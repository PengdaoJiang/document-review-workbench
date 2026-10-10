import fs from 'node:fs';
import {correspondenceScope,recordCorrespondence,correspondenceDelivery,sourceCorrespondenceActions} from './source-correspondence.mjs';
import {bindUnchangedAcceptance} from './acceptance-carry.mjs';
import path from 'node:path';
import {check,readJSON,writeJSON,hashObject,hashFile,sha,safePath,atomicWrite,now,id} from './io.mjs';
import {inputManifest,verifyAuthority,validateProjectInputs} from './inputs.mjs';
import {locate} from './target.mjs';
import {ownerDisposition} from './owner-disposition.mjs';
import {correctDispositionDocument,validateSourceRecoveryReference} from './source-disposition-correction.mjs';
import {reworkReceipt,registerLocator,ownerEngine} from './blind-bridge.mjs';
import {verifyReworkReceipt} from './rework-evidence.mjs';
import {renderSource} from './build.mjs';
import {applyDecision} from './apply.mjs';
import {faithfulDispositionValid} from './review-ledger.mjs';
import {sourceActorValid} from './source-actor.mjs';

export function acceptedBuildReceipt(s,a,reference){
 check(reference&&typeof reference.id==='string'&&id(reference.id)===reference.id&&/^[a-f0-9]{64}$/.test(reference.sha256),'Exact accepted build operation reference required',409,'BUILD_REFERENCE_INVALID');
 const matches=a.attempts.map(t=>({attempt:t,file:path.join(t.runRoot,'operations',reference.id,'operation.json')})).filter(x=>fs.existsSync(x.file));
 const found=matches.find(x=>hashFile(x.file)===reference.sha256);check(found,'Accepted build operation reference is missing or changed',409,'BUILD_REFERENCE_INVALID');const op=readJSON(found.file),p=s.store.config.papers[a.paperId],actor=op.acceptedBy||op.sourceActor;
 check(op.id===reference.id&&op.action==='build'&&op.status==='accepted'&&op.digest===hashObject({action:op.action,payload:op.payload})&&op.sourceActor?.assignmentId===a.id&&op.sourceActor.paperId===a.paperId&&a.attempts.some(t=>t.id===op.sourceActor.attemptId)&&actor?.assignmentId===a.id&&actor.paperId===a.paperId&&a.attempts.some(t=>t.id===actor.attemptId)&&sourceActorValid(s.store.root,a.paperId,p.owner,op.sourceActor)&&sourceActorValid(s.store.root,a.paperId,p.owner,actor),'Build must be accepted by this registered assignment',409,'BUILD_REFERENCE_INVALID');
 const receipt=op.result?.receipt,bundle=op.result?.bundle;check(receipt&&bundle?.paperId===a.paperId&&bundle.id===receipt.bundleId&&bundle.manifest.sha256===receipt.inputSha256&&(!op.payload.id||op.payload.id===a.reportId),'Accepted build result differs',409,'BUILD_REFERENCE_INVALID');
 verifyReworkReceipt(s.blind,s.blind.bundle(bundle.id),receipt);return structuredClone(receipt);
}
export function buildReturnReferences(s,a){
 const rows=[];for(const t of a.attempts){const dir=path.join(t.runRoot,'operations');if(!fs.existsSync(dir))continue;for(const name of fs.readdirSync(dir))try{const file=path.join(dir,name,'operation.json');if(!fs.existsSync(file))continue;const op=readJSON(file);if(op.action!=='build'||op.status!=='accepted')continue;const reference={id:op.id,sha256:hashFile(file)},receipt=acceptedBuildReceipt(s,a,reference);rows.push({...reference,bundleId:receipt.bundleId,inputSha256:receipt.inputSha256,comparisonSha256:receipt.comparisonSha256,comparisonPath:safePath(s.store.root,receipt.comparisonRelative),scope:'Reuse this exact accepted build receipt by reference; an actual source/candidate comparison review is still required.'});}catch{}}
 return rows;
}

