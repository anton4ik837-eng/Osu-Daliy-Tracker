import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html = readFileSync(new URL('../www/replay.html', import.meta.url), 'utf8');
const start = html.indexOf('function applyManiaKeyCount(');
if (start < 0) throw new Error('applyManiaKeyCount() not found');
const end = html.indexOf('\nfunction parseMap(', start);
if (end < 0) throw new Error('Could not isolate applyManiaKeyCount()');
const context = {};
vm.createContext(context);
vm.runInContext(html.slice(start, end) + '\nthis.applyManiaKeyCount = applyManiaKeyCount;', context);
const sevenToFour = { keys: 7, objects: Array.from({ length: 7 }, (_, lane) => ({ x: (lane + 0.5) * 512 / 7, column: lane, time: lane * 100 })) };
context.applyManiaKeyCount(sevenToFour, 4);
assert.equal(sevenToFour.keys, 4);
assert.deepEqual(Array.from(sevenToFour.objects, o => o.originalColumn), [0,1,2,3,4,5,6]);
assert.deepEqual(Array.from(sevenToFour.objects, o => o.column), [0,0,1,1,2,2,3]);
const fourToFour = { keys: 4, objects: [{ x: 64 }, { x: 192 }, { x: 320 }, { x: 448 }] };
context.applyManiaKeyCount(fourToFour, 4);
assert.deepEqual(Array.from(fourToFour.objects, o => o.column), [0,1,2,3]);
context.applyManiaKeyCount(sevenToFour, 4);
assert.deepEqual(Array.from(sevenToFour.objects, o => o.column), [0,0,1,1,2,2,3]);
// Exercise every source/target key-count pair, including repeated application.
let matrixCases = 0;
for (let sourceKeys = 1; sourceKeys <= 10; sourceKeys++) {
  for (let targetKeys = 1; targetKeys <= 10; targetKeys++) {
    const map = {
      keys: sourceKeys,
      objects: Array.from({ length: sourceKeys }, (_, lane) => ({
        x: (lane + 0.5) * 512 / sourceKeys,
        column: lane,
        time: lane * 100,
      })),
    };
    context.applyManiaKeyCount(map, targetKeys);
    const firstPass = Array.from(map.objects, object => object.column);
    context.applyManiaKeyCount(map, targetKeys);
    const secondPass = Array.from(map.objects, object => object.column);
    const expected = Array.from({ length: sourceKeys }, (_, lane) => Math.floor(lane * targetKeys / sourceKeys));
    assert.equal(map.keys, targetKeys, sourceKeys + 'K -> ' + targetKeys + 'K target count');
    assert.deepEqual(firstPass, expected, sourceKeys + 'K -> ' + targetKeys + 'K first pass');
    assert.deepEqual(secondPass, expected, sourceKeys + 'K -> ' + targetKeys + 'K repeated pass');
    assert.ok(map.objects.every(object => object.column >= 0 && object.column < targetKeys), sourceKeys + 'K -> ' + targetKeys + 'K lane bounds');
    matrixCases++;
  }
}
console.log('Mania key remap matrix OK: ' + matrixCases + ' source/target pairs, repeated application');
