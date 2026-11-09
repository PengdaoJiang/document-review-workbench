import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {runReader} from '../coverage-reader.mjs';
import * as core from '../coverage-core.mjs';
import {fixture, installCoverage, copyModuleClosure, candidateFor, reviewFor, decisionFor,
  refreshBasis, objectHash, campaignRelative, cleanRelative, read, clone, digest} from './fixtures/context-kit/fixture.mjs';

// Synthetic inputs only, one temporary project and one writer per test. Runtime
// fixtures declare workerCount=1; run this suite with --test-concurrency=1.
// The reader gets no production paper/state/evidence and must never write files.
const MAX_RESPONSE_BYTES = 16384;
const kinds = ['items', 'obligations', 'evidence', 'resources', 'units', 'diagnostics', 'delta', 'bindings', 'claims', 'documents'];
const privateSentinel = 'PRIVATE_REVIEW_BODY_READER_MUST_NEVER_PROJECT';
const otherPaperSentinel = 'SIBLING_RESULT_READER_MUST_NEVER_READ';
const astralText = '条件α：🧪恒等式成立；e\u0301，限制与反例。';

function inventory(directory) {
  const files = {};
  function visit(relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, relative), {withFileTypes: true})) {
      const name = path.join(relative, entry.name), file = path.join(directory, name);
      if (entry.isDirectory()) visit(name);
      else files[name.replaceAll('\\', '/')] = {sha256: digest(file), mtimeNs: String(fs.statSync(file, {bigint: true}).mtimeNs)};
    }
  }
  visit(); return files;
}

async function captureReads(action) {
  const original = fs.readFileSync, reads = [];
  fs.readFileSync = function (filename, ...args) {
    if (typeof filename === 'string') reads.push(path.resolve(filename).toLowerCase());
    return original.call(this, filename, ...args);
  };
  try { return {value: await action(), reads}; }
  finally { fs.readFileSync = original; }
}

function assertBounded(value) {
  assert.ok(Buffer.byteLength(JSON.stringify(value) + '\n', 'utf8') <= MAX_RESPONSE_BYTES,
    'Every serialized response, including metadata and newline, is bounded to 16 KiB');
  assert.equal(value.schemaVersion, 1);
  return value;
}

function readerFixture(t, options = {}) {
  const base = fixture(t, options);
  const oldReview = read(path.resolve(base.project, base.firstPass.review.path));
  oldReview.privateRetainedTests = {body: privateSentinel};
  base.firstPass.review = base.put(base.firstPass.review.path, oldReview);
  const acceptance = read(path.resolve(base.project, base.firstPass.acceptance.path));
  acceptance.reviewSha256 = base.firstPass.review.sha256;
  base.firstPass.acceptance = base.put(base.firstPass.acceptance.path, acceptance);
  const f = installCoverage(base);
  copyModuleClosure(f.project, campaignRelative + '/coverage-reader.mjs');
  f.invoke('init'); f.command('prepare');
  const scan = read(f.paper().scan.path);
  const reader = async (...argv) => assertBounded(await runReader(f.project, argv));
  return {...f, scan, reader};
}

function assignWorker(f, agent = 'synthetic-worker-c001') {
  f.command('assign', {role: 'worker', agent, freshContext: true, historyInherited: false});
  return agent;
}

