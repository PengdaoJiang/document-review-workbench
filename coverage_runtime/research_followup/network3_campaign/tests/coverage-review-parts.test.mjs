import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {runReviewParts} from '../coverage-review-parts.mjs';
import {assembleReview} from '../coverage-authoring.mjs';
import {canonical, fileRef, validateReview} from '../coverage-core.mjs';
import {fixture, installCoverage, copyModuleClosure, candidateFor, reviewFor, decisionFor,
  objectHash, campaignRelative, cleanRelative, read, clone, digest} from './fixtures/context-kit/fixture.mjs';

// Synthetic only, workerCount=1; use node --test --test-concurrency=1. Every
// derived run, copied module, source and ledger lives in the existing fixture's
// isolated temporary root. The existing fixture and all real owners stay intact.
function inventory(directory) {
  const result = {};
  function visit(relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, relative), {withFileTypes: true})) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else result[name.replaceAll('\\', '/')] = digest(path.join(directory, name));
    }
  }
  visit(); return result;
}
function partsFixture(t, {mutateCandidate, ...options} = {}) {
  const f = installCoverage(fixture(t, options));
  copyModuleClosure(f.project, campaignRelative + '/coverage-review-parts.mjs');
  f.invoke('init'); f.command('prepare');
  const scan = read(f.paper().scan.path), worker = 'synthetic-worker-c001', reviewer = 'synthetic-reviewer-c001';
  f.command('assign', {role: 'worker', agent: worker, freshContext: true, historyInherited: false});
  const proposal = candidateFor(f, scan, {author: worker});
  if (mutateCandidate) mutateCandidate(proposal);
  const proposalRef = f.put(f.paper().workRoot + '/candidate.json', proposal);
  f.command('intake', {agent: worker, ownerFinished: true, candidatePath: proposalRef.path});
  f.command('assign', {role: 'reviewer', agent: reviewer, freshContext: true, historyInherited: false});
  const candidate = read(f.paper().staged.candidate.path), manual = reviewFor(f, scan, candidate, {reviewer});
  return {...f, scan, candidate, manual, worker, reviewer, parts: (...args) => runReviewParts(f.project, args)};
}
function reviewSpec(manual) {
  const inventory = clone(manual.inventory); delete inventory.resourceIds;
  return {schemaVersion: 1, inventory, entries: manual.entries.map(value => {
    const entry = clone(value); delete entry.assessmentSha256; return entry;
  }), retainedObligationIds: clone(manual.retainedObligationIds)};
}
function writeParts(f, name = 'small', spec = reviewSpec(f.manual), size = 2) {
  const directory = f.paper().staged.reviewRoot + '/' + name;
  const entryFiles = [];
  for (let offset = 0; offset < spec.entries.length; offset += size) {
    entryFiles.push(f.put(directory + '/part-' + String(entryFiles.length + 1).padStart(3, '0') + '.json', {entries: spec.entries.slice(offset, offset + size)}));
  }
  const manifest = {schemaVersion: 1, scanSha256: f.paper().scan.sha256,
    candidateSha256: f.paper().staged.candidate.sha256, reviewerAgent: f.paper().owner.agent,
    inventory: spec.inventory, entryFiles, retainedObligationIds: spec.retainedObligationIds};
  if (Object.hasOwn(spec, 'artifactRegistry')) manifest.artifactRegistry = spec.artifactRegistry;
  return {manifest, ref: f.put(directory + '/manifest.json', manifest), output: directory + '/review.json'};
}
function normalizedReview(f, manual) {
  const result = clone(manual);
  for (const entry of result.entries) entry.evidence = entry.evidence.map(ref => fileRef(f.project, ref.path));
  return result;
}

