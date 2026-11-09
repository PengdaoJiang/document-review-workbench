import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {canonical, hash} from '../coverage-core.mjs';
import {validateCandidateScope, validateReviewScope} from '../coverage-scope.mjs';

// Scope-only synthetic fixtures; no production state, paper, run, vendor,
// symbolic kernel, or scientific evidence is opened. WorkerCount=1, no child
// process/thread pool. Run with node --test --test-concurrency=1.
const objectHash = value => hash(canonical(value));
const clone = value => structuredClone(value);
const id1 = 'origin:i0001:o01', id2 = 'origin:i0002:o01';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'network3-scope-'));
  t.after(() => {
    const absolute = fs.realpathSync(root);
    assert.equal(path.dirname(absolute).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(absolute), /^network3-scope-/);
    fs.rmSync(absolute, {recursive: true, force: true});
  });
  const put = (relative, bytes) => {
    const absolute = path.resolve(root, relative), suffix = path.relative(root, absolute);
    assert.ok(suffix && suffix !== '..' && !suffix.startsWith('..' + path.sep) && !path.isAbsolute(suffix));
    fs.mkdirSync(path.dirname(absolute), {recursive: true}); fs.writeFileSync(absolute, bytes);
    return {path: relative.replaceAll('\\', '/'), sha256: hash(bytes)};
  };
  const paragraphs = ['😀 For every real x, x=x.\n', 'Under the stated Gaussian model, the error usually approaches the bound statistically.\n'];
  const source = paragraphs.join(''), sourceRef = put('bound/main.tex', source);
  const resource = {id: 'source-main', type: 'text', ...sourceRef};
  let start = 0;
  const units = paragraphs.map((quote, i) => { const unit = {id: 'unit-' + (i + 1), resourceId: resource.id, start, end: start + quote.length, kind: 'text_block', excerptSha256: hash(quote)}; start += quote.length; return unit; });
  const scan = {schemaVersion: 1, paperId: 'origin', inputVersion: 'synthetic-bound-v1', resources: [resource], units, diagnostics: []};
  const constructor = put('research_followup/reproduction_clean/coverage_work/origin/c001/proof.txt', 'Synthetic constructor assertion only, not real science.');
  const items = units.map((unit, i) => {
    const id = 'origin:i' + String(i + 1).padStart(4, '0');
    return {id, kind: i ? 'statement' : 'formula', text: paragraphs[i].trim(), locators: [{unitId: unit.id, start: unit.start, end: unit.end, excerptSha256: unit.excerptSha256}], conditions: i ? ['Stated Gaussian model'] : ['Real x'], units: 'dimensionless', dependencies: [],
      obligations: [{id: id + ':o01', dimension: i ? 'simulationValidation' : 'formulaDerivation', kind: i ? 'empirical' : 'identity', statement: paragraphs[i].trim(), conditions: i ? ['Stated Gaussian model'] : ['Real x'], successCriterion: i ? 'Compare a stated metric with uncertainty under source conditions' : 'A derivation for every real x'}]};
  });
  const candidate = {schemaVersion: 1, paperId: 'origin', revision: 1, scanSha256: objectHash(scan), predecessorSha256: null, author: 'constructor-1', inventory: {complete: true, items, unitDispositions: units.map((unit, i) => ({unitId: unit.id, itemIds: [items[i].id], reason: 'Synthetic source mapped'})), diagnosticDispositions: []}, assessments: items.map(item => ({obligationId: item.obligations[0].id, status: 'accepted', outcome: 'supported', summary: 'Synthetic scoped assessment', limitations: [], basisItemHashes: {[item.id]: objectHash(item)}, evidence: [{kind: 'new', method: 'source_consistency', artifacts: [constructor], mapping: {scope: 'Synthetic only', conditions: 'Declared conditions', dependencyCompatibility: 'No dependencies'}}]}))};
  const contract = {schemaVersion: 1, paperId: 'origin', revision: 1, scanSha256: objectHash(scan), candidateSha256: objectHash(candidate), author: candidate.author, inventory: {complete: true, missingClaims: [], notes: 'Explicit synthetic source inventory, not a real completeness judgment'}, legacyRetainedObligationIds: [], cards: items.map((item, i) => ({itemId: item.id, itemSha256: objectHash(item), anchors: [{id: 'anchor-' + i, resourceId: resource.id, resourceSha256: resource.sha256, unitId: units[i].id, start: units[i].start, end: units[i].end, excerptSha256: units[i].excerptSha256, quote: paragraphs[i]}], claims: [{id: 'claim-' + i, anchorIds: ['anchor-' + i], statement: paragraphs[i].trim(), kind: i ? 'empirical' : 'identity', modality: i ? 'usually; not guaranteed' : 'asserted identity', quantifier: i ? 'qualified trend under stated model' : 'every real x', conditions: clone(item.conditions), empiricalTarget: {kind: i ? 'statistical' : 'not_empirical', description: i ? 'Scientific statistical agreement, not original seeds or exact scatter' : 'Algebraic identity', identityRequirements: []}}]})), alignments: items.map((item, i) => ({obligationId: item.obligations[0].id, obligationSha256: objectHash(item.obligations[0]), assessmentSha256: objectHash(candidate.assessments[i]), claimIds: ['claim-' + i], relation: 'original', additionalAssumptions: [], assessedTarget: i ? 'statistical' : 'not_empirical', reason: 'Explicit source-target mapping; correctness remains for independent review'}))};
  const f = {root, put, source, scan, candidate, contract, previous: null};
  return withReview(f);
}
function withReview(f, reviewer = 'reviewer-' + f.candidate.revision) {
  const revision = f.candidate.revision, evidence = f.put('research_followup/reproduction_clean/coverage_verifications/origin/c' + String(revision).padStart(3, '0') + '/scope-note.txt', 'Independent synthetic scope inspection ' + revision);
  f.review = {schemaVersion: 1, paperId: 'origin', revision, scanSha256: objectHash(f.scan), candidateSha256: objectHash(f.candidate), reviewerAgent: reviewer, inventory: {complete: true, resourceIds: f.scan.resources.map(r => r.id), checkedAllUnits: true, missingItems: [], notes: 'Synthetic inventory checked independently', unitExclusions: []}, entries: f.candidate.assessments.map(a => ({obligationId: a.obligationId, assessmentSha256: objectHash(a), verdict: 'accept', reason: 'Synthetic independent decision', evidence: [evidence]})), retainedObligationIds: []};
  f.scopeReview = {schemaVersion: 1, paperId: 'origin', revision, scanSha256: objectHash(f.scan), candidateSha256: objectHash(f.candidate), contractSha256: objectHash(f.contract), reviewSha256: objectHash(f.review), reviewerAgent: reviewer, inventory: {complete: true, checkedUnlistedSource: true, missingClaims: [], notes: 'Unlisted synthetic regions checked explicitly', evidence: [evidence]}, cards: f.contract.cards.map(card => ({itemId: card.itemId, cardSha256: objectHash(card), verdict: 'aligned', reason: 'Source qualifiers and target independently compared', evidence: [evidence]})), entries: f.contract.alignments.map(a => ({obligationId: a.obligationId, alignmentSha256: objectHash(a), verdict: 'aligned', reason: 'Independent source-to-obligation comparison', evidence: [evidence]})), retainedItemIds: [], retainedObligationIds: []};
  return f;
}
function sync(f) {
  f.contract.candidateSha256 = objectHash(f.candidate);
  for (const card of f.contract.cards) card.itemSha256 = objectHash(f.candidate.inventory.items.find(i => i.id === card.itemId));
  for (const alignment of f.contract.alignments) {
    alignment.obligationSha256 = objectHash(f.candidate.inventory.items.flatMap(i => i.obligations).find(o => o.id === alignment.obligationId));
    alignment.assessmentSha256 = objectHash(f.candidate.assessments.find(a => a.obligationId === alignment.obligationId));
  }
  return withReview(f);
}
const candidateCheck = f => validateCandidateScope({root: f.root, scan: f.scan, candidate: f.candidate, candidateSha256: objectHash(f.candidate), contract: f.contract, author: f.candidate.author, previous: f.previous});
const reviewCheck = (f, extra = {}) => validateReviewScope({root: f.root, scan: f.scan, candidate: f.candidate, candidateSha256: objectHash(f.candidate), contract: f.contract, contractSha256: objectHash(f.contract), review: f.review, scopeReview: f.scopeReview, reviewer: f.review.reviewerAgent, worker: f.candidate.author, previous: f.previous, ...extra});
function sealReview(f) { f.scopeReview.reviewSha256 = objectHash(f.review); }
function previous(f, scoped = true) {
  return {candidate: clone(f.candidate), sha256: objectHash(f.candidate), review: clone(f.review), decision: {schemaVersion: 1, paperId: f.candidate.paperId, revision: f.candidate.revision, scanSha256: objectHash(f.scan), candidateSha256: objectHash(f.candidate), reviewSha256: objectHash(f.review), decision: 'accept_snapshot', inventoryAccepted: true, acceptedObligationIds: f.candidate.assessments.map(a => a.obligationId), supervisor: 'synthetic-supervisor', rationale: 'Synthetic only'}, ...(scoped ? {contract: clone(f.contract), contractSha256: objectHash(f.contract), scopeReview: clone(f.scopeReview), scopeReviewSha256: objectHash(f.scopeReview)} : {})};
}
function next(f, old) {
  f.previous = old; f.candidate.revision++; f.candidate.author = 'constructor-' + f.candidate.revision; f.candidate.predecessorSha256 = old.sha256;
  f.contract.revision = f.candidate.revision; f.contract.author = f.candidate.author;
  return sync(f);
}

