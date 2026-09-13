# Воспроизведение расчёта 0108

## Запуск

Использован Node **v24.3.0** (встроенный `node:sqlite`, без сторонних модулей).
В назначенном рабочем дереве создать `.matchlog/0108-tesla-repeat-orders.mjs`
с полным содержимым блока JavaScript ниже. Все входы открываются только с
`readOnly: true`; неверный путь вызывает ошибку, не создаёт SQLite.
Промежуточные выходы пишутся только в `.matchlog/` текущего дерева.
Они не входят в коммит и могут быть заново получены из этого документа.

Каждый вызов — отдельная команда из назначенного дерева:

```powershell
node .matchlog/0108-tesla-repeat-orders.mjs
```

```powershell
node .matchlog/0108-tesla-repeat-orders.mjs
```

Основной выход — `.matchlog/0108-calculated-v2.json`: паспорт со схемой и
PRAGMA, проверки, 60 пар, все последовательности и экономические окна,
все sample-срезы и интервалы исчезновения/возврата клеток. Обозначение v2
относится к временному файлу расчёта, не версии схемы базы.
`.matchlog/0108-brief.json` содержит сокращённую сводку,
`.matchlog/0108-tables.md` — числовое приложение results.md,
`.matchlog/0108-raw-checks.json` — независимые SQL-срезы для ручной сверки.
Повтор сверяет основной JSON и Markdown с предыдущим выходом побайтно
и бросает исключение при расхождении. При воспроизведении на других входах
нельзя использовать оставшиеся выходы как новую контрольную линию.

Все SELECT, PRAGMA и агрегирование приведены внутри скрипта. Общая выборка
включает матчи без заказов. До сравнения проверяются footer, уникальность
world_seed/sample/decision и равенство обоих ai_seed и профилей в каждой паре.
Непригодные/непарные записи в этих входах отсутствуют; на других данных скрипт
останавливается, а не произвольно выбирает дубликат.

## Проверенная историческая семантика

Источники прочитаны через Git, без запуска исторического игрового кода:

```powershell
git -C . show 0ddd2fc9:apps/arena/src/records.ts
```

```powershell
git -C . show 0ddd2fc9:apps/arena/src/ingest.ts
```

```powershell
git -C . show 0ddd2fc9:apps/arena/src/match.ts
```

```powershell
git -C . show 0ddd2fc9:packages/ai/src/opponent.ts
```

```powershell
git -C . show 0ddd2fc9:packages/ai/src/profile.ts
```

```powershell
git -C . show 0ddd2fc9:packages/ai/src/observer.ts
```

```powershell
git -C . show 0ddd2fc9:packages/shared/src/balance.ts
```

```powershell
git -C . show 0ddd2fc9:packages/shared/src/constants.ts
```

```powershell
git -C . show 0ddd2fc9:packages/shared/src/commands.ts
```

```powershell
git -C . show 0ddd2fc9:packages/shared/src/matchlog.ts
```

```powershell
git -C . diff --stat 0ddd2fc9 77c796cb
```

```powershell
git -C . diff 0ddd2fc9 77c796cb -- packages/ai/src apps/arena/src/records.ts apps/arena/src/ingest.ts apps/arena/src/schema.ts apps/arena/src/match.ts packages/shared/src/commands.ts packages/shared/src/matchlog.ts
```

```powershell
git -C . diff 0ddd2fc9 77c796cb -- packages/shared/src/balance.ts packages/shared/src/rules.ts packages/sim/src/combat.ts apps/arena/src/main.ts
```

- constants: 30 тиков/с. balance: ENERGY_SCALE=30, BASE_UNIT_COST=energy(25),
  Tesla=2, базовая цена ×10 = 7500 внутренних единиц. Это не универсальная
  цена любой попытки: прокачка типа и резерв могут её поднять.
- commands/matchlog: TrainUnit=2, arg0 — unitType.
- records/ingest: footer переносится в match; отсутствующий footer даёт null.
  Пустой массив towers не создаёт строк в tower. Сетка tower — 300 тиков,
  sample — 30; фактический счёт клеток сверяется с sample.towers.
- match: decision записывается на world.tick, принятая command — на next.tick,
  то есть **decision.tick=command.tick−1**. Срезы attempt привязаны к decision,
  а не к тикам принятия команды. sample пишется после шага.
- sampleOf/towersOf: недострой включён; ID постройки и её здоровье в tower
  отсутствуют. Клетка и интервал между кадрами не задают точную жизнь башни.
- observer/opponent: bought — выдана покупка, wait — накопление, pass — пропуск;
  saving-for-better — уступка более выгодному накоплению, unit-unaffordable —
  цена выбранного юнита с резервом превышает энергию. bought в attempt сам
  по себе не заменяет accepted в command.
