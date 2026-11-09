import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {canonical, hash} from '../coverage-core.mjs';
import {fixture, installCoverage, copyModuleClosure, candidateFor, reviewFor, decisionFor, objectHash,
  campaignRelative, cleanRelative, read, clone, digest} from './fixtures/context-kit/fixture.mjs';

// Synthetic source/run/stub/state only. Each test has a disjoint checked temp
// root, workerCount=1. Run with --test-concurrency=1; never calls production CLI.
const stage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../architecture/batch-scope-20261029/candidate/coverage.mjs');
const worker = 'synthetic-guard-worker', reviewer = 'synthetic-guard-reviewer', supervisor = 'synthetic-supervisor';
const absolute = (f, ref) => path.resolve(f.project, ref.path);
function setup(t, {prepare = true} = {}) {
  const f = installCoverage(fixture(t));
  for (const name of ['coverage-guard.mjs', 'coverage-scope.mjs', 'coverage-batch.mjs']) copyModuleClosure(f.project, campaignRelative + '/' + name);
  f.put(campaignRelative + '/coverage.mjs', fs.readFileSync(stage));
  f.put(campaignRelative + '/COVERAGE_GUARDS.md', 'Synthetic guarded-authoring guide. Not a scientific approval.');
  const releaseBase = campaignRelative + '/architecture/batch-scope-20261029';
  for(const name of ['BATCH_API.md','SCOPE_API.md'])f.put(releaseBase+'/'+name,'Synthetic immutable '+name+' instructions only.');
  const modules = ['coverage.mjs', 'coverage-guard.mjs', 'coverage-scope.mjs', 'coverage-batch.mjs', 'COVERAGE_GUARDS.md', 'BATCH_API.md', 'SCOPE_API.md'].map(name => {
    const installedName=(['BATCH_API.md','SCOPE_API.md'].includes(name)?releaseBase:campaignRelative)+'/'+name;
    const filename = path.join(f.project,installedName), installed = {path:installedName,sha256:digest(filename)};
    return {name,installed,frozen:f.put(releaseBase+'/release/'+name,fs.readFileSync(filename))};
  });
  f.put(releaseBase+'/release-manifest.json',{schemaVersion:1,releaseId:'batch-scope-20261029',modules});
  f.invoke('init'); if (prepare) f.command('prepare');
  return {...f, scan: prepare ? read(f.paper().scan.path) : null};
}
function activate(f) { return f.command('guard-policy', {supervisor, reason: 'Synthetic future-version cutover only.'}); }
function assign(f, role, agent) { return f.command('assign', {role, agent, freshContext: true, historyInherited: false}); }
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
  const cards = [], alignments = [], scan = f.scan;
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
  return {schemaVersion: 1, paperId: candidate.paperId, revision: candidate.revision, scanSha256: objectHash(scan), candidateSha256: objectHash(candidate), author: candidate.author,
    inventory: {complete: candidate.inventory.complete, missingClaims: [], notes: 'Synthetic full source boundaries explicitly inspected.'}, cards, alignments, legacyRetainedObligationIds: legacy};
}
function scopeReviewFor(f, candidate, contract, review) {
  const evidence = [f.put(f.paper().staged.reviewRoot + '/scope-independent.txt', 'Independent synthetic source-to-target inspection, not constructor output.')];
  return {schemaVersion: 1, paperId: candidate.paperId, revision: candidate.revision, scanSha256: objectHash(f.scan), candidateSha256: objectHash(candidate),
    contractSha256: objectHash(contract), reviewSha256: objectHash(review), reviewerAgent: review.reviewerAgent,
    inventory: {complete: review.inventory.complete, checkedUnlistedSource: true, missingClaims: [], notes: 'Independently inspected synthetic unlisted source and exact targets.', evidence},
    cards: contract.cards.map(card => ({itemId: card.itemId, cardSha256: objectHash(card), verdict: 'aligned', reason: 'Independent synthetic source match.', evidence})),
    entries: contract.alignments.map(row => ({obligationId: row.obligationId, alignmentSha256: objectHash(row), verdict: 'aligned', reason: 'Independent synthetic obligation target match.', evidence})),
    retainedItemIds: [], retainedObligationIds: []};
}
function deliverCandidate(f, candidate = candidateFor(f, f.scan, {author: worker}), options) {
  const delivery = f.put(f.paper().workRoot + '/candidate.json', candidate), contract = scopeFor(f, candidate, options);
  const source = f.put(f.paper().workRoot + '/source-scope.json', contract);
  return {candidate, delivery, contract, source};
}
function intake(f, proposed) { return f.command('intake', {agent: proposed.candidate.author, ownerFinished: true, candidatePath: proposed.delivery.path}); }
function deliverReview(f, proposed, review = reviewFor(f, f.scan, proposed.candidate, {reviewer})) {
  const delivery = f.put(f.paper().staged.reviewRoot + '/review.json', review), scopeReview = scopeReviewFor(f, proposed.candidate, proposed.contract, review);
  const source = f.put(f.paper().staged.reviewRoot + '/scope-review.json', scopeReview);
  return {review, delivery, scopeReview, source};
}
function receiveReview(f, reviewed) { return f.command('review', {agent: reviewed.review.reviewerAgent, ownerFinished: true, reviewPath: reviewed.delivery.path}); }
function decide(f, proposed, reviewed, mutate = () => {}) {
  const decision = decisionFor(f.scan, proposed.candidate, reviewed.review); mutate(decision);
  const ref = f.put(campaignRelative + '/coverage/requests/decision-' + f.state().revision + '.json', decision);
  return f.command('decide', {decisionPath: ref.path});
}
function release(f, role, delivery, {omitScope=false}={}) {
  const paper = f.paper(), actor = role === 'worker' ? worker : reviewer, privateRoot = role === 'worker' ? paper.workRoot : paper.staged.reviewRoot;
  const checkpoint = role === 'worker' ? {schemaVersion: 1, paperId: 'origin', revision: paper.iteration, agent: actor,
    terminalState: 'candidate_frozen_ready_for_independent_review', noActiveCalculation: true, candidate: delivery}
    : {schemaVersion: 1, paperId: 'origin', revision: paper.iteration, reviewerAgent: actor, status: 'review_delivered', noActiveCalculation: true,
      scanSha256: paper.scan.sha256, candidateSha256: paper.staged.candidate.sha256, review: delivery};
  if(paper.guardEnrollment&&!omitScope) {
    const filename=privateRoot+'/'+(role==='worker'?'source-scope.json':'scope-review.json');
    checkpoint[role==='worker'?'sourceScope':'scopeReview']={path:filename,sha256:digest(path.resolve(f.project,filename))};
  }
  const ownerCheckpoint = f.put(privateRoot + '/terminal.json', checkpoint);
  const terminalEvidence = f.put(campaignRelative + '/coverage/requests/terminal-' + role + '.json', {schemaVersion: 1, paperId: 'origin', agent: actor,
    ownerFinished: true, noActiveCalculation: true, supervisor, ownerCheckpoint});
  const result = f.command('release', {agent: actor, ownerFinished: true, noActiveCalculation: true, reason: 'Synthetic natural terminal state.', supervisor, terminalEvidence});
  return {schemaVersion: 1, paperId: 'origin', iteration: paper.iteration, agent: actor, ownerFinished: true, noActiveCalculation: true, supervisor,
    reason: 'Recover exact original synthetic delivery.', releaseOperationId: hash(canonical({command: 'release', request: read(absolute(f, result.request))})),
    releaseRequest: result.request, releaseReceipt: result.value.release, terminalEvidence, ownerCheckpoint, scan: paper.scan,
    order: role === 'worker' ? paper.order : paper.staged.reviewOrder, delivery, candidate: role === 'worker' ? null : paper.staged.candidate};
}

