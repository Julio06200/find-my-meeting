/* Find My Meeting — front (vanilla JS, aucune dépendance hors Leaflet) */
(function () {
  "use strict";

  const DATA = window.FMM || { candidates: [], meetings: [], quiz: { questions: [], positions: {} } };
  const CANDS = Object.fromEntries(DATA.candidates.map((c) => [c.id, c]));
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- stockage local (préférences) ---------------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem("fmm." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("fmm." + k, JSON.stringify(v)); } catch { /* navigation privée */ } },
  };

  const state = Object.assign(
    { place: null, radius: 50, region: "", period: 30, onlyCandidate: false, cands: [] },
    store.get("prefs", {})
  );
  const save = () => store.set("prefs", state);

  /* ---------------- helpers ---------------- */
  const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
  const parseDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
  const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  const addDays = (iso, n) => { const d = parseDate(iso); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  const fmtTime = (t) => (t ? t.replace(":", "h") : "");
  const fmtLong = (iso) => { const d = parseDate(iso); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  function km(a, b) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const TYPE_LABEL = { meeting: "Meeting", reunion: "Réunion publique", rencontre: "Rencontre", debat: "Débat" };

  const upcoming = () => {
    const t = todayISO();
    return DATA.meetings.filter((m) => m.date >= t).map((m) => ({ ...m, dist: state.place ? km(state.place, m) : null }));
  };

  /* ---------------- routing ---------------- */
  function route() {
    const tab = location.hash === "#quiz" ? "quiz" : "meetings";
    $("#view-meetings").hidden = tab !== "meetings";
    $("#view-quiz").hidden = tab !== "quiz";
    $$(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
    if (tab === "meetings" && map) setTimeout(() => map.invalidateSize(), 50);
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  /* ---------------- recherche de ville (geo.api.gouv.fr) ---------------- */
  function cityCombo(input, list, onPick) {
    let items = [], active = -1, timer;
    const close = () => { list.hidden = true; active = -1; };
    const render = () => {
      list.innerHTML = items.map((c, i) =>
        `<li role="option" data-i="${i}" class="${i === active ? "active" : ""}">${esc(c.nom)} <small>${esc(c.codesPostaux?.[0] || "")} · ${esc(c.departement?.nom || "")}</small></li>`).join("");
      list.hidden = !items.length;
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { items = []; return close(); }
      timer = setTimeout(async () => {
        const isCP = /^\d{5}$/.test(q);
        const url = `https://geo.api.gouv.fr/communes?${isCP ? "codePostal" : "nom"}=${encodeURIComponent(q)}&fields=nom,centre,codesPostaux,departement,region&boost=population&limit=6`;
        try { items = await (await fetch(url)).json(); active = -1; render(); } catch { items = []; close(); }
      }, 180);
    });
    input.addEventListener("keydown", (e) => {
      if (list.hidden) return;
      if (e.key === "ArrowDown") { active = Math.min(active + 1, items.length - 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
      else if (e.key === "Enter") { pick(items[Math.max(active, 0)]); e.preventDefault(); }
      else if (e.key === "Escape") close();
    });
    list.addEventListener("mousedown", (e) => { const li = e.target.closest("li"); if (li) pick(items[+li.dataset.i]); });
    input.addEventListener("blur", () => setTimeout(close, 150));
    function pick(c) {
      if (!c || !c.centre) return;
      input.value = c.nom;
      close();
      onPick({ name: c.nom, lat: c.centre.coordinates[1], lon: c.centre.coordinates[0], region: c.region?.nom || "" });
    }
  }

  function geolocate(cb) {
    if (!navigator.geolocation) return alert("La géolocalisation n'est pas disponible sur cet appareil.");
    navigator.geolocation.getCurrentPosition(async (p) => {
      const place = { name: "Ma position", lat: p.coords.latitude, lon: p.coords.longitude, region: "" };
      try {
        const r = await (await fetch(`https://geo.api.gouv.fr/communes?lat=${place.lat}&lon=${place.lon}&fields=nom,region&limit=1`)).json();
        if (r[0]) { place.name = r[0].nom; place.region = r[0].region?.nom || ""; }
      } catch { /* on garde "Ma position" */ }
      cb(place);
    }, () => alert("Impossible d'obtenir votre position. Saisissez votre ville."), { timeout: 10000 });
  }

  /* ---------------- MEETINGS ---------------- */
  let map, layer, meLayer, markers = {};

  function initFilters() {
    const regions = [...new Set(DATA.meetings.map((m) => m.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
    $("#region").insertAdjacentHTML("beforeend", regions.map((r) => `<option>${esc(r)}</option>`).join(""));

    $("#city").value = state.place?.name || "";
    $("#radius").value = String(state.radius);
    $("#region").value = state.region;
    $("#period").value = String(state.period);
    $("#only-candidate").checked = state.onlyCandidate;

    cityCombo($("#city"), $("#city-suggest"), (p) => { state.place = p; save(); renderMeetings(true); });
    $("#city").addEventListener("change", () => { if (!$("#city").value.trim()) { state.place = null; save(); renderMeetings(true); } });
    $("#locate").addEventListener("click", () => geolocate((p) => { state.place = p; $("#city").value = p.name; save(); renderMeetings(true); }));
    $("#radius").addEventListener("change", (e) => { state.radius = +e.target.value; save(); renderMeetings(true); });
    $("#region").addEventListener("change", (e) => { state.region = e.target.value; save(); renderMeetings(true); });
    $("#period").addEventListener("change", (e) => { state.period = +e.target.value; save(); renderMeetings(); });
    $("#only-candidate").addEventListener("change", (e) => { state.onlyCandidate = e.target.checked; save(); renderMeetings(); });

    renderChips();
    $$("#mobile-toggle button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  }

  function setMode(mode) {
    $(".results").dataset.mode = mode;
    $$("#mobile-toggle button").forEach((x) => x.classList.toggle("on", x.dataset.mode === mode));
    if (mode === "map") setTimeout(() => { map.invalidateSize(); fit(); }, 30);
  }

  let chipsExpanded = false;
  function renderChips() {
    const counts = {};
    upcoming().forEach((m) => (counts[m.candidate_id] = (counts[m.candidate_id] || 0) + 1));
    const sorted = [...DATA.candidates].sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0) || a.name.localeCompare(b.name, "fr"));
    const visible = chipsExpanded ? sorted : sorted.filter((c) => counts[c.id] || state.cands.includes(c.id));
    const hidden = sorted.length - visible.length;
    $("#chips").innerHTML =
      `<button type="button" class="chip all ${state.cands.length ? "" : "on"}" data-id="">Tous</button>` +
      visible.map((c) => `<button type="button" class="chip ${state.cands.includes(c.id) ? "on" : ""}" data-id="${c.id}" title="${esc(c.party)}"><i style="background:${c.color}"></i>${esc(c.name)}${counts[c.id] ? ` · ${counts[c.id]}` : ""}</button>`).join("") +
      (hidden ? `<button type="button" class="chip all" id="more-chips">+ ${hidden} autres candidats</button>` : "");
    $("#more-chips")?.addEventListener("click", () => { chipsExpanded = true; renderChips(); });
    $$("#chips .chip[data-id]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.id;
      if (!id) state.cands = [];
      else state.cands = state.cands.includes(id) ? state.cands.filter((x) => x !== id) : [...state.cands, id];
      save(); renderChips(); renderMeetings(true);
    }));
  }

  function filtered() {
    const t = todayISO();
    const end = state.period ? addDays(t, state.period) : "9999";
    return upcoming().filter((m) =>
      m.date <= end &&
      (!state.region || m.region === state.region) &&
      (!state.cands.length || state.cands.includes(m.candidate_id)) &&
      (!state.onlyCandidate || m.with_candidate) &&
      (!state.place || !state.radius || m.dist <= state.radius)
    ).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  }

  function cardHTML(m) {
    const c = CANDS[m.candidate_id] || { name: m.candidate_id, party: "", color: "#2B2483" };
    const d = parseDate(m.date);
    const badges = [
      m.with_candidate ? `<span class="badge red">${esc(c.name.split(" ").slice(-1)[0])} en personne</span>` : "",
      `<span class="badge">${TYPE_LABEL[m.type] || "Événement"}</span>`,
      m.access === "inscription" ? `<span class="badge warn">Sur inscription</span>` : "",
      m.access === "a_verifier" ? `<span class="badge warn">Accès à vérifier</span>` : "",
      m.dist != null ? `<span class="badge dist">${m.dist < 1 ? "< 1" : Math.round(m.dist)} km</span>` : "",
    ].join("");
    const speakers = m.speakers?.length && !(m.with_candidate && m.speakers.length === 1)
      ? `<p class="speakers">Avec ${esc(m.speakers.join(", "))}</p>` : "";
    const place = [m.venue, m.address].filter(Boolean).join(", ");
    return `<li class="card" style="--c:${c.color}" data-id="${esc(m.id)}">
      <div class="date"><span>${DAYS[d.getDay()]}</span><b>${d.getDate()}</b><span>${MONTHS[d.getMonth()]}</span>${m.time ? `<em>${fmtTime(m.time)}</em>` : ""}</div>
      <div class="body">
        <h3>${esc(m.title)}</h3>
        <p class="who"><b>${esc(c.name)}</b> · ${esc(c.party)}</p>
        <p class="where">📍 ${place ? esc(place) + " — " : ""}<b>${esc(m.city)}</b>${m.department ? ` (${esc(m.department)})` : ""}</p>
        ${speakers}
        <div class="badges">${badges}</div>
        <div class="actions">
          <a href="${esc(m.url)}" target="_blank" rel="noopener">Source ↗</a>
          <button type="button" data-ics="${esc(m.id)}">+ Agenda</button>
          <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([m.venue, m.address, m.city].filter(Boolean).join(", "))}" target="_blank" rel="noopener">Itinéraire</a>
          <button type="button" data-share="${esc(m.id)}">Partager</button>
        </div>
      </div></li>`;
  }

  function renderMeetings(refit) {
    const items = filtered();
    const n = items.length;
    const where = state.place ? (state.radius ? ` à moins de ${state.radius} km de ${state.place.name}` : "") : state.region ? ` en ${state.region}` : "";
    $("#count").textContent = `${n} événement${n > 1 ? "s" : ""}${where}`;

    if (!n) {
      const total = upcoming().length;
      $("#list").innerHTML = `<li class="empty"><b>Aucun meeting avec ces filtres.</b>${state.place && state.radius && state.radius < 200
        ? `Essayez d'élargir le rayon. <br><br><button class="btn ghost" type="button" id="widen">Élargir à ${state.radius < 100 ? 100 : 200} km</button>`
        : total ? "Essayez d'élargir la période ou de retirer un filtre." : "L'agenda sera rempli au prochain passage du robot, demain matin."}</li>`;
      $("#widen")?.addEventListener("click", () => { state.radius = state.radius < 100 ? 100 : 200; $("#radius").value = String(state.radius); save(); renderMeetings(true); });
    } else {
      $("#list").innerHTML = items.map(cardHTML).join("");
    }
    drawMap(items, refit);
  }

  function initMap() {
    map = L.map("map", { zoomControl: true, scrollWheelZoom: true }).setView([46.6, 2.4], 5);
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
    // regroupe les événements au même endroit
    const groups = {};
    items.forEach((m) => { const k = m.lat.toFixed(3) + "," + m.lon.toFixed(3); (groups[k] = groups[k] || []).push(m); });
    Object.values(groups).forEach((g) => {
      const m = g[0], c = CANDS[m.candidate_id] || { color: "#2B2483" };
      const icon = L.divIcon({ className: "", html: `<div class="pin" style="--c:${c.color}"></div>`, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });
      const html = g.map((x) => { const cx = CANDS[x.candidate_id] || {}; return `<div style="margin-bottom:6px"><b>${esc(cx.name || "")}</b><br>${esc(fmtLong(x.date))}${x.time ? " · " + fmtTime(x.time) : ""}<br>${esc(x.title)}<br>${esc(x.venue || "")} ${esc(x.city)}<br><a href="${esc(x.url)}" target="_blank" rel="noopener">Source ↗</a></div>`; }).join("");
      const mk = L.marker([m.lat, m.lon], { icon }).bindPopup(html).addTo(layer);
      g.forEach((x) => (markers[x.id] = mk));
    });
    if (state.place) {
      L.marker([state.place.lat, state.place.lon], { icon: L.divIcon({ className: "", html: '<div class="me-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }).addTo(meLayer);
      if (state.radius) L.circle([state.place.lat, state.place.lon], { radius: state.radius * 1000, color: "#E5383B", weight: 1, fillOpacity: 0.05 }).addTo(meLayer);
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

  /* interactions sur les cartes */
  document.addEventListener("click", (e) => {
    const ics = e.target.closest("[data-ics]");
    if (ics) return downloadICS(DATA.meetings.find((m) => m.id === ics.dataset.ics));
    const sh = e.target.closest("[data-share]");
    if (sh) return share(DATA.meetings.find((m) => m.id === sh.dataset.share));
    const card = e.target.closest(".card");
    if (card && !e.target.closest("a,button")) {
      const mk = markers[card.dataset.id];
      if (!mk) return;
      if (window.matchMedia("(max-width: 860px)").matches) setMode("map");
      setTimeout(() => { map.setView(mk.getLatLng(), 12); mk.openPopup(); }, 60);
    }
  });

  function downloadICS(m) {
    if (!m) return;
    const c = CANDS[m.candidate_id] || {};
    const d = m.date.replace(/-/g, "");
    const t = (m.time || "").replace(":", "");
    const pad = (s) => String(s).padStart(2, "0");
    let dtStart, dtEnd;
    if (t) {
      const h = +t.slice(0, 2), mi = +t.slice(2);
      dtStart = `DTSTART;TZID=Europe/Paris:${d}T${pad(h)}${pad(mi)}00`;
      dtEnd = `DTEND;TZID=Europe/Paris:${d}T${pad(Math.min(h + 2, 23))}${pad(mi)}00`;
    } else {
      dtStart = `DTSTART;VALUE=DATE:${d}`;
      dtEnd = `DTEND;VALUE=DATE:${addDays(m.date, 1).replace(/-/g, "")}`;
    }
    const icsEsc = (s) => String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
    const body = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Find My Meeting//FR", "BEGIN:VEVENT",
      `UID:${m.id}@findmymeeting`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`, dtStart, dtEnd,
      `SUMMARY:${icsEsc(`${m.title} (${c.name || ""})`)}`,
      `LOCATION:${icsEsc([m.venue, m.address, m.city].filter(Boolean).join(", "))}`,
      `DESCRIPTION:${icsEsc("Source : " + m.url)}`, `URL:${m.url}`, "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/calendar" }));
    a.download = `meeting-${m.city}-${m.date}.ics`.replace(/\s+/g, "-");
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function share(m) {
    if (!m) return;
    const c = CANDS[m.candidate_id] || {};
    const text = `${m.title} — ${c.name}, ${fmtLong(m.date)}${m.time ? " à " + fmtTime(m.time) : ""}, ${m.city}`;
    try {
      if (navigator.share) await navigator.share({ title: "Find My Meeting", text, url: m.url });
      else { await navigator.clipboard.writeText(`${text}\n${m.url}`); alert("Lien copié !"); }
    } catch { /* annulé */ }
  }

  /* ---------------- QUIZ ---------------- */
  const Q = DATA.quiz.questions || [];
  let qi = 0, answers = {};

  function initQuiz() {
    $("#quiz-disclaimer").textContent = DATA.quiz.disclaimer || "";
    $("#quiz-start").addEventListener("click", () => { qi = 0; answers = {}; showQ(); });
    $("#quiz-restart").addEventListener("click", () => { qi = 0; answers = {}; showQ(); });
    $$("#answers button").forEach((b) => b.addEventListener("click", () => {
      answers[Q[qi].id] = { v: +b.dataset.v, w: $("#q-important").checked ? 2 : 1 };
      next();
    }));
    $("#q-skip").addEventListener("click", () => { delete answers[Q[qi].id]; next(); });
    $("#q-back").addEventListener("click", () => { if (qi > 0) { qi--; showQ(); } else { show("intro"); } });
    const saved = store.get("quiz", null);
    if (saved && saved.answers) { answers = saved.answers; showResult(); }
  }

  function show(which) {
    $("#quiz-intro").hidden = which !== "intro";
    $("#quiz-q").hidden = which !== "q";
    $("#quiz-result").hidden = which !== "result";
  }
  function next() { qi++; if (qi >= Q.length) { store.set("quiz", { answers }); showResult(); } else showQ(); }
  function showQ() {
    show("q");
    const q = Q[qi], a = answers[q.id];
    $("#quiz-bar").style.width = `${(qi / Q.length) * 100}%`;
    $("#q-num").textContent = `Question ${qi + 1}/${Q.length}`;
    $("#q-theme").textContent = q.theme;
    $("#q-text").textContent = q.text;
    $("#q-important").checked = a ? a.w === 2 : false;
    $$("#answers button").forEach((b) => b.classList.toggle("on", !!a && +b.dataset.v === a.v));
  }

  function scores() {
    const P = DATA.quiz.positions || {};
    return Object.keys(P).filter((id) => CANDS[id]).map((id) => {
      let s = 0, w = 0;
      for (const q of Q) {
        const a = answers[q.id];
        if (!a || P[id][q.id] == null) continue;
        s += (1 - Math.abs(a.v - P[id][q.id]) / 4) * a.w;
        w += a.w;
      }
      return { id, pct: w ? Math.round((s / w) * 100) : 0 };
    }).sort((a, b) => b.pct - a.pct);
  }

  function nearestFor(id, n) {
    const list = upcoming().filter((m) => m.candidate_id === id);
    if (state.place) list.sort((a, b) => a.dist - b.dist);
    else list.sort((a, b) => a.date.localeCompare(b.date));
    return list.slice(0, n);
  }

  function showResult() {
    show("result");
    const answered = Object.keys(answers).length;
    $("#result-note").textContent = `Basé sur ${answered} réponse${answered > 1 ? "s" : ""}. ${DATA.quiz.disclaimer || ""}`;
    $("#result-where").innerHTML = `
      <div class="field grow"><label for="quiz-city">${state.place ? "Meetings proches de" : "Votre ville, pour voir les meetings proches"}</label>
        <div class="combo"><input id="quiz-city" type="text" placeholder="Ex. Lille" autocomplete="off" value="${esc(state.place?.name || "")}"><ul id="quiz-suggest" class="suggest" hidden></ul></div></div>
      <button class="btn ghost" type="button" id="quiz-locate">📍 Autour de moi</button>`;
    cityCombo($("#quiz-city"), $("#quiz-suggest"), (p) => { state.place = p; save(); $("#city").value = p.name; renderMeetings(true); showResult(); });
    $("#quiz-locate").addEventListener("click", () => geolocate((p) => { state.place = p; save(); $("#city").value = p.name; renderMeetings(true); showResult(); }));

    const ranking = scores();
    $("#ranking").innerHTML = ranking.map((r, i) => {
      const c = CANDS[r.id];
      const top = i < 3;
      const near = top ? nearestFor(r.id, 3) : [];
      const meetings = top ? (near.length
        ? `<ul class="rank-meetings">${near.map((m) => `<li><span>${esc(fmtLong(m.date))}${m.time ? " · " + fmtTime(m.time) : ""} — <b>${esc(m.city)}</b>${m.dist != null ? ` (${Math.round(m.dist)} km)` : ""}<br><small>${esc(m.title)}</small></span><a href="${esc(m.url)}" target="_blank" rel="noopener">Voir ↗</a></li>`).join("")}</ul>`
        : `<p class="rank-note">Aucun meeting à venir recensé pour l'instant.</p>`) : "";
      return `<li class="rank ${top ? "top" : ""}" style="--c:${c.color}">
        <div class="rank-head"><span class="rank-pos">${i + 1}</span>
          <span class="rank-name"><b>${esc(c.name)}</b><small>${esc(c.party)}</small></span>
          <span class="rank-pct">${r.pct}%</span></div>
        <div class="bar"><span style="width:${r.pct}%"></span></div>
        ${c.note && top ? `<p class="rank-note">ℹ️ ${esc(c.note)}</p>` : ""}
        ${meetings}
        ${top ? `<button type="button" class="rank-more" data-goto="${r.id}">Tous ses meetings sur la carte →</button>` : ""}
      </li>`;
    }).join("");
    $$("[data-goto]").forEach((b) => b.addEventListener("click", () => {
      state.cands = [b.dataset.goto]; state.region = ""; $("#region").value = "";
      save(); renderChips(); location.hash = "#meetings"; setTimeout(() => renderMeetings(true), 80);
    }));
  }

  /* ---------------- boot ---------------- */
  function boot() {
    if (DATA.updated_at) {
      const d = new Date(DATA.updated_at);
      $("#updated").textContent = `Agenda mis à jour le ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })} à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · ${upcoming().length} événements à venir`;
    }
    initMap();
    initFilters();
    initQuiz();
    route();
    renderMeetings(true);
  }
  boot();
})();
