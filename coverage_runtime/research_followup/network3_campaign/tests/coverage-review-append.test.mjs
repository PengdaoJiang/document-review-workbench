import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {canonical, hash} from '../coverage-core.mjs';
import {prepareReviewGuard} from '../coverage-guard.mjs';
import {prepareAppendedReview, runReviewAppend, REQUIRED_UPSTREAM} from '../protocols/review-append-v1/coverage-review-append.mjs';
import {fixture, installCoverage, copyModuleClosure, candidateFor, reviewFor, decisionFor, objectHash,
  campaignRelative, cleanRelative, read, clone, digest} from './fixtures/context-kit/fixture.mjs';

// Isolated synthetic evidence only. workerCount=1, --test-concurrency=1.
// Root is the sole suite runner. No real paper content or live state is used.
const MODULE = campaignRelative + '/protocols/review-append-v1/coverage-review-append.mjs';
const RELEASE = campaignRelative + '/architecture/review-append-20261030/release-manifest.json';
const DIAGNOSTIC = campaignRelative + '/coverage/requests/interface-diagnostic-r0162-appended-review-20261030.json';
const worker = 'synthetic-append-worker', reviewer = 'synthetic-append-reviewer', supervisor = 'synthetic-supervisor';
const absolute = (f, ref) => path.resolve(f.project, typeof ref === 'string' ? ref : ref.path);
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function inventory(root) {
  const values = {};
  const visit = (relative = '') => { for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
    const name = path.join(relative, entry.name), full = path.join(root, name);
    if (entry.isDirectory()) visit(name);
    else if (!entry.isSymbolicLink()) values[name] = [digest(full), String(fs.statSync(full, {bigint: true}).mtimeNs)];
  }}; visit(); return values;
}
function exactRef(f, relative) { return {path: relative, sha256: digest(absolute(f, relative))}; }
function scopeFor(f, candidate) {
  const cards = [], alignments = [], scan = f.scan;
  for (const item of candidate.inventory.items) {
    const anchors = item.locators.map((locator, index) => {
      const unit = scan.units.find(u => u.id === locator.unitId), resource = scan.resources.find(r => r.id === unit.resourceId);
      return {id: item.id + ':a' + index, resourceId: resource.id, resourceSha256: resource.sha256, unitId: unit.id,
        ...(resource.type === 'text' ? {start: locator.start, end: locator.end, excerptSha256: locator.excerptSha256,
          quote: fs.readFileSync(resource.path, 'utf8').slice(locator.start, locator.end)} : {semantic: locator.semantic})};
    });
    const claimId = item.id + ':source';
    cards.push({itemId: item.id, itemSha256: objectHash(item), anchors, claims: [{id: claimId, anchorIds: anchors.map(a => a.id),
      statement: 'Synthetic exact source identity only.', kind: Object.hasOwn(anchors[0], 'quote') ? 'identity' : 'visual_observation',
      modality: 'Synthetic assertion', quantifier: 'The displayed synthetic expression', conditions: ['Synthetic domain only'],
      empiricalTarget: {kind: 'not_empirical', description: 'Synthetic source consistency; not empirical.', identityRequirements: []}}]});
    for (const obligation of item.obligations) alignments.push({obligationId: obligation.id, obligationSha256: objectHash(obligation),
      assessmentSha256: objectHash(candidate.assessments.find(a => a.obligationId === obligation.id)), claimIds: [claimId],
      relation: 'original', additionalAssumptions: [], assessedTarget: 'not_empirical', reason: 'Exact original synthetic target.'});
  }
  return {schemaVersion: 1, paperId: candidate.paperId, revision: candidate.revision, scanSha256: objectHash(scan),
    candidateSha256: objectHash(candidate), author: candidate.author,
    inventory: {complete: true, missingClaims: [], notes: 'Synthetic source boundaries individually inspected.'},
    cards, alignments, legacyRetainedObligationIds: []};
}
function scopeReviewFor(f, review, evidence) {
  return {schemaVersion: 1, paperId: 'origin', revision: 1, scanSha256: objectHash(f.scan), candidateSha256: objectHash(f.candidate),
    contractSha256: objectHash(f.contract), reviewSha256: objectHash(review), reviewerAgent: reviewer,
    inventory: {complete: true, checkedUnlistedSource: true, missingClaims: [], notes: 'Independent synthetic source inventory.', evidence: [evidence]},
    cards: f.contract.cards.map(card => ({itemId: card.itemId, cardSha256: objectHash(card), verdict: 'aligned', reason: 'Synthetic source match.', evidence: [evidence]})),
    entries: f.contract.alignments.map(row => ({obligationId: row.obligationId, alignmentSha256: objectHash(row), verdict: 'aligned', reason: 'Synthetic target match.', evidence: [evidence]})),
    retainedItemIds: [], retainedObligationIds: []};
}
function reseal(f, {diagnostic = f.diagnostic, terminal = f.terminal} = {}) {
  const diagnosticRef = f.put(DIAGNOSTIC, canonical(diagnostic));
  const terminalRef = f.put(f.reviewRoot + '/terminal-receipt.json', canonical(terminal));
  const release = {schemaVersion: 1, releaseId: 'review-append-20261030', entry: exactRef(f, MODULE),
    upstream: REQUIRED_UPSTREAM.map(relative => exactRef(f, relative)), diagnostic: diagnosticRef, ownerTerminal: terminalRef};
  const releaseRef = f.put(RELEASE, canonical(release));
  return {diagnosticRef, terminalRef, release, releaseRef};
}
function setup(t, {withReceipt = false} = {}) {
  const f = installCoverage(fixture(t));
  copyModuleClosure(f.project, MODULE);
  for (const name of ['coverage-guard.mjs', 'coverage-scope.mjs', 'coverage-batch.mjs']) copyModuleClosure(f.project, campaignRelative + '/' + name);
  f.put(campaignRelative + '/COVERAGE_GUARDS.md', 'Synthetic version-bound source scope guide.');
  const releaseBase = campaignRelative + '/architecture/batch-scope-20261029';
  for (const name of ['BATCH_API.md', 'SCOPE_API.md']) f.put(releaseBase + '/' + name, 'Synthetic guide only.');
  const modules = ['coverage.mjs', 'coverage-guard.mjs', 'coverage-scope.mjs', 'coverage-batch.mjs', 'COVERAGE_GUARDS.md', 'BATCH_API.md', 'SCOPE_API.md'].map(name => {
    const relative = (['BATCH_API.md', 'SCOPE_API.md'].includes(name) ? releaseBase : campaignRelative) + '/' + name;
    return {name, installed: exactRef(f, relative), frozen: f.put(releaseBase + '/release/' + name, fs.readFileSync(absolute(f, relative)))};
  });
  f.put(releaseBase + '/release-manifest.json', {schemaVersion: 1, releaseId: 'batch-scope-20261029', modules});
  f.invoke('init'); f.command('prepare');
  f.command('guard-policy', {supervisor, reason: 'Synthetic guarded admission before first worker.'});
  f.command('assign', {role: 'worker', agent: worker, freshContext: true, historyInherited: false});
  f.scan = read(f.paper().scan.path);
  f.candidate = candidateFor(f, f.scan, {author: worker});
  if (withReceipt) {
    // Purely synthetic provenance data, never an executed scientific script.
    // An optional receipt accompanies the existing analytic derivation; do not
    // weaken the unchanged prohibition on treating numeric samples as proof.
    const evidence = f.candidate.assessments[0].evidence[0];
    f.constructorArtifact = evidence.artifacts[0];
    f.constructorScript = f.put(f.paper().workRoot + '/synthetic-check.mjs', '// Synthetic input sentinel; never executed.\n');
    f.constructorConfig = f.put(f.paper().workRoot + '/synthetic-config.json', {fixtureOnly: true, sample: 1});
    f.constructorExtraOutput = f.put(f.paper().workRoot + '/synthetic-extra-output.json', {fixtureOnly: true, output: 'independently tracked'});
    f.constructorReceipt = f.put(f.paper().workRoot + '/synthetic-execution-receipt.json', canonical({schemaVersion: 1,
      paperId: 'origin', tool: 'synthetic-fixture-only', version: '1', command: ['not-executed-synthetic-command'], workerCount: 1,
      startedAt: '2026-10-24T00:00:00Z', finishedAt: '2026-10-24T00:00:01Z', exitCode: 0,
      inputs: [f.constructorScript, f.constructorConfig], outputs: [f.constructorArtifact, f.constructorExtraOutput]}));
    evidence.execution = {receipt: f.constructorReceipt};
  }
  const unfinished = f.candidate.assessments.at(-1);
  Object.assign(unfinished, {status: 'internal_gap', outcome: 'partial', summary: 'Synthetic known incomplete obligation', evidence: []});
  f.contract = scopeFor(f, f.candidate);
  const candidateRef = f.put(f.paper().workRoot + '/candidate.json', canonical(f.candidate));
  f.put(f.paper().workRoot + '/source-scope.json', canonical(f.contract));
  f.command('intake', {agent: worker, ownerFinished: true, candidatePath: candidateRef.path});
  f.command('assign', {role: 'reviewer', agent: reviewer, freshContext: true, historyInherited: false});
  f.reviewRoot = f.paper().staged.reviewRoot;
  f.oldReview = reviewFor(f, f.scan, f.candidate, {reviewer});
  const oldNote = f.put(f.reviewRoot + '/scope-independent.txt', 'Independent synthetic original source note.');
  f.oldScope = scopeReviewFor(f, f.oldReview, oldNote);
  f.oldReviewRef = f.put(f.reviewRoot + '/review.json', canonical(f.oldReview));
  f.oldScopeRef = f.put(f.reviewRoot + '/scope-review.json', canonical(f.oldScope));
  f.oldValidation = f.put(f.reviewRoot + '/verification-receipt.json', {synthetic: true, revision: 'initial'});
  f.finalNote = f.put(f.reviewRoot + '/final/independent.txt', 'Independent synthetic corrected descriptive note.');
  f.finalReview = clone(f.oldReview);
  for (const entry of f.finalReview.entries) entry.evidence = [f.finalNote];
  f.changedReasonIds = f.finalReview.entries.slice(0, 2).map(entry => { entry.reason += ' Corrected synthetic description.'; return entry.obligationId; });
  f.finalScope = scopeReviewFor(f, f.finalReview, f.finalNote);
  f.finalReviewRef = f.put(f.reviewRoot + '/final/review.json', canonical(f.finalReview));
  f.finalScopeRef = f.put(f.reviewRoot + '/final/scope-review.json', canonical(f.finalScope));
  f.diagnostic = {paperId: 'origin', iteration: 1, owner: clone(f.paper().owner), registeredReviewRoot: f.reviewRoot,
    stagedCandidate: f.paper().staged.candidate, neutralModule: exactRef(f, campaignRelative + '/coverage-guard.mjs'),
    observedReviewVersions: {'review.json': f.oldReviewRef, 'scope-review.json': f.oldScopeRef,
      'final/review.json': f.finalReviewRef, 'final/scope-review.json': f.finalScopeRef},
    deltaSummary: {changedReasonIds: f.changedReasonIds, verdictsIdentical: true}};
  f.terminal = {schemaVersion: 1, paperId: 'origin', revision: 1, reviewerAgent: reviewer, ownerStartedAt: f.paper().owner.startedAt,
    state: 'reviewer_completed_pending_supervisor_intake', scan: f.paper().scan, candidate: f.paper().staged.candidate,
    reviewOrder: f.paper().staged.reviewOrder, guardOrder: f.paper().guardEnrollment.profile, sourceScope: f.paper().staged.guard.contract,
    deliverables: {review: f.finalReviewRef, scopeReview: f.finalScopeRef, independentNote: f.finalNote},
    initialDrafts: {review: f.oldReviewRef, scopeReview: f.oldScopeRef, verification: f.oldValidation},
    execution: {activeTaskOwnedBackgroundProcesses: [], activeTaskOwnedScientificPids: [], scientificRuns: 0, workerCount: 1,
      finalizer: {endedNaturally: true, observedExitCode: 0}}};
  Object.assign(f, reseal(f));
  f.requestValue = {schemaVersion: 1, expectedRevision: f.state().revision, paperId: 'origin', agent: reviewer,
    ownerFinished: true, noActiveCalculation: true, supervisor, release: f.releaseRef, ownerTerminal: f.terminalRef,
    review: f.finalReviewRef, scopeReview: f.finalScopeRef};
  return f;
}
function putRequest(f, fields = {}, name = 'append-request.json') {
  return f.put(campaignRelative + '/coverage/requests/' + name, canonical({...f.requestValue, ...fields}));
}
async function rejected(f, fields = {}, pattern = /./) {
  const request = putRequest(f, fields), before = inventory(f.project), state = clone(f.state());
  await assert.rejects(() => runReviewAppend(f.project, ['review-append', request.path]), pattern);
  assert.deepEqual(f.state(), state); assert.deepEqual(inventory(f.project), before, 'Failed intake does not publish or mutate files');
}
async function withState(f, change, action) {
  const name = campaignRelative + '/coverage/state.json', saved = fs.readFileSync(absolute(f, name)), state = f.state();
  try { change(state, state.papers.find(p => p.paperId === 'origin')); f.put(name, canonical(state)); await action(); }
  finally { f.put(name, saved); }
}
async function withBytes(f, ref, bytes, action) {
  const saved = fs.readFileSync(absolute(f, ref));
  try { f.put(ref.path ?? ref, bytes); await action(); } finally { f.put(ref.path ?? ref, saved); }
}
async function withSealedVariant(f, change, action) {
  const names = [f.oldReviewRef.path, f.oldScopeRef.path, f.finalReviewRef.path, f.finalScopeRef.path,
    f.terminalRef.path, DIAGNOSTIC, RELEASE];
  const saved = names.map(name => [name, fs.readFileSync(absolute(f, name))]);
  const values = {oldReview: clone(f.oldReview), oldScope: clone(f.oldScope), finalReview: clone(f.finalReview),
    finalScope: clone(f.finalScope), diagnostic: clone(f.diagnostic), terminal: clone(f.terminal)};
  const requestBefore = f.requestValue;
  try {
    change(values);
    values.oldScope.reviewSha256 = objectHash(values.oldReview);
    values.finalScope.reviewSha256 = objectHash(values.finalReview);
    const oldReviewRef = f.put(f.oldReviewRef.path, canonical(values.oldReview));
    const oldScopeRef = f.put(f.oldScopeRef.path, canonical(values.oldScope));
    const finalReviewRef = f.put(f.finalReviewRef.path, canonical(values.finalReview));
    const finalScopeRef = f.put(f.finalScopeRef.path, canonical(values.finalScope));
    values.diagnostic.observedReviewVersions = {'review.json': oldReviewRef, 'scope-review.json': oldScopeRef,
      'final/review.json': finalReviewRef, 'final/scope-review.json': finalScopeRef};
    Object.assign(values.terminal.deliverables, {review: finalReviewRef, scopeReview: finalScopeRef});
    Object.assign(values.terminal.initialDrafts, {review: oldReviewRef, scopeReview: oldScopeRef});
    const sealed = reseal(f, values);
    f.requestValue = {...f.requestValue, release: sealed.releaseRef, ownerTerminal: sealed.terminalRef,
      review: finalReviewRef, scopeReview: finalScopeRef};
    await action(values);
  } finally {
    f.requestValue = requestBefore;
    for (const [name, bytes] of saved) f.put(name, bytes);
  }
}

