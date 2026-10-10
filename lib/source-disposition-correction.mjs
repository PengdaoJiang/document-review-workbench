import fs from 'node:fs';
import path from 'node:path';
import {check,id,inside,readJSON,hashFile,hashObject} from './io.mjs';
import {sourceActorValid} from './source-actor.mjs';
import {ownerDisposition} from './owner-disposition.mjs';

const legacyMessage='Exact current owner-frozen input and local semantic identity required';
const pureDispositionFailures=new Set([legacyMessage,'Source target or its exact context changed','Candidate changed without a complete bounded owner-return lineage','Registered source worker check and seals required']);
export function sourceDispositionRetry(s,a){
 const r=a.reportId?s.blind.report(a.reportId):null,d=r?.ownerDisposition;
 if(!['human_packet_pending','owner_technical_blocked'].includes(r?.status)||!d?.technicalFailure||!['faithful_source','transcription_uncertain'].includes(d.payload?.disposition))return null;
 check(d.bodySha256===hashObject(d.payload),'Immutable source disposition changed',409,'DISPOSITION_RECEIPT_CHANGED');
 return {action:'retry-disposition',id:r.id,dispositionSha256:d.bodySha256,technicalFailure:d.technicalFailure,scope:'Retry only the technical assembly of the accepted immutable disposition with its original actor and payload. Do not submit a replacement source judgment.'};
}
export function sourceRecoveryOperations(s,a){
 const rows=[],report=a.reportId?s.blind.report(a.reportId):null,paper=s.store.config.papers[a.paperId];if(!report)return rows;
 for(const t of a.attempts){const root=path.join(t.runRoot,'operations');if(!fs.existsSync(root))continue;
  for(const name of fs.readdirSync(root)){const file=inside(root,path.join(root,name,'operation.json'));if(!fs.existsSync(file))continue;const op=readJSON(file);
   if(!['rejected','interrupted'].includes(op.status)||(op.action!=='human-packet'&&op.payload?.id!==a.reportId)||op.digest!==hashObject({action:op.action,payload:op.payload})||op.sourceActor?.assignmentId!==a.id||op.sourceActor?.paperId!==a.paperId||!a.attempts.some(x=>x.id===op.sourceActor?.attemptId)||!sourceActorValid(s.store.root,a.paperId,paper.owner,op.sourceActor))continue;
   if(op.action==='human-packet'&&Object.keys(op.payload).length===0&&op.error?.code==='HUMAN_PACKET_LOCATOR_GAP'){
    const route=s.production?.humanRouting?.reportRoute(report),packet=route?.stableFragmentId?s.production.humanRouting.packetRecord(route.stableFragmentId):null;
    if(route?.state==='human_required'&&!route.lock&&!packet?.packageId&&!packet?.caseId)rows.push({priorOperationId:op.id,priorOperationSha256:hashFile(file),priorAttemptId:op.sourceActor.attemptId,action:op.action,code:op.error.code,mode:'supply_packet_locator',nextAction:'human-packet',scope:'The exact empty request stopped before packet creation because its locator was missing. Preserve it and use a fresh linked operation ID with the assigned source worker\'s actual bounded locator. No source verdict, candidate edit or human-scope reopening.'});
    continue;
   }
   const committed=[report.ownerDisposition,...(report.ownerDispositionHistory||[])].filter(Boolean).some(d=>d.bodySha256===hashObject(op.payload));let mode=null;
   if(op.action==='disposition'&&!committed&&!['faithful_source','transcription_uncertain'].includes(report.ownerDisposition?.payload?.disposition)&&(op.status==='rejected'&&op.rejection?.businessMutationStarted===false&&['disposition_document_sha256','disposition_precondition'].includes(op.rejection.kind)||op.status==='interrupted'&&pureDispositionFailures.has(op.error?.message)))mode='new_validated_disposition';
   if(op.action==='disposition'&&op.status==='interrupted'&&op.error?.message==='One bounded exact repair span covering the reported fragment required'&&report.status==='source_triage'&&report.ownerDisposition?.bodySha256===hashObject(op.payload)&&report.ownerDisposition.payload.disposition==='repair'&&!report.ownerReceipt)mode='reregister_incomplete_repair';
   if(op.action==='patch'&&op.status==='interrupted'&&['Exact pre-edit input version required','Registered repair scope is stale','Exact target context was not found'].includes(op.error?.message)&&!fs.existsSync(path.join(root,name,'patch.json'))&&report.status==='owner_rework')mode='reregister_current_repair';
   if(op.action==='return'&&report.status==='owner_rework'&&!report.ownerReceipt&&(op.status==='rejected'&&op.rejection?.kind==='return_precondition'&&op.rejection.businessMutationStarted===false||op.status==='interrupted'&&op.error?.message==='Owner receipt differs'))mode='return_accepted_build_reference';
   if(mode)rows.push({priorOperationId:op.id,priorOperationSha256:hashFile(file),priorAttemptId:op.sourceActor.attemptId,action:op.action,code:op.error?.code,mode,nextAction:mode==='return_accepted_build_reference'?'return':'disposition',scope:mode==='return_accepted_build_reference'?'The old request failed before return mutation. Use a fresh linked operation ID with an exact input.buildReturnReferences entry and the actual comparison review. Never reconstruct actor fields, alter the old request, or relabel an unknown operation.':'Use a fresh operation ID for a genuinely new validated proposal after reading current input and freezing its exact target. Preserve this old request and all accepted judgments. This proof does not retry or resolve any unrelated unknown operation.'});
  }
 }
 return rows;
}
export function validateSourceRecoveryReference(s,a,reference){
 check(reference&&Object.keys(reference).length===2&&typeof reference.priorOperationId==='string'&&typeof reference.priorOperationSha256==='string','Exact prior rejection reference required',409,'RECOVERY_REFERENCE');
 const options=sourceRecoveryOperations(s,a).filter(x=>x.priorOperationId===reference.priorOperationId&&x.priorOperationSha256===reference.priorOperationSha256);check(options.length===1,'The previous operation is not a proved recoverable precondition or incomplete registration',409,'RECOVERY_REFERENCE');return options[0];
}
export function rejectedDocumentBinding(op){
 return op.action==='disposition'&&(
  op.status==='rejected'&&op.rejection?.kind==='disposition_document_sha256'&&op.rejection.businessMutationStarted===false||
  op.status==='interrupted'&&op.error?.code==='VERSION_CONFLICT'&&op.error.message===legacyMessage
 );
}

