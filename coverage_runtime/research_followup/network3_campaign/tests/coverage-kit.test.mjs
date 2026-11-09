import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {runKit} from '../coverage-kit.mjs';
import * as core from '../coverage-core.mjs';
import {fixture, installCoverage, copyModuleClosure, candidateFor, reviewFor, decisionFor, objectHash, campaignRelative, cleanRelative, read, clone, digest} from './fixtures/context-kit/fixture.mjs';

// No real paper, production state, owner or source is used. The original runtime
// creates a synthetic frozen run with workerCount=1. Execute this suite with
// --test-concurrency=1; source/ledger byte inventories are compared around calls.
const privateSentinel = 'PRIVATE_REVIEW_BODY_MUST_NOT_APPEAR_IN_NAVIGATION';
const privateRetained = 'PRIVATE_RETAINED_REVIEW_OUTPUT_MUST_NOT_APPEAR';
function kitFixture(t, options = {}) {
  const base = fixture(t, options);
  const review = read(path.resolve(base.project, base.firstPass.review.path));
  review.privateRetainedTests = {body: privateSentinel, unpublishedExpectedOutput: privateRetained};
  base.firstPass.review = base.put(base.firstPass.review.path, review);
  const acceptance = read(path.resolve(base.project, base.firstPass.acceptance.path));
  acceptance.reviewSha256 = base.firstPass.review.sha256;
  base.firstPass.acceptance = base.put(base.firstPass.acceptance.path, acceptance);
  const f = installCoverage(base);
  copyModuleClosure(f.project, campaignRelative + '/coverage-kit.mjs');
  f.invoke('init'); f.command('prepare');
  const kit = (...args) => runKit(f.project, args);
  return {...f, kit, scan: read(f.paper().scan.path)};
}
function specFor(candidate) {
  return {schemaVersion: 1, author: candidate.author, inventory: {complete: candidate.inventory.complete, items: clone(candidate.inventory.items),
    unitRules: candidate.inventory.unitDispositions.filter(value => value.itemIds.length === 0).map(({unitId, reason}) => ({selector: {unitIds: [unitId]}, reason})),
    diagnosticDispositions: clone(candidate.inventory.diagnosticDispositions)},
    assessments: candidate.assessments.map(value => {const result = clone(value); delete result.basisItemHashes; return result;}), retainObligationIds: []};
}
function reviewSpec(review) {
  const inventory = clone(review.inventory); delete inventory.resourceIds;
  return {schemaVersion: 1, inventory, entries: review.entries.map(value => {const result = clone(value); delete result.assessmentSha256; return result;}), retainedObligationIds: clone(review.retainedObligationIds)};
}
function normalizedCandidate(f, candidate) {
  const result = clone(candidate);
  for (const disposition of result.inventory.unitDispositions) if (disposition.itemIds.length) disposition.reason = 'Mapped by explicit item source locators: ' + disposition.itemIds.join(', ');
  for (const assessment of result.assessments) for (const evidence of assessment.evidence) evidence.artifacts = evidence.artifacts.map(ref => core.fileRef(f.project, ref.path));
  return result;
}
function normalizedReview(f, review) {
  const result = clone(review);
  for (const entry of result.entries) entry.evidence = entry.evidence.map(ref => core.fileRef(f.project, ref.path));
  return result;
}
function inventory(directory, exclude = []) {
  const files = {};
  function visit(relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, relative), {withFileTypes: true})) {
      const name = path.join(relative, entry.name), portable = name.replaceAll('\\', '/');
      if (exclude.some(prefix => portable === prefix || portable.startsWith(prefix + '/'))) continue;
      if (entry.isDirectory()) visit(name); else files[portable] = digest(path.join(directory, name));
    }
  }
  visit(); return files;
}
const protectedFiles = f => inventory(f.project, [cleanRelative + '/coverage_work', cleanRelative + '/coverage_verifications']);
async function captureReads(action) {
  const original = fs.readFileSync, reads = [];
  fs.readFileSync = function (filename, ...args) {
    if (typeof filename === 'string') reads.push(path.resolve(filename).toLowerCase());
    return original.call(this, filename, ...args);
  };
  try { return {value: await action(), reads}; }
  finally { fs.readFileSync = original; }
}
function assertNoLeak(value) {
  const serialized = core.canonical(value);
  for (const forbidden of [privateSentinel, privateRetained, 'PRIVATE_NONACADEMIC_MAPPING_MUST_NOT_BE_SCANNED', 'r0001', 'globalCompletionPercent', 'SIBLING_RESULT_MUST_NOT_APPEAR']) assert.ok(!serialized.includes(forbidden), 'Projection leaked ' + forbidden);
}
function assignWorker(f, agent = 'synthetic-worker-c001') {
  f.command('assign', {role: 'worker', agent, freshContext: true, historyInherited: false});
  return agent;
}
async function submitCandidate(f, {gap = false} = {}) {
  const worker = assignWorker(f), candidate = candidateFor(f, f.scan, {author: worker});
  if (gap) Object.assign(candidate.assessments[0], {status: 'internal_gap', outcome: 'inconclusive', summary: 'Synthetic missing derivation', evidence: []});
  const spec = f.put(f.paper().workRoot + '/candidate-spec.json', specFor(candidate)), outputPath = f.paper().workRoot + '/assembled-candidate.json';
  const output = await f.kit('assemble', 'origin', spec.path, outputPath);
  const assembled = read(output.output.path);
  f.command('intake', {agent: worker, ownerFinished: true, candidatePath: output.output.path});
  return {candidate: assembled, output, worker};
}

