import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as core from '../coverage-core.mjs';
import {assembleCandidate, assembleReview, resolveLocators} from '../coverage-authoring.mjs';
import {scenario, reviewFor, decisionFor, refreshBasis, objectHash, cleanRelative, clone, hash, digest, executedEvidence} from './fixtures/context-kit/fixture.mjs';

// These tests use only synthetic frozen Dot/run fixtures. No production ledger,
// original paper, scientific process or live source tree is read or mutated.
// The fixture's child processes declare workerCount=1 and BLAS/OMP threads=1;
// run this suite with node --test --test-concurrency=1.
function candidateSpec(candidate) {
  return {schemaVersion: 1, author: candidate.author,
    inventory: {complete: candidate.inventory.complete, items: clone(candidate.inventory.items),
      unitRules: candidate.inventory.unitDispositions.filter(value => value.itemIds.length === 0).map(({unitId, reason}) => ({selector: {unitIds: [unitId]}, reason})),
      diagnosticDispositions: clone(candidate.inventory.diagnosticDispositions)},
    assessments: candidate.assessments.map(value => {const result = clone(value); delete result.basisItemHashes; return result;}),
    retainObligationIds: [], ...(candidate.changeImpact ? {changeImpact: clone(candidate.changeImpact)} : {})};
}
function reviewSpec(review) {
  const inventory = clone(review.inventory); delete inventory.resourceIds;
  return {schemaVersion: 1, inventory, entries: review.entries.map(value => {const result = clone(value); delete result.assessmentSha256; return result;}), retainedObligationIds: clone(review.retainedObligationIds)};
}
function normalizedCandidate(f, value) {
  const result = clone(value);
  for (const disposition of result.inventory.unitDispositions) if (disposition.itemIds.length) disposition.reason = 'Mapped by explicit item source locators: ' + disposition.itemIds.join(', ');
  for (const assessment of result.assessments) for (const evidence of assessment.evidence) {
    evidence.artifacts = evidence.artifacts.map(ref => core.fileRef(f.project, ref.path));
    if (evidence.execution) evidence.execution.receipt = core.fileRef(f.project, evidence.execution.receipt.path);
  }
  return result;
}
function normalizedReview(f, value) {
  const result = clone(value);
  for (const entry of result.entries) entry.evidence = entry.evidence.map(ref => core.fileRef(f.project, ref.path));
  return result;
}
const build = (f, spec, previous = null) => assembleCandidate({root: f.project, scan: f.scan, scanSha256: objectHash(f.scan), spec, previous});
const buildReview = (f, candidate, spec, previous = null, reviewer = 'synthetic-reviewer-c001') => assembleReview({root: f.project, scan: f.scan, candidate, candidateSha256: objectHash(candidate), spec, reviewer, worker: candidate.author, previous});
const coreCandidate = (f, candidate, previous = null) => core.validateCandidate({root: f.project, scan: f.scan, scanSha256: objectHash(f.scan), candidate, previous});
const coreReview = (f, candidate, review, previous = null) => core.validateReview({root: f.project, scan: f.scan, candidate, candidateSha256: objectHash(candidate), review, reviewer: review.reviewerAgent, worker: candidate.author, previous});

