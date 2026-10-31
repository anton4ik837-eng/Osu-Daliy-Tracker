/**
 * Replay Lab 2.2.0 Beta — experimental replay scoring model.
 *
 * This is a tiny deterministic MLP-shaped evaluator with hand-calibrated seed
 * weights. It is NOT trained: no labelled replay dataset exists yet.
 * Scores are diagnostic signals, not a player's global skill/rank.
 */
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const stddev = values => {
  if (!values.length) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map(value => (value - avg) ** 2)));
};
const sigmoid = value => 1 / (1 + Math.exp(-value));
const tanh = value => Math.tanh(value);
const fmt = value => Math.round(value);
const fmtTime = ms => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
};


const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};
export function extractTrainingFeatures(analysis) {
  const rows = Array.isArray(analysis?.rows) ? analysis.rows : [];
  const valid = rows.filter(row => !row.miss && Number.isFinite(row.offset));
  const offsets = valid.map(row => Number(row.offset));
  const absOffsets = offsets.map(Math.abs);
  const early = offsets.filter(value => value < 0).length;
  const late = offsets.filter(value => value > 0).length;
  const ordered = [...valid].sort((a, b) => a.time - b.time);
  const denseDeltas = [], streamRuns = [], burstRuns = [];
  let run = [];
  for (let i = 0; i < ordered.length; i++) {
    if (!run.length) { run = [ordered[i]]; continue; }
    const gap = ordered[i].time - run[run.length - 1].time;
    if (gap >= 75 && gap <= 250) run.push(ordered[i]);
    else {
      if (run.length >= 4) streamRuns.push(run);
      else if (run.length >= 2) burstRuns.push(run);
      run = [ordered[i]];
    }
    if (i > 0 && gap > 0 && gap <= 125)
      denseDeltas.push(ordered[i].offset - ordered[i - 1].offset);
  }
  if (run.length >= 4) streamRuns.push(run);
  else if (run.length >= 2) burstRuns.push(run);
  const streamRows = streamRuns.flat(), burstRows = burstRuns.flat();
  const denseJitter = denseDeltas.length ? Math.sqrt(mean(denseDeltas.map(value => value * value))) : null;
  const holds = rows.filter(row => /hold/i.test(String(row.type || '')));
  const releaseMisses = rows.filter(row => row.releaseMiss).length;
  const aimErrors = valid.map(row => row.aimErrorPx).filter(Number.isFinite);
  const totalPresses = Math.max(0, Number(analysis.totalPresses) || 0);
  const unmatched = Math.max(0, Number(analysis.unmatchedPresses) || 0);
  return {
    object_count: rows.length, matched_count: valid.length,
    miss_count: rows.filter(row => row.miss).length,
    median_abs_offset_ms: median(absOffsets),
    mean_offset_ms: offsets.length ? mean(offsets) : null,
    offset_stddev_ms: offsets.length ? stddev(offsets) : null,
    early_ratio: offsets.length ? early / offsets.length : null,
    late_ratio: offsets.length ? late / offsets.length : null,
    dense_pair_count: denseDeltas.length, dense_jitter_ms: denseJitter,
    unmatched_press_ratio: totalPresses ? unmatched / totalPresses : null,
    hold_count: holds.length,
    release_miss_ratio: holds.length ? releaseMisses / holds.length : null,
    stream_count: streamRuns.length, stream_note_count: streamRows.length,
    stream_offset_stddev_ms: streamRows.length ? stddev(streamRows.map(row => row.offset)) : null,
    burst_count: burstRuns.length,
    burst_offset_stddev_ms: burstRows.length ? stddev(burstRows.map(row => row.offset)) : null,
    mean_aim_error_px: aimErrors.length ? mean(aimErrors) : null,
    p95_aim_error_px: percentile(aimErrors, 0.95),
    high_density_hit_rate: null, low_density_hit_rate: null,
    approach_rate: null, overall_difficulty: null, circle_size: null,
    bpm_estimate: Number.isFinite(analysis.bpm) ? analysis.bpm : null,
  };
}


