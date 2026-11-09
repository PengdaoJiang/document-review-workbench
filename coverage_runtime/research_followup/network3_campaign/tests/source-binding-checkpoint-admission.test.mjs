import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonical, hash} from '../coverage-core.mjs';
import {prepareCheckpointCorrection} from '../protocols/source-binding-v1-checkpoint/source-admission.mjs';
import {resolveSourceView} from '../protocols/source-binding-v1-checkpoint/source-binding.mjs';
import {runBatch,serializedBytes,MAX_BATCH_BYTES} from '../protocols/source-binding-v1-checkpoint/coverage-batch.mjs';
import {runReader as runLegacyReader} from '../coverage-reader.mjs';
import {fixture, installCoverage, copyModuleClosure, candidateFor, reviewFor, decisionFor, objectHash, refreshBasis,
 campaignRelative, cleanRelative, read, clone, digest} from './fixtures/source-binding/fixture.mjs';

// Isolated synthetic source/runtime/ledger per test. workerCount=1; leave CPU
// headroom. No production CLI, scientific computation, PDF or vendor execution.
const worker='synthetic-source-worker', reviewer='synthetic-source-reviewer', supervisor='synthetic-supervisor';
const protocolBase=campaignRelative+'/protocols/source-binding-v1-checkpoint';
const releaseBase=campaignRelative+'/architecture/source-supplement-checkpoint-20261029';
const moduleNames=['coverage.mjs','coverage-guard.mjs','coverage-recovery.mjs','source-admission.mjs','source-binding.mjs','coverage-core.mjs','coverage-scope.mjs','coverage-context.mjs','coverage-reader.mjs','coverage-authoring.mjs','coverage-kit.mjs','coverage-batch.mjs','coverage-review-parts.mjs'];
const absolute=(f,ref)=>path.resolve(f.project,ref.path);
function legacyRelease(f){
 copyModuleClosure(f.project,campaignRelative+'/coverage-batch.mjs');
 const oldBase=campaignRelative+'/architecture/batch-scope-20261029';
 f.put(campaignRelative+'/COVERAGE_GUARDS.md','Synthetic source-scope guard guide.');
 for(const name of ['BATCH_API.md','SCOPE_API.md'])f.put(oldBase+'/'+name,'Synthetic neutral guide.');
 const modules=['coverage.mjs','coverage-guard.mjs','coverage-scope.mjs','coverage-batch.mjs','COVERAGE_GUARDS.md','BATCH_API.md','SCOPE_API.md'].map(name=>{
  const installedName=(['BATCH_API.md','SCOPE_API.md'].includes(name)?oldBase:campaignRelative)+'/'+name;
  const file=path.join(f.project,installedName),installed={path:installedName,sha256:digest(file)};
  return {name,installed,frozen:f.put(oldBase+'/release/'+name,fs.readFileSync(file))};
 });
 f.put(oldBase+'/release-manifest.json',{schemaVersion:1,releaseId:'batch-scope-20261029',modules});
}
function setup(t,{adopt=true}={}){
 const legacy=installCoverage(fixture(t));copyModuleClosure(legacy.project,protocolBase+'/coverage.mjs');
 // Also ship adapter modules not directly imported by the CLI.
 for(const name of moduleNames)copyModuleClosure(legacy.project,protocolBase+'/'+name);
 legacyRelease(legacy);
 legacy.invoke('init');legacy.command('guard-policy',{supervisor,reason:'Synthetic guard activation.'});
 legacy.command('prepare');legacy.command('assign',{role:'worker',agent:worker,freshContext:true,historyInherited:false});
 const scan=read(legacy.paper().scan.path),reading=scan.reading,main=fs.readFileSync(reading.primary.path,'utf8');
 const literal='\\lstinputlisting{algorithm1.m}',start=main.indexOf(literal);
 assert.ok(start>=0);
 const supplementPath=path.join(path.dirname(reading.primary.path),'algorithm1.m');
 const binding={schemaVersion:1,protocol:'source-supplement-v1',paperId:'origin',baseScan:legacy.paper().scan,
  edition:Object.fromEntries(['version','release','indexSha256','recordSha256'].map(key=>[key,reading.edition[key]])),
  index:{path:'reconstructed_sources/'+reading.edition.release+'/index.json',sha256:reading.edition.indexSha256},
  record:{path:reading.edition.recordPath,sha256:reading.edition.recordSha256},includingResource:reading.primary,
  include:{command:'lstinputlisting',start,end:start+literal.length,excerptSha256:hash(literal),literalTarget:'algorithm1.m'},
  supplement:{path:supplementPath,sha256:digest(supplementPath)},supplementBytes:fs.statSync(supplementPath).size,kind:'utf8_listing'};
 const proposedBinding=legacy.put(releaseBase+'/proposed-binding.json',canonical(binding));
 const modules=moduleNames.map(name=>{const installed={path:protocolBase+'/'+name,sha256:digest(path.join(legacy.project,protocolBase,name))};return {name,installed,frozen:legacy.put(releaseBase+'/release/'+name,fs.readFileSync(absolute(legacy,installed)))};});

 const paper=legacy.paper(),draft=legacy.put(paper.workRoot+'/original-draft.txt','Original actor draft retained without relabeling.');
 const oldDrafts=['candidate.json','source-scope.json','terminal.json',...Array.from({length:91},(_,i)=>'sealed-original-'+String(i+1).padStart(3,'0')+'.txt')].map(name=>legacy.put(paper.workRoot+'/'+name,{legacyDraft:name,actor:worker}));
 const originalRecord={schemaVersion:1,status:'source_adoption_safe_checkpoint',paperId:'origin',revision:1,agent:worker,role:'worker',
  scan:paper.scan,order:paper.order,guardEnrollment:paper.guardEnrollment.profile,noActiveCalculation:true,noConcurrentReadWrite:true,
  preservedDrafts:[draft,...oldDrafts],checkpointedAt:'2026-10-29T00:00:00Z'};
 const originalCheckpoint=legacy.put(paper.workRoot+'/source-adoption-checkpoint.json',originalRecord);
 const checkpoint=prepareCheckpointCorrection({root:legacy.project,state:legacy.state(),paper,originalCheckpoint,agent:worker,noActiveCalculation:true,noConcurrentReadWrite:true,checkpointedAt:'2026-10-29T00:00:02Z'});
 const ownerCheckpoint=legacy.put(paper.workRoot+'/source-adoption-checkpoint-v002.json',checkpoint);
 const releaseManifest=legacy.put(releaseBase+'/release-manifest.json',{schemaVersion:1,releaseId:'source-supplement-checkpoint-20261029',protocol:'source-supplement-v1',
  repairScope:{paperId:'origin',iteration:1,baseScan:legacy.paper().scan,sourceBindingSha256:objectHash(binding)},checkpointCorrection:{originalCheckpoint,agent:worker},modules});
 const adoptFields={schemaVersion:1,paperId:'origin',iteration:1,agent:worker,supervisor,reason:'Exact synthetic omitted listing repair.',
  scan:paper.scan,order:paper.order,guardEnrollment:paper.guardEnrollment,sourceBinding:proposedBinding,releaseManifest,ownerCheckpoint};
 const invoke=(command,request=null,ok=true)=>legacy.execute(protocolBase+'/coverage.mjs',[command,...(request?[request.path]:[])],ok);
 const command=(name,fields={},ok=true)=>{const request=legacy.request(fields);return {...invoke(name,request,ok),request};};
 const f={...legacy,invokeLegacy:legacy.invoke,commandLegacy:legacy.command,invoke,command,scan,binding,proposedBinding,releaseManifest,originalRecord,originalCheckpoint,checkpoint,ownerCheckpoint,adoptFields,draft,oldDrafts};
 if(adopt){f.adoption=command('source-adopt',adoptFields);const view=resolveSourceView({root:f.project,scan,sourceBinding:f.paper().sourceEnrollment.sourceBinding});f.sourceView={...scan,resources:view.resources,units:view.units,diagnostics:view.diagnostics};}
 return f;
}
function assign(f,role,agent){return f.command('assign',{role,agent,freshContext:true,historyInherited:false});}
function sourceCandidate(f){
 const candidate=candidateFor(f,f.sourceView,{author:worker});candidate.schemaVersion=2;candidate.sourceBinding=f.paper().sourceEnrollment.sourceBinding;candidate.scanSha256=objectHash(f.scan);return candidate;
}
function sourceReview(f,candidate){
 const review=reviewFor(f,f.sourceView,candidate,{reviewer});review.schemaVersion=2;review.sourceBinding=f.paper().sourceEnrollment.sourceBinding;review.scanSha256=objectHash(f.scan);return review;
}
function files(root) {
  const values = {};
  const visit = relative => { for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
    const child = path.join(relative, entry.name); if (entry.isDirectory()) visit(child); else values[child] = digest(path.join(root, child));
  }}; visit(''); return values;
}
function reject(f, command, fields, pattern = /guard|scope|hash|ENOENT|independent|reference/i) {
  const request = f.request(fields), before = files(f.project), state = clone(f.state());
  const result = f.invoke(command, request, false); assert.match(result.diagnostic, pattern);
  assert.deepEqual(f.state(), state, 'Rejected admission never mutates live state');
  assert.deepEqual(files(f.project), before, 'Reject before publication leaves no partial artifacts or locks');
  return result;
}
function scopeFor(f, candidate, {legacy = []} = {}) {
  const cards = [], alignments = [], scan = f.sourceView;
  for (const item of candidate.inventory.items) {
    if (item.obligations.every(o => legacy.includes(o.id))) continue;
    const anchors = item.locators.map((locator, index) => {
      const unit = scan.units.find(u => u.id === locator.unitId), resource = scan.resources.find(r => r.id === unit.resourceId);
      return {id: item.id + ':a' + index, resourceId: resource.id, resourceSha256: resource.sha256, unitId: unit.id,
        ...(resource.type === 'text' ? {start: locator.start, end: locator.end, excerptSha256: locator.excerptSha256,
          quote: fs.readFileSync(resource.path, 'utf8').slice(locator.start, locator.end)} : {semantic: locator.semantic})};
    });
    const claimId = item.id + ':source';
    cards.push({itemId: item.id, itemSha256: objectHash(item), anchors, claims: [{id: claimId, anchorIds: anchors.map(a => a.id),
      statement: 'Synthetic exact source identity only.', kind: Object.hasOwn(anchors[0], 'quote') ? 'identity' : 'visual_observation',
      modality: 'Synthetic stated assertion', quantifier: 'The displayed synthetic expression', conditions: ['Synthetic domain only'],
      empiricalTarget: {kind: 'not_empirical', description: 'Not empirical; synthetic source consistency fixture.', identityRequirements: []}}]});
    for (const obligation of item.obligations.filter(o => !legacy.includes(o.id))) alignments.push({obligationId: obligation.id,
      obligationSha256: objectHash(obligation), assessmentSha256: objectHash(candidate.assessments.find(a => a.obligationId === obligation.id)),
      claimIds: [claimId], relation: 'original', additionalAssumptions: [], assessedTarget: 'not_empirical', reason: 'Synthetic target matches the explicitly bound original source.'});
  }
  return {schemaVersion: 2, sourceBinding:f.paper().sourceEnrollment.sourceBinding, paperId: candidate.paperId, revision: candidate.revision, scanSha256: objectHash(f.scan), candidateSha256: objectHash(candidate), author: candidate.author,
    inventory: {complete: candidate.inventory.complete, missingClaims: [], notes: 'Synthetic full source boundaries explicitly inspected.'}, cards, alignments, legacyRetainedObligationIds: legacy};
}
function scopeReviewFor(f, candidate, contract, review) {
  const evidence = [f.put(f.paper().staged.reviewRoot + '/scope-independent.txt', 'Independent synthetic source-to-target inspection, not constructor output.')];
  return {schemaVersion: 2, sourceBinding:f.paper().sourceEnrollment.sourceBinding, paperId: candidate.paperId, revision: candidate.revision, scanSha256: objectHash(f.scan), candidateSha256: objectHash(candidate),
    contractSha256: objectHash(contract), reviewSha256: objectHash(review), reviewerAgent: review.reviewerAgent,
    inventory: {complete: review.inventory.complete, checkedUnlistedSource: true, missingClaims: [], notes: 'Independently inspected synthetic unlisted source and exact targets.', evidence},
    cards: contract.cards.map(card => ({itemId: card.itemId, cardSha256: objectHash(card), verdict: 'aligned', reason: 'Independent synthetic source match.', evidence})),
    entries: contract.alignments.map(row => ({obligationId: row.obligationId, alignmentSha256: objectHash(row), verdict: 'aligned', reason: 'Independent synthetic obligation target match.', evidence})),
    retainedItemIds: [], retainedObligationIds: []};
}
function deliverCandidate(f, candidate = sourceCandidate(f), options) {
  const delivery = f.put(f.paper().workRoot + '/candidate-source-v2.json', candidate), contract = scopeFor(f, candidate, options);
  const source = f.put(f.paper().workRoot + '/source-scope-v2.json', contract);
  return {candidate, delivery, contract, source};
}
function intake(f, proposed) { return f.command('intake', {agent: proposed.candidate.author, ownerFinished: true, candidatePath: proposed.delivery.path}); }
function deliverReview(f, proposed, review = sourceReview(f,proposed.candidate)) {
  const delivery = f.put(f.paper().staged.reviewRoot + '/review-source-v2.json', review), scopeReview = scopeReviewFor(f, proposed.candidate, proposed.contract, review);
  const source = f.put(f.paper().staged.reviewRoot + '/scope-review-v2.json', scopeReview);
  return {review, delivery, scopeReview, source};
}
function receiveReview(f, reviewed) { return f.command('review', {agent: reviewed.review.reviewerAgent, ownerFinished: true, reviewPath: reviewed.delivery.path}); }
function decide(f, proposed, reviewed, mutate = () => {}) {
  const decision = decisionFor(f.scan, proposed.candidate, reviewed.review);decision.schemaVersion=2;decision.sourceBinding=f.paper().sourceEnrollment.sourceBinding; mutate(decision);
  const ref = f.put(campaignRelative + '/coverage/requests/decision-' + f.state().revision + '.json', decision);
  return f.command('decide', {decisionPath: ref.path});
}
function release(f, role, delivery, {omitScope=false}={}) {
  const paper = f.paper(), actor = role === 'worker' ? worker : reviewer, privateRoot = role === 'worker' ? paper.workRoot : paper.staged.reviewRoot;
  const checkpoint = role === 'worker' ? {schemaVersion: 2,sourceBinding:paper.sourceEnrollment.sourceBinding, paperId: 'origin', revision: paper.iteration, agent: actor,
    terminalState: 'candidate_frozen_ready_for_independent_review', noActiveCalculation: true, candidate: delivery}
    : {schemaVersion: 2,sourceBinding:paper.sourceEnrollment.sourceBinding, paperId: 'origin', revision: paper.iteration, reviewerAgent: actor, status: 'review_delivered', noActiveCalculation: true,
      scanSha256: paper.scan.sha256, candidateSha256: paper.staged.candidate.sha256, review: delivery};
  if(paper.guardEnrollment&&!omitScope) {
    const filename=privateRoot+'/'+(role==='worker'?'source-scope-v2.json':'scope-review-v2.json');
    checkpoint[role==='worker'?'sourceScope':'scopeReview']={path:filename,sha256:digest(path.resolve(f.project,filename))};
  }
  const ownerCheckpoint = f.put(privateRoot + '/terminal-source-v2.json', checkpoint);
  const terminalEvidence = f.put(campaignRelative + '/coverage/requests/terminal-' + role + '.json', {schemaVersion: 1, paperId: 'origin', agent: actor,
    ownerFinished: true, noActiveCalculation: true, supervisor, ownerCheckpoint});
  const result = f.command('release', {agent: actor, ownerFinished: true, noActiveCalculation: true, reason: 'Synthetic natural terminal state.', supervisor, terminalEvidence});
  return {schemaVersion: 2,sourceBinding:paper.sourceEnrollment.sourceBinding, paperId: 'origin', iteration: paper.iteration, agent: actor, ownerFinished: true, noActiveCalculation: true, supervisor,
    reason: 'Recover exact original synthetic delivery.', releaseOperationId: hash(canonical({command: 'release', request: read(absolute(f, result.request))})),
    releaseRequest: result.request, releaseReceipt: result.value.release, terminalEvidence, ownerCheckpoint, scan: paper.scan,
    order: role === 'worker' ? paper.order : paper.staged.reviewOrder, delivery, candidate: role === 'worker' ? null : paper.staged.candidate};
}


