import fs from 'node:fs';import path from 'node:path';
import {check,readJSON,writeJSON,hashObject,hashFile,immutableWrite,now,id} from './io.mjs';import {fifo} from './dispatch-order.mjs';

export class MathRequestQueue {
 constructor(root,{execute,available=()=>true,recoverResult=()=>null,resolveCapability=()=>null,handoffFor=()=>null,waitLimitMs=12*60000,tickMs=1000}={}){
  this.handoffFor=handoffFor;
  this.resolveCapability=resolveCapability;
  this.root=root;this.execute=execute;this.available=available;this.recoverResult=recoverResult;this.waitLimitMs=waitLimitMs;this.tickMs=tickMs;this.waiters=new Map();this.busy=false;this.stopped=false;fs.mkdirSync(root,{recursive:true});
  for(const r of this.all())if(r.status==='running'){r.status='recovery_required';r.problem='Service ended during a registered request; an explicit registration/request recovery is required.';this.save(r);}
  this.kick();
 }
 all(){return fs.readdirSync(this.root).filter(f=>f.endsWith('.json')).map(f=>readJSON(path.join(this.root,f))).sort(fifo);}
 get(key){return readJSON(path.join(this.root,id(key)+'.json'));}
 save(r){r.updatedAt=now();writeJSON(path.join(this.root,r.id+'.json'),r);}
 identity(cap,body){return cap.claimId&&cap.reportId?hashObject({reportId:cap.reportId,claimId:cap.claimId,body}):hashObject({capabilityId:cap.id,body});}
 existing(cap,body){const key=this.identity(cap,body),digest=hashObject(body);return this.all().find(r=>r.id===key||(!!cap.claimId&&!!cap.reportId&&r.payloadSha256===digest&&r.reportId===cap.reportId&&(r.claimId||(this.resolveCapability(r.capabilityId)?.claimId))===cap.claimId));}
 async enqueue(cap,body){
  let r=this.existing(cap,body);const key=r?.id||this.identity(cap,body);
  if(r){check(r.payloadSha256===hashObject(body),'Repeated tool request changed',409);}else{r={id:key,capabilityId:cap.id,reportId:cap.reportId,claimId:cap.claimId||null,roleId:cap.roleId||null,assignmentId:cap.assignmentId||null,attemptId:cap.cliActor?.attemptId||null,payload:body,payloadSha256:hashObject(body),createdAt:now(),status:'queued',deadlineAt:Date.now()+this.waitLimitMs,attempts:0};this.save(r);}
  if(r.status==='completed'||r.status==='resource_blocked'||r.status==='human_handoff')return r.result;
  if(r.status==='recovery_required')return this.blocked(r,'REGISTRATION_RECOVERY_REQUIRED');
  if(r.status==='queued'&&r.capabilityId!==cap.id){r.capabilityHistory=[...(r.capabilityHistory||[]),r.capabilityId];r.capabilityId=cap.id;r.assignmentId=cap.assignmentId||null;r.attemptId=cap.cliActor?.attemptId||null;this.save(r);}
  const promise=new Promise(resolve=>{const waiting=this.waiters.get(key)||[];waiting.push(resolve);this.waiters.set(key,waiting);});this.kick();return promise;
 }
 blocked(r,reason){return {id:r.id,requestId:r.id,engine:r.payload.engine,success:false,executionCompleted:false,reason,evidence:{assessment:'resource_blocked',conclusion:'unknown'},resourceRequest:true};}
 settle(r){for(const resolve of this.waiters.get(r.id)||[])resolve(r.result);this.waiters.delete(r.id);}
 handoff(r){
  if(!['queued','resource_blocked'].includes(r.status))return false;const route=this.handoffFor(r);if(!route)return false;
  const prior=this.get(r.id);if(hashObject(prior)!==hashObject(r))return false;
  const record={schemaVersion:1,requestId:r.id,previousRequest:r,route,at:now(),scope:'Unstarted request handed to required human workflow. No tool execution, tool result or mathematical pass.'};
  const file=path.join(this.root,'human-handoffs',r.id+'-'+hashObject(record).slice(0,16)+'.json');immutableWrite(file,JSON.stringify(record,null,2)+'\n');
  r.status='human_handoff';r.humanHandoff={path:file,sha256:hashFile(file)};r.result={id:r.id,requestId:r.id,engine:r.payload.engine,success:false,executionCompleted:false,reason:'HUMAN_WORKFLOW_HANDOFF',evidence:{assessment:'human_workflow_handoff',conclusion:'not_evaluated'},resourceRequest:true};this.save(r);this.settle(r);return true;
 }
 async resume(key,reason){const r=this.get(key);check(r.status==='recovery_required'&&(r.resumes||0)<1&&typeof reason==='string'&&reason.length>=40,'One explicit interrupted-request recovery required',409);const cached=await this.recoverResult(r);if(cached){r.status='completed';r.result=cached;this.save(r);return {id:r.id,status:r.status,reusedActualReceipt:true};}check(await this.available(),'Registration remains held; recover that exact registration first',409,'REGISTRY_BUSY');r.resumes=1;r.recoveryReason=reason;r.status='queued';r.deadlineAt=Date.now()+this.waitLimitMs;this.save(r);this.kick();return {id:r.id,status:r.status};}
 async pump(){
  if(this.busy||this.stopped)return;this.busy=true;
  try{
   for(const pending of this.all())this.handoff(pending);
   for(const expired of this.all().filter(r=>r.status==='queued'&&r.deadlineAt<=Date.now())){expired.status='resource_blocked';expired.result=this.blocked(expired,'REGISTRY_WAIT_BOUND');this.save(expired);this.settle(expired);}
   let r=this.all().find(r=>r.status==='queued');if(!r||!await this.available())return;
   r=this.get(r.id);if(r.status!=='queued'||this.handoff(r))return;
   r.status='running';r.attempts++;r.startedAt=now();r.controllerPid=process.pid;this.save(r);
   let result;try{result=await this.execute(r);}catch(e){result=this.blocked(r,e.code||'REQUEST_EXECUTION_FAILED');}
   if(result.reason==='REGISTRY_BUSY'&&!result.executionCompleted){r.status='queued';r.lastResourceResult=result;this.save(r);return;}
   r.status='completed';r.result={...result,requestId:r.id};r.completedAt=now();this.save(r);this.settle(r);
  }finally{this.busy=false;if(this.all().some(r=>r.status==='queued'))this.kick(this.tickMs);}
 }
 kick(delay=0){if(this.stopped)return;clearTimeout(this.timer);this.timer=setTimeout(()=>this.pump().catch(e=>{this.lastError=e.message;this.kick(this.tickMs);}),delay);if(!this.waiters.size)this.timer.unref();}
 stop(){this.stopped=true;clearTimeout(this.timer);}
}
