import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {loadAppendRelease, prepareAppendCorrection} from '../protocols/append-correction-v1/append-core.mjs';
import {setup, canonical, hash, clone, objectHash} from './fixtures/append-correction-core/fixture.mjs';

// Separate disposable synthetic project per test, workerCount=1. Never invokes
// a scientific program or reads a real paper. Run --test-concurrency=1.
const args = (f, extra = {}) => ({root: f.project, state: f.state(), paper: f.paper(), request: f.requestPayload, ...extra});
const proof = (f, extra = {}) => prepareAppendCorrection(args(f, extra));
function inventory(root) {
  const out = {};
  function visit(dir) { for (const entry of fs.readdirSync(dir, {withFileTypes: true})) { const filename = path.join(dir, entry.name); if (entry.isDirectory()) visit(filename); else out[path.relative(root, filename)] = hash(fs.readFileSync(filename)); } }
  visit(root); return out;
}

test('whole-object mechanical proof passes unchanged legacy gates without writes or scientific credit', async t => {
  const f = setup(t), beforeFiles = inventory(f.project), input = canonical(args(f));
  const result = await proof(f);
  assert.equal(result.proof.verification, 'mechanical_append_correction_not_scientific_acceptance');
  assert.equal(result.proof.locatorsBefore, 4); assert.equal(result.proof.locatorsAfter, 3);
  assert.equal(result.proof.affectedObligationIds.length, 23); assert.equal(result.proof.scopeBindingChanges, 25);
  assert.equal(result.proof.preservedFileCount, 48);
  assert.equal(result.proof.candidateObjectSha256, objectHash(f.values.candidate));
  assert.notEqual(f.repaired.candidate.sha256, result.proof.candidateObjectSha256, 'raw pretty JSON ref is not a canonical object hash');
  for (const ref of [...Object.values(f.original), ...Object.values(f.repaired), f.repairCheck, f.oldTerminal.terminalProcessCheck, f.terminal.processCheck, ...f.report.preservedFiles]) assert.ok(result.references.some(saved => saved.path === ref.path && saved.sha256 === ref.sha256));
  assert.deepEqual(result.candidate, f.values.candidate); assert.deepEqual(result.contract, f.values.contract);
  assert.equal(canonical(args(f)), input); assert.deepEqual(inventory(f.project), beforeFiles);
  assert.deepEqual((await proof(f)).proof, result.proof, 'proof is deterministic for readonly history auditing');
});

test('extra scientific/locator/basis/scope edits cannot pass a worker-reported valid repair', async t => {
  const f = setup(t);
  const cases = [
    {candidate: value => { value.inventory.items[1].text += ' unauthorized science'; }},
    {candidate: value => { value.assessments[0].summary += ' stronger result'; }},
    {candidate: value => { value.inventory.items.find(item => item.id === 'origin:i0062').locators.push(clone(value.inventory.items.find(item => item.id === 'origin:i0062').locators[0])); }},
    {candidate: value => { delete value.assessments[0].basisItemHashes['origin:i0062']; }},
    {candidate: value => { value.assessments[0].basisItemHashes['origin:i9999'] = '0'.repeat(64); }},
    {originalCandidate: value => { delete value.assessments[0].basisItemHashes['origin:i0062']; }},
    {originalCandidate: value => { value.assessments[0].basisItemHashes['origin:i9999'] = '0'.repeat(64); }},
    {contract: value => { value.cards[0].claims[0].conditions.push('new condition'); }},
    {contract: value => { value.cards[0].anchors[0].quote += ' altered'; }},
    {contract: value => { value.alignments[0].assessmentSha256 = '0'.repeat(64); }},
    {manifest: value => { value.repairScope.duplicate.affectedObligationIds.pop(); }},
  ];
  for (const mutate of cases) {
    Object.assign(f, f.seal(mutate)); const before = inventory(f.project);
    await assert.rejects(proof(f), /Append correction:/); assert.deepEqual(inventory(f.project), before);
  }
});