test('small explicit parts equal manual and original-assembler canonical review; check is read-only and write-once idempotent', async t => {
  const f = partsFixture(t), authored = writeParts(f);
  const before = inventory(f.project), checked = await f.parts('check', 'origin', authored.ref.path);
  assert.equal(checked.valid, true); assert.equal(checked.ledgerWritten, false); assert.equal(checked.scientificAcceptance, false);
  assert.deepEqual(inventory(f.project), before, 'Even a valid check writes no scratch, spec, evidence or ledger');
  assert.ok(!canonical(checked).includes('Independent synthetic'), 'Check returns no review/evidence prose');
  const original = await assembleReview({root: f.project, scan: f.scan, candidate: f.candidate,
    candidateSha256: objectHash(f.candidate), spec: reviewSpec(f.manual), reviewer: f.reviewer, worker: f.worker});
  const result = await f.parts('assemble', 'origin', authored.ref.path, authored.output), actual = read(result.output.path);
  assert.equal(canonical(actual), canonical(normalizedReview(f, f.manual)));
  assert.equal(canonical(actual), canonical(original.review));
  assert.equal(fs.readFileSync(result.output.path, 'utf8'), canonical(actual));
  assert.equal((await validateReview({root: f.project, scan: f.scan, candidate: f.candidate,
    candidateSha256: objectHash(f.candidate), review: actual, reviewer: f.reviewer, worker: f.worker})).valid, true);
  const after = inventory(f.project); delete after[authored.output];
  assert.deepEqual(after, before, 'Assembly adds only the requested review; no giant intermediate review-spec');
  assert.equal(f.paper().phase, 'reviewing'); assert.equal(f.paper().latest, null); assert.ok(!f.paper().staged.review);
  const repeated = await f.parts('assemble', 'origin', authored.ref.path, authored.output);
  assert.deepEqual(repeated.output, result.output);
  const cli = f.execute(campaignRelative + '/coverage-review-parts.mjs', ['check', 'origin', authored.ref.path]);
  assert.equal(cli.value.valid, true);
  const conflict = f.put(f.paper().staged.reviewRoot + '/existing.json', {preserve: 'different existing bytes'});
  await assert.rejects(f.parts('assemble', 'origin', authored.ref.path, conflict.path), /Conflicting immutable/);
  assert.equal(digest(path.resolve(f.project, conflict.path)), conflict.sha256);
  for (const output of [authored.ref.path, authored.manifest.entryFiles[0].path]) {
    await assert.rejects(f.parts('assemble', 'origin', authored.ref.path, output), /overwrite/);
  }
});

test('partial and internal-gap obligations stay explicit; no default completeness, verdict, reason or evidence', async t => {
  const f = partsFixture(t, {mutateCandidate: value => {
    Object.assign(value.assessments[0], {status: 'internal_gap', outcome: 'partial', summary: 'Synthetic incomplete derivation remains an internal gap', evidence: []});
    Object.assign(value.assessments[1], {status: 'pending', outcome: 'inconclusive', summary: 'Synthetic scientific question remains pending', evidence: []});
    value.inventory.complete = false;
  }});
  const spec = reviewSpec(f.manual); spec.entries[0].evidence = [];
  spec.inventory.missingItems = ['Synthetic unresolved inventory boundary'];
  const good = writeParts(f, 'explicit-gaps', spec), before = inventory(f.project);
  const result = await f.parts('assemble', 'origin', good.ref.path, good.output), actual = read(result.output.path);
  assert.equal(actual.inventory.complete, false); assert.equal(actual.entries[0].verdict, 'needs_work');
  assert.deepEqual(actual.entries[0].evidence, []);
  assert.equal(actual.entries[1].verdict, 'needs_work');
  assert.equal(f.candidate.assessments[0].outcome, 'partial'); assert.equal(f.candidate.assessments[0].status, 'internal_gap');
  const after = inventory(f.project); delete after[good.output]; assert.deepEqual(after, before);
  const mutations = [
    ['complete', value => {delete value.inventory.complete;}],
    ['checked', value => {delete value.inventory.checkedAllUnits;}],
    ['notes', value => {delete value.inventory.notes;}],
    ['verdict', value => {delete value.entries[0].verdict;}],
    ['reason', value => {delete value.entries[0].reason;}],
    ['evidence', value => {delete value.entries[0].evidence;}],
    ['empty-reason', value => {value.entries[0].reason = ' ';}],
    ['invented-verdict', value => {value.entries[0].verdict = 'complete';}],
    ['accept-no-proof', value => {value.entries[2].evidence = [];}],
  ];
  for (const [name, mutate] of mutations) {
    const broken = clone(spec); mutate(broken); const authored = writeParts(f, name, broken);
    await assert.rejects(f.parts('check', 'origin', authored.ref.path), /missing|explicit|supporting|reason/i, name);
    await assert.rejects(f.parts('assemble', 'origin', authored.ref.path, authored.output));
    assert.ok(!fs.existsSync(path.resolve(f.project, authored.output)));
  }
});