function proposed(f, {large = false, incomplete = false} = {}) {
  const author = assignWorker(f), candidate = candidateFor(f, f.scan, {author});
  if (large) {
    candidate.inventory.items[0].text = astralText.repeat(1900);
    candidate.inventory.items[0].conditions = [astralText.repeat(900), 'x is real; this condition is never abbreviated as scientific evidence'];
    candidate.inventory.items[0].obligations[0].statement = astralText.repeat(1100);
    candidate.inventory.items[0].obligations[0].successCriterion = astralText.repeat(700);
    const shared = clone(candidate.assessments[0].evidence[0]);
    shared.mapping.scope = astralText.repeat(1400);
    shared.mapping.conditions = astralText.repeat(750);
    shared.mapping.dependencyCompatibility = astralText.repeat(800);
    for (const assessment of candidate.assessments) assessment.evidence = [clone(shared)];
    candidate.assessments[0].summary = astralText.repeat(1500);
    candidate.assessments[0].limitations = [astralText.repeat(1200), 'A finite synthetic check does not prove the general original proposition'];
  }
  if (incomplete) {
    candidate.inventory.complete = false;
    Object.assign(candidate.assessments[3], {status: 'internal_gap', outcome: 'partial', summary: 'Only a proper subset is checked', evidence: []});
    const assessment = candidate.assessments[4];
    Object.assign(assessment, {status: 'external_blocked', outcome: 'inconclusive', summary: 'The synthetic original data object is unavailable', evidence: [],
      blocker: {missing: 'Synthetic external data object', affectedObligations: [assessment.obligationId],
        attemptedAlternatives: ['Checked the bound Dot appendix', 'Checked same-paper accepted public evidence'],
        whyExternal: 'The object was never included by its external producer', releaseCondition: 'The producer supplies the original version with provenance'}});
  }
  refreshBasis(candidate);
  const candidateRef = f.put(f.paper().workRoot + '/candidate.json', candidate);
  return {candidate, candidateRef, worker: author};
}

async function pages(f, opened, kind, candidateRef = null, role = opened.role, limit = 3) {
  const records = [], offsets = new Set();
  for (let offset = 0; offset !== null;) {
    assert.ok(!offsets.has(offset), 'Pagination must progress'); offsets.add(offset);
    const response = await f.reader('list', 'origin', role, opened.snapshotKey, kind, String(offset), String(limit),
      ...(candidateRef ? ['--candidate', candidateRef.path] : []));
    assert.equal(response.snapshotKey, opened.snapshotKey);
    assert.equal(response.total, opened.counts[kind]);
    assert.equal(response.offset, offset);
    assert.ok(response.records.length <= limit);
    if (response.nextOffset !== null) assert.equal(response.nextOffset, offset + response.records.length);
    records.push(...response.records); offset = response.nextOffset;
  }
  assert.equal(records.length, opened.counts[kind]);
  assert.equal(new Set(records.map(value => value.key)).size, records.length, kind + ' pages cannot repeat identities');
  return records;
}

async function completeRead(f, opened, kind, key, candidateRef = null, length = 2048) {
  let text = '', first;
  for (let offset = 0; offset !== null;) {
    const response = await f.reader('read', 'origin', opened.role, opened.snapshotKey, kind, key, String(offset), String(length),
      ...(candidateRef ? ['--candidate', candidateRef.path] : []));
    first ??= response;
    assert.equal(response.offset, offset);
    assert.equal(response.end, offset + response.chunk.length, 'Ranges use JS UTF-16 code units, not UTF-8 bytes');
    assert.equal(response.sha256, first.sha256);
    assert.equal(response.utf16Length, first.utf16Length);
    assert.equal(response.utf8Bytes, first.utf8Bytes);
    assert.ok(response.chunk.length > 0 || response.complete, 'A bounded continuation cannot stall');
    assert.ok(!/^[\uDC00-\uDFFF]/u.test(response.chunk), 'No continuation starts inside a surrogate pair');
    assert.ok(!/[\uD800-\uDBFF]$/u.test(response.chunk), 'No continuation ends inside a surrogate pair');
    text += response.chunk;
    if (response.nextOffset !== null) assert.equal(response.nextOffset, response.end);
    else assert.equal(response.complete, true);
    offset = response.nextOffset;
  }
  assert.equal(text.length, first.utf16Length);
  assert.equal(Buffer.byteLength(text, 'utf8'), first.utf8Bytes);
  assert.equal(core.hash(text), first.sha256, 'All bounded chunks reconstruct the exact complete hash-bound value');
  return {text, value: first.encoding === 'canonical-json' ? JSON.parse(text) : text, descriptor: first};
}