test('exact source/card/obligation binding remains mechanical and does not mutate input', t => {
  const f = fixture(t), before = canonical({candidate: f.candidate, contract: f.contract, review: f.review, scopeReview: f.scopeReview});
  const result = candidateCheck(f); assert.equal(result.valid, true); assert.match(result.verification, /not_scientific_acceptance/); assert.deepEqual(result.eligibleObligationIds, [id1, id2]);
  assert.deepEqual(reviewCheck(f).eligibleObligationIds, [id1, id2]); assert.equal(reviewCheck(f).inventoryEligible, true);
  assert.equal(canonical({candidate: f.candidate, contract: f.contract, review: f.review, scopeReview: f.scopeReview}), before);
});

test('no default alignment, modal qualifier, target, inventory or pass fields', t => {
  const f = fixture(t), original = clone(f.contract);
  for (const mutate of [c => delete c.inventory.complete, c => delete c.legacyRetainedObligationIds, c => delete c.cards[0].claims[0].modality, c => delete c.cards[0].claims[0].quantifier, c => delete c.cards[0].claims[0].conditions, c => delete c.cards[0].claims[0].empiricalTarget, c => delete c.alignments[0].relation, c => delete c.alignments[0].additionalAssumptions, c => c.autoAlign = true]) { f.contract = clone(original); mutate(f.contract); assert.throws(() => candidateCheck(f)); }
  f.contract = original; delete f.scopeReview.entries[0].verdict; assert.throws(() => reviewCheck(f), /missing verdict/);
});