test('original actor source adoption preserves base/guard/order/draft, is idempotent, and only changes its branch',t=>{
 const f=setup(t,{adopt:false}),paper=clone(f.paper()),foreign=f.state().papers.filter(p=>p.paperId!=='origin'),before=files(f.project);
 const result=f.command('source-adopt',f.adoptFields),after=files(f.project);
 assert.equal(f.paper().phase,'source_working');assert.deepEqual(f.paper().owner,paper.owner);
 const instructions=fs.readFileSync(absolute(f,f.paper().sourceEnrollment.supplementOrder),'utf8');
 assert.ok(Buffer.byteLength(instructions,'utf8')<=8192,'The whole source supplement instruction remains below 8 KiB with 95-to-96 draft preservation');
 assert.ok(instructions.includes(f.ownerCheckpoint.path)&&instructions.includes(f.ownerCheckpoint.sha256));assert.ok(instructions.includes('Preserved draft count: 96'));
 assert.ok(!instructions.includes('original-draft.txt'));for(const ref of f.oldDrafts)assert.ok(!instructions.includes(ref.path),'No full draft inventory is embedded in model instructions');
 for(const name of ['candidate-source-v2.json','source-scope-v2.json','review-source-v2.json','scope-review-v2.json','terminal-source-v2.json','protocols/source-binding-v1-checkpoint/coverage-reader.mjs'])assert.ok(instructions.includes(name),name);
 for(const field of ['scan','order','guardEnrollment','workRoot','workerHistory'])assert.deepEqual(f.paper()[field],paper[field]);
 assert.deepEqual(f.state().papers.filter(p=>p.paperId!=='origin'),foreign);assert.equal(digest(absolute(f,f.draft)),f.draft.sha256);
 for(const [name,sha] of Object.entries(before))if(!name.endsWith('coverage\\state.json')&&!name.endsWith('coverage/state.json'))assert.equal(after[name],sha,name);
 assert.equal(f.invoke('source-adopt',result.request).value.replayed,true);assert.deepEqual(files(f.project),after);
 reject(f,'source-adopt',f.adoptFields,/original c001|adopt/);
 assert.match(f.invoke('init',null,false).diagnostic,/Unknown coverage command/);
});

