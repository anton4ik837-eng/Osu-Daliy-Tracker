import { BeatmapDecoder } from 'osu-parsers';
import { ManiaRuleset } from 'osu-mania-stable';

const decoder = new BeatmapDecoder();
const ruleset = new ManiaRuleset();

function clampKeys(value) {
  const keys = Math.round(Number(value));
  if (!Number.isFinite(keys) || keys < 1 || keys > 10) {
    throw new RangeError('Число колонок osu!mania должно быть от 1 до 10.');
  }
  return keys;
}

/**
 * Convert a Standard .osu text into a Mania chart using the osu-mania-stable
 * ruleset converter (a JavaScript port based on the current osu!lazer ruleset).
 * This is deliberately not a coordinate-only approximation: the source parser
 * builds real hit-object paths/control points, and the ruleset generates notes,
 * holds and patterns from timing, slider geometry, repeats and map density.
 */
export function convertStandardToMania(osuText, targetKeys, metadata = {}) {
  if (typeof osuText !== 'string' || !osuText.trim()) {
    throw new TypeError('Пустой текст .osu карты.');
  }

  const original = decoder.decodeFromString(osuText, { parseStoryboard: false });
  if (original.originalMode !== 0) {
    throw new Error('Конвертер принимает только исходные osu!standard-карты.');
  }
  if (!original.hitObjects.length) {
    throw new Error('В .osu не найдены объекты карты.');
  }

  const converter = ruleset._createBeatmapConverter();
  if (targetKeys !== undefined && targetKeys !== null) {
    converter.targetColumns = clampKeys(targetKeys);
  }

  const converted = converter.convertBeatmap(original);
  const processor = ruleset._createBeatmapProcessor();
  processor.preProcess(converted);
  converted.hitObjects.forEach(object => {
    object.applyDefaults(converted.controlPoints, converted.difficulty);
  });
  processor.postProcess(converted);

  const keys = converted.totalColumns;
  if (!Number.isInteger(keys) || keys < 1 || keys > 10) {
    throw new Error('Генератор вернул недопустимое число колонок: ' + keys);
  }

  const objects = converted.hitObjects.map(object => {
    const time = Number(object.startTime);
    const endTime = Number.isFinite(object.endTime) ? Number(object.endTime) : time;
    const position = object.startPosition || { x: 256, y: 192 };
    const column = Number(object.column);
    if (!Number.isFinite(time) || !Number.isInteger(column) || column < 0 || column >= keys) {
      throw new Error('Генератор создал объект с некорректным временем или колонкой.');
    }
    return {
      time,
      endTime: Math.max(time, endTime),
      type: endTime > time ? 'hold' : 'note',
      x: Number(position.x) || 0,
      y: 0,
      column,
      originalColumn: column,
      sourceX: Number(position.x) || 0,
      sourceY: Number(position.y) || 0,
      sourceType: object.constructor?.name || 'hitObject'
    };
  }).sort((a, b) => a.time - b.time || a.column - b.column);

  if (!objects.length) {
    throw new Error('После конвертации не осталось игровых объектов.');
  }

  return {
    ...metadata,
    objects,
    mode: 3,
    keys,
    originalKeys: keys,
    convertedFromMode: 0,
    conversionAlgorithm: 'osu-mania-stable 5.0.1 · osu!lazer ruleset port'
  };
}

globalThis.OsuManiaConverter = { convertStandardToMania };
