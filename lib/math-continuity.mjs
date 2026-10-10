import fs from 'node:fs';import path from 'node:path';
import {check,hashObject,hashFile,readJSON,writeJSON,immutableWrite,now,id,sha} from './io.mjs';
import {mathTechnicalGap,neutralField} from './review-ledger.mjs';
import {mathematicalSpans} from './math-coverage.mjs';

const inventoryFile=(q,key)=>path.join(q.mathCoverage.root,id(key)+'.json');
const planFile=(q,key)=>path.join(q.root,'review-continuity','plans',id(key)+'.json');
const impactDir=q=>path.join(q.root,'review-continuity','impacts');
const impactFile=(q,key)=>path.join(impactDir(q),id(key)+'.json');
const same=(a,b)=>hashObject(a)===hashObject(b);
// A validation context lasts for this synchronous call only. Never cache a
// successful proof across requests or await boundaries.
const validationContext=()=>({active:new Set(),verified:new Set()});
// Exact unique text alignment survives shifted paragraph numbers. Duplicate or
// changed text is left for the actual reviewer's bounded impact assessment.
export function unchangedNodePairs(before,after){
 const pairs=[];for(const old of before){const a=before.filter(n=>n.quote===old.quote),b=after.filter(n=>n.quote===old.quote);if(a.length===1&&b.length===1)pairs.push({baseNodeId:old.nodeId,assignedNodeId:b[0].nodeId,quoteSha256:sha(old.quote)});}return pairs;
}
function resultProof(q,item){
 check(item.status==='checked','Only actual conclusive checks are eligible for inherited check credit',409,'CONTINUITY_NOT_PASSED');
 return (item.reportIds||[]).map(key=>{const r=q.blind.report(key);check(r.mathResult&&['contradiction','checked_no_contradiction'].includes(r.mathResult.outcome)&&!mathTechnicalGap(q.blind,r),'Historical mathematical result is unresolved',409,'CONTINUITY_NOT_PASSED');
  const tool=r.mathResult.toolReceiptId?q.blind.read('checks',r.mathResult.toolReceiptId):null;
  return {reportId:r.id,bundleId:r.bundleId,encodingSha256:r.encoding?.sha256||null,resultSha256:hashObject(r.mathResult),toolPublicSha256:tool?hashObject(tool.public):null};
 });
}
export function buildContinuityPlan(q,j,context=validationContext()){
 check(j.baselineInventoryId&&j.baselineInventorySha256,'Incremental review requires a sealed baseline inventory',409,'CONTINUITY_BASE_MISSING');
 const base=readJSON(inventoryFile(q,j.baselineInventoryId));check(hashFile(inventoryFile(q,base.id))===j.baselineInventorySha256&&base.paperId===j.paperId,'Review baseline changed',409,'CONTINUITY_BASE_CHANGED');verifyDeltaReceipt(q,base,context);
 const before=q.blind.bundle(base.bundleId),after=q.blind.bundle(j.bundleId);q.blind.viewBundle(before.id);q.blind.viewBundle(after.id);
 check(before.paperId===after.paperId&&before.paperId===j.paperId&&base.documentSha256===before.public.document.sha256&&base.inputSha256===before.manifest.sha256,'Review baseline identity differs',409,'CONTINUITY_BASE_CHANGED');
 const pairs=unchangedNodePairs(before.public.nodes,after.public.nodes),changes=[];
 for(const n of before.public.nodes.filter(n=>!pairs.some(p=>p.baseNodeId===n.nodeId)))changes.push({id:'before-'+n.nodeId,kind:'removed_or_changed_node',baseNodeId:n.nodeId,beforeQuote:n.quote});
 for(const n of after.public.nodes.filter(n=>!pairs.some(p=>p.assignedNodeId===n.nodeId)))changes.push({id:'after-'+n.nodeId,kind:'added_or_changed_node',assignedNodeId:n.nodeId,afterQuote:n.quote});
 const beforeFiles=new Map(before.manifest.files.map(f=>[f.file,f])),afterFiles=new Map(after.manifest.files.map(f=>[f.file,f]));
 // Paths are deliberately not exported to blind roles. File-kind and content
 // seals are sufficient to expose a changed non-main dependency as a real gap.
 for(const name of new Set([...beforeFiles.keys(),...afterFiles.keys()]))if(name!==q.store.config.papers[j.paperId].main&&!same(beforeFiles.get(name)||null,afterFiles.get(name)||null))changes.push({id:'dependency-'+hashObject(name).slice(0,16),kind:'changed_dependency',fileKind:path.extname(name),beforeSha256:beforeFiles.get(name)?.sha256||null,afterSha256:afterFiles.get(name)?.sha256||null});
 if(before.public.document.sha256!==after.public.document.sha256&&!changes.length)changes.push({id:'unindexed-document',kind:'unindexed_document_change',beforeSha256:before.public.document.sha256,afterSha256:after.public.document.sha256});
 const candidates=[],unresolved=[];
 for(const item of base.items||[])try{candidates.push({itemId:item.id,nodeId:item.nodeId,itemSha256:hashObject(item),status:item.status,resultProof:resultProof(q,item)});}catch{unresolved.push({itemId:item.id,nodeId:item.nodeId,status:item.status,scope:'No inherited pass; retain its actual limitation or perform the remaining assigned check.'});}
 const body={schemaVersion:1,assignmentId:j.id,paperId:j.paperId,baseInventoryId:base.id,baseInventorySha256:j.baselineInventorySha256,baseBundleId:before.id,baseInputSha256:before.manifest.sha256,baseDocumentSha256:before.public.document.sha256,bundleId:after.id,inputSha256:after.manifest.sha256,documentSha256:after.public.document.sha256,pairs,changes,candidates,unresolved};
 return {...body,id:hashObject(body).slice(0,24),sha256:hashObject(body)};
}
export function continuityPlan(q,j,context=validationContext()){
 if(!j.baselineInventoryId)return null;
 const plan=buildContinuityPlan(q,j,context),file=planFile(q,j.id);
 if(fs.existsSync(file)){const old=readJSON(file);check(same(old,plan),'Immutable incremental scope changed; require diagnosed recovery',409,'CONTINUITY_PLAN_CHANGED');return old;}
 immutableWrite(file,JSON.stringify(plan,null,2)+'\n');return plan;
}
function impacts(q,j){return fs.existsSync(impactDir(q))?fs.readdirSync(impactDir(q)).filter(f=>f.endsWith('.json')).map(f=>readJSON(path.join(impactDir(q),f))).filter(r=>r.assignmentId===j.id).sort((a,b)=>b.revision-a.revision):[];}
function latestImpact(q,j,plan){
 if(!plan.changes.length)return {id:'identical-'+plan.id,revision:0,planSha256:plan.sha256,automatic:true,retained:plan.pairs.map(p=>({...p,mode:'unchanged',dependencies:plan.pairs,reason:'The complete assigned TeX and sealed dependencies are identical to the accepted baseline.'})),sha256:hashObject({planSha256:plan.sha256,identical:true})};
 return impacts(q,j)[0]||null;
}
function humanDependencyReferences(q,bundleId,restrictions=q.humanRouting?.restrictions(bundleId)||[]){
 const groups=new Map();for(const x of restrictions){const record=q.humanRouting.publicRestriction(x);if(!groups.has(x.nodeId))groups.set(x.nodeId,[]);groups.get(x.nodeId).push(record);}
 return [...groups].map(([assignedNodeId,records])=>{records.sort((a,b)=>a.stableFragmentId.localeCompare(b.stableFragmentId));return {assignedNodeId,humanScopeSha256:hashObject(records),records};});
}
export function reviewContinuityInput(q,cap){
 const j=q.get(cap.assignmentId),plan=continuityPlan(q,j);if(!plan)return null;
 const impact=latestImpact(q,j,plan),base=readJSON(inventoryFile(q,plan.baseInventoryId)),before=q.blind.viewBundle(plan.baseBundleId);
 const humanDependencyBindings=humanDependencyReferences(q,plan.bundleId).map(({assignedNodeId,humanScopeSha256,records})=>({assignedNodeId,humanScopeSha256,states:records.map(x=>({stableFragmentId:x.stableFragmentId,state:x.state,decisionId:x.decisionId||null})),mathematicalPass:false,scope:'Reference an unchanged protected premise only using dependency mode human_reference and this exact humanScopeSha256. Do not reread, judge or newly check the protected content. Pending human scope remains pending; this reference gives no checking credit to it.'}));
 return {schemaVersion:1,mode:'incremental_review',planId:plan.id,planSha256:plan.sha256,basis:{baselineInventoryId:base.id,baselineInventorySha256:plan.baseInventorySha256,baselineBundleId:plan.baseBundleId,currentBundleId:plan.bundleId,cumulativeSince:'Each retained result keeps its original inventory/result proof; this plan compares the last actually reviewed inventory basis with the assigned version.'},baselineDocument:before.document,unchangedNodePairs:plan.pairs,retainedChecks:{reading:[],mathematical:impact?plan.candidates.filter(x=>impact.retained.some(n=>n.baseNodeId===x.nodeId)):[]},retentionCandidates:plan.candidates,changedScope:plan.changes,affectedConclusions:impact?.changes||[],unresolved:plan.unresolved,humanDependencyBindings,applicableDecisions:q.blind.all('rulings').filter(r=>r.paperId===j.paperId).map(r=>({rulingId:r.id,action:r.decision?.action||null,closed:!!r.closed,scope:'Preserve the applicable source reading. No further source reading or mathematical challenge in this workflow; only explicit user reopening or a later research task can reopen the decided fragment.'})),dependencyGaps:impact?.dependencyGaps||[],impactReceipt:impact?{id:impact.id,sha256:impact.sha256,revision:impact.revision,automatic:!!impact.automatic}:null,scope:'Assess cumulative changes and their dependency effects once; do not repeat unaffected established calculations. Context reading is not a new whole-paper audit. Submit actual delta inventory; the server combines verified retained rows and new evidence.'};
}
const presentationCore=s=>s.replace(/\\(?:label|tag|ref|eqref)\*?\s*\{[^{}]*\}/g,'').replace(/\s+/g,'');
export function recordReviewImpact(q,cap,body){
 check(cap.role==='reporter','Blind reporter required',403,'ROLE_DENIED');const j=q.get(cap.assignmentId),plan=continuityPlan(q,j);check(plan&&body.planSha256===plan.sha256,'Exact cumulative change plan required',409,'CONTINUITY_PLAN_CHANGED');
 check(body.dependenciesComplete===true&&Array.isArray(body.retained)&&Array.isArray(body.changes)&&Array.isArray(body.dependencyGaps||[]),'Explicit bounded dependency assessment required',422,'CONTINUITY_IMPACT_REQUIRED');neutralField(body.explanation,'impact.explanation');check(body.explanation.length>=40,'Explain changed definitions, conditions and affected conclusions',422,'CONTINUITY_IMPACT_REQUIRED');
 const before=q.blind.viewBundle(plan.baseBundleId),after=q.blind.viewBundle(plan.bundleId),seen=new Set(),human=q.humanRouting?.restrictions(plan.bundleId)||[],references=humanDependencyReferences(q,plan.bundleId,human),usedReferences=new Set();
 check(body.changes.length===plan.changes.length&&new Set(body.changes.map(x=>x.changeId)).size===plan.changes.length,'Account for every cumulative change',422,'CONTINUITY_IMPACT_REQUIRED');
 for(const row of body.changes){check(plan.changes.some(c=>c.id===row.changeId)&&Array.isArray(row.affectedNodeIds)&&row.affectedNodeIds.every(k=>after.nodes.some(n=>n.nodeId===k)),'Change assessment differs',422,'CONTINUITY_IMPACT_REQUIRED');neutralField(row.reason,'impact.change.reason');check(row.reason.length>=40,'Explain the effect or bounded non-effect of this change',422,'CONTINUITY_IMPACT_REQUIRED');}
 for(const row of body.retained){
  const a=before.nodes.find(n=>n.nodeId===row.baseNodeId),b=after.nodes.find(n=>n.nodeId===row.assignedNodeId);check(a&&b&&!seen.has(a.nodeId)&&!body.retained.some(x=>x!==row&&x.assignedNodeId===b.nodeId),'Distinct historical/current retained node mapping required',422,'CONTINUITY_IMPACT_REQUIRED');seen.add(a.nodeId);
  check(row.mode==='unchanged'?a.quote===b.quote:row.mode==='presentation_only'&&row.scientificClaimUnchanged===true&&presentationCore(a.quote)===presentationCore(b.quote),'Only exact text or explicitly assessed label/number presentation may retain old check credit',409,'CONTINUITY_DEPENDENCY_CHANGED');
  check(!body.changes.some(c=>c.affectedNodeIds.includes(b.nodeId)),'An affected conclusion cannot inherit old checking credit',409,'CONTINUITY_DEPENDENCY_CHANGED');
  check(Array.isArray(row.dependencies)&&row.dependencies.length>0,'Name all relevant definitions and conditions; include the claim node for self-contained checks',422,'CONTINUITY_IMPACT_REQUIRED');
  for(const d of row.dependencies){const old=before.nodes.find(n=>n.nodeId===d.baseNodeId),current=after.nodes.find(n=>n.nodeId===d.assignedNodeId);check(old&&current&&old.quote===current.quote&&!body.changes.some(c=>c.affectedNodeIds.includes(current.nodeId)),'A declared dependency changed or is affected',409,'CONTINUITY_DEPENDENCY_CHANGED');
   const ref=references.find(x=>x.assignedNodeId===current.nodeId);if(ref){check(d.mode==='human_reference'&&d.humanScopeSha256===ref.humanScopeSha256,'Protected premises require the exact supplied human reference, without a new semantic judgment',409,'CONTINUITY_HUMAN_REFERENCE_REQUIRED');usedReferences.add(current.nodeId);}else check(d.mode!=='human_reference'&&!d.humanScopeSha256,'Human dependency reference is no longer applicable; refresh assigned input',409,'CONTINUITY_HUMAN_REFERENCE_REQUIRED');
  }
  neutralField(row.reason,'impact.retained.reason');check(row.reason.length>=40,'Explicit semantic dependency assessment required',422,'CONTINUITY_IMPACT_REQUIRED');
 }
 for(const gap of body.dependencyGaps||[])neutralField(gap,'impact.dependencyGap');
 const old=impacts(q,j),digest=hashObject(body),sameRevision=old.find(x=>x.revision===body.revision);if(sameRevision){check(sameRevision.bodySha256===digest,'Impact revision is immutable',409,'CONTINUITY_IMPACT_CONFLICT');return {id:sameRevision.id,sha256:sameRevision.sha256,revision:sameRevision.revision};}
 const excluded=new Set(human.filter(x=>x.wholeNode!==false).map(x=>x.nodeId));
 check(!body.retained.some(x=>excluded.has(x.assignedNodeId))&&!body.changes.some(x=>x.affectedNodeIds.some(n=>excluded.has(n))),'Do not submit a new semantic judgment or retained check for a human-restricted fragment; retain its human scope separately',409,'HUMAN_FRAGMENT_LOCKED');
 check(Number.isInteger(body.revision)&&body.revision===Math.max(0,...old.map(x=>x.revision))+1,'Next impact revision required',409,'CONTINUITY_IMPACT_CONFLICT');
 const actor=cap.cliActor?q.blindExecutors.actor(cap):{threadId:j.recipient,roleId:cap.roleId};
 const core={...body,...(usedReferences.size?{humanDependencyBindings:references.filter(x=>usedReferences.has(x.assignedNodeId))}:{}),id:hashObject({assignmentId:j.id,body}).slice(0,24),assignmentId:j.id,actor,at:now(),bodySha256:digest},receipt={...core,sha256:hashObject(core),scope:'Actual blind-reviewer change-impact assessment, not another mathematical calculation or source decision. Protected premise references retain existing human scope and never give that premise mathematical credit.'};
 immutableWrite(impactFile(q,receipt.id),JSON.stringify(receipt,null,2)+'\n');return {id:receipt.id,sha256:receipt.sha256,revision:receipt.revision,retainedNodes:receipt.retained.length,dependencyGaps:receipt.dependencyGaps||[]};
}
function mergeRows(retained,fresh,key){check(Array.isArray(fresh)&&new Set(fresh.map(x=>x[key])).size===fresh.length,'Distinct delta rows required',422,'CONTINUITY_DELTA_INVALID');const incoming=new Set(fresh.map(x=>x[key]));return [...retained.filter(x=>!incoming.has(x[key])),...fresh];}
export function expandDelta(q,cap,body,{historical=false,context=validationContext(),humanProof=null}={}){
 if(!body.continuity){const h=q.humanRouting?.projectInventory(cap.bundleId,body,mathematicalSpans(q.blind.viewBundle(cap.bundleId).nodes),{historical,historicalProof:humanProof});return {body:h?.body||body,proof:null,humanCoverage:h?.proof||null};}
 const j=q.get(cap.assignmentId),plan=continuityPlan(q,j,context);check(plan&&body.continuity.planSha256===plan.sha256,'Delta plan changed',409,'CONTINUITY_PLAN_CHANGED');
 const impact=body.continuity.impactReceiptId?.startsWith('identical-')?latestImpact(q,j,plan):readJSON(impactFile(q,body.continuity.impactReceiptId));
 check(impact&&impact.planSha256===plan.sha256&&impact.id===body.continuity.impactReceiptId&&(!impact.assignmentId||impact.assignmentId===j.id)&&!(impact.dependencyGaps||[]).length,'Unresolved impact or dependency gap prevents inherited credit',409,'CONTINUITY_IMPACT_REQUIRED');
 if(!impact.automatic){const {sha256,scope,...core}=impact;check(hashObject(core)===sha256,'Impact receipt changed',409,'CONTINUITY_IMPACT_CONFLICT');}
 if(!historical){const current=latestImpact(q,j,plan);check(current&&current.id===impact.id&&current.sha256===impact.sha256,'A new delta must use the latest accepted impact assessment',409,'CONTINUITY_IMPACT_STALE');}
 const base=readJSON(inventoryFile(q,plan.baseInventoryId)),before=q.blind.viewBundle(plan.baseBundleId),after=q.blind.viewBundle(plan.bundleId),baseSpans=mathematicalSpans(before.nodes),nextSpans=mathematicalSpans(after.nodes),items=[],nodes=[],spans=[],evidence=[];
 for(const pair of impact.retained){
  const target=after.nodes.find(n=>n.nodeId===pair.assignedNodeId);check(target,'Retained target disappeared',409,'CONTINUITY_PLAN_CHANGED');
  for(const item of base.items.filter(x=>x.nodeId===pair.baseNodeId&&plan.candidates.some(c=>c.itemId===x.id))){
   const candidate=plan.candidates.find(x=>x.itemId===item.id);check(same(resultProof(q,item),candidate.resultProof),'Retained result changed',409,'CONTINUITY_RESULT_CHANGED');
   const quote=target.quote.includes(item.quote)?item.quote:pair.itemQuotes?.find(x=>x.itemId===item.id)?.quote;
   check(typeof quote==='string'&&target.quote.includes(quote)&&(quote===item.quote||pair.mode==='presentation_only'&&presentationCore(quote)===presentationCore(item.quote)),'Retained claim is absent or substantively changed',409,'CONTINUITY_DEPENDENCY_CHANGED');
   items.push({...item,nodeId:pair.assignedNodeId,quote});evidence.push({itemId:item.id,baseInventoryId:base.id,baseInventorySha256:plan.baseInventorySha256,originalItemSha256:hashObject(item),resultProof:candidate.resultProof,impactReceiptId:impact.id,impactActor:impact.actor||null,originalActor:base.workerActor||{threadId:base.threadId,roleId:base.roleId}});
  }
  const n=base.nodes.find(x=>x.nodeId===pair.baseNodeId);if(n&&n.disposition!=='unexamined')nodes.push({...n,nodeId:pair.assignedNodeId});
  for(const decision of base.spans||[]){const old=baseSpans.find(s=>s.spanId===decision.spanId&&s.nodeId===pair.baseNodeId);if(!old||decision.disposition==='unexamined')continue;const matches=nextSpans.filter(s=>s.nodeId===pair.assignedNodeId&&s.quote===old.quote);if(matches.length===1)spans.push({...decision,spanId:matches[0].spanId});}
 }
 check(!body.items.some(x=>items.some(old=>old.id===x.id)),'An explicitly retained passed item must not be submitted as a newly repeated calculation; revise the actual impact assessment if new evidence makes it affected',409,'CONTINUITY_RECHECK_UNCHANGED');
 const mergedItems=mergeRows(items,body.items,'id'),availableIds=new Set(mergedItems.map(x=>x.id));
 // Scope rows referring to unfinished old items do not become coverage merely
 // because their paragraph is unchanged. Missing new evidence remains a gap.
 const keptNodes=nodes.filter(n=>(n.itemIds||[]).every(k=>availableIds.has(k))),keptSpans=spans.filter(s=>(s.itemIds||[]).every(k=>availableIds.has(k)));
 const expanded={...body,items:mergedItems,nodes:mergeRows(keptNodes,body.nodes,'nodeId'),spans:mergeRows(keptSpans,body.spans||[],'spanId')};
 const human=q.humanRouting?.projectInventory(plan.bundleId,expanded,nextSpans,{historical,historicalProof:humanProof,submitted:body});
 const actualRetained=evidence.filter(x=>!body.items.some(i=>i.id===x.itemId));
 return {body:human?.body||expanded,humanCoverage:human?.proof||null,proof:{schemaVersion:1,planSha256:plan.sha256,impactReceiptId:impact.id,impactReceiptSha256:impact.sha256,baseInventoryId:base.id,baseInventorySha256:plan.baseInventorySha256,retainedItems:actualRetained.filter(x=>!human?.proof?.some(h=>h.wholeNode!==false&&mergedItems.find(i=>i.id===x.itemId)?.nodeId===h.nodeId)),retainedNodes:keptNodes.filter(x=>!body.nodes.some(n=>n.nodeId===x.nodeId)&&!human?.proof?.some(h=>h.nodeId===x.nodeId)).map(x=>x.nodeId),retainedSpans:keptSpans.filter(x=>!(body.spans||[]).some(s=>s.spanId===x.spanId)&&!human?.proof?.some(h=>nextSpans.find(s=>s.spanId===x.spanId)?.nodeId===h.nodeId)).map(x=>x.spanId)}};
}
export function verifyDeltaReceipt(q,receipt,context=validationContext()){
 if(!receipt.retainedCoverage)return true;
 const key=receipt.id+':'+hashObject(receipt);if(context.verified.has(key))return true;
 check(!context.active.has(receipt.id)&&context.active.size<32,'Incremental review lineage is cyclic',409,'CONTINUITY_LINEAGE_INVALID');context.active.add(receipt.id);
 try{
  const proof=receipt.retainedCoverage,base=readJSON(inventoryFile(q,proof.baseInventoryId));check(hashFile(inventoryFile(q,base.id))===proof.baseInventorySha256,'Retained base changed',409,'CONTINUITY_BASE_CHANGED');verifyDeltaReceipt(q,base,context);
  const cap={assignmentId:receipt.assignmentId,bundleId:receipt.bundleId},expanded=expandDelta(q,cap,receipt.submittedDelta,{historical:true,context,humanProof:receipt.humanCoverage||null});
  check(same(expanded.proof,proof)&&['nodes','items','spans'].every(k=>same(expanded.body[k]||[],receipt[k]||[]))&&hashObject(receipt.submittedDelta)===receipt.bodySha256,'Merged coverage or its delta provenance changed',409,'CONTINUITY_LINEAGE_INVALID');context.verified.add(key);return true;
 }finally{context.active.delete(receipt.id);}
}
