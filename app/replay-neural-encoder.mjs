/**
 * Browser inference for the trained Replay Lab self-supervised behaviour encoder.
 * Similarity is behavioural resemblance, never a calibrated skill score.
 */
const FEATURE_NAMES = [
  "x_norm", "y_norm", "coordinate_present", "interval_log",
  "dx_norm", "dy_norm", "speed_log",
  "left1", "right1", "left2", "right2", "smoke",
  "button_state_present", "mode_standard", "mode_mania"
];
const BUTTON_BITS = [1, 2, 4, 8, 16];
const LOG_1000 = Math.log1p(1000);
const LOG_10000 = Math.log1p(10000);

const finite = value => typeof value === "number" && Number.isFinite(value);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position), high = Math.ceil(position);
  return low === high ? sorted[low] : sorted[low] * (high - position) + sorted[high] * (position - low);
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function buildFeatureMatrix(frames, mode, maxFrames = 5000) {
  const normalizedMode = mode === 3 || mode === "mania" ? "mania"
    : mode === 0 || mode === "standard" ? "standard" : null;
  if (!normalizedMode) throw new Error("Unsupported replay mode.");
  if (!Array.isArray(frames) || !frames.length) throw new Error("Replay has no parsed frames.");

  const count = Math.min(frames.length, maxFrames);
  const indices = count === 1 ? [0] : Array.from({length: count}, (_, i) =>
    Math.floor(i * (frames.length - 1) / (count - 1))
  );
  const rows = [];
  let previous = null;

  for (const index of indices) {
    const frame = frames[index] || {};
    const intervalValue = finite(frame.interval) ? frame.interval : 0;
    const interval = Math.max(intervalValue, 0);
    const bitsetValue = normalizedMode === "mania" ? Number(frame.x) : Number(frame.keys);
    const buttonStatePresent = Number.isFinite(bitsetValue);
    const bitset = buttonStatePresent ? (Math.trunc(bitsetValue) >>> 0) : 0;
    const buttons = BUTTON_BITS.map(bit => Number(Boolean(bitset & bit)));

    const x = normalizedMode === "standard" && finite(frame.x) ? frame.x : null;
    const y = normalizedMode === "standard" && finite(frame.y) ? frame.y : null;
    const hasCoordinates = x !== null && y !== null && y !== -500;
    const xNorm = hasCoordinates ? x / 512 : 0;
    const yNorm = hasCoordinates ? y / 384 : 0;

    let dx = 0, dy = 0, speed = 0;
    if (hasCoordinates && previous) {
      const dt = Math.max(interval, 1) / 1000;
      dx = (x - previous.x) / 512;
      dy = (y - previous.y) / 384;
      speed = Math.log1p(Math.min(Math.hypot(dx, dy) / dt, 10000)) / LOG_10000;
    }
    previous = hasCoordinates ? {x, y} : null;

    rows.push([
      clamp(xNorm, -2, 2),
      clamp(yNorm, -2, 2),
      Number(hasCoordinates),
      Math.log1p(interval) / LOG_1000,
      clamp(dx, -2, 2),
      clamp(dy, -2, 2),
      speed,
      ...buttons,
      Number(buttonStatePresent),
      Number(normalizedMode === "standard"),
      Number(normalizedMode === "mania")
    ]);
  }
  return rows;
}

function validateArtifacts(model, index) {
  if (model?.model_type !== "self_supervised_reconstruction_encoder" ||
      model?.trained !== true || model?.skill_scorer !== false) {
    throw new Error("Unsupported or incorrectly labelled encoder artifact.");
  }
  if (JSON.stringify(model.feature_names) !== JSON.stringify(FEATURE_NAMES)) {
    throw new Error("Encoder feature schema mismatch.");
  }
  if (!model.normalization?.mean || !model.normalization?.scale ||
      !model.encoder_weights?.w1 || !model.encoder_weights?.w2 ||
      !model.encoder_weights?.b1 || !model.encoder_weights?.b2) {
    throw new Error("Encoder weights or normalization are incomplete.");
  }
  if (index?.model_type !== "unsupervised_replay_similarity" ||
      index?.skill_scorer !== false || !Array.isArray(index.entries)) {
    throw new Error("Unsupported replay reference index.");
  }
  if (index.parser_version !== model.parser_version ||
      index.encoder_model_version !== model.model_version) {
    throw new Error("Encoder and reference index versions do not match.");
  }
  const size = FEATURE_NAMES.length;
  const weights = model.encoder_weights;
  if (model.normalization.mean.length !== size ||
      model.normalization.scale.length !== size ||
      weights.w1.length !== size ||
      weights.w1.some(row => row.length !== weights.b1.length) ||
      weights.w2.length !== weights.b1.length ||
      weights.w2.some(row => row.length !== weights.b2.length) ||
      weights.b2.length === 0 ||
      model.normalization.scale.some(value => !finite(value) || value <= 0)) {
    throw new Error("Encoder tensor dimensions are invalid.");
  }
}

