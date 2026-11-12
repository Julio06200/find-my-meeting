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

## Comment marche le scraping

Pour chaque candidat, `scrape.py` demande à Claude (`claude-opus-5-5`, avec les outils web search et web fetch) de trouver les meetings à venir sur les 60 prochains jours, à partir de l'agenda de campagne s'il est connu (`agenda` dans `candidates.json`), de la presse et des sites des partis. Chaque événement doit avoir une URL source. Les lieux sont ensuite géocodés avec l'API Adresse de l'État (gratuite), qui fournit aussi le département et la région. Enfin, les événements sont fusionnés avec l'existant et les dates passées sont retirées.

Le modèle se change avec la variable `FMM_MODEL` (par ex. `claude-sonnet-5-5` pour réduire le coût).

## Mise en ligne (GitHub Pages, gratuit)

1. Créez un dépôt GitHub et poussez ce dossier sur la branche `main`.
2. Dans **Settings → Secrets and variables → Actions**, ajoutez `ANTHROPIC_API_KEY`.
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
