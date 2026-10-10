import fs from 'node:fs';
import path from 'node:path';
import {check,sha,hashFile,readJSON,writeJSON,atomicWrite,safePath,acquireLock,now,uid,inside} from './io.mjs';
import {inputManifest,snapshotInputs,verifyAuthority} from './inputs.mjs';
import {replaceExact,validateDecisionFragment} from './target.mjs';
import {validateSealedFragment} from './sealed-fragment.mjs';
import {compile,changedManifest} from './build.mjs';
import {assertLegacyExecution} from './source-actor.mjs';
import {readAcceptanceBase} from './acceptance-carry.mjs';

export async function applyDecision(config,dataRoot,paper,key,api,{fixture,checkpoint,authority,beforeCommit}){
  if(authority)authority.assert();else assertLegacyExecution(config,paper.paperId,dataRoot);
  check(checkpoint,'Apply only at an owner safe checkpoint (--checkpoint)',409,'CHECKPOINT_REQUIRED');
  const received=await api('case',{id:key},'GET'),r=received.request,d=received.state.decision;
  check(r.fixture===fixture&&r.spec.owner===paper.owner&&r.spec.paperId===paper.paperId,'Application context differs from the request owner/pool',403,'OWNER_CONTEXT');
  if(fixture)inside(config.root,paper.root);
  else if(!authority){const registered=readJSON(config.batchPath).papers.find(x=>x.paperId===paper.paperId);check(process.env.CODEX_THREAD_ID===paper.owner&&registered?.threadId===paper.owner&&path.resolve(registered.workerRoot)===path.resolve(paper.root),'Only the existing registered owner may write canonical input',403,'OWNER_CONTEXT');}
  check(d&&['accept','edit'].includes(d.action),'No applicable decision');check(d.scope==='this_passage_only','Invalid decision scope');
  if(r.spec.category==='blind_source_fidelity'&&d.action==='accept')return {status:'faithful_confirmed',noApplicationRequired:true,decisionId:d.id,scope:'local_transcription_only'};
  if(received.state.status==='verified')return {alreadyVerified:true,result:received.state.verification};
  let recoveryPending=received.state.status==='conflict';
  const recoverable=recoveryPending&&authority&&['Invalid application transition','Canonical version changed after the request was submitted'].includes(received.state.problem)&&d.action==='accept'&&['owner_transcription_uncertainty','mandatory_fragment_human'].includes(r.spec.category);
  check(!recoveryPending||recoverable,'Resolve conflict by a new immutable request revision; saved decision remains',409,'VERSION_CONFLICT');
  await api('receive',{id:key,decisionId:d.id});
  const outputs=safePath(paper.root,'outputs');const workspace=safePath(paper.root,'work/review-desk',false);fs.mkdirSync(workspace,{recursive:true});
  const release=acquireLock(path.join(workspace,'owner.lock'));
  const tx=path.join(workspace,sha(key+'\n'+d.id).slice(0,16));fs.mkdirSync(tx,{recursive:true});
  const journalFile=path.join(tx,'journal.json'),target=safePath(outputs,r.spec.target.file),pdf=safePath(outputs,r.main.replace(/\.tex$/,'.pdf'));
  let journal=fs.existsSync(journalFile)?readJSON(journalFile):null;
  const report=async b=>api('report',{id:key,decisionId:d.id,...b});
  try{
    verifyAuthority(paper);validateDecisionFragment(r,d,tex=>validateSealedFragment(tex,r,safePath(dataRoot,'cases/'+key+'/package/inputs')));
    if(recoveryPending&&received.state.problem==='Invalid application transition'){authority.assert();await api('recover-unchanged-accept',{id:key,decisionId:d.id});recoveryPending=false;}
    if(!journal){
      let baseManifest=r.manifest,applicationBase=null;
      const currentManifest=inputManifest(outputs,r.main);
      if(currentManifest.sha256!==r.manifest.sha256){
        check(authority&&d.action==='accept'&&r.spec.category==='mandatory_fragment_human','Canonical version changed after the request was submitted',409,'VERSION_CONFLICT');
        authority.assert();const bound=await api('carry-unchanged-accept',{id:key,decisionId:d.id});
        applicationBase=bound.applicationBase;const base=readAcceptanceBase(dataRoot,r,d,applicationBase);baseManifest=base.manifest;
        check(inputManifest(outputs,r.main).sha256===baseManifest.sha256&&hashFile(pdf)===base.pdfSha256,'Acceptance base changed before preparation',409,'VERSION_CONFLICT');
        recoveryPending=false;
      }else check(!recoveryPending&&hashFile(pdf)===r.version.pdfSha256,'Canonical version changed after the request was submitted',409,'VERSION_CONFLICT');
      const before=fs.readFileSync(target),old=before.toString('utf8');const changed=replaceExact(old,r.spec.target,d.tex);const after=Buffer.from(changed.text,'utf8');
      beforeCommit?.({request:r,decision:d,text:old,manifest:baseManifest});
      atomicWrite(path.join(tx,'before.tex'),before);atomicWrite(path.join(tx,'before.pdf'),fs.readFileSync(pdf));atomicWrite(path.join(tx,'after.tex'),after);
      const expected=changedManifest(baseManifest,r.spec.target.file,sha(after),after.length);
      journal={schemaVersion:1,id:key,decisionId:d.id,owner:paper.owner,fixture,stage:'prepared',createdAt:now(),beforeSha256:sha(before),afterSha256:sha(after),beforePdfSha256:hashFile(pdf),manifestBefore:baseManifest,manifestAfter:expected,...(applicationBase?{applicationBase}:{}),target:r.spec.target.file,changedRange:{start:changed.start,end:changed.end},attempt:0,paperApproval:false};writeJSON(journalFile,journal);
    }
    check(journal.decisionId===d.id&&journal.owner===paper.owner,'Recovery journal belongs to another owner/decision',409);
    const current=inputManifest(outputs,r.main).sha256;
    if(current===journal.manifestBefore.sha256){
      check(hashFile(target)===journal.beforeSha256,'Target changed immediately before write',409,'VERSION_CONFLICT');
      check(hashFile(path.join(tx,'after.tex'))===journal.afterSha256,'Saved application bytes changed',409,'VERSION_CONFLICT');
      beforeCommit?.({request:r,decision:d,text:fs.readFileSync(target,'utf8'),manifest:journal.manifestBefore});
      authority?.assert();if(journal.beforeSha256!==journal.afterSha256)atomicWrite(target,fs.readFileSync(path.join(tx,'after.tex')));journal.stage='applied';if(authority)journal.sourceActor=authority.actor;writeJSON(journalFile,journal);
    }else check(current===journal.manifestAfter.sha256,'Owner inputs changed after preparation/application; refusing recovery overwrite',409,'VERSION_CONFLICT');
    check(inputManifest(outputs,r.main).sha256===journal.manifestAfter.sha256,'Inputs changed during application',409,'VERSION_CONFLICT');
    if(!journal.appliedReport){journal.appliedReport={operationId:d.id+'-applied',status:'applied',result:{target:r.spec.target.file,beforeSha256:journal.beforeSha256,afterSha256:journal.afterSha256,inputSha256:journal.manifestAfter.sha256,adjacentBytesPreserved:true,appliedAt:now()}};writeJSON(journalFile,journal);}
    await report(journal.appliedReport);
    if(journal.finalReport){await report(journal.finalReport);return journal.finalReport;}
    journal.attempt++;journal.stage='building';writeJSON(journalFile,journal);
    const runRoot=path.join(dataRoot,'applications',sha(key+d.id).slice(0,16),'attempt-'+journal.attempt);const inputs=path.join(runRoot,'inputs');fs.mkdirSync(runRoot,{recursive:true});snapshotInputs(outputs,inputs,journal.manifestAfter);
    authority?.trackRoot?.(runRoot);
    let built;
    try{built=await compile(config,paper,{inputs,build:path.join(runRoot,'build'),main:r.main,manifest:journal.manifestAfter,engine:r.engine,...(!authority?{publish:{outputs,pdf},receipt:true}:{})});if(authority){authority.assert();check(inputManifest(outputs,r.main).sha256===journal.manifestAfter.sha256,'Inputs changed before fenced publish',409,'VERSION_CONFLICT');atomicWrite(pdf,fs.readFileSync(built.pdf));}}
    catch(e){journal.stage='verification_failed';journal.lastError=e.message;writeJSON(journalFile,journal);await report({operationId:d.id+'-failure-'+journal.attempt,status:'verification_failed',message:e.message});return {status:'verification_failed',decisionPreserved:true,error:e.message};}
    check(inputManifest(outputs,r.main).sha256===journal.manifestAfter.sha256&&hashFile(pdf)===built.pdfSha256,'Inputs or PDF changed before acknowledgement',409,'VERSION_CONFLICT');
    const packageId=uid().replaceAll('-','').slice(0,20);const temp=path.join(dataRoot,'results','.'+packageId),dest=path.join(dataRoot,'results',packageId);fs.mkdirSync(temp,{recursive:true});
    fs.copyFileSync(built.pdf,path.join(temp,'result.pdf'));fs.copyFileSync(safePath(outputs,r.main),path.join(temp,'result.tex'));fs.copyFileSync(target,path.join(temp,'target.tex'));
    writeJSON(path.join(temp,'receipt.json'),{...built,pdf:'result.pdf',targetSha256:hashFile(target),decisionId:d.id,requestDigest:r.intentDigest,manifest:journal.manifestAfter,...(journal.applicationBase?{applicationBase:journal.applicationBase}:{})});fs.renameSync(temp,dest);
    journal.stage='verified';journal.finalReport={operationId:d.id+'-verified',status:'verified',result:{packageId,texSha256:built.texSha256,pdfSha256:built.pdfSha256,inputSha256:built.inputSha256,targetSha256:hashFile(target),engine:r.engine,technicalOnly:true,passageOnly:true,paperApproval:false,comparisonReviewStillRequired:true}};writeJSON(journalFile,journal);await report(journal.finalReport);return journal.finalReport;
  }catch(e){if(recoveryPending)throw e;if(e.status===409){if(journal){journal.stage='conflict';journal.lastError=e.message;writeJSON(journalFile,journal);}await report({operationId:d.id+'-conflict-'+sha(e.message).slice(0,12),status:'conflict',message:e.message});return {status:'conflict',decisionPreserved:true,error:e.message};}throw e;
  }finally{release();}
}