test('idempotent admission replay rechecks consumed immutable index and record identities',t=>{
 const f=setup(t);
 assert.equal(f.invoke('source-adopt',f.adoption.request).value.replayed,true);
 for(const ref of [f.binding.index,f.binding.record]){
  const original=fs.readFileSync(absolute(f,ref));f.put(ref.path,Buffer.concat([original,Buffer.from(' ')]));const before=files(f.project);
  assert.match(f.invoke('source-adopt',f.adoption.request,false).diagnostic,/hash mismatch/);assert.deepEqual(files(f.project),before);
  f.put(ref.path,original);
 }
 assert.equal(f.invoke('source-adopt',f.adoption.request).value.replayed,true);
});

test('admission rejects altered actual bound JSON read bytes even when disk and declared hash remain correct',async t=>{
 const f=setup(t,{adopt:false}),request=f.request(f.adoptFields);
 const {runCoverage}=await import(pathToFileURL(path.join(f.project,protocolBase,'coverage.mjs')).href);
 const target=absolute(f,f.ownerCheckpoint),before=files(f.project),originalRead=fs.readFileSync;
 const forged=Buffer.from(canonical({...f.checkpoint,checkpointedAt:'2026-10-29T00:00:01Z'}));
 let reads=0,injected=false;
 fs.readFileSync=function(filename,...args){
  if(typeof filename==='string'&&path.resolve(filename).toLowerCase()===target.toLowerCase()){
   reads++;
   // scoped checkRef, bound checkRef, then the actual bytes being parsed.
   if(reads===3){injected=true;return forged;}
  }
  return originalRead.call(this,filename,...args);
 };
 try{await assert.rejects(runCoverage(f.project,['source-adopt',request.path]),/actual read bytes hash mismatch/);}
 finally{fs.readFileSync=originalRead;}
 assert.ok(injected,'Inject exactly the consumed bound-JSON read, after normal hash checks');
 assert.equal(digest(target),f.ownerCheckpoint.sha256,'Bound file on disk was never changed');
 assert.deepEqual(files(f.project),before,'Rejected actual-byte mismatch publishes no state, files, or locks');
});

