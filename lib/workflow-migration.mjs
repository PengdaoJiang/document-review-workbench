import fs from 'node:fs';import path from 'node:path';
import {check,readJSON,writeJSON,hashFile,hashObject,now,id} from './io.mjs';

// Run only with production dispatch stopped. The proof must describe the old
// role's idle refusal; a deadline or missing receipt is not such a proof.
export function retireIndependentChecker(q,{proofPath,proofSha256,reportId,jobId}){
 check(q.v3&&hashFile(proofPath)===proofSha256,'Verified v3 retirement evidence required',409);
 const proof=readJSON(proofPath),old=q.authority.roles.find(x=>x.kind==='checker');
 check(proof.thread?.id===old?.threadId&&['idle','notLoaded'].includes(proof.thread.status?.type)&&proof.turns?.[0]?.status==='completed','Old checker has not reached a verified safe checkpoint',409);
 check(proof.turns.some(t=>t.items?.some(x=>x.type==='agentMessage'&&x.text.includes(jobId)&&x.text.includes('不启动计算'))),'Exact refused old assignment evidence required',409);
 const r=q.blind.report(reportId),j=q.get(jobId),receiptPath=path.join(q.root,'migrations','old-checker-retirement-ready.json');
 if(fs.existsSync(receiptPath))return readJSON(receiptPath);
 check(j.reportId===r.id&&j.recipient===old.threadId&&!r.encoding&&!r.mathResult&&!q.blind.all('checks').some(c=>c.reportId===r.id),'Retirement must not discard an encoding or actual computation',409);
 check(['math_checking','unknown'].includes(r.status),'Old refused report changed unexpectedly',409);
 const before=structuredClone({report:r,job:j}),caps=[];
 for(const cap of q.blind.all('capabilities'))if(cap.role==='checker'||cap.roleId===old.roleId){cap.revoked=true;cap.revokedAt=now();cap.revocationReason='Independent checker retired by human workflow change';q.blind.save('capabilities',cap);caps.push(cap.id);}
 q.blind.releaseClaim(r);r.previousClaims=[...(r.previousClaims||[]),{...r.claim,retiredWithoutCalculation:true}];delete r.claim;delete r.publicReason;r.status='math_queued';r.events.push({at:now(),type:'old_checker_retired_same_report_returned_to_original_reviewer'});q.blind.save('reports',r);
 const cancelled=[];for(const job of q.jobs())if((job.recipient===old.threadId||job.targetJobId===jobId||job.assignmentId===jobId||(job.reportId===reportId&&job.kind==='engineering'))&&!['completed','cancelled'].includes(job.status)){job.status='cancelled';job.retirement={at:now(),reason:'Original reviewer takes this same report under v3; no new academic unknown',reportId};q.save(job);cancelled.push(job.id);}
 const lease=path.join(q.blind.leaseRoot,'review-desk-checker-lease.json');check(!fs.existsSync(lease)||readJSON(lease).claimId!==before.report.claim?.id,'Historical checker lease not released',409);
 const receipt={schemaVersion:1,status:'old-checker-retirement-ready',at:now(),oldThreadId:old.threadId,proof:{path:proofPath,sha256:proofSha256},before,after:{reportId,status:r.status,revokedCapabilities:caps,cancelledJobs:cancelled,independentRoleCount:0},scope:'Assignment identities and historical evidence retained; no old role wake or mathematical result inferred.'};writeJSON(receiptPath,receipt);return receipt;
}

