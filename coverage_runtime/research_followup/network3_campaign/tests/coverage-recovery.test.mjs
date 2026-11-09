import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {canonical, hash} from '../coverage-core.mjs';
import {fixture, installCoverage, candidateFor, reviewFor, decisionFor, campaignRelative, cleanRelative, read, clone, digest} from './fixtures/context-kit/fixture.mjs';

// Every source/run/stub/ledger is synthetic and lives in fixture's checked temp root.
// Only neutral staged code is copied from this repository. Run with one test worker.
const here = path.dirname(fileURLToPath(import.meta.url));
const staged = path.resolve(here, '../architecture/released-owner-20261025/candidate');
const worker = 'synthetic-worker-c001', reviewer = 'synthetic-reviewer-c001';
const supervisor = 'synthetic-supervisor';
const absolute = (f, ref) => path.resolve(f.project, ref.path);
const statePath = f => path.join(f.campaign, 'coverage/state.json');

function files(root) {
  const result = {};
  function visit(relative = '') {
    for (const item of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const next = path.join(relative, item.name);
      if (item.isDirectory()) visit(next);
      else result[next.replaceAll('\\', '/')] = digest(path.join(root, next));
    }
  }
  visit(); return result;
}
function setup(t) {
  const f = installCoverage(fixture(t));
  for (const name of ['coverage.mjs', 'coverage-recovery.mjs']) {
    assert.ok(fs.existsSync(path.join(staged, name)), 'Root must stage implementation before this test suite runs: ' + name);
    f.put(campaignRelative + '/' + name, fs.readFileSync(path.join(staged, name)));
  }
  f.invoke('init'); f.command('prepare');
  return {...f, scan: read(f.paper().scan.path)};
}
function assign(f, role, agent) { return f.command('assign', {role, agent, freshContext: true, historyInherited: false}); }
function candidateDelivery(f, mutate = () => {}) {
  const candidate = candidateFor(f, f.scan, {author: worker}); mutate(candidate);
  // Raw delivery may be pretty JSON; only the formally received copy is canonicalized.
  const delivery = f.put(f.paper().workRoot + '/candidate.json', candidate);
  return {candidate, delivery};
}
function releaseDelivery(f, role, delivery, {checkpointChange = () => {}, witnessChange = () => {}} = {}) {
  const paper = f.paper(), actor = role === 'worker' ? worker : reviewer;
  const privateRoot = role === 'worker' ? paper.workRoot : paper.staged.reviewRoot;
  const checkpoint = role === 'worker'
    ? {schemaVersion: 1, paperId: 'origin', revision: paper.iteration, agent: actor,
      terminalState: 'candidate_frozen_ready_for_independent_review', noActiveCalculation: true, candidate: delivery}
    : {schemaVersion: 1, paperId: 'origin', revision: paper.iteration, reviewerAgent: actor,
      status: 'review_delivered', noActiveCalculation: true, scanSha256: paper.scan.sha256,
      candidateSha256: paper.staged.candidate.sha256, review: delivery};
  checkpointChange(checkpoint);
  const ownerCheckpoint = f.put(privateRoot + '/terminal.json', checkpoint);
  const witness = {schemaVersion: 1, paperId: 'origin', agent: actor, ownerFinished: true,
    noActiveCalculation: true, supervisor, ownerCheckpoint,
    confirmation: 'Synthetic natural completion observed; no timeout or active computation.'};
  witnessChange(witness);
  const terminalEvidence = f.put(campaignRelative + '/coverage/requests/terminal-' + role + '.json', witness);
  const release = f.command('release', {agent: actor, ownerFinished: true, noActiveCalculation: true,
    reason: 'Synthetic confirmed graceful checkpoint; preserve pending delivery.', supervisor, terminalEvidence});
  const releaseRequest = release.request;
  const releaseOperationId = hash(canonical({command: 'release', request: read(absolute(f, releaseRequest))}));
  const request = {schemaVersion: 1, paperId: 'origin', iteration: paper.iteration, agent: actor,
    ownerFinished: true, noActiveCalculation: true, supervisor,
    reason: 'Receive exact original completed delivery after safe release; no scientific acceptance.',
    releaseOperationId, releaseRequest, releaseReceipt: release.value.release, terminalEvidence, ownerCheckpoint,
    scan: paper.scan, order: role === 'worker' ? paper.order : paper.staged.reviewOrder,
    delivery, candidate: role === 'worker' ? null : paper.staged.candidate};
  return {request, release, checkpoint, witness, role, actor, delivery};
}
function workerFixture(t, {candidateChange, ...releaseOptions} = {}) {
  const f = setup(t); assign(f, 'worker', worker);
  const {candidate, delivery} = candidateDelivery(f, candidateChange);
  return {...f, candidate, proof: releaseDelivery(f, 'worker', delivery, releaseOptions)};
}
function reviewFixture(t, {reviewChange = () => {}, ...releaseOptions} = {}) {
  const f = setup(t); assign(f, 'worker', worker);
  const {candidate, delivery} = candidateDelivery(f);
  f.command('intake', {agent: worker, ownerFinished: true, candidatePath: delivery.path});
  assign(f, 'reviewer', reviewer);
  const review = reviewFor(f, f.scan, candidate, {reviewer}); reviewChange(review, candidate);
  const reviewDelivery = f.put(f.paper().staged.reviewRoot + '/review.json', review);
  return {...f, candidate, review, proof: releaseDelivery(f, 'reviewer', reviewDelivery, releaseOptions)};
}
function reject(f, command, fields, pattern = /Error|Coverage|recover|release/i) {
  const request = f.request(fields), before = files(f.project);
  const result = f.invoke(command, request, false);
  assert.match(result.diagnostic, pattern);
  assert.deepEqual(files(f.project), before, 'Rejected recovery must not mutate any pre-existing file or leave outputs/locks');
  return result;
}
function mutateState(f, mutate) {
  const original = fs.readFileSync(statePath(f));
  const value = JSON.parse(original); mutate(value);
  f.put(statePath(f), canonical(value));
  return () => f.put(statePath(f), original);
}