test('old guard rejects final pair; additive check/intake preserves history and feeds unchanged decide/verify', async t => {
  const f = setup(t), state = f.state(), paper = f.paper();
  assert.throws(() => prepareReviewGuard({root: f.project, state, paper, scan: f.scan, candidate: f.candidate,
    review: f.finalReview, actor: reviewer, previous: null}), /contract\/review hash mismatch/i);
  const request = putRequest(f), before = inventory(f.project), originalPaper = canonical(paper);
  const prepared = await prepareAppendedReview({root: f.project, state, paper, request: f.requestValue});
  prepared.recheck(); assert.equal(prepared.paperId, 'origin'); assert.deepEqual(prepared.review, f.finalReview);
  assert.equal(canonical(paper), originalPaper); assert.deepEqual(inventory(f.project), before);
  const check = await runReviewAppend(f.project, ['check', request.path]);
  assert.equal(check.valid, true); assert.equal(check.scientificAcceptance, false); assert.deepEqual(inventory(f.project), before);
  const result = await runReviewAppend(f.project, ['review-append', request.path]);
  assert.equal(result.phase, 'review_received'); assert.equal(f.paper().owner, null);
  assert.equal(f.paper().staged.reviewRoot, f.reviewRoot); assert.equal(f.paper().staged.worker, worker);
  assert.equal(f.paper().staged.reviewer, reviewer); assert.equal(f.paper().latest, null);
  assert.equal(f.paper().staged.guard.scopeReviewSource.sha256, f.finalScopeRef.sha256);
  assert.deepEqual(read(f.paper().staged.review.path), f.finalReview);
  for (const ref of [f.oldReviewRef, f.oldScopeRef, f.oldValidation, f.finalReviewRef, f.finalScopeRef, f.terminalRef])
    assert.equal(digest(absolute(f, ref)), ref.sha256, 'Original and appended artifacts remain byte-identical');
  const replayBefore = inventory(f.project), replay = await runReviewAppend(f.project, ['review-append', request.path]);
  assert.equal(replay.replayed, true); assert.deepEqual(inventory(f.project), replayBefore);
  const decision = decisionFor(f.scan, f.candidate, f.finalReview);
  const decisionRef = f.put(campaignRelative + '/coverage/requests/decision.json', decision);
  f.command('decide', {decisionPath: decisionRef.path});
  const verified = f.invoke('verify', {path: 'origin'}).value;
  assert.ok(verified); assert.equal(f.paper().phase, 'assessed');
  assert.equal(f.paper().latest.metrics.coverageComplete, false);
  assert.equal(f.paper().latest.decision.sha256, objectHash(decision));
  assert.ok(!decision.acceptedObligationIds.includes(f.candidate.assessments.at(-1).obligationId));
});