export function dispositionCorrectionOptions(s,a){
 const rows=[];
 for(const attempt of a.attempts){
  const dir=path.join(attempt.runRoot,'operations');if(!fs.existsSync(dir))continue;
  for(const name of fs.readdirSync(dir)){
   const file=inside(dir,path.join(dir,name,'operation.json'));if(!fs.existsSync(file))continue;
   const op=readJSON(file);
   if(rejectedDocumentBinding(op)&&op.payload?.disposition==='faithful_source')rows.push({priorOperationId:op.id,priorOperationSha256:hashFile(file),bundleId:op.payload.bundleId,priorAttemptId:op.sourceActor?.attemptId,scope:'Candidate for exact document-hash-only correction; current registration and every original business gate still apply.'});
  }
 }
 return rows;
}

// Deliberately cannot accept replacement prose, source evidence or a new bundle.
export function planDispositionDocumentCorrection(s,a,b){
 check(Object.keys(b).every(k=>['priorOperationId','priorOperationSha256'].includes(k)),'Only an exact rejected operation reference is accepted',422,'CORRECTION_SCOPE');
 id(b.priorOperationId);check(/^[a-f0-9]{64}$/.test(b.priorOperationSha256||''),'Exact prior receipt hash required',422,'CORRECTION_SCOPE');
 const files=a.attempts.map(t=>path.join(t.runRoot,'operations',b.priorOperationId,'operation.json')).filter(f=>fs.existsSync(f)&&hashFile(f)===b.priorOperationSha256);
 check(files.length===1,'Exact prior operation must occur once in this assignment',409,'CORRECTION_RECEIPT_REQUIRED');
 const file=files[0],op=readJSON(file),paper=s.store.config.papers[a.paperId];
 check(op.id===b.priorOperationId&&op.digest===hashObject({action:op.action,payload:op.payload})&&rejectedDocumentBinding(op),'Operation was not a proved pre-mutation document-binding rejection',409,'CORRECTION_REJECTION_REQUIRED');
 check(op.sourceActor?.assignmentId===a.id&&op.sourceActor?.paperId===a.paperId&&a.attempts.some(t=>t.id===op.sourceActor.attemptId)&&sourceActorValid(s.store.root,a.paperId,paper.owner,op.sourceActor),'Original actual source actor proof required',409,'CORRECTION_ACTOR_REQUIRED');
 check(op.payload?.id===a.reportId&&op.payload.disposition==='faithful_source'&&op.payload.evidence?.reviewedBy===op.sourceActor.threadId,'Only this assigned existing faithful-source observation is eligible',409,'CORRECTION_SCOPE');
 const report=s.blind.report(a.reportId),bundle=s.blind.bundle(op.payload.bundleId);
 check(report.paperId===a.paperId&&bundle.paperId===a.paperId&&bundle.owner===paper.owner&&bundle.nodes.some(n=>n.semanticId===report.semanticId),'Original owner, bundle and semantic identity must already agree',409,'CORRECTION_SCOPE');
 s.blind.viewBundle(bundle.id);
 const expected=bundle.public.document.sha256;
 check(op.payload.documentSha256!==expected,'This is not a document-hash mismatch',409,'CORRECTION_SCOPE');
 const body={...op.payload,documentSha256:expected};
 const provenance={kind:'document_sha256_only',assignmentId:a.id,priorOperationId:op.id,priorOperationSha256:b.priorOperationSha256,priorDigest:op.digest,originalActorProofSha256:op.sourceActor.proofSha256,correctedBodySha256:hashObject(body)};
 // A retry may encounter this exact committed correction after a lost response.
 if(report.ownerDisposition)check(report.ownerDisposition.bodySha256===hashObject(body)&&report.ownerDisposition.correction&&hashObject(report.ownerDisposition.correction)===hashObject(provenance),'A different business disposition already exists',409,'CORRECTION_ALREADY_COMMITTED');
 return {body,sourceActor:op.sourceActor,provenance,priorOperationPath:file};
}

export async function correctDispositionDocument(s,a,b,authority){
 authority.assert();const planned=planDispositionDocumentCorrection(s,a,b);
 authority.assert();
 // Original validation still checks decisions, exact source seals, current local
 // target/repair lineage and evidence. This routine never reads or judges pixels.
 const result=await ownerDisposition(s.blind,a.paperId,planned.body,{sourceActor:planned.sourceActor,authority,correction:planned.provenance});
 return {...result,correction:planned.provenance};
}
