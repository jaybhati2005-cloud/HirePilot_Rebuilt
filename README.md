# HirePilot AI — rebuilt

HirePilot AI is a Python/FastAPI backend with a plain HTML, CSS, and JavaScript frontend. The project keeps the existing core workflows while adding a real-time voice interview foundation.

## Product workflows

- **Interview coach:** one setup flow supports text practice and a full-duplex Live Interview. The live room uses a LiveKit WebRTC audio pipeline with Deepgram streaming speech recognition and speech synthesis, Groq interviewer reasoning, locally measured audio delivery metrics, and local camera analysis.
- **Resume humanizer:** rewrites resume wording without inventing achievements, metrics, skills, dates, or employers.
- **Resume match:** compares a PDF resume with a job description.
- **Career paths:** suggests realistic entry-level roles based on resume evidence.

The old separate Voice Interview and Virtual Interview sections remain consolidated into Interview Coach.

## Run locally

### Windows

1. Extract the project.
2. Open the folder in a terminal and run `run.bat`.
3. Copy `.env.example` to `.env` if it was not created automatically.
4. Configure `GROQ_API_KEY`, `DEEPGRAM_API_KEY`, and your LiveKit Cloud URL/key/secret in `.env`.
5. Restart the backend after changing `.env`.
6. Visit `http://127.0.0.1:8000` using Chrome or Edge.

### macOS / Linux

```bash
chmod +x run.sh
./run.sh
```

Then configure `.env` and restart the server. Manual setup:

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

## Environment configuration

```env
# Text generation: question generation, written answers, reports, resume tools
GROQ_API_KEY=
GEMINI_API_KEY=
AI_PROVIDER_ORDER=groq,gemini
GROQ_MODEL=openai/gpt-oss-20b
GEMINI_MODEL=gemini-2.5-flash
AI_REQUEST_TIMEOUT=40
AI_RETRIES=1
AI_CONCURRENCY=6

# Live voice: LiveKit WebRTC + Deepgram Flux/Aura-2 + Groq
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
DEEPGRAM_API_KEY=
DEEPGRAM_STT_MODEL=flux-general-en
DEEPGRAM_TTS_MODEL=aura-2-asteria-en
GROQ_VOICE_MODEL=openai/gpt-oss-20b

# Comma-separated frontend origins. Keep * for local development only.
CORS_ORIGINS=*
```

LiveKit API credentials and all Deepgram/Groq provider keys stay on the backend. HirePilot mints a short-lived, room-scoped LiveKit access token for the browser. Never place a provider key or LiveKit API secret in frontend JavaScript or commit `.env`.

### Live voice setup

Live voice now runs through a separate LiveKit Agent process. `run.bat` starts the API and the agent in two terminal windows. Configure all five required values in `.env`: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `DEEPGRAM_API_KEY`, and `GROQ_API_KEY`. The browser receives only a short-lived LiveKit room token; provider API keys remain on the server.

For local development, create a LiveKit Cloud project and copy its WebSocket URL, API key and secret. Create Deepgram and Groq API keys separately. The free quotas and rate limits of external providers can change; this design is not guaranteed to be permanently free.

## Live Interview architecture

### Real-time voice

- Browser microphone audio is published over LiveKit WebRTC to the HirePilot voice agent.
- Deepgram Flux performs streaming English transcription and turn detection; Deepgram Aura-2 streams spoken responses.
- Groq generates the interviewer's spoken responses. LiveKit carries audio and synchronized transcript events to the browser.
- Server-side voice activity detection handles speech boundaries; interruption is enabled.
- The candidate can repeat or clarify the current question. The app controls progression through its generated question list.
- The app does not use browser `SpeechRecognition` or `SpeechSynthesisUtterance` for the live voice path.

### Audio analysis

Audio metrics are calculated in the browser using the Web Audio API; raw audio is not uploaded to HirePilot's Python analysis endpoint. Metrics include:

- Speaking pace, calculated from transcript word count and answer duration.
- Filler words from the recognised transcript (`um`, `uh`, `erm`, `hmm`, `you know`).
- Pauses and longest pause, based on local voice activity measurements.
- Approximate pitch range variation and relative intensity variation, when the microphone signal supports measurement.

These are approximate coaching indicators. Pitch and loudness are not emotion or confidence detectors. Metrics are marked unavailable when the signal is insufficient.

### Visual analysis

Camera analysis runs entirely in the browser with MediaPipe Tasks Vision (face, pose and hand landmarkers). A fresh measurement window starts for every answer, once the interviewer has finished asking the question.

Signals measured per answer:

- **Face and framing:** face visible ratio, centring, camera distance (too close / too far).
- **Head pose:** yaw, pitch and tilt from the face transformation matrix; facing-the-camera ratio.
- **Gaze:** how often the eyes point toward the screen (from eye-direction blendshapes plus head pose).
- **Blink rate** and **head steadiness** (nose movement relative to face width).
- **Posture:** shoulder tilt, head height relative to the shoulders, and lateral lean. Only the shoulders must be visible, so a normal laptop webcam works.
- **Hands:** visibility and gesture activity.
- **Lighting:** brightness, left/right balance and face-versus-background exposure.
- **Observable facial movement** (mouth, smile-related, brow), described only; never mapped to emotion.

