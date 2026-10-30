import {
  createReplaySession,
  loadSkin,
  parseBeatmap,
  parseReplay,
} from 'replayviewer-js';

function emptySkin() {
  return {
    images: new Map(),
    sounds: new Map(),
    spinnerImages: new Map(),
    config: {
      comboColors: [],
      hitCircleOverlap: -2,
      hitCirclePrefix: 'default',
      scorePrefix: 'score',
      comboPrefix: 'score',
      sliderBorder: '#ffffff',
      sliderTrackOverride: null,
      allowSliderBallTint: false,
      name: '',
      version: '',
      maniaSections: [],
    },
  };
}

function sectionText(osuText, name) {
  const lines = String(osuText || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = lines.findIndex(line => line.trim().toLowerCase() === '[' + name.toLowerCase() + ']');
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^\s*\[[^\]]+\]\s*$/.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n');
}

export function buildManiaOsuText(sourceText, convertedMap) {
  const keys = Math.max(1, Math.min(10, Math.round(Number(convertedMap?.keys) || 4)));
  const objects = Array.isArray(convertedMap?.objects) ? convertedMap.objects : [];
  if (!objects.length) throw new Error('Converted Mania map has no objects.');

  const general = sectionText(sourceText, 'General');
  const metadata = sectionText(sourceText, 'Metadata');
  const timing = sectionText(sourceText, 'TimingPoints') || '0,500,4,2,1,100,1,0';
  const difficulty = sectionText(sourceText, 'Difficulty');
  const xForLane = lane => Math.round((Math.max(0, Math.min(keys - 1, lane)) + 0.5) * 512 / keys);

  const hitObjects = objects.map(object => {
    const lane = Number(object.lane ?? object.column ?? 0);
    const x = xForLane(Number.isFinite(lane) ? lane : 0);
    const time = Math.max(0, Math.round(Number(object.time) || 0));
    if (object.type === 'hold' || Number(object.endTime) > time) {
      const end = Math.max(time + 1, Math.round(Number(object.endTime) || time + 1));
      return x + ',192,' + time + ',128,0,' + end + ':0:0:0:';
    }
    return x + ',192,' + time + ',1,0,0:0:0:';
  }).join('\n');

  const cleanGeneral = general
    .split(/\r?\n/)
    .filter(line => !/^\s*Mode\s*:/i.test(line))
    .join('\n');
  const cleanDifficulty = difficulty
    .split(/\r?\n/)
    .filter(line => !/^\s*CircleSize\s*:/i.test(line))
    .join('\n');

  return [
    'osu file format v14',
    '[General]',
    cleanGeneral,
    'Mode: 3',
    '[Metadata]',
    metadata,
    '[Difficulty]',
    cleanDifficulty,
    'CircleSize: ' + keys,
    'HPDrainRate: 5',
    'OverallDifficulty: 8',
    'ApproachRate: 5',
    'SliderMultiplier: 1.4',
    'SliderTickRate: 1',
    '[TimingPoints]',
    timing,
    '[HitObjects]',
    hitObjects,
    '',
  ].join('\n');
}

/**
 * Creates an isolated replayviewer-js renderer session.
 *
 * For a Standard replay, pass the original Standard .osu text.
 * For a native Mania replay, pass its exact Mania .osu text.
 * For a Mania replay on a Standard map, pass the already converted
 * playMap result as convertedManiaMap; it is serialized to a native
 * Mania chart before the library sees it. This preserves the app's existing
 * osu-mania-stable conversion and replay-derived lane-count decision.
 *
 * This adapter deliberately does not own UI controls or the app's audio
 * element yet. The caller drives the renderer's presentation clock.
 */
export async function createReplayRendererSession({
  canvas,
  audioContext,
  replayBytes,
  beatmapText,
  convertedManiaMap = null,
  skinBytes = null,
  audioBuffer = null,
  pageZoom = 1,
}) {
  if (!canvas || !audioContext || !replayBytes || !beatmapText) {
    throw new TypeError('canvas, audioContext, replayBytes and beatmapText are required.');
  }

  const replayBuffer = replayBytes instanceof ArrayBuffer
    ? replayBytes
    : await replayBytes.arrayBuffer();
  const replay = await parseReplay(replayBuffer);
  const resolvedText = convertedManiaMap
    ? buildManiaOsuText(beatmapText, convertedManiaMap)
    : beatmapText;
  const beatmap = parseBeatmap(resolvedText);

  if (beatmap.mode !== replay.mode) {
    throw new Error(
      'Renderer mode mismatch after conversion: replay=' + replay.mode +
      ', beatmap=' + beatmap.mode + '.',
    );
  }

  let skin = emptySkin();
  if (skinBytes) {
    const skinBuffer = skinBytes instanceof ArrayBuffer
      ? skinBytes
      : await skinBytes.arrayBuffer();
    skin = await loadSkin(skinBuffer, audioContext);
  }

  const beatmapSet = {
    beatmap,
    songBuffer: audioBuffer,
    background: null,
    beatmapSounds: new Map(),
    storyboard: null,
    storyboardImages: new Map(),
    video: null,
  };
  const session = await createReplaySession({
    canvas,
    audioContext,
    replay,
    beatmapSet,
    skin,
    pageZoom,
    storyboard: false,
    video: false,
  });

  let destroyed = false;
  return {
    session,
    mode: replay.mode,
    beatmap,
    replay,
    start() {
      if (destroyed) throw new Error('Renderer session has been destroyed.');
      session.renderer.start();
    },
    pause() {
      if (destroyed) return;
      session.player.pause();
    },
    play() {
      if (destroyed) throw new Error('Renderer session has been destroyed.');
      session.player.play();
      session.renderer.start();
    },
    seekMapTime(mapTimeMs) {
      if (destroyed) return;
      const presentationMs = (Number(mapTimeMs) - session.timeMapper.introOffsetMs) / session.timeMapper.speed;
      session.player.seek(Math.max(0, Math.min(session.player.durationMs, presentationMs)));
    },
    setManiaScrollSpeed(multiplier) {
      if (destroyed || session.mode !== 3) return;
      const factor = Math.max(0.5, Math.min(2, Number(multiplier) || 1));
      session.renderer.options.maniaScrollSpeed = Math.max(1, Math.min(40, Math.round(20 * factor)));
      const mapTimeMs = session.timeMapper.toMapTime(session.player.currentTimeMs);
      session.renderer.renderFrameAt(mapTimeMs);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      session.destroy();
    },
  };
}

export const version = 'replayviewer-js@1.0.0';