export function businessDelivery(s,a){
 if(a.sourceCorrespondenceSha256)return correspondenceDelivery(s,a);
 if(a.sourceComparisonScopeSha256){const c=s.production.humanRouting.comparisonRecord(a.sourceComparisonScopeSha256);if(!c)return null;check(c.record.scope.reportId===a.reportId&&c.record.scope.paperId===a.paperId&&c.record.sourceActor.assignmentId===a.id,'Comparison belongs to another assignment',409,'SOURCE_COMPARISON_RECEIPT');return {status:'initial_source_comparison',reportId:a.reportId,scopeSha256:a.sourceComparisonScopeSha256,comparisonReceiptSha256:c.sha256};}
 if(a.requestId){const state=s.store.state(a.requestId);if(state.decision?.id!==a.decisionId)return null;if(state.status==='verified')return {status:'decision_applied',requestId:a.requestId,decisionId:a.decisionId,verification:state.verification};if(state.decision.action==='return'&&state.ownerReceivedAt)return {status:'human_return_received',requestId:a.requestId,decisionId:a.decisionId};}
 if(a.reportId){const r=s.blind.report(a.reportId),human=s.production?.humanRouting?.reportRoute(r);
  if(human?.humanCase)return {status:'human_question',reportId:r.id,caseId:human.humanCase.caseId,stableFragmentId:human.stableFragmentId};
  if(human?.state==='human_decided')return {status:'human_decided',reportId:r.id,stableFragmentId:human.stableFragmentId,decisionId:human.lock.decisionId,closureBasis:'human_decided'};
  if(human&&['human_required','awaiting_human','technical_gap','human_decided_pending_mechanical_application'].includes(human.state))return null;
  if(!['owner_rework','awaiting_human','awaiting_owner_edit'].includes(r.status)&&faithfulDispositionValid(s.blind,r))return {status:'faithful_source',reportId:r.id,dispositionSha256:r.ownerDisposition?.bodySha256};
  if(['completion_recheck','closed_completion','closed_source_correction'].includes(r.status)&&r.ownerReceipt){verifyReworkReceipt(s.blind,s.blind.bundle(r.returnedBundleId),r.ownerReceipt);return {status:'repaired_returned',reportId:r.id,bundleId:r.returnedBundleId,receiptSha256:hashObject(r.ownerReceipt)};}
  if(r.status==='awaiting_human'&&r.caseId){const request=s.store.request(r.caseId);check(request.spec.paperId===a.paperId,'Human case belongs to another paper');return {status:'human_question',reportId:r.id,caseId:r.caseId};}
  if(r.status==='closed_ruling')return {status:'existing_human_ruling',reportId:r.id,rulingId:r.rulingId};
 }
 return null;
}