test('policy activation is exact-request idempotent and enrolls never-started ready version without rewriting its order', t => {
  const f = setup(t), order = f.paper().order, bytes = fs.readFileSync(order.path);
  const activation = activate(f); assert.deepEqual(activation.value.legacyExemptions, []);
  const before = files(f.project); assert.equal(f.invoke('guard-policy', activation.request).value.replayed, true); assert.deepEqual(files(f.project), before);
  reject(f, 'guard-policy', {supervisor, reason: 'A distinct policy cannot replace history.'}, /already activated/);
  const assigned = assign(f, 'worker', worker); assert.ok(assigned.value.guardEnrollment);
  assert.deepEqual(fs.readFileSync(order.path), bytes); assert.deepEqual(f.paper().order, order);
  assert.equal(read(f.paper().guardEnrollment.profile.path).iteration, 1);
  assert.equal(read(f.paper().guardEnrollment.profile.path).author, undefined);
});

test('all future prepare versions enroll and the unactivated CLI remains exactly legacy', t => {
  const f = setup(t, {prepare: false}); activate(f); f.command('prepare'); assign(f, 'worker', worker); assert.ok(f.paper().guardEnrollment);
  const g = setup(t); assign(g, 'worker', worker);
  const candidate = candidateFor(g, g.scan, {author: worker}), delivery = g.put(g.paper().workRoot + '/candidate.json', candidate);
  g.command('intake', {agent: worker, ownerFinished: true, candidatePath: delivery.path}); assert.equal(g.paper().staged.guard, undefined);
});

