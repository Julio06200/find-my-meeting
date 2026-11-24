"""Lecteurs d'agenda gratuits (sans IA) pour les sites officiels des candidats.

Chaque lecteur renvoie une liste de dicts au format Event de scrape.py.
Pour ajouter un site : écrire une fonction parse_xxx() et l'ajouter à PARSERS
(clé = domaine des URL d'événements, sans « www. »).

COMPLETE : sources dont le lecteur voit TOUS les événements à venir. Seules celles-ci
permettent de signaler un événement « n'apparaît plus sur l'agenda officiel ».

Sites sans agenda lisible automatiquement (couverts par la veille Claude du matin) :
Attal, Retailleau, Le Pen, Zemmour, Roussel, Tondelier, Philippot, Labib, Markovic,
Lalanne, Polony, Riner, Dupont-Aignan (agenda sans lieux exploitables).
"""

from __future__ import annotations

import datetime as dt
import html as htmllib
import json
import re
import urllib.parse
import urllib.request
from typing import Callable, Dict, Iterable, List, Optional

UA = "Mozilla/5.0 (compatible; FindMyMeeting/1.0; +https://julio06200.github.io/find-my-meeting/)"
MONTHS = {m: i + 1 for i, m in enumerate(
    ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"])}
MONTHS_ABBR = {"janv": 1, "jan": 1, "févr": 2, "fév": 2, "fevr": 2, "mars": 3, "avr": 4, "mai": 5, "juin": 6, "juil": 7,
               "août": 8, "aout": 8, "sept": 9, "sep": 9, "oct": 10, "nov": 11, "déc": 12, "dec": 12}
DAYS = r"(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)"
DATE_RE = re.compile(DAYS + r"?\s*(\d{1,2})(?:er)?\s+(" + "|".join(MONTHS) + r")\s+(\d{4})", re.I)
DATE_NOYEAR_RE = re.compile(DAYS + r"\s+(\d{1,2})(?:er)?\s+(" + "|".join(MONTHS) + r")(?:\s+(\d{4}))?", re.I)
SMALL = {"de", "du", "des", "la", "le", "les", "et", "à", "en", "au", "aux", "d", "l", "sur", "sous", "lès", "lez", "avec", "pour"}
PLACEHOLDER = re.compile(r"nouveau lieu|lieu (?:à venir|à définir|à préciser|communiqué)|à venir|à définir|tbc|tba", re.I)


# --------------------------------------------------------------------------- outils

def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "fr-FR,fr"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def text_of(fragment: str) -> List[str]:
    fragment = re.sub(r"<(script|style|svg)\b.*?</\1>", " ", fragment, flags=re.S | re.I)
    txt = htmllib.unescape(re.sub(r"<[^>]+>", "\n", fragment))
    return [l.strip() for l in txt.split("\n") if l.strip()]


def iso_date(s: str):
    m = DATE_RE.search(s)
    if not m:
        return None
    d, mon, y = int(m.group(1)), MONTHS[m.group(2).lower()], int(m.group(3))
    return f"{y:04d}-{mon:02d}-{d:02d}"


def today() -> dt.date:
    return (dt.datetime.utcnow() + dt.timedelta(hours=1)).date()


def infer_year(day: int, month: int) -> Optional[str]:
    """Date sans année d'un agenda à venir : l'année courante, ou la suivante si la date est déjà passée de plus de 7 jours."""
    t = today()
    try:
        d = dt.date(t.year, month, day)
    except ValueError:
        return None
    if d < t - dt.timedelta(days=7):
        d = dt.date(t.year + 1, month, day)
    return d.isoformat()


def paris_local(iso: str):
    """« 2026-11-26T17:30:00.000Z » -> ('2026-11-26', '18:30') en heure de Paris (sans dépendance tzdata)."""
    s = iso.strip().replace("Z", "+00:00")
    try:
        d = dt.datetime.fromisoformat(s[:19] + s[23:] if re.match(r".*\.\d{3}[+-]", s) else s)
    except ValueError:
        return (iso[:10], None)
    if d.tzinfo is None:
        return (d.date().isoformat(), d.strftime("%H:%M") if (d.hour or d.minute) else None)
    u = d.astimezone(dt.timezone.utc).replace(tzinfo=None)
    y = u.year
    def last_sunday(m):
        x = dt.date(y, m, 31)
        return x - dt.timedelta(days=(x.weekday() + 1) % 7)
    summer = dt.datetime.combine(last_sunday(3), dt.time(1)) <= u < dt.datetime.combine(last_sunday(10), dt.time(1))
    loc = u + dt.timedelta(hours=2 if summer else 1)
    return (loc.date().isoformat(), loc.strftime("%H:%M"))


def nice_title(s: str) -> str:
    """Titres en MAJUSCULES -> casse lisible."""
    s = htmllib.unescape(s).strip()
    if s.upper() != s:
        return s
    def fix(word, first):
        parts = word.split("-")
        return "-".join(p.lower() if (k or not first) and p.lower() in SMALL else p for k, p in enumerate(parts))
    words = s.lower().title().split(" ")
    out = " ".join(fix(w, i == 0) for i, w in enumerate(words))
    return re.sub(r"\b([DL])'", lambda m: m.group(1).lower() + "'", out[:1]) + re.sub(r"\b([DL])'", lambda m: m.group(1).lower() + "'", out[1:])


def clean_city(c: str) -> str:
    c = re.sub(r"\s+", " ", htmllib.unescape(c or "")).strip(" ,.-")
    c = re.sub(r"\s+\d{1,2}\s*(?:e|er|ème|eme)$", "", c, flags=re.I)  # « Paris 16E » -> Paris
    return nice_title(c) if c.isupper() else c


def event(cid, *, title, date, city, url, source, time=None, venue=None, address=None, speakers=None,
          with_candidate=False, type_=None, status="confirme", status_note=None, access="public") -> Optional[dict]:
    if not (date and city and url):
        return None
    t = (title or "").strip()
    return {
        "candidate_id": cid, "title": t, "date": date, "time": time, "city": clean_city(city),
        "venue": (None if not venue or PLACEHOLDER.search(venue) else venue), "address": (address or None), "speakers": speakers or [],
        "with_candidate": bool(with_candidate),
        "type": type_ or ("meeting" if re.search(r"meeting", t, re.I) else "debat" if re.search(r"débat|debat", t, re.I)
                          else "rencontre" if re.search(r"rencontre|conférence|conference", t, re.I) else "reunion"),
        "access": access, "url": url, "source": source, "source_kind": "officiel",
        "status": "annule" if re.search(r"\bannul", t, re.I) else status, "status_note": status_note,
    }


def jsonld_events(page: str) -> List[dict]:
    """Tous les objets schema.org de type Event (et sous-types) d'une page, y compris dans @graph / ItemList."""
    out = []
    def walk(o):
        if isinstance(o, list):
            for x in o: walk(x)
        elif isinstance(o, dict):
            t = o.get("@type")
            types = t if isinstance(t, list) else [t]
            if any(isinstance(x, str) and x.endswith("Event") for x in types):
                out.append(o)
            for k in ("@graph", "mainEntity", "hasPart", "itemListElement", "item", "subEvent", "event", "events"):
                if k in o: walk(o[k])
    for m in re.finditer(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', page, re.S | re.I):
        try:
            walk(json.loads(m.group(1)))
        except Exception:
            continue
    return out


def ld_place(ev: dict):
    """(lieu, adresse, commune, pays) depuis location schema.org."""
    loc = ev.get("location") or {}
    if isinstance(loc, list): loc = loc[0] if loc else {}
    if isinstance(loc, str): return (None, None, loc, None)
    name = (loc.get("name") or "").strip()
    a = loc.get("address") or {}
    if isinstance(a, str): a = {"streetAddress": a}
    city = (a.get("addressLocality") or "").strip()
    country = (a.get("addressCountry") or "")
    if isinstance(country, dict): country = country.get("name", "")
    street = (a.get("streetAddress") or "").strip()
    return (name or None, street or None, city or None, country or None)


def ld_offline(ev: dict) -> bool:
    return "Online" not in str(ev.get("eventAttendanceMode", ""))


def ld_status(ev: dict) -> str:
    s = str(ev.get("eventStatus", ""))
    return "annule" if "Cancelled" in s else "a_confirmer" if ("Postponed" in s or "Rescheduled" in s) else "confirme"


def upcoming(date: Optional[str]) -> bool:
    return bool(date) and date >= today().isoformat()


# --------------------------------------------------------------------------- LFI (Mélenchon)

def parse_melenchon() -> List[dict]:
    """melenchon2027.fr/agenda-de-campagne : cartes Elementor role="listitem"."""
    page = fetch("https://melenchon2027.fr/agenda-de-campagne/")
    items = re.split(r'role="listitem"', page)[1:]
    out: Dict[str, dict] = {}
    for it in items:
        it = re.split(r"<footer|elementor-location-footer", it)[0]  # le dernier bloc contient le pied de page
        url_m = re.search(r'href="(https://melenchon2027\.fr/evenement/[^"]+)"', it)
        if not url_m:
            continue
        url = url_m.group(1)
        if url in out:
            continue
        lines = text_of(it)
        joined = " | ".join(lines)
        date = iso_date(joined)
        if not date:
            continue
        time_m = re.search(r"\b(\d{1,2})[:h](\d{2})\b", joined)
        title_m = re.search(r'<h[24] [^>]*>\s*([^<]{6,}?)\s*</h[24]>', it)
        if title_m:
            title = htmllib.unescape(title_m.group(1)).strip()
        else:  # les cartes « réunion publique » n'ont pas de titre : on lit la page de l'événement
            title = "Réunion publique"
            try:
                ev_page = fetch(url)
                og = re.search(r'<meta property="og:title" content="([^"]+)"', ev_page)
                h1 = re.search(r"<h1\b[^>]*>([^<]{6,})</h1>", ev_page)
                raw = (og.group(1) if og else h1.group(1) if h1 else "")
                raw = re.sub(r"\s*[-|]\s*Mélenchon 2027.*$", "", htmllib.unescape(raw)).strip()
                title = raw or title
            except Exception:
                pass
        addr_m = re.search(r'adresse_evt[^>]*>([^<]+)<', it)
        addr = htmllib.unescape(addr_m.group(1)).strip() if addr_m else ""
        city_m = re.search(r"\(([^()]+)\)\s*$", addr)  # format "Salle X (Ville)"
        city = (city_m.group(1) if city_m else addr).split(",")[0].strip()
        venue = addr[: city_m.start()].strip() if city_m else None
        if not city:
            continue
        speakers = []
        sp_m = re.search(r"avec (.+)$", title, re.I)
        if sp_m:
            speakers = [s.strip() for s in re.split(r",| et ", sp_m.group(1)) if s.strip()]
        is_jlm = "/evenement/jlm/" in url or "Jean-Luc Mélenchon" in title
        e = event("melenchon", title=title, date=date, city=city, venue=venue, url=url, source="melenchon2027.fr",
                  time=f"{int(time_m.group(1)):02d}:{time_m.group(2)}" if time_m else None,
                  speakers=speakers or (["Jean-Luc Mélenchon"] if is_jlm else []), with_candidate=is_jlm)
        if e: out[url] = e
    return list(out.values())


# --------------------------------------------------------------------------- Lutte ouvrière (Arthaud)

def parse_arthaud() -> List[dict]:
    """lutte-ouvriere.org/portail/agenda : cartes « Teaser--evenement <type> » ; lieu sur la page de l'événement."""
    base = "https://www.lutte-ouvriere.org"
    page = fetch(base + "/portail/agenda/")
    out = []
    seen = set()
    for m in re.finditer(r'<a class="?Teaser--evenement ([a-z -]+?)"? href=([^ >]+)>(.*?)</a>', page, re.S):
        kind, href, card = m.group(1).split()[0], m.group(2).strip('"'), m.group(3)  # « reunion-publique sticky » (à la une)
        if href in seen:
            continue
        seen.add(href)
        if kind not in ("reunion-publique", "meeting", "fete-regionale"):
            continue  # on écarte les stands « à votre rencontre » et les manifestations
        day = re.search(r'Date-day-number>\s*(\d{1,2})', card)
        mon = re.search(r'Date-day-month>\s*([a-zéû]+)', card)
        if not (day and mon):
            continue
        month = MONTHS_ABBR.get(mon.group(1).rstrip(".").lower())
        date = infer_year(int(day.group(1)), month) if month else None
        if not upcoming(date):
            continue
        title_m = re.search(r'Teaser-title>(.*?)</h2>', card, re.S)
        th = title_m.group(1) if title_m else ""
        sub_m = re.search(r'class=["\']?soustitre["\']?>(.*?)</span>', th, re.S)
        sub = " ".join(text_of(sub_m.group(1))) if sub_m else ""
        head = th[: th.rfind("<", 0, sub_m.start())] if sub_m else th
        city = re.sub(r"[\s\-‐-―]+$", "", " ".join(text_of(head)))
        time_m = re.search(r"à\s*(\d{1,2})h(\d{2})?", " ".join(text_of(card)))
        url = urllib.parse.urljoin(base, href)
        venue = address = None
        speakers = []
        city = re.sub(r"^F[êe]te (?:r[ée]gionale )?(?:de |du |d['’]|des )?", "", city, flags=re.I)  # « Fête de Montbéliard »
        if len(city) > 35 or not city:  # carte titrée par un thème : la commune est dans le sous-titre « Angers, salle … »
            city = sub.split(",")[0].strip() if sub else city
        try:
            page_ev = fetch(url).split("<main", 1)[-1]
            header = re.search(r"Content-header-titre>(.*?)</header>", page_ev, re.S)
            sp = re.search(r"<h3>\s*avec\s+(.*?)</h3>", header.group(1) if header else "", re.S | re.I)
            speakers = [s.strip() for s in re.split(r",| et ", " ".join(text_of(sp.group(1)))) if s.strip()] if sp else []
            body = re.search(r"Content-body[^>]*>(.*?)</section>", page_ev, re.S)
            lines = text_of(body.group(1)) if body else []
            k = next((i for i, l in enumerate(lines) if DATE_NOYEAR_RE.search(l) or re.search(r"\d{1,2}h\d{0,2}", l)), None)
            place = [l for l in lines[k + 1:k + 4]] if k is not None else []
            ok = lambda s: (s and len(s) <= 90 and not s.startswith(("(", "-", "–"))
                            and not re.search(r"entrée|libre|réunion publique|meeting|avec |arrêt|tram|métro|bus |\.$", s, re.I) and not s.isupper())
            place = [l for l in place if ok(l)]
            if place:
                first = place[0]
                if "," in first:
                    venue, _, address = [x.strip() for x in first.partition(",")]
                else:
                    venue = first
                    address = place[1] if len(place) > 1 else None
        except Exception:
            pass
        sub = sub.strip() or ("Meeting" if kind == "meeting" else "Réunion publique")
        title = f"{sub} à {city.strip()}" if city.strip().lower() not in sub.lower() else sub
        e = event("arthaud", title=title, date=date, city=city, venue=venue, address=address, url=url,
                  source="lutte-ouvriere.org", time=f"{int(time_m.group(1)):02d}:{time_m.group(2) or '00'}" if time_m else None,
                  with_candidate="Arthaud" in sub or any("Arthaud" in s for s in speakers),
                  speakers=speakers or (["Nathalie Arthaud"] if "Arthaud" in sub else []),
                  type_="meeting" if kind == "meeting" else "rencontre" if kind == "fete-regionale" else "reunion")
        if e: out.append(e)
    return out


# --------------------------------------------------------------------------- Nouvelle Énergie (Lisnard)

def parse_lisnard() -> List[dict]:
    """unenouvelleenergie.fr/agenda : liste schema.org Event, paginée (?page=N)."""
    keep = re.compile(r"R[ÉE]UNION PUBLIQUE|MEETING|TOUR D|CONF[ÉE]RENCE|RENCONTRE|D[ÉE]BAT", re.I)
    drop = re.compile(r"AFTERWORK|AP[ÉE]RO|ADH[ÉE]RENT|BEAUJOLAIS|FORMATION|D[ÎI]NER|SOIR[ÉE]E|VISIO|NOUVEAUX|PERMANENCE", re.I)
    out, seen = [], set()
    for n in range(1, 16):
        page = fetch("https://www.unenouvelleenergie.fr/agenda/" + (f"?page={n}" if n > 1 else ""))
        evs = jsonld_events(page)
        new = [e for e in evs if e.get("url") not in seen]
        if not new:
            break
        for ev in new:
            seen.add(ev.get("url"))
            name = ev.get("name") or ""
            if not keep.search(name) or drop.search(name) or not ld_offline(ev):
                continue
            date, time = paris_local(ev.get("startDate", ""))
            if not upcoming(date):
                continue
            venue, street, city, _ = ld_place(ev)
            if not city and venue:  # « Salle du Verdet, LIBOURNE, GIRONDE » : … lieu, COMMUNE, DÉPARTEMENT
                parts = [p.strip() for p in venue.split(",") if p.strip()]
                if len(parts) >= 3:
                    venue, city = ", ".join(parts[:-2]), parts[-2]
                elif len(parts) == 2:  # « LANDERNEAU, FINISTÈRE » (commune, département) ou « Lieu, COMMUNE »
                    venue, city = (None, parts[0]) if parts[0].isupper() and parts[1].isupper() else tuple(parts)
                else:
                    venue, city = None, parts[0] if parts else None
            desc = ev.get("description") or ""
            present = "LISNARD" in name.upper() or bool(re.search(r"(avec|en présence de|aux côtés de)\s+David Lisnard", desc, re.I))
            e = event("lisnard", title=nice_title(name), date=date, time=time, city=city or "", venue=venue, address=street,
                      url=ev.get("url"), source="unenouvelleenergie.fr", with_candidate=present,
                      speakers=["David Lisnard"] if present else [], status=ld_status(ev))
            if e: out.append(e)
    return out


# --------------------------------------------------------------------------- UPR (Asselineau)

def parse_asselineau() -> List[dict]:
    """upr.fr/agenda : cartes AgendaEventCard ; on garde les réunions publiques de François Asselineau."""
    page = fetch("https://upr.fr/agenda")
    out = []
    for m in re.finditer(r'AgendaEventCard__day[^>]*>\s*(\d{1,2})\s*<.*?AgendaEventCard__month[^>]*>\s*([a-zéû.]+)\s*<(.*?)href="(/agenda/[^"]+)"', page, re.S):
        day, mon, body, href = m.groups()
        title_m = re.search(r"<h3[^>]*>(.*?)</h3>", body, re.S)
        title = " ".join(text_of(title_m.group(1))) if title_m else ""
        if not re.search(r"réunion publique|meeting|conférence", title, re.I) or "Asselineau" not in title:
            continue
        month = MONTHS_ABBR.get(mon.rstrip(".").lower())
        date = infer_year(int(day), month) if month else None
        if not upcoming(date):
            continue
        city_m = re.search(r"\bà ([^()]+?)(?:\s*\(|$)", title)
        time_m = re.search(r"(\d{1,2}):(\d{2})", " ".join(text_of(body)))
        e = event("asselineau", title=title, date=date, city=city_m.group(1) if city_m else "", url="https://upr.fr" + href,
                  source="upr.fr", time=f"{int(time_m.group(1)):02d}:{time_m.group(2)}" if time_m else None,
                  with_candidate=True, speakers=["François Asselineau"])
        if e: out.append(e)
    return out


# --------------------------------------------------------------------------- Horizons / Qomon (Philippe)

def parse_philippe() -> List[dict]:
    """Formulaires d'inscription « réunion publique » liés depuis edouardphilippe.fr (plateforme Qomon)."""
    links = set()
    for hub in ("https://www.edouardphilippe.fr/", "https://action.edouardphilippe.fr/fr/"):
        try:
            for h in re.findall(r'(?:https://action\.edouardphilippe\.fr)?(/(?:fr/)?online-form/[0-9a-f]{8}-[a-z0-9-]*(?:reunion|meeting)[a-z0-9-]*)', fetch(hub)):
                links.add("https://action.edouardphilippe.fr" + h)
        except Exception:
            pass
    out = []
    for url in sorted(links)[:30]:
        try:
            lines = text_of(fetch(url))
        except Exception:
            continue
        title = next((l for l in lines if re.search(r"réunion publique|meeting", l, re.I)), "")
        joined = " | ".join(lines)
        dm = DATE_NOYEAR_RE.search(joined)
        if not (title and dm):
            continue
        month = MONTHS[dm.group(2).lower()]
        date = f"{dm.group(3)}-{month:02d}-{int(dm.group(1)):02d}" if dm.group(3) else infer_year(int(dm.group(1)), month)
        if not upcoming(date):
            continue
        city_m = re.search(r"\s[àÀ]\s+(.+)$", title)
        city = "-".join(w[:1].upper() + w[1:] for w in city_m.group(1).strip().split("-")) if city_m else ""
        title = re.sub(r"\s[àÀ]\s+.+$", f" à {city}", title) if city else title
        k = next((i for i, l in enumerate(lines) if l.startswith("📍")), None)
        place = ""
        if k is not None:
            place = lines[k].lstrip("📍").strip() or (lines[k + 1] if k + 1 < len(lines) else "")
        unknown = not place or bool(re.search(r"à venir|à préciser|communiqué|prochainement", place, re.I))
        date_line = next((l for l in lines if dm.group(0) in l), "")
        time_m = re.search(r"(\d{1,2})\s*h\s*(\d{2})?", date_line) or (None if unknown else re.search(r"(\d{1,2})\s*h\s*(\d{2})?", place))
        venue = address = None
        if not unknown:
            venue, _, address = [x.strip() for x in place.partition(",")] if "," in place else (place, "", "")
            if re.match(r"^\d", venue or ""):  # « 50 Avenue … » : c'est une adresse
                venue, address = None, place
            arts = re.search(r"à l[’']([A-ZÉ][\w\s’'-]+?)\s+(?:de\s+)?" + re.escape(city), joined) if city else None
            venue = venue or (arts.group(1).strip() if arts else None)
        confirmed = not unknown and bool(time_m)
        e = event("philippe", title=title, date=date, city=city, venue=venue, address=address or None, url=url,
                  source="edouardphilippe.fr", time=f"{int(time_m.group(1)):02d}:{time_m.group(2) or '00'}" if time_m else None,
                  with_candidate="Philippe" in title or "-ep-" in url, speakers=["Édouard Philippe"],
                  status="confirme" if confirmed else "a_confirmer",
                  status_note=None if confirmed else ("Date et ville annoncées par l'équipe d'Édouard Philippe ; lieu et horaire à venir."
                                                      if unknown else "Date et lieu annoncés par l'équipe d'Édouard Philippe ; horaire à venir."))
        if e: out.append(e)
    return out


# --------------------------------------------------------------------------- Debout ! / Qomon (Ruffin)

def parse_ruffin() -> List[dict]:
    """action.debout.fr (Qomon) : pages d'action avec schema.org Event ; on garde meetings et réunions publiques."""
    keep = re.compile(r"meeting|reunion-publique|rencontre|conference|debat|entretien", re.I)
    drop = re.compile(r"visio|tractage|collage|militant|rdv|bi-mensuelle|appel|porte-a-porte|phoning|formation|distanciel", re.I)
    links = set()
    for hub in ("https://action.debout.fr/fr/", "https://nouspresident.fr/"):
        try:
            for h in re.findall(r'(?:https://action\.debout\.fr)?(/fr/action/[0-9a-f]{8}-[a-z0-9-]+)', fetch(hub)):
                if keep.search(h) and not drop.search(h):
                    links.add("https://action.debout.fr" + h.rstrip("/"))
        except Exception:
            pass
    out = []
    for url in sorted(links)[:30]:
        try:
            evs = jsonld_events(fetch(url))
        except Exception:
            continue
        for ev in evs[:1]:
            date, time = paris_local(ev.get("startDate", ""))
            if not upcoming(date) or not ld_offline(ev):
                continue
            venue, street, city, country = ld_place(ev)
            if country and "france" not in str(country).lower():
                continue
            name = ev.get("name") or ""
            present = "Ruffin" in name
            if not (present or re.search(r"meeting|réunion publique", name, re.I)):
                continue  # dédicaces, conférences de soutiens… : pas un meeting de campagne
            if venue and re.search(r"\d{5}", venue):  # « 32 rue …, 30100 Alès » : c'est l'adresse complète
                venue = None
            e = event("ruffin", title=name, date=date, time=time, city=city or "", venue=venue if venue and venue != street else None,
                      address=street, url=url, source="action.debout.fr", with_candidate=present,
                      speakers=["François Ruffin"] if present else [], status=ld_status(ev))
            if e: out.append(e)
    return out


# --------------------------------------------------------------------------- Glucksmann (page meeting)

def parse_glucksmann() -> List[dict]:
    url = "https://glucks2027.fr/meeting/"
    out = []
    for ev in jsonld_events(fetch(url)):
        date, time = paris_local(ev.get("startDate", ""))
        if not upcoming(date) or not ld_offline(ev):
            continue
        venue, street, city, _ = ld_place(ev)
        e = event("glucksmann", title=ev.get("name") or "Meeting de Raphaël Glucksmann", date=date, time=time, city=city or "",
                  venue=venue, address=street, url=ev.get("url") or url, source="glucks2027.fr", with_candidate=True,
                  speakers=["Raphaël Glucksmann"], access="inscription", status=ld_status(ev))
        if e: out.append(e)
    return out


# --------------------------------------------------------------------------- Kazib (API du site de campagne)

def parse_kazib() -> List[dict]:
    """anasse2027.fr/api/events (liste JSON) : lecture tolérante des champs usuels."""
    data = json.loads(fetch("https://anasse2027.fr/api/events") or "[]")
    if isinstance(data, dict):
        data = data.get("events") or data.get("data") or []
    out = []
    for it in data if isinstance(data, list) else []:
        g = lambda *ks: next((it.get(k) for k in ks if it.get(k)), None)
        start = g("startDate", "start", "date", "start_date", "datetime")
        if not start:
            continue
        date, time = paris_local(str(start))
        loc = g("location", "place", "lieu") or {}
        city = g("city", "ville") or (loc.get("city") if isinstance(loc, dict) else None)
        venue = loc.get("name") if isinstance(loc, dict) else (loc if isinstance(loc, str) else None)
        title = g("title", "name", "titre") or "Meeting d'Anasse Kazib"
        if not upcoming(date) or re.search(r"visio|en ligne|online", f"{title} {venue}", re.I):
            continue
        link = g("url", "link", "href") or "https://anasse2027.fr/evenements"
        e = event("kazib", title=title, date=date, time=time, city=city or "", venue=venue, url=urllib.parse.urljoin("https://anasse2027.fr", link),
                  source="anasse2027.fr", with_candidate="Kazib" in title or "Anasse" in title, speakers=["Anasse Kazib"] if "Kazib" in title else [])
        if e: out.append(e)
    return out


# --------------------------------------------------------------------------- WordPress « The Events Calendar »

def tribe(base: str, cid: str, candidate_name: str) -> Callable[[], List[dict]]:
    def run() -> List[dict]:
        url = f"{base}/wp-json/tribe/events/v1/events?per_page=50&start_date={today().isoformat()}"
        data = json.loads(fetch(url))
        out = []
        for ev in data.get("events", []):
            v = ev.get("venue") if isinstance(ev.get("venue"), dict) else {}
            title = htmllib.unescape(ev.get("title") or "")
            if not v.get("city") or re.search(r"visio|en ligne|webinaire", title, re.I):
                continue
            present = candidate_name.split()[-1] in title
            e = event(cid, title=title, date=(ev.get("start_date") or "")[:10], time=(ev.get("start_date") or "")[11:16] or None,
                      city=v.get("city"), venue=htmllib.unescape(v.get("venue") or "") or None, address=v.get("address"),
                      url=ev.get("url"), source=urllib.parse.urlparse(base).netloc, with_candidate=present,
                      speakers=[candidate_name] if present else [])
            if e and upcoming(e["date"]): out.append(e)
        return out
    return run


PARSERS: Dict[str, Callable[[], List[dict]]] = {
    "melenchon2027.fr": parse_melenchon,
    "lutte-ouvriere.org": parse_arthaud,
    "unenouvelleenergie.fr": parse_lisnard,
    "upr.fr": parse_asselineau,
    "action.edouardphilippe.fr": parse_philippe,
    # "action.debout.fr": parse_ruffin,  # Ruffin a renoncé le 21/11/2026
    "glucks2027.fr": parse_glucksmann,
    "anasse2027.fr": parse_kazib,
    "resistons-france.fr": tribe("https://resistons-france.fr", "lassalle", "Jean Lassalle"),
}
# Sources lues intégralement : un événement absent de leur agenda peut être signalé comme « à confirmer »
COMPLETE = {"melenchon2027.fr", "lutte-ouvriere.org", "unenouvelleenergie.fr", "anasse2027.fr", "resistons-france.fr"}


def run_all(only: Optional[Iterable[str]] = None):
    """Renvoie (événements, domaines lus intégralement et avec succès)."""
    events: List[dict] = []
    ok = set()
    for name, fn in PARSERS.items():
        if only and name not in only:
            continue
        try:
            evs = fn()
            print(f"-> {name} : {len(evs)} événements")
            events.extend(evs)
            if evs and name in COMPLETE:  # une page vide = probablement cassée : on ne déclasse rien
                ok.add(name)
        except Exception as e:  # un site cassé ne doit pas bloquer les autres
            print(f"  ! {name} : échec ({type(e).__name__}: {e})")
    return events, ok
