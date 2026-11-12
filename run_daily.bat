@echo off
REM Lance le scraper en local (alternative a GitHub Actions). Necessite ANTHROPIC_API_KEY.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  python -m venv .venv
  .venv\Scripts\python.exe -m pip install -q -r scraper\requirements.txt
)
.venv\Scripts\python.exe scraper\scrape.py >> scraper\last_run.log 2>&1