test('adoption refuses actor, safe checkpoint, source release scope and private-root tampering before publication',t=>{
 const f=setup(t,{adopt:false});
 const normalState=f.state(),withoutPolicy=clone(normalState);delete withoutPolicy.guardPolicy;f.put(campaignRelative+'/coverage/state.json',canonical(withoutPolicy));
 reject(f,'source-adopt',f.adoptFields,/guard policy/);f.put(campaignRelative+'/coverage/state.json',canonical(normalState));
 for(const patch of [{agent:'impostor'},{supervisor:'impostor'},{iteration:2},{sourceBinding:f.draft},{order:f.proposedBinding}])
  reject(f,'source-adopt',{...f.adoptFields,...patch},/Source admission|Source binding|reference/i);
 const original=fs.readFileSync(absolute(f,f.ownerCheckpoint));
 for(const mutate of [c=>c.noActiveCalculation=false,c=>c.noConcurrentReadWrite=false,c=>c.agent='impostor',c=>c.preservedDrafts=[f.proposedBinding]]){
  const checkpoint=clone(f.checkpoint);mutate(checkpoint);const ref=f.put(f.ownerCheckpoint.path,checkpoint);
  reject(f,'source-adopt',{...f.adoptFields,ownerCheckpoint:ref},/checkpoint|actor|escapes|outside/i);
 }
 f.put(f.ownerCheckpoint.path,original);
 const sibling=f.put(cleanRelative+'/coverage_work/r0001/c001/source-adoption-checkpoint.json',original);
 reject(f,'source-adopt',{...f.adoptFields,ownerCheckpoint:sibling},/escapes|outside/i);
 const manifest=read(absolute(f,f.releaseManifest));manifest.repairScope.paperId='r0001';const bad=f.put(f.releaseManifest.path,manifest);
 reject(f,'source-adopt',{...f.adoptFields,releaseManifest:bad},/repair scope|Path escapes authorized root/);
});

