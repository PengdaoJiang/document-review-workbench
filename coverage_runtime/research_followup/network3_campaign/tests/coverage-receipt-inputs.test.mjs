import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {runReceiptInputs, prepareReceiptInputs} from '../protocols/receipt-inputs-v1/coverage-receipt-inputs.mjs';
import {runBatch, serializedBytes} from '../coverage-batch.mjs';
import {canonical, hash} from '../coverage-core.mjs';
import {fixture, installCoverage, copyModuleClosure, candidateFor, refreshBasis,
  campaignRelative, cleanRelative, read, digest} from './fixtures/context-kit/fixture.mjs';

// workerCount=1; run with --test-concurrency=1. Only synthetic fixtures execute.
// Every source, runtime stub, ledger, receipt, output and derived directory is
// inside the existing fixture's unique, validated temporary project. Production
// paper content, scientific state and existing fixtures are never modified.
const MODULE = campaignRelative + '/protocols/receipt-inputs-v1/coverage-receipt-inputs.mjs';
const WORKER = 'synthetic-worker-c001', REVIEWER = 'synthetic-reviewer-c001';
const unicode = '🧪中文é e\u0301\\\"\r\n\t𝄞';
const absolute = (f, name) => path.resolve(f.project, typeof name === 'string' ? name : name.path);
const pathKey = name => process.platform === 'win32' ? path.resolve(name).toLowerCase() : path.resolve(name);
function bounded(value, maxBytes = 8192) {
  assert.ok(serializedBytes(value) <= maxBytes, `JSON plus newline ${serializedBytes(value)} exceeds ${maxBytes}`);
  return value;
}
function good(value, maxBytes = 8192) {
  bounded(value, maxBytes); assert.equal(value.error, undefined, value.error); return value;
}
function denied(value, pattern = /./, maxBytes = 8192) {
  bounded(value, maxBytes); assert.equal(typeof value.error, 'string'); assert.match(value.error, pattern);
  assert.equal(value.complete, false); assert.equal(value.nextCursor, null);
  assert.equal(value.scientificAcceptance, false); return value;
}
function inventory(directory) {
  const files = {};
  const visit = (relative = '') => {
    for (const entry of fs.readdirSync(path.join(directory, relative), {withFileTypes: true})) {
      const name = path.join(relative, entry.name), file = path.join(directory, name);
      if (entry.isDirectory()) visit(name);
      else files[name] = [digest(file), String(fs.statSync(file, {bigint: true}).mtimeNs)];
    }
  };
  visit(); return files;
}
async function setup(t, {large = false} = {}) {
  const f = installCoverage(fixture(t));
  copyModuleClosure(f.project, MODULE);
  f.invoke('init'); f.command('prepare');
  f.command('assign', {role: 'worker', agent: WORKER, freshContext: true, historyInherited: false});
  const scan = read(f.paper().scan.path), candidate = candidateFor(f, scan, {author: WORKER});
  const scriptText = '// Synthetic input only; never executed by this reader.\r\n' + unicode.repeat(large ? 350 : 3);
  const script = f.put(f.paper().workRoot + '/synthetic-script.mjs', scriptText);
  const child = f.put(f.paper().workRoot + '/not-a-direct-input.txt', 'SECRET_UNBOUND_RECURSIVE_CHILD');
  const config = f.put(f.paper().workRoot + '/synthetic-config.json', {synthetic: true, text: unicode.repeat(large ? 220 : 2), child});
  const output = f.put(f.paper().workRoot + '/synthetic-output.json', {synthetic: true, answer: 1});
  const source = scan.resources.find(resource => resource.type === 'text');
  const sourceRef = {path: source.path, sha256: source.sha256};
  const receipt = {schemaVersion: 1, paperId: 'origin', tool: 'synthetic-fixture', version: '1',
    command: ['synthetic-test', 'not-real-science'], workerCount: 1,
    startedAt: '2026-10-24T00:00:00Z', finishedAt: '2026-10-24T00:00:01Z', exitCode: 0,
    inputs: [script, config, sourceRef], outputs: [output]};
  const receiptRef = f.put(f.paper().workRoot + '/synthetic-execution.receipt.json', receipt);
  // The fixture's numeric sample supports an empirical obligation only; keep
  // the unchanged production validator's prohibition on numeric-as-proof.
  Object.assign(candidate.inventory.items[0].obligations[0], {kind: 'empirical',
    statement: 'Check one explicitly synthetic numeric sample only',
    successCriterion: 'The synthetic sample output records answer=1; no general proof claim'});
  refreshBasis(candidate);
  candidate.assessments[0].evidence = [{kind: 'new', method: 'numeric_test', artifacts: [output],
    mapping: {scope: 'One synthetic sample', conditions: 'Same synthetic conditions', dependencyCompatibility: 'No external premises'},
    execution: {receipt: receiptRef}}];
  const candidateRef = f.put(f.paper().workRoot + '/candidate.json', candidate);
  f.command('intake', {agent: WORKER, ownerFinished: true, candidatePath: candidateRef.path});
  f.command('assign', {role: 'reviewer', agent: REVIEWER, freshContext: true, historyInherited: false});
  const open = (ref = receiptRef, extra = []) => runReceiptInputs(f.project,
    ['open', 'origin', 'reviewer', REVIEWER, ref.path, ref.sha256, ...extra]);
  const opened = good(await open());
  const manifest = (requests, fields = {}, name = 'receipt-inputs-manifest.json') => f.put(f.paper().staged.reviewRoot + '/' + name,
    {schemaVersion: 1, paperId: 'origin', role: 'reviewer', agent: REVIEWER, sessionKey: opened.sessionKey, receipt: receiptRef, requests, ...fields});
  return {...f, scan, candidate, candidateRef, script, scriptText, config, child, output, sourceRef, receipt, receiptRef, open, opened, manifest};
}
async function recover(f, manifest, {maxBytes = 8192, first = null} = {}) {
  const recovered = new Map(), offsets = new Map(), pages = [];
  let page = first ?? good(await runReceiptInputs(f.project, ['batch', manifest.path, '--max-bytes', String(maxBytes)]), maxBytes);
  let lastCursor = null;
  for (let turn = 0; ; turn++) {
    assert.ok(turn < 1000, 'Pagination must make bounded progress'); good(page, maxBytes); pages.push(page);
    for (const chunk of page.chunks) {
      assert.equal(chunk.offset, offsets.get(chunk.id) ?? 0);
      assert.equal(chunk.end - chunk.offset, chunk.chunk.length);
      assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.chunk) && !/[\uD800-\uDBFF]$/.test(chunk.chunk), 'No split surrogate pairs');
      offsets.set(chunk.id, chunk.end); recovered.set(chunk.id, (recovered.get(chunk.id) ?? '') + chunk.chunk);
      if (chunk.complete) { assert.equal(chunk.end, chunk.total); assert.equal(hash(recovered.get(chunk.id)), chunk.sha256); }
    }
    if (page.complete) { assert.equal(page.nextCursor, null); break; }
    assert.ok(page.nextCursor && page.nextCursor !== lastCursor); lastCursor = page.nextCursor;
    page = await runReceiptInputs(f.project, ['read', manifest.path, '--cursor', lastCursor, '--max-bytes', String(maxBytes)]);
  }
  return {recovered, pages};
}
async function observeReads(action) {
  const reads = [], original = fs.readFileSync;
  fs.readFileSync = function(filename, ...args) {
    if (typeof filename === 'string') reads.push(pathKey(filename));
    return original.call(this, filename, ...args);
  };
  try { return {value: await action(), reads}; } finally { fs.readFileSync = original; }
}
// Deliberately malformed bindings exist only in this isolated read-only test
// scenario, after genuine init/prepare/assign/intake/assign transitions. Never
// dispatch business commands under these fixtures. Restore exact bytes afterward.
async function withBindings(f, change, action) {
  const names = [f.receiptRef.path, f.paper().staged.candidate.path, campaignRelative + '/coverage/state.json'];
  const saved = names.map(name => [name, fs.readFileSync(absolute(f, name))]);
  const receipt = structuredClone(f.receipt), candidate = structuredClone(f.candidate), state = f.state();
  const paper = state.papers.find(value => value.paperId === 'origin');
  try {
    change({receipt, candidate, state, paper});
    const receiptRef = f.put(f.receiptRef.path, receipt);
    candidate.assessments[0].evidence[0].execution.receipt = receiptRef;
    paper.staged.candidate = f.put(paper.staged.candidate.path, canonical(candidate));
    f.put(campaignRelative + '/coverage/state.json', state);
    return await action(receiptRef);
  } finally { for (const [name, bytes] of saved) f.put(name, bytes); }
}