Each answer gets a checklist (good / adjust / info / unavailable) plus plain-language observations, and the final report aggregates every signal across all answers. The same measurements are never used to infer personality, honesty, intelligence, confidence or hiring suitability. Camera frames are not sent to any server.

The status line under the live metrics says what the vision stack is doing (loading, running, no face detected, or an error with the reason). Models load in the background so a slow download never delays the voice interview. If the GPU delegate fails while running, the analyzer switches to the CPU automatically.

**Blocked CDNs:** the API server downloads the library and models itself (from the npm registry and Google storage) into `frontend/vendor/mediapipe/` at startup and in `run.bat`/`run.sh`, and the browser loads them from your own server first, so a blocked jsDelivr/unpkg no longer matters. You can also run the download manually:

```bash
python scripts/download_vision_assets.py
```

The files are saved to `frontend/vendor/mediapipe/` and the browser prefers them over the CDN. If the vision stack cannot load at all, the interview keeps working and the report states why visual data is missing.


**Manual install (no internet on the server, or downloads keep failing):** on any computer that can open these links, download the files and copy them into `frontend/vendor/mediapipe/` (create the folders if needed), then restart. No unzipping is needed for the first file.

1. Library (copy the `.tgz` as-is; the app unpacks it): `https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.21.tgz` (any 0.10.x version works). If you have Node, `npm pack @mediapipe/tasks-vision` produces the same kind of file.
2. Face model, saved as `face_landmarker.task`: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`
3. Optional, saved as `pose_landmarker_lite.task`: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`
4. Optional, saved as `hand_landmarker.task`: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`

`python scripts/download_vision_assets.py` prints the exact reason each download failed (for example a TLS certificate problem caused by antivirus HTTPS scanning, or a blocked domain). `http://127.0.0.1:8000/api/health` shows the same under `vision_assets`.

**Basic mode:** if the models still cannot load, the live room automatically runs basic camera checks that need no downloads (lighting and movement in frame) and says clearly that face, gaze, posture and hand analysis are unavailable. Click the status line to retry the full analysis at any time.

### Privacy

- HirePilot does not save raw microphone or camera recordings.
- Browser-local audio/video analysis runs only during the active interview session.
- Audio is transmitted to LiveKit and Deepgram for the live voice pipeline. Transcript text, the current question and optional resume context are submitted to Groq for interviewer responses and to the configured text-generation provider for answer evaluation. Review both providers' data retention and processing terms before production use; HirePilot cannot guarantee external provider retention practices.
- HirePilot does not persist the transcript, audio metrics, visual metrics or final report. They remain in the current browser session and are cleared when the session is reset or the page is closed.
- End Interview closes the WebRTC session, stops microphone/camera tracks, stops local analysis, and clears temporary media state.

## API routes

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | API, text provider and real-time voice readiness |
| POST | `/api/resume/extract` | Extract text from a PDF resume |
| POST | `/api/interview/questions` | Generate interview questions |
| POST | `/api/interview/evaluate` | Evaluate one written answer |
| POST | `/api/realtime/session` | Create a short-lived LiveKit room access token |
| POST | `/api/interview/live/evaluate` | Evaluate transcript plus submitted local metrics |
| POST | `/api/interview/report` | Aggregate answer, audio and visual metrics |
| POST | `/api/resume/humanize` | Improve resume wording |
| POST | `/api/job/analyze` | Resume-to-job match |
| POST | `/api/job/roles` | Evidence-based role suggestions |

Interactive API docs: `http://127.0.0.1:8000/docs`

## Testing

```bash
python -m pytest -q
node --check frontend/app.js
python -m backend.realtime.agent dev
node --check frontend/live-analysis.js
```

The automated tests cover backend routes, report aggregation, LiveKit configuration validation, and input validation. They do not replace a real browser/provider test. To verify actual speech, transcription, interruptions, latency, camera inference and cost, configure valid API keys and run a complete interview in Chrome/Edge.

## Current limitations and production work

- Live voice needs valid LiveKit, Deepgram and Groq credentials and an available quota at each provider. Provider free tiers and rate limits can change.
- Local visual inference downloads its JavaScript package and model files from public CDNs. For offline/locked-down deployments, vendor and pin those assets locally after reviewing their licenses.
- The in-memory application has no authentication or persistent database. Before public deployment, add user authentication, session ownership, robust rate limiting on `/api/realtime/session`, HTTPS, restrictive CORS, spend limits and production logging controls.
- The browser's local visual metrics are approximate and depend on camera quality, lighting, device performance and model availability.
- No live provider call was possible during the automated build tests because no user API key is present in the project. Provider connectivity and real-world latency remain to be verified with the user's own credentials.

## Start the LiveKit voice agent separately

On Windows, `run.bat` starts the API and agent in separate terminals. If you start the API manually, open a second terminal in the project root and run:

```bash
python -m backend.realtime.agent dev
```

The voice pipeline uses Deepgram Flux (`flux-general-en`) for English STT, Groq (`openai/gpt-oss-20b` by default) for interviewer reasoning, and Deepgram Aura-2 (`aura-2-asteria-en`) for TTS. The 6 GB NVIDIA GPU is not used by this cloud pipeline; browser-local camera analysis remains independent.
