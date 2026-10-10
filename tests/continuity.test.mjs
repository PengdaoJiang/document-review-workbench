import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {ROOT} from '../setup.mjs';import {BlindStore} from '../lib/blind-store.mjs';import {ProductionReview} from '../lib/production-review.mjs';import {MathCoverage,mathematicalSpans} from '../lib/math-coverage.mjs';import {BlindExecutors} from '../lib/blind-executors.mjs';import {OwnerLifecycle} from '../lib/owner-lifecycle.mjs';
import {nextReadingSupplement,recordReadingSupplement,verifyReadingReceipt,readingSupplementInput,readingCoverageStatus} from '../lib/reading-continuity.mjs';
import {continuityPlan,reviewContinuityInput,recordReviewImpact,expandDelta,verifyDeltaReceipt} from '../lib/math-continuity.mjs';
import {writeJSON,readJSON,hashObject,hashFile} from '../lib/io.mjs';
const run=path.join(ROOT,'tests/runs/continuity-'+Date.now());
function fixture(name){
 const root=path.join(run,name),outputs=path.join(root,'paper/outputs');fs.mkdirSync(outputs,{recursive:true});const tex='\\documentclass{article}\n\\begin{document}\n\nThe bounded value is $x=1$.\n\nThe independent prose is unchanged.\n\n\\end{document}\n';fs.writeFileSync(path.join(outputs,'main.tex'),tex);fs.writeFileSync(path.join(root,'original.txt'),'Synthetic sealed original.');
 const p={paperId:'p',owner:'fixture-owner',root:path.join(root,'paper'),main:'main.tex',source:{path:path.join(root,'original.txt'),sha256:hashFile(path.join(root,'original.txt')),pages:1},mapping:null};
 const store={root,fixture:true,config:{root:ROOT,papers:{p}}},blind=new BlindStore(store,{leaseRoot:path.join(root,'lease')}),q=Object.create(ProductionReview.prototype);Object.assign(q,{root:path.join(root,'production-review'),blind,store,v3:true,enabled:true,settings:{paperGroups:[['p']],exhaustiveReview:{enabled:true,revision:1}},kick(){},materialize(j){this.lastMaterialized=j;}});for(const dir of ['jobs','freezes','coverage'])fs.mkdirSync(path.join(q.root,dir),{recursive:true});q.mathCoverage=new MathCoverage(q);const bundle=blind.freeze('p',{wholeDocument:true});return {root,outputs,q,blind,bundle,p};
}
function seedInventory(f,{status='checked'}={}){
 const {q,bundle:b}=f,j=q.create('review','fixture-reviewer',{paperId:'p',bundleId:b.id,roleId:'fixture-role'}),cap={role:'reporter',assignmentId:j.id,bundleId:b.id,roleId:j.roleId};
 const mathNode=b.public.nodes.find(n=>n.quote.includes('$x=1$')),item={id:'check-x',nodeId:mathNode.nodeId,quote:'$x=1$',kind:'equation',conditions:'Only the written bounded synthetic statement.',status,method:'reasoning',evidence:'Synthetic bounded checking reason: the displayed assignment explicitly fixes x at the stated value.',reportIds:[]};
 const body={assignmentId:j.id,bundleId:b.id,documentSha256:b.public.document.sha256,revision:1,final:true,summary:'Synthetic complete mathematical inventory for a controlled fixture.',nodes:b.public.nodes.map(n=>({nodeId:n.nodeId,disposition:n.nodeId===mathNode.nodeId?'applicable':'not_applicable',reason:'Synthetic bounded scope assessment.',itemIds:n.nodeId===mathNode.nodeId?[item.id]:[]})),items:[item],spans:mathematicalSpans(b.public.nodes).map(s=>({spanId:s.spanId,disposition:'covered',reason:'The synthetic check covers this entire mathematical span.',itemIds:[item.id]})),delivery:{complete:true,proposalIds:[]}};
 q.mathCoverage.submit(cap,body);return {j,cap,body,inventory:q.mathCoverage.latest('p')};
}
function increment(f,base,mutate=x=>x){
 const file=path.join(f.outputs,'main.tex');fs.writeFileSync(file,mutate(fs.readFileSync(file,'utf8')));const b=f.blind.freeze('p',{wholeDocument:true}),j=f.q.create('incremental_review','fresh-reviewer',{paperId:'p',bundleId:b.id,roleId:'new-role',inputSha256:b.manifest.sha256,baselineInventoryId:base.id,baselineInventorySha256:hashFile(path.join(f.q.mathCoverage.root,base.id+'.json'))});return {j,b,cap:{role:'reporter',assignmentId:j.id,bundleId:b.id,roleId:j.roleId},plan:continuityPlan(f.q,j)};
}
function impactBody(t){return {planSha256:t.plan.sha256,revision:1,dependenciesComplete:true,explanation:'The actual fixture reviewer assessed all cumulative changes and their bounded definition/condition effects.',changes:t.plan.changes.map(c=>({changeId:c.id,affectedNodeIds:c.assignedNodeId?[c.assignedNodeId]:[],reason:'The changed synthetic prose affects only its newly assigned node; the separate explicit x condition is unchanged.'})),retained:t.plan.pairs.map(p=>({...p,mode:'unchanged',dependencies:[p],reason:'This unchanged synthetic claim/scope is self-contained; all relevant definitions and conditions are inside this exact node.'})),dependencyGaps:[]};}
function delta(t,impactId){const retained=new Set(t.plan.pairs.map(p=>p.assignedNodeId));return {assignmentId:t.j.id,bundleId:t.b.id,documentSha256:t.b.public.document.sha256,revision:1,final:true,summary:'Actual synthetic delta review; unchanged prior checks retain their original evidence and actor.',continuity:{planSha256:t.plan.sha256,impactReceiptId:impactId},nodes:t.b.public.nodes.filter(n=>!retained.has(n.nodeId)).map(n=>({nodeId:n.nodeId,disposition:'not_applicable',reason:'The changed fixture prose states no mathematical proposition.',itemIds:[]})),items:[],spans:[],delivery:{complete:true,proposalIds:[]}};}