test('mechanical candidate/review assembly is canonical-equivalent to manual core objects, with no acceptance credit', async t => {
  const f = await scenario(t), expected = normalizedCandidate(f, f.candidate), spec = candidateSpec(expected);
  const evidence = clone(spec.assessments[0].evidence[0]);
  spec.artifactRegistry = {proof: evidence.artifacts[0].path};
  evidence.artifacts = [{alias: 'proof'}];
  spec.evidenceRegistry = {reflexivity: evidence};
  for (const assessment of spec.assessments) assessment.evidence = ['reflexivity'];
  const before = core.canonical(spec), assembled = await build(f, spec);
  assert.equal(core.canonical(spec), before, 'Author input must remain untouched');
  assert.equal(core.canonical(assembled.candidate), core.canonical(expected));
  assert.equal(assembled.check.valid, true);
  assert.equal((await coreCandidate(f, assembled.candidate)).valid, true);
  assert.equal(core.assessCoverage({scan: f.scan, candidate: assembled.candidate}).settled, 0);
  assert.equal(core.assessCoverage({scan: f.scan, candidate: assembled.candidate}).coverageComplete, false);
  const manualReview = normalizedReview(f, reviewFor(f, f.scan, expected)), reviewInput = reviewSpec(manualReview);
  reviewInput.artifactRegistry = {independent: manualReview.entries[0].evidence[0]};
  for (const entry of reviewInput.entries) entry.evidence = [{alias: 'independent'}];
  const reviewed = await buildReview(f, expected, reviewInput);
  assert.equal(core.canonical(reviewed.review), core.canonical(manualReview));
  assert.equal(reviewed.check.valid, true);
  assert.equal((await coreReview(f, expected, reviewed.review)).valid, true);
  assert.equal(core.assessCoverage({scan: f.scan, candidate: expected, review: reviewed.review}).settled, 0, 'Independent review is not supervisor acceptance');
});

test('missing scientific choices and unknown schema fields are not supplied by templates', async t => {
  const f = await scenario(t), original = candidateSpec(f.candidate);
  const mutations = [
    ['author', spec => {delete spec.author;}],
    ['complete', spec => {delete spec.inventory.complete;}],
    ['item kind', spec => {delete spec.inventory.items[0].kind;}],
    ['conditions', spec => {delete spec.inventory.items[0].conditions;}],
    ['units', spec => {delete spec.inventory.items[0].units;}],
    ['dependencies', spec => {delete spec.inventory.items[0].dependencies;}],
    ['obligation dimension', spec => {delete spec.inventory.items[0].obligations[0].dimension;}],
    ['success criterion', spec => {delete spec.inventory.items[0].obligations[0].successCriterion;}],
    ['assessment status', spec => {delete spec.assessments[0].status;}],
    ['assessment outcome', spec => {delete spec.assessments[0].outcome;}],
    ['summary', spec => {delete spec.assessments[0].summary;}],
    ['limitations', spec => {delete spec.assessments[0].limitations;}],
    ['evidence mapping', spec => {delete spec.assessments[0].evidence[0].mapping.conditions;}],
    ['accepted evidence', spec => {spec.assessments[0].evidence = [];}],
    ['empty assessments', spec => {spec.assessments = [];}],
    ['unknown candidate flag', spec => {spec.autoAccept = true;}],
    ['unknown scientific flag', spec => {spec.inventory.items[0].verified = true;}],
  ];
  for (const [name, mutate] of mutations) {
    const spec = clone(original); mutate(spec);
    await assert.rejects(build(f, spec), undefined, name + ' must remain an explicit valid author choice');
  }
  const partial = clone(original);
  Object.assign(partial.assessments[0], {status: 'pending', outcome: 'partial', summary: 'Synthetic derivation still missing', evidence: []});
  const result = await build(f, partial);
  assert.equal(result.candidate.assessments[0].status, 'pending');
  assert.equal(result.candidate.assessments[0].outcome, 'partial');
  assert.equal(result.check.metrics.pending, 1);
  const review = reviewSpec(reviewFor(f, f.scan, result.candidate));
  delete review.entries[0].verdict;
  await assert.rejects(buildReview(f, result.candidate, review), /verdict|missing/i);
  delete review.inventory.checkedAllUnits;
  await assert.rejects(buildReview(f, result.candidate, review));
});

