// HirePilot AI — local visual analysis (runs entirely in the browser).
//
// Signals measured per answer: face presence, framing, camera distance, head pose
// (yaw / pitch / tilt), gaze toward the screen, blink rate, head steadiness,
// shoulder / posture alignment, hand visibility and gesture activity, lighting
// (brightness, left/right balance, face vs background) and observable facial movement.
//
// These are observable presentation signals only. Nothing here infers emotion,
// confidence, honesty, personality or hiring suitability.
//
// Loading order for the MediaPipe library and models:
//   1. /static/vendor/mediapipe/...   (self-hosted; see scripts/download_vision_assets.py)
//   2. jsDelivr CDN, then unpkg CDN
// Camera frames never leave the browser.

const VISION_VERSION = "0.10.22";
const LOCAL_BASE = "/static/vendor/mediapipe";
const CDN_BASES = [
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`,
  `https://unpkg.com/@mediapipe/tasks-vision@${VISION_VERSION}`,
];
const MODELS = {
  face: {
    local: `${LOCAL_BASE}/face_landmarker.task`,
    remote: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  },
  pose: {
    local: `${LOCAL_BASE}/pose_landmarker_lite.task`,
    remote: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  },
  hand: {
    local: `${LOCAL_BASE}/hand_landmarker.task`,
    remote: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  },
};

const TICK_MS = 250;
const MAX_SAMPLES = 1500;

// ---------------------------------------------------------------- helpers

const mean = values => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
const round = (value, digits = 2) => value === null || value === undefined || Number.isNaN(value) ? null : Number(value.toFixed(digits));
const ratioOf = (items, predicate) => items.length ? items.filter(predicate).length / items.length : null;
const deg = radians => radians * 180 / Math.PI;

async function modelPath(spec) {
  try {
    const response = await fetch(spec.local, { method: "HEAD" });
    if (response.ok) return spec.local;
  } catch { /* fall through to remote */ }
  return spec.remote;
}

// makeOptions(delegate, modelPath) builds the task options for a given delegate.
function makeHandle(name, TaskClass, files, path, makeOptions) {
  return { name, TaskClass, files, path, makeOptions, task: null, delegate: null, failures: 0, rebuilding: false, lastTs: 0, lastError: null };
}

