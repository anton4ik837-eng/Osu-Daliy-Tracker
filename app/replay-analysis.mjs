function lowerBoundByTime(events, time) {
  let low = 0, high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (events[mid].time < time) low = mid + 1;
    else high = mid;
  }
  return low;
}
function matchOneToOne(items, events, getCandidates) {
  const candidates = items.map(item => getCandidates(item).sort((a,b) => a.score-b.score || a.eventIndex-b.eventIndex));
  const eventOwner = new Array(events.length).fill(-1);
  const itemEvent = new Array(items.length).fill(-1);
  const order = items.map((_,i)=>i).sort((a,b)=>candidates[a].length-candidates[b].length || (candidates[a][0]?.score??Infinity)-(candidates[b][0]?.score??Infinity) || (items[a].time??0)-(items[b].time??0));
  function augment(itemIndex, visited) {
    for (const candidate of candidates[itemIndex]) {
      const eventIndex = candidate.eventIndex;
      if (visited.has(eventIndex)) continue;
      visited.add(eventIndex);
      const owner = eventOwner[eventIndex];
      if (owner === -1 || augment(owner, visited)) {
        eventOwner[eventIndex] = itemIndex;
        itemEvent[itemIndex] = eventIndex;
        return true;
      }
    }
    return false;
  }
  for (const itemIndex of order) augment(itemIndex, new Set());
  return {itemEvent,eventOwner};
}
function timedCandidates(events, targetTime, windowMs, extraScore=null, predicate=null, item=null) {
  const candidates=[];
  const start=lowerBoundByTime(events,targetTime-windowMs);
  for(let eventIndex=start;eventIndex<events.length;eventIndex++){
    const event=events[eventIndex];
    if(event.time>targetTime+windowMs)break;
    if(predicate&&!predicate(event,item))continue;
    const delta=event.time-targetTime;
    const extra=extraScore?extraScore(event,item):0;
    if(!Number.isFinite(extra))continue;
    candidates.push({eventIndex,delta,score:Math.abs(delta)+extra});
  }
  return candidates;
}
export function keyPresses(frames) {
  const out=[];let previous=0;
  for(const frame of frames||[]){
    const down=(Number(frame.keys)||0)&0x7CF;
    const pressed=down&~previous;
    for(let bit=1;bit<=0x400;bit<<=1)if(pressed&bit)out.push({time:frame.time,keys:bit,x:frame.x,y:frame.y});
    previous=down;
  }
  return out.filter(event=>event.time>=0);
}
export function maniaKeyTransitions(frames,keyCount) {
  const lanes=Math.max(1,Math.min(10,Math.round(Number(keyCount)||1)));
  const presses=[],releases=[];let previous=0;const mask=(1<<lanes)-1;
  for(const frame of frames||[]){
    const raw=Number(frame.x),down=Number.isFinite(raw)?(Math.round(raw)>>>0)&mask:0;
    const pressed=down&~previous,released=previous&~down;
    for(let lane=0;lane<lanes;lane++){const bit=1<<lane;if(pressed&bit)presses.push({time:frame.time,keys:bit,lane,x:lane,y:0});if(released&bit)releases.push({time:frame.time,keys:bit,lane});}
    previous=down;
  }
  return {presses:presses.filter(e=>e.time>=0),releases:releases.filter(e=>e.time>=0)};
}
export function maniaJudgement(offset,od=5) {
  const a=Math.abs(Number(offset)||0),d=Math.max(0,Math.min(10,Number.isFinite(Number(od))?Number(od):5));
  const windows=[['MAX',22-.6*d],['300',82-1.8*d],['200',112-1.5*d],['100',142-1.5*d],['50',164-1.3*d]];
  return windows.find(([,window])=>a<=window)?.[0]||'MISS';
}
export function countMisses(rows=[]) {
  return rows.reduce((sum,row)=>sum+(row.miss?1:0)+(row.releaseMiss?1:0),0);
}
export function attachReplayCounts(analysis,scoreCounts,totalPresses=analysis.totalPresses) {
  const counts=scoreCounts&&typeof scoreCounts==='object'?scoreCounts:null;
  const miss=Number(counts?.miss);
  const total=counts?['n300','n100','n50','geki','katu','miss'].reduce((sum,key)=>sum+Math.max(0,Number(counts[key])||0),0):null;
  analysis.scoreCounts=counts;
  analysis.scoreJudgementCount=total;
  analysis.missCount=counts&&Number.isFinite(miss)?Math.max(0,miss):countMisses(analysis.rows);
  analysis.totalPresses=Math.max(0,Number(totalPresses)||0);
  return analysis;
}
export function analyzeMania(map,presses,releases=[]) {
  const objects=map.objects.filter(o=>o.time>=0).sort((a,b)=>a.time-b.time);
  const pressesByLane=Array.from({length:map.keys},()=>[]),releasesByLane=Array.from({length:map.keys},()=>[]);
  for(const p of presses)if(p.lane>=0&&p.lane<map.keys)pressesByLane[p.lane].push(p);
  for(const r of releases)if(r.lane>=0&&r.lane<map.keys)releasesByLane[r.lane].push(r);
  for(const lane of pressesByLane)lane.sort((a,b)=>a.time-b.time);
  for(const lane of releasesByLane)lane.sort((a,b)=>a.time-b.time);
  const pressForObject=new Map(),usedPresses=new Set();
  for(let lane=0;lane<map.keys;lane++){
    const laneObjects=objects.filter(o=>o.column===lane),lanePresses=pressesByLane[lane];
    const assignment=matchOneToOne(laneObjects,lanePresses,o=>timedCandidates(lanePresses,o.time,150));
    assignment.itemEvent.forEach((eventIndex,objectIndex)=>{if(eventIndex<0)return;const press=lanePresses[eventIndex];pressForObject.set(laneObjects[objectIndex],press);usedPresses.add(press);});
  }
  const rows=objects.map(object=>{
    const press=pressForObject.get(object)||null;
    if(!press)return{index:0,time:object.time,offset:null,judgement:'MISS',type:object.type,miss:true,press:null,lane:object.column,endTime:object.endTime??object.time,release:null,releaseOffset:null,releaseJudgement:null,releaseMiss:false};
    const offset=Math.round(press.time-object.time);
    return{index:0,time:object.time,offset,judgement:maniaJudgement(offset,map.od),type:object.type,miss:false,press,lane:object.column,endTime:object.endTime??object.time,release:null,releaseOffset:null,releaseJudgement:null,releaseMiss:false};
  });
  const holdRows=rows.filter(row=>row.type==='hold'&&row.press&&!row.miss),usedReleases=new Set();
  for(let lane=0;lane<map.keys;lane++){
    const laneHolds=holdRows.filter(row=>row.lane===lane),laneReleases=releasesByLane[lane];
    const assignment=matchOneToOne(laneHolds,laneReleases,row=>{
      return timedCandidates(laneReleases,row.endTime,250,null,event=>event.time>=row.press.time,row);
    });
    assignment.itemEvent.forEach((eventIndex,rowIndex)=>{
      if(eventIndex<0)return;
      const row=laneHolds[rowIndex],release=laneReleases[eventIndex];
      const delta=release.time-row.endTime;
      row.release=release;row.releaseOffset=Math.round(delta);row.releaseJudgement=maniaJudgement(delta,map.od);
      row.releaseMiss=row.releaseJudgement==='MISS';usedReleases.add(release);
    });
  }
  for(const row of rows)if(row.type==='hold'&&row.press&&!row.release){row.releaseMiss=true;row.releaseJudgement='MISS';}
  rows.forEach((row,index)=>{row.index=index+1;});
  const matched=rows.filter(row=>!row.miss),abs=matched.map(row=>Math.abs(row.offset)).sort((a,b)=>a-b);
  const median=abs.length?abs[Math.floor(abs.length/2)]:null,mean=abs.length?abs.reduce((s,x)=>s+x,0)/abs.length:null;
  return{rows,objects,matched,unmatchedPresses:presses.length-usedPresses.size,unmatchedReleases:releases.length-usedReleases.size,matchedPresses:usedPresses.size,totalPresses:presses.length,missCount:countMisses(rows),median,mean,accuracy:objects.length?matched.length/objects.length*100:0,duration:Math.max(1,...objects.map(o=>o.endTime||o.time),...presses.map(p=>p.time),...releases.map(r=>r.time)),mode:3,keys:map.keys};
}
export function analyze(map,presses) {
  const allObjects=map.objects.filter(o=>o.time>=0).sort((a,b)=>a.time-b.time),objects=allObjects.filter(o=>o.type!=='spinner');
  const sortedPresses=[...presses].sort((a,b)=>a.time-b.time),tolerance=Math.max(30,(map.radius||32)*2);
  const assignment=matchOneToOne(objects,sortedPresses,object=>timedCandidates(sortedPresses,object.time,150,(press,target)=>{
    const has=Number.isFinite(target.x)&&Number.isFinite(target.y)&&Number.isFinite(press.x)&&Number.isFinite(press.y);
    const distance=has?Math.hypot(press.x-target.x,press.y-target.y):0;
    return distance<=tolerance?(distance/tolerance)*35:Infinity;
  }));
  const rows=objects.map((object,index)=>{
    const eventIndex=assignment.itemEvent[index];
    if(eventIndex<0)return{index:index+1,time:object.time,offset:null,type:object.type,miss:true,press:null};
    const press=sortedPresses[eventIndex];
    return{index:index+1,time:object.time,offset:Math.round(press.time-object.time),type:object.type,miss:false,press};
  });
  const matched=rows.filter(row=>!row.miss),abs=matched.map(row=>Math.abs(row.offset)).sort((a,b)=>a-b);
  const median=abs.length?abs[Math.floor(abs.length/2)]:null,mean=abs.length?abs.reduce((s,x)=>s+x,0)/abs.length:null;
  const matchedPresses=assignment.itemEvent.filter(index=>index>=0).length;
  return{rows,objects,matched,unmatchedPresses:presses.length-matchedPresses,matchedPresses,totalPresses:presses.length,missCount:countMisses(rows),median,mean,accuracy:objects.length?matched.length/objects.length*100:0,duration:Math.max(1,...allObjects.map(o=>o.endTime||o.time),...presses.map(p=>p.time)),unsupportedObjects:allObjects.filter(o=>o.type==='spinner').length};
}