test('new one-hop reader admits exact script/config/source while unchanged old batch still refuses script/config', async t => {
  const f = await setup(t);
  assert.equal(f.opened.paperId, 'origin'); assert.equal(f.opened.role, 'reviewer');
  assert.equal(f.opened.agent, REVIEWER); assert.equal(f.opened.inputCount, 3); assert.equal(f.opened.scientificAcceptance, false);
  assert.deepEqual(f.opened.receipt, f.receiptRef);
  const old = good(await runBatch(f.project, ['open', 'origin', 'reviewer', REVIEWER]));
  for (const ref of [f.script, f.config]) {
    const manifest = f.put(f.paper().staged.reviewRoot + '/old-batch.json', {schemaVersion: 1, paperId: 'origin', role: 'reviewer',
      agent: REVIEWER, snapshotKey: old.snapshotKey, requests: [{id: 'old-ref', ref}]});
    const value = bounded(await runBatch(f.project, ['batch', manifest.path]));
    assert.match(value.error, /outside exact authorized|authorized|root/i);
  }
  const manifest = f.manifest([{id: 'script', ref: f.script}, {id: 'config', ref: f.config}, {id: 'source', ref: f.sourceRef}]);
  const before = inventory(f.project);
  const result = await recover(f, manifest);
  for (const [id, ref] of [['script', f.script], ['config', f.config], ['source', f.sourceRef]])
    assert.equal(result.recovered.get(id), fs.readFileSync(absolute(f, ref), 'utf8'));
  const prepared = await prepareReceiptInputs({root: f.project, paperId: 'origin', role: 'reviewer', agent: REVIEWER, receipt: f.receiptRef});
  assert.equal(prepared.sessionKey, f.opened.sessionKey); assert.equal(prepared.inputRefs.length, 3);
  assert.equal(await prepared.readInput(f.script), f.scriptText); await prepared.recheck();
  const cli = f.execute(MODULE, ['batch', manifest.path, '--max-bytes', '8192']);
  assert.equal(cli.stderr, ''); assert.equal(cli.stdout.trim().split('\n').length, 1);
  assert.ok(Buffer.byteLength(cli.stdout, 'utf8') <= 8192); assert.deepEqual(cli.value, result.pages[0]);
  assert.deepEqual(inventory(f.project), before, 'Opening/reading/CLI must not change files or mtimes');
});