test('every old v1 write path rejects source branch before business mutation and other paper operations stay v1',t=>{
 const f=setup(t);
 const sealedProtocol=campaignRelative+'/protocols/source-binding-v1/coverage.mjs';copyModuleClosure(f.project,sealedProtocol);
 for(const name of ['prepare','assign','release','intake','review','recover-intake','recover-review','decide','continue']){
  const request=f.request({agent:worker,role:'worker',freshContext:true,historyInherited:false,ownerFinished:true,noActiveCalculation:true,reason:'Synthetic',supervisor}),before=files(f.project);
  assert.match(f.invokeLegacy(name,request,false).diagnostic,/Error|phase|boundary|request/i);assert.deepEqual(files(f.project),before,name);
  if(name!=='prepare'){
   assert.match(f.execute(sealedProtocol,[name,request.path],false).diagnostic,/escapes|exact required path|release/i);assert.deepEqual(files(f.project),before,'Sealed source-binding-v1 '+name);
  }
 }
 // A foreign paper's ordinary old-v1 mutation remains valid; no source enrollment is transferred.
 const state=f.state(),other=state.papers.find(p=>p.paperId==='r0001');Object.assign(other,{phase:'ready',iteration:1,scan:f.paper().scan,order:f.paper().order,workRoot:cleanRelative+'/coverage_work/r0001/c001',staged:null});
 f.put(campaignRelative+'/coverage/state.json',canonical(state));
 f.commandLegacy('assign',{paperId:'r0001',role:'worker',agent:'foreign-original-worker',freshContext:true,historyInherited:false});
 assert.equal(f.state().papers.find(p=>p.paperId==='r0001').phase,'working');
 reject(f,'release',{paperId:'r0001',agent:'foreign-original-worker',ownerFinished:true,noActiveCalculation:true,reason:'No new protocol authority',supervisor},/enrolled source/);
});

test('pure correction helper derives exact 95 to 96 lineage without writes and requires explicit fresh original-actor attestations',t=>{
 const f=setup(t,{adopt:false}),before=files(f.project),args={root:f.project,state:f.state(),paper:f.paper(),originalCheckpoint:f.originalCheckpoint,agent:worker,noActiveCalculation:true,noConcurrentReadWrite:true,checkpointedAt:'2026-10-29T00:00:02Z'};
 const corrected=prepareCheckpointCorrection(args);assert.deepEqual(corrected,f.checkpoint);
 assert.equal(f.originalRecord.preservedDrafts.length,95);assert.equal(corrected.preservedDrafts.length,96);
 assert.deepEqual(corrected.preservedDrafts.slice(0,-1),f.originalRecord.preservedDrafts);assert.deepEqual(corrected.preservedDrafts.at(-1),f.originalCheckpoint);
 assert.deepEqual(corrected.supersedes,f.originalCheckpoint);assert.equal(corrected.correctionReason,'restore_guard_enrollment_container');
 assert.deepEqual(corrected.guardEnrollment,f.paper().guardEnrollment);assert.deepEqual(f.originalRecord.guardEnrollment,f.paper().guardEnrollment.profile);
 for(const patch of [{agent:'other-actor'},{noActiveCalculation:undefined},{noActiveCalculation:false},{noConcurrentReadWrite:undefined},{noConcurrentReadWrite:false},{checkpointedAt:f.originalRecord.checkpointedAt},{checkpointedAt:'2026-10-28T00:00:00Z'},{checkpointedAt:'invalid'},{originalCheckpoint:f.draft},{state:{...args.state,revision:args.state.revision+1}},{paper:{...args.paper,owner:{...args.paper.owner,agent:'other'}}}])assert.throws(()=>prepareCheckpointCorrection({...args,...patch}),/Source admission|reference|path|hash|scope|exact/i);
 assert.deepEqual(files(f.project),before,'Pure helper never saves or alters any file');
});

test('corrected checkpoint rejects changed identity, guard, field set, reason, time and exact preserved lineage',t=>{
 const f=setup(t,{adopt:false}),original=fs.readFileSync(absolute(f,f.ownerCheckpoint));
 const mutations=[
  c=>c.schemaVersion=1,c=>c.agent='wrong-actor',c=>c.role='reviewer',c=>c.revision=2,c=>c.status='other',
  c=>c.supersedes=f.draft,c=>c.supersedes={...c.supersedes,sha256:'0'.repeat(64)},c=>delete c.supersedes,
  c=>c.correctionReason='other',c=>c.guardEnrollment=f.paper().guardEnrollment.profile,
  c=>c.guardEnrollment.instructions=f.draft,c=>c.scan=f.draft,c=>c.order=f.draft,c=>c.noActiveCalculation=false,c=>c.noConcurrentReadWrite=false,
  c=>c.preservedDrafts.pop(),c=>c.preservedDrafts.shift(),c=>c.preservedDrafts.reverse(),c=>c.preservedDrafts.push(f.originalCheckpoint),
  c=>c.preservedDrafts.push(f.ownerCheckpoint),c=>c.preservedDrafts[0]={...c.preservedDrafts[0],sha256:'0'.repeat(64)},
  c=>c.preservedDrafts[0]=c.preservedDrafts[1],c=>c.preservedDrafts[0]=f.ownerCheckpoint,
  c=>c.checkpointedAt=f.originalRecord.checkpointedAt,c=>c.checkpointedAt='2026-10-28T00:00:00Z',c=>c.checkpointedAt='invalid',c=>c.extra='unknown'
 ];
 for(const mutate of mutations){const checkpoint=clone(f.checkpoint);mutate(checkpoint);const ownerCheckpoint=f.put(f.ownerCheckpoint.path,checkpoint);reject(f,'source-adopt',{...f.adoptFields,ownerCheckpoint},/checkpoint|correction|actor|fields|lineage|attestation/i);}
 f.put(f.ownerCheckpoint.path,original);
 for(const name of ['source-adoption-checkpoint.json','source-adoption-checkpoint-v003.json','nested/source-adoption-checkpoint-v002.json']){
  const alternate=name==='source-adoption-checkpoint.json'?f.originalCheckpoint:f.put(f.paper().workRoot+'/'+name,original);
  reject(f,'source-adopt',{...f.adoptFields,ownerCheckpoint:alternate},/exact required path|checkpoint/);
 }
});