test('request role, actor, supervisor, natural completion, release and exact paired refs fail closed', async t => {
  const f = setup(t);
  for (const fields of [
    {agent: worker}, {supervisor: 'foreign-supervisor'}, {ownerFinished: false}, {noActiveCalculation: false},
    {expectedRevision: f.state().revision - 1}, {paperId: 'r0001'}, {unexpected: true},
    {release: {...f.releaseRef, sha256: '0'.repeat(64)}}, {ownerTerminal: {...f.terminalRef, sha256: '0'.repeat(64)}},
    {review: f.oldReviewRef}, {scopeReview: f.oldScopeRef}, {review: {...f.finalReviewRef, sha256: '0'.repeat(64)}}
  ]) await rejected(f, fields);
  const foreign = f.put(cleanRelative + '/coverage_verifications/r0001/c001/final/review.json', canonical(f.finalReview));
  const sibling = f.put(f.reviewRoot + '/other/scope-review.json', canonical(f.finalScope));
  const traversal = {...f.finalReviewRef, path: f.reviewRoot + '/final/../final/review.json'};
  for (const fields of [{review: foreign}, {scopeReview: sibling}, {review: traversal}]) await rejected(f, fields);
});

test('changed owner, role, history, phase, source branch and candidate binding cannot be relabeled', async t => {
  const f = setup(t);
  for (const change of [
    p => { p.owner.agent = 'different-reviewer'; }, p => { p.owner.role = 'worker'; },
    p => { p.owner.startedAt = '2026-01-01T00:00:00Z'; }, p => { p.owner = null; },
    p => { p.phase = 'awaiting_review'; }, p => { p.workerHistory.push(reviewer); },
    p => { p.sourceEnrollment = {}; }, p => { p.iteration = 2; },
    p => { p.staged.candidate.sha256 = 'f'.repeat(64); }, p => { p.staged.reviewRoot += '/other'; }
  ]) await withState(f, (_state, paper) => change(paper), () => rejected(f));
});

