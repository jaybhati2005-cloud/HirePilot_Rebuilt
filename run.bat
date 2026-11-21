@echo off
cd /d "%~dp0"
if not exist .venv (
  py -m venv .venv
)
call .venv\Scripts\activate
python -m pip install -r requirements.txt
if not exist .env copy .env.example .env
rem Fetch camera-analysis assets once so the browser never depends on a CDN (safe to fail).
python scripts\download_vision_assets.py
start "HirePilot Live Voice Agent" cmd /k "call .venv\Scripts\activate && python -m backend.realtime.agent dev"
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
