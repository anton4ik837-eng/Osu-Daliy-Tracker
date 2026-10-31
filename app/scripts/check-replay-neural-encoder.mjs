import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeReplay, buildFeatureMatrix, encodeSequence } from "../replay-neural-encoder.mjs";

const model = JSON.parse(await readFile(new URL("../www/models/replay-encoder.json", import.meta.url), "utf8"));
const index = JSON.parse(await readFile(new URL("../www/models/replay-reference-index.json", import.meta.url), "utf8"));
assert.equal(model.model_type, "self_supervised_reconstruction_encoder");
assert.equal(model.trained, true);
assert.equal(model.skill_scorer, false);
assert.equal(index.model_type, "unsupervised_replay_similarity");
assert.equal(index.entries.length, 37);

const standardFrames = Array.from({length:48}, (_, i) => ({
  time: i * 100,
  interval: 100,
  x: (i * 29) % 512,
  y: (i * 17) % 384,
  keys: i % 2 ? 5 : 0
}));
const standardMatrix = buildFeatureMatrix(standardFrames, "standard");
assert.equal(standardMatrix.length, 48);
assert.equal(standardMatrix[1][7], 1);
assert.equal(standardMatrix[1][9], 1);
assert.equal(standardMatrix[1][2], 1);
const standardEmbedding = encodeSequence(standardMatrix, model);
assert.equal(standardEmbedding.length, 16);
assert.ok(Math.abs(Math.hypot(...standardEmbedding) - 1) < 1e-8);
const standardResult = analyzeReplay(standardFrames, "standard", model, index);
assert.equal(standardResult.mode, "standard");
assert.equal(standardResult.reference_count, 12);
assert.ok(standardResult.nearest_replays.length > 0);
assert.ok(standardResult.nearest_replays.every(item => item.replay_id.startsWith("std_")));

const maniaFrames = Array.from({length:48}, (_, i) => ({
  time: i * 125,
  interval: 125,
  x: i % 3 ? 3 : 12,
  y: -500,
  keys: 0
}));
const maniaMatrix = buildFeatureMatrix(maniaFrames, "mania");
assert.equal(maniaMatrix[1][7], 1);
assert.equal(maniaMatrix[1][8], 1);
assert.equal(maniaMatrix[1][2], 0);
const maniaResult = analyzeReplay(maniaFrames, "mania", model, index);
assert.equal(maniaResult.mode, "mania");
assert.equal(maniaResult.reference_count, 25);
assert.ok(maniaResult.nearest_replays.length > 0);
assert.ok(maniaResult.nearest_replays.every(item => item.replay_id.startsWith("mania_")));

console.log("Replay neural encoder tests passed: model artifact, 37-entry index, Standard and Mania inference.");