test('released original worker and reviewer deliveries are ingested without reassignment; decision remains separate and replay is stable', t => {
  const f = workerFixture(t), sourceBefore = digest(absolute(f, f.proof.delivery));
  const historyBefore = clone(f.paper().workerHistory), releaseCount = Object.keys(f.state().operations).length;
  const intake = f.command('recover-intake', f.proof.request);
  assert.equal(f.paper().phase, 'awaiting_review'); assert.equal(f.paper().owner, null);
  assert.equal(f.paper().staged.worker, worker); assert.equal(read(f.paper().staged.candidate.path).author, worker);
  assert.deepEqual(f.paper().workerHistory, historyBefore); assert.equal(f.paper().latest, null);
  assert.equal(Object.keys(f.state().operations).length, releaseCount + 1, 'No synthetic fresh assignment is inserted');
  assert.equal(digest(absolute(f, f.proof.delivery)), sourceBefore);
  const afterIntake = files(f.project), repeatedIntake = f.invoke('recover-intake', intake.request).value;
  assert.equal(repeatedIntake.replayed, true); assert.deepEqual(files(f.project), afterIntake);

  assign(f, 'reviewer', reviewer);
  const review = reviewFor(f, f.scan, f.candidate, {reviewer});
  const delivery = f.put(f.paper().staged.reviewRoot + '/review.json', review);
  const proof = releaseDelivery(f, 'reviewer', delivery);
  const result = f.command('recover-review', proof.request);
  assert.equal(f.paper().phase, 'review_received'); assert.equal(f.paper().owner, null);
  assert.equal(f.paper().staged.reviewer, reviewer); assert.equal(read(f.paper().staged.review.path).reviewerAgent, reviewer);
  assert.equal(f.paper().latest, null, 'Review intake cannot create a scientific decision or metrics');
  const decision = f.put(campaignRelative + '/coverage/requests/decision.json', decisionFor(f.scan, f.candidate, review));
  f.command('decide', {decisionPath: decision.path});
  assert.equal(f.paper().phase, 'complete'); assert.ok(f.paper().latest.metrics.coverageComplete);
  const beforeReplay = files(f.project), accepted = clone(f.paper().latest);
  assert.equal(f.invoke('recover-review', result.request).value.replayed, true);
  assert.equal(f.invoke('recover-intake', intake.request).value.replayed, true);
  assert.deepEqual(f.paper().latest, accepted); assert.deepEqual(files(f.project), beforeReplay);
});

test('recovery request is explicit and binds original release request, operation, actor, version, scan and order', t => {
  const f = workerFixture(t), request = f.proof.request;
  const changes = [
    ['schemaVersion', value => {value.schemaVersion = 2;}],
    ['missing proof', value => {delete value.releaseRequest;}],
    ['fresh assignment spoof', value => {value.freshContext = true;}],
    ['actor', value => {value.agent = 'different-actor';}],
    ['iteration', value => {value.iteration++;}],
    ['owner unfinished', value => {value.ownerFinished = false;}],
    ['active calculation', value => {value.noActiveCalculation = false;}],
    ['supervisor absent', value => {value.supervisor = '';}],
    ['wrong operation', value => {value.releaseOperationId = '0'.repeat(64);}],
    ['release hash', value => {value.releaseReceipt.sha256 = '0'.repeat(64);}],
    ['request hash', value => {value.releaseRequest.sha256 = '0'.repeat(64);}],
    ['terminal hash', value => {value.terminalEvidence.sha256 = '0'.repeat(64);}],
    ['checkpoint hash', value => {value.ownerCheckpoint.sha256 = '0'.repeat(64);}],
    ['scan hash', value => {value.scan.sha256 = '0'.repeat(64);}],
    ['order hash', value => {value.order.sha256 = '0'.repeat(64);}],
    ['delivery hash', value => {value.delivery.sha256 = '0'.repeat(64);}],
    ['worker candidate field', value => {value.candidate = value.delivery;}]
  ];
  for (const [label, change] of changes) {
    const altered = clone(request); change(altered);
    const result = reject(f, 'recover-intake', altered);
    assert.ok(result.diagnostic.length, label);
  }
  reject(f, 'recover-intake', {...request, expectedRevision: f.state().revision - 1}, /Stale expectedRevision/);
  assert.equal(f.paper().owner, null); assert.equal(f.paper().phase, 'ready');
});

