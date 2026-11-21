from __future__ import annotations

import asyncio
import json
import os
import random
import re
import time
from functools import lru_cache
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any, Literal

import fitz
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError

try:
    from . import vision_assets
except ImportError:  # executed as a plain script
    import vision_assets  # type: ignore[no-redef]


PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = PROJECT_ROOT / ".env"
load_dotenv(dotenv_path=ENV_FILE, override=False)

APP_NAME = "HirePilot"
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
AI_PROVIDER_ORDER = [
    p.strip().lower()
    for p in os.getenv("AI_PROVIDER_ORDER", "groq,gemini").split(",")
    if p.strip().lower() in {"groq", "gemini"}
]
AI_TIMEOUT = max(12, min(90, int(os.getenv("AI_REQUEST_TIMEOUT", "40"))))
AI_RETRIES = max(0, min(2, int(os.getenv("AI_RETRIES", "1"))))
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_RESUME_CHARS = 24000
AI_CONCURRENCY = max(1, min(20, int(os.getenv("AI_CONCURRENCY", "6"))))

http_client: httpx.AsyncClient | None = None
ai_semaphore = asyncio.Semaphore(AI_CONCURRENCY)
realtime_session_attempts: dict[str, list[float]] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    timeout = httpx.Timeout(AI_TIMEOUT, connect=8.0, read=AI_TIMEOUT, write=20.0, pool=8.0)
    limits = httpx.Limits(max_connections=30, max_keepalive_connections=15, keepalive_expiry=30)
    http_client = httpx.AsyncClient(
        base_url="https://api.groq.com/openai/v1/",
        timeout=timeout,
        limits=limits,
        headers={"User-Agent": "HirePilot/4.0"},
    )
    # Fetch vision assets in the background so the browser can load them from this server
    # even when CDNs are blocked on the user's network.
    if vision_assets.missing_files():
        asyncio.create_task(asyncio.to_thread(vision_assets.ensure_assets))
    yield
    await http_client.aclose()
    http_client = None


FRONTEND_DIR = PROJECT_ROOT / "frontend"

app = FastAPI(
    title="HirePilot API",
    version="4.1.0",
    description="Resume-aware interview practice and career tools.",
    lifespan=lifespan,
)