test('role context is source-complete navigation without private review bodies, sibling results or corpus dumps', async t => {
  const f = kitFixture(t), before = inventory(f.project);
  const worker = await captureReads(() => f.kit('context', 'origin', 'worker'));
  assertNoLeak(worker.value);
  assert.equal(worker.value.role, 'worker');
  assert.equal(worker.value.paperId, 'origin');
  assert.deepEqual(worker.value.source.resources.map(value => ({id: value.id, path: value.path, sha256: value.sha256, type: value.type})), f.scan.resources);
  assert.equal(worker.value.source.unitCount, f.scan.units.length);
  assert.equal(worker.value.source.resources.length, 3, 'Main TeX, necessary dependency and graphic all remain available');
  assert.equal(worker.value.publicBaseline.claimCount, f.result.claims.length);
  assert.ok(worker.value.source.resources.some(value => value.path.endsWith('body.tex')));
  assert.ok(worker.value.source.resources.some(value => value.path.endsWith('fig.png')));
  assert.ok(worker.value.source.resources.every(value => !Object.hasOwn(value, 'body') && !Object.hasOwn(value, 'excerpt')));
  assert.ok(!Object.hasOwn(worker.value, 'privateReviewReferences'));
  assert.ok(!Object.hasOwn(worker.value.publicBaseline, 'review'));
  const privatePath = path.resolve(f.project, f.firstPass.review.path).toLowerCase();
  assert.ok(!worker.reads.includes(privatePath), 'Worker navigation does not read a private review body');
  assert.ok(!worker.reads.some(value => value.includes('results' + path.sep + 'r0001')), 'Navigation does not load sibling results');
  assert.match(worker.value.rules.join(' '), /entire bound academic package/);
  const reviewer = await captureReads(() => f.kit('context', 'origin', 'reviewer'));
  assertNoLeak(reviewer.value);
  assert.deepEqual(reviewer.value.privateReviewReferences.firstPass, f.paper().firstPass.review);
  assert.ok(!reviewer.reads.includes(privatePath), 'Reviewer navigation supplies references, not automatic private-body dumps');
  assert.deepEqual(inventory(f.project), before, 'Context commands are wholly read-only');
  await assert.rejects(f.kit('context', 'origin', 'admin'), /role/i);
  await assert.rejects(f.kit('context', 'r9999', 'worker'), /scope|Unknown/i);
  await assert.rejects(f.kit('context', 'r0001', 'worker'), /prepared/i);
});

