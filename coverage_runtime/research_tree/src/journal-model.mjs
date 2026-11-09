import {positionFor, validateReview, directionFor, objectDirectionFor} from './review-model.mjs';

export const JOURNAL_POLICY='direction-mixture-v1';
export const DELTA_CALIBRATION='slice-delta-v2';
export const FINDING_LABELS={problem:'问题与假设',method:'方法与关键推导',contribution:'贡献与研究关系',limitations:'适用条件与局限',next:'待核实的问题'};
const colors=['#8db9f3','#75d9cb','#e5bb81','#c4adf3','#e898a7','#9dc787','#ddb58a','#80c5de'];
const norm=v=>Math.hypot(...v), clone=x=>structuredClone(x);
const requireThat=(test,message)=>{if(!test)throw new Error(message);};
const nonempty=s=>typeof s==='string'&&s.trim().length>0;
const basePosition=p=>positionFor({...p,spacePlacement:null,relationshipSummary:{primaryDirection:'unresolved',objectDirection:'unresolved'}});
const unit=v=>{requireThat(Array.isArray(v)&&v.length===3&&v.every(Number.isFinite)&&norm(v)>1e-8,'方向向量必须包含三个有限数且非零');return v.map(x=>x/norm(v));};
// Math transcendental results may differ by a few ulps between Node and browsers.
// Only derived geometry is compared here; identities/bindings remain exact and
// significant numeric changes, non-finite numbers and shape changes still fail.
const same=(a,b)=>{
 if(typeof a==='number'||typeof b==='number')return typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=64*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b));
 if(a===b)return true;
 if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
};
export function emptyJournal(catalog){return {schemaVersion:1,manifestSha256:catalog.manifestSha256,policy:JOURNAL_POLICY,events:[]};}

// New anchors fill unused parts of a fixed sphere; existing anchors never move.
export function nextAnchor(directions){
 const occupied=Object.values(directions).map(d=>d.anchor);
 const candidates=Array.from({length:64},(_,i)=>{const y=1-2*(i+.5)/64,a=i*Math.PI*(3-Math.sqrt(5)),r=Math.sqrt(1-y*y);return [r*Math.cos(a),y,r*Math.sin(a)];});
 if(!occupied.length)return candidates[20];
 return candidates.reduce((best,v)=>{const score=Math.min(...occupied.map(w=>1-v.reduce((sum,x,i)=>sum+x*w[i],0)));return score>best.score?{v,score}:best;},{v:candidates[0],score:-Infinity}).v;
}

export function placementFor(paper,probabilities,directions,previous=null){
 requireThat(probabilities&&typeof probabilities==='object'&&!Array.isArray(probabilities),'必须给出归属概率');
 requireThat(Object.hasOwn(probabilities,'unassigned'),'必须显式保留 unassigned 待定概率');
 let sum=0,known=0;const vector=[0,0,0],bindings={};
 for(const [id,p] of Object.entries(probabilities)){
  requireThat(Number.isFinite(p)&&p>=0&&p<=1,'概率必须为 0 到 1 的有限数');sum+=p;
  if(id==='unassigned')continue;
  const d=directions[id];requireThat(d&&d.status==='active','未知或已停用的研究方向：'+id);
  if(p>0){known+=p;bindings[id]=d.eventId;d.anchor.forEach((x,i)=>vector[i]+=p*x);}
 }
 requireThat(Math.abs(sum-1)<1e-8,'各方向与待定概率之和必须为 1');
 const baseline=basePosition(paper),fallback=previous?.placement||baseline;
 let after,mode;
 if(!known||norm(vector)<=.05*known){after=clone(fallback);mode=known?'cancelled_hold':'unassigned_hold';}
 else {
  const u=unit(vector),r=baseline.radius;mode='probability_mixture';
  after={x:r===null?0:r*u[0],y:r===null?0:r*u[1],z:r===null?0:r*u[2],radius:r,delta:baseline.delta,azimuthDegrees:(Math.atan2(u[2],u[0])*180/Math.PI+360)%360,elevationDegrees:Math.asin(u[1])*180/Math.PI,zone:r===null?'unknown_year':'research_probability'};
 }
 return {placement:after,mode,directionBindings:bindings,knownMass:known};
}