allowed_origins = [
    item.strip()
    for item in os.getenv("CORS_ORIGINS", "*").split(",")
    if item.strip()
]
# Browsers refuse ES modules / WASM served with the wrong MIME type.
import mimetypes
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/wasm", ".wasm")
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins or ["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


# ----------------------------- Response schemas -----------------------------

class InterviewQuestion(BaseModel):
    question: str
    category: str
    purpose: str


class InterviewPlan(BaseModel):
    role: str
    questions: list[InterviewQuestion]


class InterviewEvaluation(BaseModel):
    relevance: int = Field(ge=0, le=10)
    technical_correctness: int = Field(ge=0, le=10)
    completeness: int = Field(ge=0, le=10)
    structure: int = Field(ge=0, le=10)
    clarity: int = Field(ge=0, le=10)
    overall_score: int = Field(ge=0, le=100)
    strengths: list[str]
    improvements: list[str]
    better_answer_direction: str


class HumanizedBullet(BaseModel):
    original: str
    improved: str
    reason: str


class ResumeHumanization(BaseModel):
    professional_summary: str
    headline: str
    rewritten_bullets: list[HumanizedBullet]
    skills_to_surface: list[str]
    cautions: list[str]


class JobAnalysis(BaseModel):
    job_role: str
    match_score: int = Field(ge=0, le=100)
    candidate_summary: str
    strong_matches: list[str]
    partial_matches: list[str]
    missing_skills: list[str]
    recommendations: list[str]


class RoleSuggestion(BaseModel):
    role: str
    fit_score: int = Field(ge=0, le=100)
    why: str
    skills_to_improve: list[str]


class RoleRecommendations(BaseModel):
    roles: list[RoleSuggestion]


# --------------------------------- Requests ----------------------------------

class InterviewSetup(BaseModel):
    role: str = Field(min_length=2, max_length=120)
    interview_type: str = Field(default="Technical + HR", max_length=60)
    difficulty: Literal["Beginner", "Medium", "Advanced"] = "Medium"
    question_count: int = Field(default=8, ge=4, le=12)
    resume_text: str = Field(default="", max_length=MAX_RESUME_CHARS)
    job_description: str = Field(default="", max_length=12000)
    # Questions shown in earlier sessions; the model is told not to repeat them.
    avoid_questions: list[str] = Field(default_factory=list, max_length=60)


class EvaluateAnswer(BaseModel):
    role: str = Field(min_length=2, max_length=120)
    question: str = Field(min_length=5, max_length=1500)
    answer: str = Field(min_length=8, max_length=10000)
    resume_text: str = Field(default="", max_length=MAX_RESUME_CHARS)


class ReportRequest(BaseModel):
    role: str = Field(min_length=2, max_length=120)
    evaluations: list[InterviewEvaluation] = Field(min_length=1, max_length=12)
    audio_metrics: list[dict[str, Any]] = Field(default_factory=list, max_length=12)
    visual_metrics: list[dict[str, Any]] = Field(default_factory=list, max_length=12)


class LiveInterviewRequest(BaseModel):
    role: str = Field(min_length=2, max_length=120)
    question: str = Field(min_length=5, max_length=1500)
    answer: str = Field(min_length=8, max_length=10000)
    resume_text: str = Field(default="", max_length=MAX_RESUME_CHARS)
    audio_metrics: dict[str, Any] = Field(default_factory=dict)
    visual_metrics: dict[str, Any] = Field(default_factory=dict)


class RealtimeSessionRequest(BaseModel):
    role: str = Field(min_length=2, max_length=120)
    difficulty: Literal["Beginner", "Medium", "Advanced"] = "Medium"
    interview_type: str = Field(default="Technical + HR", max_length=60)
    questions: list[InterviewQuestion] = Field(min_length=1, max_length=12)
    current_question_index: int = Field(default=0, ge=0, le=11)
    resume_text: str = Field(default="", max_length=MAX_RESUME_CHARS)




# ------------------------------ PDF utilities --------------------------------

def extract_pdf_text(data: bytes) -> str:
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Resume is larger than 10 MB.")
    if not data.startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="This file is not a valid PDF.")
    try:
        with fitz.open(stream=data, filetype="pdf") as document:
            text = "\n".join(page.get_text("text") for page in document[:30])
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read this PDF. Try exporting it again.")
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) < 40:
        raise HTTPException(
            status_code=422,
            detail="This PDF has little or no selectable text. Upload a text-based PDF rather than a scanned image.",
        )
    return text[:MAX_RESUME_CHARS]


async def read_resume(upload: UploadFile) -> str:
    filename = (upload.filename or "").lower()
    if not filename.endswith(".pdf"):
        raise HTTPException(status_code=415, detail="Upload your resume as a PDF.")
    data = await upload.read(MAX_UPLOAD_BYTES + 1)
    return await asyncio.to_thread(extract_pdf_text, data)


# ------------------------------- AI provider ---------------------------------

def _provider_configured(provider: str) -> bool:
    return bool(GROQ_API_KEY) if provider == "groq" else bool(GEMINI_API_KEY)


def _provider_list() -> list[str]:
    return [p for p in AI_PROVIDER_ORDER if _provider_configured(p)]


def _retryable_status(status: int) -> bool:
    return status in {408, 425, 429, 500, 502, 503, 504}


