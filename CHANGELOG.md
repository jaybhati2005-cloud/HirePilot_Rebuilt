# HirePilot 4.1 — LiveKit / Deepgram live interview migration

## Implemented in this build

- Replaced the OpenAI Realtime browser SDP flow with LiveKit WebRTC room sessions.
- Added a server-side LiveKit token endpoint with room-scoped permissions, participant metadata and a 10-minute token lifetime.
- Added a separate LiveKit Agents worker (`backend/realtime/agent.py`).
- Added Deepgram Flux English streaming STT and turn detection, Deepgram Aura-2 English TTS, Groq GPT-OSS 20B interviewer LLM, and Silero VAD for interruption handling.
- Passed role, difficulty, interview type, question list and a bounded resume context to the agent as participant metadata.
- Added reliable room data messages for ask / repeat / clarify commands and question progression.
- Reused the browser microphone track for both local audio metrics and LiveKit publishing; answer analysis pauses the same track.
- Preserved FastAPI resume parsing, question generation, answer scoring, report aggregation and local MediaPipe camera analysis.
- Updated `.env.example`, dependencies, Windows/Linux launch scripts and setup documentation.
- Removed the unused OpenAI Realtime adapter.

## Verification performed

- Backend automated tests: 10 passed.
- Python compile checks: passed.
- JavaScript syntax check: passed.

## Not verified in this environment

- A real LiveKit room connection, Deepgram transcription/TTS, Groq response generation, browser audio playback, interruption quality and end-to-end latency. These require the user's own provider credentials and a live browser test.
- The project does not promise zero cost: provider free tiers, credits and rate limits can change.

## Remaining production work

- Add user authentication and session ownership.
- Replace the in-process session throttle with shared rate limiting.
- Add persistent session/transcript storage only if the product requires it and after updating privacy disclosures.
- Pin and self-host frontend SDK/model assets for deployments that cannot rely on public CDNs.

## Live interview hotfix — 2026-11-21

- Fixed LiveKit `data_received` handling to use the SDK callback's raw-bytes signature, so the browser's initial `ask` and repeat/clarify commands are actually decoded and processed.
- Forwarded Deepgram candidate transcripts from the LiveKit AgentSession `user_input_transcribed` event to the browser over a dedicated reliable data message.
- Removed reliance on the deprecated browser `TranscriptionReceived` event and its incorrect participant-identity filter, which could discard candidate transcripts.
- Added agent startup and transcript-forwarding diagnostics to the agent terminal.

## Live interview flow fix — 2026-11-21 (v2)

Problems fixed:
- The first question was never spoken. Cause: the previous hotfix made `data_received` expect raw bytes, but LiveKit passes an `rtc.DataPacket`, so every browser command (ask / repeat / next question) was silently dropped. The handler now accepts both forms.
- The LLM was replying on its own after every answer ("whenever you're ready I'll ask a new question") and asking questions the UI didn't know about, so the Question tab went stale. The agent now never replies on its own (`StopResponse` in `on_user_turn_completed`); it only speaks what the app tells it to.

Changes:
- The agent opens the interview itself and speaks each question verbatim through Aura TTS ("Question 3. ..."), then confirms the question index back to the browser (`hirepilot.question`) so the Question tab always matches what was spoken.
- Every new question clears the transcript box and resets the delivery metrics.
- After an answer is evaluated, the agent speaks a short feedback summary (score, one strength, one improvement) built from the real evaluation.
- New "Hands-free" toggle (on by default): the answer is submitted after ~3.5 s of quiet, feedback is spoken, then the next question is asked automatically. Untick it to use the buttons manually.
- The final report is produced after the last question of the chosen set (4, 6, 8, 10 or 12). The last-question button reads "View final report", and the room is only closed once the report has loaded (it no longer leaves a blank screen if the report call fails).
- Candidate transcripts are ignored while the interviewer is speaking (echo) and after an answer has been submitted (late text can no longer leak into the next question).
- Agent now publishes `hirepilot.agent_state` (listening / thinking / speaking) for the UI.
- Fixed: Finish button re-enabling itself after analysis; stray literal `\n` rendered in the page.