test('release correction grant pins exact original actor and fixed original checkpoint ref',t=>{
 const f=setup(t,{adopt:false}),original=fs.readFileSync(absolute(f,f.releaseManifest));
 const alias=f.put(f.paper().workRoot+'/original-checkpoint-copy.json',fs.readFileSync(absolute(f,f.originalCheckpoint)));
 for(const mutate of [m=>m.checkpointCorrection.agent='wrong-actor',m=>m.checkpointCorrection.originalCheckpoint=alias,m=>m.checkpointCorrection.originalCheckpoint={...f.originalCheckpoint,sha256:'0'.repeat(64)},m=>delete m.checkpointCorrection.agent,m=>m.checkpointCorrection.extra=true,m=>delete m.checkpointCorrection]){
  const manifest=JSON.parse(original);mutate(manifest);const releaseManifest=f.put(f.releaseManifest.path,manifest);reject(f,'source-adopt',{...f.adoptFields,releaseManifest},/grant|correction|checkpoint|fields|exact required path|hash/i);
 }
 f.put(f.releaseManifest.path,original);
});

test('original checkpoint permits only the declared guard container defect and no weakened safe state or self-referential drafts',t=>{
 const f=setup(t,{adopt:false}),original=fs.readFileSync(absolute(f,f.originalCheckpoint));
 const mutations=[c=>c.guardEnrollment=f.paper().guardEnrollment,c=>c.guardEnrollment=f.draft,c=>c.noActiveCalculation=false,c=>c.noConcurrentReadWrite=false,c=>c.agent='other',c=>c.schemaVersion=2,c=>c.scan=f.draft,c=>c.order=f.draft,c=>c.status='other',c=>c.extra=true,c=>c.preservedDrafts.push(c.preservedDrafts[0]),c=>c.preservedDrafts.push(f.originalCheckpoint),c=>c.preservedDrafts.push(f.ownerCheckpoint)];
 for(const mutate of mutations){const record=clone(f.originalRecord);mutate(record);const originalCheckpoint=f.put(f.originalCheckpoint.path,record),before=files(f.project);
  assert.throws(()=>prepareCheckpointCorrection({root:f.project,state:f.state(),paper:f.paper(),originalCheckpoint,agent:worker,noActiveCalculation:true,noConcurrentReadWrite:true,checkpointedAt:'2026-10-29T00:00:02Z'}),/checkpoint|guard|reference|fields|hash|defect|draft/i);assert.deepEqual(files(f.project),before);
 }
 f.put(f.originalCheckpoint.path,original);
 const draft=f.originalRecord.preservedDrafts[0],bytes=fs.readFileSync(absolute(f,draft));f.put(draft.path,Buffer.concat([bytes,Buffer.from('modified')]));const before=files(f.project);
 assert.throws(()=>prepareCheckpointCorrection({root:f.project,state:f.state(),paper:f.paper(),originalCheckpoint:f.originalCheckpoint,agent:worker,noActiveCalculation:true,noConcurrentReadWrite:true,checkpointedAt:'2026-10-29T00:00:02Z'}),/hash mismatch/);assert.deepEqual(files(f.project),before);f.put(draft.path,bytes);
});

test('both checkpoint refs and all original drafts remain in replay and future verification dependencies',t=>{
 const f=setup(t),operation=f.state().operations[hash(canonical({command:'source-adopt',request:read(absolute(f,f.adoption.request))}))];
 const sameFile=(a,b)=>path.resolve(f.project,a.path).toLowerCase()===path.resolve(f.project,b.path).toLowerCase()&&a.sha256===b.sha256;
 for(const ref of [f.originalCheckpoint,f.ownerCheckpoint,...f.originalRecord.preservedDrafts])assert.ok(operation.references.some(r=>sameFile(r,ref)),'Persistent reference '+ref.path);
 const profile=read(absolute(f,f.paper().sourceEnrollment.profile));assert.deepEqual(profile.checkpointCorrection,{originalCheckpoint:f.originalCheckpoint,agent:worker});assert.deepEqual(profile.preservedDrafts,f.checkpoint.preservedDrafts);
 for(const ref of [f.originalCheckpoint,f.ownerCheckpoint,f.originalRecord.preservedDrafts[0],f.originalRecord.preservedDrafts.at(-1)]){
  const bytes=fs.readFileSync(absolute(f,ref));f.put(ref.path,Buffer.concat([bytes,Buffer.from(' ')]));const before=files(f.project);
  assert.match(f.invoke('source-adopt',f.adoption.request,false).diagnostic,/hash mismatch/);assert.match(f.invoke('verify',{path:'origin'},false).diagnostic,/hash mismatch/);assert.deepEqual(files(f.project),before);f.put(ref.path,bytes);
 }
 assert.equal(f.invoke('source-adopt',f.adoption.request).value.replayed,true);
});