test('unit and claim navigation is bounded, paginated and explicitly marks truncated source excerpts', async t => {
  const mainText = 'Synthetic identity $x=x$ ' + 'q'.repeat(1400) + '.\n\n' + Array.from({length: 65}, (_, index) => 'Synthetic paragraph ' + index + ' $z_' + index + '=z_' + index + '$.').join('\n\n') + '\n';
  const f = kitFixture(t, {mainText}), resource = f.scan.resources.find(value => value.path.endsWith('main.tex'));
  const before = inventory(f.project), expected = f.scan.units.filter(value => value.resourceId === resource.id);
  assert.ok(expected.length > 50);
  const first = await f.kit('units', 'origin', resource.id, '0', '2');
  assert.equal(first.units.length, 2); assert.equal(first.offset, 0); assert.equal(first.nextOffset, 2); assert.equal(first.total, expected.length);
  const pages = [];
  for (let offset = 0; offset !== null;) {
    const result = await f.kit('units', 'origin', resource.id, String(offset), '50');
    assert.ok(result.units.length <= 50); assertNoLeak(result);
    pages.push(...result.units); offset = result.nextOffset;
  }
  assert.deepEqual(pages.map(value => value.id), expected.map(value => value.id), 'Pagination neither drops nor repeats source-unit identities');
  const truncated = pages.find(value => value.excerptTruncated);
  assert.ok(truncated); assert.equal(truncated.excerpt.length, 1200);
  assert.equal(truncated.excerptSha256, core.hash(mainText.slice(truncated.start, truncated.end)), 'Hash continues to bind the full range, not the display excerpt');
  assert.notEqual(core.hash(truncated.excerpt), truncated.excerptSha256);
  assert.match(first.note, /UTF-16.*end-exclusive/); assert.match(first.note, /Truncated excerpts.*full source range/);
  const final = await f.kit('units', 'origin', resource.id, String(expected.length), '1');
  assert.deepEqual(final.units, []); assert.equal(final.nextOffset, null);
  for (const args of [[resource.id, '-1', '2'], [resource.id, '0', '51'], [resource.id, '0', '0'], [resource.id, 'NaN', '1'], ['unbound-resource', '0', '1']]) await assert.rejects(f.kit('units', 'origin', ...args));
  const asset = f.scan.resources.find(value => value.type === 'asset'), assetPage = await f.kit('units', 'origin', asset.id);
  assert.equal(assetPage.units.length, 1); assert.ok(!Object.hasOwn(assetPage.units[0], 'excerpt'));
  const claims = await f.kit('claims', 'origin', '0', '1');
  assert.equal(claims.total, 1); assert.equal(claims.claims.length, 1); assert.equal(claims.nextOffset, null); assertNoLeak(claims);
  assert.equal(claims.claims[0].claimId, 'origin:c0001'); assert.equal(claims.claims[0].status, 'partial');
  assert.deepEqual(claims.claims[0].evidence[0].resolvedArtifact, core.fileRef(f.project, f.answer));
  assert.equal(claims.claims[0].evidence[0].path, f.result.claims[0].evidence[0].path, 'Original frozen run-relative provenance is preserved');
  assert.match(claims.note, /contract conditions.*does not confer coverage credit/);
  assert.deepEqual((await f.kit('claims', 'origin', '1', '1')).claims, []);
  await assert.rejects(f.kit('claims', 'origin', '0', '51'), /1\.\.50/);
  assert.deepEqual(inventory(f.project), before);
  const cli = f.execute(campaignRelative + '/coverage-kit.mjs', ['claims', 'origin', '0', '1']).value;
  assert.deepEqual(cli, claims, 'Copied CLI entry point is rooted in its isolated project');
});