- opponent: успешная покупка сбрасывает wait_streak; impatient вычисляется
  до изменения счётчика, record снимает счётчик после решения. Поэтому
  wait_streak в записи нельзя заново сравнить с порогом и выдать за
  исторический impatient: используется записанный флаг.
- profile: у осадного в поздней фазе mix только Tesla, reserve none; ранние
  фазы и другие ветви выбора не идентифицируются одним числом price.
  Порядок трат может переупорядочиваться по выгоде; обычный tryTrain заново
  разыгрывает тип. pushed пропускает обычный цикл покупок.
- Diff рабочих алгоритмов AI и записи между A/B пуст; в AI есть только
  изменение комментария siege.match.test.ts. Изменения игровых правил
  сосредоточены в награде за добивающий удар постройке. Параметры tuning
  в базах не сохранены, поэтому их значение не объявляется измеренным.

## Независимые проверки и ручная сверка

SQL LEFT JOIN/GROUP BY в переменной independent считает C отдельно от
поматчевого массива команд и проверяет каждую из 120 строк. Отдельный
GROUP BY player/accepted дал A: сторона 0 — 110/27, сторона 1 — 6/6;
B: 0 — 92/28, 1 — 6/4. Отклонённых Tesla-команд нет.
Суммы R проверяются тождествами C=I+R и R=R_prefix+R_tail в каждой паре.
Итоги: C 110/92, I 27/28, R 83/64; ΔR=−9−10=−19.
SHA256 до/после, quick_check и повторные выходы совпали.

Отдельные запросы в rawChecks не используют вычисленные окна. Ручная сверка
их вывода с таблицами проведена для детерминированно выбранных миров:

| Мир | Проверенные исходные строки | Результат |
| --- | --- | --- |
| 15 | A: заказы 7726, 19861, …, 32086, всего 14; B: нет | Второй заказ A позже H=12277; R-tail A=13 |
| 15 | B decision/attempt(12270): energy 4633, wait_streak 18, train/wait, price 7650; build/general-dead | Последняя запись подтверждает нехватку для выбранной покупки, не отказ command |
| 47 | A: 11461, 11476, 15736; B: 12436, 26386, …, 35476, всего 14 | Первые два A разделены 15 тиками; второй B позже H=17089 |
| 47 | A(17085): build/wait 1800, train/pass saving-for-better; B(35985): train/wait 11367 при energy 7324 | Причины отсутствия следующей покупки различаются |
| 4 | A: нет заказов; B: 17131; B(17610): energy 2053, train/wait 8787 | R=0/0, последняя попытка не означает состоявшийся второй заказ |
| 15 | A, enemy cell 1090: есть на 7800, нет на 8100 | Исчезновение в (7800,8100] |
| 47 | B, own cell 575: есть на 12600, нет на 12900 | Исчезновение в (12600,12900] |

Полные последовательности всех миров и полные строки покупок контрольных
миров сохранены в results.md. Полные интервалы клеток, все окна и числа
снимков каждого окна сохраняет основной JSON; никакой обрезки исходных
таблиц для агрегирования нет. Первые три исчезновения в текстовых примерах —
иллюстрация, не ограничение расчёта.

## Полный расчёт