Not verified here: live LiveKit/Deepgram/Groq audio (needs your keys and a browser test).

## v3 — fresh questions + side-by-side live room — 2026-11-21

- **New questions every session.** Question generation ran at temperature 0.2, so the same role produced near-identical sets. It now uses temperature 0.95, a random variation id, four random focus angles per set, and an `avoid_questions` list. The browser remembers the last 40 questions per role (localStorage) and sends them; the server tells the model not to repeat or reword them and regenerates once if an exact repeat still comes back.
- **Live room layout.** The answer report (score, coaching, delivery review) and the live delivery metrics now sit in a sticky right-hand column next to the camera, question and transcript, so nothing requires scrolling. The sidebar tips are hidden during a live interview to give the room full width. On screens under 1000px the column stacks below.
- `generate_structured` accepts an optional `temperature` (default unchanged at 0.2 for evaluation, resume and job tools).
- Added a test for the repeat-avoidance retry.

Not verified here: pytest and the live audio stack are not installed in the build sandbox; files were syntax-checked only (Python compile + `node --check`). Run `pytest` locally.

## v4 — difficulty enforcement + rename to HirePilot AI — 2026-11-21

- **Difficulty now respected.** The v3 randomness boost (temperature 0.95, "avoid the obvious textbook question", a single generic progression line) pushed Beginner sets towards hard questions. The prompt now carries a strict per-level rubric (Beginner / Medium / Advanced) with explicit forbidden topics for Beginner (system design, optimisation, internals, tricky edge cases, multi-step coding), focus angles that are chosen per difficulty, "never exceed the selected level, even on the last question", and lower temperature (0.6 Beginner, 0.8 otherwise). Variety still comes from the variation id, per-level angles and the avoid-list.
- **Renamed CareerPilot → HirePilot AI** in the UI (brand mark, title, live-room label), backend, agent logger, README, scripts, tests and the project folder (`HirePilot_Rebuilt`). Internal data-message types are now `hirepilot.*` on both the agent and the browser, so they stay in sync. The remembered-question store key changed, so previously remembered questions are not carried over.
- Added a test that the Beginner rubric reaches the model prompt.

## v5 — complete visual analysis rewrite — 2026-11-21

Why visual analysis was not working:
- Posture required both **hips** to be visible, which a laptop webcam never shows, so posture was almost always "unavailable".
- Every per-frame error was swallowed silently. A model that loaded but failed on each frame (typical of the GPU delegate on some machines) produced zero samples and no explanation.
- No runtime GPU→CPU fallback, a single CDN with no offline option, and a stale-cache risk for the module file.
- Model download **blocked** the voice interview from starting.
- Visual statistics were cumulative across the whole session instead of per answer.
- Only a handful of signals were measured.

What changed:
- `live-analysis.js` rewritten. New signals: camera distance, head yaw/pitch/tilt, gaze toward screen, blink rate, head steadiness, shoulder-based posture (shoulders only), hand visibility and gesture activity, lighting balance and face-vs-background exposure. Each answer gets a good/adjust checklist and plain-language observations.
- Loads from `/static/vendor/mediapipe/` first (new `scripts/download_vision_assets.py`), then jsDelivr, then unpkg. Automatic GPU→CPU rebuild on runtime failure.
- Live status line explains loading / running / no face / error; extra live tiles for gaze, head movement, lighting and hands.
- Models load in the background. One permission prompt now covers mic and camera.
- Measurement window resets per answer (after the question has been spoken).
- Final report aggregates all visual signals (`summarise_visual_metrics`) and shows per-answer audio + visual detail, with a clear reason when data is missing.
- Audio: speaking pace is measured to the end of speech (no longer lowered by the auto-submit wait); added hedge-phrase counts and answer length.
- End Interview now offers a report for the questions already answered instead of discarding them.
- Static files: `.mjs`/`.wasm` MIME types registered; `app.js`/`styles.css` cache-busted (`?v=5`) so browsers don't keep the old broken modules.
- Tests: `node tests/visual-summary.test.mjs` (summary logic) and two new API tests for the aggregator.