test('remaining reading schedules once, preserves 3 old reads and records one actual new read',()=>{
 const f=fixture('reading'),{q,bundle:b}=f,base={id:'base-reading',assignmentId:'initial',bundleId:b.id,documentSha256:b.public.document.sha256,at:'2026-01-01T00:00:00Z',threadId:'old-reader',nodes:b.public.nodes.map((n,i)=>({nodeId:n.nodeId,status:i===2?'unexamined':'read',note:'Existing honest synthetic reading.'}))};writeJSON(path.join(q.root,'coverage',base.id+'.json'),base);
 const j=nextReadingSupplement(q,{threadId:'new-reader',roleId:'role'},['p']);assert.equal(j.unreadNodeIds.length,1);assert.equal(nextReadingSupplement(q,{threadId:'new-reader',roleId:'role'},['p']),null);
 const cap={role:'reporter',assignmentId:j.id,bundleId:b.id,roleId:'role'},input=readingSupplementInput(q,cap);assert.equal(input.reviewContinuity.retainedChecks.reading.length,3);
 const body={assignmentId:j.id,bundleId:b.id,documentSha256:b.public.document.sha256,nodes:[{nodeId:j.unreadNodeIds[0],status:'read',note:'Actually read this previously omitted fixture node.'}],summary:'One previously unread node was actually examined.',delivery:{complete:true,proposalIds:[]}};
 const result=recordReadingSupplement(q,cap,body),receipt=q.all('coverage').find(x=>x.id===result.id);assert.equal(result.addedReadNodes,1);assert.equal(result.retainedReadNodes,3);assert.equal(verifyReadingReceipt(q,receipt),true);assert.deepEqual(readJSON(path.join(q.root,'coverage',base.id+'.json')),base);
 assert.equal(readingCoverageStatus(q,receipt).complete,true); // Actual CLI transport binding is exercised in closure-integration.test.mjs.
 const lineage=OwnerLifecycle.prototype.reviewLineage.call({q,blind:f.blind},'p',{inputSha256:b.manifest.sha256});assert.equal(lineage.unexamined,0);assert.equal(lineage.coverageId,receipt.id);
 receipt.nodes[0].note='Forged replacement of old reading.';assert.throws(()=>verifyReadingReceipt(q,receipt));
});
test('remaining reading refuses guessed reads, extra nodes and changed historical base',()=>{
 const f=fixture('reading-refuse'),{q,bundle:b}=f,base={id:'reading',bundleId:b.id,documentSha256:b.public.document.sha256,at:'2026-01-01T00:00:00Z',nodes:b.public.nodes.map((n,i)=>({nodeId:n.nodeId,status:i===2?'unexamined':'read',note:'Actual original reading.'}))};writeJSON(path.join(q.root,'coverage','reading.json'),base);
 const j=nextReadingSupplement(q,{threadId:'reader',roleId:'role'},['p']),cap={role:'reporter',assignmentId:j.id,bundleId:b.id,roleId:'role'},body={assignmentId:j.id,bundleId:b.id,documentSha256:b.public.document.sha256,nodes:[],summary:'This fixture does not invent an unread node result.',delivery:{complete:true,proposalIds:[]}};
 assert.throws(()=>recordReadingSupplement(q,cap,body));body.nodes=base.nodes;assert.throws(()=>recordReadingSupplement(q,cap,body));base.nodes[0].note='Changed base';writeJSON(path.join(q.root,'coverage','reading.json'),base);assert.throws(()=>readingSupplementInput(q,cap));
});
test('same complete version inherits actual checks without a new impact assessment or repeated inventory',()=>{
 const f=fixture('same'),base=seedInventory(f).inventory,t=increment(f,base),info=reviewContinuityInput(f.q,t.cap);assert.equal(info.impactReceipt.automatic,true);const body=delta(t,info.impactReceipt.id),result=f.q.mathCoverage.submit(t.cap,body);assert.equal(result.complete,true);assert.equal(result.retainedChecks,1);assert.equal(result.actualDeltaChecks,0);const x=f.q.mathCoverage.latest('p');assert.equal(verifyDeltaReceipt(f.q,x),true);assert.equal(x.retainedCoverage.retainedItems[0].originalActor.threadId,'fixture-reviewer');assert.deepEqual(f.q.mathCoverage.submit(t.cap,body),result);
});
test('unrelated edit needs one impact review, then merges delta with unchanged original check',()=>{
 const f=fixture('unrelated'),base=seedInventory(f).inventory,t=increment(f,base,s=>s.replace('prose is unchanged','prose is now corrected'));assert.ok(t.plan.changes.length);assert.equal(reviewContinuityInput(f.q,t.cap).impactReceipt,null);
 assert.throws(()=>expandDelta(f.q,t.cap,delta(t,'missing-impact')));
 const impact=recordReviewImpact(f.q,t.cap,impactBody(t)),result=f.q.mathCoverage.submit(t.cap,delta(t,impact.id));assert.equal(result.complete,true);assert.equal(result.retainedChecks,1);assert.equal(result.actualDeltaChecks,0);assert.equal(verifyDeltaReceipt(f.q,f.q.mathCoverage.latest('p')),true);
});
test('changed definition, affected conclusion and incomplete dependency map cannot claim retained pass',()=>{
 const f=fixture('affected'),base=seedInventory(f).inventory,t=increment(f,base,s=>s.replace('$x=1$','$x=2$')),payload=impactBody(t),old=f.bundle.public.nodes.find(n=>n.quote.includes('$x=1$')),current=t.b.public.nodes.find(n=>n.quote.includes('$x=2$'));
 payload.retained.push({baseNodeId:old.nodeId,assignedNodeId:current.nodeId,mode:'unchanged',dependencies:[{baseNodeId:old.nodeId,assignedNodeId:current.nodeId}],reason:'An attempted invalid inheritance of changed scientific content.'});assert.throws(()=>recordReviewImpact(f.q,t.cap,payload));
 const g=fixture('affected-other'),x=seedInventory(g).inventory,u=increment(g,x,s=>s.replace('prose is unchanged','prose changes')),p=impactBody(u);p.changes[0].affectedNodeIds=[p.retained[0].assignedNodeId];assert.throws(()=>recordReviewImpact(g.q,u.cap,p));
});
for(const status of ['unknown','unsupported','condition_gap','technical_gap'])test(status+' is not inherited as a conclusive check',()=>{
 const f=fixture('not-pass-'+status),base=seedInventory(f,{status}).inventory,t=increment(f,base),info=reviewContinuityInput(f.q,t.cap);assert.equal(info.retentionCandidates.length,0);assert.equal(info.unresolved[0].status,status);
 const expanded=expandDelta(f.q,t.cap,delta(t,info.impactReceipt.id));assert.equal(expanded.body.items.length,0);assert.equal(expanded.proof.retainedItems.length,0);
 const result=f.q.mathCoverage.submit(t.cap,delta(t,info.impactReceipt.id));assert.equal(result.complete,false);
});
test('multiple edits keep the prior actual result and survive restart; tampered baseline fails',()=>{
 const f=fixture('multiple'),initial=seedInventory(f).inventory,a=increment(f,initial,s=>s.replace('prose is unchanged','prose first changed')),ia=recordReviewImpact(f.q,a.cap,impactBody(a));f.q.mathCoverage.submit(a.cap,delta(a,ia.id));const base=f.q.mathCoverage.latest('p'),b=increment(f,base,s=>s.replace('prose first changed','prose changed again')),ib=recordReviewImpact(f.q,b.cap,impactBody(b));const result=f.q.mathCoverage.submit(b.cap,delta(b,ib.id));assert.equal(result.complete,true);assert.equal(result.retainedChecks,1);
 const c=f.q.mathCoverage.latest('p');assert.equal(verifyDeltaReceipt(f.q,c),true);const restarted=Object.assign(Object.create(ProductionReview.prototype),f.q);restarted.mathCoverage=new MathCoverage(restarted);assert.equal(restarted.mathCoverage.snapshotComplete(c),true);
 fs.appendFileSync(path.join(f.q.mathCoverage.root,initial.id+'.json'),' ');assert.equal(restarted.mathCoverage.snapshotComplete(c),false);
});