test('missing, duplicate, unknown and entry/retained-overlap IDs cannot assemble; check returns only bounded diagnostic IDs', async t => {
  const f = partsFixture(t, {mainText: Array.from({length: 35}, (_, index) => `Synthetic paragraph ${index} $z_${index}=z_${index}$.`).join('\n\n')});
  const original = reviewSpec(f.manual), mutations = [
    ['missing', value => {value.entries = value.entries.slice(0, 1);}, 'missing'],
    ['duplicate', value => {value.entries.push(clone(value.entries[0]));}, 'duplicate'],
    ['unknown', value => {value.entries[0].obligationId = 'origin:i9999:o01';}, 'unknown'],
    ['overlap', value => {value.retainedObligationIds = [value.entries[0].obligationId];}, 'entryRetainedOverlap'],
    ['duplicate-retained', value => {const entry = value.entries.shift(); value.retainedObligationIds = [entry.obligationId, entry.obligationId];}, 'duplicate'],
  ];
  for (const [name, mutate, diagnostic] of mutations) {
    const spec = clone(original); mutate(spec); const authored = writeParts(f, name, spec, 7), before = inventory(f.project);
    const checked = await f.parts('check', 'origin', authored.ref.path);
    assert.equal(checked.valid, false); assert.ok(checked.diagnostics[diagnostic].count > 0);
    for (const page of Object.values(checked.diagnostics)) assert.ok(page.ids.length <= 20);
    if (name === 'missing') {assert.equal(checked.diagnostics.missing.ids.length, 20); assert.equal(checked.diagnostics.missing.truncated, true);}
    assert.ok(!canonical(checked).includes('Independent synthetic'));
    await assert.rejects(f.parts('assemble', 'origin', authored.ref.path, authored.output), /obligation coverage/);
    assert.deepEqual(inventory(f.project), before);
  }
});

test('constructor evidence by original path or copied bytes never becomes independent evidence', async t => {
  const f = partsFixture(t), base = reviewSpec(f.manual);
  const candidateArtifact = f.candidate.assessments[0].evidence[0].artifacts[0];
  const copied = f.put(f.paper().staged.reviewRoot + '/copied-constructor.txt', fs.readFileSync(path.resolve(f.project, candidateArtifact.path)));
  for (const [name, artifact] of [['borrowed', candidateArtifact], ['copied', copied]]) {
    const spec = clone(base); spec.entries[0].evidence = [artifact];
    const authored = writeParts(f, name, spec), before = inventory(f.project);
    await assert.rejects(f.parts('check', 'origin', authored.ref.path), /independent|outside|constructor/i);
    await assert.rejects(f.parts('assemble', 'origin', authored.ref.path, authored.output), /independent|outside|constructor/i);
    assert.deepEqual(inventory(f.project), before);
  }
  const aliasSpec = clone(base); aliasSpec.artifactRegistry = {independent: aliasSpec.entries[0].evidence[0]};
  for (const entry of aliasSpec.entries) entry.evidence = [{alias: 'independent'}];
  const aliases = writeParts(f, 'explicit-artifact-alias', aliasSpec);
  assert.equal((await f.parts('check', 'origin', aliases.ref.path)).valid, true);
});

