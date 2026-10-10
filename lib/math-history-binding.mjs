import {check,hashObject,sha} from './io.mjs';
import {frozenCandidateBinding} from './source-binding.mjs';
import {resolveInitialFragment,mapFragmentToBundle} from './fragment-alias-adapter.mjs';
import {mathTechnicalGap,roleField,neutralField} from './review-ledger.mjs';

// This projection establishes immutable text identity only. The reviewer still
// owns the proposition, dependency audit, interpretation and explicit reuse.
export function frozenMathBinding(q,original,node,target){
  const blind=q.blind;blind.viewBundle(original.id);blind.viewBundle(target.id);
  check(original.paperId===target.paperId&&original.owner===target.owner&&node?.target,'Mathematical binding paper, owner or target differs',409,'VERSION_CONFLICT');
  let legacy;
  try{legacy=frozenCandidateBinding(blind,original,node,target);}catch(e){if(e.code!=='VERSION_CONFLICT')throw e;}
  if(legacy){
    const matches=target.nodes.filter(n=>n.target.file===node.target.file&&n.target.oldText===node.target.oldText&&n.quote===node.quote);
    if(matches.length===1)return {...legacy,targetNodeId:matches[0].nodeId};
  }
  const deps=b=>b.manifest.files.filter(f=>f.file!==node.target.file);
  check(hashObject(deps(original))===hashObject(deps(target)),'Mathematical dependencies outside the mapped file changed',409,'VERSION_CONFLICT');
  const initial=resolveInitialFragment(q,{paperId:original.paperId,bundleId:original.id,nodeId:node.nodeId});
  const mapped=mapFragmentToBundle(q,{initialBundleId:initial.initialBundle.id,initialNodeId:initial.initialNode.nodeId,targetBundleId:target.id});
  check(mapped.currentNode.quote===node.quote&&mapped.currentNode.target.oldText===node.target.oldText,'Mapped mathematical fragment changed',409,'VERSION_CONFLICT');
  return {mode:'exact_frozen_fragment_lineage',bundleId:original.id,targetBundleId:target.id,targetNodeId:mapped.currentNode.nodeId,inputSha256:original.manifest.sha256,currentInputSha256:target.manifest.sha256,documentSha256:original.public.document.sha256,targetDocumentSha256:target.public.document.sha256,targetSha256:sha(node.target.oldText),initialBindingSha256:initial.aliasProof.sha256,aliasProofSha256:mapped.aliasProof.sha256,scope:'Exact unchanged frozen fragment and authenticated edit lineage only; explicit reviewer dependency checks remain required. No source verdict or mathematical pass.'};
}

