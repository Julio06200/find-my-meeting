# Find My Meeting

Trouvez les meetings et réunions publiques de la présidentielle 2027 près de chez vous, et faites le quiz pour savoir qui aller écouter.

## Contenu

```
site/                 le site statique (PC + mobile), aucun build nécessaire
  index.html, app.js, styles.css, assets/logo.png
  data/candidates.json   liste des candidats (à éditer à la main)
  data/quiz.json         questions du quiz + positions des candidats (-2 à +2)
  data/meetings.json     agenda (écrit par le scraper)
  data/bundle.js         tout ce qui précède en un fichier, chargé par le site
scraper/scrape.py     robot quotidien (Claude + recherche web + API Adresse)
scraper/seed_events.json  événements ajoutés à la main (exemple d'import)
.github/workflows/daily-scrape.yml  exécution tous les matins + mise en ligne
run_daily.bat         alternative : exécution locale (Planificateur de tâches Windows)
```

## Comment marche la mise à jour (gratuite)

1. **Robot GitHub, chaque jour à 6h (gratuit)** : `scrape.py` lit les agendas de campagne structurés avec les lecteurs de `scraper/parsers.py` (aujourd'hui : melenchon2027.fr). Pour ajouter un site, écrivez une fonction dans `parsers.py` et ajoutez-la à `PARSERS`.
2. **Tâche Claude, chaque jour à 7h30** (application Claude sur le PC, incluse dans l'abonnement) : Claude cherche sur le web les meetings de tous les candidats, les écrit dans `scraper/claude_events.json`, les importe, puis pousse sur GitHub. Ne tourne que si le PC est allumé et l'application ouverte.
3. **Option payante** : si un secret `ANTHROPIC_API_KEY` est ajouté au dépôt, le robot GitHub ajoute aussi une recherche web par l'API Claude (`--ai`).

Les lieux sont géocodés avec l'API Adresse de l'État (gratuite), qui fournit aussi le département et la région.

## Fiabilité des données

Chaque événement porte :
- `status` : `confirme` (date et lieu annoncés par un agenda officiel ou l'organisateur), `a_confirmer` (presse seule, horaire/lieu manquant, ou retiré d'un agenda officiel), `annule` ;
- `source_kind` (`officiel` / `organisateur` / `presse`), `url` (source affichée sur la fiche) et `verified_at` (dernière fois vu dans une source) ;
- `changes` : historique des modifications de date, horaire, commune ou lieu.

Doublons : même candidat + même page source, ou même candidat + même date + même commune. Une source de presse ne peut jamais écraser ni « confirmer » une information d'agenda officiel.

## Réglages avant lancement

Dans `site/index.html`, bloc `window.FMM_CONFIG` : `reportEmail` (adresse pour les signalements d'erreur ; sinon, signalement via une issue GitHub). Compléter aussi l'éditeur et le contact dans `site/confidentialite.html`.

## Mise en ligne (GitHub Pages, gratuit)

1. Créez un dépôt GitHub et poussez ce dossier sur la branche `main`.
2. (Optionnel, payant) Dans **Settings → Secrets and variables → Actions**, ajoutez `ANTHROPIC_API_KEY`.
3. Dans **Settings → Pages**, choisissez « Source : GitHub Actions ».
4. Dans **Actions → Scraping quotidien → Run workflow**, lancez un premier passage.

Le scraping tourne ensuite tous les jours à 6h (heure de Paris en hiver), committe les nouvelles données et republie le site.

## En local

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r scraper\requirements.txt
set ANTHROPIC_API_KEY=sk-ant-...
.venv\Scripts\python scraper\scrape.py --only melenchon   # un seul candidat pour tester
python -m http.server 8000 --directory site               # puis http://localhost:8000
```

Ajouter des événements à la main (sans IA) : complétez un fichier comme `scraper/seed_events.json`, puis lancez `python scraper/scrape.py --import mon_fichier.json`.

Après avoir modifié `candidates.json` ou `quiz.json`, lancez `python scraper/scrape.py --bundle-only`.

## Statistiques

Voir [docs/statistiques.md](docs/statistiques.md) : Umami (sans donnée politique) et compteurs agrégés par candidat (désactivés, checklist RGPD).