async function acceptedSnapshot(f, prepared) {
  const {candidate, candidateRef, worker} = prepared;
  f.command('intake', {agent: worker, ownerFinished: true, candidatePath: candidateRef.path});
  const reviewer = 'synthetic-reviewer-c001';
  f.command('assign', {role: 'reviewer', agent: reviewer, freshContext: true, historyInherited: false});
  const review = reviewFor(f, f.scan, candidate, {reviewer});
  const reviewRef = f.put(f.paper().staged.reviewRoot + '/review.json', review);
  f.command('review', {agent: reviewer, ownerFinished: true, reviewPath: reviewRef.path});
  const decision = decisionFor(f.scan, candidate, review);
  const decisionRef = f.put(campaignRelative + '/coverage/requests/decision-c001.json', decision);
  f.command('decide', {decisionPath: decisionRef.path});
  return {review, decision, snapshot: f.paper().latest};
}

test('all reader directories paginate without loss or duplication and every response stays within 16 KiB', async t => {
  const mainText = 'Synthetic identity $x=x$.\n\n' + astralText.repeat(160) + '\n\n' +
    Array.from({length: 43}, (_, i) => 'Synthetic paragraph ' + i + ' $z_' + i + '=z_' + i + '$.').join('\n\n') + '\n';
  const f = readerFixture(t, {mainText}), {candidate, candidateRef} = proposed(f);
  const before = inventory(f.project);
  const opened = await f.reader('open', 'origin', 'worker', '--candidate', candidateRef.path);
  assert.equal(opened.paperId, 'origin'); assert.equal(opened.role, 'worker');
  assert.match(opened.snapshotKey, /^[a-f0-9]{64}$/);
  assert.equal(opened.inventoryReviewRequired, true, 'Navigation cannot replace complete inventory review');
  assert.equal(opened.counts.items, candidate.inventory.items.length);
  assert.equal(opened.counts.obligations, candidate.assessments.length);
  const uniqueEvidence = new Set([...candidate.assessments.flatMap(value => value.evidence), ...f.result.claims.flatMap(value => value.evidence)].map(objectHash));
  assert.equal(opened.counts.evidence, uniqueEvidence.size, 'Identical evidence is represented once, not copied per obligation');
  assert.equal(opened.counts.resources, f.scan.resources.length);
  assert.equal(opened.counts.units, f.scan.units.length);
  assert.ok(opened.counts.items > 50);
  const directories = {};
  for (const kind of kinds) directories[kind] = await pages(f, opened, kind, candidateRef, 'worker', 7);
  assert.deepEqual(directories.items.map(value => value.key).sort(), candidate.inventory.items.map(value => value.id).sort());
  assert.deepEqual(directories.obligations.map(value => value.key).sort(), candidate.assessments.map(value => value.obligationId).sort());
  assert.deepEqual(directories.resources.map(value => value.key).sort(), f.scan.resources.map(value => value.id).sort());
  assert.deepEqual(directories.units.map(value => value.key).sort(), f.scan.units.map(value => value.id).sort());
  assert.deepEqual(directories.delta.map(value => value.key).sort(), candidate.assessments.map(value => value.obligationId).sort());
  for (const kind of kinds) {
    const exhausted = await f.reader('list', 'origin', 'worker', opened.snapshotKey, kind, String(opened.counts[kind]), '1', '--candidate', candidateRef.path);
    assert.deepEqual(exhausted.records, []); assert.equal(exhausted.nextOffset, null);
    if (directories[kind].length) await f.reader('get', 'origin', 'worker', opened.snapshotKey, kind, directories[kind][0].key, '--candidate', candidateRef.path);
  }
  const legacy = (await completeRead(f, opened, 'claims', f.result.claims[0].claimId, candidateRef)).value;
  const {evidenceKeys: legacyKeys, ...legacyClaim} = legacy.claim, legacyEvidence = [];
  for (const key of legacyKeys) legacyEvidence.push((await completeRead(f, opened, 'evidence', key, candidateRef)).value);
  assert.deepEqual({...legacyClaim, evidence: legacyEvidence}, f.result.claims[0]);
  assert.deepEqual(legacy.contract, f.result.contract.claims[0], 'Original conditions/units/criteria remain attached to legacy public evidence');
  const cli = f.execute(campaignRelative + '/coverage-reader.mjs', ['open', 'origin', 'worker', '--candidate', candidateRef.path]);
  assert.ok(Buffer.byteLength(cli.stdout, 'utf8') <= MAX_RESPONSE_BYTES);
  assert.deepEqual(cli.value, opened, 'Copied CLI and API bind the same isolated root and snapshot');
  assert.deepEqual(inventory(f.project), before, 'Opening, paging and selecting must not modify any file, including mtimes');
});

