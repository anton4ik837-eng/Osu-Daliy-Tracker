import assert from 'node:assert/strict';
import { evaluateReplayModel, extractTrainingFeatures } from '../replay-ai-model.mjs';

const stableRows = Array.from({length:100},(_,i)=>({
  time:i*100,
  offset:(i%2===0?1:-1)*(5+(i%3)),
  miss:false,
  type:'circle',
}));
const stable = evaluateReplayModel(stableRows,{totalObjects:100,totalPresses:100,unmatchedPresses:0});
assert.equal(stable.trained,false,'prototype must clearly declare that it is not trained');
assert.equal(stable.sampleCount,100);
assert.equal(stable.scores.length,3);
assert.ok(stable.confidence>0);
assert.ok(stable.scores.every(item=>item.score>=0&&item.score<=100));

const unstableRows = Array.from({length:100},(_,i)=>({
  time:i*100,
  offset:i%2===0?-90:90,
  miss:false,
  type:'circle',
}));
const unstable = evaluateReplayModel(unstableRows,{totalObjects:100,totalPresses:130,unmatchedPresses:30});
assert.ok(
  unstable.scores.find(item=>item.key==='stability').score <
  stable.scores.find(item=>item.key==='stability').score,
  'high offset jitter must lower the stability score'
);
assert.ok(unstable.recommendations.length>0);
assert.ok(unstable.weakestSegments.length>0);

const insufficient = evaluateReplayModel([{time:0,offset:null,miss:true}],{totalObjects:1});
assert.equal(insufficient.confidence,0);
assert.match(insufficient.recommendations[0].title,/Недостаточно данных/);


const featureRows = Array.from({length:12},(_,i)=>({
  time:i*100, offset:i%2===0?4:-4, miss:false, type:'circle', aimErrorPx:6,
}));
const extracted = extractTrainingFeatures({
  rows:featureRows, totalPresses:12, unmatchedPresses:0, bpm:180,
});
assert.equal(extracted.object_count,12);
assert.equal(extracted.matched_count,12);
assert.equal(extracted.stream_count,1);
assert.equal(extracted.dense_pair_count,11);
assert.equal(extracted.mean_aim_error_px,6);
assert.equal(extracted.bpm_estimate,180);
assert.equal(extracted.high_density_hit_rate,null,'unavailable map-derived features must remain null');

console.log('Replay AI beta model tests passed: score range, confidence, stability sensitivity, recommendations, low-sample guard.');