// A receipt remains a receipt when a subsequent blind review or human decision
// advances the report. Validate its specific durable evidence, not a prose exit
// status, and do not require the report to remain in its old workflow stage.
export function verifyBusinessDelivery(s,a,result){
 const fail=()=>check(false,'Delivery does not match the assigned durable business evidence',409,'DELIVERY_EVIDENCE_INVALID');
 check(result?.paperApproval===false,'Delivery cannot approve a paper',409,'DELIVERY_EVIDENCE_INVALID');
 if(result.status==='technical_gap'){check(typeof result.reason==='string'&&result.reason.length>=40&&typeof result.code==='string','Specific technical-gap evidence required',409,'DELIVERY_EVIDENCE_INVALID');return true;}
 if(a.sourceCorrespondenceSha256){const actual=correspondenceDelivery(s,a);check(actual&&hashObject(actual)===hashObject(Object.fromEntries(Object.keys(actual).map(k=>[k,result[k]]))),'Actual source correspondence delivery required',409,'SOURCE_MAP_RECEIPT');return true;}
 if(a.sourceComparisonScopeSha256){const actual=businessDelivery(s,a);check(actual&&hashObject(actual)===hashObject(Object.fromEntries(Object.keys(actual).map(k=>[k,result[k]]))),'Actual bounded source comparison receipt required',409,'DELIVERY_EVIDENCE_INVALID');return true;}
 if(a.reportId){const r=s.blind.report(a.reportId);check(result.reportId===r.id&&r.paperId===a.paperId,'Delivery report differs from assignment',409,'DELIVERY_EVIDENCE_INVALID');
  if(result.status==='human_decided'){const route=s.production?.humanRouting?.reportRoute(r);check(route?.state==='human_decided'&&route.stableFragmentId===result.stableFragmentId&&route.lock.decisionId===result.decisionId,'Actual final human closure differs',409,'DELIVERY_EVIDENCE_INVALID');return true;}
  if(result.status==='human_question'&&result.stableFragmentId){const packet=s.production?.humanRouting?.packetRecord(result.stableFragmentId),request=s.store.request(result.caseId);check(packet?.caseId===result.caseId&&request.spec.fragmentHumanOrigin?.stableFragmentId===result.stableFragmentId&&request.spec.paperId===a.paperId,'Required fragment case is not durably delivered',409,'DELIVERY_EVIDENCE_INVALID');return true;}
  if(result.status==='faithful_source'){check(faithfulDispositionValid(s.blind,r)&&r.ownerDisposition?.bodySha256===result.dispositionSha256,'Source disposition evidence differs',409,'DELIVERY_EVIDENCE_INVALID');return true;}
  if(result.status==='repaired_returned'){check(r.returnedBundleId===result.bundleId&&r.ownerReceipt&&hashObject(r.ownerReceipt)===result.receiptSha256,'Returned repair receipt differs',409,'DELIVERY_EVIDENCE_INVALID');verifyReworkReceipt(s.blind,s.blind.bundle(result.bundleId),r.ownerReceipt);return true;}
  if(result.status==='human_question'){check(r.caseId===result.caseId,'Human case differs',409,'DELIVERY_EVIDENCE_INVALID');const request=s.store.request(result.caseId);check(request.spec.paperId===a.paperId&&request.spec.ownerSourceOrigin?.reportId===a.reportId,'Question was not accepted into this assigned human pool',409,'DELIVERY_EVIDENCE_INVALID');return true;}
  if(result.status==='existing_human_ruling'){check(r.rulingId===result.rulingId&&s.blind.all('rulings').some(x=>x.id===result.rulingId&&x.paperId===a.paperId&&x.closed),'Existing human ruling receipt differs',409,'DELIVERY_EVIDENCE_INVALID');return true;}
 }
 if(a.requestId){const state=s.store.state(a.requestId);check(result.requestId===a.requestId&&result.decisionId===a.decisionId&&state.decision?.id===a.decisionId,'Delivery decision differs',409,'DELIVERY_EVIDENCE_INVALID');
  if(result.status==='decision_applied'){check(state.status==='verified'&&hashObject(state.verification)===hashObject(result.verification),'Actual saved decision verification differs',409,'DELIVERY_EVIDENCE_INVALID');return true;}
  if(result.status==='human_return_received'){check(state.decision.action==='return'&&state.ownerReceivedAt,'Human return was not received',409,'DELIVERY_EVIDENCE_INVALID');return true;}
 }
 return fail();
}