Not verified in the build sandbox: real MediaPipe inference, camera and live audio (no browser, webcam, network or API keys here). Please do one live run and look at the status line under the metrics.

## v6 — vision assets no longer depend on browser CDN access — 2026-11-21

Reported: "Failed to fetch dynamically imported module: https://unpkg.com/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs". That message came from the last of three sources the browser tried (local, jsDelivr, unpkg), so all of them were unreachable from the browser (blocked CDN, ad-blocker, ISP or firewall).

- New `backend/vision_assets.py`: the **server** downloads the MediaPipe library (npm registry, npmmirror, then jsDelivr/unpkg per file) and the three models (Google storage) into `frontend/vendor/mediapipe/`. It runs in the background at API startup when files are missing, and is exposed in `/api/health` as `vision_assets`.
- The browser loads from `/static/vendor/mediapipe/` first, so it only needs to reach your own server.
- `run.bat` / `run.sh` run `scripts/download_vision_assets.py` before starting (failure is non-fatal).
- The status line now lists why **each** source failed (e.g. `cdn.jsdelivr.net: blocked or unreachable · unpkg.com: blocked or unreachable`), says whether the server is still downloading, and is **click to retry** without leaving the interview.
- Tarball extraction rejects any path outside the target folder. Tests: `tests/test_vision_assets.py`.
- Cache-bust bumped to `?v=6`.

Limit: if the machine running the API server also cannot reach npm and `storage.googleapis.com`, nothing can be downloaded. The status line and `/api/health` will say which files are missing; use another network or VPN once and the files stay on disk.

## v7 — robust asset download, offline install, basic-mode fallback — 2026-11-21

Reported: browser and server both failed to obtain the MediaPipe files (local not downloaded; jsDelivr and unpkg unreachable).

- Downloader now uses `httpx` (own CA bundle, honours proxy settings), tries npm, Yarn, npmmirror, Tencent and Huawei registries plus four CDN hosts, and records a readable reason per failure (including a hint for TLS-inspection/antivirus certificate problems). Errors appear in the server log, `/api/health` (`vision_assets.errors`), the script output and the live-room status line.
- Offline drop-in: place `tasks-vision-0.10.22.tgz` and the `.task` model files in `frontend/vendor/mediapipe/` and the app unpacks them at startup. README has the exact links.
- Basic mode: when models cannot load, the live room still measures lighting and movement in frame with no downloads, labels face/gaze/posture/hands as unavailable, and carries this into the final report. Click the status line to retry full analysis.
- Tests added for the offline drop-in and basic summary. Cache-bust `?v=7`.

Still unverified here: actual downloads from your network and real camera inference.

## v8 — downloader no longer assumes file names or one version — 2026-11-21

Reported: the server downloaded the three models but every library file was missing, with `unpkg.com/.../wasm/vision_wasm_nosimd_internal.wasm: 404`. The network was fine (a real 404 came back); the hard-coded file list / version did not match what is published.

- Library download now keeps **every** file under `wasm/` plus `vision_bundle.mjs` from the npm tarball instead of a fixed list, tries versions 0.10.22 → 0.10.14 in order, and records which one worked (`version.txt`, shown in `/api/health`).
- If tarballs fail, file names are **discovered** from unpkg (`?meta`) or jsDelivr's listing API; a guessed list is the last resort.
- Unreachable hosts are skipped after the first failure so a blocked network does not stall startup.
- Readiness is judged by what exists (bundle + any wasm/js + face model), not by specific names.
- The browser now probes a failed import: `HTTP 404 (file not found there)` is no longer mislabelled "blocked or unreachable". Server errors are shown in full in the status line.
- Tests simulate your exact case against a fake network (6 passing in a mini-runner here; run `pytest` locally).
