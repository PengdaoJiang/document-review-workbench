import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setup,files,acceptThroughLegacy,worker,canonical,hash,clone,scopeFor,read,digest,campaignRelative,protocolRelative} from './fixtures/append-correction-admission/fixture.mjs';

// Each test owns an isolated source/runtime/ledger root, workerCount=1.
// No production writes, scientific execution, vendor tools or PDF operations.
const absolute=(f,ref)=>path.resolve(f.project,ref.path);
const stateFile=f=>path.join(f.campaign,'coverage/state.json');
function reject(f,fields,pattern=/append|correction|scope|hash|owner|revision|reference|fields/i){
  const request=f.request(fields),before=files(f.project),state=clone(f.state());
  assert.match(f.invoke('intake-append',request,false).diagnostic,pattern);assert.deepEqual(f.state(),state);assert.deepEqual(files(f.project),before,'Rejected validation publishes no files or locks');
}
function alterState(f,mutate){const original=fs.readFileSync(stateFile(f)),state=JSON.parse(original);mutate(state);f.put(stateFile(f),canonical(state));return ()=>f.put(stateFile(f),original);}
async function inProcess(f){return import(pathToFileURL(path.join(f.project,protocolRelative,'coverage.mjs')).href);}

test('readonly check and append intake preserve original files and publish standard legacy-compatible guard',t=>{
  const f=setup(t),request=f.request(),before=files(f.project),originalPaper=clone(f.paper());
  const checked=f.invoke('check',request).value;assert.equal(checked.valid,true);assert.equal(checked.scientificAcceptance,false);assert.deepEqual(files(f.project),before);
  const received=f.invoke('intake-append',request).value,paper=f.paper();assert.equal(paper.phase,'awaiting_review');assert.equal(paper.owner,null);assert.equal(paper.latest,null);assert.equal(paper.staged.worker,worker);
  for(const name of ['scan','order','guardEnrollment','firstPass','history','iteration'])assert.deepEqual(paper[name],originalPaper[name]);
  for(const ref of [...Object.values(f.original),...Object.values(f.repaired),f.repairCheck,...f.report.preservedFiles])assert.equal(digest(absolute(f,ref)),ref.sha256);
  assert.deepEqual(read(paper.staged.candidate.path),f.values.candidate);assert.deepEqual(read(paper.staged.guard.contract.path),f.values.contract);assert.deepEqual(paper.staged.guard.contractSource,f.repaired.sourceScope);
  const order=fs.readFileSync(paper.staged.reviewOrder.path,'utf8');assert.ok(Buffer.byteLength(order)<=8192);assert.ok(order.includes('独立复核'));assert.ok(!order.includes('preserved-47.txt'));
  assert.equal(f.invoke('verify',{path:'origin'}).value.appendCorrection.verified,true);const after=files(f.project);assert.equal(f.invoke('intake-append',request).value.replayed,true);assert.deepEqual(files(f.project),after);assert.equal(received.revision,f.requestPayload.expectedRevision+1);
});

test('old intake rejects corrected candidate with old sidecar; unchanged legacy review decide continue and both verifiers accept the handoff',t=>{
  const f=setup(t),request=f.request({candidatePath:f.repaired.candidate.path}),before=files(f.project);
  assert.match(f.invokeLegacy('intake',request,false).diagnostic,/scope candidate|hash mismatch/);assert.deepEqual(files(f.project),before);
  const received=f.command('intake-append');const first=acceptThroughLegacy(f,{partial:true});assert.equal(f.paper().phase,'assessed');assert.equal(f.invokeLegacy('verify',{path:'origin'}).value.coverageComplete,false);assert.equal(f.invoke('verify',{path:'origin'}).value.appendCorrection.verified,true);
  const c001=clone(f.paper().latest);f.commandLegacy('continue');assert.equal(f.paper().iteration,2);
  f.commandLegacy('assign',{role:'worker',agent:'synthetic-c002-worker',freshContext:true,historyInherited:false});
  const next=clone(first.candidate);next.revision=2;next.author='synthetic-c002-worker';next.predecessorSha256=c001.candidate.sha256;
  const contract=scopeFor(f,next,f.scan);contract.revision=2;
  const delivery=f.put(f.paper().workRoot+'/candidate.json',next);f.put(f.paper().workRoot+'/source-scope.json',contract);
  f.commandLegacy('intake',{agent:next.author,ownerFinished:true,candidatePath:delivery.path});acceptThroughLegacy(f,{actor:'synthetic-c002-reviewer'});
  assert.equal(f.paper().phase,'complete');assert.deepEqual(f.paper().history,[c001]);assert.equal(f.invokeLegacy('verify',{path:'origin'}).value.coverageComplete,true);assert.equal(f.invoke('verify',{path:'origin'}).value.coverageComplete,true);assert.equal(f.invoke('intake-append',received.request).value.replayed,true);
});