export function encodeSequence(matrix, model) {
  const norm = model.normalization;
  const weights = model.encoder_weights;
  const latentRows = matrix.map(row => {
    const normalized = row.map((value, i) => (value - norm.mean[i]) / norm.scale[i]);
    const hidden = weights.b1.map((bias, j) => Math.tanh(
      bias + normalized.reduce((sum, value, i) => sum + value * weights.w1[i][j], 0)
    ));
    return weights.b2.map((bias, j) => Math.tanh(
      bias + hidden.reduce((sum, value, i) => sum + value * weights.w2[i][j], 0)
    ));
  });
  const latentSize = weights.b2.length;
  const embedding = [];
  for (let j = 0; j < latentSize; j++) {
    const values = latentRows.map(row => row[j]);
    const avg = mean(values);
    const variance = mean(values.map(value => (value - avg) ** 2));
    embedding.push(avg, Math.sqrt(variance));
  }
  const normValue = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(normValue) || normValue < 1e-10) {
    throw new Error("Encoder produced an invalid embedding.");
  }
  return embedding.map(value => value / normValue);
}

function replayMetrics(frames, matrix) {
  const intervals = frames.map(frame => frame.interval).filter(value => finite(value) && value > 0);
  const coordinate = matrix.map(row => row[2] > 0);
  const active = matrix.map(row => row.slice(7, 12).some(value => value > 0));
  const coordinateRows = matrix.filter(row => row[2] > 0);
  const steps = coordinateRows.map(row => Math.hypot(row[4], row[5]));
  const speeds = coordinateRows.map(row => row[6]);
  return {
    frame_count: frames.length,
    sampled_frame_count: matrix.length,
    coordinate_coverage: Number(mean(coordinate.map(Number).map(Number).map(Number)).toFixed(4)),
    button_state_coverage: Number(mean(matrix.map(row => row[12])).toFixed(4)),
    active_button_frame_ratio: Number(mean(active.map(Number)).toFixed(4)),
    median_frame_interval_ms: median(intervals),
    frame_interval_iqr_ms: intervals.length
      ? Number((percentile(intervals, .75) - percentile(intervals, .25)).toFixed(3)) : null,
    cursor_path_step_mean_norm: steps.length ? Number(mean(steps).toFixed(6)) : null,
    cursor_speed_p95_norm: speeds.length ? Number(percentile(speeds, .95).toFixed(6)) : null
  };
}

export function analyzeReplay(frames, mode, model, index, limit = 5) {
  validateArtifacts(model, index);
  const normalizedMode = mode === 3 || mode === "mania" ? "mania" : "standard";
  const matrix = buildFeatureMatrix(frames, normalizedMode);
  const embedding = encodeSequence(matrix, model);
  const candidates = [];
  for (const entry of index.entries) {
    if (entry.mode !== normalizedMode || !Array.isArray(entry.embedding) ||
        entry.embedding.length !== embedding.length) continue;
    const otherNorm = Math.sqrt(entry.embedding.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(otherNorm) || otherNorm < 1e-10) continue;
    const dot = embedding.reduce((sum, value, i) => sum + value * entry.embedding[i], 0);
    candidates.push({
      replay_id: entry.replay_id,
      similarity: Number((dot / otherNorm).toFixed(5)),
      metrics: entry.metrics || {},
      score_result: entry.score_result || null
    });
  }
  candidates.sort((a, b) => b.similarity - a.similarity);
  const score = entry => {
    if (!entry) return null;
    const accuracy = finite(entry.accuracy_percent) ? entry.accuracy_percent
      : finite(entry.accuracy) ? entry.accuracy * 100 : null;
    return {
      rank: typeof entry.rank === "string" ? entry.rank : null,
      accuracy_percent: accuracy === null ? null : Number(accuracy.toFixed(2)),
      max_combo: finite(entry.max_combo) ? entry.max_combo : null
    };
  };
  return {
    model_version: model.model_version,
    parser_version: model.parser_version,
    mode: normalizedMode,
    reference_count: index.entries.filter(entry => entry.mode === normalizedMode).length,
    metrics: replayMetrics(frames, matrix),
    nearest_replays: candidates.slice(0, Math.max(1, limit)).map(item => ({
      ...item, recorded_result: score(item.score_result)
    })),
    interpretation: "Neural similarity is behavioural resemblance, not player skill, rank, aim accuracy, or timing accuracy."
  };
}

