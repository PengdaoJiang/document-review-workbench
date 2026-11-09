import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {runBatch, pageObjects, serializedBytes, MAX_BATCH_BYTES} from '../coverage-batch.mjs';
import {canonical, hash} from '../coverage-core.mjs';
import {fixture, installCoverage, copyModuleClosure, candidateFor, refreshBasis, reviewFor, decisionFor,
  campaignRelative, cleanRelative, read, digest} from './fixtures/context-kit/fixture.mjs';

// workerCount=1. Run with --test-concurrency=1. The reusable fixture creates its
// runtime, source stubs, derived runs, all ledgers and evidence under one unique
// temporary project per test; no production mutable input is used or touched.
const AGENT = 'synthetic-worker-c001';
const unicode = '🧪中文é e\u0301\\\"\n\t\u0000\u0001𝄞';
function bounded(value, limit = MAX_BATCH_BYTES) { assert.ok(serializedBytes(value) <= limit, `Serialized ${serializedBytes(value)} > ${limit}`); return value; }
function good(value, limit) { bounded(value, limit); assert.equal(value.error, undefined, value.error); return value; }
function inventory(directory) {
  const files = {};
  const visit = (relative = '') => {
    for (const entry of fs.readdirSync(path.join(directory, relative), {withFileTypes: true})) {
      const name = path.join(relative, entry.name), absolute = path.join(directory, name);
      if (entry.isDirectory()) visit(name); else files[name] = [digest(absolute), String(fs.statSync(absolute, {bigint: true}).mtimeNs)];
    }
  };
  visit(); return files;
}
async function setup(t, options = {}) {
  const f = installCoverage(fixture(t, options));
  copyModuleClosure(f.project, campaignRelative + '/coverage-batch.mjs');
  f.invoke('init'); f.command('prepare');
  f.command('assign', {role: 'worker', agent: AGENT, freshContext: true, historyInherited: false});
  const scan = read(f.paper().scan.path), candidate = candidateFor(f, scan, {author: AGENT});
  const candidateRef = f.put(f.paper().workRoot + '/candidate.json', candidate);
  const open = async (role = 'worker', agent = AGENT, select = candidateRef.path) => good(await runBatch(f.project, ['open', 'origin', role, agent, ...(select ? ['--candidate', select] : [])]));
  const opened = await open();
  const readerArgs = (command, kind, key, ...tail) => [command, 'origin', 'worker', opened.snapshotKey, kind, key, ...tail, '--candidate', candidateRef.path];
  const manifest = (requests, fields = {}) => f.put(f.paper().workRoot + '/batch-manifest.json', {schemaVersion: 1, paperId: 'origin', role: 'worker', agent: AGENT, snapshotKey: opened.snapshotKey, candidatePath: candidateRef.path, requests, ...fields});
  return {...f, scan, candidate, candidateRef, opened, open, readerArgs, manifest};
}
async function recover(f, manifest, {maxBytes = MAX_BATCH_BYTES, first = null} = {}) {
  const recovered = new Map(), offsets = new Map(), pages = [];
  let page = first ?? good(await runBatch(f.project, ['batch', manifest.path, '--max-bytes', String(maxBytes)]), maxBytes), cursor;
  for (let turn = 0; ; turn++) {
    assert.ok(turn < 2000, 'Continuation must make progress');
    good(page, maxBytes); pages.push(page);
    for (const chunk of page.chunks) {
      assert.equal(chunk.offset, offsets.get(chunk.id) ?? 0);
      assert.equal(chunk.end - chunk.offset, chunk.chunk.length);
      assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.chunk) && !/[\uD800-\uDBFF]$/.test(chunk.chunk), 'No split Unicode surrogate pair');
      offsets.set(chunk.id, chunk.end); recovered.set(chunk.id, (recovered.get(chunk.id) ?? '') + chunk.chunk);
      if (chunk.complete) { assert.equal(chunk.end, chunk.total); assert.equal(hash(recovered.get(chunk.id)), chunk.sha256); }
      else assert.ok(chunk.end < chunk.total);
    }
    if (page.complete) { assert.equal(page.nextCursor, null); break; }
    assert.ok(page.nextCursor && page.nextCursor !== cursor); cursor = page.nextCursor;
    page = good(await runBatch(f.project, ['read', manifest.path, '--cursor', cursor, '--max-bytes', String(maxBytes)]), maxBytes);
  }
  return {recovered, pages};
}
async function withReadOnlyRoutingState(f, patchPaper, action) {
  // These minimal sidecars exercise transport routing, not guard admission.
  // Complete real CLI transitions first; never run a business command while
  // this partial synthetic routing state is installed. Restore the exact normal
  // fixture state before any subsequent transition under either CLI version.
  const normal = f.state(), routed = structuredClone(normal), command = f.command;
  patchPaper(routed.papers.find(value => value.paperId === 'origin'));
  f.put(campaignRelative + '/coverage/state.json', routed);
  f.command = () => { throw Error('Business commands are forbidden inside a partial read-only routing fixture'); };
  try { return await action(); }
  finally { f.command = command; f.put(campaignRelative + '/coverage/state.json', normal); }
}

