import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {encodeFrames,findSimilarReplays,frameMatrix,PARSER_VERSION} from '../replay-encoder.mjs';
const model=JSON.parse(await readFile(new URL('../www/replay-encoder.json',import.meta.url),'utf8'));
const index=JSON.parse(await readFile(new URL('../www/replay-reference-index.json',import.meta.url),'utf8'));
assert.equal(model.trained,true);assert.equal(model.parser_version,PARSER_VERSION);assert.equal(index.entries.length,37);
for(const [mode,frames] of [['standard',Array.from({length:160},(_,i)=>({time:i*16,interval:16,x:256+Math.sin(i/7)*120,y:192+Math.cos(i/9)*80,keys:i%4<2?4:0}))],['mania',Array.from({length:160},(_,i)=>({time:i*16,interval:16,x:i%8<4?1:0,y:0,keys:0}))]]){
 const matrix=frameMatrix(frames,mode);assert.equal(matrix.length,160);assert.equal(matrix[0].length,15);
 const vector=encodeFrames(frames,mode,model);assert.equal(vector.length,16);assert.ok(vector.every(Number.isFinite));assert.ok(Math.abs(Math.hypot(...vector)-1)<1e-8);
 const similar=findSimilarReplays(vector,mode,index,3);assert.equal(similar.length,3);assert.ok(similar.every(x=>x.replay_id.startsWith(mode==='mania'?'mania_':'std_')));
}
console.log('Replay encoder tests passed: 15-feature input, trained weights, 16D embeddings, mode-separated neighbours.');
