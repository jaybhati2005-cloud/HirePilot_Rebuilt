from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import Agent, AgentSession, JobContext, RoomOutputOptions, TurnHandlingOptions, WorkerOptions, cli
from livekit.plugins import deepgram, groq, silero

try:
    from livekit.agents import StopResponse
except ImportError:  # older 1.x layouts
    from livekit.agents.llm import StopResponse

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv(os.path.join(PROJECT_ROOT, ".env"), override=False)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("hirepilot.voice")


def build_instructions(metadata: dict) -> str:
    role = str(metadata.get("role", "the target role"))[:120]
    difficulty = str(metadata.get("difficulty", "Medium"))
    interview_type = str(metadata.get("interview_type", "Technical + HR"))
    questions = metadata.get("questions") or []
    resume_context = str(metadata.get("resume_text", ""))[:8000]
    question_list = "\n".join(
        f"{i + 1}. [{q.get('category', 'General')}] {q.get('question', '')}"
        for i, q in enumerate(questions[:12])
    )
    return f"""You are HirePilot, a natural, professional interviewer conducting a {interview_type} interview.
Target role: {role}. Difficulty: {difficulty}.
Keep spoken responses to one or two short sentences.
You only speak when the application instructs you to. Never invent or ask a new question on your own, never move to another question yourself, and never give the candidate the answer.
If asked to clarify, explain what the question is testing without revealing an ideal answer.
Do not infer personality, emotion, confidence, honesty, intelligence, or hiring suitability.
Candidate resume context (factual context only; never invent experience):
{resume_context or 'Not supplied'}
Interview question list (for reference only):
{question_list}"""


class InterviewerAgent(Agent):
    """The application drives the interview. The LLM never replies on its own
    after the candidate speaks, so spoken questions always match the UI."""

    async def on_user_turn_completed(self, turn_ctx, new_message):
        raise StopResponse()


async def entrypoint(ctx: JobContext):
    await ctx.connect()
    participant = await ctx.wait_for_participant()
    try:
        metadata = json.loads(participant.metadata or "{}")
    except (TypeError, json.JSONDecodeError):
        metadata = {}
    questions = metadata.get("questions") or []
    total = len(questions)
    current_index = int(metadata.get("current_question_index", 0))
    if not 0 <= current_index < max(total, 1):
        current_index = 0

    session = AgentSession(
        stt=deepgram.STTv2(
            model=os.getenv("DEEPGRAM_STT_MODEL", "flux-general-en"),
            eager_eot_threshold=float(os.getenv("DEEPGRAM_EAGER_EOT_THRESHOLD", "0.4")),
            mip_opt_out=os.getenv("DEEPGRAM_MIP_OPTOUT", "false").lower() == "true",
        ),
        llm=groq.LLM(
            model=os.getenv("GROQ_VOICE_MODEL", "openai/gpt-oss-20b"),
            temperature=0.3,
            max_completion_tokens=160,
            max_retries=1,
        ),
        tts=deepgram.TTS(model=os.getenv("DEEPGRAM_TTS_MODEL", "aura-2-asteria-en")),
        vad=silero.VAD.load(),
        turn_handling=TurnHandlingOptions(turn_detection="stt"),
    )

    async def publish(payload: dict):
        try:
            await ctx.room.local_participant.publish_data(
                json.dumps(payload, ensure_ascii=False), reliable=True
            )
        except Exception:
            logger.exception("Could not publish %s to browser", payload.get("type"))

    def publish_soon(payload: dict):
        asyncio.create_task(publish(payload))

    async def stop_current_speech():
        try:
            result = session.interrupt()
            if inspect.isawaitable(result):
                await result
        except Exception:
            pass  # nothing was speaking

    def question_at(index: int) -> str:
        if 0 <= index < total:
            return str(questions[index].get("question", "")).strip()
        return "Tell me about yourself and your relevant experience."

    async def speak_question(index: int, first: bool = False):
        """Speak question `index` verbatim via TTS and tell the browser which one it is."""
        nonlocal current_index
        current_index = index
        if first:
            intro = f"Hello, I'm your HirePilot interviewer. Let's begin. Question {index + 1}."
        elif index == total - 1 and total > 1:
            intro = "Here is the final question."
        else:
            intro = f"Question {index + 1}."
        await stop_current_speech()
        session.say(f"{intro} {question_at(index)}", allow_interruptions=True)
        await publish({"type": "hirepilot.question", "index": index, "total": total})
        logger.info("Asked question %d/%d", index + 1, total)

    async def process_command(message: dict):
        nonlocal current_index
        command = message.get("command")
        requested = message.get("question_index")
        index = requested if isinstance(requested, int) and 0 <= requested < max(total, 1) else current_index
        try:
            if command == "ask":
                await speak_question(index)
            elif command == "repeat":
                current_index = index
                await stop_current_speech()
                session.say(question_at(index), allow_interruptions=True)
            elif command == "clarify":
                current_index = index
                await stop_current_speech()
                await session.generate_reply(
                    instructions=(
                        "Briefly clarify what this interview question is asking, in one or two sentences, "
                        f"without giving the answer: {question_at(index)}"
                    )
                )
            elif command == "feedback":
                text = str(message.get("text", "")).strip()[:600]
                if text:
                    await stop_current_speech()
                    session.say(text, allow_interruptions=True)
            else:
                logger.info("Ignoring unknown command %r", command)
        except Exception:
            logger.exception("Could not run command %r", command)

    # rtc.Room emits `data_received` with an rtc.DataPacket (fields: data,
    # participant, kind, topic). Older/other builds may pass raw bytes first.
    # Accept both so commands are never silently dropped.
    def handle_data(packet, *extra):
        raw = getattr(packet, "data", packet)
        sender = getattr(packet, "participant", None)
        if sender is None and extra:
            sender = extra[0]
        if sender is not None and getattr(sender, "identity", None) == ctx.room.local_participant.identity:
            return
        try:
            if isinstance(raw, str):
                message = json.loads(raw)
            else:
                message = json.loads(bytes(raw).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
            logger.warning("Ignoring malformed HirePilot data packet")
            return
        if not isinstance(message, dict) or message.get("type") != "hirepilot.command":
            return
        logger.info("Command received: %s", message.get("command"))
        asyncio.create_task(process_command(message))

    def handle_user_transcript(event):
        publish_soon({
            "type": "hirepilot.transcript",
            "text": event.transcript,
            "final": bool(event.is_final),
        })

    def handle_agent_state(event):
        publish_soon({"type": "hirepilot.agent_state", "state": str(event.new_state)})

    session.on("user_input_transcribed", handle_user_transcript)
    session.on("agent_state_changed", handle_agent_state)
    ctx.room.on("data_received", handle_data)

    logger.info("Starting HirePilot AgentSession for room %s", ctx.room.name)
    await session.start(
        room=ctx.room,
        agent=InterviewerAgent(instructions=build_instructions(metadata)),
        room_output_options=RoomOutputOptions(transcription_enabled=True),
    )
    await publish({"type": "hirepilot.status", "status": "ready"})
    # The agent opens the interview itself, so the first question is always spoken.
    await speak_question(current_index, first=True)
    logger.info("HirePilot voice agent ready in room %s", ctx.room.name)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