function protectedDependency(name){
 const f=fixture(name),base=seedInventory(f).inventory,t=increment(f,base,s=>s.replace('\\end{document}','Additional separate prose.\n\\end{document}'));
 const node=t.b.public.nodes.find(n=>n.quote.includes('independent prose')),pair=t.plan.pairs.find(p=>p.assignedNodeId===node.nodeId),claim=t.plan.pairs.find(p=>t.b.public.nodes.find(n=>n.nodeId===p.assignedNodeId).quote.includes('$x=1$'));
 const restriction={kind:'fragment',stableFragmentId:'protected-fixture',nodeId:node.nodeId,state:'awaiting_human',stateSha256:'a'.repeat(64),decisionId:null};
 f.q.humanRouting={enabled:true,restrictions:()=>[restriction],publicRestriction:x=>x};
 const reference=reviewContinuityInput(f.q,t.cap).humanDependencyBindings[0],body=impactBody(t);body.retained=body.retained.filter(r=>r.assignedNodeId===claim.assignedNodeId);body.retained[0].dependencies.push({...pair,mode:'human_reference',humanScopeSha256:reference.humanScopeSha256});
 return {f,t,body,restriction,reference,pair};
}
test('unchanged protected premises are referenced without judging or granting them retained credit',()=>{
 const {f,t,body,restriction,reference}=protectedDependency('protected-reference'),before=structuredClone(restriction);assert.equal(reference.mathematicalPass,false);assert.equal(Object.hasOwn(reference,'nodeId'),false);assert.equal(reference.states[0].state,'awaiting_human');
 const plain=structuredClone(body);delete plain.retained[0].dependencies[1].mode;assert.throws(()=>recordReviewImpact(f.q,t.cap,plain),{code:'CONTINUITY_HUMAN_REFERENCE_REQUIRED'});
 const accepted=recordReviewImpact(f.q,t.cap,body),receipt=readJSON(path.join(f.q.root,'review-continuity/impacts',accepted.id+'.json'));assert.equal(receipt.retained.length,1);assert.equal(receipt.retained.some(r=>r.assignedNodeId===restriction.nodeId),false);assert.equal(receipt.humanDependencyBindings[0].records[0].state,'awaiting_human');assert.deepEqual(restriction,before);
});
test('forged or stale protected reference and attempts to recheck the protected node are rejected',()=>{
 for(const variant of ['forged','stale','retained','affected']){const {f,t,body,restriction,pair}=protectedDependency('protected-'+variant);if(variant==='forged')body.retained[0].dependencies[1].humanScopeSha256='0'.repeat(64);if(variant==='stale')restriction.stateSha256='b'.repeat(64);if(variant==='retained')body.retained.push({...pair,mode:'unchanged',dependencies:[{...pair,mode:'human_reference',humanScopeSha256:body.retained[0].dependencies[1].humanScopeSha256}],reason:'Attempted new semantic checking credit for a protected fixture.'});if(variant==='affected')body.changes[0].affectedNodeIds.push(restriction.nodeId);assert.throws(()=>recordReviewImpact(f.q,t.cap,body));}
});