```javascript
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const TPS = 30;
const out = '.matchlog/0108-calculated-v2.json';
const hash = async (path) => {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
};
const sum = (a) => a.reduce((s, n) => s + n, 0);
const stat = (values) => {
  const a = values.filter((x) => x !== null).sort((a, b) => a - b);
  const q = (p) => {
    const i = (a.length - 1) * p;
    return a.length ? a[Math.floor(i)] + (a[Math.ceil(i)] - a[Math.floor(i)]) * (i % 1) : null;
  };
  return { n:a.length, mean:a.length?sum(a)/a.length:null, min:a[0]??null, p10:q(.1), median:q(.5), p90:q(.9), max:a.at(-1)??null };
};
const hist = (a, f = (x) => x) => {
  const h = {};
  for (const x of a) { const k = f(x); h[k] = (h[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(h).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
};
const group = (m) => m.C === 0 ? '0' : m.C === 1 ? '1' : '2+';
const R = (c) => Math.max(0, c - 1);
const sources = [];
for (const [label, run] of [['A', '33601228714'], ['B', '33601225558']]) {
  const path = `C:/src/dezintegra/TD_Game/.matchlog/pipeline-${run}/.matchlog/arena.sqlite`;
  const before = await hash(path);
  const db = new DatabaseSync(path, { readOnly: true });
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const schema = all("select name, sql from sqlite_master where type='table' order by name");
  const columns = Object.fromEntries(schema.map(({name}) => [name, all(`pragma table_info(${name})`)]));
  const raw = all('select * from match order by world_seed, match_id');
  const independent = all(`select m.world_seed, count(c.rowid) C from match m left join command c
    on c.match_id=m.match_id and c.player=case when m.profile_0='siege-2026-08' then 0 else 1 end
    and c.kind=2 and c.arg0=2 and c.accepted=1 group by m.world_seed order by m.world_seed`);
  assert.equal(new Set(raw.map(m => m.world_seed)).size, raw.length);
  const matches = raw.map((m, index) => {
    assert.equal(m.kind,'arena'); assert.equal(m.git_dirty,0);
    assert.ok(Number.isInteger(m.ticks) && m.ticks>0 && m.end_reason!==null && m.wall_ms!==null);
    const side=m.profile_0==='siege-2026-08'?0:1;
    assert.equal(m[`profile_${side}`],'siege-2026-08'); assert.equal(m[`profile_${1-side}`],'baseline-2026-08');
    const commands=all('select rowid,* from command where match_id=? and player=? and kind=2 and arg0=2 order by tick,rowid',m.match_id,side);
    const ticks=commands.filter(c=>c.accepted===1).map(c=>c.tick);
    assert.ok(ticks.every(t=>t<=m.ticks));
    const samples=[0,1].map(p=>all('select * from sample where match_id=? and player=? order by tick,rowid',m.match_id,p));
    for(const ss of samples){assert.equal(new Set(ss.map(s=>s.tick)).size,ss.length);assert.ok(ss.every(s=>s.tick<=m.ticks));}
    const decisions=all('select * from decision where match_id=? and player=? order by tick,rowid',m.match_id,side);
    assert.equal(new Set(decisions.map(d=>d.tick)).size,decisions.length);
    const attempts=all('select * from attempt where match_id=? and player=? order by tick,ord,rowid',m.match_id,side);
    const towers=[0,1].map(p=>all('select * from tower where match_id=? and player=? order by tick,cell,rowid',m.match_id,p));
    const C=ticks.length;
    assert.equal(C,independent[index].C);assert.equal(m.world_seed,independent[index].world_seed);
    return {...m,side,C,I:Number(C>0),R:R(C),orders:ticks,rejected:commands.filter(c=>c.accepted!==1),first:ticks[0]??null,second:ticks[1]??null,last:ticks.at(-1)??null,
      gaps:ticks.slice(1).map((t,i)=>t-ticks[i]),firstToEnd:C?m.ticks-ticks[0]:null,lastToEnd:C?m.ticks-ticks.at(-1):null,samples,decisions,attempts,towers};
  });
  const checks={independent,commands:all('select player,accepted,count(*) n,count(distinct match_id) matches from command where kind=2 and arg0=2 group by player,accepted order by player,accepted'),sampleSteps:all('select delta,count(*) n from (select tick-lag(tick) over(partition by match_id,player order by tick) delta from sample) where delta is not null group by delta order by delta'),integrity:all('pragma quick_check')};
  db.close(); const after=await hash(path);assert.equal(before,after);
  sources.push({label,run,path,before,after,schema,columns,checks,matches});
}
const [A,B]=sources;
assert.equal(A.matches.length,60);assert.equal(B.matches.length,60);
const pairs=A.matches.map((a,i)=>{
  const b=B.matches[i];
  for(const k of ['world_seed','ai_seed_0','ai_seed_1','profile_0','profile_1'])assert.equal(a[k],b[k]);
  const H=Math.min(a.ticks,b.ticks),ca=a.orders.filter(t=>t<=H).length,cb=b.orders.filter(t=>t<=H).length;
  const row={seed:a.world_seed,H,a,b,deltaC:b.C-a.C,deltaR:b.R-a.R,deltaTicks:b.ticks-a.ticks,prefixCA:ca,prefixCB:cb,prefixRA:R(ca),prefixRB:R(cb),tailCA:a.C-ca,tailCB:b.C-cb,tailRA:a.R-R(ca),tailRB:b.R-R(cb)};
  assert.equal(row.deltaR,row.prefixRB-row.prefixRA+row.tailRB-row.tailRA);return row;
});
const sampleAt=(m,p,t)=>{
  if(t===null||t>m.ticks||t<0)return null;
  const s=m.samples[p].findLast(s=>s.tick<=t);return s&&t-s.tick<=TPS?s:null;
};
const afterLast=(m,p)=>{
  if(m.last===null)return null;
  const s=m.samples[p].find(s=>s.tick>m.last&&s.tick<=m.ticks);return s&&s.tick-m.last<=TPS?s:null;
};
const snapshots=[];
for(const point of ['beforeFirst','beforeSecond','afterLast','H','300s','600s'])for(const role of ['own','enemy']){
  const rows=pairs.map(p=>{
    const get=m=>{
      const side=role==='own'?m.side:1-m.side;
      if(point==='afterLast')return afterLast(m,side);
      const t=point==='beforeFirst'?(m.first===null?null:m.first-1):point==='beforeSecond'?(m.second===null?null:m.second-1):point==='H'?p.H:point==='300s'?9000:18000;
      return sampleAt(m,side,t);
    };return {seed:p.seed,a:get(p.a),b:get(p.b)};
  });
  snapshots.push({point,role,metrics:Object.fromEntries(['towers','energy','income_per_tick','queue_len','base_hp'].map(k=>[k,{A:stat(rows.map(o=>o.a?.[k]??null)),B:stat(rows.map(o=>o.b?.[k]??null)),pairedDelta:stat(rows.filter(o=>o.a&&o.b).map(o=>o.b[k]-o.a[k]))}])),rows});
}
const windowSummary=(m,start,end)=>{
  if(start===null||end===null)return null;
  const ds=m.decisions.filter(d=>d.tick+1>start&&d.tick+1<end),ats=m.attempts.filter(d=>d.tick+1>start&&d.tick+1<end),ss=m.samples[m.side].filter(d=>d.tick>start&&d.tick<end);
  return {start,end,seconds:(end-start)/TPS,decisions:ds.length,energy:stat(ds.map(d=>d.energy)),wait:stat(ds.map(d=>d.wait_streak)),impatient:sum(ds.map(d=>d.impatient)),pushed:sum(ds.map(d=>d.pushed)),phase:hist(ds,d=>d.phase_index),spendOrder:hist(ds,d=>d.spend_order),attempts:hist(ats,a=>[a.spending,a.result,a.note??'-'].join('/')),sampleN:ss.length,queue:stat(ss.map(s=>s.queue_len)),income:stat(ss.map(s=>s.income_per_tick)),trainReached:new Set(ats.filter(a=>a.spending==='train'&&a.note!=='saving-for-better').map(a=>a.tick)).size};
};
const windows=sources.map(s=>({label:s.label,matches:s.matches.map(m=>({seed:m.world_seed,firstSecond:windowSummary(m,m.first,m.second),lastEnd:windowSummary(m,m.last,m.ticks)}))}));
// Пустой towers-кадр теряется при ingest. Проверяем его через sample.
const cellsDuring=(m,p,end)=>{
  if(m.first===null||end===null)return null;
  const frames=[];
  for(let t=Math.ceil(m.first/300)*300;t<=end;t+=300){
    const cells=m.towers[p].filter(r=>r.tick===t).map(r=>r.cell),ss=m.samples[p].filter(s=>s.tick===t);
    frames.push({tick:t,cells,valid:ss.length===1&&cells.length===new Set(cells).size&&cells.length===ss[0].towers});
  }
  const vanished=[],reappeared=[],missing=frames.filter(f=>!f.valid).map(f=>f.tick),gone=new Set();
  for(let i=1;i<frames.length;i++){
    const prev=frames[i-1],cur=frames[i];if(!prev.valid||!cur.valid)continue;
    for(const cell of prev.cells)if(!cur.cells.includes(cell)){vanished.push({cell,after:prev.tick,by:cur.tick});gone.add(cell);}
    for(const cell of cur.cells)if(!prev.cells.includes(cell)&&gone.has(cell))reappeared.push({cell,after:prev.tick,by:cur.tick});
  }
  const initial=frames[0]?.valid?frames[0].cells:null;
  return {n:frames.length,first:frames[0]??null,last:frames.at(-1)??null,missing,vanished,reappeared,initialCells:initial?.length??null,continuouslyPresent:initial&&!missing.length?initial.filter(c=>frames.every(f=>f.cells.includes(c))).length:null};
};
const cells=sources.map(s=>({label:s.label,rows:s.matches.filter(m=>m.C).map(m=>({seed:m.world_seed,ownSecond:cellsDuring(m,m.side,m.second),enemySecond:cellsDuring(m,1-m.side,m.second),ownEnd:cellsDuring(m,m.side,m.ticks),enemyEnd:cellsDuring(m,1-m.side,m.ticks)}))}));
const summary=sources.map(s=>{
  const mm=s.matches,C=sum(mm.map(m=>m.C)),I=sum(mm.map(m=>m.I)),repeats=sum(mm.map(m=>m.R));assert.equal(C,I+repeats);
  return {label:s.label,N:mm.length,C,I,R:repeats,CperN:C/mm.length,IperN:I/mm.length,RperN:repeats/mm.length,CperI:C/I,histogram:hist(mm,m=>m.C),duration:stat(mm.map(m=>m.ticks/TPS)),outcomes:hist(mm,m=>`${m.end_reason}/${m.winner}`),groups:Object.fromEntries(['0','1','2+'].map(g=>{const x=mm.filter(m=>group(m)===g);return[g,{n:x.length,duration:stat(x.map(m=>m.ticks/TPS)),outcomes:hist(x,m=>`${m.end_reason}/${m.winner}`),first:stat(x.map(m=>m.first===null?null:m.first/TPS)),firstToEnd:stat(x.map(m=>m.firstToEnd===null?null:m.firstToEnd/TPS))}]})),first:stat(mm.map(m=>m.first===null?null:m.first/TPS)),gaps:stat(mm.flatMap(m=>m.gaps).map(t=>t/TPS)),lastToEnd:stat(mm.map(m=>m.lastToEnd===null?null:m.lastToEnd/TPS))};
});
const paired={n:pairs.length,unpaired:[],ineligible:[],deltaR:hist(pairs,p=>p.deltaR),deltaC:hist(pairs,p=>p.deltaC),duration:stat(pairs.map(p=>p.deltaTicks/TPS)),durationDirection:hist(pairs,p=>Math.sign(p.deltaTicks)),repeatDirection:hist(pairs,p=>Math.sign(p.deltaR)),transitions:hist(pairs,p=>`${group(p.a)} -> ${group(p.b)}`),decomposition:Object.fromEntries(['prefixCA','prefixCB','prefixRA','prefixRB','tailCA','tailCB','tailRA','tailRB','deltaC','deltaR'].map(k=>[k,sum(pairs.map(p=>p[k]))])),ranked:pairs.map(p=>({seed:p.seed,deltaR:p.deltaR,deltaC:p.deltaC,deltaSeconds:p.deltaTicks/TPS})).sort((a,b)=>a.deltaR-b.deltaR||a.seed-b.seed)};
const examples=[paired.ranked[0].seed,[...paired.ranked].sort((a,b)=>b.deltaR-a.deltaR||a.seed-b.seed)[0].seed,paired.ranked.filter(p=>p.deltaR===0).sort((a,b)=>a.seed-b.seed)[0].seed];
const detail=examples.map(seed=>({seed,lines:sources.map(s=>{const m=s.matches.find(m=>m.world_seed===seed);return {label:s.label,orders:m.orders,events:m.orders.map(t=>({tick:t,decision:m.decisions.filter(d=>d.tick===t-1),attempts:m.attempts.filter(a=>a.tick===t-1)})),lastDecisions:m.decisions.slice(-3),lastAttempts:m.attempts.filter(a=>a.tick>=m.ticks-45),tower:cells.find(c=>c.label===s.label).rows.find(r=>r.seed===seed)??null};})}));
const passport=sources.map(({matches,...s})=>({...s,node:process.version,versions:hist(matches,m=>`${m.git_sha}/dirty=${m.git_dirty}`),profiles:hist(matches,m=>`${m.profile_0}/${m.profile_1}`),footers:matches.length}));
const compact=(m)=>{const {samples,decisions,attempts,towers,...r}=m;return r;};
const perWorld=pairs.map(p=>({...p,a:compact(p.a),b:compact(p.b)}));
const result={passport,summary,paired,perWorld,snapshots,windows,cells,detail};
const json=JSON.stringify(result,null,2)+'\n';
if(existsSync(out))assert.equal(json,readFileSync(out,'utf8'),'repeat differs');
writeFileSync(out,json);
const addHist=(rows,key)=>{const h={};for(const r of rows)for(const [k,n] of Object.entries(r[key]))h[k]=(h[k]??0)+n;return h;};
const aggregateWindows=windows.flatMap(w=>['firstSecond','lastEnd'].map(kind=>{
  const rows=w.matches.map(m=>m[kind]).filter(Boolean);
  const weighted=k=>sum(rows.map(r=>(r[k].mean??0)*r[k].n))/sum(rows.map(r=>r[k].n));
  return {label:w.label,kind,n:rows.length,seconds:sum(rows.map(r=>r.seconds)),decisions:sum(rows.map(r=>r.decisions)),trainReached:sum(rows.map(r=>r.trainReached)),impatient:sum(rows.map(r=>r.impatient)),pushed:sum(rows.map(r=>r.pushed)),energy:weighted('energy'),wait:weighted('wait'),queue:weighted('queue'),income:weighted('income'),attempts:addHist(rows,'attempts'),phase:addHist(rows,'phase'),spendOrder:addHist(rows,'spendOrder')};
}));
const cellSummary=cells.flatMap(c=>['ownSecond','enemySecond','ownEnd','enemyEnd'].map(k=>{
  const rr=c.rows.map(r=>r[k]).filter(r=>r&&r.n>=2);
  return {label:c.label,kind:k,n:rr.length,frames:sum(rr.map(r=>r.n)),invalid:sum(rr.map(r=>r.missing.length)),vanished:sum(rr.map(r=>r.vanished.length)),reappeared:sum(rr.map(r=>r.reappeared.length)),initial:sum(rr.map(r=>r.initialCells)),continuous:sum(rr.map(r=>r.continuouslyPresent))};
}));
const brief={passport:passport.map(p=>({label:p.label,path:p.path,sha:p.versions,hash:p.before,node:p.node,profiles:p.profiles,footers:p.footers,checks:{commands:p.checks.commands,sampleSteps:p.checks.sampleSteps,integrity:p.checks.integrity}})),summary,paired,snapshots:snapshots.map(({rows,...s})=>s),aggregateWindows,cellSummary,examples:perWorld.filter(p=>examples.includes(p.seed)),detail};
writeFileSync('.matchlog/0108-brief.json',JSON.stringify(brief,null,2)+'\n');
console.log(JSON.stringify({hashes:passport.map(p=>p.before),aggregateWindows,cellSummary,examples},null,2));

// Таблицы для записки: JSON выше сохраняет также все исходные срезы.
const fmt=x=>x===null||x===undefined?'—':typeof x==='number'?Number(x.toFixed(3)):String(x);
const table=(headers,rows)=>[headers,headers.map(()=> '---'),...rows].map(r=>'| '+r.map(fmt).join(' | ')+' |').join('\n')+'\n';
let md='## Числовое приложение\n\nВсе времена здесь в тиках, кроме столбцов с явной пометкой «с». A — контроль, B — награда. Пустое событие обозначено «—», не нулём. Квантили линейные, позиция `(n−1)×q`.\n\n';
md+='### Заказы и длительность\n\n'+table(['Линия','N','C','I','R','C/N','I/N','R/N','C/I'],summary.map(s=>[s.label,s.N,s.C,s.I,s.R,s.CperN,s.IperN,s.RperN,s.CperI]));
md+='\n'+table(['C','матчей A','матчей B'],Array.from({length:19},(_,i)=>[i,summary[0].histogram[i]??0,summary[1].histogram[i]??0]));
md+='\n'+table(['Линия / группа C','n','среднее, с','p10, с','медиана, с','p90, с','победа осадного','поражение','timeout'],summary.flatMap(s=>[['все',{n:s.N,duration:s.duration,outcomes:s.outcomes}],...Object.entries(s.groups)].map(([g,r])=>[s.label+' / '+g,r.n,r.duration.mean,r.duration.p10,r.duration.median,r.duration.p90,r.outcomes['base-destroyed/0']??0,r.outcomes['base-destroyed/1']??0,r.outcomes['timeout/null']??0])));
md+='\n'+table(['Линия / событие','n','среднее, с','медиана, с','p10, с','p90, с'],summary.flatMap(s=>['first','gaps','lastToEnd'].map(k=>[s.label+' / '+k,s[k].n,s[k].mean,s[k].median,s[k].p10,s[k].p90])));
md+='\nfirst — тик первого заказа от начала; gaps — интервалы между последовательными заказами (знаменатель: интервалы, не матчи); lastToEnd — остаток после последнего.\n\n';
md+=table(['Линия / окно','n матчей','среднее, с','медиана, с','p10, с','p90, с'],windows.flatMap(w=>['firstSecond','lastEnd'].map(k=>{const st=stat(w.matches.map(m=>m[k]?.seconds??null));return[w.label+' / '+k,st.n,st.mean,st.median,st.p10,st.p90];})));
md+='\n### Парные миры и разложение\n\n'+table(['Показатель','A','B','B−A'],[['C до H',paired.decomposition.prefixCA,paired.decomposition.prefixCB,paired.decomposition.prefixCB-paired.decomposition.prefixCA],['C за H',paired.decomposition.tailCA,paired.decomposition.tailCB,paired.decomposition.tailCB-paired.decomposition.tailCA],['R до H',paired.decomposition.prefixRA,paired.decomposition.prefixRB,paired.decomposition.prefixRB-paired.decomposition.prefixRA],['R за H',paired.decomposition.tailRA,paired.decomposition.tailRB,paired.decomposition.tailRB-paired.decomposition.tailRA]]);
md+='\n'+table(['Группа A → B','n'],Object.entries(paired.transitions));
md+='\n'+table(['ΔR','миров'],Object.entries(paired.deltaR).sort(([a],[b])=>Number(a)-Number(b)));
md+='\n'+table(['seed','H','конец A','конец B','C A/B','R A/B','R префикс A/B','R хвост A/B','ΔR'],pairs.map(p=>[p.seed,p.H,p.a.ticks,p.b.ticks,`${p.a.C}/${p.b.C}`,`${p.a.R}/${p.b.R}`,`${p.prefixRA}/${p.prefixRB}`,`${p.tailRA}/${p.tailRB}`,p.deltaR]));
md+='\n### Последовательности всех матчей\n\nВ обеих базах идентификатор мира s равен `s{s}-siege-2026-08-vs-baseline-2026-08`. Строки ниже обозначают оба match_id без сокращения ключа соединения: соединение проверено по world_seed и обоим ai_seed, а не по имени.\n\n';
md+=table(['seed','ai_seed_0','ai_seed_1'],A.matches.map(m=>[m.world_seed,m.ai_seed_0,m.ai_seed_1]));
md+='\n'+table(['seed','линия','match_id','конец / причина / победитель','тики заказов (первый, второй, … последний)','интервалы','от первого до конца','от последнего до конца'],pairs.flatMap(p=>[['A',p.a],['B',p.b]].map(([label,m])=>[p.seed,label,m.match_id,`${m.ticks} / ${m.end_reason} / ${m.winner??'null'}`,m.orders.join(', ')||'—',m.gaps.join(', ')||'—',m.firstToEnd,m.lastToEnd])));
md+='\n### Снимки обороны и экономики\n\nДля beforeFirst/beforeSecond последний sample строго перед командой (отсечка tick−1), для afterLast — первый строго после неё. Возраст не более 30 тиков; sample не позднее footer. Для H/300s/600s — последний sample не позже отсечки. Парные строки включают только миры с двумя пригодными снимками; отдельные n A/B показаны для контроля пропусков. Условные события происходят в разное время и отбирают заказавшие матчи. energy — внутренние единицы, income_per_tick — внутренние единицы за тик (численно видимый доход за секунду), queue_len — снимок очереди. towers включает недострой.\n\n';
md+=table(['точка','сторона','метрика','n A','n B','пар n','A среднее в парах','B среднее в парах','Δ среднее','Δ медиана'],snapshots.flatMap(s=>Object.entries(s.metrics).map(([k,v])=>{const rr=s.rows.filter(r=>r.a&&r.b);return[s.point,s.role,k,v.A.n,v.B.n,rr.length,stat(rr.map(r=>r.a[k])).mean,stat(rr.map(r=>r.b[k])).mean,v.pairedDelta.mean,v.pairedDelta.median];})));
md+='\n### Ограничения покупок\n\nfirstSecond — только матчи со вторым заказом (A 23, B 25); lastEnd — только заказавшие (A 27, B 28). Решения и попытки внутри открытого интервала: start < decision.tick+1 < end. Смещение +1 следует из исторического match.ts: команда записана после шага, решение — до него. Снимки берутся start < sample.tick < end. Средние энергии/ожидания взвешены количеством решений, дохода/очереди — количеством снимков; это разные, условные выборки.\n\n';
md+=table(['линия','окно','матчей','наблюдение, с','решений','train достигнут','energy средняя','wait_streak средний','income средний','queue средняя','impatient','pushed'],aggregateWindows.map(w=>[w.label,w.kind,w.n,w.seconds,w.decisions,w.trainReached,w.energy,w.wait,w.income,w.queue,w.impatient,w.pushed]));
md+='\n'+table(['линия','окно','attempt spending/result/note','n'],aggregateWindows.flatMap(w=>Object.entries(w.attempts).sort(([a],[b])=>a.localeCompare(b)).map(([k,n])=>[w.label,w.kind,k,n])));
md+='\n'+table(['линия','окно','phase_index','n решений'],aggregateWindows.flatMap(w=>Object.entries(w.phase).map(([k,n])=>[w.label,w.kind,k,n])));
md+='\n'+table(['линия','окно','spend_order','n решений'],aggregateWindows.flatMap(w=>Object.entries(w.spendOrder).map(([k,n])=>[w.label,w.kind,k,n])));
md+='\n### Клетки башен\n\nОт первого кадра сетки 300 тиков не раньше первого заказа до последнего кадра не позже второго заказа/конца. Это укороченный наблюдаемый интервал: до 10 с на каждом краю не покрыто. Включены только интервалы с >=2 кадрами. Пустые tower-кадры утрачены ingest; число клеток сверено с sample.towers на той же сетке. Несовпадение означает пропуск, а не гибель. initial — клетки первого кадра; continuous — присутствовали во всех кадрах (не доказательство жизни одной башни); vanished/reappeared — события исчезновения/повторного появления клеток, включая новые клетки. Выборки и время экспозиции различны; отношения этих сумм не являются оценкой вероятности выживания башни.\n\n';
md+=table(['линия','интервал/сторона','матчей','кадров','непригодных','initial','continuous','vanished','reappeared'],cellSummary.map(c=>[c.label,c.kind,c.n,c.frames,c.invalid,c.initial,c.continuous,c.vanished,c.reappeared]));
md+='\n### Контрольные миры\n\nВыбор: минимум ΔR, максимум ΔR, равенство ΔR; при равенстве меньшее зерно. Получены 15, 47, 4.\n\n';
for(const seed of examples){
  md+=`#### Мир ${seed}\n\n`;
  md+=table(['линия','точка','тик sample own/enemy','башни own/enemy','energy own','income own','queue own'],['A','B'].flatMap((l,i)=>['beforeFirst','beforeSecond','afterLast','H'].map(point=>{const own=snapshots.find(s=>s.point===point&&s.role==='own').rows.find(r=>r.seed===seed)[i?'b':'a'],enemy=snapshots.find(s=>s.point===point&&s.role==='enemy').rows.find(r=>r.seed===seed)[i?'b':'a'];return[l,point,`${own?.tick??'—'}/${enemy?.tick??'—'}`,`${own?.towers??'—'}/${enemy?.towers??'—'}`,own?.energy,own?.income_per_tick,own?.queue_len];})));
  md+='\n'+table(['линия','command.tick','decision.tick','energy','phase','wait','pushed','spend_order','attempts'],detail.find(d=>d.seed===seed).lines.flatMap(l=>l.events.map(e=>{assert.equal(e.decision.length,1);const d=e.decision[0];return[l.label,e.tick,d.tick,d.energy,d.phase_index,d.wait_streak,d.pushed,d.spend_order,e.attempts.map(a=>`${a.spending}/${a.result}/${a.note??'-'}`).join('; ')];})));
  md+='\n'+table(['линия','последние decision.tick','energy','wait','impatient','phase','spend_order','attempts (price)'],detail.find(d=>d.seed===seed).lines.flatMap(l=>l.lastDecisions.map(d=>[l.label,d.tick,d.energy,d.wait_streak,d.impatient,d.phase_index,d.spend_order,l.lastAttempts.filter(a=>a.tick===d.tick).map(a=>`${a.spending}/${a.result}/${a.note??'-'} (${a.price??'—'})`).join('; ')])));
  md+='\n'+table(['линия','сторона/окно','кадры от/до','initial/continuous','первые 3 исчезновения: клетка (после,к тiku]','первые 3 возврата'],cells.flatMap(c=>{const r=c.rows.find(r=>r.seed===seed);if(!r)return[];return['ownSecond','enemySecond','ownEnd','enemyEnd'].map(k=>{const z=r[k];return[c.label,k,z?`${z.first?.tick??'—'}/${z.last?.tick??'—'}`:'—',z?`${z.initialCells??'—'}/${z.continuouslyPresent??'—'}`:'—',z?.vanished.slice(0,3).map(v=>`${v.cell} (${v.after},${v.by}]`).join('; ')||'—',z?.reappeared.slice(0,3).map(v=>`${v.cell} (${v.after},${v.by}]`).join('; ')||'—'];});}));
  md+='\n';
}
if(existsSync('.matchlog/0108-tables.md'))assert.equal(md,readFileSync('.matchlog/0108-tables.md','utf8'),'table repeat differs');
writeFileSync('.matchlog/0108-tables.md',md);

