/**
 * Replay Lab 2.2.0 — evidence-first coaching diagnostics.
 * This module does not pretend to be a trained neural scorer.
 * It derives mode-aware observations from beatmap-matched replay rows.
 */
const finite = v => typeof v === 'number' && Number.isFinite(v);
const mean = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
const median = xs => {
  if (!xs.length) return null;
  const s=[...xs].sort((a,b)=>a-b);
  return s[Math.floor(s.length/2)];
};
const deviation = xs => {
  const m=mean(xs);
  return m===null ? null : Math.sqrt(mean(xs.map(x=>(x-m)**2)));
};
const modeOf = value => value===3 || value==='mania' ? 'mania' : value===0 || value==='standard' ? 'standard' : null;
const clock = ms => {
  const s=Math.max(0,Math.floor(ms/1000));
  return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
};

function makeSections(rows, windowMs=10000) {
  const buckets=new Map();
  for (const row of rows) {
    if (!finite(row.time)) continue;
    const key=Math.floor(row.time/windowMs);
    if (!buckets.has(key)) buckets.set(key,[]);
    buckets.get(key).push(row);
  }
  return [...buckets.entries()].sort((a,b)=>a[0]-b[0]).map(([key,items])=>{
    const valid=items.filter(r=>!r.miss&&finite(r.offset));
    const offsets=valid.map(r=>r.offset);
    return {
      start:key*windowMs,end:(key+1)*windowMs,count:items.length,matched:valid.length,
      missRate:items.length?(items.length-valid.length)/items.length:0,
      meanAbs:mean(offsets.map(Math.abs)),spread:deviation(offsets),bias:mean(offsets)
    };
  });
}

function patternRuns(rows, minNotes, maxGapMs, minCount) {
  const sorted=rows.filter(r=>finite(r.time)).sort((a,b)=>a.time-b.time);
  const runs=[]; let run=[];
  for (const row of sorted) {
    if (!run.length || row.time-run[run.length-1].time<=maxGapMs) run.push(row);
    else { if(run.length>=minNotes) runs.push(run); run=[row]; }
  }
  if(run.length>=minNotes) runs.push(run);
  return runs.filter(r=>r.length>=minCount);
}

