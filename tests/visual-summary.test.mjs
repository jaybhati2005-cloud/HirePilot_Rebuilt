// Run with: node tests/visual-summary.test.mjs
import assert from "node:assert/strict";
import { summariseSamples, emptyVisualSummary } from "../frontend/live-analysis.js";

const base = (i, extra = {}) => ({
  t: i * 250, face_visible: true, distance: "good", centred: true, framing_ok: true,
  yaw: 4, pitch: 3, tilt: 1, facing_camera: true, gaze_screen: true, blink: false,
  head_motion: 0.008, posture: "upright / centred", posture_ok: true, shoulder_tilt: 2,
  hands_visible: false, hand_moving: false, brightness: 0.55, contrast: 0.2, light_balance: 0.05,
  face_brightness: 0.55, expression_cues: [], ...extra,
});

// Empty input never throws and reports "unavailable".
const empty = summariseSamples([]);
assert.equal(empty.samples, 0);
assert.equal(empty.framing_quality, "unavailable");
assert.deepEqual(empty, emptyVisualSummary({}));

// A well-set-up 20 second answer.
let samples = Array.from({ length: 80 }, (_, i) => base(i, { blink: i % 14 === 0 }));
let s = summariseSamples(samples, { face: "ready" });
assert.equal(s.face_visible_ratio, 1);
assert.equal(s.framing_quality, "good");
assert.equal(s.distance, "good");
assert.equal(s.head_orientation, "mostly forward");
assert.equal(s.gaze, "mostly toward screen");
assert.equal(s.head_movement, "steady");
assert.equal(s.posture_observation, "mostly upright / centred");
assert.equal(s.lighting, "moderate / good");
assert.ok(s.blink_rate_per_minute > 10 && s.blink_rate_per_minute < 30, `blink ${s.blink_rate_per_minute}`);
assert.ok(s.checks.every(c => c.status !== "adjust"), JSON.stringify(s.checks));
assert.ok(s.observations.length >= 5);

// Problems are detected and described.
samples = Array.from({ length: 60 }, (_, i) => base(i, {
  distance: "too close", framing_ok: false, facing_camera: false, yaw: 35, gaze_screen: false,
  head_motion: 0.07, posture: "head lowered / slouching", posture_ok: false,
  brightness: 0.12, face_brightness: 0.1, hands_visible: true, hand_moving: i % 2 === 0,
}));
s = summariseSamples(samples);
assert.equal(s.framing_quality, "adjust position");
assert.equal(s.distance, "too close");
assert.equal(s.head_orientation, "turned at times");
assert.equal(s.gaze, "often away from screen");
assert.equal(s.head_movement, "frequent movement");
assert.match(s.posture_observation, /head lowered/);
assert.equal(s.lighting, "low");
assert.equal(s.gesture_activity, "frequent hand movement");
assert.ok(s.checks.filter(c => c.status === "adjust").length >= 5);

// No face at all: honest "adjust" result, no crashes, no invented metrics.
samples = Array.from({ length: 20 }, (_, i) => ({ t: i * 250, face_visible: false, brightness: 0.5, contrast: 0.1, light_balance: 0.02 }));
s = summariseSamples(samples);
assert.equal(s.available, false);
assert.equal(s.face_visible_ratio, 0);
assert.equal(s.gaze, "unavailable");
assert.equal(s.head_orientation, "unavailable");
assert.equal(s.blink_rate_per_minute, null);

// Shoulders never visible -> posture unavailable with a helpful hint.
samples = Array.from({ length: 30 }, (_, i) => base(i, { posture: undefined, posture_ok: undefined, shoulder_tilt: undefined }));
s = summariseSamples(samples);
assert.equal(s.posture_observation, "unavailable");
assert.match(s.checks.find(c => c.label === "Posture").detail, /shoulders/i);

console.log("visual summary tests passed");

// ---- basic fallback mode (no models)
import { summariseBasic } from "../frontend/live-analysis.js";
const basicSamples = Array.from({ length: 40 }, (_, i) => ({ t: i * 500, basic: true, brightness: 0.5, contrast: 0.2, light_balance: 0.04, motion: i ? 0.006 : undefined }));
const basic = summariseBasic(basicSamples);
assert.equal(basic.basic_mode, true);
assert.equal(basic.available, true);
assert.equal(basic.lighting, "moderate / good");
assert.equal(basic.frame_motion, "mostly still");
assert.equal(basic.gaze, "unavailable");
assert.ok(basic.checks.some(c => c.label.startsWith("Face") && c.status === "unavailable"));
const dark = summariseBasic(basicSamples.map(x => ({ ...x, brightness: 0.1 })));
assert.equal(dark.lighting, "low");
assert.equal(summariseBasic([]).basic_mode, true);
console.log("basic fallback tests passed");