test('large scientific fields and deduplicated evidence are exactly recoverable through UTF-16 continuation reads', async t => {
  const f = readerFixture(t, {mainText: 'Synthetic identity $x=x$.\n\n' + astralText.repeat(200) + '\n'});
  const {candidate, candidateRef} = proposed(f, {large: true});
  const opened = await f.reader('open', 'origin', 'worker', '--candidate', candidateRef.path), before = inventory(f.project);
  const item = candidate.inventory.items[0], obligation = item.obligations[0];
  const selected = await f.reader('get', 'origin', 'worker', opened.snapshotKey, 'items', item.id, '--candidate', candidateRef.path);
  assert.equal(selected.contentNotInline, true);
  assert.ok(!Object.hasOwn(selected, 'content'), 'An oversized object is not silently replaced by truncated scientific content');
  assert.equal(selected.sha256, objectHash(item));
  const recoveredItem = await completeRead(f, opened, 'items', item.id, candidateRef, 999999);
  assert.equal(recoveredItem.text, core.canonical(item));
  assert.deepEqual(recoveredItem.value, item);
  const recoveredObligation = await completeRead(f, opened, 'obligations', obligation.id, candidateRef, 2047);
  assert.deepEqual(recoveredObligation.value.definition, obligation);
  assert.deepEqual(recoveredObligation.value.itemContext, Object.fromEntries(['kind', 'text', 'conditions', 'units', 'locators', 'dependencies'].map(key => [key, item[key]])));
  const projectedAssessment = recoveredObligation.value.assessment;
  assert.ok(!Object.hasOwn(projectedAssessment, 'evidence'));
  assert.equal(projectedAssessment.evidenceKeys.length, candidate.assessments[0].evidence.length);
  const recoveredEvidence = [];
  for (const key of projectedAssessment.evidenceKeys) {
    const recovered = await completeRead(f, opened, 'evidence', key, candidateRef, 999999);
    assert.equal(key, 'evidence-' + objectHash(recovered.value));
    recoveredEvidence.push(recovered.value);
  }
  const {evidenceKeys, basisKey, ...assessmentWithoutEvidence} = projectedAssessment;
  const basis = (await completeRead(f, opened, 'bindings', basisKey, candidateRef)).value;
  assert.deepEqual({...assessmentWithoutEvidence, basisItemHashes: basis, evidence: recoveredEvidence}, candidate.assessments[0],
    'Scope, conditions, compatibility, limitations and all evidence fields survive normalization exactly');
  const dependent = candidate.inventory.items[2];
  const dependentItem = await completeRead(f, opened, 'items', dependent.id, candidateRef);
  assert.deepEqual(dependentItem.value.dependencies, dependent.dependencies);
  const evidenceDirectory = await pages(f, opened, 'evidence', candidateRef);
  assert.equal(evidenceDirectory.filter(value => value.key === evidenceKeys[0]).length, 1);
  const second = await completeRead(f, opened, 'obligations', candidate.assessments[1].obligationId, candidateRef);
  assert.deepEqual(second.value.assessment.evidenceKeys, evidenceKeys, 'Shared evidence identity is stable across obligations');
  for (const resource of f.scan.resources.filter(value => value.type !== 'asset')) {
    const recovered = await completeRead(f, opened, 'resources', resource.id, candidateRef, 2047);
    assert.equal(recovered.descriptor.encoding, 'utf8-source');
    assert.equal(recovered.text, fs.readFileSync(path.resolve(f.project, resource.path), 'utf8'));
    assert.equal(recovered.descriptor.sha256, resource.sha256);
  }
  const unit = f.scan.units.find(value => value.start !== null);
  const recoveredUnit = await completeRead(f, opened, 'units', unit.id, candidateRef);
  assert.deepEqual(recoveredUnit.value, {...unit, disposition: candidate.inventory.unitDispositions.find(value => value.unitId === unit.id)});
  assert.deepEqual(inventory(f.project), before);
});

