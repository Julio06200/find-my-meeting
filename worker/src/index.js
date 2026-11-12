/**
 * Find My Meeting — compteurs agrégés de consultations par meeting / candidat / parti.
 *
 * Service séparé d'Umami (Cloudflare Worker + base D1, offre gratuite). Principes :
 *  - le navigateur envoie UNIQUEMENT l'identifiant public du meeting (aucun cookie, aucun référent) ;
 *  - le Worker ne lit ni ne stocke l'adresse IP, le User-Agent ou l'heure : seulement (jour, meeting, +1) ;
 *  - une fois par jour, les compteurs de la veille sont agrégés, filtrés par un seuil minimal (K),
 *    envoyés à Umami depuis le serveur (donc sans lien avec la session d'un visiteur), puis SUPPRIMÉS.
 *
 * Variables (wrangler.toml / secrets) :
 *  SITE_URL        https://julio06200.github.io/find-my-meeting/
 *  UMAMI_WEBSITE   identifiant du site Umami
 *  UMAMI_ENDPOINT  https://gateway.umami.is/api/batch
 *  K_MIN           seuil minimal de vues pour publier un détail (défaut 5)
 */

const ID_RE = /^[a-z0-9-]{5,90}$/;
let cache = { at: 0, meetings: null };

async function catalogue(env) {
  if (cache.meetings && Date.now() - cache.at < 3600_000) return cache.meetings;
  const [m, c] = await Promise.all([
    fetch(new URL("data/meetings.json", env.SITE_URL)).then((r) => r.json()),
    fetch(new URL("data/candidates.json", env.SITE_URL)).then((r) => r.json()),
  ]);
  const cands = Object.fromEntries(c.map((x) => [x.id, x]));
  const map = {};
  for (const ev of m.meetings || []) {
    const cand = cands[ev.candidate_id];
    if (cand) map[ev.id] = { candidate: cand.name, party: cand.party, label: `${ev.city} — ${ev.date}` };
  }
  cache = { at: Date.now(), meetings: map };
  return map;
}

function parisDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(d); // AAAA-MM-JJ
}

function cors(env) {
  return {
    "Access-Control-Allow-Origin": new URL(env.SITE_URL).origin,
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const id = (await request.text()).trim().slice(0, 100);
    if (ID_RE.test(id)) {
      const known = await catalogue(env).catch(() => ({}));
      const info = known[id];
      if (info) {
        await env.DB.prepare(
          "INSERT INTO counts (day, meeting_id, candidate, party, label, n) VALUES (?1, ?2, ?3, ?4, ?5, 1) " +
          "ON CONFLICT(day, meeting_id) DO UPDATE SET n = n + 1"
        ).bind(parisDay(), id, info.candidate, info.party, info.label).run();
      }
    }
    // Réponse identique dans tous les cas : rien à apprendre côté navigateur
    return new Response(null, { status: 204, headers: cors(env) });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(flush(env));
  },
};

async function flush(env) {
  const K = parseInt(env.K_MIN || "5", 10);
  const today = parisDay();
  const { results } = await env.DB.prepare("SELECT day, meeting_id, candidate, party, label, n FROM counts WHERE day < ?1").bind(today).all();
  if (!results.length) return;

  // Agrégation avec seuil K : un détail n'est publié que s'il représente au moins K consultations.
  const lines = []; // { candidate, party, meeting, day, n }
  const byDayCand = {};
  for (const r of results) {
    const k = `${r.day}|${r.candidate}|${r.party}`;
    (byDayCand[k] = byDayCand[k] || { day: r.day, candidate: r.candidate, party: r.party, rows: [] }).rows.push(r);
  }
  let smallTotal = {};
  for (const g of Object.values(byDayCand)) {
    let rest = 0;
    for (const r of g.rows) {
      if (r.n >= K) lines.push({ candidate: g.candidate, party: g.party, meeting: r.label, day: g.day, n: r.n });
      else rest += r.n;
    }
    if (rest >= K) lines.push({ candidate: g.candidate, party: g.party, meeting: "Autres meetings", day: g.day, n: rest });
    else if (rest > 0) smallTotal[g.day] = (smallTotal[g.day] || 0) + rest;
  }
  for (const [day, n] of Object.entries(smallTotal)) {
    if (n >= K) lines.push({ candidate: "Autres (moins de " + K + " vues)", party: "—", meeting: "—", day, n });
    // en dessous de K au total : non publié, simplement supprimé
  }

  // Envoi à Umami : un événement « vues-candidat » par consultation, émis par le serveur
  const host = new URL(env.SITE_URL).hostname;
  const events = [];
  for (const l of lines) {
    for (let i = 0; i < Math.min(l.n, 1000); i++) {
      events.push({
        type: "event",
        payload: {
          website: env.UMAMI_WEBSITE, hostname: host, url: "/agregats", title: "Agrégats quotidiens",
          language: "fr-FR", screen: "0x0", referrer: "", name: "vues-candidat",
          data: { candidat: l.candidate, parti: l.party, meeting: l.meeting, jour: l.day },
        },
      });
    }
  }
  let ok = true;
  for (let i = 0; i < events.length; i += 100) {
    const res = await fetch(env.UMAMI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Umami ignore les requêtes sans User-Agent de navigateur
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      },
      body: JSON.stringify(events.slice(i, i + 100)),
    });
    if (!res.ok) { ok = false; break; }
  }
  // Minimisation : on supprime les compteurs envoyés ; en cas d'échec on réessaie le lendemain, 7 jours maximum.
  if (ok) await env.DB.prepare("DELETE FROM counts WHERE day < ?1").bind(today).run();
  else await env.DB.prepare("DELETE FROM counts WHERE day < ?1").bind(parisDay(-7)).run();
}