function validateReading(event,paper,catalog){
 requireThat(event.review,'精读更新必须包含当次精读记录');
 const v=validateReview(event.review,paper,catalog.papers,catalog.root);
 requireThat(!v.errors.length,v.errors.join('；'));
 requireThat(['in_progress','reviewed'].includes(event.review.reading.status),'未读记录不能发布为精读成果');
 requireThat(nonempty(event.review.reading.reviewer)&&Number.isFinite(Date.parse(event.review.reading.updatedAt)),'记录实际审读者与时间');
 requireThat(nonempty(event.summary),'记录本次精读摘要');
 requireThat(event.findings&&Object.values(event.findings).some(nonempty),'至少记录一项精读发现');
 requireThat(Object.keys(event.findings).every(k=>Object.hasOwn(FINDING_LABELS,k))&&Object.values(event.findings).every(v=>typeof v==='string'),'精读发现字段无效');
 const c=event.coverage;
 requireThat(c&&['partial','full'].includes(c.status)&&nonempty(c.note)&&Array.isArray(c.pages)&&c.pages.length&&new Set(c.pages).size===c.pages.length&&c.pages.every(n=>Number.isInteger(n)&&n>=1&&n<=paper.sourcePages),'记录已检查的原文页码及覆盖范围');
 if(event.review.reading.status==='reviewed')requireThat(c.status==='full'&&['problem','method','contribution','limitations'].every(k=>nonempty(event.findings[k])),'已审读需要全文覆盖声明及问题、方法、贡献、局限四项成果');
 requireThat(Array.isArray(event.evidenceIds)&&event.evidenceIds.length>0,'坐标判断必须关联当次原文证据');
 for(const id of event.evidenceIds){
  const ev=event.review.evidence.find(e=>e.id===id),source=ev?.sourcePaperId==='origin'?catalog.root:catalog.papers.find(p=>p.id===ev?.sourcePaperId);
  requireThat(ev&&source?.sourceSha256===ev.sourcePdfSha256&&source.sourceSha256&&Number.isInteger(ev.pdfPage)&&ev.pdfPage>=1&&ev.pdfPage<=source.sourcePages&&(nonempty(ev.excerpt)||ev.bbox)&&ev.reviewStatus!=='rejected','坐标证据缺少匹配的原文封印或发生位置：'+id);
 }
 requireThat(Array.isArray(event.slices)&&event.slices.length>0&&new Set(event.slices.map(s=>s.id)).size===event.slices.length,'精读必须留下可单独读取的重要关联切片');
 for(const slice of event.slices){
  requireThat(/^[a-zA-Z0-9_-]+$/.test(slice.id)&&nonempty(slice.statement)&&slice.statement.length<=800&&nonempty(slice.conditions)&&slice.conditions.length<=500,'切片需要简短结论（≤800 字符）和适用条件（≤500 字符）');
  requireThat(Array.isArray(slice.evidenceIds)&&slice.evidenceIds.length>0&&slice.evidenceIds.length<=8&&slice.evidenceIds.every(id=>event.evidenceIds.includes(id)),'切片应引用 1 至 8 个本次已定位证据');
  requireThat(Array.isArray(slice.relatedPaperIds)&&slice.relatedPaperIds.every(id=>id==='origin'||catalog.papers.some(p=>p.id===id))&&Array.isArray(slice.directionIds)&&slice.directionIds.every(id=>Object.hasOwn(event.probabilities,id)),'切片的关联论文或方向无效');
 }
 return v;
}

// Propagation packets contain relation slices and source locations, never full
// review objects, PDFs, extracted full text, or complete findings.
function materialFor(entry,slice){
 return {ref:entry.id+':'+slice.id,paperId:entry.paperId,statement:slice.statement,conditions:slice.conditions,relatedPaperIds:slice.relatedPaperIds,directionIds:slice.directionIds,evidence:slice.evidenceIds.map(id=>{
  const e=entry.review.evidence.find(e=>e.id===id);return {id,sourcePaperId:e.sourcePaperId,sourcePdfSha256:e.sourcePdfSha256,pdfPage:e.pdfPage,section:e.section||null,equation:e.equation||null,bbox:e.bbox||null,excerpt:(e.excerpt||'').slice(0,500),excerptTruncated:(e.excerpt||'').length>500};
 })};
}
function materialsForRoute(route,papers,byId){
 const current=papers[route.paperId],old=byId.get(current.readingEventId||current.id)||current;
 const material=new Map((old.slices||[]).map(s=>{const item=materialFor(old,s);return [item.ref,item];}));
 for(const id of route.triggerIds){
  const trigger=byId.get(id);if(trigger?.kind!=='reading')continue;
  const relevant=trigger.slices.filter(s=>s.relatedPaperIds.includes(route.paperId)||s.directionIds.some(d=>current.probabilities[d]>0));
  for(const slice of relevant.length?relevant:trigger.slices){const item=materialFor(trigger,slice);material.set(item.ref,item);}
 }
 return [...material.values()];
}