export function analyzeReplayCoach(analysis, requestedMode) {
  const mode=modeOf(requestedMode ?? analysis?.mode);
  if (!mode) throw new Error('Coach supports Standard and Mania only.');
  const rows=Array.isArray(analysis?.rows)?analysis.rows:[];
  const valid=rows.filter(r=>!r.miss&&finite(r.offset));
  const offsets=valid.map(r=>r.offset);
  const abs=offsets.map(Math.abs);
  const sections=makeSections(rows);
  const strengths=[],weaknesses=[],recommendations=[];
  const add=(list,area,evidence)=>list.push({area,evidence});
  const addAdvice=(priority,title,text,evidence)=>recommendations.push({priority,title,text,evidence});

  if(valid.length<12) {
    addAdvice('high','Недостаточно данных','Для надёжного разбора нужно больше сопоставленных объектов. Сейчас выводы будут предварительными.',`Сопоставлено объектов: ${valid.length}`);
  } else {
    const med=median(abs),spread=deviation(offsets),bias=mean(offsets);
    if(med!==null && med<=25) add(strengths,'Точность тайминга',`Медиана |offset| ${med.toFixed(1)} мс.`);
    if(med!==null && med>=55) {
      add(weaknesses,'Точность тайминга',`Медиана |offset| ${med.toFixed(1)} мс.`);
      addAdvice('high','Точность попаданий','Разбери проблемные отрезки и сравни ранние/поздние нажатия. Не меняй общий audio offset по одному рану.',`Медиана |offset|: ${med.toFixed(1)} мс`);
    }
    if(spread!==null && spread<=22) add(strengths,'Ровность тайминга',`Стандартное отклонение offset: ${spread.toFixed(1)} мс.`);
    if(spread!==null && spread>=48) {
      add(weaknesses,'Стабильность тайминга',`Разброс offset: ${spread.toFixed(1)} мс.`);
      addAdvice('high','Стабильность ритма','Найди участки, где разброс резко растёт, и сравни их с ритмическим рисунком карты.',`SD offset: ${spread.toFixed(1)} мс`);
    }
    if(Math.abs(bias??0)>=18) addAdvice('medium',bias<0?'Преобладают ранние нажатия':'Преобладают поздние нажатия','Проверь, повторяется ли смещение на нескольких картах. Это может быть индивидуальный сдвиг, а не ошибка ритма.',`Средний signed offset: ${bias.toFixed(1)} мс`);
  }

  if(mode==='standard') {
    const aim=valid.map(r=>r.aimErrorPx).filter(finite);
    if(aim.length>=10) {
      const aimMedian=median(aim),aimP95=[...aim].sort((a,b)=>a-b)[Math.floor((aim.length-1)*.95)];
      if(aimMedian<=18) add(strengths,'Контроль aim',`Медианная ошибка курсора: ${aimMedian.toFixed(1)} px.`);
      if(aimMedian>=40) {
        add(weaknesses,'Контроль aim',`Медианная ошибка курсора: ${aimMedian.toFixed(1)} px.`);
        addAdvice('medium','Контроль наведения','Сравни ошибки на коротких и длинных перемещениях; проверь, не появляются ли лишние коррекции.',`Медиана: ${aimMedian.toFixed(1)} px; P95: ${aimP95.toFixed(1)} px`);
      }
    } else addAdvice('low','Aim пока не оценён','Для оценки aim нужны корректно сопоставленные координаты объектов и курсора на карте.',`Доступно координатных попаданий: ${aim.length}`);

    const streams=patternRuns(rows,8,160,8);
    const streamRows=streams.flat().filter(r=>!r.miss&&finite(r.offset));
    if(streamRows.length>=12) {
      const streamSpread=deviation(streamRows.map(r=>r.offset));
      if(streamSpread<=25) add(strengths,'Стабильность стримов',`Разброс offset в найденных плотных сериях: ${streamSpread.toFixed(1)} мс.`);
      if(streamSpread>=50) {
        add(weaknesses,'Стабильность стримов',`Разброс offset в плотных сериях: ${streamSpread.toFixed(1)} мс.`);
        addAdvice('high','Ровность стримов','Сравни начало и конец каждой длинной серии. Отдельно проверь, не растёт ли разброс к концу.',`Серий: ${streams.length}; нот: ${streamRows.length}; SD: ${streamSpread.toFixed(1)} мс`);
      }
    } else addAdvice('low','Стримы не оценены','В этом реплее недостаточно длинных плотных серий для вывода о стабильности стримов.',`Найдено длинных серий: ${streams.length}`);

    const bursts=patternRuns(rows,3,190,3).filter(r=>r.length<=7);
    if(bursts.length) {
      const burstRows=bursts.flat().filter(r=>!r.miss&&finite(r.offset));
      if(burstRows.length>=8) {
        const burstSpread=deviation(burstRows.map(r=>r.offset));
        if(burstSpread>=45) addAdvice('medium','Контроль бурстов','Проверь вход и выход из коротких серий: именно на переходах часто меняется тайминг.',`Бурстов: ${bursts.length}; SD offset: ${burstSpread.toFixed(1)} мс`);
      }
    }
  } else {
    const holds=rows.filter(r=>String(r.type||'').toLowerCase().includes('hold'));
    const releaseMisses=holds.filter(r=>r.releaseMiss).length;
    const lanes=new Map();
    for(const row of valid) if(Number.isInteger(row.lane)) {
      if(!lanes.has(row.lane)) lanes.set(row.lane,[]);
      lanes.get(row.lane).push(row.offset);
    }
    if(holds.length) {
      const rate=releaseMisses/holds.length;
      if(rate===0) add(strengths,'Удержание hold-нот',`Пропусков отпускания: 0 из ${holds.length}.`);
      if(rate>0) {
        add(weaknesses,'Удержание hold-нот',`Пропуски отпускания: ${releaseMisses} из ${holds.length}.`);
        addAdvice('high','Удержание hold','Проверь отпускание в конце длинных нот и на переходах между соседними дорожками.',`Release miss: ${releaseMisses}/${holds.length}`);
      }
    }
    const laneStats=[...lanes.entries()].map(([lane,xs])=>({lane,count:xs.length,spread:deviation(xs),mean:mean(xs)})).filter(x=>x.count>=6);
    if(laneStats.length>=2) {
      const worst=[...laneStats].sort((a,b)=>(b.spread??0)-(a.spread??0))[0];
      const best=[...laneStats].sort((a,b)=>(a.spread??0)-(b.spread??0))[0];
      if(worst.lane!==best.lane && (worst.spread??0)>(best.spread??0)+20)
        addAdvice('medium','Разница между дорожками','Сравни аппликатуру и нагрузку на дорожки: на одной из них тайминг заметно менее ровный.',`Lane ${worst.lane+1}: SD ${worst.spread.toFixed(1)} мс; lane ${best.lane+1}: SD ${best.spread.toFixed(1)} мс`);
    }
  }

  const weakest=[...sections].filter(s=>s.matched>=5).sort((a,b)=>(b.meanAbs??0)-(a.meanAbs??0)).slice(0,3)
    .map(s=>({start:s.start,end:s.end,count:s.matched,meanAbs:s.meanAbs,missRate:s.missRate}));
  if(weakest.length) addAdvice('medium','Проблемные участки','Начни разбор с этих отрезков и проверь, какой паттерн вызывает просадку.',weakest.map(s=>`${clock(s.start)}–${clock(s.end)}: |offset| ${s.meanAbs?.toFixed(1)??'—'} мс, misses ${Math.round(s.missRate*100)}%`).join(' · '));

  const sampleConfidence=valid.length>=100?'high':valid.length>=30?'medium':'low';
  return {
    version:'2.2.0-coach-alpha',mode,sampleCount:valid.length,confidence:sampleConfidence,
    strengths,weaknesses,recommendations:recommendations.slice(0,6),sections,weakestSections:weakest,
    limitations:['Диагностика основана на измеримых событиях этого реплея, а не на общем рейтинге игрока.','Распознавание серий использует интервалы объектов карты; сложные паттерны требуют дополнительной классификации.','Это не результат обученной supervised-модели.']
  };
}
