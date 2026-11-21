import fitz
from fastapi.testclient import TestClient

from backend import main


def test_health_and_frontend_routes():
    with TestClient(main.app) as client:
        assert client.get("/").status_code == 200
        assert "HirePilot" in client.get("/").text
        health = client.get("/api/health").json()
        assert health["ok"] is True
        assert client.get("/static/app.js").status_code == 200


def test_report_aggregates_without_ai(monkeypatch):
    with TestClient(main.app) as client:
        payload = {
            "role": "Data Analyst",
            "evaluations": [
                {
                    "relevance": 8, "technical_correctness": 7, "completeness": 6,
                    "structure": 8, "clarity": 9, "overall_score": 76,
                    "strengths": ["Clear explanation"], "improvements": ["Add a project example"],
                    "better_answer_direction": "Use a concrete example."
                },
                {
                    "relevance": 7, "technical_correctness": 8, "completeness": 7,
                    "structure": 7, "clarity": 8, "overall_score": 74,
                    "strengths": ["Good reasoning"], "improvements": ["Explain trade-offs"],
                    "better_answer_direction": "Explain the trade-offs."
                }
            ]
        }
        response = client.post("/api/interview/report", json=payload)
        assert response.status_code == 200
        result = response.json()
        assert result["overall_score"] == 75
        assert result["questions_evaluated"] == 2
        assert result["dimension_scores"]["clarity"] == 8.5
        assert "Clear explanation" in result["strengths"]


def test_resume_extractor_rejects_non_pdf():
    with TestClient(main.app) as client:
        response = client.post(
            "/api/resume/extract",
            files={"resume": ("not-a-pdf.pdf", b"not a pdf", "application/pdf")},
        )
        assert response.status_code == 400


def test_resume_extractor_reads_pdf_text():
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), "Jay Bhati - Python developer with data analysis project experience.")
    data = document.tobytes()
    document.close()
    text = main.extract_pdf_text(data)
    assert "Python developer" in text


def test_question_generation_uses_validated_schema(monkeypatch):
    async def fake_generate(prompt, schema, **kwargs):
        return schema.model_validate({
            "role": "Data Analyst",
            "questions": [
                {"question": f"Question {i}: how would you approach this?", "category": "Technical", "purpose": "Check structured reasoning."}
                for i in range(4)
            ]
        }).model_dump()

    monkeypatch.setattr(main, "generate_structured", fake_generate)
    with TestClient(main.app) as client:
        response = client.post("/api/interview/questions", json={"role": "Data Analyst", "question_count": 4})
        assert response.status_code == 200
        assert response.json()["questions"][0]["category"] == "Technical"


def test_evaluation_rejects_empty_answer():
    with TestClient(main.app) as client:
        response = client.post("/api/interview/evaluate", json={
            "role": "Data Analyst", "question": "Explain SQL joins.", "answer": "short"
        })
        assert response.status_code == 422


def test_voice_endpoints_removed():
    with TestClient(main.app) as client:
        assert client.post("/api/interview/audio").status_code == 404
        assert client.post("/api/interview/audio/evaluate").status_code == 404





def test_realtime_session_requires_livekit_credentials(monkeypatch):
    for key in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "DEEPGRAM_API_KEY", "GROQ_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    with TestClient(main.app) as client:
        response = client.post("/api/realtime/session", json={
            "role": "Data Analyst",
            "difficulty": "Medium",
            "interview_type": "Technical",
            "questions": [{"question": "Explain SQL joins", "category": "SQL", "purpose": "Check database knowledge"}],
            "current_question_index": 0,
        })
    assert response.status_code == 503
    assert "LIVEKIT_URL" in response.json()["detail"]


def test_live_evaluation_accepts_local_metrics(monkeypatch):
    async def fake_evaluate(payload):
        return {
            "relevance": 8, "technical_correctness": 7, "completeness": 7,
            "structure": 8, "clarity": 8, "overall_score": 76,
            "strengths": ["Clear explanation"], "improvements": ["Give an example"],
            "better_answer_direction": "Use a practical example."
        }
    monkeypatch.setattr(main, "evaluate_interview_answer", fake_evaluate)
    with TestClient(main.app) as client:
        response = client.post("/api/interview/live/evaluate", json={
            "role": "Data Analyst", "question": "Explain SQL joins",
            "answer": "An inner join returns rows with matching keys in both tables.",
            "audio_metrics": {"words_per_minute": 120, "filler_count": 2},
            "visual_metrics": {"framing_quality": "good", "face_visible_ratio": 0.95},
        })
    assert response.status_code == 200
    assert response.json()["audio_metrics"]["words_per_minute"] == 120
    assert response.json()["visual_metrics"]["framing_quality"] == "good"