test('all preserved/final bindings and prepared references are rechecked without changing scientific files', async t => {
  const f = setup(t);
  for (const ref of [f.oldReviewRef, f.oldScopeRef, f.oldValidation, f.finalReviewRef, f.finalScopeRef, f.finalNote, f.terminalRef,
    f.paper().staged.candidate, f.paper().scan]) {
    await withBytes(f, ref, 'synthetic-tampered-by-test', () => rejected(f));
  }
  const prepared = await prepareAppendedReview({root: f.project, state: f.state(), paper: f.paper(), request: f.requestValue});
  await withBytes(f, f.finalNote, 'changed after preparation', async () => assert.throws(() => prepared.recheck(), /hash|changed|mismatch/i));
  await withState(f, (_state, paper) => { paper.owner.agent = 'owner-changed-after-prepare'; }, async () =>
    assert.throws(() => prepared.recheck(), /owner|state|changed|binding/i));
});

test('writer lock cannot be stolen and output collision cannot overwrite existing publication', async t => {
  const f = setup(t), request = putRequest(f), lock = campaignRelative + '/coverage/.writer.lock';
  const lockRef = f.put(lock, canonical({pid: process.pid, token: 'foreign-synthetic-owner', command: 'synthetic-other-operation'}));
  const locked = inventory(f.project);
  await assert.rejects(() => runReviewAppend(f.project, ['review-append', request.path]), /exist|lock/i);
  assert.deepEqual(inventory(f.project), locked); assert.equal(digest(absolute(f, lockRef)), lockRef.sha256);
  fs.unlinkSync(absolute(f, lock)); // The test created this exact synthetic lock.
  const collision = f.put(campaignRelative + '/coverage/origin/c001/review.json', 'Synthetic immutable conflicting review');
  const before = inventory(f.project), state = clone(f.state());
  await assert.rejects(() => runReviewAppend(f.project, ['review-append', request.path]), /exist|differ|collision|match/i);
  assert.deepEqual(f.state(), state); assert.deepEqual(inventory(f.project), before);
  assert.equal(digest(absolute(f, collision)), collision.sha256);
});