let trainedArtifact = null;
const TRAINED_TARGET_LABELS = {
  timing_level: 'Тайминг', rhythm_stability: 'Ритмическая стабильность',
  aim_control: 'Контроль aim', reading_consistency: 'Чтение карты',
  stream_stability: 'Стабильность стримов', burst_control: 'Контроль бурстов',
};
export function evaluateTrainedArtifact(features, artifact, mode = 'standard') {
  if (!artifact?.trained || !Array.isArray(artifact.feature_names) || !Array.isArray(artifact.targets)) return null;
  const norm = artifact.normalization, weights = artifact.weights;
  if (!norm?.mean || !norm?.scale || !weights?.w1 || !weights?.w2 || !weights?.b1 || !weights?.b2) return null;
  const names = artifact.feature_names, hiddenSize = weights.b1.length, outputSize = artifact.targets.length;
  if (norm.mean.length !== names.length || norm.scale.length !== names.length ||
      weights.w1.length !== names.length || weights.w2.length !== hiddenSize ||
      weights.b2.length !== outputSize) return null;
  const input = names.map((name, index) => {
    let raw = name === '__mode_standard__' ? Number(mode === 'standard')
      : name === '__mode_mania__' ? Number(mode === 'mania')
      : features[name] ?? norm.median_imputation?.[name] ?? 0;
    raw = Number(raw);
    if (!Number.isFinite(raw)) raw = Number(norm.median_imputation?.[name]) || 0;
    const scale = Number(norm.scale[index]) || 1;
    return (raw - Number(norm.mean[index] || 0)) / scale;
  });
  const hidden = Array.from({length:hiddenSize}, (_,j) =>
    Math.tanh(weights.b1[j] + input.reduce((sum,value,i) => sum + value * weights.w1[i][j], 0))
  );
  return artifact.targets.map((key,k) => {
    const z = weights.b2[k] + hidden.reduce((sum,value,j) => sum + value * weights.w2[j][k], 0);
    const value = 1 + (1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))))) * 4;
    return {key, label: TRAINED_TARGET_LABELS[key] || key, score: Math.round(value * 10) / 10};
  });
}
async function loadTrainedArtifact() {
  if (typeof fetch !== 'function') return;
  try {
    const response = await fetch('./replay-ai-model.json', {cache:'no-store'});
    if (!response.ok) return;
    const candidate = await response.json();
    if (candidate?.trained === true) trainedArtifact = candidate;
  } catch {}
  renderModelPanel();
}

const HIDDEN_WEIGHTS = [
  [ 2.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0],
  [ 0.0,  1.8,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0],
  [ 0.0,  0.0,  1.8,  0.0,  0.0,  0.0,  0.0,  0.0],
  [ 0.0,  0.0,  0.0,  1.8,  0.0,  0.0,  0.0,  0.0],
  [ 0.0,  0.0,  0.0,  0.0,  1.8,  0.0,  0.0,  0.0],
  [ 0.0,  0.0,  0.0,  0.0,  0.0,  1.8,  0.0,  0.0],
];
const HIDDEN_BIAS = [-1, -0.9, -0.9, -0.8, -0.8, -0.8];
const OUTPUT_WEIGHTS = [
  [0.85, 0.55, 0.05, 0.15, 0.25, 0.10],
  [0.10, 0.20, 0.95, 0.25, 0.15, 0.20],
  [0.30, 0.20, 0.15, 0.65, 0.15, 0.55],
];
const OUTPUT_BIAS = [0.15, 0.10, 0.05];

function forward(features) {
  const input = [
    features.precision,
    features.medianQuality,
    features.timingConsistency,
    features.completion,
    features.earlyLateBalance,
    features.denseStability,
    features.extraPressControl,
    features.holdControl,
  ];
  const hidden = HIDDEN_WEIGHTS.map((weights, index) =>
    tanh(weights.reduce((sum, weight, i) => sum + weight * input[i], HIDDEN_BIAS[index]))
  );
  return OUTPUT_WEIGHTS.map((weights, index) =>
    Math.round(sigmoid(weights.reduce((sum, weight, i) => sum + weight * hidden[i], OUTPUT_BIAS[index])) * 100)
  );
}

