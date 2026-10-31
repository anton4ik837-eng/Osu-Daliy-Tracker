export const ENCODER_VERSION='0.1.0';
export const PARSER_VERSION='osu-parsers-4.1.7-events-v3';
const NAMES=['x_norm','y_norm','coordinate_present','interval_log','dx_norm','dy_norm','speed_log','left1','right1','left2','right2','smoke','button_state_present','mode_standard','mode_mania'];
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export function frameMatrix(frames,mode,maxFrames=5000){
 if(!Array.isArray(frames)||!frames.length)throw Error('В реплее нет кадров.');
 const m=mode===3||mode==='mania'?'mania':mode===0||mode==='standard'?'standard':null;
 if(!m)throw Error('Поддерживаются Standard и Mania.');
 const count=Math.min(frames.length,maxFrames),rows=[];let prev=null,prevTime=null;
 for(let i=0;i<count;i++){
  const index=count===1?0:Math.floor(i*(frames.length-1)/(count-1)),f=frames[index]||{};
  const t=Number(f.time),raw=Number(f.interval),dt=Number.isFinite(raw)?raw:(Number.isFinite(t)&&Number.isFinite(prevTime)?t-prevTime:0);
  const x=Number(f.x),y=Number(f.y),has=m==='standard'&&Number.isFinite(x)&&Number.isFinite(y);
  const xn=has?clamp(x/512,-2,2):0,yn=has?clamp(y/384,-2,2):0;let dx=0,dy=0,speed=0;
  if(has&&prev){const sec=Math.max(dt,1)/1000;dx=clamp((x-prev[0])/512,-2,2);dy=clamp((y-prev[1])/384,-2,2);speed=Math.log1p(Math.min(Math.hypot(dx,dy)/sec,10000))/Math.log1p(10000);}
  prev=has?[x,y]:null;if(Number.isFinite(t))prevTime=t;
  const bits=m==='standard'?(Number(f.keys)||0):0;
  rows.push([xn,yn,+has,Math.log1p(Math.max(dt,0))/Math.log1p(1000),dx,dy,speed,+!!(bits&1),+!!(bits&2),+!!(bits&4),+!!(bits&8),+!!(bits&16),1,+(m==='standard'),+(m==='mania')]);
 }
 return rows;
}
export function encodeFrames(frames,mode,model){
 if(model?.model_type!=='self_supervised_reconstruction_encoder'||model?.trained!==true)throw Error('Неподдерживаемый файл энкодера.');
 if(model.parser_version!==PARSER_VERSION||JSON.stringify(model.feature_names)!==JSON.stringify(NAMES))throw Error('Несовместимая версия схемы признаков.');
 const rows=frameMatrix(frames,mode),n=model.normalization,w=model.encoder_weights;
 if(!n?.mean||!n?.scale||!w?.w1||!w?.w2||!w?.b1||!w?.b2||n.mean.length!==15||n.scale.length!==15||w.w1.length!==15||w.w1.some(r=>r.length!==16)||w.w2.length!==16||w.w2.some(r=>r.length!==8)||w.b1.length!==16||w.b2.length!==8)throw Error('Некорректная архитектура/веса энкодера.');
 const sum=Array(8).fill(0),sq=Array(8).fill(0);
 for(const row of rows){const input=row.map((v,i)=>(v-Number(n.mean[i]))/Number(n.scale[i]));
  const h=Array.from({length:16},(_,j)=>Math.tanh(w.b1[j]+input.reduce((s,v,i)=>s+v*w.w1[i][j],0)));
  const z=Array.from({length:8},(_,j)=>Math.tanh(w.b2[j]+h.reduce((s,v,i)=>s+v*w.w2[i][j],0)));
  z.forEach((v,j)=>{sum[j]+=v;sq[j]+=v*v;});
 }
 const embedding=[...sum.map(v=>v/rows.length),...sum.map((v,j)=>Math.sqrt(Math.max(0,sq[j]/rows.length-(v/rows.length)**2)))],norm=Math.hypot(...embedding);
 if(!Number.isFinite(norm)||norm<1e-10)throw Error('Энкодер вернул некорректный вектор.');
 return embedding.map(v=>v/norm);
}
export function findSimilarReplays(vector,mode,index,limit=5){
 if(index?.model_type!=='unsupervised_replay_similarity'||index.skill_scorer!==false||index.parser_version!==PARSER_VERSION||!Array.isArray(index.entries))throw Error('Несовместимый индекс эталонов.');
 const m=mode===3||mode==='mania'?'mania':'standard';
 return index.entries.filter(e=>e.mode===m&&Array.isArray(e.embedding)&&e.embedding.length===vector.length)
  .map(e=>({replay_id:e.replay_id,similarity:vector.reduce((s,v,i)=>s+v*e.embedding[i],0),metrics:e.metrics}))
  .sort((a,b)=>b.similarity-a.similarity).slice(0,Math.max(1,limit));
}