test('in-flight, staged and previously started released versions remain legacy, including late reviewers', t => {
  for (const phase of ['working', 'awaiting_review', 'released']) {
    const f = setup(t); assign(f, 'worker', worker); const proposed = deliverCandidate(f);
    if (phase === 'awaiting_review') intake(f, proposed);
    const recovery = phase === 'released' ? release(f, 'worker', proposed.delivery) : null;
    const result = activate(f); assert.equal(result.value.legacyExemptions[0].iteration, 1);
    if (recovery) f.command('recover-intake', recovery); else if (phase === 'working') intake(f, proposed);
    assign(f, 'reviewer', reviewer); assert.equal(f.paper().guardEnrollment, undefined); assert.equal(f.paper().staged.guard, undefined);
    const review = reviewFor(f, f.scan, proposed.candidate, {reviewer}), delivery = f.put(f.paper().staged.reviewRoot + '/review.json', review);
    f.command('review', {agent: reviewer, ownerFinished: true, reviewPath: delivery.path});
    assert.equal(f.paper().phase, 'review_received');
  }
});

test('missing sidecars and wrong private-root sidecars fail before publication or state mutation', t => {
  const f = setup(t); activate(f); assign(f, 'worker', worker);
  const candidate = candidateFor(f, f.scan, {author: worker}), delivery = f.put(f.paper().workRoot + '/candidate.json', candidate);
  const sibling = f.put(cleanRelative + '/coverage_work/r0001/c001/source-scope.json', scopeFor(f, candidate));
  reject(f, 'intake', {agent: worker, ownerFinished: true, candidatePath: delivery.path}, /ENOENT|no such/i);
  assert.equal(digest(absolute(f, sibling)), sibling.sha256);
  const proposed = deliverCandidate(f, candidate); intake(f, proposed); assign(f, 'reviewer', reviewer);
  const review = reviewFor(f, f.scan, candidate, {reviewer}), reviewDelivery = f.put(f.paper().staged.reviewRoot + '/review.json', review);
  reject(f, 'review', {agent: reviewer, ownerFinished: true, reviewPath: reviewDelivery.path}, /ENOENT|no such/i);
});

test('guarded frozen raw/canonical sidecars survive intake/review/decision; replay detects raw tampering', t => {
  const f = setup(t); activate(f); assign(f, 'worker', worker); const proposed = deliverCandidate(f), result = intake(f, proposed);
  assert.notEqual(proposed.source.sha256, f.paper().staged.guard.contract.sha256, 'Pretty delivery ref and canonical snapshot ref stay distinct');
  assign(f, 'reviewer', reviewer); const reviewed = deliverReview(f, proposed); receiveReview(f, reviewed); decide(f, proposed, reviewed);
  assert.ok(f.paper().latest.guard.scopeReview); assert.equal(f.invoke('verify', {path: 'origin'}).value.coverageComplete, true);
  const before = files(f.project); assert.equal(f.invoke('intake', result.request).value.replayed, true); assert.deepEqual(files(f.project), before);
  f.put(absolute(f, proposed.source), fs.readFileSync(absolute(f, proposed.source)).toString() + ' ');
  assert.match(f.invoke('intake', result.request, false).diagnostic, /hash mismatch/);
  assert.match(f.invoke('verify', {path: 'origin'}, false).diagnostic, /hash mismatch/);
});

