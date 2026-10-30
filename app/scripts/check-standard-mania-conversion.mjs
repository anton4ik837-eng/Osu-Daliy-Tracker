import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convertStandardToMania } from '../mania-converter.mjs';

const beatmap = `osu file format v14

[General]
AudioFilename: test.mp3
Mode:0

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:6
ApproachRate:7
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,1,60,1,0
1000,-50,4,2,1,60,0,0
2000,400,4,2,1,60,1,0

[HitObjects]
64,192,500,1,0,0:0:0:0:
448,192,750,1,0,0:0:0:0:
256,100,1000,2,0,B|400:100|400:250,2,240
100,300,1900,1,0,0:0:0:0:
256,192,2200,8,0,3500
256,192,2400,1,0,0:0:0:0:
`;

const convertedByKeyCount = new Map();
for (let keys = 1; keys <= 10; keys += 1) {
  const first = convertStandardToMania(beatmap, keys, { bpm: 120, cs: 4, od: 6 });
  const second = convertStandardToMania(beatmap, keys, { bpm: 120, cs: 4, od: 6 });
  assert.equal(first.mode, 3);
  assert.equal(first.keys, keys);
  assert.ok(first.objects.length > 0);
  assert.ok(first.objects.every(object =>
    Number.isFinite(object.time) &&
    Number.isFinite(object.endTime) &&
    object.endTime >= object.time &&
    Number.isInteger(object.column) &&
    object.column >= 0 &&
    object.column < keys
  ));
  assert.deepEqual(first.objects, second.objects, keys + 'K conversion must be deterministic');
  assert.deepEqual(first.objects.map(object => object.time),
    [...first.objects.map(object => object.time)].sort((a, b) => a - b),
    keys + 'K objects must be time sorted');
  convertedByKeyCount.set(keys, first);
}
assert.ok(convertedByKeyCount.get(4).objects.some(object => object.type === 'hold'),
  'slider/spinner duration objects should produce Mania holds where appropriate');
assert.equal(convertStandardToMania(beatmap).keys, 7,
  'default key count should follow the osu-mania-stable conversion heuristic');
assert.throws(() => convertStandardToMania(beatmap, 11), /от 1 до 10/);
const replayLabSource = readFileSync(new URL('../www/replay.html', import.meta.url), 'utf8');
assert.ok(!replayLabSource.includes('standardManiaTargetColumns'),
  'Replay Lab must not reference the removed standardManiaTargetColumns helper');
assert.ok(replayLabSource.includes('convertStandardToMania(mapText,undefined,map)'),
  'Replay Lab must derive the default Mania key count from the conversion engine');
assert.ok(replayLabSource.includes('defaultConvertedMap.keys'),
  'Replay Lab must use the engine-generated default column count before resolving key mods');
console.log('Standard -> Mania converter OK: 1K–10K, deterministic patterns, sliders, repeats, spinner, timing points and SV.');
