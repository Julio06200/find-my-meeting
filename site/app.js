/* Find My Meeting — front (vanilla JS, aucune dépendance hors Leaflet) */
(function () {
  "use strict";

  const CONFIG = window.FMM_CONFIG || {};
  const SITE = CONFIG.siteUrl || location.href.split("#")[0];
  const DATA = window.FMM || { candidates: [], meetings: [], quiz: { questions: [], positions: {} } };
  const CANDS = Object.fromEntries(DATA.candidates.map((c) => [c.id, c]));
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- stockage local ---------------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem("fmm." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("fmm." + k, JSON.stringify(v)); } catch { /* navigation privée */ } },
    del(k) { try { localStorage.removeItem("fmm." + k); } catch { /* */ } },
  };
  // Les réponses au quiz (opinions politiques) ne sont gardées que si l'utilisateur l'a demandé.
  if (!store.get("quizConsent", false)) store.del("quiz");

  const state = Object.assign(
    { place: null, radius: 50, region: "", period: 30, onlyCandidate: false, onlyConfirmed: false, cands: [] },
    store.get("prefs", {})
  );
  const save = () => store.set("prefs", state);

  const STATS = window.fmmStats || { view() {}, event() {}, countMeeting() {} };
  const bucket = (n) => (n === 0 ? "0" : n <= 5 ? "1-5" : "6+");
  function meetingSeen(id, origine) { STATS.event("fiche-meeting", { origine }, id); STATS.countMeeting(id); }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
  }

  /* ---------------- helpers dates ---------------- */
  const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const MONTHS_L = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
  const DAYS_L = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const parseDate = (iso) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
  const isoOf = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const todayISO = () => isoOf(new Date());
  const addDays = (iso, n) => { const d = parseDate(iso); d.setDate(d.getDate() + n); return isoOf(d); };
  const fmtTime = (t) => (t ? t.replace(":", "h") : "");
  const fmtLong = (iso) => { const d = parseDate(iso); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  const fmtShort = (iso) => { const d = parseDate(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  function dayLabel(iso) {
    const t = todayISO();
    if (iso === t) return "<b>Aujourd'hui</b>";
    if (iso === addDays(t, 1)) return "<b>Demain</b>";
    const d = parseDate(iso);
    return `${DAYS_L[d.getDay()]} ${d.getDate()} ${MONTHS_L[d.getMonth()]}`;
  }
  function km(a, b) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

  const TYPE_LABEL = { meeting: "Meeting", reunion: "Réunion publique", rencontre: "Rencontre", debat: "Débat" };
  const STATUS_LABEL = { confirme: "Confirmé", a_confirmer: "À confirmer", annule: "Annulé" };
  const KIND_LABEL = { officiel: "Agenda officiel", organisateur: "Site de l'organisateur", presse: "Article de presse" };
  const FIELD_LABEL = { date: "date", time: "horaire", city: "commune", venue: "lieu" };
  const statusOf = (m) => (STATUS_LABEL[m.status] ? m.status : "a_confirmer"); // jamais « confirmé » par défaut

  const upcoming = () => {
    const t = todayISO();
    return DATA.meetings.filter((m) => m.date >= t).map((m) => ({ ...m, dist: state.place ? km(state.place, m) : null }));
  };
  const byId = (id) => upcoming().find((m) => m.id === id);

  /* ---------------- routing ---------------- */
  function route() {
    const h = location.hash;
    let tab = "meetings";
    if (h.startsWith("#quiz") || h.startsWith("#r=")) tab = "quiz";
    if (h === "#methodologie") tab = "methodologie";
    ["meetings", "quiz", "methodologie"].forEach((v) => ($("#view-" + v).hidden = v !== tab));
    $$(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === (tab === "methodologie" ? "quiz" : tab)));
    STATS.view(tab === "methodologie" ? "/methodologie" : tab === "quiz" ? (h.startsWith("#r=") ? "/resultat-partage" : "/quiz") : (h.startsWith("#m=") ? "/meeting-partage" : "/"));
    if (tab === "meetings") {
      if (map) setTimeout(() => map.invalidateSize(), 50);
      renderShared();
    }
    if (tab === "quiz") {
      if (h.startsWith("#r=")) showSharedResult(h.slice(3));
      else if ($("#quiz-shared").hidden === false) show("intro");
    }
    if (tab === "methodologie") renderMethod();
    if (!h.startsWith("#m=")) window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  /* ---------------- recherche de ville (geo.api.gouv.fr) ---------------- */
  function cityCombo(input, list, onPick) {
    let items = [], active = -1, timer, ctrl, lastQ = "";
    const close = () => { list.hidden = true; active = -1; input.setAttribute("aria-expanded", "false"); };
    const render = () => {
      list.innerHTML = items.map((c, i) =>
        `<li role="option" id="${list.id}-${i}" data-i="${i}" class="${i === active ? "active" : ""}" aria-selected="${i === active}">${esc(c.nom)} <small>${esc(c.codesPostaux?.[0] || "")} · ${esc(c.departement?.nom || "")}</small></li>`).join("");
      list.hidden = !items.length;
      input.setAttribute("aria-expanded", String(!!items.length));
      if (active >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${active}`);
    };
    async function search(q) {
      lastQ = q;
      ctrl?.abort(); ctrl = new AbortController();
      const isCP = /^\d{5}$/.test(q);
      const url = `https://geo.api.gouv.fr/communes?${isCP ? "codePostal" : "nom"}=${encodeURIComponent(q)}&fields=nom,centre,codesPostaux,departement,region&boost=population&limit=6`;
      try { items = await (await fetch(url, { signal: ctrl.signal })).json(); active = items.length ? 0 : -1; render(); return items; }
      catch (e) { if (e.name !== "AbortError") { items = []; close(); } return []; }
    }
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { items = []; return close(); }
      timer = setTimeout(() => search(q), 150);
    });
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (list.hidden && input.value.trim().length >= 2) await search(input.value.trim());
        pick(items[Math.max(active, 0)]);
        return;
      }
      if (list.hidden) return;
      if (e.key === "ArrowDown") { active = Math.min(active + 1, items.length - 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
      else if (e.key === "Escape") close();
    });
    list.addEventListener("mousedown", (e) => { const li = e.target.closest("li"); if (li) { e.preventDefault(); pick(items[+li.dataset.i]); } });
    input.addEventListener("blur", () => setTimeout(close, 150));
    function pick(c) {
      if (!c || !c.centre) return;
      input.value = c.nom;
      close(); input.blur();
      onPick({ name: c.nom, lat: c.centre.coordinates[1], lon: c.centre.coordinates[0], region: c.region?.nom || "" }, /^\d{5}$/.test(lastQ) ? "code-postal" : "ville");
    }
  }

  function geolocate(cb) {
    if (!navigator.geolocation) return toast("Géolocalisation indisponible : saisissez votre ville.");
    toast("Recherche de votre position…");
    navigator.geolocation.getCurrentPosition(async (p) => {
      const place = { name: "Ma position", lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3), region: "" };
      try {
        const r = await (await fetch(`https://geo.api.gouv.fr/communes?lat=${place.lat}&lon=${place.lon}&fields=nom,region&limit=1`)).json();
        if (r[0]) { place.name = r[0].nom; place.region = r[0].region?.nom || ""; }
      } catch { /* on garde "Ma position" */ }
      cb(place, "geolocalisation");
    }, () => toast("Position refusée ou introuvable : saisissez votre ville."), { timeout: 10000, maximumAge: 600000 });
  }

  /* ---------------- MEETINGS ---------------- */
  let map, layer, meLayer, markers = {}, chipsExpanded = false;

  function setPlace(p, method) {
    state.place = p; save();
    $("#city").value = p ? p.name : "";
    renderChips(); renderMeetings(true);
    if (p && method) STATS.event("recherche", { methode: method, resultats: bucket(filtered().length) });
    if (p) $(".results-head").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function initFilters() {
    const regions = [...new Set(DATA.meetings.map((m) => m.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
    $("#region").insertAdjacentHTML("beforeend", regions.map((r) => `<option>${esc(r)}</option>`).join(""));
    if (state.region && !regions.includes(state.region)) state.region = "";

    $("#city").value = state.place?.name || "";
    $("#radius").value = String(state.radius);
    $("#region").value = state.region;
    $("#only-candidate").checked = state.onlyCandidate;
    $("#only-confirmed").checked = state.onlyConfirmed;
    if (state.region || state.onlyCandidate || state.onlyConfirmed) $("#more-filters").open = true;
    syncPeriod();

    cityCombo($("#city"), $("#city-suggest"), setPlace);
    $("#city").addEventListener("input", () => { if (!$("#city").value.trim() && state.place) setPlace(null); });
    $("#locate").addEventListener("click", () => geolocate(setPlace));
    $("#radius").addEventListener("change", (e) => { state.radius = +e.target.value; save(); renderMeetings(true); });
    $("#region").addEventListener("change", (e) => { state.region = e.target.value; save(); renderMeetings(true); });
    $$("#period button").forEach((b) => b.addEventListener("click", () => { state.period = +b.dataset.v; save(); syncPeriod(); renderMeetings(true); }));
    $("#only-candidate").addEventListener("change", (e) => { state.onlyCandidate = e.target.checked; save(); renderMeetings(); });
    $("#only-confirmed").addEventListener("change", (e) => { state.onlyConfirmed = e.target.checked; save(); renderMeetings(); });
    $("#reset").addEventListener("click", () => {
      Object.assign(state, { region: "", period: 30, onlyCandidate: false, onlyConfirmed: false, cands: [], radius: 50 });
      save(); $("#region").value = ""; $("#radius").value = "50"; $("#only-candidate").checked = false; $("#only-confirmed").checked = false;
      syncPeriod(); renderChips(); renderMeetings(true);
    });
    renderChips();
    $("#fab").addEventListener("click", () => setMode($(".results").dataset.mode === "map" ? "list" : "map"));
  }
  function syncPeriod() { $$("#period button").forEach((b) => b.setAttribute("aria-checked", String(+b.dataset.v === state.period))); }

  function setMode(mode) {
    $(".results").dataset.mode = mode;
    $("#fab").textContent = mode === "map" ? "☰ Liste" : "🗺️ Carte";
    $("#fab").setAttribute("aria-label", mode === "map" ? "Afficher la liste" : "Afficher la carte");
    if (mode === "map") { $(".results-head").scrollIntoView({ block: "start" }); setTimeout(() => { map.invalidateSize(); fit(); }, 30); }
  }

  function renderChips() {
    const counts = {};
    upcoming().forEach((m) => (counts[m.candidate_id] = (counts[m.candidate_id] || 0) + 1));
    // ordre alphabétique (par nom de famille) : aucun candidat n'est mis en avant
    const sorted = [...DATA.candidates].sort((a, b) => a.name.split(" ").slice(-1)[0].localeCompare(b.name.split(" ").slice(-1)[0], "fr"));
    const visible = chipsExpanded ? sorted : sorted.filter((c) => counts[c.id] || state.cands.includes(c.id));
    const hidden = sorted.length - visible.length;
    $("#chips").innerHTML =
      `<button type="button" class="chip all ${state.cands.length ? "" : "on"}" data-id="" aria-pressed="${!state.cands.length}">Tous</button>` +
      visible.map((c) => `<button type="button" class="chip ${state.cands.includes(c.id) ? "on" : ""}" data-id="${c.id}" aria-pressed="${state.cands.includes(c.id)}" title="${esc(c.party)}"><i style="background:${c.color}"></i>${esc(c.name)}${counts[c.id] ? ` · ${counts[c.id]}` : ""}</button>`).join("") +
      (hidden ? `<button type="button" class="chip all" id="more-chips">+ ${hidden} sans meeting annoncé</button>` : "");
    $("#more-chips")?.addEventListener("click", () => { chipsExpanded = true; renderChips(); });
    $$("#chips .chip[data-id]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.id;
      if (!id) state.cands = [];
      else state.cands = state.cands.includes(id) ? state.cands.filter((x) => x !== id) : [...state.cands, id];
      save(); renderChips(); renderMeetings(true);
    }));
  }

  function filtered(ignorePlace) {
    const t = todayISO();
    const end = state.period ? addDays(t, state.period - 1) : "9999";
    return upcoming().filter((m) =>
      m.date <= end &&
      (!state.region || m.region === state.region) &&
      (!state.cands.length || state.cands.includes(m.candidate_id)) &&
      (!state.onlyCandidate || m.with_candidate) &&
      (!state.onlyConfirmed || statusOf(m) === "confirme") &&
      (ignorePlace || !state.place || !state.radius || m.dist <= state.radius)
    ).sort((a, b) => (a.date + (a.time || "99")).localeCompare(b.date + (b.time || "99")));
  }

  function cardHTML(m, opts = {}) {
    const c = CANDS[m.candidate_id] || { name: m.candidate_id, party: "", color: "#302689" };
    const d = parseDate(m.date);
    const st = statusOf(m);
    const badges = [
      m.with_candidate ? `<span class="badge red">${esc(c.name.split(" ").slice(-1)[0])} en personne</span>` : "",
      `<span class="badge">${TYPE_LABEL[m.type] || "Événement"}</span>`,
      m.access === "inscription" ? `<span class="badge warn">Sur inscription</span>` : "",
      m.access === "a_verifier" ? `<span class="badge warn">Accès public à vérifier</span>` : "",
      m.dist != null ? `<span class="badge dist">${m.dist < 1 ? "< 1" : Math.round(m.dist)} km</span>` : "",
    ].join("");
    const speakers = m.speakers?.length && !(m.with_candidate && m.speakers.length === 1)
      ? `<p class="speakers">Avec ${esc(m.speakers.join(", "))}</p>` : "";
    const place = [m.venue, m.address].filter(Boolean).join(", ");
    const changes = (m.changes || []).slice(-2).map((ch) =>
      `${FIELD_LABEL[ch.field] || ch.field} modifié le ${fmtShort(ch.at)} (avant : ${esc(ch.field === "date" ? fmtLong(ch.old) : ch.field === "time" ? fmtTime(ch.old) : ch.old)})`).join(" · ");
    const verified = m.verified_at ? `Vérifié le ${fmtShort(m.verified_at)}` : "Date de vérification inconnue";
    return `<article class="card ${st === "annule" ? "cancelled" : ""} ${opts.hl ? "hl" : ""}" style="--c:${c.color}" id="card-${esc(m.id)}" data-id="${esc(m.id)}">
      <button type="button" class="date" data-focus="${esc(m.id)}" aria-label="Voir sur la carte"><span>${DAYS[d.getDay()]}</span><b>${d.getDate()}</b><span>${MONTHS[d.getMonth()]}</span><em>${m.time ? fmtTime(m.time) : "heure ?"}</em></button>
      <div class="body">
        <span class="st st-${st}">${STATUS_LABEL[st]}</span>
        <h3>${esc(m.title)}</h3>
        <p class="who"><b>${esc(c.name)}</b> · ${esc(c.party)}</p>
        <p class="where">📍 ${place ? esc(place) + " — " : ""}<b>${esc(m.city)}</b>${m.department ? ` (${esc(m.department)})` : ""}</p>
        ${speakers}
        ${m.status_note ? `<p class="note">${esc(m.status_note)}</p>` : ""}
        ${changes ? `<p class="changes">✎ ${changes}</p>` : ""}
        <div class="badges">${badges}</div>
        <p class="source">${KIND_LABEL[m.source_kind] || "Source"} : <a href="${esc(m.url)}" target="_blank" rel="noopener" data-track="source" data-mid="${esc(m.id)}">${esc(m.source || host(m.url))} ↗</a><span>${verified}</span></p>
        <div class="actions">
          ${st !== "annule" ? `<button type="button" data-ics="${esc(m.id)}">📅 Ajouter à mon calendrier</button>` : ""}
          <button type="button" data-share="${esc(m.id)}">↗ Partager</button>
          <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([m.venue, m.address, m.city].filter(Boolean).join(", "))}" target="_blank" rel="noopener" data-track="itineraire" data-mid="${esc(m.id)}">🧭 Itinéraire</a>
          <a class="report" href="${esc(reportUrl(m))}" target="_blank" rel="noopener">⚑ Signaler une erreur</a>
        </div>
      </div></article>`;
  }

  function reportUrl(m) {
    const c = CANDS[m.candidate_id] || {};
    const subject = `Erreur sur un meeting : ${c.name || ""} — ${m.city}, ${m.date}`;
    const body = `Meeting concerné : ${m.title}\n${c.name || ""} — ${fmtLong(m.date)} ${fmtTime(m.time)} — ${m.city}\nIdentifiant : ${m.id}\nLien : ${SITE}#m=${m.id}\n\nQuelle est l'erreur ? (date, heure, lieu, annulation…)\n\nSource qui le prouve (lien) :\n`;
    if (CONFIG.reportEmail) return `mailto:${CONFIG.reportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    return `${CONFIG.reportGithub}?title=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}&labels=signalement`;
  }

  function renderMeetings(refit) {
    const items = filtered();
    const n = items.length;
    const where = state.place ? (state.radius ? ` à moins de ${state.radius} km de ${state.place.name}` : "") : state.region ? ` en ${state.region}` : "";
    $("#count").textContent = `${n} événement${n > 1 ? "s" : ""}${where}`;

    if (!n) {
      const wider = state.place && state.radius ? filtered(true).sort((a, b) => a.dist - b.dist)[0] : null;
      $("#list").innerHTML = `<div class="empty"><b>Aucun meeting avec ces filtres.</b>${
        wider ? `Le plus proche est à ${Math.round(wider.dist)} km (${esc(wider.city)}, ${esc(fmtLong(wider.date))}).<br><br><button class="btn ghost" type="button" id="widen">Élargir à ${Math.ceil(wider.dist / 50) * 50} km</button>`
        : upcoming().length ? "Essayez d'élargir la période ou de retirer un filtre." : "L'agenda sera complété au prochain passage du robot, demain matin."}</div>`;
      $("#widen")?.addEventListener("click", () => {
        const r = [10, 25, 50, 100, 200].find((x) => x >= wider.dist) || 0;
        state.radius = r; $("#radius").value = String(r); save(); renderMeetings(true);
      });
    } else {
      let html = "", last = "";
      for (const m of items) {
        if (m.date !== last) { html += `<h2 class="day">${dayLabel(m.date)}</h2>`; last = m.date; }
        html += cardHTML(m);
      }
      $("#list").innerHTML = html;
    }
    drawMap(items, refit);
  }

  /* meeting partagé via #m=<id> */
  function renderShared() {
    const box = $("#shared-meeting");
    const h = location.hash;
    if (!h.startsWith("#m=")) { box.innerHTML = ""; return; }
    const id = decodeURIComponent(h.slice(3));
    const m = byId(id);
    if (m) meetingSeen(m.id, "lien-partage");
    box.innerHTML = `<div class="shared-box"><p class="kicker">Meeting partagé</p>${m ? cardHTML(m, { hl: true }) :
      `<div class="empty"><b>Ce meeting est passé ou n'est plus référencé.</b>Découvrez les autres meetings ci-dessous.</div>`}</div>`;
    setTimeout(() => box.scrollIntoView({ block: "start" }), 50);
  }

  function initMap() {
    map = L.map("map", { zoomControl: true, scrollWheelZoom: true, tap: true }).setView([46.6, 2.4], 5);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    meLayer = L.layerGroup().addTo(map);
  }

  let lastItems = [];
  function drawMap(items, refit) {
    lastItems = items;
    layer.clearLayers(); meLayer.clearLayers(); markers = {};
    const groups = {};
    items.forEach((m) => { const k = m.lat.toFixed(3) + "," + m.lon.toFixed(3); (groups[k] = groups[k] || []).push(m); });
    Object.values(groups).forEach((g) => {
      const m = g[0], c = CANDS[m.candidate_id] || { color: "#302689" };
      const st = statusOf(m);
      const cls = st === "annule" ? "pin off" : st === "a_confirmer" ? "pin dashed" : "pin";
      const icon = L.divIcon({ className: "", html: `<div class="${cls}" style="--c:${c.color}"></div>`, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });
      const html = g.map((x) => {
        const cx = CANDS[x.candidate_id] || {}, sx = statusOf(x);
        return `<div style="margin-bottom:8px"><span class="st st-${sx}">${STATUS_LABEL[sx]}</span><br><b>${esc(cx.name || "")}</b><br>${esc(fmtLong(x.date))}${x.time ? " · " + fmtTime(x.time) : ""}<br>${esc(x.title)}<br>${esc(x.venue || "")} ${esc(x.city)}<br><a href="#m=${encodeURIComponent(x.id)}">Voir la fiche</a> · <a href="${esc(x.url)}" target="_blank" rel="noopener" data-track="source" data-mid="${esc(x.id)}">Source ↗</a></div>`;
      }).join("");
      const mk = L.marker([m.lat, m.lon], { icon, title: `${(CANDS[m.candidate_id] || {}).name || ""} — ${m.city}` }).bindPopup(html, { maxWidth: 260 }).addTo(layer);
      g.forEach((x) => (markers[x.id] = mk));
    });
    if (state.place) {
      L.marker([state.place.lat, state.place.lon], { icon: L.divIcon({ className: "", html: '<div class="me-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, keyboard: false }).addTo(meLayer);
      if (state.radius) L.circle([state.place.lat, state.place.lon], { radius: state.radius * 1000, color: "#E5383B", weight: 1, fillOpacity: 0.05, interactive: false }).addTo(meLayer);
    }
    if (refit) fit();
  }

  function fit() {
    const pts = lastItems.map((m) => [m.lat, m.lon]);
    if (state.place) pts.push([state.place.lat, state.place.lon]);
    if (state.place && state.radius && !lastItems.length) return map.setView([state.place.lat, state.place.lon], state.radius <= 25 ? 10 : state.radius <= 50 ? 9 : 8);
    if (pts.length === 1) return map.setView(pts[0], 10);
    if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 11 });
    else map.setView([46.6, 2.4], 5);
  }

  /* interactions des fiches */
  document.addEventListener("click", (e) => {
    const tr = e.target.closest("a[data-track]");
    if (tr) meetingSeen(tr.dataset.mid, tr.dataset.track);
    const ics = e.target.closest("[data-ics]");
    if (ics) return downloadICS(byId(ics.dataset.ics));
    const sh = e.target.closest("[data-share]");
    if (sh) return shareMeeting(byId(sh.dataset.share));
    const f = e.target.closest("[data-focus]");
    if (f) {
      const mk = markers[f.dataset.focus];
      if (!mk) return;
      meetingSeen(f.dataset.focus, "carte");
      if (window.matchMedia("(max-width: 860px)").matches) setMode("map");
      setTimeout(() => { map.setView(mk.getLatLng(), 12); mk.openPopup(); }, 80);
    }
  });

  function downloadICS(m) {
    if (!m) return;
    const c = CANDS[m.candidate_id] || {};
    const d = m.date.replace(/-/g, "");
    const pad = (s) => String(s).padStart(2, "0");
    let dtStart, dtEnd;
    if (m.time) {
      const [h, mi] = m.time.split(":").map(Number);
      dtStart = `DTSTART;TZID=Europe/Paris:${d}T${pad(h)}${pad(mi)}00`;
      dtEnd = `DTEND;TZID=Europe/Paris:${d}T${pad(Math.min(h + 2, 23))}${pad(mi)}00`;
    } else {
      dtStart = `DTSTART;VALUE=DATE:${d}`;
      dtEnd = `DTEND;VALUE=DATE:${addDays(m.date, 1).replace(/-/g, "")}`;
    }
    const icsEsc = (s) => String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
    const unsure = statusOf(m) !== "confirme" ? " (à confirmer)" : "";
    const body = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Find My Meeting//FR", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
      `UID:${m.id}@findmymeeting`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`, dtStart, dtEnd,
      `SUMMARY:${icsEsc(`${m.title} — ${c.name || ""}${unsure}`)}`,
      `LOCATION:${icsEsc([m.venue, m.address, m.city].filter(Boolean).join(", "))}`,
      `DESCRIPTION:${icsEsc(`Statut : ${STATUS_LABEL[statusOf(m)]}. Vérifiez avant de vous déplacer.\nSource : ${m.url}\nFiche : ${SITE}#m=${m.id}`)}`,
      `URL:${SITE}#m=${m.id}`, statusOf(m) === "confirme" ? "STATUS:CONFIRMED" : "STATUS:TENTATIVE", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/calendar;charset=utf-8" }));
    a.download = `meeting-${m.city}-${m.date}.ics`.replace(/\s+/g, "-");
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    toast("Événement ajouté : ouvrez le fichier pour l'enregistrer.");
    STATS.event("calendrier"); STATS.countMeeting(m.id);
  }

  async function shareOrCopy(data) {
    try {
      if (navigator.share) { await navigator.share(data); return "natif"; }
    } catch (e) { if (e.name === "AbortError") return null; }
    try { await navigator.clipboard.writeText(`${data.text}\n${data.url}`); toast("Lien copié !"); }
    catch { prompt("Copiez ce lien :", data.url); }
    return "copie";
  }
  function shareMeeting(m) {
    if (!m) return;
    const c = CANDS[m.candidate_id] || {};
    const unsure = statusOf(m) !== "confirme" ? ` (${STATUS_LABEL[statusOf(m)].toLowerCase()})` : "";
    shareOrCopy({
      title: "Find My Meeting",
      text: `${c.name} : ${m.title}, ${fmtLong(m.date)}${m.time ? " à " + fmtTime(m.time) : ""}, ${m.city}${unsure}`,
      url: `${SITE}#m=${encodeURIComponent(m.id)}`,
    }).then((canal) => { if (canal) STATS.event("partage", { objet: "meeting", canal }); });
  }

  /* ---------------- QUIZ ---------------- */
  const ALLQ = DATA.quiz.questions || [];
  const CORE = ALLQ.filter((q) => q.core !== false);
  const EXTRA = ALLQ.length - CORE.length;
  const saved = store.get("quiz", null) || {};
  let quizMode = saved.mode === "long" ? "long" : "court";
  let Q = quizMode === "long" ? ALLQ : CORE;
  function useMode(m) { quizMode = m; Q = m === "long" ? ALLQ : CORE; }
  const P = DATA.quiz.positions || {};
  const QSRC = DATA.quiz.sources || {};
  const USER_LABEL = { 2: "Tout à fait d'accord", 1: "Plutôt d'accord", 0: "Partagé", "-1": "Plutôt pas d'accord", "-2": "Pas du tout d'accord" };
  const POS_LABEL = { 2: "Pour", 1: "Plutôt pour", 0: "Position nuancée", "-1": "Plutôt contre", "-2": "Contre" };
  let qi = 0;
  let answers = saved.answers || {};
  let lastRanking = [];

  function initQuiz() {
    const start = (m) => { useMode(m); qi = 0; answers = {}; persist(); STATS.event("quiz-debut", { version: m }); showQ(); };
    $$("[data-quiz-mode]").forEach((b) => b.addEventListener("click", () => start(b.dataset.quizMode)));
    $("#quiz-n-court").textContent = CORE.length; $("#quiz-n-long").textContent = ALLQ.length;
    $("#shared-start").addEventListener("click", () => { history.replaceState(null, "", "#quiz"); start("court"); });
    $("#quiz-restart").addEventListener("click", () => { answers = {}; persist(); show("intro"); window.scrollTo(0, 0); });
    $("#quiz-refine").addEventListener("click", () => {
      useMode("long"); qi = ALLQ.findIndex((q) => q.core === false); if (qi < 0) qi = 0;
      STATS.event("quiz-debut", { version: "affinage" }); showQ(); window.scrollTo(0, 0);
    });
    $$("#answers button").forEach((b) => b.addEventListener("click", () => {
      const id = Q[qi].id;
      if (b.dataset.v === "skip") delete answers[id];
      else answers[id] = { v: +b.dataset.v, w: $("#q-important").checked ? 2 : 1 };
      next();
    }));
    $("#q-back").addEventListener("click", () => { if (qi > 0) { qi--; showQ(); } else show("intro"); });
    $("#remember").checked = store.get("quizConsent", false);
    $("#remember").addEventListener("change", (e) => { store.set("quizConsent", e.target.checked); persist(); toast(e.target.checked ? "Réponses gardées sur cet appareil uniquement." : "Réponses non conservées."); });
    $("#forget").addEventListener("click", () => {
      answers = {}; store.del("quiz"); store.set("quizConsent", false); $("#remember").checked = false;
      toast("Vos réponses ont été effacées."); show("intro");
    });
    $("#share-results").addEventListener("click", openShare);
    if (Object.keys(answers).length) showResult(); else show("intro");
  }
  function persist() { if (store.get("quizConsent", false) && Object.keys(answers).length) store.set("quiz", { answers, mode: quizMode }); else store.del("quiz"); }

  function show(which) {
    ["intro", "q", "result", "shared"].forEach((w) => ($("#quiz-" + w).hidden = w !== which));
  }
  function next() { qi++; if (qi >= Q.length) { persist(); STATS.event("quiz-fin", { version: quizMode }); showResult(); window.scrollTo(0, 0); } else showQ(); }
  function showQ() {
    show("q");
    const q = Q[qi], a = answers[q.id];
    $("#quiz-bar").style.width = `${(qi / Q.length) * 100}%`;
    $(".progress").setAttribute("aria-valuenow", String(Math.round((qi / Q.length) * 100)));
    $("#q-num").textContent = `Question ${qi + 1}/${Q.length}`;
    $("#q-theme").textContent = q.theme;
    $("#q-text").textContent = q.text;
    $("#q-important").checked = a ? a.w === 2 : false;
    $$("#answers button").forEach((b) => b.classList.toggle("on", !!a && +b.dataset.v === a.v));
    $("#q-text").focus({ preventScroll: true });
    if (window.scrollY > 80) window.scrollTo(0, 0);
  }

  function scores() {
    return Object.keys(P).filter((id) => CANDS[id]).map((id) => {
      let s = 0, w = 0;
      const details = [];
      for (const q of ALLQ) {
        const a = answers[q.id];
        const p = P[id][q.id];
        if (!a || p == null) continue;
        const diff = Math.abs(a.v - p);
        s += (1 - diff / 4) * a.w; w += a.w;
        details.push({ q, u: a.v, p, diff, w: a.w });
      }
      return { id, pct: w ? Math.round((s / w) * 100) : 0, details };
    }).sort((a, b) => b.pct - a.pct || CANDS[a.id].name.localeCompare(CANDS[b.id].name, "fr"));
  }

  function nearestFor(id, n) {
    const list = upcoming().filter((m) => m.candidate_id === id && statusOf(m) !== "annule");
    if (state.place) list.sort((a, b) => a.dist - b.dist);
    else list.sort((a, b) => a.date.localeCompare(b.date));
    return list.slice(0, n);
  }

  function topicTags(details, close) {
    const sel = details.filter((d) => (close ? d.diff <= 1 : d.diff >= 2))
      .sort((a, b) => (close ? a.diff - b.diff : b.diff - a.diff) || b.w - a.w).slice(0, 5);
    return sel.map((d) => `<span class="tag ${close ? "ok" : "ko"}">${esc(d.q.theme)}</span>`).join("") || "<span class=\"fine\">aucun</span>";
  }

  function sourcesFor(id) {
    const c = CANDS[id], src = QSRC[id] || {};
    const links = [];
    if (src._programme) links.push(`<a href="${esc(src._programme)}" target="_blank" rel="noopener">Programme</a>`);
    if (c.site) links.push(`<a href="${esc(c.site)}" target="_blank" rel="noopener">Site officiel</a>`);
    return links.join(" · ");
  }

  function showResult() {
    show("result");
    const answered = Object.keys(answers).length;
    const important = Object.values(answers).filter((a) => a.w === 2).length;
    $("#result-note").textContent = answered
      ? `${quizMode === "long" ? "Test complet" : "Test rapide"} : calculé sur ${answered} réponse${answered > 1 ? "s" : ""} sur ${Q.length}${important ? `, dont ${important} jugée${important > 1 ? "s" : ""} importante${important > 1 ? "s" : ""} (comptée${important > 1 ? "s" : ""} double)` : ""}.${answered < 6 ? " Avec si peu de réponses, le résultat est peu fiable." : ""}`
      : "Vous n'avez répondu à aucune question : impossible de calculer une proximité.";
    lastRanking = answered ? scores() : [];
    $("#share-results").hidden = !answered;
    $("#quiz-refine").hidden = !answered || quizMode === "long" || !EXTRA;
    $("#quiz-refine").textContent = `Affiner avec le test complet (+${EXTRA} questions)`;

    $("#top3").innerHTML = lastRanking.slice(0, 3).map((r, i) => {
      const c = CANDS[r.id];
      const ok = r.details.filter((d) => d.diff <= 1).length, ko = r.details.filter((d) => d.diff >= 3).length;
      const rows = r.details.map((d) => {
        const qs = (QSRC[r.id] || {})[d.q.id];
        return `<tr><td>${esc(d.q.theme)}${d.w === 2 ? " ★" : ""}</td><td>${USER_LABEL[d.u]}</td><td>${POS_LABEL[d.p]}${qs ? ` <a href="${esc(qs)}" target="_blank" rel="noopener">source</a>` : ""}</td><td>${d.diff <= 1 ? "✔︎" : d.diff >= 3 ? "✖︎" : "≈"}</td></tr>`;
      }).join("");
      return `<li style="--c:${c.color}">
        <div class="t-head"><span class="t-pos">${i + 1}</span><span class="t-name"><b>${esc(c.name)}</b><small>${esc(c.party)}</small></span><span class="t-pct">${r.pct}%</span></div>
        <div class="bar"><span style="width:${r.pct}%"></span></div>
        <div class="topics">
          <p><b>Proches sur :</b> ${topicTags(r.details, true)}</p>
          <p><b>Divergences :</b> ${topicTags(r.details, false)}</p>
        </div>
        ${c.note ? `<p class="fine">ℹ️ ${esc(c.note)}</p>` : ""}
        <details class="explain"><summary>Comprendre ce score</summary>
          <p>${r.pct} % de proximité : sur vos ${r.details.length} réponses comparables, vous êtes proche de ${esc(c.name)} sur ${ok} sujet${ok > 1 ? "s" : ""} (écart de 0 ou 1 point) et nettement opposé sur ${ko} (écart de 3 ou 4 points). Chaque écart retire des points, les sujets marqués ★ comptent double. <a href="#methodologie" class="link">Méthodologie complète</a></p>
          <div class="table-wrap"><table><thead><tr><th>Sujet</th><th>Vous</th><th>${esc(c.name.split(" ").slice(-1)[0])}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
          <p class="src">Positions établies à partir des programmes et déclarations publiques. Vérifier : ${sourcesFor(r.id) || "sources en cours d'ajout"}.</p>
        </details>
      </li>`;
    }).join("");

    renderDiscover();

    $("#ranking").innerHTML = lastRanking.map((r, i) => {
      const c = CANDS[r.id];
      return `<li class="rank" style="--c:${c.color}"><span>${i + 1}</span><span><b>${esc(c.name)}</b> <small>${esc(c.party)}</small></span><span class="rank-pct">${r.pct}%</span><div class="bar"><span style="width:${r.pct}%"></span></div></li>`;
    }).join("");

    renderResultMeetings();
  }

  /* « Vous aimez ces idées… mais avez-vous déjà écouté ? » : candidats assez proches (hors top 3),
     d'un autre parti et si possible d'une autre famille politique, pour élargir l'horizon. */
  function renderDiscover() {
    const box = $("#discover");
    if (lastRanking.length < 5) { box.innerHTML = ""; return; }
    const top = lastRanking.slice(0, 3);
    const topParties = new Set(top.map((r) => CANDS[r.id].party));
    const topFams = new Set(top.map((r) => CANDS[r.id].family));
    const pool = lastRanking.slice(3).filter((r) => !topParties.has(CANDS[r.id].party) && r.details.some((d) => d.diff <= 1));
    const near = pool.filter((r) => r.pct >= top[0].pct - 20);
    const cands = (near.length >= 2 ? near : pool).slice(0, 6);
    // d'abord une autre famille politique, puis la même famille mais un autre parti
    const picks = [...cands.filter((r) => !topFams.has(CANDS[r.id].family)), ...cands.filter((r) => topFams.has(CANDS[r.id].family))];
    const chosen = [];
    for (const r of picks) { if (!chosen.some((x) => CANDS[x.id].family === CANDS[r.id].family)) chosen.push(r); if (chosen.length === 2) break; }
    if (!chosen.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<h2 class="h2">Vous aimez ces idées… mais avez-vous déjà écouté ?</h2>
      <p class="fine" style="margin-top:0">Des candidats proches de vous sur plusieurs sujets, avec une approche différente. Les écouter en meeting, c'est le meilleur moyen de se faire son propre avis.</p>
      <ul class="top3 compact">${chosen.map((r) => {
        const c = CANDS[r.id], m = nearestFor(r.id, 1)[0];
        const agree = r.details.filter((d) => d.diff <= 1).sort((a, b) => a.diff - b.diff || b.w - a.w).slice(0, 4);
        const differ = r.details.filter((d) => d.diff >= 2).sort((a, b) => b.diff - a.diff).slice(0, 3);
        return `<li style="--c:${c.color}">
          <div class="t-head"><span class="t-name"><b>${esc(c.name)}</b><small>${esc(c.party)} · ${esc(c.family)}</small></span><span class="t-pct">${r.pct}%</span></div>
          <div class="topics">
            <p><b>D'accord avec vous sur :</b> ${agree.map((d) => `<span class="tag ok">${esc(d.q.theme)}</span>`).join("")}</p>
            ${differ.length ? `<p><b>Une autre approche sur :</b> ${differ.map((d) => `<span class="tag ko">${esc(d.q.theme)}</span>`).join("")}</p>` : ""}
            <p>${m ? `<b>Prochain meeting :</b> ${esc(fmtLong(m.date))}${m.time ? " · " + fmtTime(m.time) : ""} — ${esc(m.city)}${m.dist != null ? ` (${Math.round(m.dist)} km)` : ""} · <a class="link" href="#m=${encodeURIComponent(m.id)}">Voir la fiche</a>`
              : `Pas encore de meeting annoncé.${c.site ? ` <a class="link" href="${esc(c.site)}" target="_blank" rel="noopener">Découvrir son programme</a>` : ""}`}</p>
          </div></li>`;
      }).join("")}</ul>`;
  }

  function renderResultMeetings() {
    $("#result-where").innerHTML = `
      <div class="field grow"><label for="quiz-city">${state.place ? "Autour de" : "Votre ville"}</label>
        <div class="combo"><input id="quiz-city" type="search" placeholder="Ville ou code postal" autocomplete="off" value="${esc(state.place?.name || "")}"><ul id="quiz-suggest" class="suggest" role="listbox" hidden></ul></div></div>
      <button class="btn ghost" type="button" id="quiz-locate">📍 Autour de moi</button>`;
    const pick = (p) => { state.place = p; save(); $("#city").value = p.name; renderChips(); renderMeetings(true); renderResultMeetings(); };
    cityCombo($("#quiz-city"), $("#quiz-suggest"), pick);
    $("#quiz-locate").addEventListener("click", () => geolocate(pick));

    $("#result-meetings").innerHTML = lastRanking.slice(0, 3).map((r) => {
      const c = CANDS[r.id], near = nearestFor(r.id, 3);
      return `<p class="mini-head"><i style="background:${c.color}"></i>${esc(c.name)}</p>` + (near.length
        ? `<ul class="mini">${near.map((m) => `<li><span>${esc(fmtLong(m.date))}${m.time ? " · " + fmtTime(m.time) : ""} — <b>${esc(m.city)}</b>${m.dist != null ? ` (${Math.round(m.dist)} km)` : ""} <span class="st st-${statusOf(m)}">${STATUS_LABEL[statusOf(m)]}</span></span><a href="#m=${encodeURIComponent(m.id)}">Voir</a></li>`).join("")}</ul>`
        : `<p class="fine">Aucun meeting annoncé pour l'instant.</p>`);
    }).join("") + (lastRanking.length ? `<button type="button" class="btn ghost small" id="see-all-top">Voir ces candidats sur la carte</button>` : "");
    $("#see-all-top")?.addEventListener("click", () => {
      state.cands = lastRanking.slice(0, 3).map((r) => r.id); state.region = ""; $("#region").value = "";
      save(); renderChips(); location.hash = "#meetings"; setTimeout(() => renderMeetings(true), 60);
    });
  }

  /* ---------------- partage des résultats ---------------- */
  function sharePayload() {
    const top = lastRanking.slice(0, 3);
    if (!$("#sh-names").checked) return { url: `${SITE}#quiz`, top: [] };
    const withPct = $("#sh-pct").checked;
    const code = top.map((r) => r.id).join(",") + (withPct ? "~" + top.map((r) => r.pct).join(",") : "");
    return { url: `${SITE}#r=${code}`, top: top.map((r) => ({ id: r.id, pct: withPct ? r.pct : null })) };
  }
  let shareFormat = "story";
  function openShare() {
    const dlg = $("#share-dialog");
    const upd = () => { drawCard(); updateLinks(); };
    if (!dlg.dataset.init) {
      dlg.dataset.init = "1";
      ["#sh-names", "#sh-pct"].forEach((s) => $(s).addEventListener("change", () => { $("#sh-pct").disabled = !$("#sh-names").checked; upd(); }));
      $$("#sh-format button").forEach((b) => b.addEventListener("click", () => {
        shareFormat = b.dataset.v; $$("#sh-format button").forEach((x) => x.setAttribute("aria-checked", String(x === b))); upd();
      }));
      $("#sh-native").addEventListener("click", shareImage);
      $("#sh-download").addEventListener("click", () => downloadImage(true));
      [["wa", "whatsapp"], ["x", "x"], ["li", "linkedin"]].forEach(([k, c]) => $("#sh-" + k).addEventListener("click", () => trackShare(c)));
      $("#sh-copy").addEventListener("click", async () => {
        const { url } = sharePayload();
        trackShare("copie");
        try { await navigator.clipboard.writeText(url); $("#sh-msg").textContent = "Lien copié !"; }
        catch { prompt("Copiez ce lien :", url); }
      });
    }
    $("#sh-msg").textContent = "";
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    document.fonts?.ready.then(upd); upd();
  }
  function shareText(p) {
    if (!p.top.length) return "J'ai testé mes proximités politiques pour la présidentielle 2027 sur Find My Meeting. Et vous ?";
    return `Mes proximités politiques (quiz Find My Meeting) : ${p.top.map((t) => CANDS[t.id].name + (t.pct != null ? ` ${t.pct} %` : "")).join(", ")}. Une mesure de proximité, pas une consigne de vote. Faites le test :`;
  }
  function updateLinks() {
    const p = sharePayload(), t = shareText(p);
    $("#sh-wa").href = `https://wa.me/?text=${encodeURIComponent(t + " " + p.url)}`;
    $("#sh-x").href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(t)}&url=${encodeURIComponent(p.url)}`;
    $("#sh-li").href = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(p.url)}`;
  }

  let logoImg;
  function drawCard() {
    const cv = $("#share-canvas"), story = shareFormat === "story";
    cv.width = 1080; cv.height = story ? 1920 : 1080;
    const W = cv.width, H = cv.height, g = cv.getContext("2d");
    const p = sharePayload();
    g.fillStyle = "#302689"; g.fillRect(0, 0, W, H);
    if (!logoImg) { logoImg = new Image(); logoImg.onload = drawCard; logoImg.src = "assets/logo.png"; }
    const top = story ? 230 : 60;
    if (logoImg.complete && logoImg.naturalWidth) g.drawImage(logoImg, W / 2 - (story ? 150 : 110), top, story ? 300 : 220, story ? 300 : 220);
    let y = top + (story ? 400 : 290);
    g.textAlign = "center"; g.fillStyle = "#fff";
    g.font = `${story ? 84 : 66}px Anton, Impact, sans-serif`;
    g.fillText("MES PROXIMITÉS", W / 2, y); y += story ? 96 : 76;
    g.fillText("POLITIQUES", W / 2, y); y += story ? 90 : 60;
    if (!p.top.length) {
      g.font = "600 44px Inter, sans-serif"; g.fillText("J'ai fait le quiz.", W / 2, y + 80);
      g.fillText("Et vous ?", W / 2, y + 150); y += 260;
    } else {
      const rowH = story ? 210 : 130;
      p.top.forEach((t, i) => {
        const c = CANDS[t.id];
        const x0 = 90, ry = y + i * (rowH + 20);
        g.fillStyle = "rgba(255,255,255,0.1)"; roundRect(g, x0, ry, W - 180, rowH, 28); g.fill();
        g.fillStyle = c.color; roundRect(g, x0, ry, 18, rowH, 9); g.fill();
        g.textAlign = "left"; g.fillStyle = "rgba(255,255,255,.6)"; g.font = `${story ? 64 : 52}px Anton, Impact, sans-serif`;
        g.fillText(String(i + 1), x0 + 50, ry + rowH / 2 + (story ? 22 : 18));
        g.fillStyle = "#fff"; g.font = `700 ${story ? 50 : 42}px Inter, sans-serif`;
        g.fillText(fitText(g, c.name, t.pct != null ? 560 : 760), x0 + 130, ry + rowH / 2 - (story ? 6 : 4));
        g.fillStyle = "rgba(255,255,255,.75)"; g.font = `500 ${story ? 34 : 28}px Inter, sans-serif`;
        g.fillText(fitText(g, c.party, t.pct != null ? 560 : 760), x0 + 130, ry + rowH / 2 + (story ? 44 : 36));
        if (t.pct != null) { g.textAlign = "right"; g.fillStyle = "#fff"; g.font = `${story ? 76 : 60}px Anton, Impact, sans-serif`; g.fillText(t.pct + "%", W - 130, ry + rowH / 2 + (story ? 26 : 20)); }
      });
      y += 3 * (rowH + 20) + (story ? 40 : 10);
    }
    g.textAlign = "center"; g.fillStyle = "rgba(255,255,255,.8)"; g.font = `500 ${story ? 32 : 26}px Inter, sans-serif`;
    g.fillText("Une mesure de proximité, pas une consigne de vote.", W / 2, y);
    const by = H - (story ? 230 : 120);
    g.fillStyle = "#E5383B"; roundRect(g, W / 2 - 330, by, 660, story ? 110 : 84, 55); g.fill();
    g.fillStyle = "#fff"; g.font = `${story ? 48 : 38}px Anton, Impact, sans-serif`;
    g.fillText("FAITES LE TEST", W / 2, by + (story ? 72 : 56));
    g.font = `600 ${story ? 30 : 24}px Inter, sans-serif`; g.fillStyle = "rgba(255,255,255,.85)";
    g.fillText(SITE.replace(/^https?:\/\//, "").replace(/\/$/, ""), W / 2, H - (story ? 70 : 18));
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function fitText(g, s, max) { if (g.measureText(s).width <= max) return s; while (s.length > 3 && g.measureText(s + "…").width > max) s = s.slice(0, -1); return s + "…"; }
  const canvasBlob = () => new Promise((res) => $("#share-canvas").toBlob(res, "image/png"));
  async function shareImage() {
    const blob = await canvasBlob();
    const file = new File([blob], "mes-proximites-politiques.png", { type: "image/png" });
    const p = sharePayload();
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Mes proximités politiques", text: shareText(p) + " " + p.url }); trackShare("natif"); return; }
      catch (e) { if (e.name === "AbortError") return; }
    }
    $("#sh-msg").textContent = "Le partage direct d'image n'est pas disponible ici : l'image est téléchargée, publiez-la depuis votre galerie.";
    downloadImage(true);
  }
  const trackShare = (canal) => STATS.event("partage", { objet: $("#sh-names").checked ? "resultat" : "site", canal });
  async function downloadImage(track) {
    if (track) trackShare("image");
    const blob = await canvasBlob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "mes-proximites-politiques.png";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  function showSharedResult(code) {
    const [idsPart, pctPart] = decodeURIComponent(code).split("~");
    const ids = (idsPart || "").split(",").filter((id) => CANDS[id]).slice(0, 3);
    const pcts = (pctPart || "").split(",").map((x) => parseInt(x, 10));
    if (!ids.length) { show("intro"); return; }
    show("shared");
    $("#shared-top3").innerHTML = ids.map((id, i) => {
      const c = CANDS[id], pct = Number.isFinite(pcts[i]) && pcts[i] >= 0 && pcts[i] <= 100 ? pcts[i] : null;
      return `<li style="--c:${c.color}"><div class="t-head"><span class="t-pos">${i + 1}</span><span class="t-name"><b>${esc(c.name)}</b><small>${esc(c.party)}</small></span>${pct != null ? `<span class="t-pct">${pct}%</span>` : ""}</div>${pct != null ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ""}</li>`;
    }).join("");
  }

  /* ---------------- méthodologie ---------------- */
  function renderMethod() {
    if ($("#method-body").dataset.done) return;
    const cands = Object.keys(P).filter((id) => CANDS[id]).sort((a, b) => CANDS[a].name.localeCompare(CANDS[b].name, "fr"));
    const fmtP = (v) => (v == null ? "?" : (v > 0 ? "+" : "") + v);
    const head = `<tr><th>Candidat</th>${ALLQ.map((q, i) => `<th title="${esc(q.text)}">${i + 1}. ${esc(q.theme)}${q.core === false ? "*" : ""}</th>`).join("")}<th>Sources</th></tr>`;
    const rows = cands.map((id) => `<tr><td><b>${esc(CANDS[id].name)}</b></td>${ALLQ.map((q) => `<td>${fmtP(P[id][q.id])}</td>`).join("")}<td>${sourcesFor(id) || "—"}</td></tr>`).join("");
    $("#method-body").innerHTML = `
      <p>Le quiz mesure une <b>proximité idéologique</b> entre vos réponses et les positions publiques des candidats. Il ne recommande aucun candidat et ne prédit aucun vote.</p>
      <h2>1. Les questions</h2>
      <p>Deux versions : le <b>test rapide</b> (${CORE.length} affirmations sur les grands thèmes) et le <b>test complet</b> (${ALLQ.length} affirmations, plus précis : institutions, défense, santé, logement, société…). Le test rapide peut être complété à tout moment par les questions du test complet. Pour chacune, vous indiquez votre accord sur une échelle de 4 niveaux, de « Pas du tout d'accord » (−2) à « Tout à fait d'accord » (+2), ou vous passez. Une question passée n'est pas prise en compte.</p>
      <h2>2. Les positions des candidats</h2>
      <p>Chaque candidat reçoit une position sur la même échelle (−2 contre, −1 plutôt contre, 0 nuancé, +1 plutôt pour, +2 pour), établie à partir de son programme et de ses déclarations publiques. Toutes les positions sont publiées ci-dessous pour être vérifiables.</p>
      <h2>3. Le calcul</h2>
      <p>Pour chaque question, l'écart entre votre réponse et la position du candidat va de 0 (identique) à 4 (opposé). La proximité de la question vaut <code>1 − écart ÷ 4</code>. Le score est la moyenne de ces proximités, pondérée : les sujets marqués « important pour moi » comptent double. Il est exprimé en pourcentage.</p>
      <p>Un sujet est classé en « proximité » si l'écart vaut 0 ou 1, en « divergence » s'il vaut 2 ou plus. En cas d'égalité, les candidats sont classés par ordre alphabétique.</p>
      <h2>4. Limites</h2>
      <ul><li>Une liste de questions ne résume pas un programme ; le choix des questions influence le résultat. Le test complet réduit ce biais.</li>
      <li>Une position marquée « ? » n'est pas établie : la question est alors ignorée pour ce candidat.</li>
      <li>Les positions sont une simplification et peuvent évoluer pendant la campagne. Signalez une erreur via le lien en bas de page.</li>
      <li>Les candidats sans position établie ne figurent pas dans le quiz.</li></ul>
      <h2>5. « Avez-vous déjà écouté ? »</h2>
      <p>Après vos trois proximités, le site propose jusqu'à deux autres candidats, choisis automatiquement : hors de votre top 3, d'un autre parti, proches de vous sur au moins un sujet et si possible d'une autre famille politique. L'objectif est de découvrir d'autres approches, pas d'orienter un vote.</p>
      <h2>6. Confidentialité</h2>
      <p>Le calcul est fait entièrement dans votre navigateur. Vos réponses ne sont envoyées à aucun serveur et ne sont gardées sur votre appareil que si vous l'activez. Le partage de résultat ne contient jamais vos réponses, seulement ce que vous choisissez d'afficher.</p>
      <h2>7. Positions utilisées</h2>
      <p class="fine">* question du test complet uniquement.</p>
      <p class="fine">Dernière mise à jour : ${esc(DATA.quiz.updated || "—")}.</p>
      <div class="table-wrap"><table>${head}${rows}</table></div>`;
    $("#method-body").dataset.done = "1";
  }

  /* ---------------- boot ---------------- */
  function boot() {
    if (DATA.updated_at) {
      const d = new Date(DATA.updated_at);
      $("#updated").textContent = `Agenda vérifié le ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })} à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · ${upcoming().length} événements à venir`;
    }
    initMap();
    initFilters();
    initQuiz();
    renderMeetings(true);
    route();
  }
  boot();
})();