test('one batch handles many mixed exact reader objects and source/public/own evidence without writes', async t => {
  const f = await setup(t);
  const source = f.scan.resources.find(value => value.type === 'text');
  const own = f.put(f.paper().workRoot + '/notes.txt', 'Own current notes\r\n' + unicode);
  const publicEvidence = f.result.claims[0].evidence[0];
  const publicRef = {path: path.join(f.run.runDir, publicEvidence.path), sha256: publicEvidence.sha256};
  const requests = [
    {id: 'source', ref: {path: source.path, sha256: source.sha256}},
    {id: 'own', ref: own}, {id: 'public', ref: publicRef},
    ...Array.from({length: 40}, (_, i) => ({id: 'object-' + i, argv: f.readerArgs('get', 'items', f.candidate.inventory.items[i % f.candidate.inventory.items.length].id)}))
  ];
  const manifest = f.manifest(requests), before = inventory(f.project);
  const {recovered, pages} = await recover(f, manifest);
  assert.equal(recovered.size, requests.length); assert.ok(pages.length > 1);
  assert.equal(recovered.get('source'), fs.readFileSync(path.resolve(f.project, source.path), 'utf8'));
  assert.equal(recovered.get('own'), 'Own current notes\r\n' + unicode);
  assert.equal(recovered.get('public'), fs.readFileSync(publicRef.path, 'utf8'));
  for (let i = 0; i < 40; i++) assert.deepEqual(JSON.parse(recovered.get('object-' + i)), f.candidate.inventory.items[i % f.candidate.inventory.items.length]);
  const cli = f.execute(campaignRelative + '/coverage-batch.mjs', ['batch', manifest.path]);
  assert.ok(Buffer.byteLength(cli.stdout, 'utf8') <= MAX_BATCH_BYTES); assert.equal(cli.stderr, '');
  assert.equal(cli.stdout.trim().split('\n').length, 1, 'Exactly one JSON result, not one result per request');
  assert.deepEqual(cli.value, pages[0]);
  assert.deepEqual(inventory(f.project), before, 'Batch reading must not mutate any fixture file or mtime');
});

test('huge singleton and escaped Unicode preserve every scientific field through exact continuation', async t => {
  const f = await setup(t);
  f.candidate.inventory.items[0].text = unicode.repeat(2600);
  f.candidate.inventory.items[0].conditions.push(unicode.repeat(40)); refreshBasis(f.candidate);
  f.put(f.candidateRef.path, f.candidate);
  const opened = await f.open();
  const request = {id: 'huge', argv: ['get', 'origin', 'worker', opened.snapshotKey, 'items', f.candidate.inventory.items[0].id, '--candidate', f.candidateRef.path]};
  const manifest = f.manifest([request], {snapshotKey: opened.snapshotKey});
  const {recovered, pages} = await recover(f, manifest);
  assert.ok(pages.length > 10); assert.equal(pages[0].complete, false); assert.equal(pages[0].chunks[0].complete, false);
  assert.equal(recovered.get('huge'), canonical(f.candidate.inventory.items[0]));
  assert.deepEqual(JSON.parse(recovered.get('huge')), f.candidate.inventory.items[0]);
  assert.equal(pages.at(-1).complete, true);
});