// Reuse is an explicit reference to an earlier signed calibration, never a new
// reading claim. Only unchanged slices of this target can be reused. All new
// trigger material and every new reading revision still require actual review.
function calibrationBasis(route,papers,byId,protocol,{forceFull=false}={}){
 const current=papers[route.paperId],materials=materialsForRoute(route,papers,byId);
 const covered=new Set([...(current.sliceRefs||[]),...(current.reusedSlices?.sliceRefs||[])]);
 const reusable=protocol===DELTA_CALIBRATION&&!forceFull&&!route.requireFullSliceReview&&current.kind==='calibration'
  ?materials.filter(m=>m.paperId===route.paperId&&covered.has(m.ref)):[];
 const reusableRefs=new Set(reusable.map(m=>m.ref));
 return {materials,reusable,review:materials.filter(m=>!reusableRefs.has(m.ref)),basisEventId:reusable.length?current.id:null};
}

// Replay checks each stored result against the definitions that existed at that time.
// The archive is authoritative; a later direction revision never rewrites a paper.
export function replayJournal(journal,catalog){
 requireThat(journal?.schemaVersion===1&&journal.policy===JOURNAL_POLICY&&journal.manifestSha256===catalog.manifestSha256&&Array.isArray(journal.events),'精读存档版本或语料封印不匹配');
 const directions={},papers={},byId=new Map(),queue={};let firstReadCount=0,calibrationProtocol='slice-full-v1';
 const enqueue=(id,event,reason,priority=2,full=false)=>{
  if(!papers[id])return;
  const item=queue[id]||={paperId:id,triggerIds:[],reasons:[],priority,queuedAt:event.at};
  if(!item.triggerIds.includes(event.id))item.triggerIds.push(event.id);
  if(!item.reasons.includes(reason))item.reasons.push(reason);
  item.priority=Math.min(item.priority,priority);
  if(full)item.requireFullSliceReview=true;
 };
 for(const [index,event] of journal.events.entries()){
  requireThat(event.id==='u'+String(index+1).padStart(6,'0'),'存档顺序或更新编号不连续');
  requireThat(nonempty(event.author)&&nonempty(event.reason)&&Number.isFinite(Date.parse(event.at)),'更新必须记录实际作者、时间和理由');
  requireThat(['policy','direction','reading','calibration'].includes(event.kind),'未知更新类型');
  if(event.kind==='policy'){
   requireThat(nonempty(event.title)&&Array.isArray(event.rules)&&event.rules.every(nonempty),'规则说明缺失');
   if(event.calibrationProtocol){
    requireThat(['slice-full-v1',DELTA_CALIBRATION].includes(event.calibrationProtocol)&&Object.keys(queue).length===0,'校准流程迁移须在队列清空的检查点进行');
    calibrationProtocol=event.calibrationProtocol;
   }
  }
  if(event.kind==='direction'){
   requireThat(/^[a-z][a-z0-9_-]{1,39}$/.test(event.directionId)&&event.directionId!=='unassigned','研究方向 ID 无效');
   requireThat(nonempty(event.label)&&event.label.length<=60&&nonempty(event.definition)&&event.definition.length<=1200&&['active','retired'].includes(event.status),'研究方向需要简短名称、定义（≤1200 字符）和状态');
   requireThat(Array.isArray(event.basisPaperIds)&&event.basisPaperIds.length&&event.basisPaperIds.every(id=>catalog.papers.some(p=>p.id===id)),'方向需要注明依据的集合内论文');
   requireThat(Math.abs(norm(unit(event.anchor))-norm(event.anchor))<1e-8,'方向锚点必须为单位向量');
   directions[event.directionId]={...event,eventId:event.id,color:directions[event.directionId]?.color||colors[Object.keys(directions).length%colors.length]};
   for(const [id,p] of Object.entries(papers))if(calibrationProtocol===DELTA_CALIBRATION||p.probabilities[event.directionId]>0||p.knownMass<.75||event.basisPaperIds.includes(id))enqueue(id,event,'方向形成或修订后，重新估计旧归属数值',1,calibrationProtocol===DELTA_CALIBRATION);
  }
  if(event.kind==='reading'){
   const paper=catalog.papers.find(p=>p.id===event.paperId),prev=papers[event.paperId];
   requireThat(paper&&event.paperSha256===paper.sourceSha256,'更新论文身份或原文封印不匹配');
   requireThat(event.previousId===(prev?.id||null),'更新基线已改变，请重新检查前一版本');
   const before=prev?.placement||basePosition(paper);
   requireThat(same(event.before,before),'更新前坐标与历史记录不一致');
   validateReading(event,paper,catalog);
   requireThat(Array.isArray(event.relatedPaperIds)&&event.relatedPaperIds.every(id=>id!==paper.id&&catalog.papers.some(p=>p.id===id)),'相关旧论文必须来自当前集合');
   const projected=placementFor(paper,event.probabilities,directions,prev);
   for(const key of ['placement','mode','directionBindings','knownMass'])requireThat(same(event[key],projected[key]),'存档坐标不可复现：'+key);
   papers[paper.id]=event;
   // Supplementing a reading does not consume pending numerical calibration.
   if(event.kind==='reading'){
    for(const [id,old] of Object.entries(papers)){
     if(id===paper.id)continue;
     if(event.relatedPaperIds.includes(id))enqueue(id,event,'新精读明确关联到这篇旧论文',0);
     else if(Object.entries(event.probabilities).some(([d,p])=>d!=='unassigned'&&p>0&&old.probabilities[d]>0))enqueue(id,event,'同一研究方向出现新的精读依据',2);
    }
    if(!prev){
     firstReadCount++;
     const full=calibrationProtocol===DELTA_CALIBRATION&&(firstReadCount%25===0||firstReadCount===catalog.papers.length);
     if(firstReadCount%5===0||full)for(const id of Object.keys(papers))if(id!==paper.id)enqueue(id,event,full?'每 25 篇及语料末尾，完整复核全部旧切片和数值':'每新增 5 篇，对已读论文做一次数值对齐',3,full);
    }
   }
  }
  if(event.kind==='calibration'){
   requireThat(calibrationProtocol!==DELTA_CALIBRATION||event.protocol===DELTA_CALIBRATION,'增量校准须明确区分本次审读与引用旧依据');
   requireThat(!event.protocol||event.protocol===calibrationProtocol,'校准流程版本不匹配');
   requireThat(Array.isArray(event.updates)&&event.updates.length>0&&new Set(event.updates.map(u=>u.paperId)).size===event.updates.length,'数值校准批次必须包含不重复的旧论文');
   for(const update of event.updates){
    const paper=catalog.papers.find(p=>p.id===update.paperId),prev=papers[update.paperId];
    requireThat(paper&&prev&&update.previousId===prev.id&&update.paperSha256===paper.sourceSha256,'校准目标或前一数值版本不匹配');
    requireThat(nonempty(update.reason)&&same(update.before,prev.placement),'校准需要前一坐标及具体理由');
    requireThat(Array.isArray(update.basisEventIds)&&update.basisEventIds.length&&update.basisEventIds.every(id=>byId.has(id)),'校准需要记录所依据的新旧精读或方向更新');
    requireThat((queue[paper.id]?.triggerIds||[]).every(id=>update.basisEventIds.includes(id)),'校准未覆盖当前传播路线的全部新依据');
    const route=queue[paper.id]||{paperId:paper.id,triggerIds:update.basisEventIds};
    const basis=calibrationBasis(route,papers,byId,calibrationProtocol),materials=basis.materials;
    const reused=update.reusedSlices?.sliceRefs||[];
    if(event.protocol===DELTA_CALIBRATION){
     requireThat(Array.isArray(update.sliceRefs)&&new Set(update.sliceRefs).size===update.sliceRefs.length,'本次审读切片引用无效');
     requireThat(!update.reusedSlices||(Array.isArray(reused)&&reused.length>0&&new Set(reused).size===reused.length&&update.reusedSlices.basisEventId===basis.basisEventId&&reused.every(ref=>basis.reusable.some(m=>m.ref===ref))),'旧切片引用基线失效或本轮必须完整复核');
     requireThat(update.sliceRefs.every(ref=>materials.some(m=>m.ref===ref))&&reused.every(ref=>!update.sliceRefs.includes(ref)),'切片不能虚构或同时标为新审读和旧引用');
    }else requireThat(!update.reusedSlices,'历史完整校准不支持省略旧切片');
    requireThat(materials.length&&Array.isArray(update.sliceRefs)&&materials.every(m=>update.sliceRefs.includes(m.ref)||reused.includes(m.ref)),'校准需要覆盖关联切片；材料不足时先补切片，不以批量全文替代');
    const projected=placementFor(paper,update.probabilities,directions,prev);
    for(const key of ['placement','mode','directionBindings','knownMass'])requireThat(same(update[key],projected[key]),'校准坐标不可复现：'+key);
    papers[paper.id]={...prev,...update,id:event.id,kind:'calibration',at:event.at,author:event.author,readingEventId:prev.readingEventId||prev.id};
    delete queue[paper.id];
   }
   // A calibration is terminal: it never enqueues more papers by itself.
  }
  byId.set(event.id,event);
 }
 const stale={};
 for(const [id,event] of Object.entries(papers))stale[id]=Object.entries(event.directionBindings).filter(([key,revision])=>directions[key]?.eventId!==revision||directions[key]?.status!=='active').map(([key])=>key);
 return {directions,papers,stale,calibrationProtocol,queue:Object.values(queue).sort((a,b)=>a.priority-b.priority||a.queuedAt.localeCompare(b.queuedAt)||a.paperId.localeCompare(b.paperId)),revision:journal.events.length};
}