test('guarded recoveries retain the exact strict original request schema and actors', t => {
  const f = setup(t); activate(f); assign(f, 'worker', worker); const proposed = deliverCandidate(f), workerRecovery = release(f, 'worker', proposed.delivery);
  const recovered = f.command('recover-intake', workerRecovery); assert.equal(f.paper().staged.worker, worker); assert.ok(f.paper().staged.guard.contract);
  assert.equal(f.invoke('recover-intake', recovered.request).value.replayed, true);
  assign(f, 'reviewer', reviewer); const reviewed = deliverReview(f, proposed), reviewerRecovery = release(f, 'reviewer', reviewed.delivery);
  reject(f, 'recover-review', {...reviewerRecovery, sourceScopePath: 'not-allowed'}, /unknown|fields/);
  f.command('recover-review', reviewerRecovery); decide(f, proposed, reviewed); assert.ok(f.paper().latest.metrics.coverageComplete);
});

test('recovery projection rejects removed, added or tampered additive release references', t => {
  const f = setup(t); activate(f); assign(f, 'worker', worker); const proposed = deliverCandidate(f), proof = release(f,'worker',proposed.delivery);
  const stateFile = path.join(f.campaign,'coverage/state.json'), original = fs.readFileSync(stateFile);
  for(const mutate of [op=>{op.references=op.references.slice(0,2);},op=>{op.references=op.references.slice(0,2);delete op.response.guardReferences;},op=>{op.references.push(op.references.at(-1));},op=>{op.response.guardReferences[0].sha256='0'.repeat(64);}]) {
    const state=JSON.parse(original);mutate(state.operations[proof.releaseOperationId]);f.put(stateFile,canonical(state));
    reject(f,'recover-intake',proof,/guard reference set|hash mismatch/);f.put(stateFile,original);
  }
  f.command('recover-intake',proof);assert.equal(f.paper().phase,'awaiting_review');
});

test('guarded recovery requires original terminal sidecar refs and rejects post-release replacement for either actor', t => {
  for(const role of ['worker','reviewer'])for(const omitScope of [false,true]) {
    const f=setup(t);activate(f);assign(f,'worker',worker);const proposed=deliverCandidate(f);
    let delivery=proposed.delivery,source=proposed.source;
    if(role==='reviewer') {intake(f,proposed);assign(f,'reviewer',reviewer);const reviewed=deliverReview(f,proposed);delivery=reviewed.delivery;source=reviewed.source;}
    const proof=release(f,role,delivery,{omitScope}),command=role==='worker'?'recover-intake':'recover-review';
    if(omitScope)reject(f,command,proof,/terminal checkpoint lacks/);
    else {
      const filename=absolute(f,source),original=fs.readFileSync(filename);f.put(filename,Buffer.concat([original,Buffer.from(' ')]));
      reject(f,command,proof,/hash mismatch/);f.put(filename,original);f.command(command,proof);
    }
  }
});

test('recovery carries the original terminal sidecar seal across subsequent delivery reads for both roles', async t => {
  for(const role of ['worker','reviewer']) {
    const f=setup(t);activate(f);assign(f,'worker',worker);const proposed=deliverCandidate(f);
    let delivery=proposed.delivery,source=proposed.source;
    if(role==='reviewer') {intake(f,proposed);assign(f,'reviewer',reviewer);const reviewed=deliverReview(f,proposed);delivery=reviewed.delivery;source=reviewed.source;}
    const proof=release(f,role,delivery),command=role==='worker'?'recover-intake':'recover-review',request=f.request(proof);
    const sidecar=absolute(f,source),original=fs.readFileSync(sidecar),replacement=JSON.parse(original);replacement.inventory.notes+=' Valid replacement made after original seal check.';
    const trigger=absolute(f,delivery),before=files(f.project),{runCoverage}=await import(pathToFileURL(path.join(f.campaign,'coverage.mjs')).href);
    const originalRead=fs.readFileSync;let changed=false;
    fs.readFileSync=function(filename,...args) {
      if(!changed&&typeof filename==='string'&&path.resolve(filename).toLowerCase()===trigger.toLowerCase()) {changed=true;fs.writeFileSync(sidecar,canonical(replacement));}
      return originalRead.call(this,filename,...args);
    };
    try {await assert.rejects(runCoverage(f.project,[command,request.path]),/hash mismatch/);}
    finally {fs.readFileSync=originalRead;f.put(sidecar,original);}
    assert.ok(changed);assert.deepEqual(files(f.project),before);f.command(command,proof);
  }
});

