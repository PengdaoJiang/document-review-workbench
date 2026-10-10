import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {ROOT} from '../setup.mjs';import {blindPoolFixture} from './blind-pool-fixture.mjs';
import {readJSON,writeJSON,hashFile,now} from '../lib/io.mjs';import {readingCoverageStatus} from '../lib/reading-continuity.mjs';import {assignmentHumanRoute} from '../lib/human-handoff.mjs';
const root=path.join(ROOT,'tests/runs/closure-'+Date.now());let sequence=0;
async function fixture(){
 const f=await blindPoolFixture(path.join(root,String(++sequence))),old=await f.activate(),base=f.coverage();base.nodes=base.nodes.map(n=>({...n,status:'unexamined'}));f.q.coverage(old.cap,base);const c=f.q.all('coverage')[0];await f.exit(old);
 const nodeId=f.bundle.nodes[0].nodeId,restriction={kind:'fragment',nodeId,wholeNode:true,state:'awaiting_human',stableFragmentId:'synthetic-fragment',stateSha256:'synthetic-state'};
 f.q.humanRouting={restrictions:()=>[restriction],publicRestriction:x=>x,inputView:x=>x};
 const job=f.q.create('reading_supplement','blind_executor',{paperId:'p',bundleId:f.bundle.id,roleId:'blind-paper-p',baseCoverageId:c.id,baseCoverageSha256:hashFile(path.join(f.q.root,'coverage',c.id+'.json')),unreadNodeIds:f.bundle.nodes.slice(1).map(n=>n.nodeId)});
 f.q.materialize(job,f.blind.issueCapability('reporter',{bundleId:f.bundle.id,assignmentId:job.id,roleId:job.roleId}));
 const {attempt}=await f.pool.claim(job.id),lease=await f.pool.registry.acquire('p',job.id,attempt.id);await f.pool.registry.attachThread('p',lease.secret,'reading-worker');await f.pool.activate('p',lease.secret,{assignmentId:job.id,attemptId:attempt.id});const cap=f.blind.capability(readJSON(path.join(attempt.workspace,'session.json')).capability);
 const body={assignmentId:job.id,bundleId:f.bundle.id,documentSha256:f.bundle.public.document.sha256,nodes:f.bundle.public.nodes.slice(1).map(n=>({nodeId:n.nodeId,status:'read',note:'Actually read only the remaining synthetic node.'})),summary:'All assigned remaining synthetic text was read; pending human scope remains excluded.',delivery:{complete:true,proposalIds:[]}};
 const receipt=await f.pool.operation(cap,'coverage',body,()=>f.q.coverage(cap,body));
 async function stopWithRejectedFinish(){
  await assert.rejects(f.pool.operation(cap,'worker-finish',{},()=>{throw Object.assign(Error('Reproduced former whole-paper finish predicate'),{status:409,code:'DELIVERY_INCOMPLETE'});}));
  const payload={code:'BOUNDED_READING_FINISH_REJECTED',reason:'Accepted bounded reading was incorrectly rejected solely because another fragment awaits the user.'};await f.pool.operation(cap,'worker-gap',payload,()=>f.pool.gap(cap,payload));
  const a=f.pool.get(job.id);a.attempts.at(-1).supervisorIdentity={pid:987654,createdAt:'exact-ended-supervisor'};f.pool.save(a);await f.pool.registry.release('p',lease.secret,{fixture:true});writeJSON(path.join(attempt.runRoot,'supervisor-exit.json'),{released:true,assignmentId:job.id,attemptId:attempt.id,processExit:{exitCode:0},at:now()});f.pool.registry.probe=async pid=>pid===987654?null:{pid,parentPid:0,createdAt:'fixture-process'};await f.pool.reconcile(f.pool.get(job.id));
 }
 return {...f,job,attempt,lease,cap,body,receipt,stopWithRejectedFinish};
}
test('actual supplemental reading can finish while separate human decisions still block paper completion',async()=>{
 const f=await fixture(),saved=f.q.all('coverage').find(x=>x.id===f.receipt.id);assert.equal(f.receipt.readingComplete,false);assert.equal(readingCoverageStatus(f.q,saved).complete,false);
 const result=await f.pool.operation(f.cap,'worker-finish',{},()=>f.pool.finish(f.cap));assert.equal(result.delivered,true);assert.equal(result.paperApproval,false);assert.equal(saved.nodes.some(n=>n.status==='human_pending'),true);
});
test('accepted coverage and exact stopped failed finish are reconciled without a new model or altered receipt',async()=>{
 const f=await fixture();await f.stopWithRejectedFinish();const file=path.join(f.q.root,'coverage',f.receipt.id+'.json'),seal=hashFile(file),r=await f.pool.completeStoppedReading(f.job.id,'The bounded reading delivery predicate is repaired; exact accepted coverage and natural exit are reused.');assert.equal(r.status,'delivered');assert.equal(r.newModelAttempt,false);assert.equal(hashFile(file),seal);assert.equal(f.pool.get(f.job.id).attempts.length,1);assert.equal((await f.pool.completeStoppedReading(f.job.id,'The exact prior mechanical transport closure is being queried idempotently.')).reused,true);
});
for(const mode of ['missing-operation','tampered-body','changed-actor','changed-base','unread-node'])test('reading delivery fails closed for '+mode,async()=>{
 const f=await fixture(),a=f.pool.get(f.job.id),ops=path.join(f.pool.root,'operations',a.id),opFile=fs.readdirSync(ops).map(n=>path.join(ops,n)).find(p=>readJSON(p).action==='coverage');
 if(mode==='missing-operation')fs.unlinkSync(opFile);else if(mode==='changed-base'){a.businessIdentity.baseCoverageSha256='0'.repeat(64);}else if(mode==='unread-node'){const file=path.join(f.q.root,'coverage',f.receipt.id+'.json'),v=readJSON(file);v.nodes.at(-1).status='unexamined';writeJSON(file,v);}else{const v=readJSON(opFile);if(mode==='tampered-body')v.payload.summary+=' forged';else v.acceptedActor.threadId='another-worker';writeJSON(opFile,v);}assert.throws(()=>f.pool.delivery(a));
});
for(const mode of ['active-holder','live-supervisor','unknown-operation','wrong-exit','wrong-gap'])test('stopped-reading closure refuses '+mode,async()=>{
 const f=await fixture();await f.stopWithRejectedFinish();const a=f.pool.get(f.job.id);
 if(mode==='active-holder')await f.pool.registry.acquire('p','successor','attempt-successor');
 if(mode==='live-supervisor')f.pool.registry.probe=async pid=>({pid,parentPid:0,createdAt:pid===987654?'exact-ended-supervisor':'fixture-process'});
 if(mode==='unknown-operation')writeJSON(path.join(f.pool.root,'operations',a.id,'unknown.json'),{status:'started'});
 if(mode==='wrong-exit'){const file=path.join(f.attempt.runRoot,'supervisor-exit.json'),v=readJSON(file);v.attemptId='wrong';writeJSON(file,v);}
 if(mode==='wrong-gap'){a.problemCode='UNRELATED_GAP';f.pool.save(a);}
 await assert.rejects(f.pool.completeStoppedReading(a.id,'A stopped reading request still requires exact independent transport evidence and safe registration.'));assert.equal(f.pool.get(a.id).status,'technical_gap');
});
test('packet and decision assignments never scan the full job list for human handoff',()=>{
 const q={humanRouting:{enabled:true},jobs(){throw Error('Unexpected full queue scan');}};assert.equal(assignmentHumanRoute(q,{packetOnly:true,origins:[{origin:'production',id:'job'}]}),null);assert.equal(assignmentHumanRoute(q,{requestId:'case',origins:[{origin:'production',id:'job'}]}),null);
});
test('scoped source handoff reads only its exact durable origin',()=>{
 let reads=0;const q={jobs(){throw Error('Unexpected full queue scan');},get(id){assert.equal(id,'job');reads++;return {kind:'owner_business'};},humanRouting:{enabled:true,settings:{authority:{}},reportRoute:()=>({state:'awaiting_human',stableFragmentId:'f',epoch:1})},blind:{report:id=>({id})}};assert.ok(assignmentHumanRoute(q,{reportId:'r',origins:[{origin:'production',id:'job'}]}));assert.equal(reads,1);
});