test('delta keeps changed transitive premises, partial work and unaudited inventory incomplete', async t => {
  const f = readerFixture(t), prepared = proposed(f, {incomplete: true});
  const old = await acceptedSnapshot(f, prepared);
  assert.equal(old.decision.inventoryAccepted, false);
  f.command('continue');
  const next = clone(prepared.candidate);
  next.revision = 2; next.predecessorSha256 = old.snapshot.candidate.sha256;
  next.author = assignWorker(f, 'synthetic-worker-c002');
  next.inventory.items[0].conditions.push('The foundational condition has genuinely changed');
  refreshBasis(next);
  next.changeImpact = next.inventory.items.slice(1, 3).map(item => ({obligationId: item.obligations[0].id,
    reason: 'A changed foundation propagates through this explicit dependency chain', dependsOnChangedItems: [next.inventory.items[0].id]}));
  const candidateRef = f.put(f.paper().workRoot + '/candidate.json', next);
  const opened = await f.reader('open', 'origin', 'worker', '--candidate', candidateRef.path), before = inventory(f.project);
  assert.equal(opened.inventoryReviewRequired, true, 'Previous partial inventory never grants a reduced semantic reading scope');
  assert.equal(opened.counts.units, f.scan.units.length);
  assert.equal(opened.counts.resources, f.scan.resources.length);
  const directory = await pages(f, opened, 'delta', candidateRef), deltas = new Map();
  for (const row of directory) deltas.set(row.key, (await completeRead(f, opened, 'delta', row.key, candidateRef)).value);
  assert.equal(deltas.get(next.assessments[0].obligationId).category, 'changed');
  assert.equal(deltas.get(next.assessments[1].obligationId).category, 'dependency_affected');
  assert.equal(deltas.get(next.assessments[2].obligationId).category, 'dependency_affected', 'The second edge of a dependency chain is not forgotten');
  assert.equal(deltas.get(next.assessments[3].obligationId).category, 'old_unaccepted', 'Partial evidence is not inherited as an accepted obligation');
  assert.equal(deltas.get(next.assessments[4].obligationId).category, 'old_unaccepted');
  assert.equal(deltas.get(next.assessments[5].obligationId).category, 'unchanged_accepted');
  const blocked = (await completeRead(f, opened, 'obligations', next.assessments[4].obligationId, candidateRef)).value;
  assert.deepEqual(blocked.assessment.blocker, next.assessments[4].blocker);
  assert.deepEqual(blocked.assessment.limitations, next.assessments[4].limitations);
  assert.deepEqual(blocked.definition.conditions, next.inventory.items[4].obligations[0].conditions);
  assert.equal(blocked.assessment.status, 'external_blocked');
  assert.equal(blocked.assessment.outcome, 'inconclusive');
  assert.deepEqual((await completeRead(f, opened, 'documents', 'candidate', candidateRef)).value, next,
    'The exact complete candidate remains recoverable in addition to normalized per-obligation reads');
  assert.deepEqual(inventory(f.project), before, 'Delta projection cannot grant acceptance or update the coverage ledger');
});