test('manifest, every part and output remain inside the current registered review version; duplicate paths and non-ref parts fail', async t => {
  const f = partsFixture(t), authored = writeParts(f), reviewRoot = f.paper().staged.reviewRoot;
  const foreignRoots = [cleanRelative + '/coverage_verifications/origin/c002', cleanRelative + '/coverage_verifications/r0001/c001',
    cleanRelative + '/coverage_work/origin/c001', campaignRelative + '/coverage/requests'];
  for (const [index, directory] of foreignRoots.entries()) {
    const foreignManifest = f.put(directory + '/foreign-manifest.json', authored.manifest);
    await assert.rejects(f.parts('check', 'origin', foreignManifest.path), /escapes|authorized root/);
    const foreignPart = f.put(directory + '/foreign-part.json', {entries: reviewSpec(f.manual).entries});
    const manifest = {...clone(authored.manifest), entryFiles: [foreignPart]};
    const ref = f.put(reviewRoot + `/foreign-${index}.json`, manifest);
    await assert.rejects(f.parts('check', 'origin', ref.path), /escapes|authorized root/);
    const output = directory + '/forbidden-output.json';
    await assert.rejects(f.parts('assemble', 'origin', authored.ref.path, output), /escapes|authorized root/);
    assert.ok(!fs.existsSync(path.resolve(f.project, output)));
  }
  const duplicate = clone(authored.manifest);
  duplicate.entryFiles.push({...duplicate.entryFiles[0], path: path.resolve(f.project, duplicate.entryFiles[0].path)});
  const duplicateRef = f.put(reviewRoot + '/duplicate-file.json', duplicate);
  await assert.rejects(f.parts('check', 'origin', duplicateRef.path), /Duplicate entry file/);
  const badShapes = [
    ['array', f.put(reviewRoot + '/array.json', reviewSpec(f.manual).entries)],
    ['extra', f.put(reviewRoot + '/extra.json', {entries: reviewSpec(f.manual).entries, acceptAll: true})],
    ['stale', {...authored.manifest.entryFiles[0], sha256: '0'.repeat(64)}],
    ['traversal', {...authored.manifest.entryFiles[0], path: reviewRoot + '/small/../small/part-001.json'}],
  ];
  for (const [name, part] of badShapes) {
    const ref = f.put(reviewRoot + '/' + name + '-manifest.json', {...clone(authored.manifest), entryFiles: [part]});
    await assert.rejects(f.parts('check', 'origin', ref.path), /object|unexpected|hash|Traversal/);
  }
  const stringRefs = f.put(reviewRoot + '/string-refs.json', {...clone(authored.manifest), entryFiles: [authored.manifest.entryFiles[0].path]});
  await assert.rejects(f.parts('check', 'origin', stringRefs.path), /reference.*object/);
});

test('snapshot bindings and current reviewer/phase/version fail closed without outputs', async t => {
  const f = partsFixture(t), authored = writeParts(f), reviewRoot = f.paper().staged.reviewRoot;
  for (const field of ['schemaVersion', 'scanSha256', 'candidateSha256', 'reviewerAgent', 'retainedObligationIds']) {
    const missing = clone(authored.manifest); delete missing[field];
    const ref = f.put(reviewRoot + '/missing-' + field + '.json', missing);
    await assert.rejects(f.parts('check', 'origin', ref.path), /missing/);
  }
  for (const [field, value] of [['scanSha256', '0'.repeat(64)], ['candidateSha256', '0'.repeat(64)], ['reviewerAgent', 'not-current-reviewer']]) {
    const ref = f.put(reviewRoot + '/stale-' + field + '.json', {...clone(authored.manifest), [field]: value});
    await assert.rejects(f.parts('assemble', 'origin', ref.path, reviewRoot + '/stale.json'), /current|owner/);
  }
  const statePath = path.join(f.campaign, 'coverage/state.json'), originalBytes = fs.readFileSync(statePath), original = JSON.parse(originalBytes);
  for (const mutate of [paper => {paper.owner = null;}, paper => {paper.phase = 'awaiting_review';},
    paper => {paper.owner.role = 'worker';}, paper => {paper.iteration++;}, paper => {paper.staged.reviewRoot = reviewRoot.replace('c001', 'c002');}]) {
    const changed = clone(original); mutate(changed.papers.find(value => value.paperId === 'origin')); f.put(statePath, changed);
    try {await assert.rejects(f.parts('assemble', 'origin', authored.ref.path, authored.output), /owner|version/);}
    finally {f.put(statePath, originalBytes);}
    assert.ok(!fs.existsSync(path.resolve(f.project, authored.output)));
  }
});