// Независимый SQL-срез выбранных миров для ручной сверки таблиц.
const rawChecks=[];
for(const s of sources){
  const db=new DatabaseSync(s.path,{readOnly:true});
  const orders=db.prepare(`select m.world_seed,c.tick,c.accepted from command c join match m using(match_id)
    where m.world_seed in (4,15,47) and c.player=0 and c.kind=2 and c.arg0=2 order by m.world_seed,c.tick,c.rowid`).all();
  const last=db.prepare(`select m.world_seed,d.tick,d.energy,d.wait_streak,a.ord,a.spending,a.result,a.note,a.price
    from match m join decision d using(match_id) join attempt a on a.match_id=d.match_id and a.player=d.player and a.tick=d.tick
    where m.world_seed in (4,15,47) and d.player=0 and d.tick=(select max(tick) from decision where match_id=m.match_id and player=0)
    order by m.world_seed,a.ord`).all();
  const tower=db.prepare(`select m.world_seed,t.player,t.tick,t.cell from tower t join match m using(match_id)
    where (m.world_seed=15 and t.player=1 and t.tick in (7800,8100)) or (m.world_seed=47 and t.player=0 and t.tick in (12600,12900))
    order by m.world_seed,t.player,t.tick,t.cell`).all();
  rawChecks.push({label:s.label,orders,last,tower});db.close();assert.equal(await hash(s.path),s.before);
}
writeFileSync('.matchlog/0108-raw-checks.json',JSON.stringify(rawChecks,null,2)+'\n');

const denominators=windows.flatMap(w=>['firstSecond','lastEnd'].map(k=>{
  const rows=w.matches.map(m=>m[k]).filter(Boolean);
  return {line:w.label,window:k,decisions:sum(rows.map(r=>r.decisions)),samples:sum(rows.map(r=>r.sampleN)),maxQueue:Math.max(...rows.map(r=>r.queue.max??0)),maxWait:Math.max(...rows.map(r=>r.wait.max??0))};
}));
console.log(JSON.stringify({denominators}));
```