test('role and candidate isolation deny sibling/private paths before reading their bodies', async t => {
  const f = readerFixture(t);
  const unowned = candidateFor(f, f.scan);
  const unownedRef = f.put(f.paper().workRoot + '/unowned.json', unowned);
  await assert.rejects(f.reader('open', 'origin', 'worker', '--candidate', unownedRef.path), /owner|working|worker/i);
  const prepared = proposed(f), {candidate, candidateRef} = prepared;
  const privatePath = path.resolve(f.project, f.firstPass.review.path).toLowerCase();
  const foreignRef = f.put(cleanRelative + '/coverage_work/r0001/c001/foreign.json', candidate);
  const privateCandidate = f.put(cleanRelative + '/coverage_verifications/origin/c001/private-candidate.json', candidate);
  const wrongVersion = f.put(cleanRelative + '/coverage_work/origin/c002/candidate.json', candidate);
  const outside = f.put('outside-reader-candidate.json', candidate);
  const sibling = f.put(cleanRelative + '/results/r0001/reader-sentinel.json', {paperId: 'r0001', body: otherPaperSentinel});
  const before = inventory(f.project);
  const observed = await captureReads(async () => {
    const opened = await f.reader('open', 'origin', 'worker', '--candidate', candidateRef.path);
    for (const kind of kinds) await pages(f, opened, kind, candidateRef);
    await assert.rejects(f.reader('open', 'origin', 'reviewer', '--candidate', candidateRef.path), /role|owner|candidate/i);
    await assert.rejects(f.reader('open', 'origin', 'admin'), /role/i);
    await assert.rejects(f.reader('open', 'r9999', 'worker'), /scope|Unknown/i);
    await assert.rejects(f.reader('open', 'r0001', 'worker'), /prepared/i);
    for (const ref of [foreignRef, privateCandidate, wrongVersion, outside])
      await assert.rejects(f.reader('open', 'origin', 'worker', '--candidate', ref.path), /root|candidate|version|scope/i);
    for (const key of ['../review.json', privatePath, otherPaperSentinel])
      await assert.rejects(f.reader('get', 'origin', 'worker', opened.snapshotKey, 'documents', key, '--candidate', candidateRef.path), /key|record|document|unknown/i);
    const serialized = core.canonical(opened);
    assert.ok(!serialized.includes(privateSentinel)); assert.ok(!serialized.includes(otherPaperSentinel));
    return opened;
  });
  for (const forbidden of [privatePath, path.resolve(f.project, sibling.path).toLowerCase(),
    ...[foreignRef, privateCandidate, wrongVersion, outside].map(ref => path.resolve(f.project, ref.path).toLowerCase())])
    assert.ok(!observed.reads.includes(forbidden), 'Denied inputs must not be read: ' + forbidden);
  assert.deepEqual(inventory(f.project), before);
  const forgedAuthor = clone(candidate); forgedAuthor.author = 'not-the-registered-owner';
  const forgedRef = f.put(f.paper().workRoot + '/wrong-author.json', forgedAuthor);
  await assert.rejects(f.reader('open', 'origin', 'worker', '--candidate', forgedRef.path), /author|owner/i);
  const privateEvidence = clone(candidate); privateEvidence.assessments[0].evidence[0].artifacts = [f.firstPass.review];
  const privateEvidenceRef = f.put(f.paper().workRoot + '/private-evidence.json', privateEvidence);
  const rejected = await captureReads(async () => assert.rejects(f.reader('open', 'origin', 'worker', '--candidate', privateEvidenceRef.path), /private|outside|root/i));
  assert.ok(!rejected.reads.includes(privatePath), 'Private artifact content is denied before evidence validation reads it');
  f.command('intake', {agent: prepared.worker, ownerFinished: true, candidatePath: candidateRef.path});
  f.command('assign', {role: 'reviewer', agent: 'synthetic-reader-reviewer', freshContext: true, historyInherited: false});
  const reviewer = await captureReads(() => f.reader('open', 'origin', 'reviewer'));
  assert.equal(reviewer.value.candidate.ref.sha256, f.paper().staged.candidate.sha256);
  assert.ok(!reviewer.reads.includes(privatePath), 'Reviewer navigation does not automatically dump private holdouts');
  await assert.rejects(f.reader('open', 'origin', 'worker'), /role|owner/i);
});