test('missing, duplicate, invented, unmapped or stale identities fail closed', t => {
  const f = fixture(t), original = clone(f.contract);
  const changes = [c => c.cards.pop(), c => c.cards.push(clone(c.cards[0])), c => c.cards[0].itemId = 'origin:i9999', c => c.alignments.pop(), c => c.alignments.push(clone(c.alignments[0])), c => c.alignments[0].obligationSha256 = '0'.repeat(64), c => c.alignments[0].assessmentSha256 = '0'.repeat(64), c => c.cards[0].itemSha256 = '0'.repeat(64), c => c.cards[0].claims.push({...clone(c.cards[0].claims[0]), id: 'omitted-original'}), c => c.alignments[0].claimIds = ['claim-1']];
  for (const mutate of changes) { f.contract = clone(original); mutate(f.contract); assert.throws(() => candidateCheck(f)); }
});

test('quotes bind exact resource, source unit and UTF-16 span; no stale text or surrogate split', t => {
  const f = fixture(t), original = clone(f.contract);
  for (const mutate of [a => a.resourceId = 'different-source', a => a.resourceSha256 = '0'.repeat(64), a => a.unitId = 'unit-2', a => a.quote = 'invented quote', a => a.excerptSha256 = '0'.repeat(64), a => a.start = 1, a => a.end = f.source.length + 1]) { f.contract = clone(original); mutate(f.contract.cards[0].anchors[0]); assert.throws(() => candidateCheck(f)); }
  f.contract = original; fs.appendFileSync(path.join(f.root, 'bound/main.tex'), 'tamper'); assert.throws(() => candidateCheck(f), /hash/i);
});