test('quotes resolve all overlapping source units with UTF-16 offsets and never guess ambiguous positions', async t => {
  const source = '😀 Synthetic repeated $x=x$ and $x=x$.\n\nSecond synthetic paragraph.\n\\[z=z\\]\n';
  const f = await scenario(t, {mainText: source}), resource = f.scan.resources.find(value => value.path.endsWith('main.tex'));
  assert.ok(resource);
  assert.throws(() => resolveLocators({root: f.project, scan: f.scan, locator: {resourceId: resource.id, quote: 'x=x'}}), /ambigu|unique|occurrence/i);
  const start = source.lastIndexOf('x=x'), end = start + 3;
  const located = resolveLocators({root: f.project, scan: f.scan, locator: {resourceId: resource.id, quote: 'x=x', start, end}});
  assert.ok(located.length >= 2, 'Both enclosing text block and mathematical source unit must be represented');
  for (const locator of located) {
    assert.equal(locator.start, start); assert.equal(locator.end, end);
    assert.equal(locator.excerptSha256, hash(source.slice(start, end)));
  }
  const quote = source.slice(0, source.indexOf('\n'));
  const wide = resolveLocators({root: f.project, scan: f.scan, locator: {path: resource.path, quote}});
  const expectedUnits = f.scan.units.filter(unit => unit.resourceId === resource.id && unit.start < quote.length && unit.end > 0).map(unit => unit.id);
  assert.deepEqual(new Set(wide.map(value => value.unitId)), new Set(expectedUnits));
  assert.equal(wide.find(value => value.start === 0).excerptSha256, hash(quote));
  for (const locator of [
    {resourceId: resource.id, quote: 'x=x', start: start - 1, end: end - 1},
    {resourceId: resource.id, quote: 'x=x', start: -1, end: 2},
    {resourceId: resource.id, quote: 'x=x', start, end: source.length + 1},
    {resourceId: resource.id, quote: 'x=x', start},
    {resourceId: resource.id, quote: 'not in synthetic source'},
    {resourceId: 'unbound-resource', quote},
    {path: path.join(f.project, 'sources/original_pdfs/synthetic.pdf'), quote},
  ]) assert.throws(() => resolveLocators({root: f.project, scan: f.scan, locator}));
  const asset = f.scan.resources.find(value => value.type === 'asset');
  assert.deepEqual(resolveLocators({root: f.project, scan: f.scan, locator: {resourceId: asset.id, semantic: 'Entire synthetic placeholder image'}}), [{unitId: f.scan.units.find(value => value.resourceId === asset.id).id, semantic: 'Entire synthetic placeholder image'}]);
  assert.throws(() => resolveLocators({root: f.project, scan: f.scan, locator: {resourceId: asset.id}}));
  const raw = located[0];
  assert.throws(() => resolveLocators({root: f.project, scan: f.scan, locator: {...raw, excerptSha256: '0'.repeat(64)}}), /hash/i);
  assert.throws(() => resolveLocators({root: f.project, scan: f.scan, locator: {...raw, start: -1}}), /bounds|range/i);
  assert.throws(() => resolveLocators({root: f.project, scan: f.scan, locator: {resourceId: resource.id, quote: source.slice(1, 2), start: 1, end: 2}}), /surrogate/i);
  const spec = candidateSpec(f.candidate), index = spec.inventory.items.findIndex(item => item.locators.some(locator => f.scan.units.find(unit => unit.id === locator.unitId).resourceId === resource.id));
  spec.inventory.items[index].locators = [{resourceId: resource.id, quote}];
  const expected = normalizedCandidate(f, f.candidate);
  expected.inventory.items[index].locators = wide;
  for (const disposition of expected.inventory.unitDispositions) {
    disposition.itemIds = expected.inventory.items.filter(item => item.locators.some(locator => locator.unitId === disposition.unitId)).map(item => item.id);
    disposition.reason = 'Mapped by explicit item source locators: ' + disposition.itemIds.join(', ');
  }
  refreshBasis(expected);
  assert.equal(core.canonical((await build(f, spec)).candidate), core.canonical(expected), 'Quote shortcut must match manually expanded exact core locators');
  const duplicate = candidateSpec(f.candidate); duplicate.inventory.items[0].locators.push(clone(duplicate.inventory.items[0].locators[0]));
  await assert.rejects(build(f, duplicate), /duplicate/i);
});

