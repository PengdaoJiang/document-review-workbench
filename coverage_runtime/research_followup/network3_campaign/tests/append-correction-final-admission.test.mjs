import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setup,files,acceptThroughLegacy,canonical,clone,read,digest,protocolRelative} from './fixtures/append-correction-final-admission/fixture.mjs';

// Final entry only: the earlier full suite covers unchanged scientific gates.
// All mutable roots are isolated synthetic fixtures, workerCount=1.
const absolute=(f,ref)=>path.resolve(f.project,ref.path);
const stateFile=f=>path.join(f.campaign,'coverage/state.json');
const sameRef=(f,a,b)=>absolute(f,a).toLowerCase()===absolute(f,b).toLowerCase()&&a.sha256===b.sha256;
function campaignRefs(f){const authority=read(absolute(f,f.state().authority)),scope=read(absolute(f,authority.scopeAuthority));return [authority.scopeAuthority,scope.scope.nodes,authority.firstPassClosure];}

test('final core is exactly the preserved algorithm with only three release identity constants replaced',()=>{
  const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../protocols');
  const old=fs.readFileSync(path.join(base,'append-correction-v1/append-core.mjs'),'utf8').replace(/\r\n/g,'\n');
  const expected=old.replace("'/protocols/append-correction-v1'","'/protocols/append-correction-final-v1'")
    .replace("'/architecture/append-correction-20261029'","'/architecture/append-correction-final-20261029'")
    .replace("'append-correction-20261029'","'append-correction-final-20261029'");
  assert.equal(fs.readFileSync(path.join(base,'append-correction-final-v1/append-core.mjs'),'utf8').replace(/\r\n/g,'\n'),expected);
});

test('final readonly check and intake reject each campaign subreference changed after initial reads without publishing',async t=>{
  const f=setup(t),request=f.request(),refs=campaignRefs(f),stateBefore=clone(f.state());
  const {runCoverage}=await import(pathToFileURL(path.join(f.project,protocolRelative,'coverage.mjs')).href);
  const trigger=absolute(f,f.repaired.candidate).toLowerCase();
  for(const command of ['check','intake-append'])for(const target of refs){
    const filename=absolute(f,target),bytes=fs.readFileSync(filename),before=files(f.project),originalRead=fs.readFileSync;
    const counts=new Map(refs.map(ref=>[absolute(f,ref).toLowerCase(),0]));let changed=false,allInitiallyRead=false;
    fs.readFileSync=function(name,...args){
      const key=typeof name==='string'?path.resolve(name).toLowerCase():null;
      if(counts.has(key))counts.set(key,counts.get(key)+1);
      if(!changed&&key===trigger){changed=true;allInitiallyRead=[...counts.values()].every(n=>n>=2);fs.writeFileSync(filename,Buffer.concat([bytes,Buffer.from(' ')]));}
      return originalRead.call(this,name,...args);
    };
    try{await assert.rejects(runCoverage(f.project,[command,request.path]),/hash mismatch/i);}
    finally{fs.readFileSync=originalRead;f.put(filename,bytes);}
    assert.ok(changed);assert.ok(allInitiallyRead,'Race must occur only after all three initial bound JSON reads');
    assert.deepEqual(f.state(),stateBefore);assert.deepEqual(files(f.project),before,'No frozen output, state change or lock survives validation rejection');
  }
});

test('final check intake verify and unchanged legacy review decide preserve all campaign refs and detect omitted lineage',t=>{
  const f=setup(t),request=f.request(),refs=campaignRefs(f),before=files(f.project),original=clone(f.paper());
  assert.equal(f.invoke('check',request).value.valid,true);assert.deepEqual(files(f.project),before);
  const received=f.invoke('intake-append',request).value,paper=f.paper(),receipt=read(absolute(f,paper.staged.guard.appendCorrection));
  assert.equal(received.scientificAcceptance,false);assert.equal(paper.phase,'awaiting_review');
  for(const ref of refs){assert.ok(receipt.requiredReferences.some(actual=>sameRef(f,actual,ref)));assert.ok(paper.staged.guard.references.some(actual=>sameRef(f,actual,ref)));}
  for(const name of ['scan','order','guardEnrollment','firstPass','history','iteration'])assert.deepEqual(paper[name],original[name]);
  for(const ref of [...Object.values(f.original),...Object.values(f.repaired),...f.report.preservedFiles])assert.equal(digest(absolute(f,ref)),ref.sha256);
  assert.equal(f.invoke('verify',{path:'origin'}).value.appendCorrection.verified,true);
  const saved=fs.readFileSync(stateFile(f));
  for(const ref of refs){
    const damaged=JSON.parse(saved);const guard=damaged.papers.find(row=>row.paperId==='origin').staged.guard;
    guard.references=guard.references.filter(actual=>!sameRef(f,actual,ref));f.put(stateFile(f),canonical(damaged));const unchanged=files(f.project);
    assert.match(f.invoke('verify',{path:'origin'},false).diagnostic,/Missing required append lineage reference/);assert.deepEqual(files(f.project),unchanged);f.put(stateFile(f),saved);
  }
  acceptThroughLegacy(f);assert.equal(f.paper().phase,'complete');
  assert.equal(f.invokeLegacy('verify',{path:'origin'}).value.coverageComplete,true);
  assert.equal(f.invoke('verify',{path:'origin'}).value.coverageComplete,true);
  const frozen=files(f.project);assert.equal(f.invoke('intake-append',request).value.replayed,true);assert.deepEqual(files(f.project),frozen);
});