test('strict requests reject stale revision actor unknown/active ownership and altered registration without state mutation',t=>{
  const f=setup(t);
  for(const fields of [{expectedRevision:f.state().revision-1},{agent:'different-worker'},{ownerFinished:false},{noActiveCalculation:false},{iteration:2},{supervisor:'wrong-supervisor'},{extra:true}])reject(f,fields);
  for(const mutate of [p=>p.owner=null,p=>p.owner.agent='unknown-worker',p=>p.owner.role='reviewer',p=>p.owner.startedAt='2020-01-01T00:00:00Z',p=>p.phase='ready',p=>p.staged={candidate:f.repaired.candidate},p=>p.latest={candidate:f.repaired.candidate},p=>p.history=[{}],p=>p.sourceEnrollment={}]){
    const restore=alterState(f,state=>mutate(state.papers.find(p=>p.paperId==='origin')));try{reject(f,{});}finally{restore();}
  }
  for(const mutate of [s=>delete s.operations,s=>s.operations=null,s=>s.operations=[],s=>s.schemaVersion=2,s=>s.papers.push(null),s=>s.papers.find(p=>p.paperId==='origin').workerHistory={},s=>s.papers.find(p=>p.paperId==='origin').workerHistory='invalid-history']){
    const request=f.request(),restore=alterState(f,mutate),before=files(f.project);
    try{for(const command of ['check','intake-append']){assert.match(f.invoke(command,request,false).diagnostic,/Invalid ledger|Invalid workerHistory/);assert.deepEqual(files(f.project),before,'Invalid state schema must fail before publishing any output');}}finally{restore();}
  }
});

test('full independent validators reject extra scientific edits, changed scope semantics, basis damage and terminal mismatches',t=>{
  for(const options of [
    {candidate:c=>c.inventory.items[0].text+=' unauthorized extra change'},
    {candidate:c=>c.assessments[0].basisItemHashes.extra='0'.repeat(64)},
    {candidate:c=>delete c.assessments[0].basisItemHashes['origin:i0062']},
    {candidate:c=>c.inventory.items.find(i=>i.id==='origin:i0062').locators.push(clone(c.inventory.items.find(i=>i.id==='origin:i0062').locators[0]))},
    {contract:c=>c.cards[0].claims[0].statement+=' unauthorized scope change'},
    {terminal:t=>t.actor='wrong-actor'},
    {terminal:t=>t.noActiveScientificCalculations=false},
  ]){
    const f=setup(t),altered=f.seal(options);reject(f,altered.requestPayload);
  }
});

test('all intended outputs are preflighted; conflicting immutable material and foreign writer locks are retained',t=>{
  for(const name of ['candidate.json','source-scope.json','append-correction-receipt.json','reviewer.md']){
    const f=setup(t),conflict=f.put(campaignRelative+'/coverage/origin/c001/'+name,'PRESERVE_CONFLICT');reject(f,{},/Conflicting immutable output/);assert.equal(digest(absolute(f,conflict)),conflict.sha256);
  }
  const f=setup(t),lock=f.put(campaignRelative+'/coverage/.writer.lock',canonical({pid:123456789,token:'foreign-owner'}));reject(f,{},/EEXIST/);assert.equal(digest(absolute(f,lock)),lock.sha256);
});

