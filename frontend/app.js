(() => {
  "use strict";

  const API_BASE = (window.HIREPILOT_API_URL || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  const state = {
    questions: [],
    evaluations: [],
    answers: [],
    evaluatedAnswers: [],
    index: 0,
    role: "",
    resumeText: "",
    interviewType: "",
    difficulty: "",
    report: null,
    liveMode: false,
    liveActive: false,
    liveStopping: false,
    liveFinalTranscript: "",
    liveVisuals: [],
    liveAudioSummaries: [],
    liveVisualSummaries: [],
    liveMicStream: null,
    liveCameraStream: null,
    liveKitRoom: null,
    liveKitSdk: null,
    liveInitialQuestionSent: false,
    liveAudioContext: null,
    liveAudioTimer: null,
    liveAudioAnalyser: null,
    liveAudioTrack: null,
    liveVisualAnalyzer: null,
    liveAnswerMetrics: null,
    liveAnswerStartedAt: null,
    liveInterimTranscript: "",
    liveSessionConnected: false,
    liveAiResponding: false,
    livePhase: "idle",          // idle | answering | analyzing | feedback
    liveAgentState: "idle",
    liveQuestionAnnounced: false,
    liveAdvancing: false,
    liveAutoFinishTimer: null,
    liveAdvanceTimer: null,
    liveFallbackAskTimer: null,
    liveAwaitingFeedbackSpeech: null,
    liveAnswerWindowStarted: false,
    liveVisualReason: "",
    liveVisualBasic: false,
    visualReady: false,
  };

  const escapeHTML = (value) => String(value ?? "").replace(/[&<>'"]/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[ch]);

  function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("show"), 3200);
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner"></span> ${escapeHTML(label || "Working...")}`;
    } else {
      button.disabled = false;
      if (button.dataset.originalText) button.innerHTML = button.dataset.originalText;
    }
  }

  function loading(target, message = "HirePilot is working on it...") {
    target.innerHTML = `<div class="loading-state"><span class="spinner"></span>${escapeHTML(message)}</div>`;
  }

  function showError(target, message) {
    target.innerHTML = `<div class="error-box"><strong>We couldn't complete that request.</strong><br>${escapeHTML(message)}<br><br><span>Check your connection or provider configuration, then try again. Your input has not been cleared.</span></div>`;
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 55000);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
          ...(options.headers || {}),
        },
      });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; }
      catch { throw new Error(`The server returned an unreadable response (HTTP ${response.status}).`); }

      if (!response.ok) {
        const detail = typeof data.detail === "string"
          ? data.detail
          : Array.isArray(data.detail)
            ? data.detail.map(item => `${item.loc?.slice(-1)[0] || "field"}: ${item.msg}`).join("; ")
            : `Request failed with HTTP ${response.status}.`;
        throw new Error(detail);
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The request took too long. Try again; your text is still here.");
      if (error instanceof TypeError) throw new Error("Can't reach HirePilot's API. Make sure the Python backend is running and the frontend is served from it.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function showView(name) {
    document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === `view-${name}`));
    document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === name));
    const labels = { overview: "Overview", interview: "Interview coach", humanizer: "Resume humanizer", jobmatch: "Resume match", roles: "Career paths" };
    $("crumb").textContent = labels[name] || "Overview";
    $("sidebar").classList.remove("open");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });
  $("mobileMenu").addEventListener("click", () => $("sidebar").classList.toggle("open"));

  async function checkHealth() {
    const status = $("apiStatus");
    try {
      const data = await request("/api/health", { timeout: 8000 });
      state.visualReady = Boolean(data.visual_ready);
      if (data.ai_ready) {
        status.className = "status-indicator online";
        status.innerHTML = `<i></i> AI configured · ${escapeHTML(data.primary_provider)}`;
      } else {
        status.className = "status-indicator offline";
        status.innerHTML = "<i></i> API running · AI key missing";
      }
    } catch {
      status.className = "status-indicator offline";
      status.innerHTML = "<i></i> API unavailable";
    }
  }

  function currentQuestion() { return state.questions[state.index]; }

  // Remember recently asked questions (per role, this browser only) so new sets are different.
  const ASKED_KEY = "hirepilot.asked.v1";
  function askedKey(role) { return String(role || "").trim().toLowerCase(); }
  function loadAsked(role) {
    try { return (JSON.parse(localStorage.getItem(ASKED_KEY) || "{}")[askedKey(role)] || []).slice(-40); }
    catch { return []; }
  }
  function saveAsked(role, questions) {
    try {
      const all = JSON.parse(localStorage.getItem(ASKED_KEY) || "{}");
      const merged = [...(all[askedKey(role)] || []), ...questions.map(q => q.question)];
      all[askedKey(role)] = [...new Set(merged)].slice(-40);
      localStorage.setItem(ASKED_KEY, JSON.stringify(all));
    } catch { /* storage unavailable; variety still comes from the server */ }
  }

  function renderQuestion() {
    const question = currentQuestion();
    if (!question) return;
    $("practiceRoleTitle").textContent = state.role;
    $("practiceMeta").textContent = `${state.interviewType} · ${state.difficulty}`;
    $("questionCategory").textContent = (question.category || "GENERAL").toUpperCase();
    $("questionIndex").textContent = `QUESTION ${String(state.index + 1).padStart(2, "0")}`;
    $("currentQuestion").textContent = question.question;
    $("questionPurpose").textContent = question.purpose || "";
    $("candidateAnswer").value = state.answers[state.index] || "";
    $("progressText").textContent = `Question ${state.index + 1} of ${state.questions.length}`;
    $("progressFill").style.width = `${((state.index + 1) / state.questions.length) * 100}%`;
    $("previousQuestion").disabled = state.index === 0;
    $("nextQuestion").disabled = !state.evaluations[state.index];
    $("nextQuestion").textContent = state.index === state.questions.length - 1 ? "View report →" : "Next question →";
    $("answerFeedback").classList.toggle("hidden", !state.evaluations[state.index]);
    if (state.evaluations[state.index]) renderFeedback(state.evaluations[state.index]);
    $("practicePanel").classList.remove("hidden");
    $("setupPanel").classList.add("hidden");
    $("reportPanel").classList.add("hidden");
  }

  function renderList(items) {
    return `<ul>${(items || []).map(item => `<li>${escapeHTML(item)}</li>`).join("")}</ul>`;
  }

  function renderFeedback(evaluation) {
    const dimensions = [
      ["Relevance", evaluation.relevance],
      ["Correctness", evaluation.technical_correctness],
      ["Completeness", evaluation.completeness],
      ["Structure", evaluation.structure],
      ["Clarity", evaluation.clarity],
    ];
    $("answerFeedback").innerHTML = `
      <div class="feedback-top"><h3>Answer feedback</h3><div class="feedback-score">${evaluation.overall_score}<small style="font-size:10px;color:#94a09b"> / 100</small></div></div>
      <div class="feedback-grid">${dimensions.map(([label, score]) => `<div class="feedback-metric"><strong>${score}/10</strong><span>${label}</span></div>`).join("")}</div>
      <div class="feedback-lists"><div><h4>What worked</h4>${renderList(evaluation.strengths)}</div><div><h4>Improve next time</h4>${renderList(evaluation.improvements)}</div></div>
      <div class="direction-box"><strong>How to strengthen this answer</strong><br>${escapeHTML(evaluation.better_answer_direction)}</div>`;
    $("answerFeedback").classList.remove("hidden");
  }

  async function generateQuestions(liveMode = false) {
    const button = liveMode ? $("startLiveInterview") : $("generateQuestions");
    const role = $("interviewRole").value.trim();
    if (role.length < 2) return toast("Enter the role you want to practise for.");
    setBusy(button, true, "Building your question set...");
    try {
      let resumeText = "";
      const file = $("interviewResume").files[0];
      if (file) {
        const form = new FormData();
        form.append("resume", file);
        const extracted = await request("/api/resume/extract", { method: "POST", body: form, timeout: 20000 });
        resumeText = extracted.resume_text || "";
      }
      const payload = {
        role,
        interview_type: $("interviewType").value,
        difficulty: $("interviewDifficulty").value,
        question_count: Number($("questionCount").value),
        job_description: $("interviewJD").value.trim(),
        resume_text: resumeText,
        avoid_questions: loadAsked(role),
      };
      const plan = await request("/api/interview/questions", { method: "POST", body: JSON.stringify(payload) });
      if (!Array.isArray(plan.questions) || !plan.questions.length) throw new Error("The AI returned an empty question set. Try generating it again.");
      state.questions = plan.questions;
      saveAsked(role, plan.questions);
      state.evaluations = new Array(plan.questions.length).fill(null);
      state.answers = new Array(plan.questions.length).fill("");
      state.evaluatedAnswers = new Array(plan.questions.length).fill(null);
      state.index = 0;
      state.role = role;
      state.resumeText = resumeText;
      state.interviewType = payload.interview_type;
      state.difficulty = payload.difficulty;
      state.report = null;
      state.liveMode = liveMode;
      state.liveVisuals = [];
      if (liveMode) {
        await enterLiveRoom();
      } else {
        renderQuestion();
      }
      toast(`${plan.questions.length} questions are ready. Let's begin.`);
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function evaluateAnswer() {
    const button = $("evaluateAnswer");
    const answer = $("candidateAnswer").value.trim();
    if (answer.length < 8) return toast("Write a little more before evaluating your answer.");
    state.answers[state.index] = answer;
    setBusy(button, true, "Evaluating your answer...");
    try {
      const evaluation = await request("/api/interview/evaluate", {
        method: "POST",
        body: JSON.stringify({
          role: state.role,
          question: currentQuestion().question,
          answer,
          resume_text: state.resumeText,
        }),
        timeout: 60000,
      });
      state.evaluations[state.index] = evaluation;
      state.evaluatedAnswers[state.index] = answer;
      renderFeedback(evaluation);
      $("nextQuestion").disabled = false;
      toast("Feedback is ready. Review it before moving on.");
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function nextQuestion() {
    state.answers[state.index] = $("candidateAnswer").value;
    if (state.index < state.questions.length - 1) {
      state.index += 1;
      renderQuestion();
    } else {
      await buildReport();
    }
  }

  function previousQuestion() {
    state.answers[state.index] = $("candidateAnswer").value;
    if (state.index > 0) {
      state.index -= 1;
      renderQuestion();
    }
  }

  async function buildReport(button = $("nextQuestion")) {
    setBusy(button, true, "Preparing your report...");
    try {
      const report = await request("/api/interview/report", {
        method: "POST",
        body: JSON.stringify({
          role: state.role,
          evaluations: state.evaluations.filter(Boolean),
          audio_metrics: state.liveAudioSummaries.filter(Boolean),
          visual_metrics: state.liveVisualSummaries.filter(Boolean),
        }),
        timeout: 20000,
      });
      state.report = report;
      renderReport(report);
      $("practicePanel").classList.add("hidden");
      $("reportPanel").classList.remove("hidden");
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    } finally {
      setBusy(button, false);
    }
  }

  function renderReport(report) {
    $("reportScore").textContent = `${report.overall_score}`;
    const labels = {
      relevance: "Relevance", technical_correctness: "Technical accuracy",
      completeness: "Completeness", structure: "Structure", clarity: "Clarity"
    };
    $("reportStats").innerHTML = Object.entries(report.dimension_scores || {}).map(([key, value]) =>
      `<div class="report-stat"><strong>${value}/10</strong><span>${labels[key] || escapeHTML(key)}</span></div>`
    ).join("");
    $("reportStrengths").innerHTML = (report.strengths || []).map(x => `<li>${escapeHTML(x)}</li>`).join("") || "<li>No strengths recorded.</li>";
    $("reportImprovements").innerHTML = (report.improvements || []).map(x => `<li>${escapeHTML(x)}</li>`).join("") || "<li>No improvement notes recorded.</li>";
    $("reportNextSteps").innerHTML = (report.next_steps || []).map(x => `<li>${escapeHTML(x)}</li>`).join("");
  }


  function setLiveMetric(id, value) {
    const node = $(id);
    if (node) node.textContent = value;
  }

  function resetLiveAnswerMetrics() {
    state.liveAnswerStartedAt = null;
    state.liveInterimTranscript = "";
    state.liveAnswerMetrics = {
      speech_seconds: 0,
      pause_count: 0,
      longest_pause_seconds: 0,
      current_silence_started: null,
      was_speaking: false,
      rms_samples: [],
      pitch_samples: [],
      started_at: null,
      last_tick: performance.now(),
      audio_samples: 0,
      last_speech_at: null,
    };
    setLiveMetric("livePace", "— WPM");
    setLiveMetric("liveFillers", "0");
    setLiveMetric("livePause", "—");
    setLiveMetric("livePitch", "—");
  }

  function estimatePitch(buffer, sampleRate) {
    let rms = 0;
    for (let i = 0; i < buffer.length; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / buffer.length);
    if (rms < 0.018) return null;
    let bestLag = -1, bestCorrelation = 0;
    const minLag = Math.max(2, Math.floor(sampleRate / 400));
    const maxLag = Math.min(buffer.length - 2, Math.floor(sampleRate / 70));
    for (let lag = minLag; lag <= maxLag; lag++) {
      let correlation = 0;
      for (let i = 0; i < buffer.length - lag; i++) correlation += buffer[i] * buffer[i + lag];
      correlation /= buffer.length - lag;
      if (correlation > bestCorrelation) { bestCorrelation = correlation; bestLag = lag; }
    }
    return bestLag > 0 && bestCorrelation > 0.18 ? sampleRate / bestLag : null;
  }

  function countFillers(text) {
    const matches = text.toLowerCase().match(/\b(um+|uh+|erm+|hmm+|you know)\b/g);
    return matches ? matches.length : 0;
  }

  function countFillerPhrases(text) {
    const matches = text.toLowerCase().match(/\b(i mean|sort of|kind of|basically|literally|actually)\b/g);
    return matches ? matches.length : 0;
  }

  function currentAudioSummary() {
    const metrics = state.liveAnswerMetrics || {};
    const now = performance.now();
    // Pace is measured from first to last detected speech, so the quiet wait before auto-submit doesn't lower it.
    const endedAt = metrics.last_speech_at || now;
    const elapsed = metrics.started_at ? Math.max(0.1, (endedAt - metrics.started_at) / 1000) : 0;
    const transcript = ($("liveTranscript")?.value || "").trim();
    const words = transcript ? transcript.split(/\s+/).length : 0;
    const pitches = metrics.pitch_samples || [];
    const minPitch = pitches.length ? Math.min(...pitches) : null;
    const maxPitch = pitches.length ? Math.max(...pitches) : null;
    const pitchVariation = minPitch && maxPitch && minPitch > 0
      ? 12 * Math.log2(maxPitch / minPitch) : null;
    const rms = metrics.rms_samples || [];
    const meanRms = rms.length ? rms.reduce((sum, value) => sum + value, 0) / rms.length : null;
    const variance = rms.length && meanRms ? rms.reduce((sum, value) => sum + ((value - meanRms) ** 2), 0) / rms.length : null;
    const intensityVariation = variance !== null && meanRms > 0
      ? Math.sqrt(variance) / meanRms * 100 : null;
    return {
      duration_seconds: Number(elapsed.toFixed(1)),
      speech_seconds: Number((metrics.speech_seconds || 0).toFixed(1)),
      words_per_minute: elapsed > 0 ? Math.round(words / elapsed * 60) : null,
      word_count: words,
      filler_count: countFillers(transcript),
      filler_phrase_count: countFillerPhrases(transcript),
      pause_count: metrics.pause_count || 0,
      longest_pause_seconds: Number((metrics.longest_pause_seconds || 0).toFixed(1)),
      pitch_min_hz: minPitch ? Math.round(minPitch) : null,
      pitch_max_hz: maxPitch ? Math.round(maxPitch) : null,
      pitch_variation_semitones: pitchVariation !== null ? Number(pitchVariation.toFixed(1)) : null,
      intensity_mean: meanRms !== null ? Number(meanRms.toFixed(3)) : null,
      intensity_variation_percent: intensityVariation !== null ? Number(intensityVariation.toFixed(1)) : null,
      audio_samples: metrics.audio_samples || 0,
    };
  }

  async function startAudioMonitoring(track) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Web Audio is unavailable in this browser.");
      const context = new AudioContextClass();
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.15;
      const source = context.createMediaStreamSource(new MediaStream([track]));
      source.connect(analyser);
      state.liveAudioContext = context;
      state.liveAudioAnalyser = analyser;
      resetLiveAnswerMetrics();
      const buffer = new Float32Array(analyser.fftSize);
      state.liveAudioTimer = window.setInterval(() => {
        if (!state.liveActive || !state.liveAnswerMetrics || !state.liveAudioTrack?.enabled) return;
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
        const rms = Math.sqrt(sum / buffer.length);
        const now = performance.now();
        const metrics = state.liveAnswerMetrics;
        const dt = Math.min(0.5, Math.max(0, (now - metrics.last_tick) / 1000));
        metrics.last_tick = now;
        metrics.audio_samples += 1;
        const speaking = rms > 0.014;
        if (speaking) {
          if (!metrics.started_at) metrics.started_at = now;
          if (!metrics.was_speaking && metrics.current_silence_started) {
            const pause = (now - metrics.current_silence_started) / 1000;
            if (pause >= 0.35) {
              metrics.pause_count += 1;
              metrics.longest_pause_seconds = Math.max(metrics.longest_pause_seconds, pause);
            }
            metrics.current_silence_started = null;
          }
          metrics.speech_seconds += dt;
          metrics.last_speech_at = now;
          metrics.rms_samples.push(rms);
          if (metrics.rms_samples.length > 900) metrics.rms_samples.shift();
          const pitch = estimatePitch(buffer, context.sampleRate);
          if (pitch && pitch >= 70 && pitch <= 400) {
            metrics.pitch_samples.push(pitch);
            if (metrics.pitch_samples.length > 900) metrics.pitch_samples.shift();
          }
        } else if (metrics.was_speaking && !metrics.current_silence_started) {
          metrics.current_silence_started = now;
        }
        metrics.was_speaking = speaking;
        const summary = currentAudioSummary();
        setLiveMetric("livePace", summary.words_per_minute === null ? "— WPM" : `${summary.words_per_minute} WPM`);
        setLiveMetric("liveFillers", String(summary.filler_count));
        setLiveMetric("livePause", `${summary.longest_pause_seconds.toFixed(1)}s`);
        setLiveMetric("livePitch", summary.pitch_variation_semitones === null ? "—" : `${summary.pitch_variation_semitones} st`);
      }, 250);
    } catch (error) {
      setLiveMetric("livePitch", "Unavailable");
      $("liveMetricsNote").textContent = `Audio analysis unavailable: ${error.message}. The real-time interview can still continue.`;
    }
  }

  function updateRealtimeTranscript() {
    const finalText = state.liveFinalTranscript.trim();
    const combined = [finalText, state.liveInterimTranscript.trim()].filter(Boolean).join(" ");
    $("liveTranscript").value = combined;
    $("liveTranscript").scrollTop = $("liveTranscript").scrollHeight;
  }

  function renderLiveQuestion() {
    const question = currentQuestion();
    if (!question) return;
    const last = state.index === state.questions.length - 1;
    $("liveQuestionText").textContent = question.question;
    $("liveQuestionPurpose").textContent = question.purpose || "";
    $("liveQuestionCategory").textContent = (question.category || "GENERAL").toUpperCase();
    $("liveQuestionCount").textContent = `QUESTION ${String(state.index + 1).padStart(2, "0")} / ${String(state.questions.length).padStart(2, "0")}`;
    $("liveStatus").textContent = `Question ${state.index + 1} of ${state.questions.length} · ${state.role}`;
    $("nextLiveQuestion").textContent = last ? "View final report →" : "Next question →";
  }

  function clearLiveTranscript() {
    state.liveFinalTranscript = "";
    state.liveInterimTranscript = "";
    $("liveTranscript").value = "";
  }

  function askCurrentLiveQuestion(mode = "ask") {
    const question = currentQuestion();
    if (!question) return;
    renderLiveQuestion();
    if (mode === "ask") {
      // New question: fresh transcript, fresh metrics, ready for the answer.
      clearLiveTranscript();
      state.livePhase = "answering";
      state.liveAnswerWindowStarted = false;
      state.liveVisualAnalyzer?.reset?.();
    }
    const command = mode === "repeat" ? "repeat" : mode === "clarify" ? "clarify" : "ask";
    sendLiveAgentCommand(command, state.index).catch(error => toast(error.message));
    $("liveAiState").textContent = mode === "ask" ? "Interviewer speaking" : "Interviewer responding";
    $("liveAiHint").textContent = "Answer after the question. Hands-free mode submits when you stop speaking.";
  }

  function appendLiveTranscript(text, isFinal = true) {
    const clean = String(text || "").trim();
    if (!clean) return;
    if (isFinal) {
      state.liveFinalTranscript += (state.liveFinalTranscript ? " " : "") + clean;
      state.liveInterimTranscript = "";
    } else {
      state.liveInterimTranscript = clean;
    }
    updateRealtimeTranscript();
    scheduleAutoFinish();
  }

  // Hands-free: submit the answer automatically after a quiet spell.
  function scheduleAutoFinish() {
    clearTimeout(state.liveAutoFinishTimer);
    if (!$("liveHandsFree")?.checked || state.livePhase !== "answering") return;
    state.liveAutoFinishTimer = setTimeout(() => {
      const words = ($("liveTranscript").value || "").trim().split(/\s+/).filter(Boolean).length;
      if (state.livePhase === "answering" && state.liveAgentState !== "speaking" && words >= 5) {
        finishLiveAnswer(true);
      }
    }, 3500);
  }

  function buildSpokenFeedback(evaluation, isLast) {
    const tidy = value => String(value || "").replace(/\s+/g, " ").replace(/[.\s]+$/, "").slice(0, 200);
    const parts = [`Thanks. You scored ${evaluation.overall_score} out of 100 on that answer.`];
    const strength = tidy((evaluation.strengths || [])[0]);
    const improvement = tidy((evaluation.improvements || [])[0]);
    if (strength) parts.push(`What worked: ${strength}.`);
    if (improvement) parts.push(`To improve: ${improvement}.`);
    if (isLast) parts.push("That was the final question. I'm preparing your report now.");
    else if ($("liveHandsFree")?.checked) parts.push("Let's move on to the next question.");
    else parts.push("Whenever you're ready, press Next question.");
    return parts.join(" ");
  }

  async function sendLiveAgentCommand(command, questionIndex = state.index, extra = {}) {
    const room = state.liveKitRoom;
    if (!room || !state.liveSessionConnected) throw new Error("The interviewer is not connected yet.");
    const payload = new TextEncoder().encode(JSON.stringify({ type: "hirepilot.command", command, question_index: questionIndex, ...extra }));
    await room.localParticipant.publishData(payload, { reliable: true });
  }

  function handleAgentState(agentState) {
    const waiting = state.liveAwaitingFeedbackSpeech;
    // The interviewer finished the question: start this answer's visual measurement window now,
    // so camera data covers the answer rather than the question being read out.
    if (agentState === "listening" && state.livePhase === "answering" && !state.liveAnswerWindowStarted) {
      state.liveAnswerWindowStarted = true;
      state.liveVisualAnalyzer?.reset?.();
    }
    if (agentState === "speaking") {
      if (waiting) waiting.started = true;
      return;
    }
    // Feedback finished: in hands-free mode, move to the next question automatically.
    if (waiting && waiting.started && agentState === "listening") {
      state.liveAwaitingFeedbackSpeech = null;
      if ($("liveHandsFree")?.checked && state.livePhase === "feedback") {
        clearTimeout(state.liveAdvanceTimer);
        state.liveAdvanceTimer = setTimeout(nextLiveQuestion, 900);
      }
    }
  }

  async function initialiseRealtimeVoice() {
    const session = await request("/api/realtime/session", {
      method: "POST",
      body: JSON.stringify({
        role: state.role,
        difficulty: state.difficulty || "Medium",
        interview_type: state.interviewType || "Technical + HR",
        questions: state.questions,
        current_question_index: state.index,
        resume_text: state.resumeText || "",
      }),
      timeout: 25000,
    });
    // Load the maintained LiveKit browser SDK as an ES module; no API secret is exposed here.
    const sdk = await import("https://cdn.jsdelivr.net/npm/livekit-client@2.24.1/+esm");
    state.liveKitSdk = sdk;
    const room = new sdk.Room({ adaptiveStream: true, dynacast: true });
    state.liveKitRoom = room;

    room.on(sdk.RoomEvent.Connected, () => {
      state.liveSessionConnected = true;
      $("liveStatus").textContent = `Connected · ${state.role}`;
      $("liveAiState").textContent = "Interviewer connected";
      $("micStatus").textContent = "● Live microphone connected";
    });
    room.on(sdk.RoomEvent.Disconnected, () => {
      state.liveSessionConnected = false;
      if (state.liveActive && !state.liveStopping) {
        $("liveStatus").textContent = "Voice connection lost. Try ending and restarting the session.";
      }
    });
    room.on(sdk.RoomEvent.ActiveSpeakersChanged, speakers => {
      const interviewerSpeaking = (speakers || []).some(person => person.identity !== room.localParticipant.identity);
      if (interviewerSpeaking) {
        $("liveAiState").textContent = "Interviewer speaking";
        $("micStatus").textContent = "Live audio connected";
      } else if (state.liveSessionConnected && !state.liveStopping) {
        $("liveAiState").textContent = "Your turn";
        $("micStatus").textContent = "● Microphone active";
      }
    });
    room.on(sdk.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === sdk.Track.Kind.Audio) {
        const element = track.attach();
        element.autoplay = true;
        element.style.display = "none";
        document.body.appendChild(element);
        state.liveRemoteElements ||= [];
        state.liveRemoteElements.push(element);
      }
    });
    room.on(sdk.RoomEvent.TrackUnsubscribed, track => track.detach().forEach(el => el.remove()));
    room.on(sdk.RoomEvent.DataReceived, (payload) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (data.type === "hirepilot.status") {
          if (data.status === "ready") {
            $("liveAiState").textContent = "Interviewer is ready";
            // The agent opens with the first question itself. If it hasn't confirmed
            // within 6 seconds, ask for it explicitly as a safety net.
            clearTimeout(state.liveFallbackAskTimer);
            state.liveFallbackAskTimer = setTimeout(() => {
              if (state.liveActive && !state.liveQuestionAnnounced && !state.liveInitialQuestionSent) {
                state.liveInitialQuestionSent = true;
                askCurrentLiveQuestion("ask");
              }
            }, 6000);
          }
        } else if (data.type === "hirepilot.question") {
          // The agent confirms exactly which question it is speaking: keep the tab in sync.
          state.liveQuestionAnnounced = true;
          if (Number.isInteger(data.index) && data.index === state.index) {
            renderLiveQuestion();
            if (state.livePhase === "idle") state.livePhase = "answering";
          }
        } else if (data.type === "hirepilot.agent_state") {
          state.liveAgentState = data.state;
          handleAgentState(data.state);
        } else if (data.type === "hirepilot.transcript") {
          // Ignore echo while the interviewer talks, and late text after the answer was submitted.
          if (state.livePhase !== "answering" || state.liveAgentState === "speaking") return;
          appendLiveTranscript(data.text || "", data.final !== false);
          if (data.text) {
            $("micStatus").textContent = data.final === false ? "● Hearing your response…" : "● Transcript updated";
            $("liveAiState").textContent = data.final === false ? "Listening to your answer" : "Response captured";
          }
        } else if (data.type === "hirepilot.error") {
          $("liveAiState").textContent = "Voice agent error";
          $("liveAiHint").textContent = data.message || "The voice agent reported an error.";
        }
      } catch { /* Ignore non-HirePilot data messages. */ }
    });

    await room.connect(session.url, session.token, { autoSubscribe: true });
    if (!state.liveAudioTrack) throw new Error("Microphone input is unavailable. Allow microphone access and restart.");
    await room.localParticipant.publishTrack(state.liveAudioTrack, {
      source: sdk.Track.Source.Microphone,
      name: "hirepilot-candidate-microphone",
    });
    state.liveSessionConnected = true;
    $("liveAiState").textContent = "Interviewer is preparing your first question";
    $("liveAiHint").textContent = "Microphone published to LiveKit. Waiting for the voice agent to confirm readiness…";
    $("micStatus").textContent = "● Microphone published · waiting for agent";
  }

  function setVisualTilesUnavailable(text = "Unavailable") {
    ["liveFraming", "livePosture", "liveGaze", "liveSteady", "liveLighting", "liveHands"].forEach(id => setLiveMetric(id, text));
  }

  function setVisualStatus(status) {
    const node = $("liveVisualStatus");
    if (node) { node.textContent = status.message || ""; node.dataset.stage = status.stage || ""; }
    const label = { ready: "CAMERA ON · ANALYSING", loading: "CAMERA ON · LOADING MODELS", "no-face": "CAMERA ON · NO FACE FOUND", error: "CAMERA ON · ANALYSIS ISSUE" }[status.stage];
    if (label) setLiveMetric("cameraStatusText", label);
  }

  function updateVisualTiles(m) {
    if (!m || m.samples < 3) return;
    if (m.basic_mode) {
      state.liveLatestVisualMetrics = m;
      setLiveMetric("liveFraming", "Face tracking off");
      ["livePosture", "liveGaze", "liveHands"].forEach(id => setLiveMetric(id, "—"));
      setLiveMetric("liveSteady", m.frame_motion === "unavailable" ? "Measuring…" : m.frame_motion);
      setLiveMetric("liveLighting", m.lighting);
      return;
    }
    if (!m.available) {
      setLiveMetric("liveFraming", "No face found");
      ["livePosture", "liveGaze", "liveSteady", "liveHands"].forEach(id => setLiveMetric(id, "—"));
      setLiveMetric("liveLighting", m.lighting || "—");
      return;
    }
    state.liveLatestVisualMetrics = m;
    setLiveMetric("liveFraming", m.distance && m.distance !== "good" && m.distance !== "unavailable" ? `${m.framing_quality} · ${m.distance}` : m.framing_quality);
    setLiveMetric("livePosture", m.posture_observation === "unavailable" ? "Shoulders not in view" : m.posture_observation);
    setLiveMetric("liveGaze", m.gaze === "unavailable" ? "—" : `${m.gaze} (${Math.round((m.gaze_toward_screen_ratio || 0) * 100)}%)`);
    setLiveMetric("liveSteady", m.head_movement === "unavailable" ? "Measuring…" : m.head_movement);
    setLiveMetric("liveLighting", m.lighting);
    setLiveMetric("liveHands", m.gesture_activity === "unavailable" ? "—" : m.gesture_activity);
  }

  function renderVisualChecks(checks) {
    if (!checks?.length) return "";
    const icon = { good: "✓", adjust: "!", info: "i", unavailable: "–" };
    return `<ul class="visual-checks">${checks.map(item => `<li class="check-${escapeHTML(item.status)}"><b>${icon[item.status] || "•"}</b><span><strong>${escapeHTML(item.label)}</strong> ${escapeHTML(item.detail)}</span></li>`).join("")}</ul>`;
  }

  // Starts in the background so slow model downloads never delay the voice interview.
  async function startLocalVisualAnalysis() {
    if (!state.liveCameraStream) {
      state.liveVisualReason = "Camera was off or permission was denied, so no visual analysis was possible.";
      setVisualTilesUnavailable();
      setVisualStatus({ stage: "error", message: state.liveVisualReason });
      return;
    }
    const video = $("liveCamera");
    video.srcObject = state.liveCameraStream;
    await video.play().catch(() => {});
    setVisualStatus({ stage: "loading", message: "Loading vision models… (first time can take a few seconds)" });
    try {
      const module = await import("/static/live-analysis.js?v=8");
      const analyzer = await module.createLocalVisualAnalyzer(video, updateVisualTiles, setVisualStatus);
      if (!state.liveActive || !state.liveCameraStream) { analyzer.stop(); return; }  // interview ended while loading
      state.liveVisualAnalyzer = analyzer;
      state.visualReady = true;
      state.liveVisualReason = "";
    } catch (error) {
      state.visualReady = false;
      state.liveVisualReason = `Face, gaze and posture models could not load (${error.message}).`;
      let advice = "Click here to retry the full analysis.";
      try {
        const assets = (await request("/api/health", { timeout: 8000 })).vision_assets;
        const serverError = assets?.errors?.length ? ` Server said: ${assets.errors.slice(-3).join(" | ")}.` : "";
        if (assets?.downloading) advice = "The server is still downloading the vision files. Click here to retry in a minute.";
        else if (assets && !assets.ready) advice = `The server could not download them (missing: ${assets.missing.join(", ")}).${serverError} See README, "Manual install".`;
        else if (assets?.ready) advice = "The server has the files now. Click here to retry.";
      } catch { /* health unavailable; keep generic advice */ }
      // Keep useful analysis running: lighting and movement need no downloads.
      try {
        if (state.liveActive && state.liveCameraStream && !state.liveVisualAnalyzer) {
          const module = await import("/static/live-analysis.js?v=8");
          state.liveVisualAnalyzer = module.createBasicVisualAnalyzer(video, updateVisualTiles);
          state.liveVisualBasic = true;
          state.liveVisualReason = `${state.liveVisualReason} Only basic camera checks (lighting, movement) ran.`;
        }
      } catch { setVisualTilesUnavailable(); }
      setVisualStatus({ stage: "error", message: `${state.liveVisualReason} ${advice} Running basic checks (lighting, movement) meanwhile; the interview works normally.` });
      $("liveMetricsNote").textContent = "Face, gaze, posture and hand analysis are unavailable this session; lighting, movement, audio and answer analysis still work.";
    }
  }

  async function enterLiveRoom() {
    $("setupPanel").classList.add("hidden");
    $("practicePanel").classList.add("hidden");
    $("reportPanel").classList.add("hidden");
    $("livePanel").classList.remove("hidden");
    document.querySelector(".interview-layout")?.classList.add("live-wide");
    $("practiceRoleTitle").textContent = state.role;
    state.liveActive = true;
    state.liveStopping = false;
    state.liveInitialQuestionSent = false;
    state.liveQuestionAnnounced = false;
    state.livePhase = "idle";
    state.liveAgentState = "idle";
    state.liveAdvancing = false;
    state.liveAwaitingFeedbackSpeech = null;
    state.liveAnswerWindowStarted = false;
    state.liveVisualReason = "";
    state.liveVisualBasic = false;
    setVisualTilesUnavailable("Checking…");
    setVisualStatus({ stage: "loading", message: "Waiting for camera…" });
    state.liveFinalTranscript = "";
    state.liveVisuals = [];
    state.liveAudioSummaries = [];
    state.liveVisualSummaries = [];
    clearLiveTranscript();
    $("liveFeedback").classList.add("hidden");
    $("finishLiveAnswer").disabled = false;
    $("nextLiveQuestion").disabled = true;
    renderLiveQuestion();
    resetLiveAnswerMetrics();
    try {
      const health = await request("/api/health", { timeout: 10000 });
      if (!health.realtime_voice_ready) {
        const missing = (health.realtime_setup?.missing_variables || []).join(", ");
        throw new Error(`Live interview is not configured. Add these variables to the project-root .env: ${missing}. Then start the separate LiveKit voice agent. Never put provider keys in frontend JavaScript.`);
      }
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone and camera access require HTTPS or localhost.");
      const audioConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      let stream, cameraError = null;
      try {
        // One permission prompt for microphone and camera together.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (firstError) {
        cameraError = firstError;
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });  // mic is required
      }
      state.liveMicStream = new MediaStream(stream.getAudioTracks());
      state.liveAudioTrack = state.liveMicStream.getAudioTracks()[0];
      await startAudioMonitoring(state.liveAudioTrack);
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length) {
        state.liveCameraStream = new MediaStream(videoTracks);
        $("cameraPlaceholder").classList.add("hidden");
        setLiveMetric("cameraStatusText", "CAMERA ON · STARTING");
        startLocalVisualAnalysis().catch(() => {});   // not awaited: models load while the interview connects
      } else {
        $("cameraPlaceholder").classList.remove("hidden");
        $("cameraPlaceholder").textContent = cameraError?.name === "NotAllowedError"
          ? "Camera permission denied. Voice interview will continue without visual analysis."
          : "Camera unavailable. Voice interview will continue without visual analysis.";
        setLiveMetric("cameraStatusText", "CAMERA OFF");
        startLocalVisualAnalysis().catch(() => {});
      }
      $("liveAiState").textContent = "Connecting to real-time interviewer";
      $("liveAiHint").textContent = "Establishing a secure, low-latency voice session…";
      await initialiseRealtimeVoice();
    } catch (error) {
      stopLiveMedia();
      $("liveAiState").textContent = "Could not start live voice";
      $("liveAiHint").textContent = error.message;
      toast(error.message);
    }
  }

  async function finishLiveAnswer(auto = false) {
    if (!state.liveActive || state.liveStopping || state.livePhase !== "answering") return;
    clearTimeout(state.liveAutoFinishTimer);
    state.liveStopping = true;
    state.livePhase = "analyzing";
    const button = $("finishLiveAnswer");
    if (state.liveAudioTrack) state.liveAudioTrack.enabled = false;
    await new Promise(resolve => setTimeout(resolve, 500));
    const answer = ($("liveTranscript").value || state.liveFinalTranscript).trim();
    if (answer.length < 8) {
      if (state.liveAudioTrack) state.liveAudioTrack.enabled = true;
      state.liveStopping = false;
      state.livePhase = "answering";
      if (!auto) toast("I didn't capture enough speech. Keep speaking or correct the transcript before analysing.");
      return;
    }
    setBusy(button, true, "Analysing answer and delivery...");
    $("liveAiState").textContent = "Reviewing your response";
    $("liveAiHint").textContent = "Evaluating answer quality and the locally measured delivery signals…";
    $("micStatus").textContent = "Answer analysis in progress";
    state.answers[state.index] = answer;
    const audioMetrics = currentAudioSummary();
    const visualMetrics = state.liveVisualAnalyzer?.getSummary?.() || {
      samples: 0, available: false, face_visible_ratio: null, framing_quality: "unavailable",
      posture_observation: "unavailable", head_orientation: "unavailable", lighting: "unavailable",
      checks: [], observations: [],
      unavailable_reason: state.liveVisualReason || "Visual models were still loading or unavailable for this answer.",
    };
    state.liveAudioSummaries[state.index] = audioMetrics;
    state.liveVisualSummaries[state.index] = visualMetrics;
    try {
      const result = await request("/api/interview/live/evaluate", {
        method: "POST",
        body: JSON.stringify({
          role: state.role,
          question: currentQuestion().question,
          answer,
          resume_text: state.resumeText,
          audio_metrics: audioMetrics,
          visual_metrics: visualMetrics,
        }),
        timeout: 70000,
      });
      const evaluation = result.answer_evaluation;
      state.evaluations[state.index] = evaluation;
      state.evaluatedAnswers[state.index] = answer;
      const visual = result.visual_metrics || visualMetrics;
      const visualNotes = visual.observations || [];
      const audioNotes = [
        audioMetrics.words_per_minute !== null ? `Speaking pace: ${audioMetrics.words_per_minute} words/min.` : "Speaking pace unavailable.",
        `Answer length: ${audioMetrics.word_count} words over ${audioMetrics.duration_seconds}s.`,
        `Filler words detected: ${audioMetrics.filler_count}; hedge phrases (e.g. "kind of", "basically"): ${audioMetrics.filler_phrase_count}.`,
        `Pauses over 0.35 seconds: ${audioMetrics.pause_count}; longest: ${audioMetrics.longest_pause_seconds}s.`,
        audioMetrics.pitch_variation_semitones !== null ? `Pitch range variation: ${audioMetrics.pitch_variation_semitones} semitones.` : "Pitch variation unavailable.",
        audioMetrics.intensity_variation_percent !== null ? `Relative vocal intensity variation: ${audioMetrics.intensity_variation_percent}%.` : "Vocal intensity variation unavailable.",
      ];
      $("liveFeedback").innerHTML = `
        <div class="feedback-top"><h3>Answer & delivery review</h3><div class="feedback-score">${evaluation.overall_score}<small style="font-size:10px;color:#94a09b"> /100</small></div></div>
        <p><strong>Transcript:</strong> ${escapeHTML(answer)}</p>
        <div class="visual-review"><h4>Audio delivery observations</h4>${renderList(audioNotes)}</div>
        <div class="visual-review"><h4>Visual presentation review</h4>${renderVisualChecks(visual.checks)}${visualNotes.length ? renderList(visualNotes) : `<p>${escapeHTML(visual.unavailable_reason || "Visual analysis unavailable for this answer.")}</p>`}<small>These are observable presentation signals, not inferences about emotion, confidence, personality or honesty.</small></div>
        <div class="direction-box"><strong>Answer coaching</strong><br>${escapeHTML(evaluation.better_answer_direction)}</div>
        <div class="feedback-lists"><div><h4>What worked</h4>${renderList(evaluation.strengths)}</div><div><h4>Improve next time</h4>${renderList(evaluation.improvements)}</div></div>`;
      $("liveFeedback").classList.remove("hidden");
      document.querySelector(".live-side")?.scrollTo({ top: 0, behavior: "smooth" });
      $("liveAiState").textContent = "Feedback is ready";
      $("liveAiHint").textContent = "Review the feedback, then continue. Your microphone is paused until the next question.";
      $("micStatus").textContent = "Answer analysed · microphone paused";
      state.livePhase = "feedback";
      $("nextLiveQuestion").disabled = false;
      // Speak a short feedback summary; hands-free mode advances once it finishes.
      const isLast = state.index === state.questions.length - 1;
      state.liveAwaitingFeedbackSpeech = { started: false };
      sendLiveAgentCommand("feedback", state.index, { text: buildSpokenFeedback(evaluation, isLast) })
        .catch(() => { state.liveAwaitingFeedbackSpeech = null; });
      if ($("liveHandsFree")?.checked) {
        // Safety net in case the agent's speaking-state messages never arrive.
        clearTimeout(state.liveAdvanceTimer);
        state.liveAdvanceTimer = setTimeout(nextLiveQuestion, 30000);
      }
      toast("Your answer, audio delivery and local visual signals have been analysed.");
    } catch (error) {
      state.livePhase = "answering";
      $("liveAiState").textContent = "Analysis could not finish";
      $("liveAiHint").textContent = error.message;
      $("micStatus").textContent = "Analysis failed — retry available";
      if (state.liveAudioTrack) state.liveAudioTrack.enabled = true;
      toast(error.message);
    } finally {
      setBusy(button, false);
      state.liveStopping = false;
      $("finishLiveAnswer").disabled = state.livePhase === "feedback";
    }
  }

  function renderLiveVisualReport() {
    const audioItems = state.liveAudioSummaries.map((item, index) => item ? `
      <article class="visual-report-item"><strong>Question ${index + 1} · Audio</strong>
      <p>${item.words_per_minute ?? "—"} WPM · ${item.filler_count} fillers · ${item.filler_phrase_count ?? 0} hedge phrases · ${item.pause_count} pauses · longest ${item.longest_pause_seconds}s · pitch variation ${item.pitch_variation_semitones ?? "—"} semitones</p></article>` : "").join("");
    const visualItems = state.liveVisualSummaries.map((item, index) => item ? `
      <article class="visual-report-item"><strong>Question ${index + 1} · Visual</strong>
      ${renderVisualChecks(item.checks)}
      ${item.observations?.length ? renderList(item.observations) : `<p>${escapeHTML(item.unavailable_reason || "Visual analysis unavailable for this answer.")}</p>`}</article>` : "").join("");
    const overall = state.report?.visual_summary?.highlights || [];
    $("liveVisualReport").innerHTML = `<div class="next-steps"><h3>Visual presentation summary</h3>${overall.length ? renderList(overall) : "<p>No visual data was captured.</p>"}<h3>Audio delivery report</h3>${audioItems || "<p>Audio metrics unavailable.</p>"}<h3>Per-answer visual review</h3>${visualItems || "<p>Visual metrics unavailable.</p>"}<small>Audio and visual measurements are coaching signals. They do not determine personality, emotion, confidence, honesty or hiring suitability.</small></div>`;
  }

  async function nextLiveQuestion() {
    if (state.liveAdvancing || state.livePhase !== "feedback") return;
    state.liveAdvancing = true;
    clearTimeout(state.liveAdvanceTimer);
    clearTimeout(state.liveAutoFinishTimer);
    state.liveAwaitingFeedbackSpeech = null;
    try {
      if (state.index < state.questions.length - 1) {
        state.index += 1;
        $("liveFeedback").classList.add("hidden");
        $("finishLiveAnswer").disabled = false;
        $("nextLiveQuestion").disabled = true;
        resetLiveAnswerMetrics();
        if (state.liveAudioTrack) state.liveAudioTrack.enabled = true;
        askCurrentLiveQuestion("ask");   // updates the question tab and clears the transcript
        return;
      }
      // Final question answered: build the report before tearing the room down.
      const built = await buildReport($("nextLiveQuestion"));
      if (!built) return;               // stay on screen so the user can retry
      state.liveActive = false;
      stopLiveMedia();
      state.livePhase = "idle";
      renderLiveVisualReport();
    $("livePanel").classList.add("hidden");
    } finally {
      state.liveAdvancing = false;
    }
  }

  function stopLiveMedia() {
    [state.liveAutoFinishTimer, state.liveAdvanceTimer, state.liveFallbackAskTimer].forEach(t => clearTimeout(t));
    state.liveAwaitingFeedbackSpeech = null;
    document.querySelector(".interview-layout")?.classList.remove("live-wide");
    state.liveActive = false;
    state.liveStopping = true;
    try { state.liveKitRoom?.disconnect(); } catch {}
    state.liveKitRoom = null;
    state.liveKitSdk = null;
    state.liveInitialQuestionSent = false;
    (state.liveRemoteElements || []).forEach(element => { try { element.remove(); } catch {} });
    state.liveRemoteElements = [];
    state.liveSessionConnected = false;
    state.liveAiResponding = false;
    if (state.liveAudioTimer) clearInterval(state.liveAudioTimer);
    state.liveAudioTimer = null;
    try { state.liveVisualAnalyzer?.stop?.(); } catch {}
    state.liveVisualAnalyzer = null;
    state.visualReady = false;
    try { state.liveAudioContext?.close(); } catch {}
    state.liveAudioContext = null;
    [state.liveMicStream, state.liveCameraStream].forEach(stream => {
      stream?.getTracks().forEach(track => track.stop());
    });
    state.liveMicStream = null;
    state.liveCameraStream = null;
    state.liveAudioTrack = null;
    if ($("liveCamera")) $("liveCamera").srcObject = null;
    if ($("liveRemoteAudio")) $("liveRemoteAudio").srcObject = null;
    state.liveStopping = false;
  }

  async function endLiveInterview() {
    // If some answers were already analysed, offer a report for those instead of discarding them.
    const answered = state.evaluations.filter(Boolean).length;
    if (answered > 0 && state.liveActive && confirm(`End now and view your report for the ${answered} answered question${answered === 1 ? "" : "s"}?`)) {
      const built = await buildReport($("stopLiveInterview"));
      if (built) {
        stopLiveMedia();
      renderLiveVisualReport();
        $("livePanel").classList.add("hidden");
        return;
      }
    }
    stopLiveMedia();
    $("livePanel").classList.add("hidden");
    $("setupPanel").classList.remove("hidden");
    $("practicePanel").classList.add("hidden");
    $("reportPanel").classList.add("hidden");
  }

  function resetSession() {
    stopLiveMedia();
    state.liveVisuals = [];
    state.liveAudioSummaries = [];
    state.liveVisualSummaries = [];
    $("livePanel").classList.add("hidden");
    $("liveVisualReport").innerHTML = "";
    state.questions = []; state.evaluations = []; state.answers = []; state.evaluatedAnswers = []; state.index = 0; state.resumeText = ""; state.report = null;
    $("setupPanel").classList.remove("hidden");
    $("practicePanel").classList.add("hidden");
    $("reportPanel").classList.add("hidden");
  }

  function reviewSession() {
    $("reportPanel").classList.add("hidden");
    state.index = 0;
    renderQuestion();
  }

  function humanizerResult(data) {
    const bullets = (data.rewritten_bullets || []).map((bullet, index) => `
      <div class="humanized-bullet">
        <div class="old">${escapeHTML(bullet.original)}</div>
        <div class="new">${escapeHTML(bullet.improved)}</div>
        <small>${escapeHTML(bullet.reason)}</small>
      </div>`).join("");
    $("humanizerOutput").innerHTML = `
      <div class="result-block">
        <div class="eyebrow">YOUR REFINED PROFILE</div>
        <h3>${escapeHTML(data.headline)}</h3>
        <p>${escapeHTML(data.professional_summary)}</p>
        <button class="copy-btn" data-copy="summary">Copy summary</button>
        <h3>Rewritten experience bullets</h3>${bullets || "<p>No bullet points were available to rewrite.</p>"}
        <h3>Skills to bring forward</h3><div>${(data.skills_to_surface || []).map(x => `<span class="result-chip">${escapeHTML(x)}</span>`).join("")}</div>
        <h3>Evidence to add yourself</h3>${renderList(data.cautions)}
      </div>`;
    $("humanizerOutput").dataset.summary = data.professional_summary || "";
    $("humanizerOutput").querySelector('[data-copy="summary"]')?.addEventListener("click", () => copyText($("humanizerOutput").dataset.summary));
  }

  async function humanizeResume() {
    const file = $("humanizerFile").files[0];
    if (!file) return toast("Choose a resume PDF first.");
    const button = $("humanizeButton"), output = $("humanizerOutput");
    const form = new FormData();
    form.append("resume", file);
    form.append("target_role", $("humanizerRole").value.trim());
    setBusy(button, true, "Improving your resume...");
    loading(output, "Reviewing your resume and refining the wording...");
    try {
      const data = await request("/api/resume/humanize", { method: "POST", body: form, timeout: 65000 });
      humanizerResult(data);
    } catch (error) { showError(output, error.message); }
    finally { setBusy(button, false); }
  }

  async function matchResume() {
    const file = $("matchResume").files[0], jd = $("matchJD").value.trim();
    if (!file || !jd) return toast("Upload a resume PDF and paste the job description.");
    const button = $("matchButton"), output = $("matchOutput");
    const form = new FormData(); form.append("resume", file); form.append("job_description", jd);
    setBusy(button, true, "Comparing your profile...");
    loading(output, "Comparing your resume with the job requirements...");
    try {
      const data = await request("/api/job/analyze", { method: "POST", body: form, timeout: 65000 });
      output.innerHTML = `
        <div class="result-block">
          <div class="eyebrow">YOUR MATCH BREAKDOWN</div>
          <div class="match-score-large">${data.match_score}<small> / 100</small></div>
          <h3>${escapeHTML(data.job_role)}</h3><p>${escapeHTML(data.candidate_summary)}</p>
          <h3>Strong matches</h3><div>${(data.strong_matches || []).map(x => `<span class="result-chip">${escapeHTML(x)}</span>`).join("")}</div>
          <h3>Partial matches</h3><div>${(data.partial_matches || []).map(x => `<span class="result-chip warn">${escapeHTML(x)}</span>`).join("")}</div>
          <h3>Missing skills</h3><div>${(data.missing_skills || []).map(x => `<span class="result-chip bad">${escapeHTML(x)}</span>`).join("")}</div>
          <h3>Recommended next steps</h3>${renderList(data.recommendations)}
        </div>`;
    } catch (error) { showError(output, error.message); }
    finally { setBusy(button, false); }
  }

  async function findRoles() {
    const file = $("rolesResume").files[0];
    if (!file) return toast("Choose a resume PDF first.");
    const button = $("rolesButton"), output = $("rolesOutput");
    const form = new FormData(); form.append("resume", file);
    setBusy(button, true, "Finding realistic roles...");
    loading(output, "Looking for roles supported by your experience...");
    try {
      const data = await request("/api/job/roles", { method: "POST", body: form, timeout: 65000 });
      output.innerHTML = (data.roles || []).map((role, index) => `
        <article class="role-result-card"><div class="role-fit">${role.fit_score}% fit</div><h3>${index + 1}. ${escapeHTML(role.role)}</h3>
        <p>${escapeHTML(role.why)}</p><h4>Skills to build next</h4>
        ${(role.skills_to_improve || []).map(skill => `<span class="skill-pill">${escapeHTML(skill)}</span>`).join("")}</article>`).join("");
    } catch (error) { showError(output, error.message); }
    finally { setBusy(button, false); }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied to clipboard."); }
    catch { toast("Clipboard access was blocked by the browser."); }
  }

  $("generateQuestions").addEventListener("click", () => generateQuestions(false));
  $("startLiveInterview").addEventListener("click", () => generateQuestions(true));
  $("finishLiveAnswer").addEventListener("click", finishLiveAnswer);
  $("nextLiveQuestion").addEventListener("click", nextLiveQuestion);
  $("stopLiveInterview").addEventListener("click", endLiveInterview);
  $("repeatLiveQuestion").addEventListener("click", () => {
    try { askCurrentLiveQuestion("repeat"); } catch (error) { toast(error.message); }
  });
  $("clarifyLiveQuestion").addEventListener("click", () => {
    try { askCurrentLiveQuestion("clarify"); } catch (error) { toast(error.message); }
  });
  $("clearLiveTranscript").addEventListener("click", () => {
    clearLiveTranscript();
    $("liveTranscript").focus();
  });
  $("liveVisualStatus").addEventListener("click", () => {
    if ($("liveVisualStatus").dataset.stage === "error" && state.liveActive && (!state.liveVisualAnalyzer || state.liveVisualBasic)) {
      try { state.liveVisualAnalyzer?.stop?.(); } catch {}
      state.liveVisualAnalyzer = null;
      state.liveVisualBasic = false;
      startLocalVisualAnalysis().catch(() => {});
    }
  });
  $("liveHandsFree").addEventListener("change", () => {
    if ($("liveHandsFree").checked) scheduleAutoFinish();
    else clearTimeout(state.liveAutoFinishTimer);
  });
  $("evaluateAnswer").addEventListener("click", evaluateAnswer);
  $("nextQuestion").addEventListener("click", nextQuestion);
  $("previousQuestion").addEventListener("click", previousQuestion);
  $("resetSession").addEventListener("click", resetSession);
  $("newSession").addEventListener("click", resetSession);
  $("reviewSession").addEventListener("click", reviewSession);
  $("humanizeButton").addEventListener("click", humanizeResume);
  $("matchButton").addEventListener("click", matchResume);
  $("rolesButton").addEventListener("click", findRoles);
  $("humanizerFile").addEventListener("change", event => {
    $("humanizerFileName").textContent = event.target.files[0]?.name || "Drop your resume PDF here";
  });

  $("candidateAnswer").addEventListener("input", () => {
    state.answers[state.index] = $("candidateAnswer").value;
    if (state.evaluations[state.index] && state.evaluatedAnswers[state.index] !== $("candidateAnswer").value.trim()) {
      state.evaluations[state.index] = null;
      state.evaluatedAnswers[state.index] = null;
      $("answerFeedback").classList.add("hidden");
      $("nextQuestion").disabled = true;
    }
  });

  checkHealth();
})();