def _safe_provider_error(provider: str, exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status == 401:
            return f"{provider} rejected its API key (401). Check the key in .env."
        if status == 404:
            return f"{provider} could not find the configured model (404). Check the model ID in .env."
        if status == 400:
            try:
                detail = exc.response.json().get("error", {}).get("message", "")
            except Exception:
                detail = ""
            return f"{provider} rejected the request (400)." + (f" {detail[:220]}" if detail else "")
        return f"{provider} returned HTTP {status}."
    status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    if status == 404:
        return f"{provider} could not find the configured model (404). Check the model ID in .env."
    if status == 401 or status == 403:
        return f"{provider} rejected its API key or permissions ({status}). Check the key in .env."
    if status == 429 or (isinstance(status, int) and status >= 500):
        return f"{provider} is rate-limited or temporarily unavailable (HTTP {status})."
    if isinstance(exc, (httpx.TimeoutException, TimeoutError)):
        return f"{provider} timed out."
    if isinstance(exc, httpx.RequestError):
        return f"{provider} network connection failed."
    if isinstance(exc, (json.JSONDecodeError, ValidationError, KeyError, IndexError)):
        return f"{provider} returned an invalid response format."
    return f"{provider} request failed: {str(exc)[:180]}"


async def _groq_generate(prompt: str, schema: type[BaseModel], temperature: float = 0.2) -> dict[str, Any]:
    if not GROQ_API_KEY or http_client is None:
        raise RuntimeError("Groq is not configured.")
    body = {
        "model": GROQ_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are HirePilot, a precise career coach. Return one valid JSON object only. "
                    "Follow the requested schema. Never invent candidate experience, employers, metrics, "
                    "certifications, projects, or skills."
                ),
            },
            {"role": "user", "content": prompt + "\n\nRequired JSON schema:\n" + json.dumps(schema.model_json_schema())},
        ],
        "response_format": {"type": "json_object"},
        "temperature": temperature,
    }
    last_error: Exception | None = None
    for attempt in range(AI_RETRIES + 1):
        try:
            response = await http_client.post(
                "chat/completions",
                headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
                json=body,
            )
            response.raise_for_status()
            payload = response.json()
            content = payload["choices"][0]["message"]["content"]
            parsed = json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.I))
            return schema.model_validate(parsed).model_dump()
        except httpx.HTTPStatusError as exc:
            last_error = exc
            if attempt >= AI_RETRIES or not _retryable_status(exc.response.status_code):
                raise
            retry_after = exc.response.headers.get("retry-after")
            try:
                delay = min(3.0, max(0.25, float(retry_after)))
            except (TypeError, ValueError):
                delay = 0.35 * (2 ** attempt) + random.uniform(0.05, 0.2)
            await asyncio.sleep(delay)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            last_error = exc
            if attempt >= AI_RETRIES:
                raise
            await asyncio.sleep(0.35 * (2 ** attempt) + random.uniform(0.05, 0.2))
        except (json.JSONDecodeError, ValidationError, KeyError, IndexError):
            # A malformed model response is not a transient network failure. Do not burn retries.
            raise
    raise last_error or RuntimeError("Groq request failed.")


@lru_cache(maxsize=1)
def _get_gemini_client():
    from google import genai
    return genai.Client(api_key=GEMINI_API_KEY, http_options={"timeout": AI_TIMEOUT * 1000})


def _gemini_generate_sync(prompt: str, schema: type[BaseModel], temperature: float = 0.2) -> dict[str, Any]:
    if not GEMINI_API_KEY:
        raise RuntimeError("Gemini is not configured.")
    try:
        client = _get_gemini_client()
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config={
                "response_mime_type": "application/json",
                "response_schema": schema,
                "temperature": temperature,
            },
        )
        raw = (response.text or "").strip()
        parsed = json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.I))
        return schema.model_validate(parsed).model_dump()
    except Exception:
        raise




