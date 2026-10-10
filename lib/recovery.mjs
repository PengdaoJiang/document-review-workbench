import fs from 'node:fs';
import path from 'node:path';
import {readJSON,writeJSON,sha,hashFile,atomicWrite,safePath,inside,check,acquireLock,now} from './io.mjs';
import {inputManifest} from './inputs.mjs';
import {assertLegacyExecution} from './source-actor.mjs';
export function ownerContext(config,paper,fixture){
  if(!fixture||config.sourceExecutionDataRoot)assertLegacyExecution(config,paper.paperId,config.sourceExecutionDataRoot);
  if(fixture){check(config.fixture===true,'Fixture configuration required',403);inside(config.root,paper.root);if(config.fixtureReworkOwner){const p=readJSON(config.batchPath).papers.find(p=>p.paperId===paper.paperId);check(process.env.CODEX_THREAD_ID===config.fixtureReworkOwner&&paper.owner===config.fixtureReworkOwner&&p?.threadId===paper.owner,'Admitted fixture requires its actual registered owner context',403,'OWNER_CONTEXT');}}
  else{const p=readJSON(config.batchPath).papers.find(p=>p.paperId===paper.paperId);check(process.env.CODEX_THREAD_ID===paper.owner&&p?.threadId===paper.owner&&path.resolve(p.workerRoot)===path.resolve(paper.root),'Current registered owner context required',403,'OWNER_CONTEXT');}
}
export function clearStaleOwnerLock(config,paper,fixture){
  ownerContext(config,paper,fixture);const lock=safePath(paper.root,'work/review-desk/owner.lock');const record=readJSON(lock);let live=true;
  try{process.kill(record.pid,0);}catch(e){if(e.code==='ESRCH')live=false;}
  check(!live,'Recorded owner process still exists. Do not clear or terminate an active owner.',409,'WRITER_BUSY');
  writeJSON(path.join(path.dirname(lock),'stale-lock-'+Date.now()+'.json'),{...record,clearedAt:now(),clearedBy:paper.owner});fs.unlinkSync(lock);return {cleared:true,recordedPid:record.pid};
}
export async function restoreBefore(config,dataRoot,paper,key,api,{fixture,checkpoint}){
  ownerContext(config,paper,fixture);check(checkpoint,'--checkpoint is required');const {request:r,state:s}=await api('case',{id:key},'GET');check(r.fixture===fixture&&r.spec.owner===paper.owner,'Request owner/pool differs',403);check(s.decision,'No decision/application');
  const work=safePath(paper.root,'work/review-desk'),release=acquireLock(path.join(work,'owner.lock'));
  try{
    const tx=safePath(work,sha(key+'\n'+s.decision.id).slice(0,16)),jp=path.join(tx,'journal.json'),j=readJSON(jp);
    const outputs=safePath(paper.root,'outputs'),target=safePath(outputs,j.target),pdf=safePath(outputs,r.main.replace(/\.tex$/,'.pdf'));
    check(j.decisionId===s.decision.id&&j.owner===paper.owner,'Recovery journal differs');
    const current=inputManifest(outputs,r.main).sha256;
    check(current===j.manifestAfter.sha256||(j.restore&&current===j.manifestBefore.sha256),'Input changed beyond this operation; refusing rollback overwrite',409,'VERSION_CONFLICT');
    check([j.beforePdfSha256,j.finalReport?.result.pdfSha256].includes(hashFile(pdf)),'PDF changed beyond this operation',409,'VERSION_CONFLICT');
    check(hashFile(path.join(tx,'before.tex'))===j.beforeSha256&&hashFile(path.join(tx,'before.pdf'))===j.beforePdfSha256,'Recovery backup hash mismatch',409);
    j.restore=j.restore||{startedAt:now(),by:paper.owner};writeJSON(jp,j);
    atomicWrite(target,fs.readFileSync(path.join(tx,'before.tex')));atomicWrite(pdf,fs.readFileSync(path.join(tx,'before.pdf')));
    j.restore.completedAt=now();j.stage='restored';writeJSON(jp,j);
    const report={id:key,decisionId:s.decision.id,operationId:s.decision.id+'-restored',status:'conflict',message:'Owner restored the exact pre-change TeX/PDF backup at a safe checkpoint. The user decision remains saved. A new build/review and explicit owner reconciliation are required; no automatic reapplication.'};
    await api('report',report);return {restored:true,decisionPreserved:true,receiptMustBeRebuilt:true};
  }finally{release();}
}