test('unit rules and diagnostic dispositions require exact explicit coverage, not silent through-mapping', async t => {
  const f = await scenario(t, {diagnostic: true}), candidate = clone(f.candidate);
  const asset = f.scan.units.find(value => value.kind === 'asset');
  const excludedItem = candidate.inventory.items.find(value => value.locators.some(locator => locator.unitId === asset.id));
  candidate.inventory.items = candidate.inventory.items.filter(value => value.id !== excludedItem.id);
  candidate.assessments = candidate.assessments.filter(value => !excludedItem.obligations.some(obligation => obligation.id === value.obligationId));
  Object.assign(candidate.inventory.unitDispositions.find(value => value.unitId === asset.id), {itemIds: [], reason: 'Explicitly inspected synthetic placeholder excluded'});
  refreshBasis(candidate);
  const original = candidateSpec(candidate);
  assert.ok(f.scan.diagnostics.length);
  const missingUnit = clone(original); missingUnit.inventory.unitRules.pop();
  await assert.rejects(build(f, missingUnit), /unit|rule|cover/i);
  const unknownUnit = clone(original); unknownUnit.inventory.unitRules[0].selector.unitIds = ['unknown-unit'];
  await assert.rejects(build(f, unknownUnit), /unit|rule|unknown/i);
  const noRules = clone(original); noRules.inventory.unitRules = [];
  await assert.rejects(build(f, noRules), /unit|rule|cover/i);
  const missingDiagnostic = clone(original); missingDiagnostic.inventory.diagnosticDispositions = [];
  await assert.rejects(build(f, missingDiagnostic), /diagnostic/i);
  const unresolved = clone(original); unresolved.inventory.diagnosticDispositions[0].resolved = false;
  await assert.rejects(build(f, unresolved), /unresolved|diagnostic/i);
  unresolved.inventory.complete = false;
  const result = await build(f, unresolved);
  assert.equal(result.candidate.inventory.complete, false);
  assert.equal(result.candidate.inventory.diagnosticDispositions[0].resolved, false);
  const unknownDiagnostic = clone(original); unknownDiagnostic.inventory.diagnosticDispositions[0].diagnosticId = 'not-a-diagnostic';
  await assert.rejects(build(f, unknownDiagnostic), /diagnostic/i);
});

test('nonacademic exclusions need explicit constructor reasons and separate independent review reasons', async t => {
  const f = await scenario(t), candidate = clone(f.candidate), asset = f.scan.units.find(value => value.kind === 'asset');
  const excludedItem = candidate.inventory.items.find(value => value.locators.some(locator => locator.unitId === asset.id));
  candidate.inventory.items = candidate.inventory.items.filter(value => value.id !== excludedItem.id);
  candidate.assessments = candidate.assessments.filter(value => !excludedItem.obligations.some(obligation => obligation.id === value.obligationId));
  const disposition = candidate.inventory.unitDispositions.find(value => value.unitId === asset.id);
  disposition.itemIds = []; disposition.reason = 'Explicitly inspected synthetic image placeholder contains no academic assertion';
  refreshBasis(candidate);
  const spec = candidateSpec(candidate), {candidate: assembled} = await build(f, spec);
  assert.deepEqual(assembled.inventory.unitDispositions.find(value => value.unitId === asset.id), disposition);
  const absentReason = clone(spec); absentReason.inventory.unitRules.find(rule => rule.selector.unitIds.includes(asset.id)).reason = '';
  await assert.rejects(build(f, absentReason), /reason|rule/i);
  const review = reviewSpec(reviewFor(f, f.scan, assembled));
  assert.equal(review.inventory.unitExclusions.length, 1);
  const missing = clone(review); missing.inventory.unitExclusions = [];
  await assert.rejects(buildReview(f, assembled, missing), /exclusion/i);
  const unexplained = clone(review); unexplained.inventory.unitExclusions[0].reason = '';
  await assert.rejects(buildReview(f, assembled, unexplained), /reason|exclusion/i);
  const {review: reviewed} = await buildReview(f, assembled, review);
  assert.notEqual(reviewed.inventory.unitExclusions[0].reason, disposition.reason);
  assert.equal((await coreReview(f, assembled, reviewed)).valid, true);
});