async def generate_structured(prompt: str, schema: type[BaseModel], temperature: float = 0.2) -> dict[str, Any]:
    providers = _provider_list()
    if not providers:
        raise HTTPException(
            status_code=503,
            detail="No AI provider is configured. Add GROQ_API_KEY or GEMINI_API_KEY to your .env file.",
        )

    failures: list[str] = []
    async with ai_semaphore:
        for provider in providers:
            try:
                if provider == "groq":
                    return await _groq_generate(prompt, schema, temperature)
                return await asyncio.to_thread(_gemini_generate_sync, prompt, schema, temperature)
            except asyncio.TimeoutError as exc:
                failures.append(_safe_provider_error(provider, TimeoutError("timeout")))
            except Exception as exc:
                failures.append(_safe_provider_error(provider, exc))

    # Do not leak provider response bodies, credentials, or stack traces to the browser.
    retryable = any(
        any(token in item.lower() for token in ("timed out", "network", "http 429", "http 5", "temporarily"))
        for item in failures
    )
    detail = "AI providers are temporarily unavailable. Please try again." if retryable else "AI request failed. Check provider keys and model settings."
    raise HTTPException(
        status_code=503 if retryable else 502,
        detail=detail + " " + " ".join(failures),
        headers={"Retry-After": "3"} if retryable else None,
    )


# --------------------------------- Endpoints ----------------------------------

@app.get("/")
async def root():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/api/health")
async def health():
    providers = _provider_list()
    return {
        "ok": True,
        "ai_ready": bool(providers),
        "visual_analysis": "browser-local-mediapipe",
        "vision_assets": vision_assets.status(),
        "realtime_voice_ready": all(os.getenv(key, "").strip() for key in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "DEEPGRAM_API_KEY", "GROQ_API_KEY")),
        "realtime_provider": "livekit+deepgram+groq",
        "realtime_setup": {
            "required_env_file": str(ENV_FILE),
            "missing_variables": [key for key in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "DEEPGRAM_API_KEY", "GROQ_API_KEY") if not os.getenv(key, "").strip()],
            "help": "Configure LiveKit Cloud, Deepgram and Groq credentials in the project-root .env file, then start both the API and the HirePilot voice agent.",
        },
        "providers": providers,
        "primary_provider": providers[0] if providers else None,
        "models": {
            "groq": GROQ_MODEL if GROQ_API_KEY else None,
            "gemini": GEMINI_MODEL if GEMINI_API_KEY else None,
        },
        "request_timeout_seconds": AI_TIMEOUT,
        "max_concurrent_ai_requests": AI_CONCURRENCY,
    }


@app.post("/api/resume/extract")
async def extract_resume_endpoint(resume: UploadFile = File(...)):
    return {"resume_text": await read_resume(resume)}


QUESTION_ANGLES = {
    "Beginner": [
        "core definitions and concepts in simple words", "everyday examples of how things are used", "basic tools and terminology",
        "simple hands-on mini tasks", "why you chose this field and what you are learning", "teamwork and asking for help",
        "communicating clearly", "basic good habits and best practices",
    ],
    "Medium": [
        "practical scenarios and trade-offs", "debugging and troubleshooting", "project and ownership stories",
        "tools, workflow and best practices", "testing and validation", "communication with non-experts",
        "teamwork and conflict", "prioritisation under time pressure",
    ],
    "Advanced": [
        "design and decision-making under constraints", "edge cases and failure modes", "performance, quality and efficiency",
        "leading and influencing others", "ethics, accuracy and responsibility", "learning from mistakes at scale",
        "ambiguous problems with incomplete data", "mentoring and technical communication",
    ],
}

