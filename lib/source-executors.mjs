import {correspondenceScope} from './source-correspondence.mjs';
import {handoffInactiveHumanWork,verifyHumanHandoff} from './human-handoff.mjs';
import fs from 'node:fs';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {CliPoolSettings,maintenancePaused} from './cli-pool-settings.mjs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {check,readJSON,writeJSON,hashFile,hashObject,now,id,uid,inside} from './io.mjs';
import {inputManifest,snapshotInputs,verifyAuthority} from './inputs.mjs';
import {ownerEngine} from './blind-bridge.mjs';
import {PaperWriterRegistry} from './paper-writer-registry.mjs';
import {processIdentity} from './wolfram-registry.mjs';
import {persistSourceActor,sourceActorValid} from './source-actor.mjs';
import {sourceOperation,businessDelivery,verifyBusinessDelivery,buildReturnReferences} from './source-business.mjs';
import {workerEnvironment} from './codex-source-worker.mjs';
import {run} from './process.mjs';
import {dispositionCorrectionOptions,sourceRecoveryOperations,sourceDispositionRetry} from './source-disposition-correction.mjs';

const terminal=new Set(['delivered','technical_gap','human_handoff']);
const sourceKinds=new Set(['source_correspondence','human_packet','source_comparison','owner_business','owner_resume','freeze','location']);
export function sourceWorkScope(a,route,decisionApplicationOnly=false,dispositionRetry=null){
 if(a.sourceCorrespondenceSha256)return {branch:'source_correspondence',reason:'Supply only a source-backed exact initial/current passage correspondence. Preserve all readings and judgments; no edits, mathematical review or automatic human routing.'};
 if(a.sourceComparisonScopeSha256)return {branch:'source_comparison',reason:'Compare only the supplied exact initial/current readings against the retained original-source evidence. Preserve final human scope; no manuscript edit or mathematical review.'};
 if(decisionApplicationOnly)return {branch:'apply_decision',reason:'Apply only the saved decision; no source reinspection.'};
 if(route?.state==='technical_gap')return {branch:'platform_gap',reason:'Fragment identity must be repaired before source work.',code:route.code};
 if(route?.state==='human_required')return {branch:'human_packet',reason:'The current program route requires assembly from retained evidence.'};
 if(['awaiting_human','human_decided','human_decided_pending_mechanical_application'].includes(route?.state))return {branch:'protected_scope',reason:'Preserve the pending or final human boundary; only an existing delivery or specifically assigned saved-decision application may proceed.'};
 if(a.packetOnly)return {branch:'packet_scope_gap',reason:'A packet-only assignment has no current human-required route. Record the routing gap; do not invent a trigger or inspect source content.'};
 if(dispositionRetry)return {branch:'retry_disposition',reason:dispositionRetry.scope};
 return {branch:'source_work',reason:'Continue the original bounded source assignment under current input, registered scope and existing human locks. Historical retry prose does not create a human-packet trigger.'};
}
export class SourceExecutors {
 constructor(production,settings,{auto=true,probe=processIdentity}={}){
  this.production=production;this.blind=production.blind;this.store=production.store;this.notifications=production.notifications;this.settings=settings;this.auto=auto;this.probe=probe;this.root=path.join(this.store.root,'source-executors');this.enabled=!!settings?.enabled;this.busy=false;this.stopped=false;
  this.registry=new PaperWriterRegistry(path.join(this.root,'registry'),{probe});for(const d of ['assignments','attempts','actors','draining','archives'])fs.mkdirSync(path.join(this.root,d),{recursive:true});
  this.runRootBase=path.join(this.store.config.root,'work/source',hashObject(path.resolve(this.store.root)).slice(0,10));
  this.pools=new CliPoolSettings(this.store.root,{source:settings?.maxConcurrent??2});
  if(this.enabled){check(path.resolve(settings.dataRoot)===path.resolve(this.store.root),'Source execution pool differs');this.authority();check(Number.isInteger(settings.maxConcurrent)&&settings.maxConcurrent>=0&&settings.maxConcurrent<=64,'Explicit bounded source worker concurrency required');}
 }
 authority(){const a=this.settings?.authorization;check(a&&hashFile(a.path)===a.sha256,'Temporary execution authorization changed',409);return a;}
 ownerRegistry(){check(!this.settings.ownerRegistrySha256||hashFile(this.settings.ownerRegistry)===this.settings.ownerRegistrySha256,'Historical ownership registry changed',409,'OWNER_CHANGED');return readJSON(this.settings.ownerRegistry);}
 managed(paperId){return this.enabled&&!!paperId&&(this.registry.read(paperId).mode==='cli'||fs.existsSync(path.join(this.root,'draining',id(paperId)+'.json')));}
 migrated(paperId){return this.enabled&&!!paperId&&this.registry.read(paperId).mode==='cli';}
 assignments(){return fs.readdirSync(path.join(this.root,'assignments')).filter(f=>f.endsWith('.json')).map(f=>readJSON(path.join(this.root,'assignments',f)));}
 get(key){return readJSON(path.join(this.root,'assignments',id(key)+'.json'));}
 save(a){a.updatedAt=now();writeJSON(path.join(this.root,'assignments',a.id+'.json'),a);return a;}
 paperFor(job){if(job.paperId)return job.paperId;if(job.kind==='assignment_resume')return this.paperFor(this.production.get(job.assignmentId));return null;}
 handles(job){return (sourceKinds.has(job.kind)||(job.kind==='assignment_resume'&&!job.roleId))&&this.managed(this.paperFor(job));}
 enqueue(origin,job){
  const paperId=this.paperFor(job)||job.paperId,reportId=job.reportId||job.reworkId||(job.assignmentId?this.production.get(job.assignmentId).reportId:null);
  check(this.migrated(paperId),'Paper is draining its permanent owner',409,'HANDOFF_PENDING');
  if(job.kind==='connect'){job.status='cancelled';job.problem='Permanent chat connection superseded by recorded paper handoff';this.notifications.save(job);return null;}
  if(job.kind==='freeze'){const p=this.store.config.papers[paperId],v=this.production.freeze(paperId,{checkpoint:true,...ownerEngine(this.store.root,p),note:'Existing engine receipt reused after recorded temporary-execution handoff; no new source judgment.'});job.status='completed';job.result='existing_engine_current_freeze';this.production.save(job);return v;}
  const report=reportId?this.blind.report(reportId):null,identity={paperId,reportId:reportId||null,requestId:job.requestId||null,decisionId:job.decisionId||null,reworkAttempt:report?.attempts||0,technicalResume:report?.ownerTechnicalResumes||0,caseRevision:report?.caseId||null,...(job.kind==='human_packet'?{stableFragmentId:job.stableFragmentId,humanEpoch:job.humanEpoch,packetOnly:true}:{}),...(job.kind==='source_comparison'?{sourceComparisonScopeSha256:job.sourceComparisonScopeSha256}:{}),...(job.kind==='source_correspondence'?{sourceCorrespondenceSha256:job.sourceCorrespondenceSha256}:{})};
  check(reportId||job.requestId,'A concrete report or saved decision is required');const key='source-'+hashObject(identity).slice(0,24),file=path.join(this.root,'assignments',key+'.json');
  const a=fs.existsSync(file)?readJSON(file):{id:key,...identity,status:'pending',createdAt:now(),attempts:[],origins:[],events:[]};if(!a.origins.some(x=>x.origin===origin&&x.id===job.id))a.origins.push({origin,id:job.id,historicalRecipient:job.recipient||job.owner});this.save(a);
  job.sourceAssignmentId=a.id;job.executionMode='fresh_cli';job.status=terminal.has(a.status)?(a.status==='delivered'?(origin==='notification'?'owner_received':'completed'):'blocked'):'source_pending';job.events.push({at:now(),type:'temporary_execution_route',assignmentId:a.id});(origin==='notification'?this.notifications:this.production).save(job);this.kick();return a;
 }
 async route(origin,job){const p=this.paperFor(job)||job.paperId;if(!this.managed(p))return false;if(!this.migrated(p)){job.status=origin==='notification'?'waiting_owner':'waiting_recipient';job.nextAttemptAt=Date.now()+30000;job.problem='Awaiting explicit safe permanent-owner handoff';(origin==='notification'?this.notifications:this.production).save(job);return true;}this.enqueue(origin,job);return true;}
 packet(a){
  const p=this.store.config.papers[a.paperId];verifyAuthority(p);const manifest=inputManifest(path.join(p.root,'outputs'),p.main),report=a.reportId?this.blind.report(a.reportId):null;
  const bundles=report?[...new Set([report.bundleId,report.reworkBaseBundleId,report.ownerDisposition?.payload.bundleId,report.returnedBundleId].filter(Boolean))].map(k=>this.blind.bundle(k)):[];
  const confidence=path.join(p.root,'outputs/confidence-events.json'),dispositionRetry=sourceDispositionRetry(this,a);
  const fragmentHumanScope=report?this.production.humanRouting?.reportRoute(report)||null:null,decisionApplicationOnly=!!a.requestId&&['accept','edit'].includes(this.store.state(a.requestId).decision?.action);
  if(p.enrollment?.historicalSourceReadings)check(hashFile(p.enrollment.historicalSourceReadings.path)===p.enrollment.historicalSourceReadings.sha256,'Historical source-reading record changed',409,'AUTHORITY_CHANGED');
  return {schemaVersion:1,...(a.sourceCorrespondenceSha256?{initialCorrespondence:correspondenceScope(this.production,a.reportId)}:{}),...(a.sourceComparisonScopeSha256?{initialComparison:this.production.humanRouting.comparisonRecord(a.sourceComparisonScopeSha256)||this.production.humanRouting.initialComparisonScope(report)}:{}),packetOnly:!!a.packetOnly,fragmentHumanScope,decisionApplicationOnly,dispositionRetry,workScope:sourceWorkScope(a,fragmentHumanScope,decisionApplicationOnly,dispositionRetry),recoveryGuidance:a.recoveryGuidance||null,assignmentId:a.id,paperId:a.paperId,reportId:a.reportId,requestId:a.requestId,decisionId:a.decisionId,canonicalRoot:p.root,outputs:path.join(p.root,'outputs'),main:p.main,manifest,source:p.source,mapping:p.mapping,boundaries:p.boundaries,engine:ownerEngine(this.store.root,p),historicalOwner:p.owner,enrollment:p.enrollment||null,report,bundles,dispositionBindings:bundles.map(b=>({bundleId:b.id,documentSha256:b.public.document.sha256,inputSha256:b.manifest.sha256,semanticIds:b.nodes.map(n=>n.semanticId)})),decision:a.requestId?{request:this.store.request(a.requestId),state:this.store.state(a.requestId)}:null,confirmedReadings:fs.existsSync(confidence)?readJSON(confidence):null,applicableRulings:this.blind.all('rulings').filter(r=>r.paperId===a.paperId),tools:this.store.config.tools,comparisonOnly:false,limits:'One assigned source task. Existing source words remain verbatim even when scientifically suspicious. Original PDFs and accepted editions are immutable. Necessary neighboring/full original context is available; no old chat transcript or unrelated work.'};
 }
 async input(paperId,secret,scope){const {holder}=this.registry.validate(paperId,secret,scope),a=this.get(holder.assignmentId);check(a.paperId===paperId&&a.activeAttemptId===holder.attemptId,'Assignment differs',403);const actor=persistSourceActor(this.store.root,this.store.config.papers[paperId],holder),snapshot=path.join(holder.runRoot,'packet.json');return {assignment:a,actor,packet:this.packet(a),dispositionCorrections:dispositionCorrectionOptions(this,a),recoveryOperations:sourceRecoveryOperations(this,a),buildReturnReferences:buildReturnReferences(this,a),assignmentSnapshot:fs.existsSync(snapshot)?{packetPath:snapshot,packetSha256:hashFile(snapshot),inputSha256:readJSON(snapshot).manifest.sha256,inputs:path.join(holder.runRoot,'inputs')}:null,runRoot:holder.runRoot};}
 async operation(paperId,secret,scope,action,body){
  this.activeOperations=(this.activeOperations||0)+1;try{return await this.registry.mutate(paperId,secret,scope,async(state,holder)=>{
   const a=this.get(holder.assignmentId);check(a.paperId===paperId&&a.activeAttemptId===holder.attemptId&&!terminal.has(a.status),'Assignment attempt is no longer active',409,'WRITER_FENCED');
   const actor=persistSourceActor(this.store.root,this.store.config.papers[paperId],holder),opId=id(body.operationId),payload={...body};delete payload.operationId;
   const digest=hashObject({action,payload}),paths=[...new Set([...a.attempts.map(x=>path.join(x.runRoot,'operations',opId,'operation.json')),path.join(holder.runRoot,'operations',opId,'operation.json')])],prior=paths.filter(file=>fs.existsSync(file)).map(file=>({file,op:readJSON(file)}));
   for(const x of prior)check(x.op.id===opId&&x.op.digest===digest&&x.op.action===action&&hashObject({action:x.op.action,payload:x.op.payload})===digest&&x.op.sourceActor?.assignmentId===a.id&&x.op.sourceActor?.paperId===a.paperId,'Operation ID cannot change its payload or assignment across attempts',409,'OPERATION_CONFLICT');
   const selected=prior.find(x=>x.op.status==='accepted')||prior[0],file=selected?.file||path.join(holder.runRoot,'operations',opId,'operation.json'),opRoot=path.dirname(file);let op=selected?.op||null;
   const saveDelivery=()=>{if(['finish','technical-gap'].includes(action)){verifyBusinessDelivery(this,a,op.result);writeJSON(path.join(holder.runRoot,'delivery.json'),{assignmentId:a.id,attemptId:holder.attemptId,at:now(),result:op.result,operation:{path:file,sha256:hashFile(file)},acknowledgedBy:actor});}};
   if(op?.status==='accepted'){check(this.acceptedActorValid(a,op),'Accepted operation actor proof changed',409,'DELIVERY_EVIDENCE_INVALID');saveDelivery();return {...op.result,operationReceipt:{path:file,sha256:hashFile(file)},duplicate:true,replayedFromAttemptId:op.sourceActor.attemptId};}
   else {op={id:opId,action,digest,payload,status:'started',at:now(),sourceActor:actor};writeJSON(file,op);}
   const authority={actor,assert:()=>this.registry.validate(paperId,secret,scope),trackRoot:root=>{const current=this.registry.validate(paperId,secret,scope).state;current.holder.workRoots=[...new Set([...(current.holder.workRoots||[]),path.resolve(root)])];this.registry.save(current);}};
   try{const result=await sourceOperation(this,a,action,payload,authority,opRoot);authority.assert();op.status='accepted';op.result=result;op.acceptedAt=now();op.acceptedBy=actor;delete op.error;writeJSON(file,op);saveDelivery();
    this.production.kick();return {...result,operationReceipt:{path:file,sha256:hashFile(file)}};
   }catch(e){op.status=e.sourcePrecondition?'rejected':'interrupted';if(e.sourcePrecondition)op.rejection=e.sourcePrecondition;op.error={code:e.code||'FAILED',message:e.message};writeJSON(file,op);throw e;}
  });}finally{this.activeOperations--;}
 }
 async launch(a){
  check(!maintenancePaused(this.store.root),'Maintenance pause prevents source launch',503,'MAINTENANCE_PAUSED');
  this.authority();check(this.migrated(a.paperId)&&!this.registry.read(a.paperId).holder,'Paper writer is occupied',409,'PAPER_WRITER_ACTIVE');
  if(a.sourceCorrespondenceSha256)check(correspondenceScope(this.production,a.reportId).scopeSha256===a.sourceCorrespondenceSha256,'Source correspondence scope changed',409,'SOURCE_MAP_SCOPE');
  if(a.sourceComparisonScopeSha256&&!this.production.humanRouting.comparisonRecord(a.sourceComparisonScopeSha256)){const current=this.production.humanRouting.initialComparisonScope(this.blind.report(a.reportId));check(current?.scopeSha256===a.sourceComparisonScopeSha256,'Exact unprotected comparison scope required',409,'SOURCE_COMPARISON_SCOPE');}
  if(a.reportId&&!a.requestId&&!a.sourceComparisonScopeSha256&&!a.sourceCorrespondenceSha256){const report=this.blind.report(a.reportId),route=this.production.humanRouting?.reportRoute(report);let fault=route?.state==='technical_gap'?route:null;
   if(!fault&&route?.state==='continue_registered_work'&&!a.packetOnly){try{this.production.humanRouting.assertReportAction(report,'source_admission');}catch(e){fault={state:'technical_gap',code:e.code||'HUMAN_SCOPE_ADMISSION_GAP',message:e.message,reportId:a.reportId};}}
   if(fault){
   a.status='technical_gap';a.delivery={status:'technical_gap',code:'HUMAN_LINEAGE_ADMISSION_BLOCKED',reason:'The actual source operation scope is unresolved: '+(fault.message||fault.code)+'. Repair the recorded platform evidence before a diagnosed resume; no source worker was launched.',causeCode:fault.code,reportId:a.reportId,paperApproval:false};a.events.push({at:now(),type:'platform_admission_block',routeSha256:hashObject(route),causeCode:fault.code,scopeFault:fault});this.save(a);this.syncOrigins(a);return;
  }}
  const existing=businessDelivery(this,a);if(existing){a.status='delivered';a.delivery={...existing,reusedExistingReceipt:true,paperApproval:false};this.save(a);this.syncOrigins(a);return;}
  const attemptId='attempt-'+uid(),runRoot=path.join(this.runRootBase,attemptId.slice(8,20));fs.mkdirSync(runRoot,{recursive:true});
  const packet=this.packet(a);snapshotInputs(packet.outputs,path.join(runRoot,'inputs'),packet.manifest);packet.frozenInputsRoot=path.join(runRoot,'inputs');writeJSON(path.join(runRoot,'packet.json'),packet);writeJSON(path.join(runRoot,'config.json'),this.store.config);
  writeJSON(path.join(runRoot,'job.json'),{schemaVersion:1,assignmentId:a.id,attemptId,paperId:a.paperId,runRoot,registryRoot:this.registry.root,dataRoot:this.store.root,deskRoot:this.store.config.root,origin:this.origin,cli:this.settings.cli,cliSha256:this.settings.cliSha256,packetSha256:hashFile(path.join(runRoot,'packet.json')),fixture:this.store.fixture});
  a.activeAttemptId=attemptId;a.status='launching';a.attempts.push({id:attemptId,runRoot,startedAt:now()});this.save(a);
  const log=fs.openSync(path.join(runRoot,'supervisor.log'),'a'),child=spawn(process.execPath,[path.join(this.store.config.root,'source-supervisor.mjs'),path.join(runRoot,'job.json')],{cwd:runRoot,env:workerEnvironment().env,windowsHide:true,detached:true,stdio:['ignore',log,log]});fs.closeSync(log);child.unref();
  child.once('error',e=>writeJSON(path.join(runRoot,'supervisor-spawn-error.json'),{at:now(),code:e.code,message:e.message}));
  const identity=child.pid?await this.probe(child.pid):null;a=this.get(a.id);check(a.activeAttemptId===attemptId,'Source attempt changed during launch',409,'WRITER_FENCED');const attempt=a.attempts.find(t=>t.id===attemptId);attempt.supervisorPid=child.pid||null;attempt.supervisorIdentity=identity;this.save(a);
 }
 syncOrigins(a){for(const origin of a.origins){const queue=origin.origin==='notification'?this.notifications:this.production;let job=origin.origin==='notification'?queue.job(origin.id):queue.get(origin.id);if(job.sourceAssignmentId!==a.id)continue;
  job.status=a.status==='delivered'?(origin.origin==='notification'?'owner_received':'completed'):a.status==='human_handoff'&&verifyHumanHandoff(this.production,a)?'cancelled':a.status==='technical_gap'?'blocked':'source_pending';job.sourceExecution={assignmentId:a.id,attemptId:a.activeAttemptId||null,status:a.status,delivery:a.delivery||null};if(a.status==='technical_gap')job.problem=a.delivery?.reason||'Temporary worker stopped without a verified delivery';else delete job.problem;queue.save(job);}}
 acceptedActorValid(a,op){const actor=op.acceptedBy||op.sourceActor;return actor?.assignmentId===a.id&&a.attempts.some(x=>x.id===actor.attemptId)&&sourceActorValid(this.store.root,a.paperId,this.store.config.papers[a.paperId].owner,actor);}
 verifiedDelivery(a,attempt){
  const file=path.join(attempt.runRoot,'delivery.json'),saved=readJSON(file);check(saved.assignmentId===a.id&&saved.attemptId===attempt.id&&saved.operation&&hashFile(saved.operation.path)===saved.operation.sha256,'Delivery identity/hash changed',409,'DELIVERY_EVIDENCE_INVALID');
  const op=readJSON(saved.operation.path),allowed=a.attempts.some(x=>path.resolve(saved.operation.path)===path.resolve(x.runRoot,'operations',id(op.id),'operation.json'));
  check(allowed&&op.status==='accepted'&&['finish','technical-gap'].includes(op.action)&&op.digest===hashObject({action:op.action,payload:op.payload})&&op.sourceActor?.assignmentId===a.id&&op.sourceActor?.paperId===a.paperId&&this.acceptedActorValid(a,op),'Delivery does not reference an accepted operation of this assignment',409,'DELIVERY_EVIDENCE_INVALID');
  check(hashObject(saved.result)===hashObject(op.result)&&(op.action==='technical-gap')===(op.result.status==='technical_gap'),'Delivery result differs from its accepted operation',409,'DELIVERY_EVIDENCE_INVALID');verifyBusinessDelivery(this,a,op.result);return {result:op.result,operation:saved.operation,delivery:{path:file,sha256:hashFile(file)}};
 }
 async reconcile(a){
  if(!a.activeAttemptId||terminal.has(a.status))return;const attempt=a.attempts.find(x=>x.id===a.activeAttemptId),exitFile=path.join(attempt.runRoot,'supervisor-exit.json');
  if(fs.existsSync(exitFile)){const end=readJSON(exitFile);if(!end.released)return;const held=this.registry.read(a.paperId);check(!held.holder||held.holder.attemptId!==attempt.id,'Ended worker still holds registration');
   const deliveryFile=path.join(attempt.runRoot,'delivery.json');let delivery=null,deliveryError=null;
   if(fs.existsSync(deliveryFile))try{
    delivery=this.verifiedDelivery(a,attempt).result;
   }catch(e){deliveryError={code:'DELIVERY_EVIDENCE_INVALID',reason:e.message,record:deliveryFile};}
   a.status=delivery&&delivery.status!=='technical_gap'?'delivered':'technical_gap';a.delivery=delivery||{status:'technical_gap',code:deliveryError?.code||end.error?.code||'DELIVERY_MISSING',reason:deliveryError?.reason||end.error?.message||'Fresh worker process ended without a verified durable business exit. Exit code and prose are not delivery.',processExit:end.processExit,paperApproval:false};if(deliveryError)a.reconciliationError=deliveryError;attempt.deliveryVerified=a.status==='delivered';attempt.problemCode=a.delivery?.code||null;attempt.exitedAt=end.at;attempt.exitCode=end.processExit?.exitCode??null;a.finishedAt=now();this.save(a);this.syncOrigins(a);this.production.kick();return;
  }
  const held=this.registry.read(a.paperId).holder;if(held?.attemptId===attempt.id){a.status='running';a.workerId=held.workerId;a.threadId=held.threadId;this.save(a);return;}
  if(attempt.supervisorIdentity){const current=await this.probe(attempt.supervisorIdentity.pid);a=this.get(a.id);if(a.activeAttemptId!==attempt.id||terminal.has(a.status))return;if(fs.existsSync(exitFile))return this.reconcile(a);if(this.registry.read(a.paperId).holder?.attemptId===attempt.id)return;if(!current||current.createdAt!==attempt.supervisorIdentity.createdAt){a.status='technical_gap';a.delivery={status:'technical_gap',code:'SUPERVISOR_EXIT_UNKNOWN',reason:'The exact supervisor stopped without an exit receipt. Inspect this attempt before a diagnosed retry; no automatic replacement was launched.'};this.save(a);this.syncOrigins(a);}}
 }
 async drain(){if(!this.enabled||!this.auto||this.stopped||this.busy||maintenancePaused(this.store.root))return;this.busy=true;try{
  for(const a of this.assignments().filter(a=>a.activeAttemptId&&!terminal.has(a.status))){await yieldIO();await this.production.blindExecutors?.math?.registrationWindow?.wait();if(this.stopped)break;await this.reconcile(a);}
  const activeAssignments=this.assignments().filter(a=>['launching','running'].includes(a.status)),activePapers=new Set(activeAssignments.map(a=>a.paperId));let active=activeAssignments.length;
  for(const a of this.assignments().filter(a=>a.status==='pending')){await yieldIO();await this.production.blindExecutors?.math?.registrationWindow?.wait();if(this.stopped)break;if(activePapers.has(a.paperId)||this.registry.read(a.paperId).holder)continue;if(await handoffInactiveHumanWork(this,a,'source'))continue;if(active>=this.pools.limit('source')||maintenancePaused(this.store.root))continue;await this.production.blindExecutors?.math?.registrationWindow?.wait();if(this.stopped)break;await this.launch(a);if(!terminal.has(this.get(a.id).status)){active++;activePapers.add(a.paperId);}}
  for(const a of this.assignments().filter(a=>a.status==='technical_gap')){await yieldIO();await this.production.blindExecutors?.math?.registrationWindow?.wait();if(this.stopped)break;await handoffInactiveHumanWork(this,a,'source');}
 }catch(e){this.lastError={at:now(),code:e.code,message:e.message};}finally{this.busy=false;if(this.assignments().some(a=>!terminal.has(a.status)))this.kick(5000);}}
 kick(ms=100){if(!this.enabled||!this.auto||this.stopped)return;clearTimeout(this.timer);this.timer=setTimeout(()=>this.drain(),ms);this.timer.unref();}
 async resume(key,reason){const a=this.get(key);check(a.status==='technical_gap'&&typeof reason==='string'&&reason.length>=40,'Explicit technical repair evidence required');check(!this.registry.read(a.paperId).holder,'Resolve the exact old writer before retry',409,'PAPER_WRITER_ACTIVE');a.events.push({at:now(),type:'diagnosed_retry',reason,priorDelivery:a.delivery});a.status='pending';delete a.delivery;delete a.activeAttemptId;this.save(a);this.kick();return a;}
 async amendRecovery(key,{correctionId,expectedAssignmentSha256,reason}){
  id(correctionId);check(typeof reason==='string'&&reason.length>=40&&/^[a-f0-9]{64}$/.test(expectedAssignmentSha256||''),'Exact assignment and concrete recovery correction required');
  const paperId=this.get(key).paperId,digest=hashObject({correctionId,expectedAssignmentSha256,reason});
  return this.registry.guard(paperId,state=>{
   const a=this.get(key);check(a.paperId===paperId,'Recovery paper identity changed',409,'WRITER_FENCED');
   const old=a.events.find(e=>e.type==='recovery_guidance_corrected'&&e.correctionId===correctionId);
   if(old){check(old.digest===digest,'Correction ID cannot change its payload',409,'OPERATION_CONFLICT');return a;}
   check(!state.holder&&!this.assignments().some(x=>x.paperId===paperId&&['launching','running'].includes(x.status)),'Existing paper work must release before guidance correction',409,'PAPER_WRITER_ACTIVE');
   check(['pending','technical_gap'].includes(a.status)&&hashObject(a)===expectedAssignmentSha256,'Assignment changed or is not inactive recoverable work',409,'RECOVERY_CONFLICT');
   const event={at:now(),type:'recovery_guidance_corrected',correctionId,digest,expectedAssignmentSha256,reason,priorGuidance:a.recoveryGuidance||null,statusUnchanged:a.status};
   a.events.push(event);a.recoveryGuidance={at:event.at,correctionId,reason};return this.save(a);
  });
 }
 async handoff(paperId){
  this.authority();const registry=this.ownerRegistry(),entry=registry.papers[paperId];check(entry,'Paper is outside registered B16/maintenance scope');const configured=this.store.config.papers[paperId];check(entry.mode==='accepted_maintenance'||configured?.owner===entry.owner&&path.resolve(configured.root)===path.resolve(entry.writeRoot),'Historical paper root or owner changed',409,'OWNER_CHANGED');if(this.migrated(paperId)){this.transfer(paperId,entry);return this.registry.read(paperId);}
  const draining=path.join(this.root,'draining',id(paperId)+'.json');if(!fs.existsSync(draining))writeJSON(draining,{paperId,owner:entry.owner,at:now(),authority:this.authority()});
  const client=await this.notifications.adapter(),response=await client.call('wait_threads',{targets:[{threadId:entry.owner}],timeoutMs:0}),status=response.polls?.find(x=>x.thread?.id===entry.owner);
  check(status&&['idle','notLoaded'].includes(status.thread.status?.type)&&status.latestTurn?.status!=='inProgress','Permanent owner still has active work; no forced handoff',409,'LEGACY_OWNER_ACTIVE');
  const scan=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Depth 3 -Compress'],{timeout:15000});check(scan.code===0,'Local writer process census failed',503);
  const normalize=v=>String(v||'').replaceAll('\\','/').toLowerCase(),root=normalize(entry.writeRoot),processes=JSON.parse(scan.output.replace(/^\uFEFF/,'')),matches=processes.filter(p=>p.ProcessId!==process.pid&&(normalize(p.CommandLine).includes(root)||(/local-job\.mjs/i.test(p.CommandLine||'')&&normalize(p.CommandLine).includes(paperId.toLowerCase()))));
  check(!matches.length,'A local process still references this paper; finish it before handoff',409,'LEGACY_WRITER_ACTIVE');
  const p=this.store.config.papers[paperId],lock=path.join(p?.root||entry.writeRoot,'work/review-desk/owner.lock');let lockProof={present:false};
  if(fs.existsSync(lock)){const value=readJSON(lock),identity=await this.probe(value.pid);check(!identity,'Recorded legacy writer PID is still live',409,'LEGACY_WRITER_ACTIVE');lockProof={present:true,stale:value,sha256:hashFile(lock)};}
  const input=p?inputManifest(path.join(p.root,'outputs'),p.main):{sha256:hashObject(fs.readdirSync(entry.writeRoot).filter(n=>/\.(tex|pdf)$/.test(n)).map(n=>({name:n,sha256:hashFile(path.join(entry.writeRoot,n))}))) };
  if(p)verifyAuthority(p);
  const record={at:now(),previousOwner:entry.owner,writeRoot:entry.writeRoot,inputSha256:input.sha256,mode:entry.mode,idleProof:{observedAt:now(),thread:status.thread,latestTurn:status.latestTurn||null,paperProcesses:matches,lock:lockProof},authorization:this.authority(),pending:{production:this.production.jobs().filter(j=>this.paperFor(j)===paperId&&!['completed','cancelled'].includes(j.status)).map(j=>({id:j.id,kind:j.kind,status:j.status})),notifications:this.notifications.jobs().filter(j=>j.paperId===paperId&&!['owner_received','cancelled'].includes(j.status)).map(j=>({id:j.id,kind:j.kind,status:j.status})),decisions:this.store.list().filter(x=>x.paperId===paperId).map(x=>({id:x.id,state:this.store.state(x.id)}))},paperApproval:false};
  const saved=await this.registry.handoff(paperId,record);if(lockProof.present){check(hashFile(lock)===lockProof.sha256,'Stale lock changed during handoff',409);fs.unlinkSync(lock);}
  this.transfer(paperId,entry);return saved;
 }
 transfer(paperId,entry){
  for(const j of this.production.jobs())if(this.paperFor(j)===paperId&&this.handles(j)&&!['completed','cancelled'].includes(j.status))this.enqueue('production',j);
  for(const j of this.notifications.jobs())if(j.paperId===paperId&&!['owner_received','cancelled'].includes(j.status))this.enqueue('notification',j);
  for(const item of this.store.list().filter(x=>x.paperId===paperId)){const state=this.store.state(item.id);if(!state.supersededBy&&state.decision?.action==='edit'&&state.status!=='verified'){const job=this.notifications.jobs().find(j=>j.requestId===item.id&&j.decisionId===state.decision.id);check(job,'Saved unapplied decision is missing its notification identity',409,'DECISION_HANDOFF_GAP');this.enqueue('notification',job);}}
  // A legacy repair may have been acknowledged without returning its result.
  for(const r of this.blind.all('reports'))if(r.paperId===paperId&&r.status==='owner_rework'){const j=this.production.create('owner_resume',entry.owner,{paperId,reportId:r.id,reworkAttempt:r.attempts,reason:'Safe execution handoff retained an acknowledged repair without its required build/comparison return.'});this.enqueue('production',j);}
  this.production.kick();this.kick();
 }
 async archive(owner){
  const registry=this.ownerRegistry(),papers=Object.values(registry.papers).filter(p=>p.owner===owner);check(papers.length&&papers.every(p=>this.migrated(p.paperId)),'Every paper owned by this chat needs its safe handoff',409,'HANDOFF_REQUIRED');
  check(this.settings.compatibilityReceipt&&hashFile(this.settings.compatibilityReceipt.path)===this.settings.compatibilityReceipt.sha256,'Verified adapter compatibility receipt required',409,'COMPATIBILITY_REQUIRED');const proof=readJSON(this.settings.compatibilityReceipt.path);check(proof.success&&proof.actualCli&&proof.imageAccess&&proof.compile&&proof.render&&proof.businessDelivery,'Actual CLI/business compatibility is incomplete',409,'COMPATIBILITY_REQUIRED');
  const file=path.join(this.root,'archives',id(owner)+'.json');if(fs.existsSync(file)){const old=readJSON(file);if(old.archived)return old;check(false,'Archive acknowledgement is unknown; reconcile the existing archive record before retry',409,'ARCHIVE_DELIVERY_UNKNOWN');}
  const client=await this.notifications.adapter(),v=await client.call('wait_threads',{targets:[{threadId:owner}],timeoutMs:0}),t=v.polls?.find(x=>x.thread?.id===owner);check(t&&['idle','notLoaded'].includes(t.thread.status?.type)&&t.latestTurn?.status!=='inProgress','Old chat resumed; do not archive active work',409,'LEGACY_OWNER_ACTIVE');
  const receipt={at:now(),owner,papers:papers.map(p=>p.paperId),status:'sending',archived:false,reason:'Permanent execution retired after explicit per-paper handoff; durable assignments/decisions remain active.',paperApproval:false};writeJSON(file,receipt);
  try{receipt.transportReceipt=await client.call('set_thread_archived',{threadId:owner,archived:true});receipt.status='archived';receipt.archived=true;}catch(e){receipt.status='delivery_unknown';receipt.problem=e.message;}writeJSON(file,receipt);return receipt;
 }
 summary(){return {enabled:this.enabled,settings:this.enabled?{model:'gpt-6-luna',reasoningEffort:'max',sandbox:'danger-full-access',approvalPolicy:'never',maxConcurrent:this.settings.maxConcurrent}:null,papers:fs.readdirSync(path.join(this.registry.root,'papers')).map(f=>readJSON(path.join(this.registry.root,'papers',f))).map(p=>({paperId:p.paperId,mode:p.mode,generation:p.generation,holder:p.holder?{workerId:p.holder.workerId,assignmentId:p.holder.assignmentId,phase:p.holder.phase,threadId:p.holder.threadId}:null})),assignments:this.assignments().map(a=>({id:a.id,paperId:a.paperId,reportId:a.reportId,requestId:a.requestId,status:a.status,workerId:a.workerId,threadId:a.threadId,delivery:a.delivery})),lastError:this.lastError||null,paperApproval:false};}
 stop(){this.stopped=true;clearTimeout(this.timer);}
}