test('decision cannot accept source-scope blocked obligations and rejection leaves staged snapshot intact', t => {
  const f=setup(t);activate(f);assign(f,'worker',worker);const proposed=deliverCandidate(f);
  proposed.contract.alignments[0].additionalAssumptions=['A new assumption absent from the original claim'];f.put(proposed.source.path,proposed.contract);intake(f,proposed);
  assign(f,'reviewer',reviewer);const review=reviewFor(f,f.scan,proposed.candidate,{reviewer});review.entries[0].verdict='needs_work';
  const reviewed=deliverReview(f,proposed,review);reviewed.scopeReview.entries[0].verdict='needs_work';f.put(reviewed.source.path,reviewed.scopeReview);receiveReview(f,reviewed);
  const bad=f.put(campaignRelative+'/coverage/requests/bad-accepted-id.json',decisionFor(f.scan,proposed.candidate,review));
  reject(f,'decide',{decisionPath:bad.path},/outside independent source-scope approval/);
  decide(f,proposed,reviewed,value=>{value.acceptedObligationIds=value.acceptedObligationIds.slice(1);});assert.equal(f.paper().phase,'assessed');
});

test('immutable release references keep old verify/replay valid after live guide edit but reject new admission', t => {
  const f=setup(t);activate(f);assign(f,'worker',worker);const proposed=deliverCandidate(f),received=intake(f,proposed);
  assign(f,'reviewer',reviewer);const reviewed=deliverReview(f,proposed);receiveReview(f,reviewed);decide(f,proposed,reviewed,value=>{value.inventoryAccepted=false;});
  f.put(campaignRelative+'/COVERAGE_GUARDS.md','A future installed guide edit not activated by this policy.');
  assert.equal(f.invoke('verify',{path:'origin'}).value.inventoryAccepted,false);
  assert.equal(f.invoke('intake',received.request).value.replayed,true);
  // continue verifies old history first, then fails active installed-version
  // admission before creating a new order or modifying the state.
  reject(f,'continue',{},/hash mismatch/);
});

test('source-scope incomplete inventory cannot be accepted even when original inventory review passes', t => {
  const f = setup(t); activate(f); assign(f, 'worker', worker); const proposed = deliverCandidate(f); intake(f, proposed); assign(f, 'reviewer', reviewer);
  const reviewed = deliverReview(f, proposed); reviewed.scopeReview.inventory.complete = false;
  f.put(reviewed.source.path, reviewed.scopeReview); receiveReview(f, reviewed);
  const decision = f.put(campaignRelative + '/coverage/requests/invalid-inventory-decision.json', decisionFor(f.scan, proposed.candidate, reviewed.review));
  reject(f, 'decide', {decisionPath: decision.path}, /inventory.*eligibility/);
  decide(f, proposed, reviewed, value => {value.inventoryAccepted = false;}); assert.equal(f.paper().phase, 'assessed');
});

test('unchanged legacy accepted obligations explicitly migrate without retrospective scope approval or reruns', t => {
  const f = setup(t); assign(f, 'worker', worker);
  const old = candidateFor(f, f.scan, {author: worker}); old.inventory.complete = false; const proposed = deliverCandidate(f, old); intake(f, proposed);
  activate(f); assign(f, 'reviewer', reviewer); const reviewed = deliverReview(f, proposed); receiveReview(f, reviewed); decide(f, proposed, reviewed);
  assert.equal(f.paper().latest.guard, undefined); const predecessor = f.paper().latest.candidate.sha256;
  f.command('continue'); assign(f, 'worker', 'synthetic-next-worker'); assert.ok(f.paper().guardEnrollment);
  const next = clone(old); Object.assign(next, {revision: 2, predecessorSha256: predecessor, author: 'synthetic-next-worker'}); next.inventory.complete = true;
  const ids = next.assessments.map(a => a.obligationId), nextProposed = deliverCandidate(f, next, {legacy: ids}); intake(f, nextProposed);
  assign(f, 'reviewer', 'synthetic-next-reviewer'); const nextReview = reviewFor(f, f.scan, next, {reviewer: 'synthetic-next-reviewer'});
  nextReview.entries = []; nextReview.retainedObligationIds = ids;
  const nextReviewed = deliverReview(f, nextProposed, nextReview); receiveReview(f, nextReviewed); decide(f, nextProposed, nextReviewed);
  assert.equal(f.paper().history.length, 1); assert.deepEqual(read(f.paper().latest.guard.contract.path).legacyRetainedObligationIds, ids);
  assert.equal(f.invoke('verify', {path: 'origin'}).value.coverageComplete, true);
});