test('release ledger history cannot be fabricated or superseded by a later same-paper owner, while unrelated revision progress is allowed', t => {
  const f = workerFixture(t), request = f.proof.request;
  const mutations = [
    value => {delete value.operations[request.releaseOperationId];},
    value => {value.operations[request.releaseOperationId].response.revision--;},
    value => {value.operations[request.releaseOperationId].response.paperId = 'r0001';},
    value => {value.operations[request.releaseOperationId].references = [];},
    value => {const op = Object.values(value.operations).find(x => x.response.owner?.agent === worker); op.response.owner.startedAt = '1970-01-01T00:00:00Z';}
  ];
  for (const mutate of mutations) {
    const restore = mutateState(f, mutate);
    try { reject(f, 'recover-intake', request); } finally { restore(); }
  }
  const otherState = f.state(); otherState.papers.find(p => p.paperId === 'r0001').phase = 'ready';
  f.put(statePath(f), canonical(otherState));
  f.command('assign', {paperId: 'r0001', role: 'worker', agent: 'other-paper-worker', freshContext: true, historyInherited: false});
  assert.ok(f.state().revision > f.proof.release.value.revision);
  f.command('recover-intake', request);
  assert.equal(f.paper().phase, 'awaiting_review');
  assert.equal(f.state().papers.find(p => p.paperId === 'r0001').owner.agent, 'other-paper-worker');

  const g = workerFixture(t);
  assign(g, 'worker', 'successor-worker');
  reject(g, 'recover-intake', g.proof.request, /owner|boundary|phase/i);
  const witness = g.put(campaignRelative + '/coverage/requests/successor-terminal.json', {fixtureOnly: true, ownerFinished: true});
  g.command('release', {agent: 'successor-worker', ownerFinished: true, noActiveCalculation: true, reason: 'Synthetic successor stopped.', supervisor, terminalEvidence: witness});
  assert.equal(g.paper().owner, null);
  reject(g, 'recover-intake', g.proof.request, /latest|recent|subsequent|interven|mutation|supersed/i);
});

test('uncompleted or falsely identified owner checkpoint/witness is not recoverable even after normal release', t => {
  const cases = [
    {checkpointChange: x => {x.terminalState = 'draft_incomplete';}},
    {checkpointChange: x => {x.noActiveCalculation = false;}},
    {checkpointChange: x => {x.agent = 'impostor';}},
    {checkpointChange: x => {x.revision = 2;}},
    {witnessChange: x => {x.ownerFinished = false;}},
    {witnessChange: x => {x.noActiveCalculation = false;}},
    {witnessChange: x => {x.paperId = 'r0001';}},
    {witnessChange: x => {x.agent = 'impostor';}}
  ];
  for (const options of cases) {
    const f = workerFixture(t, options);
    reject(f, 'recover-intake', f.proof.request);
  }
  const unfinishedReview = reviewFixture(t, {checkpointChange: x => {x.status = 'partial_review';}});
  reject(unfinishedReview, 'recover-review', unfinishedReview.proof.request);
});

test('proofs and deliveries cannot cross private/version/ledger roots or use path aliases and stale bytes', t => {
  const f = workerFixture(t), request = f.proof.request;
  const copiedDelivery = f.put(cleanRelative + '/coverage_work/r0001/c001/candidate.json', fs.readFileSync(absolute(f, request.delivery)));
  const copiedCheckpoint = f.put(cleanRelative + '/coverage_work/origin/c002/terminal.json', fs.readFileSync(absolute(f, request.ownerCheckpoint)));
  const copiedRelease = f.put(campaignRelative + '/coverage/requests/copied-release.json', fs.readFileSync(absolute(f, request.releaseReceipt)));
  const copiedRequest = f.put('synthetic-authority/copied-release-request.json', fs.readFileSync(absolute(f, request.releaseRequest)));
  for (const fields of [{delivery: copiedDelivery}, {ownerCheckpoint: copiedCheckpoint}, {releaseReceipt: copiedRelease}, {releaseRequest: copiedRequest},
    {delivery: {...request.delivery, path: request.delivery.path.replace('/candidate.json', '/../c001/candidate.json')}}]) {
    reject(f, 'recover-intake', {...clone(request), ...fields});
  }
  for (const target of [request.releaseRequest, request.releaseReceipt, request.terminalEvidence, request.ownerCheckpoint, request.delivery]) {
    const filename = absolute(f, target), bytes = fs.readFileSync(filename);
    f.put(filename, Buffer.concat([bytes, Buffer.from(' ')]));
    try { reject(f, 'recover-intake', request, /hash|canonical/i); }
    finally { f.put(filename, bytes); }
  }
  assert.equal(f.paper().phase, 'ready');
});