export async function sourceOperation(s,a,action,b,authority,opRoot){
 const p=s.store.config.papers[a.paperId],config=s.store.config,outputs=path.join(p.root,'outputs'),blind=s.blind;
 authority.assert();verifyAuthority(p);
 if(a.sourceCorrespondenceSha256){check(sourceCorrespondenceActions.has(action),'Only bounded source correspondence is authorized',403,'SOURCE_MAP_ACTION');if(action==='map-initial')return recordCorrespondence(s,a,b,authority.actor);if(action==='render')check(correspondenceScope(s.production,a.reportId).scopeSha256===a.sourceCorrespondenceSha256,'Source correspondence scope changed',409,'SOURCE_MAP_SCOPE');}
 if(a.sourceComparisonScopeSha256){check(['compare-initial','render','finish','technical-gap'].includes(action),'Only the assigned source reading comparison is authorized',403,'ASSIGNMENT_SCOPE');if(action==='compare-initial'){check(b.scopeSha256===a.sourceComparisonScopeSha256,'Comparison scope differs',409,'SOURCE_COMPARISON_SCOPE');const c=s.production.humanRouting.recordInitialComparison(a.reportId,b,authority.actor);return {recorded:true,scopeSha256:a.sourceComparisonScopeSha256,receiptSha256:c.sha256,paperApproval:false};}if(action==='render'){const scope=s.production.humanRouting.initialComparisonScope(blind.report(a.reportId));check(scope?.scopeSha256===a.sourceComparisonScopeSha256,'Comparison scope changed or became protected',409,'SOURCE_COMPARISON_SCOPE');}}
 if(a.reportId&&!a.sourceComparisonScopeSha256&&!a.sourceCorrespondenceSha256&&!['human-packet','finish','technical-gap','apply-decision'].includes(action)){
  const report=blind.report(a.reportId),route=s.production?.humanRouting?.reportRoute(report);
  if(action==='disposition'&&route?.state==='human_required')return s.production.humanRouting.assemble(a.reportId,{authority});
  if(!(a.packetOnly&&action==='render'&&!route?.lock))s.production?.humanRouting?.assertReportAction(report,action);
 }
 if(action==='human-packet'){check(a.reportId&&s.production?.humanRouting?.enabled,'Assigned required fragment packet only',403,'ASSIGNMENT_SCOPE');if(b.replacesRejectedOperation)check(validateSourceRecoveryReference(s,a,b.replacesRejectedOperation).mode==='supply_packet_locator'&&b.locator,'Exact missing-locator recovery required',409,'RECOVERY_REFERENCE');return s.production.humanRouting.assemble(a.reportId,{authority,locator:b.locator});}
 const assignedReport=()=>{check(a.reportId&&(!b.id||b.id===a.reportId),'Report is outside this assignment',403,'ASSIGNMENT_SCOPE');const r=blind.report(a.reportId);check(r.paperId===p.paperId,'Report paper changed',409);return r;};
 if(action==='render'){
  check(b.locator?.page>=1&&b.locator.page<=p.source.pages&&Array.isArray(b.locator.bbox)&&b.locator.bbox.length===4&&b.locator.bbox.every(Number.isFinite),'An original-page locator is required');
  const out=path.join(opRoot,'original');authority.trackRoot?.(out);const render=await renderSource(config,p,b.locator,p.source.path,out);
  return {sourceSha256:p.source.sha256,locator:b.locator,render,files:render.pages.map(pg=>Object.fromEntries(['cropFile','contextFile','pageFile'].map(k=>[k,{path:path.join(out,pg[k]),sha256:hashFile(path.join(out,pg[k]))}])))};
 }
 if(action==='freeze'){
  const r=assignedReport(),allowed=r.screening?.affectedSemanticIds||[r.semanticId];check(Array.isArray(b.spec?.nodes)&&b.spec.nodes.length>0&&b.spec.nodes.every(n=>allowed.includes(n.semanticId)),'Freeze only the assigned semantic scope',403,'ASSIGNMENT_SCOPE');
  check(inputManifest(outputs,p.main).sha256===b.expectedInputSha256,'Canonical inputs changed before freeze',409,'VERSION_CONFLICT');return blind.freeze(p.paperId,{nodes:b.spec.nodes});
 }
 if(action==='correct-disposition-document')return correctDispositionDocument(s,a,b,authority);
 if(action==='disposition'){assignedReport();check(b.evidence?.reviewedBy===authority.actor.threadId||b.disposition==='technical_gap','Use the actual fresh worker identity',403,'WRITER_FENCED');if(b.replacesRejectedOperation)validateSourceRecoveryReference(s,a,b.replacesRejectedOperation);return ownerDisposition(blind,p.paperId,b,{sourceActor:authority.actor,authority});}
 if(action==='retry-disposition'){const r=assignedReport();check(['human_packet_pending','owner_technical_blocked'].includes(r.status)&&r.ownerDisposition?.technicalFailure&&['faithful_source','transcription_uncertain'].includes(r.ownerDisposition.payload.disposition),'Only an immutable disposition with a recorded assembly failure may be retried',409);return ownerDisposition(blind,p.paperId,r.ownerDisposition.payload,{sourceActor:r.ownerDisposition.sourceActor,authority});}
 if(action==='locate'){const r=assignedReport(),bundle=blind.bundle(b.bundleId);check(bundle.paperId===p.paperId&&bundle.nodes.some(n=>n.nodeId===b.nodeId&&n.semanticId===r.semanticId),'Location differs from this assignment',403);return registerLocator(blind,p.paperId,b.bundleId,b.nodeId,b.locator,b.evidence,{sourceActor:authority.actor});}
 if(action==='patch'){
  const r=assignedReport();check(r.status==='owner_rework'&&r.receivedAt,'Register and receive bounded repair before writing',409,'REPAIR_SCOPE_REQUIRED');
  const prior=blind.bundle(r.reworkBaseBundleId||r.bundleId),ids=r.screening?.affectedSemanticIds||[r.semanticId],declared=ids.map(semanticId=>({semanticId,node:prior.nodes.find(n=>n.semanticId===semanticId),target:r.screening?.repairSpan&&semanticId===r.semanticId?r.screening.repairSpan:prior.nodes.find(n=>n.semanticId===semanticId)?.target}));
  check(Array.isArray(b.edits)&&b.edits.length===declared.length&&new Set(b.edits.map(x=>x.semanticId)).size===declared.length&&b.edits.every(x=>ids.includes(x.semanticId)&&typeof x.text==='string'&&x.text.length>0&&x.text.length<=40000),'All and only registered text ranges must be supplied',403,'ASSIGNMENT_SCOPE');
  check(declared.every(x=>x.target?.file===p.main),'Only declared canonical body text may be changed',403,'ASSIGNMENT_SCOPE');
  const journalFile=path.join(opRoot,'patch.json'),file=safePath(outputs,p.main);let journal=fs.existsSync(journalFile)?readJSON(journalFile):null;
  if(!journal){const before=inputManifest(outputs,p.main);check(before.sha256===b.expectedInputSha256,'Exact pre-edit input version required',409,'VERSION_CONFLICT');const expected=r.screening?.candidateBinding?.currentInputSha256||prior.manifest.sha256;check(expected===before.sha256,'Registered repair scope is stale',409,'VERSION_CONFLICT');
   let text=fs.readFileSync(file,'utf8');const edits=declared.map(d=>({...d,...locate(text,d.target),replacement:b.edits.find(e=>e.semanticId===d.semanticId).text})).sort((x,y)=>y.start-x.start);check(edits.every((e,i)=>!i||e.end<=edits[i-1].start),'Repair ranges overlap');
   s.production?.humanRouting?.assertPatch(p.paperId,prior.id,text,edits);
   atomicWrite(path.join(opRoot,'before.tex'),text);for(const e of edits)text=text.slice(0,e.start)+e.replacement+text.slice(e.end);atomicWrite(path.join(opRoot,'after.tex'),text);
   const files=before.files.map(f=>f.file===p.main?{...f,sha256:sha(text),size:Buffer.byteLength(text)}:f),after={files,sha256:hashObject(files)};
   // Validate the edited file and its unchanged sealed dependencies before commit.
   const validateRoot=path.join(opRoot,'validate');fs.mkdirSync(validateRoot,{recursive:true});for(const f of files){const dest=safePath(validateRoot,f.file,false);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(f.file===p.main?path.join(opRoot,'after.tex'):safePath(outputs,f.file),dest);}validateProjectInputs(validateRoot,after);
   const nodes=declared.map(d=>{const e=edits.find(e=>e.semanticId===d.semanticId),start=e.start+edits.filter(x=>x.start<e.start).reduce((v,x)=>v+x.replacement.length-(x.end-x.start),0),end=start+e.replacement.length;return {...d.node,target:{...d.target,oldText:e.replacement,oldSha256:sha(e.replacement),before:text.slice(Math.max(0,start-120),start),after:text.slice(end,end+120)}};});
   journal={at:now(),reportId:r.id,before,after,nodes,sourceActor:authority.actor};writeJSON(journalFile,journal);
  }
  const current=inputManifest(outputs,p.main).sha256;check([journal.before.sha256,journal.after.sha256].includes(current),'Input changed beyond this idempotent edit',409,'VERSION_CONFLICT');
  if(current===journal.before.sha256){
   const beforeText=fs.readFileSync(path.join(opRoot,'before.tex'),'utf8'),afterFile=path.join(opRoot,'after.tex');
   check(sha(beforeText)===journal.before.files.find(f=>f.file===p.main)?.sha256&&hashFile(afterFile)===journal.after.files.find(f=>f.file===p.main)?.sha256,'Saved patch bytes differ from the exact journal',409,'VERSION_CONFLICT');
   s.production?.humanRouting?.assertPatch(p.paperId,prior.id,beforeText,declared.map(d=>locate(beforeText,d.target)));
   authority.assert();atomicWrite(file,fs.readFileSync(afterFile));
  }
  check(inputManifest(outputs,p.main).sha256===journal.after.sha256,'Fenced input write differs',409,'VERSION_CONFLICT');return {applied:true,beforeInputSha256:journal.before.sha256,inputSha256:journal.after.sha256,nodes:journal.nodes,journal:journalFile};
 }
 if(action==='build'){
  const r=assignedReport();check(r.status==='owner_rework'&&r.receivedAt,'Registered repair required');const ids=r.screening?.affectedSemanticIds||[r.semanticId];check(Array.isArray(b.spec?.nodes)&&hashObject(b.spec.nodes.map(n=>n.semanticId))===hashObject(ids),'Build must include each declared fragment in order');
  check(inputManifest(outputs,p.main).sha256===b.expectedInputSha256,'Repaired input changed',409,'VERSION_CONFLICT');const bundle=blind.freeze(p.paperId,{nodes:b.spec.nodes}),nodes=ids.map(k=>bundle.nodes.find(n=>n.semanticId===k));
  for(const n of nodes)registerLocator(blind,p.paperId,bundle.id,n.nodeId,n.locator,n.locatorEvidence,{sourceActor:authority.actor});
  const receipt=await reworkReceipt(config,s.store.root,p,bundle,nodes[0],nodes,authority);return {bundle,receipt,comparisonPath:path.join(s.store.root,receipt.comparisonRelative),comparison:readJSON(path.join(s.store.root,receipt.comparisonRelative))};
 }
 if(action==='return'){
  const r=assignedReport();let receipt,bundle;
  try{check(!(b.buildOperationReference&&b.receipt),'Choose an accepted build reference or an exact full receipt',409,'BUILD_REFERENCE_INVALID');receipt=b.buildOperationReference?acceptedBuildReceipt(s,a,b.buildOperationReference):b.receipt;bundle=blind.bundle(b.bundleId||receipt?.bundleId);check(bundle.paperId===p.paperId,'Return paper differs',403);verifyReworkReceipt(blind,bundle,receipt);if(b.replacesRejectedOperation)validateSourceRecoveryReference(s,a,b.replacesRejectedOperation);
   check(b.comparisonReview?.comparisonSha256===receipt.comparisonSha256&&typeof b.comparisonReview.note==='string'&&b.comparisonReview.note.length>=40,'Inspect actual generated source and candidate images before return');
  }catch(e){e.sourcePrecondition={kind:'return_precondition',businessMutationStarted:false,reportId:r.id};throw e;}
  authority.assert();const result=blind.returnRework(p.paperId,r.id,bundle.id,receipt);result.sourceWorkerComparison={...b.comparisonReview,sourceActor:authority.actor,at:now()};blind.save('reports',result);s.production.kick();return {id:result.id,status:result.status,bundleId:result.returnedBundleId};
 }
 if(action==='apply-decision'){
  check(a.requestId&&b.decisionId===a.decisionId,'Decision is outside this assignment',403,'ASSIGNMENT_SCOPE');const state=s.store.state(a.requestId);check(state.decision?.id===a.decisionId&&!state.supersededBy,'Saved decision was superseded',409,'VERSION_CONFLICT');
  const api=async(action,body)=>{authority.assert();if(action==='case')return {request:s.store.request(a.requestId),state:s.store.state(a.requestId)};if(action==='receive'){const value=s.store.receive(a.requestId,p.owner,a.decisionId);s.notifications.acknowledgeDecision(a.requestId,a.decisionId);return value;}if(action==='recover-unchanged-accept')return s.store.recoverUnchangedAcceptance(a.requestId,p.owner,a.decisionId);if(action==='carry-unchanged-accept')return bindUnchangedAcceptance(s.store,blind,a.requestId,p.owner,a.decisionId);if(action==='report')return s.store.report(a.requestId,p.owner,{...body,sourceActor:authority.actor});check(false,'Unsupported decision operation');};
  if(state.decision.action==='return'){await api('receive',{});return {received:true,status:'returned',decisionId:a.decisionId};}
  const beforeCommit=({request,decision,text,manifest})=>{const human=s.production?.humanRouting;if(!human?.enabled)return;
   const bundles=blind.all('bundles').filter(x=>x.paperId===p.paperId&&x.manifest.sha256===(manifest||request.manifest).sha256).sort((x,y)=>y.nodes.length-x.nodes.length);
   check(bundles.length,'Exact user edit lacks its frozen review scope',409,'HUMAN_PATCH_SCOPE');human.assertPatch(p.paperId,bundles[0].id,text,[locate(text,request.spec.target)],{decisionId:decision.id});};
  const value=await applyDecision(config,s.store.root,p,a.requestId,api,{fixture:s.store.fixture,checkpoint:true,authority,beforeCommit});blind.reconcileRulings();
  if(s.production?.humanRouting?.enabled&&s.store.state(a.requestId).status==='verified'){
   const request=s.store.request(a.requestId);s.production.freeze(p.paperId,{checkpoint:true,engine:request.engine,note:'Program checkpoint after exact saved user decision application and successful local build; no source reinspection or new blind judgment.'});s.production.humanRouting.reconcile({paperId:p.paperId});
  }return value;
 }
 if(action==='finish'){
  const delivery=businessDelivery(s,a);check(delivery,'No durable business delivery exists; finish the return or record the actual technical gap',409,'DELIVERY_INCOMPLETE');return {...delivery,at:now(),sourceActor:authority.actor,paperApproval:false};
 }
 if(action==='technical-gap'){
  check(typeof b.reason==='string'&&b.reason.length>=40&&typeof b.code==='string','A specific technical diagnosis is required');return {status:'technical_gap',reason:b.reason,code:b.code,at:now(),sourceActor:authority.actor,paperApproval:false};
 }
 check(false,'Unknown source operation',404);
}
