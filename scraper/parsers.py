"""Lecteurs d'agenda gratuits (sans IA) pour les sites de campagne structurés.

Chaque lecteur renvoie une liste de dicts au format Event de scrape.py.
Pour ajouter un site : écrire une fonction parse_xxx() et l'ajouter à PARSERS.
"""

from __future__ import annotations

import html as htmllib
import re
import urllib.request
from typing import Callable, Dict, List

UA = "Mozilla/5.0 (compatible; FindMyMeeting/1.0)"
MONTHS = {m: i + 1 for i, m in enumerate(
    ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"])}
DATE_RE = re.compile(r"(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)?\s*(\d{1,2})(?:er)?\s+(" + "|".join(MONTHS) + r")\s+(\d{4})", re.I)


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


# --------------------------------------------------------------------------- LFI

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
                raw = re.sub(r"\s*[-–|]\s*Mélenchon 2027.*$", "", htmllib.unescape(raw)).strip()
                title = raw or title
            except Exception:
                pass
        addr_m = re.search(r'adresse_evt[^>]*>([^<]+)<', it)
        addr = htmllib.unescape(addr_m.group(1)).strip() if addr_m else ""
        # format "Salle X (Ville)"
        city_m = re.search(r"\(([^()]+)\)\s*$", addr)
        city = city_m.group(1).strip() if city_m else addr
        venue = addr[: city_m.start()].strip() if city_m else None
        if not city:
            continue
        if city.isupper():
            city = city.title()
        speakers = []
        sp_m = re.search(r"avec (.+)$", title, re.I)
        if sp_m:
            speakers = [s.strip() for s in re.split(r",| et ", sp_m.group(1)) if s.strip()]
        is_jlm = "/evenement/jlm/" in url or "Jean-Luc Mélenchon" in title
        out[url] = {
            "candidate_id": "melenchon",
            "title": title,
            "type": "meeting" if "meeting" in title.lower() else "reunion",
            "date": date,
            "time": f"{int(time_m.group(1)):02d}:{time_m.group(2)}" if time_m else None,
            "city": city,
            "venue": venue,
            "address": None,
            "speakers": speakers or (["Jean-Luc Mélenchon"] if is_jlm else []),
            "with_candidate": is_jlm,
            "access": "public",
            "url": url,
            "source": "melenchon2027.fr",
            "source_kind": "officiel",
            "status": "annule" if re.search(r"\bannul", title, re.I) else "confirme",
        }
    return list(out.values())


PARSERS: Dict[str, Callable[[], List[dict]]] = {
    "melenchon2027.fr": parse_melenchon,
}


def run_all():
    """Renvoie (événements, domaines lus avec succès)."""
    events: List[dict] = []
    ok = set()
    for name, fn in PARSERS.items():
        try:
            evs = fn()
            print(f"-> {name} : {len(evs)} événements")
            events.extend(evs)
            if evs:  # une page vide = probablement cassée : on ne déclasse rien
                ok.add(name)
        except Exception as e:  # un site cassé ne doit pas bloquer les autres
            print(f"  ! {name} : échec ({e})")
    return events, ok