test('same resource with an unrelated source span is not meaningful candidate overlap', t => {
  const f = fixture(t), anchor = f.contract.cards[0].anchors[0], other = f.contract.cards[1].anchors[0];
  Object.assign(anchor, {...other, id: anchor.id}); assert.throws(() => candidateCheck(f), /overlap/);
});

test('source anchor must overlap a source token, not punctuation or whitespace alone', t => {
  const f = fixture(t), item = f.candidate.inventory.items[0], anchor = f.contract.cards[0].anchors[0];
  item.locators[0].start = anchor.end - 2; item.locators[0].end = anchor.end; item.locators[0].excerptSha256 = hash('.\n'); sync(f);
  assert.throws(() => candidateCheck(f), /overlap/);
});

test('original additional assumptions and empirical-target substitution cannot be accepted', t => {
  const f = fixture(t); f.contract.alignments[0].additionalAssumptions = ['Only x=1']; withReview(f);
  assert.deepEqual(candidateCheck(f).blockedObligationIds, [id1]); assert.throws(() => reviewCheck(f), /accept\/retention conflicts/);
  f.review.entries[0].verdict = 'needs_work'; f.scopeReview.entries[0].verdict = 'needs_work'; sealReview(f); assert.deepEqual(reviewCheck(f).blockedObligationIds, [id1]);
  f.contract.alignments[0].additionalAssumptions = []; f.contract.alignments[1].assessedTarget = 'exact_historical'; withReview(f);
  assert.ok(candidateCheck(f).issues.some(i => i.reasons.includes('original_and_assessed_empirical_targets_differ'))); assert.throws(() => reviewCheck(f));
});

test('a restricted subclaim or stronger variant cannot silently replace its original parent', t => {
  const f = fixture(t); f.contract.alignments[0].relation = 'subclaim'; assert.throws(() => candidateCheck(f), /preserved original-target/);
  f.contract.alignments[0].relation = 'stronger_variant'; assert.throws(() => candidateCheck(f), /preserved original-target/);
});

test('restricted auxiliary evidence may be preserved while original obligation remains unresolved', t => {
  const f = fixture(t), item = f.candidate.inventory.items[0], original = f.candidate.assessments[0];
  item.obligations.push({...clone(item.obligations[0]), id: 'origin:i0001:o02', statement: 'Only x=1 is tested', conditions: ['x=1']});
  original.status = 'internal_gap'; original.outcome = 'partial';
  f.candidate.assessments.push({...clone(original), obligationId: 'origin:i0001:o02', status: 'accepted', outcome: 'supported', basisItemHashes: {[item.id]: objectHash(item)}});
  original.basisItemHashes = {[item.id]: objectHash(item)};
  f.contract.alignments.push({...clone(f.contract.alignments[0]), obligationId: 'origin:i0001:o02', relation: 'narrower_variant', additionalAssumptions: ['x=1'], reason: 'A narrower test, explicitly not the universal claim'}); sync(f);
  f.review.entries[0].verdict = 'needs_work'; sealReview(f);
  assert.equal(candidateCheck(f).valid, true); assert.ok(reviewCheck(f).eligibleObligationIds.includes('origin:i0001:o02')); assert.ok(!reviewCheck(f).eligibleObligationIds.includes(id1));
});

test('random seeds, old executables and plotpoint identity are not statistical prerequisites', t => {
  const f = fixture(t), target = f.contract.cards[1].claims[0].empiricalTarget;
  target.identityRequirements = [{object: 'Original random seeds and executable', anchorIds: ['anchor-1'], reason: 'Demanded exact reproduction'}];
  assert.throws(() => candidateCheck(f), /not an automatic/);
  target.identityRequirements = []; f.candidate.assessments[1].status = 'external_blocked'; f.candidate.assessments[1].outcome = 'inconclusive';
  f.contract.alignments[1].blockerBasis = {kind: 'historical_identity', anchorIds: ['anchor-1'], reason: 'Missing original seed/plot identity'}; sync(f);
  assert.ok(candidateCheck(f).issues.some(i => i.reasons.includes('historical_identity_not_source_requirement')));
  f.review.entries[1].verdict = 'needs_work'; f.scopeReview.entries[1].verdict = 'needs_work'; sealReview(f); assert.ok(reviewCheck(f).blockedObligationIds.includes(id2));
});