test('large Unicode script/config paginate losslessly, stable cursors preserve duplicate-ref request identities', async t => {
  const f = await setup(t, {large: true});
  const manifest = f.manifest([{id: 'script', ref: f.script}, {id: 'config', ref: f.config}, {id: 'same-script', ref: f.script}]);
  const first = good(await runReceiptInputs(f.project, ['batch', manifest.path, '--max-bytes', '2048']), 2048);
  assert.equal(first.complete, false); assert.ok(first.nextCursor);
  assert.deepEqual(await runReceiptInputs(f.project, ['batch', manifest.path, '--max-bytes', '2048']), first);
  const result = await recover(f, manifest, {maxBytes: 2048, first});
  assert.ok(result.pages.length > 4); assert.equal(result.recovered.get('script'), f.scriptText);
  assert.equal(result.recovered.get('same-script'), f.scriptText);
  assert.equal(result.recovered.get('config'), fs.readFileSync(absolute(f, f.config), 'utf8'));
  const changedBudget = good(await runReceiptInputs(f.project, ['read', manifest.path, '--cursor', first.nextCursor, '--max-bytes', '1024']), 1024);
  assert.ok(changedBudget.chunks.length);
  const oldOpen = good(await runBatch(f.project, ['open', 'origin', 'reviewer', REVIEWER]));
  const oldNotes = f.put(f.paper().staged.reviewRoot + '/old-reader-notes.txt', unicode.repeat(150));
  const oldManifest = f.put(f.paper().staged.reviewRoot + '/old-cursor-manifest.json', {schemaVersion: 1, paperId: 'origin',
    role: 'reviewer', agent: REVIEWER, snapshotKey: oldOpen.snapshotKey, requests: [{id: 'old-notes', ref: oldNotes}]});
  const oldPage = good(await runBatch(f.project, ['batch', oldManifest.path, '--max-bytes', '1024']), 1024);
  assert.ok(oldPage.nextCursor);
  denied(await runReceiptInputs(f.project, ['read', manifest.path, '--cursor', oldPage.nextCursor]), /cursor|snapshot|batch/i);
  const badCursor = first.nextCursor.slice(0, -1) + (first.nextCursor.endsWith('0') ? '1' : '0');
  denied(await runReceiptInputs(f.project, ['read', manifest.path, '--cursor', badCursor]), /cursor/i);
  const edited = read(absolute(f, manifest)); edited.requests[0].id = 'renamed'; f.put(manifest.path, edited);
  denied(await runReceiptInputs(f.project, ['read', manifest.path, '--cursor', first.nextCursor]), /cursor|changed|manifest/i);
});