test('replay and frozen-history audit reject changed preserved references and missing lineage refs without mutating state',t=>{
  const f=setup(t),received=f.command('intake-append');acceptThroughLegacy(f);const stored=fs.readFileSync(stateFile(f));
  for(const ref of [f.original.candidate,f.original.sourceScope,f.original.terminal,f.repaired.candidate,f.repaired.sourceScope,f.repaired.terminal,f.repairCheck,f.report.preservedFiles.at(-1),f.releaseManifest]){
    const bytes=fs.readFileSync(absolute(f,ref));f.put(ref.path,Buffer.concat([bytes,Buffer.from(' ')]));const before=files(f.project);
    assert.match(f.invoke('intake-append',received.request,false).diagnostic,/hash|bytes/i);assert.match(f.invoke('verify',{path:'origin'},false).diagnostic,/hash|bytes/i);assert.deepEqual(files(f.project),before);f.put(ref.path,bytes);
  }
  for(const mutate of [g=>delete g.appendCorrection,g=>g.references=[],g=>g.references=g.references.filter(r=>r.sha256!==f.original.terminal.sha256),g=>g.contractSource=f.original.sourceScope,g=>delete g.contract,g=>delete g.enrollment]){
    const state=JSON.parse(stored);mutate(state.papers.find(p=>p.paperId==='origin').latest.guard);f.put(stateFile(f),canonical(state));const before=files(f.project);
    assert.match(f.invoke('verify',{path:'origin'},false).diagnostic,/append|lineage|correction|scope|reference|enrollment/i);assert.deepEqual(files(f.project),before);f.put(stateFile(f),stored);
  }
  assert.equal(f.invoke('verify',{path:'origin'}).value.appendCorrection.verified,true);
});

test('raw request mutation after check fails closed before any frozen publication',async t=>{
  const f=setup(t),request=f.request(),{runCoverage}=await inProcess(f),target=absolute(f,request),before=files(f.project),original=fs.readFileSync;let reads=0,changed=false;
  fs.readFileSync=function(filename,...args){if(typeof filename==='string'&&path.resolve(filename).toLowerCase()===target.toLowerCase()&&++reads===3){changed=true;return Buffer.from(canonical({...f.requestPayload,ownerFinished:false}));}return original.call(this,filename,...args);};
  try{await assert.rejects(runCoverage(f.project,['intake-append',request.path]),/Actual bound JSON bytes changed/);}finally{fs.readFileSync=original;}
  assert.ok(changed);assert.deepEqual(files(f.project),before);
});

test('partial atomic publication and state-save I/O failures preserve outputs and resume the exact request',async t=>{
  for(const failure of ['scope-publication','state-rename']){
    const f=setup(t),request=f.request(),{runCoverage}=await inProcess(f),stateBefore=clone(f.state()),originalLink=fs.linkSync,originalRename=fs.renameSync;let injected=false;
    const scopeTarget=path.join(f.campaign,'coverage/origin/c001/source-scope.json'),stateTarget=stateFile(f);
    fs.linkSync=function(source,target,...rest){if(failure==='scope-publication'&&!injected&&path.resolve(target).toLowerCase()===scopeTarget.toLowerCase()){injected=true;throw Error('Injected publication failure');}return originalLink.call(this,source,target,...rest);};
    fs.renameSync=function(source,target,...rest){if(failure==='state-rename'&&!injected&&path.resolve(target).toLowerCase()===stateTarget.toLowerCase()){injected=true;throw Error('Injected state-save failure');}return originalRename.call(this,source,target,...rest);};
    try{await assert.rejects(runCoverage(f.project,['intake-append',request.path]),/Injected/);}finally{fs.linkSync=originalLink;fs.renameSync=originalRename;}
    assert.ok(injected);assert.deepEqual(f.state(),stateBefore);assert.equal(fs.existsSync(path.join(f.campaign,'coverage/.writer.lock')),false);
    const candidate=path.join(f.campaign,'coverage/origin/c001/candidate.json');assert.ok(fs.existsSync(candidate));const candidateHash=digest(candidate);
    f.invoke('intake-append',request);assert.equal(digest(candidate),candidateHash);assert.equal(f.invoke('verify',{path:'origin'}).value.appendCorrection.verified,true);
  }
});