test('candidate assembly writes only canonical new output, is byte-idempotent and leaves all business state untouched', async t => {
  const f = kitFixture(t), worker = assignWorker(f), manual = candidateFor(f, f.scan, {author: worker});
  const spec = f.put(f.paper().workRoot + '/spec.json', specFor(manual)), outputPath = f.paper().workRoot + '/candidate.json';
  const before = protectedFiles(f), workBefore = inventory(path.resolve(f.project, f.paper().workRoot));
  const result = await f.kit('assemble', 'origin', spec.path, outputPath), actual = read(result.output.path);
  assert.equal(result.valid, true); assert.equal(result.ledgerWritten, false); assert.equal(result.scientificAcceptance, false);
  assert.equal(core.canonical(actual), core.canonical(normalizedCandidate(f, manual)));
  assert.equal(fs.readFileSync(result.output.path, 'utf8'), core.canonical(actual));
  assert.equal((await core.validateCandidate({root: f.project, scan: f.scan, scanSha256: f.paper().scan.sha256, candidate: actual})).valid, true);
  assert.equal(f.paper().phase, 'working'); assert.equal(f.paper().staged, null);
  const statBefore = fs.statSync(result.output.path, {bigint: true}), repeat = await f.kit('assemble', 'origin', spec.path, outputPath);
  assert.deepEqual(repeat.output, result.output);
  assert.equal(fs.statSync(result.output.path, {bigint: true}).mtimeNs, statBefore.mtimeNs, 'Idempotence does not rewrite an identical frozen output');
  assert.deepEqual(protectedFiles(f), before, 'No ledger, source, acceptance or historical evidence bytes were changed');
  const workAfter = inventory(path.resolve(f.project, f.paper().workRoot));
  assert.deepEqual(Object.keys(workAfter).sort(), [...Object.keys(workBefore), 'candidate.json'].sort());
  const conflict = f.put(f.paper().workRoot + '/conflict.json', 'Do not overwrite this pre-existing material');
  await assert.rejects(f.kit('assemble', 'origin', spec.path, conflict.path), /Conflicting immutable/);
  assert.equal(digest(path.resolve(f.project, conflict.path)), conflict.sha256);
  await assert.rejects(f.kit('assemble', 'origin', spec.path, spec.path), /specification/);
  assert.equal(digest(path.resolve(f.project, spec.path)), spec.sha256);
  assert.deepEqual(protectedFiles(f), before);
});

test('assembly requires matching owner/version roots and validates bad specifications before publishing anything', async t => {
  const f = kitFixture(t), manual = candidateFor(f, f.scan), spec = f.put(f.paper().workRoot + '/spec.json', specFor(manual));
  const outputPath = f.paper().workRoot + '/new.json';
  await assert.rejects(f.kit('assemble', 'origin', spec.path, outputPath), /owner/i);
  assert.ok(!fs.existsSync(path.resolve(f.project, outputPath)));
  assignWorker(f);
  assert.equal((await f.kit('context', 'origin', 'worker')).owner.agent, manual.author);
  await assert.rejects(f.kit('context', 'origin', 'reviewer'), /active owner.*not OS authentication/i);
  const before = protectedFiles(f);
  for (const destination of [campaignRelative + '/coverage/forbidden.json', cleanRelative + '/coverage_work/r0001/c001/forbidden.json', cleanRelative + '/coverage_work/origin/c002/forbidden.json', cleanRelative + '/coverage_verifications/origin/c001/forbidden.json', 'outside.json']) {
    await assert.rejects(f.kit('assemble', 'origin', spec.path, destination), /authorized root|escapes/i);
    assert.ok(!fs.existsSync(path.resolve(f.project, destination)));
  }
  const foreignSpec = f.put(cleanRelative + '/coverage_work/r0001/c001/foreign-spec.json', specFor(manual));
  await assert.rejects(f.kit('assemble', 'origin', foreignSpec.path, outputPath), /authorized root|escapes/i);
  await assert.rejects(f.kit('assemble-review', 'origin', spec.path, outputPath), /owner/i);
  const mutations = [
    ['wrong-author', value => {value.author = 'different-agent';}],
    ['missing-status', value => {delete value.assessments[0].status;}],
    ['missing-assessment', value => {value.assessments.pop();}],
    ['stale-artifact', value => {value.assessments[0].evidence[0].artifacts[0].sha256 = '0'.repeat(64);}],
    ['invented-pass', value => {value.assessments[0].outcome = 'partial';}],
  ];
  for (const [name, mutate] of mutations) {
    const input = specFor(manual); mutate(input);
    const changed = f.put(f.paper().workRoot + '/' + name + '-spec.json', input), target = f.paper().workRoot + '/' + name + '.json';
    await assert.rejects(f.kit('assemble', 'origin', changed.path, target));
    assert.ok(!fs.existsSync(path.resolve(f.project, target)), name + ' must not publish an output');
  }
  const privateInput = specFor(manual); privateInput.assessments[0].evidence[0].artifacts = [f.firstPass.review];
  const privateSpec = f.put(f.paper().workRoot + '/private-spec.json', privateInput);
  const captured = await captureReads(async () => {
    await assert.rejects(f.kit('assemble', 'origin', privateSpec.path, outputPath), /outside.*worker.*root/i);
  });
  assert.ok(!captured.reads.includes(path.resolve(f.project, f.firstPass.review.path).toLowerCase()), 'Private review artifact is rejected before its body is read for assembly');
  assert.ok(!fs.existsSync(path.resolve(f.project, outputPath)));
  assert.deepEqual(protectedFiles(f), before);
});