test('sidecar edits during the unchanged asynchronous core validator are caught before publishing', async t => {
  const f = setup(t); activate(f); assign(f, 'worker', worker); const proposed = deliverCandidate(f), request = f.request({agent: worker, ownerFinished: true, candidatePath: proposed.delivery.path});
  const sidecar = absolute(f, proposed.source), original = fs.readFileSync(sidecar), artifact = absolute(f, proposed.candidate.assessments[0].evidence[0].artifacts[0]);
  const before = files(f.project), {runCoverage} = await import(pathToFileURL(path.join(f.campaign, 'coverage.mjs')).href);
  const originalRead = fs.readFileSync; let changed = false;
  fs.readFileSync = function(filename, ...args) {
    if (!changed && typeof filename === 'string' && path.resolve(filename).toLowerCase() === artifact.toLowerCase()) {
      changed = true; fs.writeFileSync(sidecar, Buffer.concat([original, Buffer.from(' ')]));
    }
    return originalRead.call(this, filename, ...args);
  };
  try { await assert.rejects(runCoverage(f.project, ['intake', request.path]), /hash mismatch/); }
  finally { fs.readFileSync = originalRead; f.put(sidecar, original); }
  assert.ok(changed); assert.deepEqual(files(f.project), before); assert.equal(f.paper().phase, 'working');
});

test('independent scope-only evidence changes during core review or decide cannot be frozen or accepted', async t => {
  const f=setup(t);activate(f);assign(f,'worker',worker);const proposed=deliverCandidate(f);intake(f,proposed);assign(f,'reviewer',reviewer);const reviewed=deliverReview(f,proposed);
  const evidence=absolute(f,reviewed.scopeReview.inventory.evidence[0]),original=fs.readFileSync(evidence),trigger=absolute(f,proposed.candidate.assessments[0].evidence[0].artifacts[0]);
  const {runCoverage}=await import(pathToFileURL(path.join(f.campaign,'coverage.mjs')).href);
  async function raced(command,fields) {
    const request=f.request(fields),before=files(f.project),originalRead=fs.readFileSync;let changed=false;
    fs.readFileSync=function(filename,...args) {
      if(!changed&&typeof filename==='string'&&path.resolve(filename).toLowerCase()===trigger.toLowerCase()) {changed=true;fs.writeFileSync(evidence,Buffer.concat([original,Buffer.from(' changed')]));}
      return originalRead.call(this,filename,...args);
    };
    try {await assert.rejects(runCoverage(f.project,[command,request.path]),/hash mismatch/);}
    finally {fs.readFileSync=originalRead;f.put(evidence,original);}
    assert.ok(changed);assert.deepEqual(files(f.project),before);
  }
  await raced('review',{agent:reviewer,ownerFinished:true,reviewPath:reviewed.delivery.path});assert.equal(f.paper().phase,'reviewing');
  receiveReview(f,reviewed);
  assert.ok(f.paper().staged.guard.references.some(ref=>ref.sha256===reviewed.scopeReview.inventory.evidence[0].sha256),'Nested independent evidence is persisted in frozen guard refs');
  const decision=f.put(campaignRelative+'/coverage/requests/raced-decision.json',decisionFor(f.scan,proposed.candidate,reviewed.review));
  await raced('decide',{decisionPath:decision.path});assert.equal(f.paper().phase,'review_received');
  decide(f,proposed,reviewed);assert.equal(f.paper().phase,'complete');
});