export function mathEvidenceSha256(r){return hashObject({id:r.id,paperId:r.paperId,bundleId:r.bundleId,nodeId:r.nodeId,quote:r.quote,focusQuote:r.focusQuote||r.quote,question:r.question,conditions:r.conditions,citations:r.citations||[],encoding:r.encoding||null,mathResult:r.mathResult||null,mathRecoveryPending:r.mathRecoveryPending||null});}
const active=new Set(['math_queued','math_checking','math_resource_blocked']);
export function needsActualRecovery(blind,r){return !active.has(r.status)&&(mathTechnicalGap(blind,r)||(!r.mathResult?.toolReceiptId&&['unknown','encoding_error'].includes(r.mathResult?.outcome)));}
function actualTool(blind,r,b){
  check(r.bundleId===b.id&&r.mathResult?.toolReceiptId&&!active.has(r.status)&&!mathTechnicalGap(blind,r),'A completed assigned-version recovery result is required',409,'MATH_RECOVERY_INVALID');
  const t=blind.read('checks',r.mathResult.toolReceiptId);
  check(t.id===r.mathResult.toolReceiptId&&t.reportId===r.id&&t.bundleId===b.id&&t.nodeId===r.nodeId&&t.documentSha256===b.public.document.sha256&&t.executionCompleted===true&&t.encodingSha256===r.encoding?.sha256&&t.encodingSha256===r.mathResult.encodingSha256,'Recovery tool receipt identity differs',409,'MATH_RECOVERY_INVALID');
  return t;
}
export function actualRecoveryCandidates(q,r,b){
  if(!needsActualRecovery(q.blind,r))return [];
  let binding;try{const original=q.blind.bundle(r.bundleId);binding=frozenMathBinding(q,original,original.nodes.find(n=>n.nodeId===r.nodeId),b);}catch{return [];}
  return q.blind.all('reports').filter(x=>x.id!==r.id&&x.paperId===r.paperId&&x.question===r.question&&x.conditions===r.conditions&&(x.focusQuote||x.quote)===(r.focusQuote||r.quote)).flatMap(x=>{
    try{const original=q.blind.bundle(x.bundleId),t=actualTool(q.blind,x,original),mapped=frozenMathBinding(q,original,original.nodes.find(n=>n.nodeId===x.nodeId),b);if(mapped.targetNodeId!==binding.targetNodeId)return [];return [{reportId:x.id,reportEvidenceSha256:mathEvidenceSha256(x),toolReceiptId:t.id,toolReceiptSha256:hashObject(t),nodeId:mapped.targetNodeId,outcome:x.mathResult.outcome,scope:'Possible actual recovery of this exact concern; the assigned reviewer must explicitly link and interpret it.'}];}catch{return [];}
  });
}
export function validateActualRecovery(q,r,b,entry,items,binding){
  roleField(needsActualRecovery(q.blind,r),'technicalRecoveries.reportId','finished_historical_technical_or_missing_actual_result');
  roleField(entry.bindingSha256===binding.sha256&&entry.claim===r.question&&entry.conditions===r.conditions,'technicalRecoveries.bindingSha256/claim/conditions','exact_exposed_historical_concern');
  const candidate=actualRecoveryCandidates(q,r,b).find(x=>x.reportId===entry.recoveryReportId);
  roleField(candidate&&candidate.reportEvidenceSha256===entry.recoveryReportEvidenceSha256&&candidate.toolReceiptId===entry.toolReceiptId&&candidate.toolReceiptSha256===entry.toolReceiptSha256,'technicalRecoveries.recoveryReportId','exact_actual_current_tool_receipt');
  roleField(Array.isArray(entry.itemIds)&&entry.itemIds.length>0&&new Set(entry.itemIds).size===entry.itemIds.length,'technicalRecoveries.itemIds','distinct_recovery_items');
  roleField(entry.itemIds.every(id=>items.some(x=>x.id===id&&x.nodeId===candidate.nodeId&&['tool','reuse'].includes(x.method)&&['checked','unknown','unsupported','condition_gap'].includes(x.status)&&x.reportIds?.includes(candidate.reportId)&&x.claim===r.question&&x.conditions===r.conditions&&x.quote===(r.focusQuote||r.quote))),'technicalRecoveries.itemIds','actual_current_check_of_this_concern');
  neutralField(entry.reason,'technicalRecoveries.reason');roleField(entry.reason.length>=40,'technicalRecoveries.reason','explain_actual_recovery_and_historical_failure');
  return {reportId:r.id,historicalEvidenceSha256:mathEvidenceSha256(r),recoveryReportId:candidate.reportId,recoveryEvidenceSha256:candidate.reportEvidenceSha256,toolReceiptId:candidate.toolReceiptId,toolReceiptSha256:candidate.toolReceiptSha256,itemIds:entry.itemIds,reason:entry.reason,historicalResultReused:false,historicalFailurePreserved:true};
}
export function verifyActualRecoveries(q,inventory){
  for(const proof of inventory.technicalRecoveryBindings||[]){
    const r=q.blind.report(proof.reportId),current=q.blind.report(proof.recoveryReportId),b=q.blind.bundle(current.bundleId),tool=actualTool(q.blind,current,b);
    check(mathEvidenceSha256(r)===proof.historicalEvidenceSha256&&mathEvidenceSha256(current)===proof.recoveryEvidenceSha256&&tool.id===proof.toolReceiptId&&hashObject(tool)===proof.toolReceiptSha256,'Retained mathematical recovery evidence changed',409,'MATH_RECOVERY_INVALID');
  }
}