test('pure envelope budget includes JSON escapes, all metadata, cursor and newline; budget may decrease on resume', () => {
  const objects = Array.from({length: 20}, (_, i) => ({id: 'r' + i, requestKey: hash('request' + i), sha256: hash(unicode.repeat(30)), text: unicode.repeat(30), encoding: 'utf8-artifact', scope: 'full-content'}));
  const key = hash('synthetic-plan'), output = new Map(); let cursor = null, limit = 8192, count = 0;
  do {
    const page = pageObjects(objects, key, {cursor, maxBytes: limit}); bounded(page, limit); count++;
    for (const chunk of page.chunks) {
      assert.equal(chunk.offset, (output.get(chunk.id) ?? '').length);
      output.set(chunk.id, (output.get(chunk.id) ?? '') + chunk.chunk);
      assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.chunk) && !/[\uD800-\uDBFF]$/.test(chunk.chunk));
    }
    cursor = page.nextCursor; limit = 1024; assert.ok(count < 1000);
  } while (cursor);
  for (const object of objects) assert.equal(output.get(object.id), object.text);
  const empty = [{id: 'empty', requestKey: hash('empty-request'), sha256: hash(''), text: '', encoding: 'utf8-artifact', scope: 'full-content'}];
  assert.equal(pageObjects(empty, key, {maxBytes: 1024}).complete, true);
});

test('tampered cursor, changed requested content/manifest, stale owner and stale candidate fail closed', async t => {
  const f = await setup(t), own = f.put(f.paper().workRoot + '/large.txt', unicode.repeat(1000));
  const manifest = f.manifest([{id: 'own', ref: own}]);
  const page = good(await runBatch(f.project, ['batch', manifest.path])); assert.ok(page.nextCursor);
  const bad = page.nextCursor.slice(0, -1) + (page.nextCursor.endsWith('0') ? '1' : '0');
  assert.match((await runBatch(f.project, ['read', manifest.path, '--cursor', bad])).error, /cursor/i);
  const original = fs.readFileSync(path.resolve(f.project, own.path)); f.put(own.path, 'changed');
  assert.match((await runBatch(f.project, ['read', manifest.path, '--cursor', page.nextCursor])).error, /hash|changed/i);
  f.put(own.path, original);
  const originalManifest = fs.readFileSync(path.resolve(f.project, manifest.path));
  const changed = JSON.parse(originalManifest); changed.requests[0].id = 'renamed'; f.put(manifest.path, changed);
  assert.match((await runBatch(f.project, ['read', manifest.path, '--cursor', page.nextCursor])).error, /cursor|manifest|changed/i);
  f.put(manifest.path, originalManifest);
  const originalState = f.state(), changedState = structuredClone(originalState);
  changedState.papers.find(value => value.paperId === 'origin').owner.agent = 'other-owner'; f.put(campaignRelative + '/coverage/state.json', changedState);
  assert.match((await runBatch(f.project, ['read', manifest.path, '--cursor', page.nextCursor])).error, /owner/i);
  f.put(campaignRelative + '/coverage/state.json', originalState);
  f.candidate.assessments[0].summary += ' changed'; f.put(f.candidateRef.path, f.candidate);
  assert.match((await runBatch(f.project, ['read', manifest.path, '--cursor', page.nextCursor])).error, /snapshot/i);
});

