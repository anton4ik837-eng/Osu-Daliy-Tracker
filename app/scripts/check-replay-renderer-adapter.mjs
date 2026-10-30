import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildManiaOsuText } from '../replay-renderer-adapter.mjs';
import { parseBeatmap } from 'replayviewer-js';

const adapterSource = readFileSync(new URL('../replay-renderer-adapter.mjs', import.meta.url), 'utf8');
assert.match(adapterSource, /async setSkin\(nextSkinBytes = null\)/, 'active JS renderer must support in-place skin refresh');
assert.match(adapterSource, /previousSession\.destroy\(\)/, 'skin refresh must release the previous renderer session');
assert.match(adapterSource, /maniaScrollMultiplier/, 'skin refresh must preserve Mania scroll speed');

const source = [
  'osu file format v14',
  '[General]',
  'AudioFilename: test.mp3',
  'Mode: 0',
  '[Metadata]',
  'Title: Renderer adapter fixture',
  'Artist: Test',
  '[Difficulty]',
  'HPDrainRate: 5',
  'CircleSize: 4',
  'OverallDifficulty: 8',
  'ApproachRate: 9',
  'SliderMultiplier: 1.4',
  'SliderTickRate: 1',
  '[TimingPoints]',
  '0,500,4,2,1,100,1,0',
  '[HitObjects]',
  '64,192,1000,1,0,0:0:0:0:',
].join('\n');

const converted = {
  mode: 3,
  keys: 4,
  objects: [
    { lane: 0, time: 1000, endTime: 1000, type: 'note' },
    { lane: 2, time: 1500, endTime: 2200, type: 'hold' },
    { lane: 3, time: 2500, endTime: 2500, type: 'note' },
  ],
};

const generated = buildManiaOsuText(source, converted);
const parsed = parseBeatmap(generated);
assert.equal(parsed.mode, 3);
assert.equal(parsed.circleSize, 4);
assert.equal(parsed.hitObjects.length, 2, 'two tap notes should be parsed');
assert.equal(parsed.maniaHolds.length, 1, 'one hold should be parsed');
assert.equal(parsed.hitObjects[0].x, 64, 'first lane should map to the first column center');
assert.equal(parsed.hitObjects[1].x, 448, 'last lane should map to the last column center');
assert.equal(parsed.maniaHolds[0].endTime, 2200);

console.log('PASS replayviewer adapter: Standard-to-Mania bridge serializes notes, holds and lane geometry');