test('the original scientific validators still reject incomplete candidate and non-independent review; historical constructors remain excluded', t => {
  const badCandidate = workerFixture(t, {candidateChange: c => c.assessments.pop()});
  reject(badCandidate, 'recover-intake', badCandidate.proof.request, /assessment|cover|obligation/i);

  const incompleteReview = reviewFixture(t, {reviewChange: r => r.entries.pop()});
  reject(incompleteReview, 'recover-review', incompleteReview.proof.request, /coverage|obligation|exact/i);

  const dependentReview = reviewFixture(t, {reviewChange: (r, c) => {r.entries[0].evidence = clone(c.assessments[0].evidence[0].artifacts);}});
  reject(dependentReview, 'recover-review', dependentReview.proof.request, /independent|evidence/i);

  const historical = reviewFixture(t);
  const restore = mutateState(historical, state => {state.papers.find(p => p.paperId === 'origin').workerHistory.push(reviewer);});
  try { reject(historical, 'recover-review', historical.proof.request, /histor|constructor|worker|independent/i); }
  finally { restore(); }
  const falseBinding = clone(historical.proof.request); falseBinding.candidate.sha256 = '0'.repeat(64);
  reject(historical, 'recover-review', falseBinding);
});

test('writer ownership is not stolen and conflicting immutable files cannot be overwritten', t => {
  const f = workerFixture(t), lock = f.put(campaignRelative + '/coverage/.writer.lock', canonical({pid: 123456789, token: 'foreign-owned', command: 'fixture-active'}));
  reject(f, 'recover-intake', f.proof.request, /EEXIST|lock/i);
  assert.equal(digest(absolute(f, lock)), lock.sha256);
  // This exact fixture-owned lock is removed only to test the next independent condition.
  const lockPath = absolute(f, lock); assert.equal(path.dirname(lockPath), path.join(f.campaign, 'coverage')); fs.unlinkSync(lockPath);
  const target = f.put(campaignRelative + '/coverage/origin/c001/candidate.json', 'PREEXISTING_CONFLICT_MUST_SURVIVE');
  reject(f, 'recover-intake', f.proof.request, /Conflicting immutable/i);
  assert.equal(digest(absolute(f, target)), target.sha256); assert.equal(f.paper().phase, 'ready');

  const g = reviewFixture(t), reviewTarget = g.put(campaignRelative + '/coverage/origin/c001/review.json', 'PREEXISTING_REVIEW_MUST_SURVIVE');
  reject(g, 'recover-review', g.proof.request, /Conflicting immutable/i);
  assert.equal(digest(absolute(g, reviewTarget)), reviewTarget.sha256); assert.equal(g.paper().phase, 'awaiting_review');
});

test('proof changes during the original validator are rechecked before publishing or ledger mutation', async t => {
  const f = workerFixture(t), request = f.request(f.proof.request), checkpoint = absolute(f, f.proof.request.ownerCheckpoint);
  const originalCheckpoint = fs.readFileSync(checkpoint), before = files(f.project);
  const artifact = absolute(f, f.candidate.assessments[0].evidence[0].artifacts[0]);
  const {runCoverage} = await import(pathToFileURL(path.join(f.campaign, 'coverage.mjs')).href);
  const originalRead = fs.readFileSync; let changed = false;
  fs.readFileSync = function(filename, ...args) {
    if (!changed && typeof filename === 'string' && path.resolve(filename).toLowerCase() === artifact.toLowerCase()) {
      changed = true; fs.writeFileSync(checkpoint, Buffer.concat([originalCheckpoint, Buffer.from(' ')]));
    }
    return originalRead.call(this, filename, ...args);
  };
  try { await assert.rejects(runCoverage(f.project, ['recover-intake', request.path]), /hash|changed|stale/i); }
  finally { fs.readFileSync = originalRead; f.put(checkpoint, originalCheckpoint); }
  assert.ok(changed, 'Mutation was injected while the existing scientific validator read actual candidate evidence');
  assert.deepEqual(files(f.project), before); assert.equal(f.paper().phase, 'ready');
});