test('re-sealed terminal still requires exact original owner, no pending execution and bounded references', async t => {
  const f = setup(t);
  const foreign = f.put(cleanRelative + '/coverage_verifications/r0001/c001/secret.txt', 'SECRET_FOREIGN_TERMINAL');
  for (const change of [
    terminal => { terminal.reviewerAgent = worker; },
    terminal => { terminal.ownerStartedAt = '2026-01-01T00:00:00Z'; },
    terminal => { terminal.state = 'still_working'; },
    terminal => { terminal.candidate = {...terminal.candidate, sha256: '0'.repeat(64)}; },
    terminal => { terminal.execution.finalizer.endedNaturally = false; },
    terminal => { terminal.execution.finalizer.observedExitCode = 1; },
    terminal => { terminal.execution.activeTaskOwnedScientificPids = [123]; },
    terminal => { terminal.execution.activeTaskOwnedBackgroundProcesses = ['unknown-delivery']; },
    terminal => { terminal.execution.scientificRuns = 1; },
    terminal => { terminal.deliverables.extra = foreign; }
  ]) await withSealedVariant(f, ({terminal}) => change(terminal), async () => {
    const originalRead = fs.readFileSync, observed = [];
    fs.readFileSync = function(name, ...args) {
      if (typeof name === 'string') observed.push(pathKey(name));
      return originalRead.call(this, name, ...args);
    };
    try {
      // Do not include inventory() in the spy: it deliberately inventories the
      // entire synthetic root, including the forbidden sentinel file.
      const request = putRequest(f), before = clone(f.state());
      await assert.rejects(() => runReviewAppend(f.project, ['check', request.path]));
      assert.deepEqual(f.state(), before);
      assert.ok(!observed.includes(pathKey(absolute(f, foreign))), 'Foreign terminal content is rejected before reading');
    } finally { fs.readFileSync = originalRead; }
  });
});