test('asserted necessary historical objects need explicit source anchors, not free text', t => {
  const f = fixture(t), target = f.contract.cards[1].claims[0].empiricalTarget;
  target.kind = 'exact_historical'; target.identityRequirements = []; assert.throws(() => candidateCheck(f), /source-bound/);
  target.identityRequirements = [{object: 'Exact historical plot points', anchorIds: [], reason: 'Explicit source contract requires exact identity'}]; assert.throws(() => candidateCheck(f), /explicit strings/);
  target.identityRequirements[0].anchorIds = ['missing']; assert.throws(() => candidateCheck(f), /source quotes/);
  // Truth of this declaration is a human comparison, not keyword classification.
  target.identityRequirements[0].anchorIds = ['anchor-1']; f.contract.alignments[1].assessedTarget = 'exact_historical'; withReview(f); assert.equal(candidateCheck(f).valid, true);
  f.scopeReview.entries[1].verdict = 'needs_work'; assert.throws(() => reviewCheck(f), /accept\/retention conflicts/);
});

test('not_author_claim cannot erase an original source obligation or create positive credit', t => {
  const f = fixture(t); f.contract.alignments[0].relation = 'not_author_claim'; assert.throws(() => candidateCheck(f), /cannot erase/);
  f.contract.alignments[0].claimIds = []; f.contract.cards[0].claims = []; withReview(f);
  assert.ok(candidateCheck(f).blockedObligationIds.includes(id1)); assert.throws(() => reviewCheck(f));
  f.candidate.assessments[0].outcome = 'not_applicable'; f.candidate.assessments[0].applicabilityReason = 'Synthetic extra guarantee, not asserted in source'; sync(f);
  assert.ok(reviewCheck(f).eligibleObligationIds.includes(id1));
});

test('unknown or needs_work survives and cannot inherit an accept recommendation', t => {
  const f = fixture(t); f.scopeReview.cards[0].verdict = 'unknown'; assert.throws(() => reviewCheck(f), /accept\/retention conflicts/);
  f.review.entries[0].verdict = 'needs_work'; sealReview(f); assert.deepEqual(reviewCheck(f).blockedObligationIds, [id1]);
  f.scopeReview.cards[0].verdict = 'aligned'; f.scopeReview.entries[1].verdict = 'needs_work'; assert.throws(() => reviewCheck(f));
});

test('explicitly unknown original alignment preserves the unresolved parent without default pass', t => {
  const f = fixture(t); f.contract.alignments[0].relation = 'unknown'; withReview(f);
  assert.deepEqual(candidateCheck(f).blockedObligationIds, [id1]); assert.throws(() => reviewCheck(f), /accept\/retention conflicts/);
  f.review.entries[0].verdict = 'needs_work'; f.scopeReview.entries[0].verdict = 'unknown'; sealReview(f);
  assert.deepEqual(reviewCheck(f).eligibleObligationIds, [id2]);
});

test('review must cover exact cards and alignments and bind frozen versions', t => {
  const f = fixture(t), original = clone(f.scopeReview);
  for (const mutate of [r => r.cards.pop(), r => r.entries.pop(), r => r.entries.push(clone(r.entries[0])), r => r.cards[0].cardSha256 = '0'.repeat(64), r => r.entries[0].alignmentSha256 = '0'.repeat(64), r => r.contractSha256 = '0'.repeat(64), r => r.reviewSha256 = '0'.repeat(64), r => r.candidateSha256 = '0'.repeat(64)]) { f.scopeReview = clone(original); mutate(f.scopeReview); assert.throws(() => reviewCheck(f)); }
});

test('registered and historical constructor identities cannot independently review', t => {
  const f = fixture(t); assert.throws(() => reviewCheck(f, {reviewer: f.candidate.author}), /independent/);
  assert.throws(() => reviewCheck(f, {historicalConstructors: [f.review.reviewerAgent]}), /independent/);
  f.scopeReview.reviewerAgent = 'unregistered'; assert.throws(() => reviewCheck(f), /independent/);
});

test('review needs real independent same-revision refs, not copied constructor artifacts', t => {
  const f = fixture(t), old = clone(f.scopeReview.cards[0].evidence);
  f.scopeReview.cards[0].evidence = []; assert.throws(() => reviewCheck(f), /independent evidence/);
  f.scopeReview.cards[0].evidence = clone(f.candidate.assessments[0].evidence[0].artifacts); assert.throws(() => reviewCheck(f), /independent review root/);
  const copied = f.put('research_followup/reproduction_clean/coverage_verifications/origin/c001/copied.txt', fs.readFileSync(path.join(f.root, f.candidate.assessments[0].evidence[0].artifacts[0].path)));
  f.scopeReview.cards[0].evidence = [copied]; assert.throws(() => reviewCheck(f), /aliases constructor/);
  f.scopeReview.cards[0].evidence = old; old[0].sha256 = '0'.repeat(64); assert.throws(() => reviewCheck(f), /hash/);
});