test('unbound receipt and recursively mentioned JSON child never grant content access', async t => {
  const f = await setup(t);
  const unbound = f.put(f.paper().workRoot + '/unbound-receipt.json', {...f.receipt, marker: 'SECRET_UNBOUND_RECEIPT'});
  const deniedReceipt = await observeReads(() => f.open(unbound));
  denied(deniedReceipt.value, /explicitly bound|receipt/i);
  assert.ok(!deniedReceipt.reads.includes(pathKey(absolute(f, unbound))));
  for (const ref of [f.child, f.output, {...f.script, sha256: '0'.repeat(64)}]) {
    const manifest = f.manifest([{id: 'not-input', ref}]);
    const observed = await observeReads(() => runReceiptInputs(f.project, ['batch', manifest.path]));
    denied(observed.value, /direct receipt input|exact|reference/i);
    if (ref.path === f.child.path) assert.ok(!observed.reads.includes(pathKey(absolute(f, ref))));
    assert.ok(!JSON.stringify(observed.value).includes('SECRET_'));
  }
  const prepared = await prepareReceiptInputs({root: f.project, paperId: 'origin', role: 'reviewer', agent: REVIEWER, receipt: f.receiptRef});
  await assert.rejects(async () => prepared.readInput(f.child), /direct receipt input/i);
});

test('receipt input scope rejects other papers, private roots, versions, arbitrary paths and traversal before byte reads', async t => {
  const f = await setup(t);
  const forbidden = [
    f.put(cleanRelative + '/coverage_work/r0001/c001/secret.txt', 'SECRET_FOREIGN'),
    f.put(f.paper().staged.reviewRoot + '/secret.txt', 'SECRET_PRIVATE_REVIEW'),
    f.put(cleanRelative + '/coverage_work/origin/c000/secret.txt', 'SECRET_HISTORICAL'),
    f.put(cleanRelative + '/coverage_work/origin/c002/secret.txt', 'SECRET_FUTURE'),
    f.put('arbitrary-source.txt', 'SECRET_ARBITRARY'),
    f.put('reconstructed_sources/dot-20261023/papers/origin/source/not-in-scan.txt', 'SECRET_UNBOUND_SOURCE')
  ];
  forbidden.push({path: f.paper().workRoot + '/../../../../arbitrary-source.txt', sha256: forbidden[4].sha256});
  for (const ref of forbidden) await withBindings(f, ({receipt}) => { receipt.inputs.push(ref); }, async receiptRef => {
    const observed = await observeReads(() => f.open(receiptRef));
    denied(observed.value, /outside|root|travers|path/i);
    assert.ok(!observed.reads.includes(pathKey(absolute(f, ref))), 'Unauthorized input must not be hashed or read');
    assert.ok(!JSON.stringify(observed.value).includes('SECRET_'));
  });
  const privateReceipt = f.put(f.paper().staged.reviewRoot + '/private-receipt.json', f.receipt);
  const observed = await observeReads(() => f.open(privateReceipt));
  denied(observed.value, /constructor root|receipt/i);
  assert.ok(!observed.reads.includes(pathKey(absolute(f, privateReceipt))));
});

test('linked directory input is denied before target reads; Windows privilege absence is explicitly skipped', async t => {
  const f = await setup(t), target = f.put('symlink-target/secret.txt', 'SECRET_SYMLINK_TARGET');
  const link = absolute(f, f.paper().workRoot + '/linked-input');
  try { fs.symlinkSync(path.dirname(absolute(f, target)), link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('Windows cannot create isolated link fixture: ' + error.code); return;
    }
    throw error;
  }
  const ref = {path: f.paper().workRoot + '/linked-input/secret.txt', sha256: target.sha256};
  await withBindings(f, ({receipt}) => { receipt.inputs.push(ref); }, async receiptRef => {
    const observed = await observeReads(() => f.open(receiptRef)); denied(observed.value, /link|realpath|path/i);
    assert.ok(!observed.reads.includes(pathKey(absolute(f, ref))) && !observed.reads.includes(pathKey(absolute(f, target))));
  });
});