DIFFICULTY_RULES = {
    "Beginner": (
        "DIFFICULTY = BEGINNER (strict). The candidate is a fresher or student with little or no work experience. "
        "Ask only foundational, easy questions: definitions, 'what is X and when would you use it', simple differences between two basic ideas, "
        "everyday examples, and gentle behavioural questions. "
        "FORBIDDEN at this level: system design, architecture, scaling, optimisation, advanced internals, tricky edge cases, "
        "multi-step coding or algorithm puzzles, and anything that needs years of experience. "
        "Every question must be answerable in 1-2 minutes by someone who has only learned the basics. Use short, friendly, plain wording."
    ),
    "Medium": (
        "DIFFICULTY = MEDIUM. The candidate has solid fundamentals and some project experience. Ask practical, applied questions: "
        "how they would approach a realistic task, compare options, debug a common problem, or explain a past project. "
        "Avoid trivial definitions and avoid expert-level system design."
    ),
    "Advanced": (
        "DIFFICULTY = ADVANCED. The candidate is experienced. Ask in-depth questions on trade-offs, design decisions, failure modes, "
        "performance, leadership and ambiguous real-world problems. Expect structured, detailed reasoning."
    ),
}


def _norm_question(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", text.lower()).strip()


@app.post("/api/interview/questions", response_model=InterviewPlan)
async def create_interview_questions(payload: InterviewSetup):
    resume_context = payload.resume_text.strip()[:MAX_RESUME_CHARS]
    avoid = [q.strip()[:300] for q in payload.avoid_questions if q.strip()][:40]
    avoid_norm = {_norm_question(q) for q in avoid}
    attempts = 2
    plan: dict[str, Any] = {}
    for attempt in range(attempts):
        angles = ", ".join(random.sample(QUESTION_ANGLES[payload.difficulty], 4))
        nonce = random.randint(100000, 999999)
        avoid_block = (
            "\nThe candidate has already practised these questions. Do NOT repeat or lightly reword any of them; "
            "ask clearly different questions:\n" + "\n".join(f"- {q}" for q in avoid)
            if avoid else ""
        )
        prompt = f"""
Build a FRESH interview practice set (variation id {nonce}).
{DIFFICULTY_RULES[payload.difficulty]}
Return exactly {payload.question_count} useful questions. Order them from easiest to slightly harder, but NEVER exceed the {payload.difficulty.upper()} level above, even for the last question.
Every question must be distinct from the others. Choose different wording and topics from previous sets, without raising the difficulty to do so.
For this set, lean towards these angles (only where they fit the difficulty): {angles}.
Mix role-specific technical, project/problem-solving, and communication questions according to the selected interview type.
The purpose field should explain what a strong answer needs to demonstrate.
Do not assume experience absent from the resume.{avoid_block}
Target role: {payload.role}
Interview type: {payload.interview_type}
Selected difficulty: {payload.difficulty} (this must be respected for every question)
Resume (may be empty):
{resume_context or "Not supplied"}
Job description (may be empty):
{payload.job_description or "Not supplied"}
"""
        plan = await generate_structured(prompt, InterviewPlan, temperature=0.6 if payload.difficulty == "Beginner" else 0.8)
        questions = plan.get("questions", [])
        repeated = any(_norm_question(q.get("question", "")) in avoid_norm for q in questions)
        if len(questions) == payload.question_count and not repeated:
            break
        if len(questions) == payload.question_count and attempt == attempts - 1:
            break  # accept after one retry rather than failing the session
    if len(plan.get("questions", [])) != payload.question_count:
        raise HTTPException(
            status_code=502,
            detail="The AI returned an incomplete question set. Please generate the questions again.",
        )
    return plan


@app.post("/api/interview/evaluate", response_model=InterviewEvaluation)
async def evaluate_interview_answer(payload: EvaluateAnswer):
    prompt = f"""
Evaluate one written mock-interview answer as a fair, demanding interviewer.
Judge the answer against the question and role. Give actionable feedback, not generic praise.
Do not infer personality, confidence, honesty, emotion, or intelligence. Do not reward fabricated claims.
Scores relevance, technical_correctness, completeness, structure and clarity are each 0-10.
overall_score is 0-100. Strengths and improvements should refer to specific content in this answer.
better_answer_direction should explain a stronger structure and missing points; do not write a fabricated first-person story.
Role: {payload.role}
Question: {payload.question}
Candidate resume context (may be empty):
{payload.resume_text or "Not supplied"}
Candidate answer:
{payload.answer}
"""
    return await generate_structured(prompt, InterviewEvaluation)




@app.post("/api/realtime/session")
async def create_realtime_session(payload: RealtimeSessionRequest, request: Request):
    # Local single-process rate guard. Add account-based/shared limits before public deployment.
    client_ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    recent = [stamp for stamp in realtime_session_attempts.get(client_ip, []) if now - stamp < 60]
    if len(recent) >= 5:
        raise HTTPException(status_code=429, detail="Too many live interview attempts. Wait one minute and try again.")
    recent.append(now)
    realtime_session_attempts[client_ip] = recent

    if payload.current_question_index >= len(payload.questions):
        raise HTTPException(status_code=422, detail="The current question index is outside the question set.")

    required = ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "DEEPGRAM_API_KEY", "GROQ_API_KEY")
    missing = [key for key in required if not os.getenv(key, "").strip()]
    if missing:
        raise HTTPException(status_code=503, detail="Live interview is not configured. Missing: " + ", ".join(missing))

    room_name = "hp-" + __import__("secrets").token_urlsafe(12).replace("-", "").replace("_", "")[:18].lower()
    identity = "candidate-" + __import__("secrets").token_hex(6)
    metadata = {
        "role": payload.role,
        "difficulty": payload.difficulty,
        "interview_type": payload.interview_type,
        "questions": [item.model_dump() for item in payload.questions],
        "current_question_index": payload.current_question_index,
        "resume_text": payload.resume_text[:8000],
    }
    try:
        from livekit import api as livekit_api
        token = (
            livekit_api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
            .with_identity(identity)
            .with_name("Candidate")
            .with_ttl(timedelta(minutes=10))
            .with_metadata(json.dumps(metadata, separators=(",", ":")))
            .with_grants(livekit_api.VideoGrants(
                room_join=True, room=room_name, can_publish=True,
                can_subscribe=True, can_publish_data=True,
            ))
            .to_jwt()
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Could not create a secure LiveKit room token. Check LiveKit credentials.") from exc

    return {
        "provider": "livekit-deepgram-groq",
        "transport": "livekit-webrtc",
        "url": os.getenv("LIVEKIT_URL", "").strip(),
        "room": room_name,
        "identity": identity,
        "token": token,
        "expires_in": 600,
    }


@app.post("/api/interview/live/evaluate")
async def evaluate_live_interview_turn(payload: LiveInterviewRequest):
    text_payload = EvaluateAnswer(
        role=payload.role,
        question=payload.question,
        answer=payload.answer,
        resume_text=payload.resume_text,
    )
    evaluation = await evaluate_interview_answer(text_payload)
    return {
        "answer_evaluation": evaluation,
        "audio_metrics": payload.audio_metrics,
        "visual_metrics": payload.visual_metrics,
        "transcript": payload.answer,
    }

def _avg(values: list[float], digits: int = 2) -> float | None:
    return round(sum(values) / len(values), digits) if values else None


def summarise_visual_metrics(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate per-answer browser visual metrics into one session summary."""
    def numbers(key: str) -> list[float]:
        return [
            float(item[key]) for item in items
            if isinstance(item.get(key), (int, float)) and not isinstance(item.get(key), bool)
        ]

    def labels(key: str) -> list[str]:
        return [str(item[key]) for item in items if item.get(key) not in (None, "", "unavailable")]

    usable = [item for item in items if item.get("available") is not False and item.get("samples", 1)]
    face = _avg(numbers("face_visible_ratio"))
    framing = _avg(numbers("framing_good_ratio"))
    gaze = _avg(numbers("gaze_toward_screen_ratio"))
    posture = _avg(numbers("posture_good_ratio"))
    hands = _avg(numbers("hands_visible_ratio"))
    blink = _avg(numbers("blink_rate_per_minute"), 0)
    lighting = labels("lighting")
    movement = labels("head_movement")
    problems_lighting = [value for value in lighting if value != "moderate / good"]
    frequent_movement = [value for value in movement if value == "frequent movement"]

    highlights: list[str] = []
    if face is not None:
        highlights.append(f"Your face was visible for about {round(face * 100)}% of the measured time.")
    if framing is not None:
        highlights.append(
            "Framing and distance were mostly good." if framing >= 0.72
            else "Framing needs work: centre your face and keep a steady distance from the camera."
        )
    if gaze is not None:
        highlights.append(
            f"Your eyes were pointed toward the screen about {round(gaze * 100)}% of the time."
            + ("" if gaze >= 0.65 else " Try looking toward the camera more while you speak.")
        )
    if posture is not None:
        highlights.append(
            "Posture looked upright and centred for most answers." if posture >= 0.65
            else "Posture drifted in several answers: sit tall with both shoulders in frame."
        )
    if frequent_movement:
        highlights.append(f"Head movement was frequent in {len(frequent_movement)} answer(s); a steadier head can help viewers focus on your words.")
    if hands is not None and hands >= 0.08:
        highlights.append("Your hands were visible at times; natural gestures are fine when they stay in a comfortable range.")
    if blink is not None:
        highlights.append(f"Observed blink rate averaged about {int(blink)} per minute (descriptive only).")
    if problems_lighting:
        highlights.append(f"Lighting was flagged in {len(problems_lighting)} answer(s): {problems_lighting[0]}.")
    basic_answers = [item for item in usable if item.get("basic_mode")]
    if basic_answers:
        motion = [str(item["frame_motion"]) for item in basic_answers if item.get("frame_motion") not in (None, "", "unavailable")]
        highlights.append(
            "Face, gaze and posture models were unavailable for "
            f"{len(basic_answers)} answer(s), so only basic camera checks ran"
            + (f" (movement in frame: {motion[0]})." if motion else ".")
        )
    if not items or not usable:
        highlights = ["No usable visual data was captured. Check that the camera is on and your face is visible."]

    return {
        "answers_with_visual_data": len(usable),
        "average_face_visible_ratio": face,
        "average_framing_good_ratio": framing,
        "average_gaze_toward_screen_ratio": gaze,
        "average_posture_good_ratio": posture,
        "average_hands_visible_ratio": hands,
        "average_blink_rate_per_minute": blink,
        "framing_good_answers": sum(item.get("framing_quality") == "good" for item in items),
        "lighting_by_answer": lighting,
        "head_movement_by_answer": movement,
        "basic_mode_answers": len(basic_answers),
        "highlights": highlights,
    }


@app.post("/api/interview/report")
async def build_interview_report(payload: ReportRequest):
    # Aggregate evaluations locally. No second LLM call means a faster, cheaper final report.
    scores = [item.overall_score for item in payload.evaluations]
    dimensions = {
        "relevance": round(sum(x.relevance for x in payload.evaluations) / len(scores), 1),
        "technical_correctness": round(sum(x.technical_correctness for x in payload.evaluations) / len(scores), 1),
        "completeness": round(sum(x.completeness for x in payload.evaluations) / len(scores), 1),
        "structure": round(sum(x.structure for x in payload.evaluations) / len(scores), 1),
        "clarity": round(sum(x.clarity for x in payload.evaluations) / len(scores), 1),
    }
    strengths = list(dict.fromkeys(item for x in payload.evaluations for item in x.strengths))[:8]
    improvements = list(dict.fromkeys(item for x in payload.evaluations for item in x.improvements))[:8]
    weak_dimension = min(dimensions, key=dimensions.get)
    strong_dimension = max(dimensions, key=dimensions.get)
    def numeric_values(key: str) -> list[float]:
        values = []
        for item in payload.audio_metrics:
            value = item.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                values.append(float(value))
        return values

    audio_summary = {}
    for key in ("words_per_minute", "duration_seconds", "longest_pause_seconds", "pitch_variation_semitones", "intensity_variation_percent"):
        values = numeric_values(key)
        audio_summary[key] = round(sum(values) / len(values), 1) if values else None
    audio_summary["total_filler_count"] = sum(
        int(item.get("filler_count", 0)) for item in payload.audio_metrics
        if isinstance(item.get("filler_count", 0), (int, float)) and not isinstance(item.get("filler_count", 0), bool)
    )
    audio_summary["total_pause_count"] = sum(
        int(item.get("pause_count", 0)) for item in payload.audio_metrics
        if isinstance(item.get("pause_count", 0), (int, float)) and not isinstance(item.get("pause_count", 0), bool)
    )
    visual_summary = summarise_visual_metrics(payload.visual_metrics)

    return {
        "role": payload.role,
        "questions_evaluated": len(scores),
        "overall_score": round(sum(scores) / len(scores)),
        "dimension_scores": dimensions,
        "strongest_area": strong_dimension.replace("_", " ").title(),
        "priority_area": weak_dimension.replace("_", " ").title(),
        "strengths": strengths,
        "improvements": improvements,
        "audio_summary": audio_summary,
        "visual_summary": visual_summary,
        "next_steps": [
            f"Focus your next practice session on {weak_dimension.replace('_', ' ')}.",
            "Use a clear structure: context, action or reasoning, and outcome.",
            "Support technical claims with a concrete example, trade-off, or short explanation.",
        ],
        "note": "This report summarizes answer evaluations and observable delivery signals; it is not a measure of personality, emotion, confidence, or hiring suitability.",
    }


@app.post("/api/resume/humanize", response_model=ResumeHumanization)
async def humanize_resume(
    resume: UploadFile = File(...),
    target_role: str = Form(default=""),
):
    text = await read_resume(resume)
    prompt = f"""
Improve the writing of this resume so it sounds clear, specific, natural, and professionally written by a real candidate.
Do not make it sound inflated, robotic, stuffed with keywords, or like marketing copy.
CRITICAL: never invent employers, job titles, dates, metrics, achievements, responsibilities, technologies, education, or certifications.
Keep every rewritten bullet traceable to the original resume. If the source bullet is weak or unclear, improve grammar only and flag missing evidence in cautions.
Return a concise professional summary, a truthful headline, up to 10 rewritten bullets, skills already present that should be surfaced, and cautions where the candidate should add real evidence themselves.
Target role: {target_role or "Not specified"}
Resume:
{text}
"""
    return await generate_structured(prompt, ResumeHumanization)


@app.post("/api/job/analyze", response_model=JobAnalysis)
async def analyze_job(
    resume: UploadFile = File(...),
    job_description: str = Form(...),
):
    if not job_description.strip():
        raise HTTPException(status_code=400, detail="Paste a job description before analyzing.")
    text = await read_resume(resume)
    prompt = f"""
Compare this resume with the job description. Be realistic and evidence-based.
Use only facts present in the resume and job description. Never invent candidate experience.
Classify skills as strong_matches, partial_matches, or missing_skills. Explain a realistic match_score.
Resume:
{text}
Job description:
{job_description[:16000]}
"""
    return await generate_structured(prompt, JobAnalysis)


@app.post("/api/job/roles", response_model=RoleRecommendations)
async def recommend_roles(resume: UploadFile = File(...)):
    text = await read_resume(resume)
    prompt = f"""
Recommend exactly five realistic entry-level or internship roles based only on this resume.
Fit scores must reflect evidence in the resume. For each role, explain why it fits and list skills to improve.
Do not invent experience or imply the candidate is already qualified for skills they do not show.
Resume:
{text}
"""
    return await generate_structured(prompt, RoleRecommendations)


@app.get("/api/health/live")
async def liveness():
    return {"ok": True, "service": APP_NAME}