test('actual terminal field names, original actor/roundId/time/raw refs and preserved processes are mandatory', async t => {
  const f = setup(t);
  const cases = [
    {oldTerminal: value => { value.actor = 'replacement-worker'; }},
    {oldTerminal: value => { value.assignedAt = '2020-01-01T00:00:00Z'; }},
    {oldTerminal: value => { value.roundId = 'c002'; }},
    {oldTerminal: value => { value.noActiveCalculations = false; }},
    {oldTerminal: value => { value.guardOrder.sha256 = '0'.repeat(64); }},
    {terminal: value => { value.actor = 'replacement-worker'; }},
    {terminal: value => { value.threadId = 'other-thread'; }},
    {terminal: value => { value.roundId = 'c002'; }},
    {terminal: value => { value.finishedAt = f.oldTerminal.finishedAt; }},
    {terminal: value => { delete value.noActiveScientificCalculations; value.noActiveCalculation = true; }},
    {terminal: value => { value.scientificComputationsRun = 1; }},
    {terminal: value => { value.repaired.sourceScope.sha256 = '0'.repeat(64); }},
    {terminal: value => { delete value.processCheck; }},
    {report: value => { value.preservedFiles.pop(); }},
    {report: value => { value.preservedFiles[3] = f.put(f.registration.workRoot + '/unrelated-preserved.txt', 'synthetic unrelated'); }},
    {report: value => { value.preservedFiles[47] = f.put('outside-private-root.txt', 'not permitted'); }},
  ];
  for (const mutate of cases) {
    Object.assign(f, f.seal(mutate)); await assert.rejects(proof(f), /Append correction:|Coverage:/);
  }
});

test('only exact current original-owner working c001 registration is eligible', async t => {
  const f = setup(t);
  for (const mutate of [
    paper => { paper.owner = null; }, paper => { paper.owner.agent = 'unknown-worker'; },
    paper => { paper.owner.startedAt = '2020-01-01T00:00:00Z'; }, paper => { paper.owner.role = 'reviewer'; },
    paper => { paper.phase = 'released'; }, paper => { paper.iteration = 2; },
    paper => { paper.staged = {candidate: f.repaired.candidate}; }, paper => { paper.latest = {}; },
    paper => { paper.history.push({iteration: 1}); }, paper => { paper.sourceEnrollment = null; },
  ]) {
    const state = clone(f.state()), paper = state.papers.find(row => row.paperId === 'origin'); mutate(paper);
    await assert.rejects(proof(f, {state, paper}), /Append correction:/);
  }
  for (const mutate of [request => { request.expectedRevision--; }, request => { request.ownerFinished = false; }, request => { request.noActiveCalculation = false; }, request => { request.supervisor = 'not-supervisor'; }, request => { request.agent = 'unknown-worker'; }]) {
    const request = clone(f.requestPayload); mutate(request); await assert.rejects(proof(f, {request}), /Append correction:/);
  }
});

test('fixed module/upstream/diagnostic release whitelist and every raw reference are rechecked', async t => {
  const f = setup(t);
  for (const mutate of [
    value => { value.upstream.pop(); }, value => { value.upstream.push(clone(value.upstream[0])); },
    value => { value.modules[0].installed.path = value.modules[0].frozen.path; },
    value => { value.modules[0].frozen.sha256 = '0'.repeat(64); },
    value => { value.diagnostic.path = value.repairScope.repairCheck.path; },
  ]) {
    Object.assign(f, f.seal({manifest: mutate})); assert.throws(() => loadAppendRelease({root: f.project, reference: f.releaseManifest}), /Append correction:|Coverage:/);
  }
  Object.assign(f, f.seal()); const prepared = await proof(f);
  const originalBytes = fs.readFileSync(f.terminal.processCheck.path);
  fs.appendFileSync(f.terminal.processCheck.path, 'tamper');
  assert.throws(() => prepared.recheck(), /hash|bytes/);
  fs.writeFileSync(f.terminal.processCheck.path, originalBytes);
  prepared.recheck();
  for (const filename of [path.join(f.project, 'reconstructed_sources', f.scan.reading.edition.release, 'index.json'), f.scan.reading.edition.recordPath]) {
    const saved = fs.readFileSync(filename); fs.appendFileSync(filename, 'tamper');
    assert.throws(() => prepared.recheck(), /hash|bytes/); fs.writeFileSync(filename, saved); prepared.recheck();
  }
  fs.appendFileSync(f.repaired.candidate.path, 'tamper'); await assert.rejects(proof(f), /hash|bytes/);
});

test('actual consumed candidate bytes are checked even when disk and all later reads stay correct', async t => {
  const f = setup(t), readFile = fs.readFileSync, filename = path.resolve(f.repaired.candidate.path), actual = readFile(filename);
  let matchingReads = 0, injections = 0;
  fs.readFileSync = function(name, ...rest) {
    const result = readFile.call(this, name, ...rest);
    if (typeof name === 'string' && path.resolve(name) === filename && ++matchingReads === 2) { injections++; return Buffer.from('synthetic corrupted transient raw bytes'); }
    return result;
  };
  try { await assert.rejects(proof(f), /actual bytes mismatch/); }
  finally { fs.readFileSync = readFile; }
  assert.equal(injections, 1); assert.deepEqual(fs.readFileSync(filename), actual);
});
