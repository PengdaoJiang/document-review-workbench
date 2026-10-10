import fs from 'node:fs';
import path from 'node:path';
import {check,id,hashObject,writeJSON,readJSON,now,uid,sha,safePath,hashFile,immutableWrite} from './io.mjs';
import {replaceExact,validateDecisionFragment} from './target.mjs';
import {inputManifest,verifyAuthority,verifyManifest} from './inputs.mjs';
import {validateSealedFragment} from './sealed-fragment.mjs';
import {changedManifest} from './build.mjs';
import {inspectPackage} from './package.mjs';
import {routingView,caseListMetadata} from '../public/state-view.js';
import {readAcceptanceBase} from './acceptance-carry.mjs';

export class Store {
  constructor(config,root,fixture=false){this.config=config;this.root=root;this.fixture=fixture;fs.mkdirSync(path.join(root,'cases'),{recursive:true});fs.mkdirSync(path.join(root,'previews'),{recursive:true});this.recoverIngests();}
  recoverIngests(){
    // A crash between moving the package and committing the case directory
    // leaves an intact hidden ingest. Re-stage and replay; never invent a decision.
    const cases=path.join(this.root,'cases');
    for(const name of fs.readdirSync(cases).filter(x=>x.startsWith('.'))){const pack=path.join(cases,name,'package');if(!fs.existsSync(path.join(pack,'request.json')))continue;const r=readJSON(path.join(pack,'request.json'));id(r.packageId);const staging=path.join(this.root,'staging',r.packageId);fs.mkdirSync(path.dirname(staging),{recursive:true});check(!fs.existsSync(staging),'Interrupted ingest has a conflicting staging package',409);fs.renameSync(pack,staging);this.submit(r.packageId,r.spec.paperId);}
    // Reconcile the small second state write after committing a new revision.
    for(const name of fs.readdirSync(cases).filter(x=>!x.startsWith('.'))){const r=this.request(name),old=r.spec.supersedes;if(old&&fs.existsSync(path.join(cases,old))){const s=this.state(old);if(!s.supersededBy){s.supersededBy=r.id;if(!s.decision)s.status='superseded';s.events.push({at:now(),type:'superseded',newRequest:r.id,recovered:true});this.save(old,s);}}}
  }
  caseRoot(key){return safePath(this.root,'cases/'+id(key));}
  request(key){return readJSON(path.join(this.caseRoot(key),'package/request.json'));}
  state(key){return readJSON(path.join(this.caseRoot(key),'state.json'));}
  save(key,s){s.version++;s.updatedAt=now();writeJSON(path.join(this.caseRoot(key),'state.json'),s);return s;}
  list(){return fs.readdirSync(path.join(this.root,'cases')).filter(f=>!f.startsWith('.')).map(key=>{const r=this.request(key),s=this.state(key),route=routingView(r);return {id:key,paperId:r.spec.paperId,kind:r.spec.kind,locator:r.spec.locator.label,question:r.spec.question,routing:{labels:route.labels,shortLabels:route.shortLabels,negativeCount:route.negativeCount},status:s.status,version:s.version,updatedAt:s.updatedAt,...caseListMetadata(r,s),fixture:r.fixture,ownerReceivedAt:s.ownerReceivedAt,preview:s.latestPreview};}).sort((a,b)=>a.id.localeCompare(b.id));}
  submit(packageId,paperId){
    id(packageId);
    if(!fs.existsSync(path.join(this.root,'staging',packageId))){
      for(const item of this.list()){const old=this.request(item.id);if(old.packageId===packageId){check(old.spec.paperId===paperId,'Credential paper differs',403);return {id:old.id,duplicate:true,state:this.state(old.id)};}}
    }
    const {root,request:r}=inspectPackage(this.config,this.root,packageId,this.fixture);check(r.spec.paperId===paperId,'Credential paper differs',403);
    const target=path.join(this.root,'cases',r.id);
    if(fs.existsSync(target)){const old=this.request(r.id);check(old.intentDigest===r.intentDigest,'Request revision already exists with different content',409,'REQUEST_CONFLICT');return {id:r.id,duplicate:true,state:this.state(r.id)};}
    const prior=this.list().map(x=>this.request(x.id)).filter(x=>x.spec.paperId===paperId&&x.spec.issueId===r.spec.issueId).sort((a,b)=>b.spec.revision-a.spec.revision)[0];
    if(prior){check(r.spec.revision>prior.spec.revision&&r.spec.supersedes===prior.id,'A new revision must explicitly supersede the preceding request',409,'REVISION_CONFLICT');check(this.state(prior.id).status!=='applied','Owner must finish or recover the active application before superseding',409);}
    this.humanRouting?.assertNewCase?.(r,root);
    const temp=path.join(this.root,'cases','.'+uid());fs.mkdirSync(temp);fs.renameSync(root,path.join(temp,'package'));
    const s={schemaVersion:1,version:1,status:'pending',createdAt:now(),updatedAt:now(),draft:{version:0,tex:r.spec.target.oldText,note:''},decision:null,ownerReceivedAt:null,application:null,verification:null,events:[{at:now(),type:'submitted'}],operations:{},latestPreview:null,notification:{status:'not_connected',owner:r.spec.owner},paperApproval:false};
    writeJSON(path.join(temp,'state.json'),s);fs.renameSync(temp,target);
    if(prior){const previous=this.state(prior.id);previous.supersededBy=r.id;previous.events.push({at:now(),type:'superseded',newRequest:r.id});if(!previous.decision)previous.status='superseded';this.save(prior.id,previous);}
    return {id:r.id,duplicate:false,state:s};
  }
  editDraft(key,body){const s=this.state(key);check(!s.decision&&!s.supersededBy,'A saved or superseded decision is immutable',409,'DECISION_EXISTS');if(body.baseVersion===s.draft.version-1&&body.tex===s.draft.tex&&body.note===s.draft.note)return s.draft;check(body.baseVersion===s.draft.version,'Draft changed in another tab; copy your local text before reloading',409,'DRAFT_CONFLICT');check(typeof body.tex==='string'&&body.tex.length<=40000&&typeof body.note==='string'&&body.note.length<=4000,'Invalid draft');s.draft={version:s.draft.version+1,tex:body.tex,note:body.note,savedAt:now()};this.save(key,s);return s.draft;}
  defer(key,body){const s=this.state(key);check(!s.decision&&!s.supersededBy,'Decision is saved or request superseded',409);s.status=body.deferred?'deferred':'pending';s.events.push({at:now(),type:s.status});return this.save(key,s);}
  decide(key,body){
    const r=this.request(key),s=this.state(key);id(body.operationId);const digest=hashObject(body);
    if(s.operations[body.operationId]){check(s.operations[body.operationId]===digest,'Idempotency key reused with another decision',409,'OPERATION_CONFLICT');return s;}
    check(!s.decision&&!s.supersededBy,'This request already has a saved decision or was superseded',409,'DECISION_EXISTS');
    check(body.requestDigest===r.intentDigest,'Decision targets a different immutable request',409,'REQUEST_CONFLICT');
    check(body.draftVersion===s.draft.version,'Save the latest draft before deciding',409,'DRAFT_CONFLICT');
    const packageRoot=path.join(this.caseRoot(key),'package'),seal=readJSON(path.join(packageRoot,'seal.json'));
    for(const rel of Object.values(r.artifacts)){const expected=seal.files.find(f=>f.file===rel)?.sha256;check(expected&&hashFile(safePath(packageRoot,rel))===expected,'Immutable review evidence changed; no decision saved',409,'EVIDENCE_CHANGED');}
    check(['accept','edit','return'].includes(body.action),'Invalid decision action');
    const tex=body.action==='accept'?r.spec.target.oldText:s.draft.tex;
    if(body.action==='edit'){
      validateSealedFragment(tex,r,safePath(packageRoot,'inputs'));
      const p=this.preview(body.previewId);check(p.caseId===key&&p.status==='succeeded'&&p.fragmentSha256===sha(tex)&&p.requestDigest===r.intentDigest,'Compile and view this exact draft before submitting',409,'PREVIEW_REQUIRED');
      check(p.artifactHashes,'Preview evidence needs a new compilation after the local protocol update',409,'PREVIEW_REQUIRED');
      for(const [name,rel] of Object.entries(p.artifacts))check(hashFile(safePath(path.join(this.root,'previews',p.id),rel))===p.artifactHashes[name],'Preview artifact changed; recompile this draft',409,'EVIDENCE_CHANGED');
      check(body.viewedPdfSha256===p.build.pdfSha256,'The viewed PDF does not match this draft',409,'PREVIEW_REQUIRED');
    }
    if(body.action==='return')check(s.draft.note.trim().length>=2,'Please explain what the owner must recheck');
    s.decision={id:uid(),operationId:body.operationId,requestDigest:r.intentDigest,action:body.action,tex,texSha256:sha(tex),note:s.draft.note,previewId:body.action==='edit'?body.previewId:null,previewPdfSha256:body.action==='edit'?body.viewedPdfSha256:r.baseBuild.pdfSha256,by:this.fixture?'fixture_test_decision':'local_user',scope:'this_passage_only',savedAt:now()};
    s.operations[body.operationId]=digest;s.status=body.action==='return'?'returned':body.action==='accept'&&['blind_source_fidelity','owner_transcription_uncertainty','mandatory_fragment_human'].includes(r.spec.category)?'faithful_confirmed':'decided';s.events.push({at:now(),type:'decision_saved',decisionId:s.decision.id});s.notification={status:'not_connected',owner:r.spec.owner,decisionId:s.decision.id};const saved=this.save(key,s);this.humanRouting?.reconcile();return saved;
  }
  receive(key,owner,decisionId){const r=this.request(key),s=this.state(key);check(r.spec.owner===owner,'Owner differs',403);check(!s.supersededBy,'Request was superseded; do not apply an older decision',409,'REVISION_CONFLICT');check(s.decision?.id===decisionId,'Decision differs',409);if(!s.ownerReceivedAt){s.ownerReceivedAt=now();s.events.push({at:now(),type:'owner_received'});this.save(key,s);}return {request:r,state:s};}
  // Called only by the fenced source-application adapter while its owner lock
  // is held. This repairs one old transport transition, never a content conflict.
  recoverUnchangedAcceptance(key,owner,decisionId){
    const r=this.request(key),s=this.state(key),d=s.decision,p=this.config.papers[r.spec.paperId];
    const requireMatch=(ok,message)=>check(ok,message,409,'APPLICATION_RECOVERY_MISMATCH');
    requireMatch(r.spec.owner===owner&&p?.owner===owner&&d?.id===decisionId&&!s.supersededBy&&!!s.ownerReceivedAt,'Recovery owner, receipt or decision differs');
    requireMatch(d.action==='accept'&&['owner_transcription_uncertainty','mandatory_fragment_human'].includes(r.spec.category),'Only an unchanged fragment acceptance can use this recovery');
    validateDecisionFragment(r,d);verifyAuthority(p);
    if(s.status==='faithful_confirmed'&&s.events.some(e=>e.type==='application_transition_recovered'&&e.decisionId===d.id))return s;
    requireMatch(s.status==='conflict'&&s.problem==='Invalid application transition'&&!s.application&&!s.verification&&!s.operations[d.id+'-applied'],'The recorded conflict is not the unapplied acceptance transition');
    const outputs=safePath(p.root,'outputs'),tx=safePath(p.root,'work/review-desk/'+sha(key+'\n'+d.id).slice(0,16)),journalFile=safePath(tx,'journal.json'),j=readJSON(journalFile),target=safePath(outputs,r.spec.target.file),pdf=safePath(outputs,r.main.replace(/\.tex$/,'.pdf'));
    requireMatch(j.id===key&&j.decisionId===d.id&&j.owner===owner&&j.fixture===this.fixture&&j.stage==='conflict'&&j.lastError==='Invalid application transition'&&j.attempt===0&&!j.finalReport,'The application journal is not the diagnosed pre-build failure');
    verifyManifest(safePath(this.caseRoot(key),'package/inputs'),r.manifest);
    const current=inputManifest(outputs,r.main),targetSha256=hashFile(target),pdfSha256=hashFile(pdf);
    requireMatch(hashObject(j.manifestBefore)===hashObject(r.manifest)&&hashObject(j.manifestAfter)===hashObject(r.manifest)&&current.sha256===r.manifest.sha256,'Application inputs changed since the saved decision');
    requireMatch(j.target===r.spec.target.file&&j.beforeSha256===targetSha256&&j.afterSha256===targetSha256&&hashFile(safePath(tx,'before.tex'))===targetSha256&&hashFile(safePath(tx,'after.tex'))===targetSha256,'Application bytes are not an unchanged acceptance');
    requireMatch(j.beforePdfSha256===r.version.pdfSha256&&pdfSha256===r.version.pdfSha256&&hashFile(safePath(tx,'before.pdf'))===pdfSha256,'The canonical PDF changed before acceptance recovery');
    requireMatch(j.appliedReport?.operationId===d.id+'-applied'&&j.appliedReport.status==='applied'&&j.appliedReport.result?.beforeSha256===targetSha256&&j.appliedReport.result.afterSha256===targetSha256&&j.appliedReport.result.inputSha256===current.sha256,'The interrupted application receipt differs');
    const relative='application-recoveries/'+sha(key+'\n'+d.id).slice(0,32)+'.json',file=safePath(this.root,relative,false),evidence={schemaVersion:1,kind:'unchanged_accept_transition',requestId:key,requestDigest:r.intentDigest,decisionId:d.id,stateBefore:s,journalBefore:j,inputSha256:current.sha256,targetSha256,pdfSha256,paperApproval:false};
    // No timestamp or mutable actor in the immutable preimage: a crash between
    // evidence and state commits can replay these exact bytes safely.
    immutableWrite(file,JSON.stringify(evidence,null,2)+'\n');
    s.status='faithful_confirmed';delete s.problem;s.events.push({at:now(),type:'application_transition_recovered',decisionId:d.id,evidence:relative,evidenceSha256:hashFile(file),paperApproval:false});return this.save(key,s);
  }
  report(key,owner,body){
    const r=this.request(key),s=this.state(key);check(r.spec.owner===owner,'Owner differs',403);check(s.decision?.id===body.decisionId,'Decision differs',409);id(body.operationId);const digest=hashObject(body);
    if(s.operations[body.operationId]){check(s.operations[body.operationId]===digest,'Receipt id reused',409);return s;}
    check(s.ownerReceivedAt,'Owner must acknowledge receipt before applying',409);
    check(['applied','verified','verification_failed','conflict'].includes(body.status),'Unknown owner status');
    check(s.decision.action!=='return','Returned item needs a new request revision',409);
    if(body.status==='applied'){
      const unchanged=s.status==='faithful_confirmed'&&s.decision.action==='accept'&&['owner_transcription_uncertainty','mandatory_fragment_human'].includes(r.spec.category);
      if(unchanged)validateDecisionFragment(r,s.decision);
      check(unchanged||['decided','applied','verification_failed'].includes(s.status),'Invalid application transition',409);
    }
    if(body.status==='verified'||body.status==='verification_failed')check(['applied','verification_failed'].includes(s.status),'No recorded application',409);
    if(body.status==='verified'){
      check(body.result?.texSha256&&body.result?.pdfSha256&&body.result?.inputSha256&&body.result?.packageId,'Complete fresh build result required');
      const pack=safePath(this.root,'results/'+id(body.result.packageId));const receipt=readJSON(safePath(pack,'receipt.json'));
      check(receipt.success&&receipt.pdfSha256===body.result.pdfSha256&&receipt.texSha256===body.result.texSha256&&receipt.inputSha256===body.result.inputSha256,'Result receipt is unbound');
      check(hashFile(safePath(pack,'result.pdf'))===body.result.pdfSha256&&hashFile(safePath(pack,'result.tex'))===body.result.texSha256,'Result files differ');
      const base=s.applicationBase?readAcceptanceBase(this.root,r,s.decision,s.applicationBase):null;
      if(base){
        check(hashObject(receipt.applicationBase)===hashObject(s.applicationBase)&&s.application.beforeSha256===base.targetSha256&&s.application.afterSha256===base.targetSha256&&s.application.inputSha256===base.manifest.sha256,'Result acceptance base differs',409,'RESULT_MISMATCH');
        check(inputManifest(safePath(this.config.papers[r.spec.paperId].root,'outputs'),r.main).sha256===base.manifest.sha256,'Current acceptance inputs changed before verification',409,'RESULT_MISMATCH');
      }else check(!receipt.applicationBase,'Unexpected acceptance base',409,'RESULT_MISMATCH');
      const old=base?base.targetText:fs.readFileSync(safePath(path.join(this.caseRoot(key),'package'),'inputs/'+r.spec.target.file),'utf8');
      const expected=replaceExact(old,r.spec.target,s.decision.tex).text,expectedManifest=changedManifest(base?base.manifest:r.manifest,r.spec.target.file,sha(expected),Buffer.byteLength(expected));
      check(receipt.decisionId===s.decision.id&&receipt.requestDigest===r.intentDigest&&hashFile(safePath(pack,'target.tex'))===sha(expected)&&receipt.inputSha256===expectedManifest.sha256,'Result does not implement exactly this saved decision',409,'RESULT_MISMATCH');
      s.verification=body.result;
      delete s.problem;
    }else if(body.status==='applied')s.application=body.result;
    else s.problem=body.message;
    s.operations[body.operationId]=digest;s.status=body.status;s.events.push({at:now(),type:body.status,message:body.message||null});const saved=this.save(key,s);this.humanRouting?.reconcile();return saved;
  }
  preview(key){return readJSON(safePath(this.root,'previews/'+id(key)+'/state.json'));}
  savePreview(p){writeJSON(path.join(this.root,'previews',id(p.id),'state.json'),p);}
}