test('unrelated paper/global revisions preserve cursor; source changes and final-read races invalidate', async t => {
  const f = await setup(t), own = f.put(f.paper().workRoot + '/large.txt', unicode.repeat(600));
  const manifest = f.manifest([{id: 'own', ref: own}]);
  const page = good(await runBatch(f.project, ['batch', manifest.path]));
  const state = f.state(); state.revision++; state.papers.find(value => value.paperId === 'r0001').phase = 'synthetic-unrelated-progress';
  f.put(campaignRelative + '/coverage/state.json', state);
  await recover(f, manifest, {first: page});
  const source = f.scan.resources.find(value => value.type === 'text'), original = fs.readFileSync(path.resolve(f.project, source.path));
  f.put(source.path, 'tampered bound source');
  assert.match((await runBatch(f.project, ['read', manifest.path, '--cursor', page.nextCursor])).error, /hash|source/i);
  f.put(source.path, original);
  // Change this exact input only after its actual content read. The final seal
  // check must reject the buffered response, rather than returning mixed data.
  const originalRead = fs.readFileSync; let ownReads = 0;
  fs.readFileSync = function(filename, ...args) {
    const value = originalRead.call(this, filename, ...args);
    if (typeof filename === 'string' && path.resolve(filename) === path.resolve(f.project, own.path) && ++ownReads === 2) f.put(own.path, 'changed during read');
    return value;
  };
  try { assert.match((await runBatch(f.project, ['batch', manifest.path])).error, /hash|changed/i); }
  finally { fs.readFileSync = originalRead; }
});

test('worker cannot read other paper, sibling private root, old holdout, arbitrary file or binary asset', async t => {
  const f = await setup(t);
  const foreign = f.put(cleanRelative + '/coverage_work/r0001/c001/forbidden.txt', 'OTHER_PAPER_SECRET');
  const sibling = f.put(cleanRelative + '/coverage_work/origin/c002/forbidden.txt', 'SIBLING_VERSION_SECRET');
  const privateRef = f.put(cleanRelative + '/coverage_verifications/origin/c001/forbidden.txt', 'PRIVATE_HOLDOUT_SECRET');
  const outside = f.put('arbitrary.txt', 'ARBITRARY_SECRET');
  const refs = [foreign, sibling, privateRef, outside, f.firstPass.review];
  for (const ref of refs) {
    const manifest = f.manifest([{id: 'forbidden', ref}]), observed = [], original = fs.readFileSync;
    fs.readFileSync = function(filename, ...args) { if (typeof filename === 'string') observed.push(path.resolve(filename).toLowerCase()); return original.call(this, filename, ...args); };
    try {
      const value = bounded(await runBatch(f.project, ['batch', manifest.path, '--max-bytes', '1024']), 1024);
      assert.match(value.error, /authorized|root/i); assert.equal(value.complete, false);
      assert.ok(!observed.includes(path.resolve(f.project, ref.path).toLowerCase()), 'Denied file is not read before authorization');
      assert.ok(!JSON.stringify(value).includes('SECRET'));
    } finally { fs.readFileSync = original; }
  }
  const injected = structuredClone(f.candidate);
  injected.assessments[0].evidence[0].artifacts = [sibling];
  f.put(f.candidateRef.path, injected);
  const observed = [], originalRead = fs.readFileSync;
  fs.readFileSync = function(filename, ...args) { if (typeof filename === 'string') observed.push(path.resolve(filename).toLowerCase()); return originalRead.call(this, filename, ...args); };
  try {
    const rejected = await runBatch(f.project, ['open', 'origin', 'worker', AGENT, '--candidate', f.candidateRef.path]);
    assert.match(rejected.error, /current root|prior public/i, 'A private candidate cannot authorize an unbound sibling-version artifact');
    assert.ok(!observed.includes(path.resolve(f.project, sibling.path).toLowerCase()), 'Candidate preflight must reject before old reader hashes a forbidden artifact');
  } finally { fs.readFileSync = originalRead; }
  f.put(f.candidateRef.path, f.candidate);
  const binary = f.scan.resources.find(value => value.type !== 'text');
  assert.match((await runBatch(f.project, ['batch', f.manifest([{id: 'binary', ref: {path: binary.path, sha256: binary.sha256}}]).path])).error, /binary|viewer/i);
  assert.match((await runBatch(f.project, ['batch', f.manifest([{id: 'cross-reader', argv: ['open', 'r0001', 'worker']}]).path])).error, /paper|role|candidate/i);
  assert.match((await runBatch(f.project, ['batch', outside.path])).error, /manifest|root/i);
  assert.match((await runBatch(f.project, ['open', 'origin', 'worker', 'forged-agent'])).error, /owner/i);
});