export function appendJournalEvent(journal,catalog,proposal,{at=new Date().toISOString()}={}){
 const current=replayJournal(journal,catalog);
 requireThat(proposal.expectedRevision===current.revision,'存档已更新或缺少 expectedRevision；先读取最新修订号');
 const event={id:'u'+String(current.revision+1).padStart(6,'0'),kind:proposal.kind,at,author:proposal.author,reason:proposal.reason};
 if(event.kind==='policy'){event.title=proposal.title;event.rules=clone(proposal.rules);if(proposal.calibrationProtocol)event.calibrationProtocol=proposal.calibrationProtocol;}
 if(event.kind==='direction'){
  const old=current.directions[proposal.directionId];
  Object.assign(event,{directionId:proposal.directionId,label:proposal.label,definition:proposal.definition,status:proposal.status||'active',basisPaperIds:clone(proposal.basisPaperIds),anchor:unit(proposal.anchor||old?.anchor||nextAnchor(current.directions))});
 }
 if(event.kind==='reading'){
  const paper=catalog.papers.find(p=>p.id===proposal.paperId);requireThat(paper,'论文不在封闭集合中');
  const previous=current.papers[paper.id];
  Object.assign(event,{paperId:paper.id,paperSha256:paper.sourceSha256,previousId:previous?.id||null,before:clone(previous?.placement||basePosition(paper))});
  for(const key of ['review','summary','findings','coverage','evidenceIds','probabilities','slices'])event[key]=clone(proposal[key]);
  event.relatedPaperIds=[...new Set([...(proposal.relatedPaperIds||[]),...(proposal.slices||[]).flatMap(s=>s.relatedPaperIds||[])])].filter(id=>id!=='origin'&&id!==paper.id);
  Object.assign(event,placementFor(paper,event.probabilities,current.directions,previous));
 }
 if(event.kind==='calibration'){
  if(current.calibrationProtocol===DELTA_CALIBRATION)event.protocol=DELTA_CALIBRATION;
  requireThat(Array.isArray(proposal.updates)&&proposal.updates.length,'校准批次为空');
  event.updates=proposal.updates.map(input=>{
   const paper=catalog.papers.find(p=>p.id===input.paperId),prev=current.papers[input.paperId];requireThat(paper&&prev,'只能校准已有精读定位的论文');
   return {paperId:paper.id,paperSha256:paper.sourceSha256,previousId:prev.id,before:clone(prev.placement),probabilities:clone(input.probabilities),reason:input.reason,basisEventIds:clone(input.basisEventIds),sliceRefs:clone(input.sliceRefs),...(event.protocol===DELTA_CALIBRATION?{reusedSlices:clone(input.reusedSlices||null)}:input.reusedSlices?{reusedSlices:clone(input.reusedSlices)}:{}),...placementFor(paper,input.probabilities,current.directions,prev)};
  });
 }
 const next={...journal,events:[...journal.events,event]};replayJournal(next,catalog);return next;
}