test('scope rejects cross-paper/private evidence before any content read or hash', t => {
  const f = fixture(t), outside = f.put('research_followup/reproduction_clean/coverage_verifications/r0001/c001/private.txt', 'PRIVATE SENTINEL MUST NOT BE READ');
  f.scopeReview.cards[0].evidence = [outside]; const originalRead = fs.readFileSync; let forbiddenReads = 0;
  fs.readFileSync = function(filename, ...args) { if (path.resolve(String(filename)) === path.resolve(f.root, outside.path)) forbiddenReads++; return originalRead.call(this, filename, ...args); };
  try { assert.throws(() => reviewCheck(f), /this revision independent review root/); assert.equal(forbiddenReads, 0); }
  finally { fs.readFileSync = originalRead; }
});

test('incomplete inventory never becomes whole-paper scope eligibility', t => {
  const f = fixture(t); f.candidate.inventory.complete = false; sync(f); assert.throws(() => candidateCheck(f), /complete scope/);
  f.contract.inventory.complete = false; f.contract.inventory.missingClaims = ['Unresolved omitted premise']; withReview(f);
  assert.equal(candidateCheck(f).inventoryEligible, false); assert.throws(() => reviewCheck(f), /complete scope review/);
  f.scopeReview.inventory.complete = false; f.scopeReview.inventory.checkedUnlistedSource = false; f.scopeReview.inventory.missingClaims = ['Unresolved omitted premise'];
  assert.equal(reviewCheck(f).inventoryEligible, false);
});

test('first enrollment preserves exact accepted legacy credit without new cards or scientific reruns', t => {
  const f = fixture(t), old = previous(f, false); next(f, old);
  f.contract.legacyRetainedObligationIds = [id1, id2]; f.contract.cards = []; f.contract.alignments = []; withReview(f);
  f.review.entries = []; f.review.retainedObligationIds = [id1, id2]; sealReview(f);
  const result = reviewCheck(f); assert.deepEqual(result.inheritedLegacyIds, [id1, id2]); assert.deepEqual(result.eligibleObligationIds, []); assert.deepEqual(result.cardHashes, {});
});

test('legacy exemption rejects unaccepted, changed items, changed assessments and transitive premises', t => {
  for (const type of ['unaccepted', 'item', 'assessment', 'premise']) {
    const f = fixture(t), old = previous(f, false); next(f, old); f.contract.legacyRetainedObligationIds = [id1, id2]; f.contract.cards = []; f.contract.alignments = [];
    if (type === 'unaccepted') old.decision.acceptedObligationIds = [id2];
    if (type === 'item') f.candidate.inventory.items[0].conditions.push('new condition');
    if (type === 'assessment') f.candidate.assessments[0].summary += ' changed';
    if (type === 'premise') f.candidate.assessments[0].basisItemHashes.extra = '0'.repeat(64);
    sync(f); assert.throws(() => candidateCheck(f), /legacy retention/);
  }
});

test('new or previously unaccepted obligation is never hidden by legacy retention', t => {
  const f = fixture(t), old = previous(f, false); old.decision.acceptedObligationIds = [id1]; next(f, old);
  f.contract.legacyRetainedObligationIds = [id1]; f.contract.cards = [f.contract.cards[1]]; f.contract.alignments = [f.contract.alignments[1]]; withReview(f);
  assert.deepEqual(candidateCheck(f).inheritedLegacyIds, [id1]); assert.deepEqual(reviewCheck(f).eligibleObligationIds, [id2]);
  f.contract.alignments = []; assert.throws(() => candidateCheck(f), /exactly cover/);
});