test('artifact shortcuts hash existing in-scope files but reject stale, unknown, escaped and private references', async t => {
  const f = await scenario(t), original = candidateSpec(f.candidate), artifact = original.assessments[0].evidence[0].artifacts[0];
  const stale = clone(original); stale.assessments[0].evidence[0].artifacts = [{...artifact, sha256: '0'.repeat(64)}];
  await assert.rejects(build(f, stale), /hash|SHA/i);
  const unknownAlias = clone(original); unknownAlias.assessments[0].evidence[0].artifacts = [{alias: 'not-declared'}];
  await assert.rejects(build(f, unknownAlias), /alias|registry|unknown/i);
  const unknownEvidence = clone(original); unknownEvidence.assessments[0].evidence = ['not-declared'];
  await assert.rejects(build(f, unknownEvidence), /alias|registry|unknown/i);
  const escaped = clone(original); escaped.assessments[0].evidence[0].artifacts = ['../not-a-project-file.txt'];
  await assert.rejects(build(f, escaped), /travers|outside|escape/i);
  const privateRef = f.review.entries[0].evidence[0];
  const leaked = clone(original); leaked.assessments[0].evidence[0].artifacts = [privateRef.path];
  await assert.rejects(build(f, leaked), /outside|work|private|root/i);
  const sibling = f.put(cleanRelative + '/coverage_work/r0001/c001/sibling.txt', 'Sibling scientific output must not supply this paper');
  const borrowed = clone(original); borrowed.assessments[0].evidence[0].artifacts = [sibling];
  await assert.rejects(build(f, borrowed), /outside|paper|root/i);
  const {candidate} = await build(f, original), review = reviewSpec(reviewFor(f, f.scan, candidate));
  review.entries[0].evidence = [artifact.path];
  await assert.rejects(buildReview(f, candidate, review), /independent|review|constructor|outside/i);
  const copied = f.put(cleanRelative + '/coverage_verifications/origin/c001/copied.txt', fs.readFileSync(path.resolve(f.project, artifact.path)));
  review.entries[0].evidence = [copied.path];
  await assert.rejects(buildReview(f, candidate, review), /independent|constructor|SHA|alias/i);
});

test('legacy shortcuts bind real immutable claims but never invent applicability, roles or scientific strength', async t => {
  const f = await scenario(t), candidate = clone(f.candidate);
  candidate.inventory.items[0].obligations[0].kind = 'empirical';
  candidate.inventory.items[0].obligations[0].dimension = 'simulationValidation';
  refreshBasis(candidate);
  const evidence = {kind: 'reuse', method: 'numeric_test', artifacts: [{path: f.answer, sha256: digest(f.answer)}], mapping: {scope: 'Exact single synthetic legacy sample only', conditions: 'Only the explicitly reported synthetic conditions', dependencyCompatibility: 'Same definitions and sample; no analytic generalization'}, legacy: {...f.firstPass, claimIds: ['origin:c0001']}};
  candidate.assessments[0].evidence = [evidence];
  const spec = candidateSpec(candidate);
  spec.assessments[0].evidence = [{...clone(evidence), claimIds: ['origin:c0001']}];
  delete spec.assessments[0].evidence[0].legacy;
  const assembled = await build(f, spec);
  assert.equal(core.canonical(assembled.candidate), core.canonical(normalizedCandidate(f, candidate)));
  assert.deepEqual(assembled.candidate.assessments[0].evidence[0].legacy, evidence.legacy);
  for (const field of ['scope', 'conditions', 'dependencyCompatibility']) {
    const missing = clone(spec); delete missing.assessments[0].evidence[0].mapping[field];
    await assert.rejects(build(f, missing), /mapping|missing|explicit/i);
  }
  const nonexistent = clone(spec); nonexistent.assessments[0].evidence[0].claimIds = ['origin:c9999'];
  await assert.rejects(build(f, nonexistent), /claim/i);
  const wrongRole = clone(spec); wrongRole.assessments[0].evidence[0].method = 'analytic_derivation';
  await assert.rejects(build(f, wrongRole), /role|matching|evidence/i);
  const generalization = clone(spec); generalization.inventory.items[0].obligations[0].kind = 'analytic';
  await assert.rejects(build(f, generalization), /numeric|proof|kind/i);
  const wholeResult = clone(spec); wholeResult.assessments[0].evidence[0].artifacts = [f.firstPass.result];
  await assert.rejects(build(f, wholeResult), /matching|artifact|claim/i);
  const pending = clone(spec); Object.assign(pending.assessments[0], {status: 'pending', outcome: 'partial'});
  const partial = await build(f, pending);
  assert.equal(partial.candidate.assessments[0].outcome, 'partial');
  assert.equal(partial.candidate.assessments[0].status, 'pending');
});