test('snapshot continuation rejects local changes but survives legal work on a different paper', async t => {
  const f = readerFixture(t), {candidate, candidateRef} = proposed(f);
  // A synthetic sibling is placed at its legitimate assignment boundary. It is
  // never prepared from, nor allowed to consume, the target paper's resources.
  const state = f.state(), sibling = state.papers.find(value => value.paperId === 'r0001');
  Object.assign(sibling, {phase: 'ready', iteration: 1, workRoot: cleanRelative + '/coverage_work/r0001/c001'});
  f.put(campaignRelative + '/coverage/state.json', state);
  const opened = await f.reader('open', 'origin', 'worker', '--candidate', candidateRef.path);
  f.command('assign', {paperId: 'r0001', role: 'worker', agent: 'independent-synthetic-sibling-owner', freshContext: true, historyInherited: false});
  const unrelatedSnapshot = await f.reader('open', 'origin', 'worker', '--candidate', candidateRef.path);
  assert.equal(unrelatedSnapshot.snapshotKey, opened.snapshotKey, 'A whole-ledger revision is not a target-paper snapshot identity');
  await f.reader('list', 'origin', 'worker', opened.snapshotKey, 'items', '0', '2', '--candidate', candidateRef.path);
  const changed = clone(candidate); changed.assessments[0].summary += ' A new local scientific condition.';
  f.put(candidateRef.path, changed);
  await assert.rejects(f.reader('list', 'origin', 'worker', opened.snapshotKey, 'items', '0', '2', '--candidate', candidateRef.path), /snapshot|stale|changed/i);
  const reopened = await f.reader('open', 'origin', 'worker', '--candidate', candidateRef.path);
  assert.notEqual(reopened.snapshotKey, opened.snapshotKey);
  await assert.rejects(f.reader('get', 'origin', 'worker', opened.snapshotKey, 'items', candidate.inventory.items[0].id, '--candidate', candidateRef.path), /snapshot|stale|changed/i);
  await assert.rejects(f.reader('read', 'origin', 'worker', opened.snapshotKey, 'items', candidate.inventory.items[0].id, '0', '20', '--candidate', candidateRef.path), /snapshot|stale|changed/i);
  const before = inventory(f.project);
  await f.reader('get', 'origin', 'worker', reopened.snapshotKey, 'items', candidate.inventory.items[0].id, '--candidate', candidateRef.path);
  assert.deepEqual(inventory(f.project), before);
});