test('a mixed item can retain its exact legacy parent without manufacturing another original obligation', t => {
  const f = fixture(t), item = f.candidate.inventory.items[0];
  item.obligations.push({...clone(item.obligations[0]), id: 'origin:i0001:o02', statement: 'An auxiliary x=1 check', conditions: ['x=1']});
  f.candidate.assessments[0].basisItemHashes = {[item.id]: objectHash(item)};
  f.candidate.assessments.push({...clone(f.candidate.assessments[0]), obligationId: 'origin:i0001:o02', status: 'internal_gap', outcome: 'partial'});
  f.contract.alignments.push({...clone(f.contract.alignments[0]), obligationId: 'origin:i0001:o02', relation: 'subclaim', additionalAssumptions: ['x=1']}); sync(f);
  const old = previous(f, false); old.decision.acceptedObligationIds = [id1, id2]; next(f, old);
  f.contract.legacyRetainedObligationIds = [id1, id2]; f.contract.cards = [f.contract.cards[0]]; f.contract.alignments = [f.contract.alignments[2]];
  f.contract.cards[0].claims[0].legacyParentObligationIds = [id1]; withReview(f);
  f.review.entries.find(e => e.obligationId === 'origin:i0001:o02').verdict = 'needs_work'; sealReview(f);
  assert.deepEqual(reviewCheck(f).inheritedLegacyIds, [id1, id2]);
  f.contract.cards[0].claims[0].legacyParentObligationIds = [id2]; assert.throws(() => candidateCheck(f), /same-item credit/);
});

test('legacy migration credit can carry forward but a stale prior contract cannot justify it', t => {
  const f = fixture(t); next(f, previous(f, false)); f.contract.legacyRetainedObligationIds = [id1, id2]; f.contract.cards = []; f.contract.alignments = []; withReview(f);
  const old = previous(f); next(f, old); assert.deepEqual(reviewCheck(f).inheritedLegacyIds, [id1, id2]);
  old.contractSha256 = '0'.repeat(64); assert.throws(() => candidateCheck(f), /legacy scope contract binding/);
});

test('guarded obligations cannot be relabeled legacy, and difficult IDs cannot be removed', t => {
  const f = fixture(t), old = previous(f); next(f, old); f.contract.legacyRetainedObligationIds = [id1]; assert.throws(() => candidateCheck(f), /cannot become exempt/);
  f.contract.legacyRetainedObligationIds = []; f.candidate.inventory.items.pop(); f.candidate.assessments.pop(); f.contract.cards.pop(); f.contract.alignments.pop(); sync(f); assert.throws(() => candidateCheck(f), /cannot remove/);
});

test('exact prior scope checks can be retained explicitly without rereview and remain version-bound', t => {
  const f = fixture(t); assert.equal(reviewCheck(f).valid, true); const old = previous(f); next(f, old);
  f.scopeReview.cards = clone(old.scopeReview.cards); f.scopeReview.entries = clone(old.scopeReview.entries); f.scopeReview.retainedItemIds = f.contract.cards.map(c => c.itemId); f.scopeReview.retainedObligationIds = [id1, id2];
  assert.deepEqual(reviewCheck(f).eligibleObligationIds, [id1, id2]);
  const twice = previous(f); next(f, twice); f.scopeReview.cards = clone(twice.scopeReview.cards); f.scopeReview.entries = clone(twice.scopeReview.entries); f.scopeReview.retainedItemIds = f.contract.cards.map(c => c.itemId); f.scopeReview.retainedObligationIds = [id1, id2]; assert.equal(reviewCheck(f).valid, true);
  f.scopeReview.entries[0].reason = 'new reason disguised as retained'; assert.throws(() => reviewCheck(f), /changed\/unaccepted\/unreviewed/);
});

test('retention cannot upgrade old needs_work or reuse a changed scope card', t => {
  const f = fixture(t), old = previous(f); next(f, old); f.scopeReview.retainedObligationIds = [id1]; f.scopeReview.entries[0] = clone(old.scopeReview.entries[0]);
  old.scopeReview.entries[0].verdict = 'needs_work'; old.scopeReviewSha256 = objectHash(old.scopeReview); assert.throws(() => reviewCheck(f), /unreviewed/);
  old.scopeReview.entries[0].verdict = 'aligned'; old.scopeReviewSha256 = objectHash(old.scopeReview);
  f.contract.cards[0].claims[0].quantifier = 'only one x'; withReview(f); f.scopeReview.cards[0] = clone(old.scopeReview.cards[0]); f.scopeReview.retainedItemIds = [f.contract.cards[0].itemId]; assert.throws(() => reviewCheck(f), /exact hash|retained card/);
});