test('retention keeps exact accepted assessments only; a changed transitive dependency cannot be retained', async t => {
  const f = await scenario(t), previousCandidate = normalizedCandidate(f, f.candidate);
  const previousReview = normalizedReview(f, reviewFor(f, f.scan, previousCandidate));
  const previous = {candidate: previousCandidate, sha256: objectHash(previousCandidate), review: previousReview, decision: decisionFor(f.scan, previousCandidate, previousReview)};
  const spec = candidateSpec(previousCandidate); spec.author = 'synthetic-worker-c002';
  spec.retainObligationIds = spec.assessments.map(value => value.obligationId); spec.assessments = [];
  const {candidate} = await build(f, spec, previous);
  assert.equal(candidate.revision, 2); assert.equal(candidate.predecessorSha256, previous.sha256);
  assert.equal(core.canonical(candidate.assessments), core.canonical(previousCandidate.assessments));
  const manualReview = reviewFor(f, f.scan, candidate, {reviewer: 'synthetic-reviewer-c002'}), reviewInput = reviewSpec(manualReview);
  reviewInput.retainedObligationIds = spec.retainObligationIds; reviewInput.entries = [];
  const {review} = await buildReview(f, candidate, reviewInput, previous, 'synthetic-reviewer-c002');
  assert.deepEqual(review.retainedObligationIds, spec.retainObligationIds);
  assert.equal((await coreReview(f, candidate, review, previous)).valid, true);
  const changed = clone(spec); changed.inventory.items[0].conditions.push('Changed synthetic ancestor condition');
  await assert.rejects(build(f, changed, previous), /retain|changed|basis|dependency/i);
  const unaccepted = clone(previous); unaccepted.decision.acceptedObligationIds.shift();
  await assert.rejects(build(f, spec, unaccepted), /retain|accept/i);
  await assert.rejects(build(f, spec), /retain|previous|predecessor/i);
  const fresh = candidateSpec(previousCandidate); fresh.author = 'synthetic-worker-c002';
  fresh.inventory.items[0].conditions.push('Changed synthetic ancestor condition');
  const changedCandidate = (await build(f, fresh, previous)).candidate;
  await assert.rejects(buildReview(f, changedCandidate, reviewInput, previous, 'synthetic-reviewer-c002'), /retain|changed|dependency|basis/i);
});

test('failed historical executions stay visible as diagnostics and cannot be promoted by a shortcut', async t => {
  const f = await scenario(t, {failedRun: true}), spec = candidateSpec(f.candidate);
  assert.equal(f.output.state, 'failed');
  spec.inventory.items[0].obligations[0].kind = 'empirical';
  spec.inventory.items[0].obligations[0].dimension = 'simulationValidation';
  spec.assessments[0].evidence = [{kind: 'reuse', method: 'numeric_test', artifacts: [f.answer], claimIds: ['origin:c0001'], mapping: {scope: 'Only the failed synthetic process output', conditions: 'Same single sample', dependencyCompatibility: 'Failure remains a recorded limitation'}}];
  await assert.rejects(build(f, spec), /failed|completed|decisive/i);
  Object.assign(spec.assessments[0], {status: 'internal_gap', outcome: 'partial', summary: 'Failed historical output retained without acceptance credit'});
  const {candidate} = await build(f, spec);
  assert.equal(candidate.assessments[0].status, 'internal_gap');
  assert.equal(candidate.assessments[0].outcome, 'partial');
  assert.equal(core.assessCoverage({scan: f.scan, candidate}).coverageComplete, false);
  assert.equal((await coreCandidate(f, candidate)).valid, true);
});