def test_report_aggregates_audio_and_visual_metrics():
    evaluation = {
        "relevance": 8, "technical_correctness": 7, "completeness": 7,
        "structure": 8, "clarity": 8, "overall_score": 76,
        "strengths": ["Clear explanation"], "improvements": ["Add examples"],
        "better_answer_direction": "Use a concrete example."
    }
    with TestClient(main.app) as client:
        response = client.post("/api/interview/report", json={
            "role": "Data Analyst", "evaluations": [evaluation],
            "audio_metrics": [{"words_per_minute": 120, "filler_count": 2, "pause_count": 3}],
            "visual_metrics": [{"face_visible_ratio": 0.9, "framing_quality": "good"}],
        })
    assert response.status_code == 200
    result = response.json()
    assert result["audio_summary"]["words_per_minute"] == 120
    assert result["audio_summary"]["total_filler_count"] == 2
    assert result["visual_summary"]["average_face_visible_ratio"] == 0.9


def test_questions_retry_when_previous_questions_repeat(monkeypatch):
    calls = {"n": 0, "prompts": []}

    async def fake_generate(prompt, schema, **kwargs):
        calls["n"] += 1
        calls["prompts"].append(prompt)
        text = "Explain the difference between a list and a tuple." if calls["n"] == 1 else f"New question {calls['n']}?"
        return schema.model_validate({
            "role": "Python Developer",
            "questions": [
                {"question": text if i == 0 else f"Another unique question {i} for attempt {calls['n']}?", "category": "Technical", "purpose": "Check reasoning."}
                for i in range(4)
            ],
        }).model_dump()

    monkeypatch.setattr(main, "generate_structured", fake_generate)
    with TestClient(main.app) as client:
        response = client.post("/api/interview/questions", json={
            "role": "Python Developer", "question_count": 4,
            "avoid_questions": ["Explain the difference between a list and a tuple."],
        })
        assert response.status_code == 200
        assert calls["n"] == 2  # first set repeated an old question, so it regenerated
        assert "Explain the difference" not in response.json()["questions"][0]["question"]
        assert "Do NOT repeat" in calls["prompts"][0]


def test_question_prompt_enforces_selected_difficulty(monkeypatch):
    seen = {}

    async def fake_generate(prompt, schema, **kwargs):
        seen["prompt"] = prompt
        seen["temperature"] = kwargs.get("temperature")
        return schema.model_validate({
            "role": "Python Developer",
            "questions": [
                {"question": f"What is concept number {i} in simple words?", "category": "Technical", "purpose": "Check basics."}
                for i in range(4)
            ],
        }).model_dump()

    monkeypatch.setattr(main, "generate_structured", fake_generate)
    with TestClient(main.app) as client:
        response = client.post("/api/interview/questions", json={
            "role": "Python Developer", "question_count": 4, "difficulty": "Beginner",
        })
        assert response.status_code == 200
    assert "DIFFICULTY = BEGINNER (strict)" in seen["prompt"]
    assert "FORBIDDEN" in seen["prompt"]
    assert seen["temperature"] <= 0.7


def test_visual_summary_aggregates_all_signals():
    summary = main.summarise_visual_metrics([
        {"available": True, "samples": 40, "face_visible_ratio": 0.98, "framing_good_ratio": 0.9,
         "gaze_toward_screen_ratio": 0.8, "posture_good_ratio": 0.9, "hands_visible_ratio": 0.2,
         "blink_rate_per_minute": 16, "lighting": "moderate / good", "head_movement": "steady", "framing_quality": "good"},
        {"available": True, "samples": 40, "face_visible_ratio": 0.9, "framing_good_ratio": 0.8,
         "gaze_toward_screen_ratio": 0.5, "posture_good_ratio": 0.4, "blink_rate_per_minute": 20,
         "lighting": "low", "head_movement": "frequent movement", "framing_quality": "good"},
    ])
    assert summary["answers_with_visual_data"] == 2
    assert summary["average_gaze_toward_screen_ratio"] == 0.65
    assert summary["framing_good_answers"] == 2
    assert any("Lighting was flagged" in line for line in summary["highlights"])
    assert any("Head movement was frequent" in line for line in summary["highlights"])


def test_visual_summary_handles_missing_data():
    summary = main.summarise_visual_metrics([])
    assert summary["answers_with_visual_data"] == 0
    assert "No usable visual data" in summary["highlights"][0]
    unavailable = main.summarise_visual_metrics([{"available": False, "samples": 0}])
    assert unavailable["answers_with_visual_data"] == 0
