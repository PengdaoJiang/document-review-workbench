// List metadata contains no full draft or note. Unknown values stay unknown.
export const caseSortModes=['time-asc','time-desc','length-asc','length-desc'];
export const latexLength=text=>typeof text==='string'?[...text].length:null;
const validTime=value=>{if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))return null;const wall=new Date(value.slice(0,19)+'Z');return Number.isFinite(wall.getTime())&&wall.toISOString().slice(0,19)===value.slice(0,19)?new Date(value).toISOString():null;};
export function caseListMetadata(request,state){
  const created=validTime(state.createdAt),submitted=(Array.isArray(state.events)?state.events:[]).filter(e=>e.type==='submitted').map(e=>validTime(e.at)).filter(Boolean).sort()[0]||null;
  const saved=typeof state.draft?.tex==='string',tex=saved?state.draft.tex:request?.spec?.target?.oldText;
  return {createdAt:created||submitted,createdAtSource:created?'state.createdAt':submitted?'submitted-event':null,latexChars:latexLength(tex),latexCharsSource:saved?'saved-draft':typeof tex==='string'?'submitted-fragment':null};
}
const fixedId=(a,b)=>a.id<b.id?-1:a.id>b.id?1:0;
function compareKnown(a,b,direction){if(a===null||b===null)return a===b?0:a===null?1:-1;return a<b?-direction:a>b?direction:0;}
export function sortedCases(items,mode='time-asc'){
  if(!caseSortModes.includes(mode))mode='time-asc';const byLength=mode.startsWith('length'),direction=mode.endsWith('desc')?-1:1;
  return [...items].sort((a,b)=>{const at=validTime(a.createdAt),bt=validTime(b.createdAt),al=Number.isInteger(a.latexChars)&&a.latexChars>=0?a.latexChars:null,bl=Number.isInteger(b.latexChars)&&b.latexChars>=0?b.latexChars:null;
    return (byLength?compareKnown(al,bl,direction)||compareKnown(at,bt,1):compareKnown(at,bt,direction))||fixedId(a,b);});
}
export function nextPendingCase(visible,currentId){const pending=visible.filter(x=>['pending','deferred'].includes(x.status)),index=pending.findIndex(x=>x.id===currentId);if(!pending.length||pending.length===1&&index===0)return null;return pending[index<0?0:(index+1)%pending.length];}

// Read-only presentation also handles records written before recovery cleared problem.
export function routingView(request){
  const triggers=Array.isArray(request.humanEscalation?.triggers)?request.humanEscalation.triggers:[],codes=new Set(),decisions=new Map();let countRecorded=false,countUnverified=false;
  for(const raw of triggers){const trigger=typeof raw==='string'?raw:raw?.trigger;
    if(trigger==='source_agrees_initial')codes.add('source_agrees_initial');
    else if(trigger==='source_uncertainty')codes.add('source_uncertainty');
    else if(trigger==='two_distinct_negative_business_decisions'){codes.add(trigger);if(Array.isArray(raw.businessDecisionIds)&&Array.isArray(raw.receiptSha256s)&&raw.businessDecisionIds.length===raw.receiptSha256s.length&&raw.businessDecisionIds.length>=2&&new Set(raw.businessDecisionIds).size===raw.businessDecisionIds.length&&raw.businessDecisionIds.every(id=>typeof id==='string'&&id)&&raw.receiptSha256s.every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))){countRecorded=true;raw.businessDecisionIds.forEach((id,i)=>{if(decisions.has(id)&&decisions.get(id)!==raw.receiptSha256s[i])countUnverified=true;decisions.set(id,raw.receiptSha256s[i]);});}else countUnverified=true;}
    else codes.add('unknown');
  }
  if(request.spec?.category==='owner_transcription_uncertainty')codes.add('source_uncertainty');
  if(!codes.size)codes.add('unknown');
  const negativeCount=countRecorded&&!countUnverified?decisions.size:null,labels=[],shortLabels=[];
  if(codes.has('source_agrees_initial')){labels.push('原文复核与初稿一致');shortLabels.push('原文与初稿一致');}
  if(codes.has('two_distinct_negative_business_decisions')){labels.push('盲审累计负面意见达到阈值（'+(negativeCount===null?'累计次数待核实':'已记录 '+negativeCount+' 次')+'）');shortLabels.push(negativeCount===null?'盲审负面 · 次数待核实':'盲审负面 '+negativeCount+' 次');}
  if(codes.has('source_uncertainty')){labels.push('转译歧义');shortLabels.push('转译歧义');}
  if(codes.has('unknown')){labels.push('路由原因待核实');shortLabels.push('来路待核实');}
  return {labels,shortLabels,negativeCount,countedDecisions:negativeCount===null?[]:[...decisions].map(([businessDecisionId,receiptSha256])=>({businessDecisionId,receiptSha256}))};
}
export function problemView(state){
  const failed=['verification_failed','conflict'].includes(state.status);
  const history=(state.events||[]).filter(e=>['verification_failed','conflict'].includes(e.type)&&e.message);
  return {current:failed?(state.problem||history.at(-1)?.message||null):null,
    history:history.map(e=>({...e,resolved:state.status==='verified'}))};
}