test('reviewer reads bound same-paper old private refs and own notes but cannot recursively widen authority', async t => {
  const f = await setup(t);
  f.command('intake', {agent: AGENT, ownerFinished: true, candidatePath: f.candidateRef.path});
  const reviewer = 'synthetic-reviewer-c001';
  f.command('assign', {role: 'reviewer', agent: reviewer, freshContext: true, historyInherited: false});
  const opened = await f.open('reviewer', reviewer, null), reviewRoot = f.paper().staged.reviewRoot;
  const own = f.put(reviewRoot + '/notes.txt', 'Independent private notes');
  const manifest = requests => f.put(reviewRoot + '/batch.json', {schemaVersion: 1, paperId: 'origin', role: 'reviewer', agent: reviewer, snapshotKey: opened.snapshotKey, requests});
  const recovered = await recover(f, manifest([{id: 'old-review', ref: f.firstPass.review}, {id: 'own', ref: own}]));
  assert.equal(recovered.recovered.get('old-review'), fs.readFileSync(path.resolve(f.project, f.firstPass.review.path), 'utf8'));
  assert.equal(recovered.recovered.get('own'), 'Independent private notes');
  const unbound = f.put(cleanRelative + '/verifications/origin/a999/secret.txt', 'Not explicitly bound');
  const foreign = f.put(cleanRelative + '/coverage_verifications/r0001/c001/private.txt', 'Other paper');
  for (const ref of [unbound, foreign]) assert.match((await runBatch(f.project, ['batch', manifest([{id: 'denied', ref}]).path])).error, /authorized|root/i);
});

test('exact sealed first-pass private ref is authorized but evidence-file child refs are not recursively trusted', async t => {
  const base = fixture(t);
  const child = base.put(cleanRelative + '/verifications/origin/a001/unbound-child.txt', 'Unbound nested private child');
  const exact = base.put(cleanRelative + '/verifications/origin/a001/exact-evidence.json', {child});
  const old = read(path.resolve(base.project, base.firstPass.review.path));
  old.independentChecks[0].evidence.push(exact);
  base.firstPass.review = base.put(base.firstPass.review.path, old);
  const acceptance = read(path.resolve(base.project, base.firstPass.acceptance.path)); acceptance.reviewSha256 = base.firstPass.review.sha256;
  base.firstPass.acceptance = base.put(base.firstPass.acceptance.path, acceptance);
  const f = installCoverage(base); copyModuleClosure(f.project, campaignRelative + '/coverage-batch.mjs');
  f.invoke('init'); f.command('prepare'); f.command('assign', {role: 'worker', agent: AGENT, freshContext: true, historyInherited: false});
  const scan = read(f.paper().scan.path), candidate = candidateFor(f, scan, {author: AGENT}), candidateRef = f.put(f.paper().workRoot + '/candidate.json', candidate);
  f.command('intake', {agent: AGENT, ownerFinished: true, candidatePath: candidateRef.path});
  const reviewer = 'synthetic-reviewer-c001'; f.command('assign', {role: 'reviewer', agent: reviewer, freshContext: true, historyInherited: false});
  const opened = good(await runBatch(f.project, ['open', 'origin', 'reviewer', reviewer]));
  const manifest = ref => f.put(f.paper().staged.reviewRoot + '/batch.json', {schemaVersion: 1, paperId: 'origin', role: 'reviewer', agent: reviewer, snapshotKey: opened.snapshotKey, requests: [{id: 'private', ref}]});
  assert.equal((await recover(f, manifest(exact))).recovered.get('private'), fs.readFileSync(path.resolve(f.project, exact.path), 'utf8'));
  assert.match((await runBatch(f.project, ['batch', manifest(child).path])).error, /authorized|root/i);
});