test('owner/stage/row and manifest/part hashes are rechecked after validation before publication', async t => {
  const f = partsFixture(t), authored = writeParts(f), statePath = path.join(f.campaign, 'coverage/state.json');
  const artifactPath = path.resolve(f.project, f.manual.entries[0].evidence[0].path).toLowerCase();
  const originals = new Map([statePath, path.resolve(f.project, authored.ref.path), path.resolve(f.project, authored.manifest.entryFiles[0].path)]
    .map(filename => [filename, fs.readFileSync(filename)]));
  const mutations = [
    ['owner', () => {const state = JSON.parse(originals.get(statePath)); state.papers.find(value => value.paperId === 'origin').owner.agent = 'new-owner'; f.put(statePath, state);} ],
    ['stage', () => {const state = JSON.parse(originals.get(statePath)); state.papers.find(value => value.paperId === 'origin').phase = 'review_received'; f.put(statePath, state);} ],
    ['row', () => {const state = JSON.parse(originals.get(statePath)); state.papers.find(value => value.paperId === 'origin').iteration++; f.put(statePath, state);} ],
    ['manifest', () => {f.put(authored.ref.path, {...clone(authored.manifest), reviewerAgent: 'changed-during-assembly'});} ],
    ['part', () => {const part = JSON.parse(originals.get(path.resolve(f.project, authored.manifest.entryFiles[0].path))); part.entries[0].reason += ' changed'; f.put(authored.manifest.entryFiles[0].path, part);} ],
  ];
  for (const [name, mutate] of mutations) {
    const originalRead = fs.readFileSync; let triggered = false;
    fs.readFileSync = function (filename, ...args) {
      const result = originalRead.call(this, filename, ...args);
      if (!triggered && typeof filename === 'string' && path.resolve(filename).toLowerCase() === artifactPath) {triggered = true; mutate();}
      return result;
    };
    try {await assert.rejects(f.parts('assemble', 'origin', authored.ref.path, authored.output), /changed during|hash mismatch/, name);}
    finally {fs.readFileSync = originalRead; for (const [filename, bytes] of originals) f.put(filename, bytes);}
    assert.equal(triggered, true, name + ' mutation occurs only after parts have been read');
    assert.ok(!fs.existsSync(path.resolve(f.project, authored.output)));
  }
});

test('retention goes through the unchanged exact prior independent acceptance gate', async t => {
  const f = partsFixture(t), first = writeParts(f), result = await f.parts('assemble', 'origin', first.ref.path, first.output);
  const actual = read(result.output.path);
  f.command('review', {agent: f.reviewer, ownerFinished: true, reviewPath: result.output.path});
  const decision = f.put(campaignRelative + '/coverage/requests/decision.json', decisionFor(f.scan, f.candidate, actual));
  f.command('decide', {decisionPath: decision.path});
  const id = f.candidate.assessments[0].obligationId;
  f.command('continue', {obligationIds: [id], reopenReasons: {[id]: 'Synthetic explicit review of retained source conditions'}});
  const worker = 'synthetic-worker-c002', reviewer = 'synthetic-reviewer-c002';
  f.command('assign', {role: 'worker', agent: worker, freshContext: true, historyInherited: false});
  const candidate = clone(f.candidate); candidate.revision = 2; candidate.predecessorSha256 = objectHash(f.candidate); candidate.author = worker;
  const candidateRef = f.put(f.paper().workRoot + '/candidate.json', candidate);
  f.command('intake', {agent: worker, ownerFinished: true, candidatePath: candidateRef.path});
  f.command('assign', {role: 'reviewer', agent: reviewer, freshContext: true, historyInherited: false});
  const manual = reviewFor(f, f.scan, candidate, {reviewer}), spec = reviewSpec(manual);
  spec.entries = []; spec.retainedObligationIds = candidate.assessments.map(value => value.obligationId);
  const retained = writeParts(f, 'retained', spec);
  assert.deepEqual(retained.manifest.entryFiles, []);
  const output = await f.parts('assemble', 'origin', retained.ref.path, retained.output);
  assert.deepEqual(read(output.output.path).retainedObligationIds, spec.retainedObligationIds);
  assert.equal(f.paper().phase, 'reviewing');
});