test('candidate, owner, receipt and input changes invalidate old sessions/cursors; unrelated global progress does not', async t => {
  const f = await setup(t, {large: true}), manifest = f.manifest([{id: 'script', ref: f.script}]);
  const first = good(await runReceiptInputs(f.project, ['batch', manifest.path])); assert.ok(first.nextCursor);
  const resume = () => runReceiptInputs(f.project, ['read', manifest.path, '--cursor', first.nextCursor]);
  const statePath = campaignRelative + '/coverage/state.json', initialState = fs.readFileSync(absolute(f, statePath));
  const global = f.state(); global.revision++; global.papers.find(paper => paper.paperId === 'r0001').phase = 'unrelated-synthetic-progress';
  f.put(statePath, global); good(await resume()); assert.equal(good(await f.open()).sessionKey, f.opened.sessionKey);
  f.put(statePath, initialState);
  for (const [name, value] of [
    [f.script.path, 'Tampered synthetic script'],
    [f.receiptRef.path, JSON.stringify({...f.receipt, version: 'changed'})],
    [f.paper().staged.candidate.path, canonical({...f.candidate, author: 'changed-worker'})]
  ]) {
    const bytes = fs.readFileSync(absolute(f, name));
    try { f.put(name, value); denied(await resume(), /hash|changed|candidate|mismatch/i); }
    finally { f.put(name, bytes); }
  }
  const changed = f.state(); changed.papers.find(paper => paper.paperId === 'origin').owner.agent = 'different-reviewer';
  f.put(statePath, changed); denied(await resume(), /owner|reviewer|session|matching/i); f.put(statePath, initialState);
  await withBindings(f, ({candidate}) => { candidate.assessments[0].summary += ' changed semantic binding'; }, async receiptRef => {
    assert.notEqual(good(await f.open(receiptRef)).sessionKey, f.opened.sessionKey);
    denied(await resume(), /session|stale/i);
  });
  const moduleBytes = fs.readFileSync(absolute(f, MODULE));
  try {
    f.put(MODULE, Buffer.concat([moduleBytes, Buffer.from('\n// Synthetic module seal changed, not executed.\n')]));
    assert.notEqual(good(await f.open()).sessionKey, f.opened.sessionKey);
    denied(await resume(), /session|stale/i);
  } finally { f.put(MODULE, moduleBytes); }
});

test('prepared guard detects post-read tampering and batch discards a response changed during its content read', async t => {
  const f = await setup(t), options = {root: f.project, paperId: 'origin', role: 'reviewer', agent: REVIEWER, receipt: f.receiptRef};
  const prepareTrace = await observeReads(() => prepareReceiptInputs(options)), prepared = prepareTrace.value;
  const inputTrace = await observeReads(() => prepared.readInput(f.script)); assert.equal(inputTrace.value, f.scriptText);
  const target = pathKey(absolute(f, f.script));
  const contentReadCount = [...prepareTrace.reads, ...inputTrace.reads].filter(name => name === target).length;
  assert.ok(contentReadCount > 1, 'Measure the guarded prepare plus actual content-read sequence');
  f.put(f.script.path, 'Changed after read'); await assert.rejects(async () => prepared.recheck(), /hash|changed|mismatch/i);
  f.put(f.script.path, f.scriptText);
  const manifest = f.manifest([{id: 'script', ref: f.script}]);
  const original = fs.readFileSync; let reads = 0, mutated = false;
  fs.readFileSync = function(filename, ...args) {
    const bytes = original.call(this, filename, ...args);
    // Corrupt after the final content read measured above, without depending
    // on a hardcoded count of internal integrity checks.
    if (typeof filename === 'string' && pathKey(filename) === target && ++reads === contentReadCount) {
      f.put(f.script.path, 'Changed during content read'); mutated = true;
    }
    return bytes;
  };
  try { denied(await runReceiptInputs(f.project, ['batch', manifest.path]), /hash|changed|mismatch/i); assert.equal(mutated, true); }
  finally { fs.readFileSync = original; }
});

