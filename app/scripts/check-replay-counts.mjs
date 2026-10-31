import assert from 'node:assert/strict';
import {
  analyze,
  analyzeMania,
  attachReplayCounts,
  countMisses,
  keyPresses,
} from '../replay-analysis.mjs';

const simultaneous = keyPresses([
  { time: 0, keys: 0, x: 256, y: 192 },
  { time: 100, keys: 5, x: 256, y: 192 },
  { time: 120, keys: 0, x: 256, y: 192 },
]);
assert.equal(simultaneous.length, 2, 'two key bits pressed in one frame must become two press events');
assert.deepEqual(simultaneous.map(event => event.keys).sort((a, b) => a - b), [1, 4]);

const standard = analyze({
  radius: 32,
  objects: [
    { time: 1000, type: 'circle', x: 256, y: 192 },
    { time: 1090, type: 'circle', x: 256, y: 192 },
  ],
}, [
  { time: 900, x: 256, y: 192 },
  { time: 1080, x: 256, y: 192 },
]);
assert.equal(standard.matched.length, 2, 'Standard matching must reserve the only candidate for the more constrained object');
assert.deepEqual(standard.rows.map(row => row.offset), [-100, -10]);
assert.equal(standard.unmatchedPresses, 0);

const mania = analyzeMania({
  keys: 1,
  od: 5,
  objects: [
    { time: 1000, endTime: 1000, type: 'note', column: 0 },
    { time: 1090, endTime: 1090, type: 'note', column: 0 },
  ],
}, [
  { time: 900, lane: 0 },
  { time: 1080, lane: 0 },
]);
assert.equal(mania.matched.length, 2, 'Mania matching must not let an earlier note steal a closer press');
assert.deepEqual(mania.rows.map(row => row.offset), [-100, -10]);
assert.equal(mania.unmatchedPresses, 0);

const hold = analyzeMania({
  keys: 1,
  od: 5,
  objects: [{ time: 1000, endTime: 1500, type: 'hold', column: 0 }],
}, [{ time: 1000, lane: 0 }], []);
assert.equal(hold.rows[0].releaseMiss, true, 'a hold without a release must count as a release MISS');
assert.equal(hold.missCount, 1);
assert.equal(countMisses([{ miss: false, releaseMiss: true }, { miss: true }]), 2);

const authoritative = attachReplayCounts(standard, {
  n300: 1, n100: 2, n50: 0, geki: 0, katu: 0, miss: 3,
}, simultaneous.length);
assert.equal(authoritative.missCount, 3, 'the .osr score header is authoritative for the official MISS total');
assert.equal(authoritative.scoreJudgementCount, 6);
assert.equal(authoritative.totalPresses, 2);

console.log('Replay counter regression tests passed: Standard, Mania, hold releases, official .osr counts, simultaneous key presses.');