test('execution shortcuts preserve the original receipt, output and same-paper input gates', async t => {
  const f = await scenario(t), candidate = clone(f.candidate);
  candidate.inventory.items[0].obligations[0].kind = 'empirical';
  candidate.inventory.items[0].obligations[0].dimension = 'simulationValidation';
  candidate.assessments[0].evidence = [executedEvidence(f)];
  refreshBasis(candidate);
  const spec = candidateSpec(candidate), originalRef = spec.assessments[0].evidence[0].execution.receipt;
  const receipt = JSON.parse(fs.readFileSync(path.resolve(f.project, originalRef.path), 'utf8'));
  const assembled = await build(f, spec);
  assert.equal(core.canonical(assembled.candidate), core.canonical(normalizedCandidate(f, candidate)));
  assert.equal(digest(path.resolve(f.project, originalRef.path)), originalRef.sha256, 'Assembly does not rewrite execution evidence');
  const missing = clone(spec); delete missing.assessments[0].evidence[0].execution;
  await assert.rejects(build(f, missing), /execution receipt/i);
  const mutations = [
    ['unsuccessful-exit', value => {value.exitCode = 1;}],
    ['no-worker-count', value => {delete value.workerCount;}],
    ['zero-workers', value => {value.workerCount = 0;}],
    ['no-output', value => {value.outputs = [];}],
    ['wrong-output', value => {value.outputs = [f.put(cleanRelative + '/coverage_work/origin/c001/not-the-output.json', {synthetic: 'wrong output'})];}],
    ['foreign-input', value => {value.inputs = [f.put(cleanRelative + '/coverage_work/r0001/c001/foreign-input.txt', 'Synthetic sibling input')];}],
  ];
  for (const [name, mutate] of mutations) {
    const changedReceipt = clone(receipt); mutate(changedReceipt);
    const changed = clone(spec);
    changed.assessments[0].evidence[0].execution.receipt = f.put(cleanRelative + '/coverage_work/origin/c001/' + name + '.json', changedReceipt);
    await assert.rejects(build(f, changed), undefined, name + ' must still fail the original core gate');
  }
});

test('NA, refutation and external blockers retain their explicit scientific obligations', async t => {
  const f = await scenario(t), original = candidateSpec(f.candidate);
  const notApplicable = clone(original);
  notApplicable.assessments[0].outcome = 'not_applicable';
  notApplicable.assessments[0].applicabilityReason = 'Synthetic source definition claims no empirical experiment';
  notApplicable.assessments[0].evidence[0].method = 'source_consistency';
  const na = await build(f, notApplicable);
  assert.equal(na.candidate.assessments[0].outcome, 'not_applicable');
  const missingReason = clone(notApplicable); delete missingReason.assessments[0].applicabilityReason;
  await assert.rejects(build(f, missingReason), /reason|applicability/i);
  const missingSourceCheck = clone(notApplicable); missingSourceCheck.assessments[0].evidence[0].method = 'analytic_derivation';
  await assert.rejects(build(f, missingSourceCheck), /source-consistency/i);
  const refuted = clone(original); refuted.assessments[0].outcome = 'refuted';
  await assert.rejects(build(f, refuted), /counterexample/i);
  refuted.assessments[0].evidence[0].method = 'counterexample';
  assert.equal((await build(f, refuted)).candidate.assessments[0].outcome, 'refuted');
  const blocked = clone(original), assessment = blocked.assessments[0];
  Object.assign(assessment, {status: 'external_blocked', outcome: 'inconclusive', summary: 'Synthetic external data unavailable', evidence: [], blocker: {missing: 'Synthetic original sample release', affectedObligations: [assessment.obligationId], attemptedAlternatives: ['Inspected all bound synthetic source resources'], whyExternal: 'Exact samples reside with outside synthetic holder', releaseCondition: 'Exact sample release is supplied'}});
  const result = await build(f, blocked);
  assert.equal(result.check.metrics.externalBlocked, 1);
  assert.equal(core.assessCoverage({scan: f.scan, candidate: result.candidate}).coverageComplete, false);
  for (const field of ['missing', 'affectedObligations', 'attemptedAlternatives', 'whyExternal', 'releaseCondition']) {
    const absent = clone(blocked); delete absent.assessments[0].blocker[field];
    await assert.rejects(build(f, absent), /blocker|missing/i);
  }
});

export {candidateSpec, reviewSpec};