export function applyJournal(catalog,journal){
 const current=replayJournal(journal,catalog),next=clone(catalog);
 next.journalRevision=current.revision;next.journalUpdatedAt=journal.events.at(-1)?.at||null;
 for(const paper of next.papers){
  const entry=current.papers[paper.id];paper.spacePlacement=clone(entry?.placement||basePosition(paper));
  paper.researchEntry=entry?{id:entry.id,at:entry.at,summary:entry.summary,probabilities:entry.probabilities,reason:entry.reason,staleDirections:current.stale[paper.id],pendingCalibration:current.queue.some(q=>q.paperId===paper.id)}:null;
  // Residual probability stays in the record; it is not a separate research route.
  const assigned=entry?Object.entries(entry.probabilities).filter(([id,p])=>id!=='unassigned'&&p>0):[];
  paper.memberships.research=assigned.length?assigned.map(([id,p])=>({branch:id,basis:'reader_probability',probability:p,evidence:null})):[{branch:'unassigned',basis:entry?'reader_probability':'pending_reading',probability:entry?entry.probabilities.unassigned:1,evidence:null}];
  const dominant=paper.memberships.research.filter(m=>m.branch!=='unassigned').sort((a,b)=>b.probability-a.probability)[0];paper.researchColor=dominant?current.directions[dominant.branch].color:'#a5b3bf';
  if(!entry)continue;
  const review=clone(entry.review),v=validateReview(review,paper,next.papers,next.root);paper.review=review;
  paper.states.reading=review.reading.status;paper.states.academicRelations=review.relationship.status;
  const primaryDirection=directionFor(review,v);paper.relationshipSummary={status:review.relationship.status,primaryDirection,objectDirection:objectDirectionFor(review,v),acceptedUseTypes:v.acceptedUseTypes,acceptedObjects:v.acceptedObjects,inspectionDirection:review.inspectionDirection};
  paper.memberships.relation=(primaryDirection==='unresolved'?['unresolved']:v.acceptedUseTypes).map(branch=>({branch,basis:branch==='unresolved'?'pending_reading':'reviewed_source_evidence',evidence:null}));
  for(const key of ['contribution','methodInheritance','comparison','researchHistory'])paper[key]=review[key];
 }
 next.facets=[{id:'research',name:'精读形成的研究方向',branches:[...Object.values(current.directions).map(d=>({id:d.directionId,name:d.label,short:d.label,color:d.color,hint:d.definition})),{id:'unassigned',name:'研究方向待定',short:'研究方向待定',hint:'尚未分配到任何研究方向的论文；已形成归属的论文只在记录中保留未分配份额。',color:'#a5b3bf',pending:true}]},...next.facets.filter(f=>f.id!=='research')];
 for(const f of next.facets)for(const b of f.branches)b.count=next.papers.filter(p=>p.memberships[f.id]?.some(m=>m.branch===b.id)).length;
 next.counts.readingVerified=next.papers.filter(p=>p.states.reading==='reviewed').length;
 next.counts.academicRelationsVerified=next.papers.filter(p=>p.relationshipSummary.primaryDirection!=='unresolved').length;
 next.researchDirections=Object.values(current.directions);next.counts.coordinateReviews=Object.keys(current.papers).length;next.counts.coordinatesNeedReview=current.queue.length;
 return next;
}

