/* Find My Meeting — mesure d'audience respectueuse de la vie privée.
 *
 * 1) Umami (statistiques générales, sans cookie) : pages vues, sources, UTM, et quelques événements.
 *    AUCUNE donnée politique n'est envoyée : ni candidat, ni parti, ni réponse/score du quiz, ni ville tapée.
 *    Le hash d'URL (#m=…, #r=…) n'est jamais transmis : chaque envoi passe par fmmUmamiBeforeSend.
 * 2) Compteurs agrégés par meeting (optionnels, désactivés tant que candidateStatsUrl est vide) :
 *    envoi de l'identifiant du meeting seul, sans lien avec la session Umami (voir worker/).
 *
 * Mode test : ajouter ?fmm_debug_stats=1 à l'URL -> les envois sont affichés dans la console, rien ne part.
 */
(function () {
  "use strict";
  const CFG = window.FMM_CONFIG || {};
  const DEBUG = /[?&]fmm_debug_stats=1/.test(location.search);

  function optedOut() {
    try { return localStorage.getItem("umami.disabled") === "1" || localStorage.getItem("fmm.noStats") === "1"; }
    catch { return false; }
  }

  /* ---------- Assainissement : seule une liste blanche de chemins et de paramètres UTM sort ---------- */
  const PATHS = ["/", "/quiz", "/methodologie", "/meeting-partage", "/resultat-partage", "/confidentialite", "/404"];
  const UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"];
  function cleanUrl(path) {
    const p = PATHS.includes(path) ? path : "/";
    const q = new URLSearchParams(location.search);
    const keep = new URLSearchParams();
    UTM.forEach((k) => { const v = q.get(k); if (v) keep.set(k, v.slice(0, 100)); });
    const s = keep.toString();
    return s ? `${p}?${s}` : p;
  }
  // Propriétés d'événement autorisées et leurs valeurs possibles (tout le reste est supprimé)
  const ALLOWED = {
    recherche: { methode: ["ville", "code-postal", "geolocalisation"], resultats: ["0", "1-5", "6+"] },
    "fiche-meeting": { origine: ["lien-partage", "carte", "source", "itineraire"] },
    "quiz-debut": { version: ["court", "long", "affinage"] }, "quiz-fin": { version: ["court", "long"] }, calendrier: {},
    partage: { objet: ["meeting", "resultat", "site"], canal: ["natif", "copie", "image", "whatsapp", "x", "linkedin"] },
  };
  function cleanData(name, data) {
    const rules = ALLOWED[name];
    if (!rules) return null;
    const out = {};
    Object.keys(rules).forEach((k) => { if (data && rules[k].includes(String(data[k]))) out[k] = String(data[k]); });
    return out;
  }
  let currentPath = "/";
  // Filet de sécurité appelé par Umami avant CHAQUE envoi (data-before-send)
  window.fmmUmamiBeforeSend = function (type, payload) {
    if (optedOut() || !payload) return false;
    payload.url = cleanUrl(currentPath);
    payload.title = "Find My Meeting";
    if (payload.referrer && /julio06200\.github\.io|localhost/.test(payload.referrer)) payload.referrer = "";
    else if (payload.referrer) { try { payload.referrer = new URL(payload.referrer).origin; } catch { payload.referrer = ""; } }
    delete payload.id; // jamais d'identifiant visiteur
    delete payload.tag;
    if (payload.name) {
      const d = cleanData(payload.name, payload.data);
      if (d === null) return false;
      payload.data = d;
      if (!Object.keys(d).length) delete payload.data;
    }
    return payload;
  };

  /* ---------- Chargement du script Umami ---------- */
  const enabled = !!CFG.umamiWebsiteId && !optedOut();
  if (enabled && !DEBUG) {
    const s = document.createElement("script");
    s.defer = true;
    s.src = CFG.umamiScript || "https://cloud.umami.is/script.js";
    s.setAttribute("data-website-id", CFG.umamiWebsiteId);
    s.setAttribute("data-auto-track", "false");     // pas de suivi automatique : tout passe par fmmStats
    s.setAttribute("data-exclude-hash", "true");
    s.setAttribute("data-do-not-track", "true");
    s.setAttribute("data-domains", CFG.umamiDomains || location.hostname);
    s.setAttribute("data-before-send", "fmmUmamiBeforeSend");
    document.head.appendChild(s);
  }

  /* ---------- File d'attente (le script Umami est chargé en différé) ---------- */
  const queue = [];
  function flush() {
    if (!window.umami) return;
    while (queue.length) {
      const [kind, a, b] = queue.shift();
      if (kind === "view") window.umami.track((props) => ({ ...props, url: cleanUrl(a), title: "Find My Meeting" }));
      else window.umami.track(a, b);
    }
  }
  if (enabled && !DEBUG) {
    const t = setInterval(() => { if (window.umami) { clearInterval(t); flush(); } }, 300);
    setTimeout(() => clearInterval(t), 20000);
  }
  function send(kind, a, b) {
    if (DEBUG) { console.info("[stats]", kind, a, b ? cleanData(a, b) : "", "→", cleanUrl(kind === "view" ? a : currentPath)); return; }
    if (!enabled) return;
    queue.push([kind, a, b]); flush();
  }

  /* ---------- Économie d'événements : au plus N envois par chargement de page ---------- */
  const CAPS = { recherche: 3, "fiche-meeting": 8, "quiz-debut": 2, "quiz-fin": 2, calendrier: 5, partage: 5 };
  const sent = {}; const seenMeetings = new Set();
  let total = 0, lastView = null;
  const MAX_TOTAL = 25;

  const api = {
    view(path) {
      if (path === lastView || total >= MAX_TOTAL) return;
      lastView = path; currentPath = path; total++;
      send("view", path);
    },
    event(name, data, key) {
      if (!ALLOWED[name] || total >= MAX_TOTAL) return;
      if ((sent[name] || 0) >= (CAPS[name] || 3)) return;
      if (key) { if (seenMeetings.has(name + key)) return; seenMeetings.add(name + key); }
      sent[name] = (sent[name] || 0) + 1; total++;
      send("event", name, data || {});
    },
    /* Compteur agrégé séparé (désactivé par défaut) : seul l'identifiant du meeting part, sans cookie,
       sans référent, sans lien avec Umami. Les règles RGPD sont détaillées dans docs/statistiques.md. */
    countMeeting(meetingId) {
      if (!CFG.candidateStatsUrl || optedOut() || !meetingId || seenMeetings.has("count" + meetingId)) return;
      seenMeetings.add("count" + meetingId);
      if (DEBUG) { console.info("[compteur agrégé]", meetingId); return; }
      try {
        fetch(CFG.candidateStatsUrl, {
          method: "POST", body: meetingId, keepalive: true, credentials: "omit",
          referrerPolicy: "no-referrer", mode: "no-cors", headers: { "Content-Type": "text/plain" },
        }).catch(() => {});
      } catch { /* jamais bloquant */ }
    },
    optOut(on) {
      try {
        if (on) { localStorage.setItem("umami.disabled", "1"); localStorage.setItem("fmm.noStats", "1"); }
        else { localStorage.removeItem("umami.disabled"); localStorage.removeItem("fmm.noStats"); }
      } catch { /* */ }
    },
    isOptedOut: optedOut,
  };
  window.fmmStats = api;
})();