test('source candidate through independent review, decision, continue and history verify preserves exact binding',t=>{
 const f=setup(t),foreign=clone(f.state().papers.filter(p=>p.paperId!=='origin')),proposed=deliverCandidate(f);intake(f,proposed);
 assert.equal(read(f.paper().staged.candidate.path).schemaVersion,2);assign(f,'reviewer',reviewer);
 const reviewed=deliverReview(f,proposed);receiveReview(f,reviewed);
 decide(f,proposed,reviewed,d=>{d.acceptedObligationIds=d.acceptedObligationIds.slice(0,-1);});
 assert.equal(f.paper().phase,'source_assessed');const binding=clone(f.paper().sourceEnrollment.sourceBinding),old=clone(f.paper().latest);
 f.command('continue');assign(f,'worker','synthetic-c002-worker');
 assert.match(fs.readFileSync(absolute(f,f.paper().order),'utf8'),/candidate-source-v2\.json/);assert.match(fs.readFileSync(absolute(f,f.paper().guardEnrollment.instructions),'utf8'),/schemaVersion 2/);
 const next=clone(proposed.candidate);next.revision=2;next.author='synthetic-c002-worker';next.predecessorSha256=old.candidate.sha256;
 const current=deliverCandidate(f,next);intake(f,current);assign(f,'reviewer','synthetic-c002-reviewer');
 const nextReview=sourceReview(f,next);nextReview.reviewerAgent='synthetic-c002-reviewer';
 const checked=deliverReview(f,current,nextReview);receiveReview(f,checked);decide(f,current,checked);
 assert.equal(f.paper().phase,'source_complete');assert.deepEqual(f.paper().sourceEnrollment.sourceBinding,binding);assert.deepEqual(f.paper().history,[old]);
 assert.equal(f.invoke('verify',{path:'origin'}).value.coverageComplete,true);assert.deepEqual(f.state().papers.filter(p=>p.paperId!=='origin'),foreign);
 for(const ref of f.oldDrafts)assert.equal(digest(absolute(f,ref)),ref.sha256,'Old schema drafts must remain untouched through complete source flow');
 const stateFile=campaignRelative+'/coverage/state.json',original=fs.readFileSync(path.resolve(f.project,stateFile));
 for(const mutate of [snapshot=>delete snapshot.guard,snapshot=>delete snapshot.guard.contract,snapshot=>delete snapshot.guard.scopeReview,snapshot=>delete snapshot.guard.enrollment,snapshot=>snapshot.guard.enrollment=f.paper().latest.guard.enrollment]){
  const state=JSON.parse(original);mutate(state.papers.find(p=>p.paperId==='origin').history[0]);f.put(stateFile,canonical(state));const before=files(f.project);
  assert.match(f.invoke('verify',{path:'origin'},false).diagnostic,/guard|exact required path|snapshot|escapes/i);assert.deepEqual(files(f.project),before);f.put(stateFile,original);
 }
});

test('intake admits exact additional listing receipt input but rejects a sibling input',t=>{
 const f=setup(t),candidate=sourceCandidate(f);
 candidate.inventory.items.at(-1).obligations[0].kind='algorithm';candidate.inventory.items.at(-1).obligations[0].dimension='algorithmValidation';refreshBasis(candidate);
 const output=f.put(f.paper().workRoot+'/implementation.txt','Synthetic inert listing comparison output.');
 const receipt=f.put(f.paper().workRoot+'/receipt.json',{schemaVersion:1,paperId:'origin',tool:'synthetic',version:'1',command:['synthetic'],workerCount:1,startedAt:'2026-10-29T00:00:00Z',finishedAt:'2026-10-29T00:00:01Z',exitCode:0,inputs:[f.binding.supplement],outputs:[output]});
 candidate.assessments.at(-1).evidence=[{kind:'new',method:'implementation_test',artifacts:[output],mapping:{scope:'Exact synthetic listing',conditions:'Synthetic only',dependencyCompatibility:'Independent synthetic dependencies'},execution:{receipt}}];
 const proposed=deliverCandidate(f,candidate);intake(f,proposed);assert.equal(f.paper().phase,'source_awaiting_review');
 const g=setup(t),bad=sourceCandidate(g),foreign=g.put(cleanRelative+'/coverage_work/r0001/c001/private.txt','Sibling private input.');
 bad.inventory.items.at(-1).obligations[0].kind='algorithm';bad.inventory.items.at(-1).obligations[0].dimension='algorithmValidation';refreshBasis(bad);
 const out=g.put(g.paper().workRoot+'/implementation.txt','Fixture output.');
 const badReceipt=g.put(g.paper().workRoot+'/receipt.json',{schemaVersion:1,paperId:'origin',tool:'synthetic',version:'1',command:['synthetic'],workerCount:1,startedAt:'2026-10-29T00:00:00Z',finishedAt:'2026-10-29T00:00:01Z',exitCode:0,inputs:[foreign],outputs:[out]});
 bad.assessments.at(-1).evidence=[{kind:'new',method:'implementation_test',artifacts:[out],mapping:{scope:'Synthetic',conditions:'Synthetic',dependencyCompatibility:'Synthetic'},execution:{receipt:badReceipt}}];
 const delivery=deliverCandidate(g,bad);reject(g,'intake',{agent:worker,ownerFinished:true,candidatePath:delivery.delivery.path},/input|outside|permitted|allow/i);
});