export function evaluateReplayModel(rows = [], meta = {}) {
  const valid = rows.filter(row => Number.isFinite(row.offset) && !row.miss);
  const offsets = valid.map(row => Number(row.offset));
  const abs = offsets.map(Math.abs);
  const total = Math.max(rows.length, Number(meta.totalObjects) || 0, 1);
  const matchedRatio = clamp(valid.length / total);
  const precision = clamp(valid.filter(row => Math.abs(row.offset) <= 30).length / Math.max(1, valid.length));
  const medianAbs = abs.length ? [...abs].sort((a, b) => a - b)[Math.floor(abs.length / 2)] : 150;
  const medianQuality = clamp(1 - medianAbs / 150);
  const timingConsistency = clamp(1 - stddev(offsets) / 120);
  const early = offsets.filter(value => value < -8).length;
  const late = offsets.filter(value => value > 8).length;
  const earlyLateBalance = 1 - clamp(Math.abs(early - late) / Math.max(1, early + late));
  const densePairs = [];
  const ordered = [...rows].filter(row => Number.isFinite(row.time)).sort((a, b) => a.time - b.time);
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1], current = ordered[i];
    const gap = current.time - previous.time;
    if (gap > 0 && gap <= 125 && Number.isFinite(previous.offset) && Number.isFinite(current.offset) && !previous.miss && !current.miss) {
      densePairs.push(current.offset - previous.offset);
    }
  }
  const denseJitter = densePairs.length ? Math.sqrt(mean(densePairs.map(value => value * value))) : null;
  const denseStability = denseJitter == null ? 0.5 : clamp(1 - denseJitter / 100);
  const unmatched = Math.max(0, Number(meta.unmatchedPresses) || 0);
  const extraPressControl = clamp(1 - unmatched / Math.max(1, Number(meta.totalPresses) || valid.length));
  const holds = rows.filter(row => /hold/i.test(String(row.type || '')));
  const releaseMisses = rows.filter(row => row.releaseMiss || /release\s+MISS/i.test(String(row.label || ''))).length;
  const holdControl = holds.length ? clamp(1 - releaseMisses / holds.length) : 0.75;

  const features = {
    precision,
    medianQuality,
    timingConsistency,
    completion: matchedRatio,
    earlyLateBalance,
    denseStability,
    extraPressControl,
    holdControl,
  };
  const [timing, stability, control] = forward(features);
  const scores = [
    { key: 'timing', label: 'Тайминг', score: timing },
    { key: 'stability', label: 'Стабильность', score: stability },
    { key: 'control', label: 'Контроль', score: control },
  ];
  const sampleFactor = clamp(valid.length / 80);
  const confidence = Math.round(sampleFactor * matchedRatio * 100);
  const recommendations = [];
  if (valid.length < 8) {
    recommendations.push({ priority: 'high', title: 'Недостаточно данных', text: 'Нужно хотя бы 8 сопоставленных объектов. Пока модель не делает выводов о технике.' });
  } else {
    if (precision < 0.45) recommendations.push({ priority: 'high', title: 'Точность нажатий', text: 'Мало попаданий в узкое окно ±30 мс. Разбери короткие отрезки и следи за равномерностью нажатий.' });
    if (timingConsistency < 0.55) recommendations.push({ priority: 'high', title: 'Ровность тайминга', text: 'Offset заметно колеблется. Сначала стабилизируй ритм, не пытайся просто нажимать быстрее.' });
    if (earlyLateBalance < 0.55) recommendations.push({ priority: 'medium', title: early > late ? 'Слишком ранние нажатия' : 'Слишком поздние нажатия', text: 'Есть перекос направления тайминга. Проверь его на нескольких участках и не меняй глобальный offset по одному реплею.' });
    if (densePairs.length >= 6 && denseStability < 0.55) recommendations.push({ priority: 'high', title: 'Плотные серии', text: 'На соседних нотах с интервалом до 125 мс заметны скачки offset. Работай над ровностью серий на небольших фрагментах.' });
    if (matchedRatio < 0.9) recommendations.push({ priority: 'high', title: 'Пропуски и сопоставление', text: 'Часть объектов не сопоставлена с нажатиями. Проверь MISS в исходном .osr и точность выбранной сложности карты.' });
    if (unmatched > 0) recommendations.push({ priority: 'medium', title: 'Лишние нажатия', text: 'Есть нажатия без найденной пары. Это могут быть лишние клики или ограничения сопоставления — проверь их в таблице.' });
    if (holds.length && releaseMisses) recommendations.push({ priority: 'high', title: 'Отпускание hold', text: 'Есть пропуски отпускания hold-нот. Проверь удержание до конца ноты.' });
    if (!recommendations.length) recommendations.push({ priority: 'low', title: 'Сохраняй стабильность', text: 'Критичных сигналов по доступным метрикам нет. Сравнивай несколько реплеев на похожих картах и BPM.' });
  }

  const windows = new Map();
  for (const row of valid) {
    const bucket = Math.floor(row.time / 15000);
    if (!windows.has(bucket)) windows.set(bucket, []);
    windows.get(bucket).push(row);
  }
  const weakestSegments = [...windows.entries()]
    .filter(([, items]) => items.length >= 5)
    .map(([bucket, items]) => ({
      start: bucket * 15000,
      end: (bucket + 1) * 15000,
      count: items.length,
      meanAbs: mean(items.map(item => Math.abs(item.offset))),
    }))
    .sort((a, b) => b.meanAbs - a.meanAbs)
    .slice(0, 2);

  return {
    version: '2.2.0-beta.1',
    trained: false,
    scores,
    confidence,
    sampleCount: valid.length,
    features,
    densePairs: densePairs.length,
    denseJitter,
    recommendations: recommendations.slice(0, 4),
    weakestSegments,
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function renderModelPanel() {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('critiqueContent');
  const table = document.getElementById('eventRows');
  if (!host || !table || !table.rows.length) return;
  const rows = [...table.rows].map(tr => {
    const cells = [...tr.cells].map(cell => cell.textContent.trim());
    if (cells.length < 5) return null;
    const miss = /MISS|не найдено/i.test(cells[2] + ' ' + cells[4]);
    const offsetMatch = cells[2].match(/([+-]?\d+)\s*ms/i);
    const timeMatch = cells[1].match(/^(\d+):(\d+)(?:\.(\d+))?$/);
    const time = timeMatch ? (Number(timeMatch[1]) * 60 + Number(timeMatch[2])) * 1000 + Number((timeMatch[3] || '0').padEnd(3, '0').slice(0, 3)) : NaN;
    return {
      time,
      offset: offsetMatch ? Number(offsetMatch[1]) : null,
      miss: miss || !offsetMatch,
      type: cells[3],
      label: cells[4],
      releaseMiss: /release\s+MISS/i.test(cells[4]),
    };
  }).filter(Boolean);
  const metricText = document.getElementById('metrics')?.innerText || '';
  const unmatchedMatch = metricText.match(/UNMATCHED PRESSES\s*(\d+)/i);
  const pressesMatch = metricText.match(/TOTAL PRESSES\s*(\d+)/i);
  const objectMatch = metricText.match(/ANALYZED OBJECTS\s*(\d+)/i);
  const result = evaluateReplayModel(rows, {
    unmatchedPresses: unmatchedMatch ? Number(unmatchedMatch[1]) : 0,
    totalPresses: pressesMatch ? Number(pressesMatch[1]) : rows.length,
    totalObjects: objectMatch ? Number(objectMatch[1]) : rows.length,
  });
  const mode = Number(window.replayHeader?.mode ?? window.replayAnalysis?.mode) === 3 ? 'mania' : 'standard';
  const activeScores = evaluateTrainedArtifact(extractTrainingFeatures(window.replayAnalysis || {}), trainedArtifact, mode) || result.scores;
  const isTrained = !!trainedArtifact && activeScores.length === 6;
  const signature = JSON.stringify([rows.length, result.sampleCount, activeScores.map(item => item.score), result.confidence, isTrained]);
  const existing = host.querySelector('[data-replay-ai-model]');
  if (existing?.dataset.signature === signature) return;
  existing?.remove();

  const panel = element('section', 'replay-ai-model');
  panel.dataset.replayAiModel = 'true';
  panel.dataset.signature = signature;
  panel.style.cssText = 'margin-top:14px;padding:14px;border:1px solid #45627a;border-radius:12px;background:linear-gradient(135deg,#17283a,#101722)';
  const heading = element('div', '', isTrained ? 'Обученная модель Replay Lab' : 'Экспериментальная модель 2.2.0 Beta');
  heading.style.cssText = 'font-weight:800;font-size:15px;color:#a9e7ff';
  panel.append(heading);
  const note = element('p', 'muted', (isTrained ? 'Обучена на размеченном датасете' : 'Не обучена на пользовательских реплеях') + ' · уверенность выборки: ' + result.confidence + '%');
  panel.append(note);
  const scores = element('div');
  scores.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px';
  for (const item of activeScores) {
    const card = element('div');
    card.style.cssText = 'padding:10px;border:1px solid #2d4054;border-radius:9px;background:#0b111b';
    const label = element('small', 'muted', item.label);
    const value = element('strong', '', isTrained ? item.score.toFixed(1) + '/5' : item.score + '/100');
    value.style.cssText = 'display:block;font-size:22px;color:' + (item.score >= 70 ? '#42d392' : item.score >= 50 ? '#f5c451' : '#ff8797');
    card.append(label, value);
    scores.append(card);
  }
  panel.append(scores);
  const exportNote = element('p', 'muted', 'Экспорт числовых признаков для обучающего набора. Никнейм и MD5 карты не сохраняются.');
  exportNote.style.margin = '12px 0 6px';
  panel.append(exportNote);
  const exportButton = element('button', '', 'Экспорт признаков для обучения');
  exportButton.type = 'button';
  exportButton.style.cssText = 'padding:9px 12px;border:1px solid #4a7692;border-radius:8px;background:#17354b;color:#d9f3ff;font-weight:700;cursor:pointer';
  exportButton.addEventListener('click', () => {
    const source = typeof window !== 'undefined' ? window.replayAnalysis : null;
    if (!source?.rows?.length) { alert('Сначала полностью проанализируй реплей.'); return; }
    const mode = Number(window.replayHeader?.mode ?? source.mode) === 3 ? 'mania' : 'standard';
    const prefix = mode === 'mania' ? 'mania' : 'std';
    const selected = document.getElementById('replayFile')?.files?.[0];
    const match = String(selected?.name || '').match(/(?:std|mania)_\d{6}/i);
    const suggested = match ? match[0].toLowerCase() : '';
    const replayId = window.prompt('Введи анонимный ID из датасета (например, ' + prefix + '_000001):', suggested);
    if (!replayId || !new RegExp('^' + prefix + '_\\d{6}$').test(replayId.trim())) {
      alert('ID должен иметь формат ' + prefix + '_000001.');
      return;
    }
    const doc = {
      schema_version: 1, replay_id: replayId.trim(), mode,
      parser_version: 'replay-lab-2.2.0-beta.1',
      features: extractTrainingFeatures(source),
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = replayId.trim() + '.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  panel.append(exportButton);

  const recTitle = element('h3', '', 'Что модель предлагает улучшить');
  recTitle.style.cssText = 'font-size:14px;margin:14px 0 6px';
  panel.append(recTitle);
  const list = element('div');
  for (const item of result.recommendations) {
    const rec = element('div');
    rec.style.cssText = 'padding:9px 0;border-top:1px solid #2d4054';
    const title = element('strong', '', (item.priority === 'high' ? 'Приоритет: высокий · ' : item.priority === 'medium' ? 'Приоритет: средний · ' : 'Приоритет: низкий · ') + item.title);
    const body = element('p', 'muted', item.text);
    body.style.margin = '3px 0 0';
    rec.append(title, body);
    list.append(rec);
  }
  panel.append(list);
  if (result.weakestSegments.length) {
    const segmentsTitle = element('h3', '', 'Участки для перепроверки');
    segmentsTitle.style.cssText = 'font-size:14px;margin:14px 0 6px';
    panel.append(segmentsTitle);
    for (const segment of result.weakestSegments) {
      panel.append(element('p', 'muted', fmtTime(segment.start) + '–' + fmtTime(segment.end) + ' · ' + segment.count + ' нот · среднее |offset| ' + fmt(segment.meanAbs) + ' мс'));
    }
  }
  host.append(panel);
}

if (typeof document !== 'undefined') {
  const boot = () => {
    const host = document.getElementById('critiqueContent');
    if (!host || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => renderModelPanel());
    observer.observe(host, { childList: true, subtree: true });
    const table = document.getElementById('eventRows');
    if (table) {
      const tableObserver = new MutationObserver(() => renderModelPanel());
      tableObserver.observe(table, { childList: true, subtree: true });
    }
    renderModelPanel();
    loadTrainedArtifact();
    document.title = 'Replay Lab · Beta 2.2.0';
    const footer = document.querySelector('.foot');
    if (footer) footer.textContent = 'Replay Lab · Beta 2.2.0';
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