test('review assembly stays independently scoped and the unchanged intake/review/decision chain remains mandatory', async t => {
  const f = kitFixture(t), submitted = await submitCandidate(f, {gap: true});
  const reviewer = 'synthetic-reviewer-c001';
  f.command('assign', {role: 'reviewer', agent: reviewer, freshContext: true, historyInherited: false});
  await assert.rejects(f.kit('context', 'origin', 'worker'), /active owner/i);
  assert.equal((await f.kit('context', 'origin', 'reviewer')).owner.agent, reviewer);
  const manual = reviewFor(f, f.scan, submitted.candidate, {reviewer});
  const spec = f.put(f.paper().staged.reviewRoot + '/review-spec.json', reviewSpec(manual)), outputPath = f.paper().staged.reviewRoot + '/review.json';
  const before = protectedFiles(f), result = await f.kit('assemble-review', 'origin', spec.path, outputPath), actual = read(result.output.path);
  assert.equal(result.valid, true); assert.equal(result.scientificAcceptance, false); assert.equal(result.ledgerWritten, false);
  assert.equal(core.canonical(actual), core.canonical(normalizedReview(f, manual)));
  assert.equal(fs.readFileSync(result.output.path, 'utf8'), core.canonical(actual));
  assert.equal((await core.validateReview({root: f.project, scan: f.scan, candidate: submitted.candidate, candidateSha256: objectHash(submitted.candidate), review: actual, reviewer, worker: submitted.worker})).valid, true);
  assert.equal(actual.entries[0].verdict, 'needs_work');
  assert.equal(f.paper().phase, 'reviewing'); assert.ok(!f.paper().staged.review);
  assert.equal(f.paper().latest, null, 'Assembly does not bypass scientific intake or supervisor acceptance');
  const repeated = await f.kit('assemble-review', 'origin', spec.path, outputPath);
  assert.deepEqual(repeated.output, result.output);
  await assert.rejects(f.kit('assemble-review', 'origin', spec.path, f.paper().workRoot + '/review.json'), /authorized root|escapes/i);
  await assert.rejects(f.kit('assemble', 'origin', spec.path, outputPath), /owner/i);
  const copied = reviewSpec(manual); copied.entries[1].evidence = submitted.candidate.assessments[1].evidence[0].artifacts;
  const copiedSpec = f.put(f.paper().staged.reviewRoot + '/borrowed-spec.json', copied), borrowedOutput = f.paper().staged.reviewRoot + '/borrowed.json';
  await assert.rejects(f.kit('assemble-review', 'origin', copiedSpec.path, borrowedOutput), /independent|outside/i);
  assert.ok(!fs.existsSync(path.resolve(f.project, borrowedOutput)));
  const incomplete = reviewSpec(manual); incomplete.entries.pop();
  const incompleteSpec = f.put(f.paper().staged.reviewRoot + '/incomplete-spec.json', incomplete);
  await assert.rejects(f.kit('assemble-review', 'origin', incompleteSpec.path, f.paper().staged.reviewRoot + '/incomplete.json'), /coverage/i);
  assert.deepEqual(protectedFiles(f), before, 'Kit operations have not mutated the supervisor ledger or old evidence');
  f.command('review', {agent: reviewer, ownerFinished: true, reviewPath: result.output.path});
  const decision = decisionFor(f.scan, submitted.candidate, actual), decisionRef = f.put(campaignRelative + '/coverage/requests/decision.json', decision);
  f.command('decide', {decisionPath: decisionRef.path});
  assert.equal(f.paper().phase, 'assessed'); assert.equal(f.paper().latest.metrics.internalGap, 1); assert.equal(f.paper().latest.metrics.coverageComplete, false);
  f.command('continue');
  const workerContext = await f.kit('context', 'origin', 'worker'), reviewerContext = await f.kit('context', 'origin', 'reviewer');
  assertNoLeak(workerContext); assertNoLeak(reviewerContext);
  assert.equal(workerContext.iteration, 2); assert.equal(workerContext.previous.candidate.sha256, objectHash(submitted.candidate));
  assert.ok(!Object.hasOwn(workerContext.previous, 'review'));
  assert.equal(reviewerContext.privateReviewReferences.previous.sha256, objectHash(actual));
  assert.deepEqual(workerContext.selectedObligationIds, [submitted.candidate.assessments[0].obligationId]);
  const nextWorker = assignWorker(f, 'synthetic-worker-c002'), next = specFor(submitted.candidate);
  next.author = nextWorker;
  next.assessments[1].summary += ' Unauthorized recomputation of an already accepted obligation';
  const unapprovedSpec = f.put(f.paper().workRoot + '/unapproved-spec.json', next), unapprovedOutput = f.paper().workRoot + '/unapproved.json';
  const deltaBefore = protectedFiles(f);
  await assert.rejects(f.kit('assemble', 'origin', unapprovedSpec.path, unapprovedOutput), /dependency-impact explanation/i);
  assert.ok(!fs.existsSync(path.resolve(f.project, unapprovedOutput)), 'Unselected accepted work cannot be republished as a fresh assessment');
  const delta = specFor(submitted.candidate); delta.author = nextWorker;
  delta.retainObligationIds = delta.assessments.slice(1).map(value => value.obligationId); delta.assessments = delta.assessments.slice(0, 1);
  const deltaSpec = f.put(f.paper().workRoot + '/delta-spec.json', delta);
  const deltaResult = await f.kit('assemble', 'origin', deltaSpec.path, f.paper().workRoot + '/delta.json');
  const deltaCandidate = read(deltaResult.output.path);
  assert.equal(deltaCandidate.revision, 2); assert.equal(deltaCandidate.predecessorSha256, objectHash(submitted.candidate));
  assert.equal(core.canonical(deltaCandidate.assessments.slice(1)), core.canonical(submitted.candidate.assessments.slice(1)), 'Unchanged accepted assessments are retained byte-for-byte');
  assert.deepEqual(protectedFiles(f), deltaBefore);
});