test('binding and actor tampering cannot reach frozen intake or overwrite private evidence',t=>{
 const f=setup(t),candidate=sourceCandidate(f);candidate.sourceBinding=f.proposedBinding;
 const proposed=deliverCandidate(f,candidate);reject(f,'intake',{agent:worker,ownerFinished:true,candidatePath:proposed.delivery.path},/source binding/);
 candidate.sourceBinding=f.paper().sourceEnrollment.sourceBinding;candidate.author='impostor';deliverCandidate(f,candidate);
 reject(f,'intake',{agent:worker,ownerFinished:true,candidatePath:proposed.delivery.path},/author/);
 const state=f.state();state.papers.find(p=>p.paperId==='origin').owner.agent='impostor';f.put(campaignRelative+'/coverage/state.json',canonical(state));
 reject(f,'release',{agent:'impostor',ownerFinished:true,noActiveCalculation:true,reason:'Forbidden actor relabel',supervisor},/worker lacks explicit/);
});

test('source released original worker/reviewer recoveries keep strict schema and binding provenance',t=>{
 const f=setup(t),proposed=deliverCandidate(f),workerProof=release(f,'worker',proposed.delivery);
 reject(f,'recover-intake',{...workerProof,unknownField:true},/unknown fields/);
 reject(f,'recover-intake',{...workerProof,sourceBinding:f.proposedBinding},/Source binding|source binding/);
 f.command('recover-intake',workerProof);assert.equal(f.paper().staged.worker,worker);assign(f,'reviewer',reviewer);
 const reviewed=deliverReview(f,proposed),reviewProof=release(f,'reviewer',reviewed.delivery);f.command('recover-review',reviewProof);
 decide(f,proposed,reviewed);assert.equal(f.invoke('verify',{path:'origin'}).value.coverageComplete,true);
});

test('confirmed release permits a new registered c001 actor without replacing original draft or adoption history',t=>{
 const f=setup(t),proposed=deliverCandidate(f),proof=release(f,'worker',proposed.delivery),enrollment=clone(f.paper().sourceEnrollment);
 assign(f,'worker','synthetic-successor');assert.equal(f.paper().owner.agent,'synthetic-successor');assert.deepEqual(f.paper().sourceEnrollment,enrollment);
 for(const ref of [f.draft,...f.oldDrafts])assert.equal(digest(absolute(f,ref)),ref.sha256);
 reject(f,'recover-intake',proof,/owner|active/);
});

test('adopted reader/batch carries exact supplemental bytes within whole-envelope limits and preserves role privacy',async t=>{
 const f=setup(t,{adopt:false}),oldOpened=await runLegacyReader(f.project,['open','origin','worker']);
 f.command('source-adopt',f.adoptFields);const view=resolveSourceView({root:f.project,scan:f.scan,sourceBinding:f.paper().sourceEnrollment.sourceBinding});
 f.sourceView={...f.scan,resources:view.resources,units:view.units,diagnostics:view.diagnostics};
 const proposed=deliverCandidate(f),opened=await runBatch(f.project,['open','origin','worker',worker,'--candidate',proposed.delivery.path]);
 assert.equal(opened.error,undefined,opened.error);assert.ok(serializedBytes(opened)<=MAX_BATCH_BYTES);assert.notEqual(opened.snapshotKey,oldOpened.snapshotKey);
 const manifestFor=requests=>f.put(f.paper().workRoot+'/batch-manifest-source-v2.json',{schemaVersion:1,paperId:'origin',role:'worker',agent:worker,snapshotKey:opened.snapshotKey,candidatePath:proposed.delivery.path,requests});
 const huge=f.put(f.paper().workRoot+'/long-note.txt','Synthetic UTF8 中文🧪\n'.repeat(900));
 const manifest=manifestFor([{id:'listing',ref:f.binding.supplement},{id:'long',ref:huge}]),before=files(f.project),recovered=new Map();
 let result=await runBatch(f.project,['batch',manifest.path,'--max-bytes','4096']),count=0;
 while(true){assert.equal(result.error,undefined,result.error);assert.ok(serializedBytes(result)<=4096);for(const chunk of result.chunks)recovered.set(chunk.id,(recovered.get(chunk.id)??'')+chunk.chunk);if(result.complete)break;assert.ok(++count<100);result=await runBatch(f.project,['read',manifest.path,'--cursor',result.nextCursor,'--max-bytes','4096']);}
 assert.equal(recovered.get('listing'),fs.readFileSync(absolute(f,f.binding.supplement),'utf8'));assert.equal(recovered.get('long'),fs.readFileSync(absolute(f,huge),'utf8'));assert.ok(count>0);assert.deepEqual(files(f.project),before);
 const privateRef=f.put(cleanRelative+'/coverage_verifications/origin/c001/private.txt','PRIVATE_REVIEW_SENTINEL');
 const forbidden=manifestFor([{id:'private',ref:privateRef}]),denied=await runBatch(f.project,['batch',forbidden.path]);
 assert.ok(denied.error);assert.ok(serializedBytes(denied)<=MAX_BATCH_BYTES);assert.ok(!JSON.stringify(denied).includes('PRIVATE_REVIEW_SENTINEL'));
 const stale=f.put(f.paper().workRoot+'/stale-manifest.json',{schemaVersion:1,paperId:'origin',role:'worker',agent:worker,snapshotKey:oldOpened.snapshotKey,candidatePath:proposed.delivery.path,requests:[{id:'listing',ref:f.binding.supplement}]});
 assert.match((await runBatch(f.project,['batch',stale.path])).error,/stale|snapshot/i);
});