test('tampered scope, bound source and evidence fail closed without repair or writes', async t => {
  const f = readerFixture(t), {candidate, candidateRef} = proposed(f);
  const opened = await f.reader('open', 'origin', 'worker', '--candidate', candidateRef.path);
  const rejectAfter = async (relative, mutation, pattern) => {
    const absolute = path.resolve(f.project, relative), original = fs.readFileSync(absolute);
    f.put(relative, mutation(original));
    const before = inventory(f.project);
    await assert.rejects(f.reader('open', 'origin', 'worker', '--candidate', candidateRef.path), pattern);
    assert.deepEqual(inventory(f.project), before, 'Failure cannot repair, reseal or partially rewrite inputs');
    f.put(relative, original);
  };
  const authority = read(path.resolve(f.project, f.authority.path));
  await rejectAfter(authority.scope.nodes.path, bytes => [...JSON.parse(bytes), {paper_id: 'r9999'}], /hash|scope|nodes/i);
  await rejectAfter(f.scan.resources.find(value => value.type === 'text').path, bytes => Buffer.concat([bytes, Buffer.from('\nTAMPERED_SOURCE')]), /hash|source|changed/i);
  await rejectAfter(candidate.assessments[0].evidence[0].artifacts[0].path, bytes => Buffer.concat([bytes, Buffer.from('\nTAMPERED_EVIDENCE')]), /hash|evidence/i);
  await rejectAfter(f.paper().scan.path, bytes => {const value = JSON.parse(bytes); value.paperId = 'r0001'; return value;}, /hash|scan|paper/i);
  const forged = clone(candidate); forged.assessments[0].evidence[0].artifacts[0].sha256 = '0'.repeat(64);
  const forgedRef = f.put(f.paper().workRoot + '/bad-ref.json', forged);
  const before = inventory(f.project);
  await assert.rejects(f.reader('open', 'origin', 'worker', '--candidate', forgedRef.path), /hash|ref|evidence/i);
  assert.deepEqual(inventory(f.project), before);
  assert.equal((await f.reader('open', 'origin', 'worker', '--candidate', candidateRef.path)).snapshotKey, opened.snapshotKey);
});

test('invalid navigation cannot bypass bounds, select arbitrary files or split a surrogate pair', async t => {
  const f = readerFixture(t, {diagnostic: true}), {candidate, candidateRef} = proposed(f);
  candidate.inventory.items[0].text = 'astral 🧪 boundary'; refreshBasis(candidate); f.put(candidateRef.path, candidate);
  const opened = await f.reader('open', 'origin', 'worker', '--candidate', candidateRef.path), before = inventory(f.project);
  const tail = ['--candidate', candidateRef.path], item = candidate.inventory.items[0];
  for (const pagination of [['-1', '2'], ['0', '0'], ['NaN', '1'], ['0', '999999999999'], ['9007199254740992', '1']])
    await assert.rejects(f.reader('list', 'origin', 'worker', opened.snapshotKey, 'items', ...pagination, ...tail));
  for (const range of [['-1', '2'], ['0', '0'], ['NaN', '1'], ['9007199254740992', '1']])
    await assert.rejects(f.reader('read', 'origin', 'worker', opened.snapshotKey, 'items', item.id, ...range, ...tail));
  await assert.rejects(f.reader('list', 'origin', 'worker', opened.snapshotKey, 'privateReview', ...tail), /kind|unknown/i);
  await assert.rejects(f.reader('get', 'origin', 'worker', opened.snapshotKey, 'items', 'origin:missing', ...tail), /key|unknown|record/i);
  await assert.rejects(f.reader('open', 'origin', 'worker', '--candidate'), /candidate|argument|path/i);
  const start = core.canonical(item).indexOf('🧪');
  await assert.rejects(f.reader('read', 'origin', 'worker', opened.snapshotKey, 'items', item.id, String(start + 1), '2', ...tail), /surrogate|boundary|UTF-16/i);
  const single = await f.reader('read', 'origin', 'worker', opened.snapshotKey, 'items', item.id, String(start), '1', ...tail);
  assert.equal(single.chunk, '🧪'); assert.equal(single.end, start + 2);
  assert.ok(opened.counts.diagnostics > 0);
  const diagnostics = await pages(f, opened, 'diagnostics', candidateRef);
  assert.deepEqual(diagnostics.map(value => value.key).sort(), f.scan.diagnostics.map(value => value.id).sort());
  for (const diagnostic of f.scan.diagnostics) {
    const recovered = (await completeRead(f, opened, 'diagnostics', diagnostic.id, candidateRef)).value;
    assert.deepEqual(recovered, {...diagnostic, disposition: candidate.inventory.diagnosticDispositions.find(value => value.diagnosticId === diagnostic.id)});
  }
  assert.deepEqual(inventory(f.project), before);
});
