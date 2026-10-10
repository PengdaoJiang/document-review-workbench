const $=s=>document.querySelector(s);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const when=t=>t?new Date(t).toLocaleString('zh-CN',{hour12:false}):'尚未开始';
const duration=s=>s===null?'—':s<60?s+' 秒':s<3600?Math.floor(s/60)+' 分 '+s%60+' 秒':Math.floor(s/3600)+' 小时 '+Math.floor(s%3600/60)+' 分';
let last='',filter='active',poolFilter='all',latestDraw=()=>{};
export function renderTasks(data,update){
 const signature=JSON.stringify(data);if(signature===last)return;last=signature;
 $('#tasks-state').textContent=data.maintenance.paused?'维护暂停 · 不派发新任务':'按需执行 · 空队列不启动模型';
 $('#tasks-state').className='pill '+(data.maintenance.paused?'paused':'');
 const controls=$('#tasks-controls');
 if(!controls.querySelector('input:focus')){controls.replaceChildren();for(const pool of ['source','blind']){const s=data.summary[pool],card=el('section',undefined,'pool-control'),label=el('label',pool==='source'?'原文 · Luna max':'盲审 · Astra max'),input=el('input');input.type='number';input.min='0';input.max='64';input.value=s.limit;input.setAttribute('aria-label',pool==='source'?'原文并发上限':'盲审并发上限');label.append(input);const save=el('button','保存并发','secondary');save.onclick=async()=>{save.disabled=true;try{await update({pool,limit:Number(input.value),revision:data.settings.revision});}finally{save.disabled=false;}};card.append(label,save,el('p',`执行 ${s.running} · 排队 ${s.queued} · 等待 ${s.waiting} · 受阻 ${s.blocked} · 已交付 ${s.delivered}`));controls.append(card);}}
 const selectors=$('#tasks-filters');if(!selectors.children.length){for(const [value,text] of [['active','当前任务'],['history','最近退出']]){const b=el('button',text);b.dataset.taskFilter=value;b.onclick=()=>{filter=value;latestDraw();};selectors.append(b);}const select=el('select');select.setAttribute('aria-label','CLI 任务池');for(const [value,text] of [['all','两个执行池'],['source','仅原文'],['blind','仅盲审']]){const option=el('option',text);option.value=value;select.append(option);}select.onchange=()=>{poolFilter=select.value;latestDraw();};selectors.append(select);}
 function draw(){
  selectors.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.taskFilter===filter));
  const rows=(filter==='history'?data.history:data.tasks.filter(r=>r.category!=='exited')).filter(r=>poolFilter==='all'||r.pool===poolFilter),body=$('#tasks-body');
  const opened=new Set([...body.querySelectorAll('details[open]')].map(d=>d.dataset.task));body.replaceChildren();
  if(!rows.length){body.append(el('p','此范围暂无 CLI 任务。','subtle'));return;}
  for(const r of rows){
   const card=el('article',undefined,'cli-task'),top=el('div',undefined,'cli-task-top');
   top.append(el('strong',r.paperId+' · '+r.title),el('span',r.phase,'task-phase '+r.category));
   card.append(top,el('p',r.kind+' · '+r.model+' / '+r.effort),el('p','最近动作：'+r.lastAction));
   if(r.reason)card.append(el('p',r.reason,'task-reason'));
   card.append(el('p','开始 '+when(r.startedAt)+' · 用时 '+duration(r.elapsedSeconds)+' · 最后活动 '+when(r.lastActivityAt),'subtle'));
   const d=el('details'),s=el('summary','任务与回执');d.dataset.task=[r.pool,r.assignmentId,r.attemptId,filter].join(':');d.open=opened.has(d.dataset.task);
   d.append(s,el('p','工单 '+r.assignmentId),el('p','执行尝试 '+(r.attemptId||'尚未领取')));
   if(r.reportId)d.append(el('p','关联报告 '+r.reportId));
   if(r.parentAssignmentIds.length)d.append(el('p','上游任务 '+r.parentAssignmentIds.join('、')));
   if(r.exitedAt)d.append(el('p','退出 '+when(r.exitedAt)+' · 退出码 '+(r.exitCode??'未记录')));
   const a=el('a','查看工单当前交付状态 ↗');a.href=r.resultUrl;a.target='_blank';a.rel='noopener';
   d.append(a,el('p',r.deliveryVerified?'此执行尝试的业务交付已核实；论文签核独立记录。':'此执行尝试尚无完整交付；退出或无活动均不代表完成。','subtle'));card.append(d);body.append(card);
  }
 }
 latestDraw=draw;draw();
}