async function createWithFallback(handle) {
  let lastError;
  for (const delegate of ["GPU", "CPU"]) {
    try {
      handle.task = await handle.TaskClass.createFromOptions(handle.files, handle.makeOptions(delegate, handle.path));
      handle.delegate = delegate;
      return handle;
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error(`${handle.name} model could not start`);
}

// Run one detection. If the GPU delegate loads but fails while running (common on
// some drivers), transparently rebuild the task on the CPU.
function runDetection(handle, video, now) {
  if (!handle || !handle.task || handle.rebuilding) return null;
  const timestamp = Math.max(now, handle.lastTs + 1);
  handle.lastTs = timestamp;
  try {
    const result = handle.task.detectForVideo(video, timestamp);
    handle.failures = 0;
    return result;
  } catch (error) {
    handle.failures += 1;
    handle.lastError = error;
    if (handle.delegate === "GPU" && handle.failures >= 3) rebuildOnCpu(handle);
    return null;
  }
}

async function rebuildOnCpu(handle) {
  handle.rebuilding = true;
  try { handle.task?.close(); } catch { /* already closed */ }
  handle.task = null;
  try {
    handle.task = await handle.TaskClass.createFromOptions(handle.files, handle.makeOptions("CPU", handle.path));
    handle.delegate = "CPU";
    handle.failures = 0;
  } catch (error) {
    handle.lastError = error;
  } finally {
    handle.rebuilding = false;
  }
}

// ------------------------------------------------------------- model loading

async function loadModels(onStatus) {
  const attempts = [
    { label: "local", module: `${LOCAL_BASE}/vision_bundle.mjs`, wasm: `${LOCAL_BASE}/wasm` },
    ...CDN_BASES.map(base => ({ label: "cdn", module: `${base}/vision_bundle.mjs`, wasm: `${base}/wasm` })),
  ];
  const errors = [];
  for (const attempt of attempts) {
    const source = attempt.module.startsWith("/") ? "this server" : new URL(attempt.module).hostname;
    try {
      onStatus({ stage: "loading", message: `Loading vision library from ${source}…` });
      if (attempt.label === "local") {
        // Skip quickly (and quietly) when the server has not downloaded the assets yet.
        const probe = await fetch(attempt.module, { method: "HEAD" }).catch(() => null);
        if (!probe || !probe.ok) throw new Error("not downloaded on the server yet");
      }
      const vision = await import(attempt.module);
      const files = await vision.FilesetResolver.forVisionTasks(attempt.wasm);

      onStatus({ stage: "loading", message: "Loading face model…" });
      const face = makeHandle("face", vision.FaceLandmarker, files, await modelPath(MODELS.face), (delegate, path) => ({
        baseOptions: { modelAssetPath: path, delegate },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      }));
      await createWithFallback(face);

      // Pose and hands are optional: face analysis still works without them.
      onStatus({ stage: "loading", message: "Loading posture and hand models…" });
      const optionalHandle = async (name, TaskClass, spec, extra) => {
        const handle = makeHandle(name, TaskClass, files, await modelPath(spec), (delegate, path) => ({
          baseOptions: { modelAssetPath: path, delegate }, runningMode: "VIDEO", ...extra,
        }));
        return createWithFallback(handle);
      };
      const [poseResult, handResult] = await Promise.allSettled([
        optionalHandle("pose", vision.PoseLandmarker, MODELS.pose, { numPoses: 1 }),
        optionalHandle("hand", vision.HandLandmarker, MODELS.hand, { numHands: 2 }),
      ]);
      return {
        face,
        pose: poseResult.status === "fulfilled" ? poseResult.value : null,
        hand: handResult.status === "fulfilled" ? handResult.value : null,
        source: attempt.label,
      };
    } catch (error) {
      let reason = error.message || "failed";
      if (/dynamically imported module|Failed to fetch/i.test(reason)) {
        // Tell "file not found" apart from "network blocked": a 404 still returns a response.
        const probe = await fetch(attempt.module, { method: "HEAD" }).catch(() => null);
        reason = probe ? `HTTP ${probe.status} (file not found there)` : "blocked or unreachable";
      }
      errors.push(`${source}: ${reason}`);
    }
  }
  throw new Error(errors.join(" · ") || "network blocked or assets unavailable");
}

// ------------------------------------------------------------------ analyzer

export async function createLocalVisualAnalyzer(video, onMetrics = () => {}, onStatus = () => {}) {
  onStatus({ stage: "loading", message: "Loading vision models…" });
  const models = await loadModels(onStatus);
  const modelStatus = () => ({
    face: models.face.task ? "ready" : "failed",
    pose: models.pose ? (models.pose.task ? "ready" : "failed") : "unavailable",
    hand: models.hand ? (models.hand.task ? "ready" : "failed") : "unavailable",
    source: models.source,
    delegate: models.face.delegate,
  });
  onStatus({ stage: "ready", message: "Visual analysis running", models: modelStatus() });

  let samples = [];
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 54;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  let stopped = false;
  let busy = false;
  let tickCount = 0;
  let lastVideoTime = -1;
  let noFaceSince = null;
  let eyesWereClosed = false;
  let prevNose = null;
  let prevWrists = null;
  let lastPose = null;      // carried forward between alternating pose/hand ticks
  let lastHands = { visible: false, motion: 0 };
  let lastDiagnostic = 0;

  const tick = () => {
    if (stopped || busy || video.readyState < 2 || !video.videoWidth || video.currentTime === lastVideoTime) return;
    busy = true;
    lastVideoTime = video.currentTime;
    tickCount += 1;
    try {
      const now = performance.now();
      const sample = { t: now, face_visible: false };

      // ---- face: presence, framing, distance, head pose, gaze, blink, movement
      const faceResult = runDetection(models.face, video, now);
      const landmarks = faceResult?.faceLandmarks?.[0];
      let faceBox = null;
      if (landmarks?.length) {
        sample.face_visible = true;
        noFaceSince = null;
        let left = 1, right = 0, top = 1, bottom = 0;
        for (const point of landmarks) {
          if (point.x < left) left = point.x;
          if (point.x > right) right = point.x;
          if (point.y < top) top = point.y;
          if (point.y > bottom) bottom = point.y;
        }
        faceBox = { left, right, top, bottom };
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2;
        const faceHeight = bottom - top;
        sample.distance = faceHeight < 0.16 ? "too far" : faceHeight > 0.62 ? "too close" : "good";
        sample.centred = centerX >= 0.3 && centerX <= 0.7 && centerY >= 0.2 && centerY <= 0.8;
        sample.framing_ok = sample.centred && sample.distance === "good";

        // Head pose from the facial transformation matrix (column-major 4x4).
        const matrix = faceResult.facialTransformationMatrixes?.[0]?.data;
        if (matrix && matrix.length >= 16) {
          const r00 = matrix[0], r10 = matrix[1], r20 = matrix[2], r21 = matrix[6], r22 = matrix[10];
          const sy = Math.sqrt(r00 * r00 + r10 * r10);
          sample.pitch = deg(Math.atan2(r21, r22));
          sample.yaw = deg(Math.atan2(-r20, sy));
          sample.tilt = deg(Math.atan2(r10, r00));
          // Fold pitch so a face looking straight ahead reads near 0 whichever way the model is oriented.
          if (sample.pitch > 90) sample.pitch -= 180;
          if (sample.pitch < -90) sample.pitch += 180;
          sample.facing_camera = Math.abs(sample.yaw) <= 22 && Math.abs(sample.pitch) <= 25;
        } else {
          const nose = landmarks[1], leftEye = landmarks[33], rightEye = landmarks[263];
          if (nose && leftEye && rightEye) {
            const eyeMid = (leftEye.x + rightEye.x) / 2;
            const offset = (nose.x - eyeMid) / Math.max(0.01, Math.abs(rightEye.x - leftEye.x));
            sample.facing_camera = Math.abs(offset) < 0.2;
          }
        }

        // Head steadiness: nose movement between samples, in face-widths.
        const faceWidth = Math.max(0.01, right - left);
        const noseTip = landmarks[1];
        if (noseTip) {
          if (prevNose) sample.head_motion = Math.hypot(noseTip.x - prevNose.x, noseTip.y - prevNose.y) / faceWidth;
          prevNose = { x: noseTip.x, y: noseTip.y };
        }

        // Blendshapes: gaze, blinks, mouth/smile/brow movement.
        const categories = faceResult.faceBlendshapes?.[0]?.categories || [];
        const score = name => categories.find(item => item.categoryName === name)?.score ?? 0;
        if (categories.length) {
          const horizontal = ((score("eyeLookOutLeft") - score("eyeLookInLeft")) - (score("eyeLookOutRight") - score("eyeLookInRight"))) / 2;
          const vertical = ((score("eyeLookUpLeft") + score("eyeLookUpRight")) - (score("eyeLookDownLeft") + score("eyeLookDownRight"))) / 2;
          sample.gaze_screen = Math.abs(horizontal) < 0.25 && Math.abs(vertical) < 0.4 && sample.facing_camera !== false;
          const eyesClosed = (score("eyeBlinkLeft") + score("eyeBlinkRight")) / 2 > 0.55;
          sample.blink = eyesClosed && !eyesWereClosed;
          eyesWereClosed = eyesClosed;
          const cues = [];
          if (score("jawOpen") > 0.18) cues.push("visible mouth movement");
          if (Math.max(score("mouthSmileLeft"), score("mouthSmileRight")) > 0.35) cues.push("smile-related facial movement");
          if (Math.max(score("browInnerUp"), score("browOuterUpLeft"), score("browOuterUpRight")) > 0.35) cues.push("visible brow movement");
          sample.expression_cues = cues;
        }
      } else {
        prevNose = null;
        noFaceSince = noFaceSince ?? now;
      }

      // ---- pose (every other tick): shoulders, head height, centring.
      // Only shoulders are required, so a laptop webcam that sees head and shoulders works.
      if (models.pose && tickCount % 2 === 0) {
        const poseResult = runDetection(models.pose, video, now);
        const points = poseResult?.landmarks?.[0];
        lastPose = null;
        if (points?.length > 12) {
          const ls = points[11], rs = points[12], nose = points[0];
          const seen = point => point && (point.visibility ?? 1) > 0.5;
          if (seen(ls) && seen(rs)) {
            const aspect = video.videoWidth / video.videoHeight;
            const dx = Math.abs(ls.x - rs.x) * aspect;
            const dy = Math.abs(ls.y - rs.y);
            const shoulderTilt = deg(Math.atan2(dy, Math.max(0.001, dx)));
            const shoulderMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
            const shoulderWidth = Math.max(0.001, dx);
            const headOffset = nose ? ((nose.x - shoulderMid.x) * aspect) / shoulderWidth : 0;
            const headHeight = nose ? (shoulderMid.y - nose.y) / shoulderWidth : 1;
            let label = "upright / centred";
            if (shoulderTilt > 7) label = "shoulders uneven";
            else if (Math.abs(headOffset) > 0.4 || shoulderMid.x < 0.25 || shoulderMid.x > 0.75) label = "leaning or off-centre";
            else if (headHeight < 0.35) label = "head lowered / slouching";
            lastPose = { label, ok: label === "upright / centred", shoulder_tilt: shoulderTilt };
          }
        }
      }
      if (lastPose) { sample.posture = lastPose.label; sample.posture_ok = lastPose.ok; sample.shoulder_tilt = lastPose.shoulder_tilt; }

      // ---- hands (every other tick, offset from pose)
      if (models.hand && tickCount % 2 === 1) {
        const handResult = runDetection(models.hand, video, now);
        const hands = handResult?.landmarks || [];
        const wrists = hands.map(hand => hand[0]).filter(Boolean);
        let motion = 0;
        if (prevWrists && wrists.length) {
          motion = Math.max(...wrists.map(wrist => Math.min(...prevWrists.map(p => Math.hypot(wrist.x - p.x, wrist.y - p.y)))));
          if (!Number.isFinite(motion)) motion = 0;
        }
        prevWrists = wrists.length ? wrists : null;
        lastHands = { visible: hands.length > 0, motion };
      }
      if (models.hand) { sample.hands_visible = lastHands.visible; sample.hand_moving = lastHands.visible && lastHands.motion > 0.035; }

      // ---- lighting
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const luma = index => (pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722) / 255;
      let total = 0, totalSq = 0, count = 0, leftTotal = 0, leftCount = 0, rightTotal = 0, rightCount = 0;
      for (let y = 0; y < canvas.height; y += 2) {
        for (let x = 0; x < canvas.width; x += 2) {
          const value = luma((y * canvas.width + x) * 4);
          total += value; totalSq += value * value; count += 1;
          if (x < canvas.width / 2) { leftTotal += value; leftCount += 1; } else { rightTotal += value; rightCount += 1; }
        }
      }
      sample.brightness = total / count;
      sample.contrast = Math.sqrt(Math.max(0, totalSq / count - sample.brightness ** 2));
      sample.light_balance = Math.abs(leftTotal / leftCount - rightTotal / rightCount);
      if (faceBox) {
        let faceTotal = 0, faceCount = 0;
        const x0 = Math.max(0, Math.floor(faceBox.left * canvas.width)), x1 = Math.min(canvas.width - 1, Math.ceil(faceBox.right * canvas.width));
        const y0 = Math.max(0, Math.floor(faceBox.top * canvas.height)), y1 = Math.min(canvas.height - 1, Math.ceil(faceBox.bottom * canvas.height));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { faceTotal += luma((y * canvas.width + x) * 4); faceCount += 1; }
        if (faceCount) sample.face_brightness = faceTotal / faceCount;
      }

      samples.push(sample);
      if (samples.length > MAX_SAMPLES) samples.shift();
      onMetrics(summariseSamples(samples, modelStatus()));

      // ---- diagnostics: tell the user why nothing is showing
      if (now - lastDiagnostic > 2000) {
        lastDiagnostic = now;
        if (models.face.failures >= 3 || !models.face.task) {
          onStatus({ stage: "error", message: `Face model is failing (${models.face.lastError?.message || "unknown error"}). Retrying on CPU…`, models: modelStatus() });
        } else if (noFaceSince && now - noFaceSince > 4000) {
          onStatus({ stage: "no-face", message: "No face detected. Sit in front of the camera with your face and shoulders visible.", models: modelStatus() });
        } else {
          onStatus({ stage: "ready", message: `Visual analysis running · ${samples.length} samples`, models: modelStatus() });
        }
      }
    } catch (error) {
      if (performance.now() - lastDiagnostic > 2000) {
        lastDiagnostic = performance.now();
        console.warn("HirePilot visual analysis frame error:", error);
        onStatus({ stage: "error", message: `Frame analysis error: ${error.message}`, models: modelStatus() });
      }
    } finally {
      busy = false;
    }
  };

  const timer = window.setInterval(tick, TICK_MS);
  return {
    getSummary: () => summariseSamples(samples, modelStatus()),
    // Start a fresh measurement window (called for each new answer).
    reset: () => { samples = []; eyesWereClosed = false; prevNose = null; prevWrists = null; },
    stop: () => {
      stopped = true;
      clearInterval(timer);
      for (const handle of [models.face, models.pose, models.hand]) { try { handle?.task?.close(); } catch { /* closed */ } }
    },
  };
}

// ------------------------------------------------------------------- summary

export function emptyVisualSummary(modelStatus = {}) {
  return {
    samples: 0, available: false, duration_seconds: 0,
    face_visible_ratio: null, framing_quality: "unavailable", framing_good_ratio: null, distance: "unavailable",
    head_orientation: "unavailable", head_yaw_avg_abs: null, head_pitch_avg_abs: null, head_tilt_avg_abs: null,
    gaze: "unavailable", gaze_toward_screen_ratio: null,
    blink_rate_per_minute: null, head_movement: "unavailable", head_motion_index: null,
    posture_observation: "unavailable", posture_good_ratio: null, shoulder_tilt_avg_deg: null,
    hands_visible_ratio: null, gesture_activity: "unavailable",
    lighting: "unavailable", lighting_brightness: null, lighting_balance: null,
    observable_facial_movement: [], checks: [], observations: [], model_status: modelStatus,
  };
}

export function summariseSamples(samples, modelStatus = {}) {
  if (!samples.length) return emptyVisualSummary(modelStatus);
  const n = samples.length;
  const faces = samples.filter(s => s.face_visible);
  const duration = (samples[n - 1].t - samples[0].t) / 1000;

  const faceRatio = faces.length / n;
  const framingGood = faces.length ? ratioOf(faces, s => s.framing_ok) : null;
  const distances = faces.map(s => s.distance).filter(Boolean);
  const tooClose = ratioOf(distances, d => d === "too close") ?? 0;
  const tooFar = ratioOf(distances, d => d === "too far") ?? 0;
  const distance = !distances.length ? "unavailable" : tooClose >= 0.4 ? "too close" : tooFar >= 0.4 ? "too far" : "good";
  const framingQuality = !faces.length ? "adjust position" : framingGood >= 0.72 ? "good" : "adjust position";

  const poseSamples = faces.filter(s => s.facing_camera !== undefined);
  const forward = poseSamples.length ? ratioOf(poseSamples, s => s.facing_camera) : null;
  const head = forward === null ? "unavailable" : forward >= 0.7 ? "mostly forward" : "turned at times";
  const absMean = key => round(mean(faces.filter(s => typeof s[key] === "number").map(s => Math.abs(s[key]))), 1);

  const gazeSamples = faces.filter(s => s.gaze_screen !== undefined);
  const gazeRatio = gazeSamples.length ? ratioOf(gazeSamples, s => s.gaze_screen) : null;
  const gaze = gazeRatio === null ? "unavailable" : gazeRatio >= 0.65 ? "mostly toward screen" : "often away from screen";

  const blinks = samples.filter(s => s.blink).length;
  const blinkRate = duration >= 10 && gazeSamples.length ? round(blinks / duration * 60, 0) : null;

  const motions = faces.filter(s => typeof s.head_motion === "number").map(s => s.head_motion);
  const motionIndex = motions.length >= 4 ? mean(motions) : null;
  const headMovement = motionIndex === null ? "unavailable" : motionIndex < 0.018 ? "steady" : motionIndex < 0.04 ? "moderate movement" : "frequent movement";

  const postureSamples = samples.filter(s => s.posture !== undefined);
  const postureGood = postureSamples.length ? ratioOf(postureSamples, s => s.posture_ok) : null;
  let posture = "unavailable";
  if (postureSamples.length) {
    if (postureGood >= 0.65) posture = "mostly upright / centred";
    else {
      const counts = {};
      postureSamples.filter(s => !s.posture_ok).forEach(s => { counts[s.posture] = (counts[s.posture] || 0) + 1; });
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
      posture = top ? `review alignment: ${top}` : "review shoulder and torso alignment";
    }
  }
  const shoulderTilt = round(mean(postureSamples.filter(s => typeof s.shoulder_tilt === "number").map(s => s.shoulder_tilt)), 1);

  const handSamples = samples.filter(s => s.hands_visible !== undefined);
  const handsVisible = handSamples.length ? ratioOf(handSamples, s => s.hands_visible) : null;
  const movingRatio = handSamples.length ? ratioOf(handSamples, s => s.hand_moving) : null;
  const gestures = handsVisible === null ? "unavailable"
    : handsVisible < 0.08 ? "hands rarely in view"
    : movingRatio >= 0.25 ? "frequent hand movement"
    : movingRatio >= 0.07 ? "some hand gestures"
    : "hands visible, mostly still";

  const brightness = mean(samples.map(s => s.brightness));
  const balance = mean(samples.map(s => s.light_balance));
  const faceBrightness = mean(faces.filter(s => typeof s.face_brightness === "number").map(s => s.face_brightness));
  const lightNotes = [];
  let lighting = "moderate / good";
  if (brightness < 0.22) { lighting = "low"; lightNotes.push("The image is dark; face a window or lamp."); }
  else if (brightness > 0.85) { lighting = "bright"; lightNotes.push("The image is very bright and may wash out detail."); }
  else if (balance > 0.22) { lighting = "uneven"; lightNotes.push("One side of the frame is much brighter than the other."); }
  else if (faceBrightness !== null && faceBrightness < brightness * 0.7 && brightness > 0.4) { lighting = "face dim against background"; lightNotes.push("Your face is darker than the background; avoid sitting with a window behind you."); }

  const cues = [...new Set(samples.flatMap(s => s.expression_cues || []))];

  const checks = [];
  const addCheck = (label, status, detail) => checks.push({ label, status, detail });
  addCheck("Face in view", faceRatio >= 0.85 ? "good" : "adjust", `Face visible in ${Math.round(faceRatio * 100)}% of samples.`);
  addCheck("Framing and distance", faces.length ? (framingQuality === "good" && distance === "good" ? "good" : "adjust") : "adjust",
    faces.length ? `Framing ${framingQuality}; distance ${distance}.` : "No face was detected.");
  addCheck("Head position", head === "unavailable" ? "unavailable" : head === "mostly forward" ? "good" : "adjust",
    head === "unavailable" ? "Head pose unavailable." : `Head ${head}${absMean("yaw") !== null ? ` (average turn ${absMean("yaw")}°)` : ""}.`);
  addCheck("Gaze toward screen", gaze === "unavailable" ? "unavailable" : gaze === "mostly toward screen" ? "good" : "adjust",
    gazeRatio === null ? "Eye direction unavailable." : `Eyes pointed toward the screen in ${Math.round(gazeRatio * 100)}% of samples.`);
  addCheck("Head steadiness", headMovement === "unavailable" ? "unavailable" : headMovement === "frequent movement" ? "adjust" : "good",
    headMovement === "unavailable" ? "Not enough data." : `Head movement: ${headMovement}.`);
  addCheck("Posture", postureGood === null ? "unavailable" : postureGood >= 0.65 ? "good" : "adjust",
    postureGood === null ? "Shoulders were not visible; move back so your shoulders are in frame." : `Posture: ${posture}.`);
  addCheck("Lighting", lighting === "moderate / good" ? "good" : "adjust", lightNotes[0] || "Lighting looks adequate.");
  addCheck("Hand gestures", handsVisible === null ? "unavailable" : "info", handsVisible === null ? "Hand tracking unavailable." : `Gestures: ${gestures}.`);

  const observations = [`Face visible in ${Math.round(faceRatio * 100)}% of ${n} samples.`];
  if (faces.length) observations.push(`Framing: ${framingQuality}; camera distance: ${distance}.`);
  if (head !== "unavailable") observations.push(`Head orientation: ${head}.`);
  if (gaze !== "unavailable") observations.push(`Gaze: ${gaze} (${Math.round(gazeRatio * 100)}%).`);
  if (blinkRate !== null) observations.push(`Blink rate: about ${blinkRate} per minute.`);
  if (headMovement !== "unavailable") observations.push(`Head movement: ${headMovement}.`);
  if (posture !== "unavailable") observations.push(`Posture: ${posture}.`);
  if (gestures !== "unavailable") observations.push(`Hands: ${gestures}.`);
  observations.push(`Lighting: ${lighting}.`);
  if (lightNotes.length && lighting !== "moderate / good") observations.push(lightNotes[0]);
  if (cues.length) observations.push(`Observable facial movement: ${cues.join(", ")}.`);

  return {
    samples: n, available: faces.length > 0, duration_seconds: round(duration, 1),
    face_visible_ratio: round(faceRatio), framing_quality: framingQuality, framing_good_ratio: round(framingGood), distance,
    head_orientation: head, head_yaw_avg_abs: absMean("yaw"), head_pitch_avg_abs: absMean("pitch"), head_tilt_avg_abs: absMean("tilt"),
    gaze, gaze_toward_screen_ratio: round(gazeRatio),
    blink_rate_per_minute: blinkRate, head_movement: headMovement, head_motion_index: round(motionIndex, 3),
    posture_observation: posture, posture_good_ratio: round(postureGood), shoulder_tilt_avg_deg: shoulderTilt,
    hands_visible_ratio: round(handsVisible), gesture_activity: gestures,
    lighting, lighting_brightness: round(brightness), lighting_balance: round(balance),
    observable_facial_movement: cues, checks, observations, model_status: modelStatus,
  };
}

// ------------------------------------------------------------ basic fallback
// Used when the MediaPipe models cannot be loaded (blocked network, no assets).
// Needs no downloads: it measures lighting and movement in the camera frame only.
// Face, gaze, posture and hand analysis are NOT available in this mode, and it says so.

export function summariseBasic(samples, modelStatus = {}) {
  if (!samples.length) return { ...emptyVisualSummary(modelStatus), basic_mode: true };
  const n = samples.length;
  const duration = (samples[n - 1].t - samples[0].t) / 1000;
  const brightness = mean(samples.map(s => s.brightness));
  const balance = mean(samples.map(s => s.light_balance));
  const motions = samples.filter(s => typeof s.motion === "number").map(s => s.motion);
  const motionIndex = motions.length >= 4 ? mean(motions) : null;
  const frameMotion = motionIndex === null ? "unavailable" : motionIndex < 0.012 ? "mostly still" : motionIndex < 0.04 ? "some movement" : "a lot of movement";

  let lighting = "moderate / good";
  let lightNote = "Lighting looks adequate.";
  if (brightness < 0.22) { lighting = "low"; lightNote = "The image is dark; face a window or lamp."; }
  else if (brightness > 0.85) { lighting = "bright"; lightNote = "The image is very bright and may wash out detail."; }
  else if (balance > 0.22) { lighting = "uneven"; lightNote = "One side of the frame is much brighter than the other."; }

  const reason = "Face, gaze and posture models could not load, so only basic camera checks ran.";
  const checks = [
    { label: "Lighting", status: lighting === "moderate / good" ? "good" : "adjust", detail: lightNote },
    { label: "Movement in frame", status: "info", detail: frameMotion === "unavailable" ? "Not enough data." : `Movement in the camera frame: ${frameMotion}.` },
    { label: "Face, gaze, posture, hands", status: "unavailable", detail: reason },
  ];
  const observations = [`Lighting: ${lighting}.`];
  if (frameMotion !== "unavailable") observations.push(`Movement in frame: ${frameMotion}.`);
  observations.push(reason);

  return {
    ...emptyVisualSummary(modelStatus),
    samples: n, available: true, basic_mode: true, duration_seconds: round(duration, 1),
    lighting, lighting_brightness: round(brightness), lighting_balance: round(balance),
    frame_motion: frameMotion, frame_motion_index: round(motionIndex, 3),
    checks, observations, unavailable_reason: reason,
  };
}

export function createBasicVisualAnalyzer(video, onMetrics = () => {}) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 36;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let samples = [];
  let previous = null;
  let stopped = false;

  const tick = () => {
    if (stopped || video.readyState < 2 || !video.videoWidth) return;
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const gray = new Float32Array(canvas.width * canvas.height);
      let total = 0, totalSq = 0, left = 0, right = 0, diff = 0;
      for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
        const value = (pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722) / 255;
        gray[p] = value;
        total += value; totalSq += value * value;
        if ((p % canvas.width) < canvas.width / 2) left += value; else right += value;
        if (previous) diff += Math.abs(value - previous[p]);
      }
      const count = gray.length;
      const brightness = total / count;
      samples.push({
        t: performance.now(), basic: true, brightness,
        contrast: Math.sqrt(Math.max(0, totalSq / count - brightness ** 2)),
        light_balance: Math.abs(left - right) / (count / 2),
        motion: previous ? diff / count : undefined,
      });
      previous = gray;
      if (samples.length > MAX_SAMPLES) samples.shift();
      onMetrics(summariseBasic(samples, { mode: "basic" }));
    } catch { /* skip a bad frame */ }
  };
  const timer = window.setInterval(tick, 500);
  return {
    basic: true,
    getSummary: () => summariseBasic(samples, { mode: "basic" }),
    reset: () => { samples = []; previous = null; },
    stop: () => { stopped = true; clearInterval(timer); },
  };
}