test('accepted previous coverage artifacts and exact previous review evidence remain available on next iteration', async t => {
  const f = await setup(t);
  f.command('intake', {agent: AGENT, ownerFinished: true, candidatePath: f.candidateRef.path});
  const reviewer = 'synthetic-reviewer-c001';
  f.command('assign', {role: 'reviewer', agent: reviewer, freshContext: true, historyInherited: false});
  const review = reviewFor(f, f.scan, f.candidate, {reviewer}), reviewRef = f.put(f.paper().staged.reviewRoot + '/review.json', review);
  f.command('review', {agent: reviewer, ownerFinished: true, reviewPath: reviewRef.path});
  const decision = decisionFor(f.scan, f.candidate, review), decisionRef = f.put(campaignRelative + '/coverage/requests/decision.json', decision);
  f.command('decide', {decisionPath: decisionRef.path});
  const priorContract = f.put(campaignRelative + '/coverage/origin/c001/source-scope.json', canonical({paperId: 'origin', synthetic: 'public source contract'}));
  const priorScopeEvidence = f.put(cleanRelative + '/coverage_verifications/origin/c001/scope-evidence.txt', 'PRIVATE_SCOPE_EVIDENCE');
  const priorScopeReview = f.put(campaignRelative + '/coverage/origin/c001/scope-review.json', canonical({paperId: 'origin', synthetic: 'PRIVATE_SCOPE_REVIEW', evidence: [priorScopeEvidence]}));
  const priorGuard = {contract: priorContract, scopeReview: priorScopeReview, references: [priorContract, priorScopeReview]};
  // Reopen one accepted synthetic obligation explicitly; no scientific fixture
  // silently turns a completed decision into new work.
  const obligation = f.candidate.assessments[0].obligationId;
  f.command('continue', {obligationIds: [obligation], reopenReasons: {[obligation]: 'Synthetic test of next-iteration read access'}});
  const worker2 = 'synthetic-worker-c002'; f.command('assign', {role: 'worker', agent: worker2, freshContext: true, historyInherited: false});
  await withReadOnlyRoutingState(f, paper => { paper.latest.guard = priorGuard; }, async () => {
  const opened = await f.open('worker', worker2, null), priorArtifact = f.candidate.assessments[0].evidence[0].artifacts[0];
  const workerManifest = requests => f.put(f.paper().workRoot + '/batch.json', {schemaVersion: 1, paperId: 'origin', role: 'worker', agent: worker2, snapshotKey: opened.snapshotKey, requests});
  const recovered = await recover(f, workerManifest([{id: 'prior-public', ref: priorArtifact}, {id: 'prior-contract', ref: priorContract}]));
  assert.equal(recovered.recovered.get('prior-public'), fs.readFileSync(path.resolve(f.project, priorArtifact.path), 'utf8'));
  assert.equal(recovered.recovered.get('prior-contract'), fs.readFileSync(path.resolve(f.project, priorContract.path), 'utf8'));
  for (const ref of [priorScopeReview, priorScopeEvidence]) {
    const deniedManifest = workerManifest([{id: 'private-scope', ref}]), reads = [], original = fs.readFileSync;
    fs.readFileSync = function(filename, ...args) { if (typeof filename === 'string') reads.push(path.resolve(filename).toLowerCase()); return original.call(this, filename, ...args); };
    try {
      assert.match((await runBatch(f.project, ['batch', deniedManifest.path])).error, /authorized|root/i);
      assert.ok(!reads.includes(path.resolve(f.project, ref.path).toLowerCase()), 'Worker never opens private scope review/evidence');
    } finally { fs.readFileSync = original; }
  }
  });
  const candidate2 = structuredClone(f.candidate); candidate2.revision = 2; candidate2.author = worker2; candidate2.predecessorSha256 = f.paper().latest.candidate.sha256;
  const ref2 = f.put(f.paper().workRoot + '/candidate.json', candidate2);
  f.command('intake', {agent: worker2, ownerFinished: true, candidatePath: ref2.path});
  const reviewer2 = 'synthetic-reviewer-c002'; f.command('assign', {role: 'reviewer', agent: reviewer2, freshContext: true, historyInherited: false});
  await withReadOnlyRoutingState(f, paper => { paper.latest.guard = priorGuard; }, async () => {
  const opened2 = await f.open('reviewer', reviewer2, null), privateEvidence = review.entries[0].evidence[0];
  const reviewManifest = f.put(f.paper().staged.reviewRoot + '/batch.json', {schemaVersion: 1, paperId: 'origin', role: 'reviewer', agent: reviewer2, snapshotKey: opened2.snapshotKey, requests: [{id: 'prior-private', ref: privateEvidence}, {id: 'prior-scope-review', ref: priorScopeReview}, {id: 'prior-scope-evidence', ref: priorScopeEvidence}]});
  const reviewed = await recover(f, reviewManifest);
  assert.equal(reviewed.recovered.get('prior-private'), fs.readFileSync(path.resolve(f.project, privateEvidence.path), 'utf8'));
  assert.equal(reviewed.recovered.get('prior-scope-review'), fs.readFileSync(path.resolve(f.project, priorScopeReview.path), 'utf8'));
  assert.equal(reviewed.recovered.get('prior-scope-evidence'), 'PRIVATE_SCOPE_EVIDENCE');
  });
});