test('a valid new seal cannot bypass standard main/scope validators or authorize a verdict/reason-scope change', async t => {
  const f = setup(t);
  await withSealedVariant(f, ({oldReview, finalReview}) => {
    oldReview.inventory.checkedAllUnits = false; finalReview.inventory.checkedAllUnits = false;
  }, () => rejected(f, {}, /Coverage: review must explicitly inspect all units/i));
  await withSealedVariant(f, ({oldScope, finalScope}) => {
    oldScope.cards[0].verdict = 'needs_work'; finalScope.cards[0].verdict = 'needs_work';
  }, () => rejected(f, {}, /Coverage scope: accept\/retention conflicts/i));
  await withSealedVariant(f, ({finalReview}) => { finalReview.entries[0].verdict = 'needs_work'; },
    () => rejected(f, {}, /verdict/i));
  await withSealedVariant(f, ({diagnostic}) => { diagnostic.deltaSummary.changedReasonIds = []; },
    () => rejected(f, {}, /reason delta/i));
  const foreign = f.put(cleanRelative + '/coverage_verifications/r0001/c001/secret-evidence.txt', 'SECRET_FOREIGN_REVIEW_EVIDENCE');
  for (const change of [
    ({finalReview}) => { finalReview.entries[0].evidence = [foreign]; },
    ({finalScope}) => { finalScope.inventory.evidence = [foreign]; }
  ]) await withSealedVariant(f, change, async () => {
    const request = putRequest(f), originalRead = fs.readFileSync, observed = [];
    fs.readFileSync = function(name, ...args) {
      if (typeof name === 'string') observed.push(pathKey(name));
      return originalRead.call(this, name, ...args);
    };
    try {
      await assert.rejects(() => runReviewAppend(f.project, ['check', request.path]), /evidence|support|root/i);
      assert.ok(!observed.includes(pathKey(absolute(f, foreign))), 'Foreign main/scope evidence is not hashed before its scope check');
    } finally { fs.readFileSync = originalRead; }
  });
});