export function calibrationWorklist(journal,catalog,{cursor=0,maxChars=16000,forceFull=false}={}){
 requireThat(Number.isInteger(cursor)&&cursor>=0&&Number.isInteger(maxChars)&&maxChars>=4000&&maxChars<=24000,'切片包游标或长度限制无效');
 const state=replayJournal(journal,catalog),byId=new Map(journal.events.map(e=>[e.id,e])),records=[];
 const seen={definitions:new Set(),triggers:new Set(),materials:new Set()};
 const put=(collection,id,value)=>{if(seen[collection]?.has(id))return;seen[collection]?.add(id);records.push({collection,value});};
 // Include the complete queue. Pagination bounds context size, never paper count;
 // routing metadata is paginated too so a large queue cannot crowd out its slices.
 for(const route of state.queue){
  const current=state.papers[route.paperId],basis=calibrationBasis(route,state.papers,byId,state.calibrationProtocol,{forceFull}),needed=basis.materials;
  put('papers',route.paperId,{...route,title:catalog.papers.find(p=>p.id===route.paperId).title,probabilities:current.probabilities,placement:current.placement,requiredSliceRefs:needed.map(m=>m.ref),...(state.calibrationProtocol===DELTA_CALIBRATION?{readingEventId:current.readingEventId||current.id,readingSummary:current.summary.slice(0,600),summaryTruncated:current.summary.length>600,previousReason:current.reason.slice(0,800),reasonTruncated:current.reason.length>800,reviewSliceRefs:basis.review.map(m=>m.ref),reusableSliceRefs:basis.reusable.map(m=>m.ref),reuseBasisEventId:basis.basisEventId}: {})});
  const relevant=new Set([...Object.keys(current.probabilities),...needed.flatMap(m=>m.directionIds)]);
  for(const id of route.triggerIds){const d=byId.get(id)?.directionId;if(d)relevant.add(d);}
  for(const id of relevant){const d=state.directions[id];if(d)put('definitions',id,{id,revision:d.eventId,label:d.label,definition:d.definition,anchor:d.anchor,status:d.status});}
  for(const id of route.triggerIds){const e=byId.get(id);put('triggers',id,{id,kind:e.kind,paperId:e.paperId||null,directionId:e.directionId||null,reason:e.reason.slice(0,500)});}
  for(const m of basis.review)put('materials',m.ref,m);
 }
 const packet={expectedRevision:state.revision,total:state.queue.length,workflow:'校准不限制篇数。仅依据关联切片校准旧概率和坐标；目录、方向定义、触发依据与切片都按长度分包。按 nextCursor 和同一 expectedRevision 继续读取所需材料，不批量载入全文。切片不足时定点补查。calibration 不再次传播。',papers:[],definitions:[],triggers:[],materials:[],cursor,nextCursor:null,totalRecords:records.length,totalMaterials:seen.materials.size};
 if(state.calibrationProtocol===DELTA_CALIBRATION){packet.protocol=DELTA_CALIBRATION;packet.workflow+=' 增量轮逐篇对照当前数值、精读摘要和上次理由；已确认且版本未变的旧切片可显式引用，不能称为本次重读。需要旧细节时用 --recall 定点展开；不得自动生成保留决定。方向变化、每25篇及最终收尾完整回读。';}
 let i=cursor;requireThat(cursor<=records.length,'切片包游标超出当前材料范围');
 for(;i<records.length;i++){
  const {collection,value}=records[i];packet[collection].push(value);
  if(JSON.stringify(packet).length>maxChars-100){packet[collection].pop();break;}
 }
 packet.nextCursor=i<records.length?i:null;
 requireThat(JSON.stringify(packet).length<=maxChars&&(i>cursor||i===records.length),'单条关联材料超过包长度；增大 max-chars 或整理该切片，不限制校准篇数');
 return packet;
}