test('installed authority, exact assigned version and evidence identity fail closed in synthetic tampering cases', async t => {
  const f = kitFixture(t), statePath = path.join(f.campaign, 'coverage/state.json');
  const originalStateBytes = fs.readFileSync(statePath, 'utf8'), originalState = JSON.parse(originalStateBytes);
  const alias = f.put('synthetic-authority/copied-coverage-authority.json', fs.readFileSync(path.resolve(f.project, originalState.authority.path)));
  for (const authority of [{...originalState.authority, sha256: '0'.repeat(64)}, alias]) {
    f.put(statePath, {...clone(originalState), authority});
    try { await assert.rejects(f.kit('context', 'origin', 'worker'), /installed authority/i); }
    finally { f.put(statePath, originalStateBytes); }
  }
  const alteredBaseline = clone(originalState); alteredBaseline.papers.find(value => value.paperId === 'origin').firstPass.result.sha256 = '0'.repeat(64);
  f.put(statePath, alteredBaseline);
  try { await assert.rejects(f.kit('context', 'origin', 'worker'), /frozen closure/i); }
  finally { f.put(statePath, originalStateBytes); }
  assert.equal(fs.readFileSync(statePath, 'utf8'), originalStateBytes);
  const answerBytes = fs.readFileSync(f.answer);
  f.put(f.answer, 'Synthetic mutated output must not be advertised as the frozen claim artifact');
  try { await assert.rejects(f.kit('claims', 'origin'), /hash mismatch/i); }
  finally { f.put(f.answer, answerBytes); }
  assert.deepEqual((await f.kit('claims', 'origin')).claims[0].evidence[0].resolvedArtifact, core.fileRef(f.project, f.answer));
  assignWorker(f);
  const assignedBytes = fs.readFileSync(statePath, 'utf8'), wrongVersion = JSON.parse(assignedBytes);
  wrongVersion.papers.find(value => value.paperId === 'origin').workRoot = cleanRelative + '/coverage_work/origin/c002';
  f.put(statePath, wrongVersion);
  const unexpected = cleanRelative + '/coverage_work/origin/c002/out.json';
  try { await assert.rejects(f.kit('assemble', 'origin', cleanRelative + '/coverage_work/origin/c002/spec.json', unexpected), /registered paper\/version/i); }
  finally { f.put(statePath, assignedBytes); }
  assert.ok(!fs.existsSync(path.resolve(f.project, unexpected)));
});