test('guard supplements, exact neutral release refs and staged scope contract are role-scoped without recursive refs', async t => {
  const f = await setup(t), releaseRoot = campaignRelative + '/architecture/batch-scope-20261029';
  const names = ['coverage.mjs', 'coverage-guard.mjs', 'coverage-scope.mjs', 'coverage-batch.mjs', 'COVERAGE_GUARDS.md', 'BATCH_API.md', 'SCOPE_API.md'];
  const modules = names.map(name => f.put(releaseRoot + '/release/' + name, 'Synthetic neutral release: ' + name));
  const release = f.put(releaseRoot + '/release-manifest.json', canonical({schemaVersion: 1, synthetic: true, modules}));
  const policy = f.put(campaignRelative + '/coverage/guard-policy-v1.json', canonical({schemaVersion: 1, profile: 'source-scope-v1', release, modules}));
  const paper = f.paper(), prefix = campaignRelative + '/coverage/origin/c001';
  const profile = f.put(prefix + '/guard-order.json', canonical({schemaVersion: 1, profile: 'source-scope-v1', paperId: 'origin', iteration: 1, policy, scan: paper.scan, order: paper.order, workRoot: paper.workRoot}));
  const instructions = f.put(prefix + '/guard-order.md', 'Synthetic bound supplement');
  const enrollment = {profile, instructions};
  await withReadOnlyRoutingState(f, paper => { paper.guardEnrollment = enrollment; }, async () => {
  const opened = await f.open();
  const manifest = f.manifest([profile, instructions, policy, release, ...modules].map((ref, i) => ({id: 'guard-' + i, ref})), {snapshotKey: opened.snapshotKey});
  assert.equal((await recover(f, manifest)).recovered.size, modules.length + 4);
  });
  f.command('intake', {agent: AGENT, ownerFinished: true, candidatePath: f.candidateRef.path});
  const contract = f.put(prefix + '/source-scope.json', canonical({paperId: 'origin', synthetic: 'bound construction sidecar'}));
  const forbidden = f.put(cleanRelative + '/coverage_verifications/r0001/c001/private.txt', 'OTHER_PAPER_HOLDOUT');
  const reviewer = 'synthetic-reviewer-c001'; f.command('assign', {role: 'reviewer', agent: reviewer, freshContext: true, historyInherited: false});
  await withReadOnlyRoutingState(f, paper => { paper.guardEnrollment = enrollment; paper.staged.guard = {enrollment, contract, references: [contract, forbidden]}; }, async () => {
  const reviewed = await f.open('reviewer', reviewer, null);
  const reviewManifest = refs => f.put(f.paper().staged.reviewRoot + '/batch.json', {schemaVersion: 1, paperId: 'origin', role: 'reviewer', agent: reviewer, snapshotKey: reviewed.snapshotKey, requests: refs.map((ref, i) => ({id: 'r-' + i, ref}))});
  assert.equal((await recover(f, reviewManifest([contract]))).recovered.get('r-0'), fs.readFileSync(path.resolve(f.project, contract.path), 'utf8'));
  assert.match((await runBatch(f.project, ['batch', reviewManifest([forbidden]).path])).error, /authorized|root/i, 'Opaque guard.references must never widen scope');
  const wrongState = f.state(); wrongState.papers.find(value => value.paperId === 'origin').staged.guard.contract = forbidden;
  f.put(campaignRelative + '/coverage/state.json', wrongState);
  const wrongOpen = await f.open('reviewer', reviewer, null);
  const wrongManifest = f.put(f.paper().staged.reviewRoot + '/wrong.json', {schemaVersion: 1, paperId: 'origin', role: 'reviewer', agent: reviewer, snapshotKey: wrongOpen.snapshotKey, requests: [{id: 'wrong', ref: forbidden}]});
  assert.match((await runBatch(f.project, ['batch', wrongManifest.path])).error, /exact same-paper|guard reference/i);
  });
});