test('sealed candidate must match current paper, scan, revision, author and new-evidence linkage', async t => {
  const f = await setup(t);
  for (const change of [
    candidate => { candidate.paperId = 'r0001'; },
    candidate => { candidate.scanSha256 = '0'.repeat(64); },
    candidate => { candidate.revision = 2; },
    candidate => { candidate.author = 'another-worker'; },
    candidate => { candidate.assessments[0].evidence[0].kind = 'reused'; }
  ]) await withBindings(f, ({candidate}) => change(candidate), async receiptRef => {
    const observed = await observeReads(() => f.open(receiptRef));
    denied(observed.value, /candidate|binding|explicitly bound/i);
    assert.ok(!observed.reads.includes(pathKey(absolute(f, f.script))), 'Invalid candidate must fail before receipt-input hashing');
  });
});

test('failed/malformed receipt and uncovered/foreign outputs cannot authorize inputs', async t => {
  const f = await setup(t);
  const foreign = f.put(cleanRelative + '/coverage_work/r0001/c001/foreign-output.json', {secret: 'SECRET_FOREIGN_OUTPUT'});
  const cases = [
    receipt => { receipt.exitCode = 1; },
    receipt => { receipt.paperId = 'r0001'; },
    receipt => { receipt.workerCount = 0; },
    receipt => { receipt.startedAt = '2026-10-24T00:01:00Z'; },
    receipt => { receipt.invocation = ['second-command']; },
    receipt => { receipt.outputs = []; },
    receipt => { receipt.outputs = [f.script]; },
    receipt => { receipt.outputs = [foreign]; },
    receipt => { receipt.inputs = [{...f.sourceRef, sha256: 'f'.repeat(64)}]; }
  ];
  for (const change of cases) await withBindings(f, ({receipt}) => change(receipt), async receiptRef => {
    const observed = await observeReads(() => f.open(receiptRef)); denied(observed.value, /receipt|time|invocation|outputs|Input|workerCount/i);
    assert.ok(!observed.reads.includes(pathKey(absolute(f, foreign))));
    assert.ok(!JSON.stringify(observed.value).includes('SECRET_'));
  });
  await withBindings(f, ({candidate}) => { candidate.assessments[0].evidence[0].artifacts = [foreign]; }, async receiptRef => {
    const observed = await observeReads(() => f.open(receiptRef)); denied(observed.value, /artifact|constructor/i);
    assert.ok(!observed.reads.includes(pathKey(absolute(f, foreign))));
  });
  const secondArtifact = f.put(f.paper().workRoot + '/second-linked-artifact.txt', 'Synthetic uncovered linked artifact');
  await withBindings(f, ({candidate}) => {
    const second = structuredClone(candidate.assessments[0].evidence[0]); second.artifacts = [secondArtifact];
    candidate.assessments[1].evidence.push(second);
  }, async receiptRef => {
    denied(await f.open(receiptRef), /outputs.*cover.*linked|artifact/i);
  });
});

test('strict manifest, current-reviewer identity and bounded CLI errors fail closed', async t => {
  const f = await setup(t), request = {id: 'script', ref: f.script};
  for (const fields of [{schemaVersion: 2}, {paperId: 'r0001'}, {role: 'worker'}, {agent: 'foreign-agent'}, {unexpected: true},
    {requests: [{...request, argv: ['get', 'anything']}]}, {requests: [request, request]}, {requests: []}]) {
    const manifest = f.manifest([request], fields); denied(await runReceiptInputs(f.project, ['batch', manifest.path, '--max-bytes', '1024']), /./, 1024);
  }
  const own = f.manifest([request]);
  const outside = f.put(f.paper().workRoot + '/wrong-root-manifest.json', read(absolute(f, own)));
  const observed = await observeReads(() => runReceiptInputs(f.project, ['batch', outside.path]));
  denied(observed.value, /manifest|reviewer|root/i); assert.ok(!observed.reads.includes(pathKey(absolute(f, outside))));
  for (const args of [[], ['open', 'origin', 'worker', WORKER, f.receiptRef.path, f.receiptRef.sha256],
    ['open', 'origin', 'reviewer', 'forged-agent', f.receiptRef.path, f.receiptRef.sha256],
    ['batch', own.path, '--max-bytes', '1023'], ['batch', own.path, '--max-bytes', '8193'],
    ['batch', own.path, '--max-bytes', '1024', '--max-bytes', '1024']]) denied(await runReceiptInputs(f.project, args));
  const cli = f.execute(MODULE, ['batch', outside.path, '--max-bytes', '1024'], false);
  assert.equal(cli.stderr, ''); assert.equal(cli.stdout.trim().split('\n').length, 1);
  assert.ok(Buffer.byteLength(cli.stdout, 'utf8') <= 1024); denied(JSON.parse(cli.stdout), /./, 1024);
});