export function resumeAuditedMath(q,key,{reason,validation}){
 check(q.v3,'Audited recovery belongs to original reviewer workflow',409);const r=q.blind.report(key);
 check(['unknown','encoding_error','math_resource_blocked'].includes(r.status)&&r.encoding&&!r.caseId&&!r.sourceObservation&&(r.auditedRecovery?.attempt||0)<1,'One unresolved audited technical recovery required',409);
 check(typeof reason==='string'&&reason.length>=40&&validation&&hashFile(validation.path)===validation.sha256,'Specific tested platform repair evidence required',409);
 const failed=q.blind.all('checks').filter(c=>c.reportId===r.id&&c.encodingSha256===r.encoding.sha256&&!c.success);
 check(failed.length>0||r.status==='math_resource_blocked','Retained failed actual request required',409);
 if(r.mathResult)r.previousMathResults=[...(r.previousMathResults||[]),r.mathResult];delete r.mathResult;delete r.publicReason;
 r.auditedRecovery={attempt:1,at:now(),encodingSha256:r.encoding.sha256,taskSha256:hashObject(r.encoding.task),reason,validation,priorReceiptIds:failed.map(c=>c.id)};r.status='math_queued';r.platformDiagnostic='A verified platform repair permits one exact audited-payload retry by the original reviewer. Conditions and encoding remain unchanged.';r.events.push({at:now(),type:'audited_payload_technical_recovery'});q.blind.save('reports',r);q.kick();return {id:r.id,status:r.status,encodingSha256:r.encoding.sha256,taskSha256:r.auditedRecovery.taskSha256};
}

// Explicitly retire a stranded v2 location delivery, not its unresolved paper
// report. A prepared receipt permits recovery if the process stops mid-migration.
export function migrateLegacyLocation(q,key,{reason,validation}){
 key=id(key);
 check(q.v3&&typeof reason==='string'&&reason.length>=40&&validation&&hashFile(validation.path)===validation.sha256,'Verified v3 location-routing repair evidence required',409);
 const receiptPath=path.join(q.root,'migrations','location-'+key+'.json'),requestSha256=hashObject({key,reason,validation});
 let receipt=fs.existsSync(receiptPath)?readJSON(receiptPath):null;
 if(receipt){check(receipt.requestSha256===requestSha256,'Location migration request differs',409);if(receipt.status==='migrated')return receipt;}
 const old=q.get(key),r=q.blind.report(old.reportId);q.blind.assertPaperOpen?.(r.paperId);
 check(old.kind==='location'&&old.recipient===q.owner(r.paperId).owner&&r.bundleId===old.bundleId&&r.locationRequest?.jobId===old.id,'Original location assignment identity changed',409);
 if(!receipt){
  check(old.status==='receipt_missing'&&r.status==='awaiting_source_location'&&!r.ownerDisposition&&!r.caseId&&!old.resumeCount,'Only an unresolved legacy location delivery may migrate',409);
  check(!q.jobs().some(j=>j.assignmentId===old.id&&!['completed','cancelled'].includes(j.status)),'A location recovery is already outstanding',409);
  receipt={schemaVersion:1,status:'prepared',at:now(),requestSha256,reason,validation,authority:q.settings.workflowAuthority,before:structuredClone({job:old,report:r})};writeJSON(receiptPath,receipt);
 }
 const details={paperId:r.paperId,reportId:r.id,bundleId:r.bundleId,reportStatus:'source_triage',locationRevision:r.locationRequest.revision};
 const replacement=q.create('owner_business',old.recipient,details);
 if(r.status==='awaiting_source_location'){
  r.status='source_triage';r.events.push({at:now(),type:'legacy_location_routed_to_original_owner',oldJobId:old.id,jobId:replacement.id,receiptPath});q.blind.save('reports',r);
 }
 old.status='cancelled';old.migration={at:receipt.at,kind:'owner_business',jobId:replacement.id,receiptPath};q.save(old);
 for(const j of q.jobs())if(j.kind==='dispatch_attention'&&j.targetJobId===old.id&&!['completed','cancelled'].includes(j.status)){j.status='cancelled';j.migration={jobId:replacement.id,receiptPath};q.save(j);}
 receipt={...receipt,status:'migrated',completedAt:now(),after:{oldJobId:old.id,oldJobStatus:'cancelled',jobId:replacement.id,reportId:r.id,bundleId:r.bundleId,recipient:replacement.recipient},scope:'Routing migration only. The missing delivery remains in before; no owner receipt, source judgment, edit or completion is inferred.'};writeJSON(receiptPath,receipt);q.kick();return receipt;
}