// The targeted return path is deliberately available in every round. It never
// exposes full notes/findings or silently upgrades a reused slice to reviewed.
export function calibrationRecall(journal,catalog,{paperId,cursor=0,maxChars=16000}={}){
 requireThat(Number.isInteger(cursor)&&cursor>=0&&Number.isInteger(maxChars)&&maxChars>=4000&&maxChars<=24000,'切片包游标或长度限制无效');
 const state=replayJournal(journal,catalog),route=state.queue.find(r=>r.paperId===paperId);
 requireThat(route,'只能定点回查当前校准目标');
 const byId=new Map(journal.events.map(e=>[e.id,e])),materials=materialsForRoute(route,state.papers,byId).filter(m=>m.paperId===paperId);
 requireThat(cursor<=materials.length,'回查游标超出范围');
 const packet={expectedRevision:state.revision,paperId,cursor,nextCursor:null,totalMaterials:materials.length,materials:[]};let i=cursor;
 for(;i<materials.length;i++){packet.materials.push(materials[i]);if(JSON.stringify(packet).length>maxChars-100){packet.materials.pop();break;}}
 packet.nextCursor=i<materials.length?i:null;
 requireThat(JSON.stringify(packet).length<=maxChars&&(i>cursor||i===materials.length),'单条旧切片过长，请增大材料包');
 return packet;
}