test('reader read means full exact remainder and directory preview stays explicitly a preview', async t => {
  const f = await setup(t, {mainText: 'Beginning\n' + unicode.repeat(800)}), resource = f.scan.resources.find(value => value.type === 'text');
  const requests = [
    {id: 'source', argv: f.readerArgs('read', 'resources', resource.id, '0', '2')},
    {id: 'remainder', argv: f.readerArgs('read', 'resources', resource.id, '2', '2')},
    {id: 'directory', argv: f.readerArgs('list', 'resources', '0', '1')}
  ];
  const {recovered, pages} = await recover(f, f.manifest(requests));
  const text = fs.readFileSync(path.resolve(f.project, resource.path), 'utf8');
  assert.equal(recovered.get('source'), text); assert.equal(recovered.get('remainder'), text.slice(2));
  const directory = JSON.parse(recovered.get('directory')); assert.equal(directory.preview, true); assert.equal(directory.complete, false);
  assert.ok(pages.flatMap(page => page.chunks).some(chunk => chunk.scope === 'directory-preview-page'));
  assert.ok(pages.flatMap(page => page.chunks).some(chunk => chunk.scope === 'remainder-from-utf16-2'));
});

test('all API/CLI errors are bounded and never imply complete, including hostile long inputs', async t => {
  const f = await setup(t);
  const variants = [[], ['unknown', unicode.repeat(10000)], ['open', 'origin', 'worker', AGENT, '--max-bytes', '8193'],
    ['open', 'origin', 'worker', AGENT, '--max-bytes', '1'], ['batch', unicode.repeat(10000), '--max-bytes', '1024']];
  for (const args of variants) { const value = bounded(await runBatch(f.project, args), 1024); assert.ok(value.error); assert.equal(value.complete, false); assert.equal(value.nextCursor, null); }
  const cli = f.execute(campaignRelative + '/coverage-batch.mjs', ['batch', 'unbound.json', '--max-bytes', '1024'], false);
  assert.ok(Buffer.byteLength(cli.stdout, 'utf8') <= 1024); assert.equal(cli.stderr, ''); assert.equal(JSON.parse(cli.stdout).complete, false);
});