test('redirected exact final paths are rejected before file contents and restored by test-owned cleanup', async t => {
  const f = setup(t), finalPath = absolute(f, f.reviewRoot + '/final'), moved = absolute(f, f.reviewRoot + '/final-real');
  fs.renameSync(finalPath, moved);
  try {
    try { fs.symlinkSync(moved, finalPath, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip('This Windows account cannot create a synthetic junction: ' + error.code); return;
      }
      throw error;
    }
    const request = putRequest(f), state = clone(f.state()), originalRead = fs.readFileSync, observed = [];
    fs.readFileSync = function(name, ...args) {
      if (typeof name === 'string') observed.push(pathKey(name));
      return originalRead.call(this, name, ...args);
    };
    try {
      await assert.rejects(() => runReviewAppend(f.project, ['check', request.path]), /redirect|path|link/i);
      assert.deepEqual(f.state(), state);
      assert.ok(!observed.includes(pathKey(absolute(f, f.finalReviewRef))));
    } finally { fs.readFileSync = originalRead; }
  } finally {
    if (fs.existsSync(finalPath) && fs.lstatSync(finalPath).isSymbolicLink()) fs.unlinkSync(finalPath);
    fs.renameSync(moved, finalPath);
  }
});

test('request byte seal, requests-root confinement, bounded CLI and replay references remain enforced', async t => {
  const f = setup(t);
  const noncanonical = f.put(campaignRelative + '/coverage/requests/noncanonical.json', f.requestValue);
  await assert.rejects(() => runReviewAppend(f.project, ['check', noncanonical.path]), /canonical/i);
  const outside = f.put(f.reviewRoot + '/outside-request.json', canonical(f.requestValue));
  await assert.rejects(() => runReviewAppend(f.project, ['check', outside.path]), /root|path/i);
  const request = putRequest(f), cli = f.execute(MODULE, ['check', request.path]);
  assert.equal(cli.stderr, ''); assert.equal(cli.stdout.trim().split('\n').length, 1);
  assert.ok(Buffer.byteLength(cli.stdout) <= 8192); assert.equal(cli.value.valid, true);
  await runReviewAppend(f.project, ['review-append', request.path]);
  const state = clone(f.state());
  await withBytes(f, f.oldValidation, 'tampered retained verification', async () => {
    await assert.rejects(() => runReviewAppend(f.project, ['review-append', request.path]), /hash|mismatch/i);
    assert.deepEqual(f.state(), state);
  });
});

test('validated constructor evidence remains sealed through recheck and commit, including direct receipt inputs and outputs', async t => {
  const f = setup(t, {withReceipt: true});
  const prepared = await prepareAppendedReview({root: f.project, state: f.state(), paper: f.paper(), request: f.requestValue});
  const evidenceRefs = [f.constructorArtifact, f.constructorReceipt, f.constructorScript, f.constructorConfig, f.constructorExtraOutput];
  for (const ref of evidenceRefs) {
    assert.ok(prepared.references.some(known => pathKey(absolute(f, known)) === pathKey(absolute(f, ref)) && known.sha256 === ref.sha256),
      'Every exact, already-validated constructor artifact/receipt/input/output is in the final recheck set');
    await withBytes(f, ref, 'Synthetic evidence changed after original validators succeeded', async () => {
      const before = inventory(f.project), state = clone(f.state());
      assert.throws(() => prepared.recheck(), /hash|changed|mismatch/i);
      assert.throws(() => prepared.commit(), /hash|changed|mismatch/i);
      assert.deepEqual(f.state(), state);
      assert.deepEqual(inventory(f.project), before, 'Failed post-validation seal does not publish partial review/scope/proof');
      for (const name of ['review.json', 'scope-review.json', 'append-review-proof.json'])
        assert.equal(fs.existsSync(absolute(f, campaignRelative + '/coverage/origin/c001/' + name)), false);
    });
  }
  prepared.recheck();
});