let cachedArtifacts = null;
async function loadArtifacts() {
  if (!cachedArtifacts) {
    cachedArtifacts = Promise.all([
      fetch("./models/replay-encoder.json", {cache:"no-store"}).then(response => {
        if (!response.ok) throw new Error("Не удалось загрузить файл весов модели (HTTP " + response.status + ").");
        return response.json();
      }),
      fetch("./models/replay-reference-index.json", {cache:"no-store"}).then(response => {
        if (!response.ok) throw new Error("Не удалось загрузить индекс реплеев (HTTP " + response.status + ").");
        return response.json();
      })
    ]).then(([model, index]) => {
      validateArtifacts(model, index);
      return {model, index};
    }).catch(error => {
      cachedArtifacts = null;
      throw error;
    });
  }
  return cachedArtifacts;
}

export async function analyze(frames, mode, limit = 5) {
  const {model, index} = await loadArtifacts();
  return analyzeReplay(frames, mode, model, index, limit);
}

export function render(host, result) {
  if (!host || typeof document === "undefined") return;
  host.replaceChildren();
  const add = (tag, text, className = "") => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    host.append(node);
    return node;
  };
  add("p", "Модель " + result.model_version + " · " + result.reference_count +
    " эталонных реплеев этого режима · " + result.metrics.sampled_frame_count +
    " кадров обработано.");
  add("p", "Это сравнение поведения, а не оценка скилла. Исходный .osr остаётся на устройстве.");
  const metrics = document.createElement("div");
  metrics.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:8px;margin:10px 0";
  const cards = [
    ["Кадры", result.metrics.frame_count],
    ["Координаты", Math.round(result.metrics.coordinate_coverage * 100) + "%"],
    ["Активные нажатия", Math.round(result.metrics.active_button_frame_ratio * 100) + "%"],
    ["Медиана интервала", result.metrics.median_frame_interval_ms == null ? "—" : Math.round(result.metrics.median_frame_interval_ms) + " ms"]
  ];
  for (const [label, value] of cards) {
    const card = document.createElement("div");
    card.style.cssText = "padding:10px;border:1px solid #2d4054;border-radius:9px;background:#0b111b";
    const small = document.createElement("small");
    small.style.cssText = "display:block;color:#91a3b9;font-size:11px";
    small.textContent = label;
    const strong = document.createElement("strong");
    strong.style.cssText = "display:block;font-size:19px;color:#a9e7ff";
    strong.textContent = String(value);
    card.append(small, strong);
    metrics.append(card);
  }
  host.append(metrics);
  add("h3", "Похожие реплеи");
  if (!result.nearest_replays.length) {
    add("p", "В индексе пока нет реплеев этого режима.");
    return;
  }
  const list = document.createElement("ol");
  list.style.cssText = "margin:6px 0;padding-left:22px";
  for (const item of result.nearest_replays) {
    const li = document.createElement("li");
    li.style.cssText = "margin:8px 0;color:#dcecff";
    const similarity = (item.similarity * 100).toFixed(1) + "%";
    const recorded = item.recorded_result;
    const details = recorded
      ? " · " + (recorded.rank || "без ранга") +
        (recorded.accuracy_percent == null ? "" : " · acc " + recorded.accuracy_percent + "%") +
        (recorded.max_combo == null ? "" : " · combo " + recorded.max_combo)
      : "";
    li.textContent = item.replay_id + " — " + similarity + details;
    list.append(li);
  }
  host.append(list);
}
