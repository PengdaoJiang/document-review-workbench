import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {canonical, hash} from '../coverage-core.mjs';
import {prepareSourceReceiptInputs, runSourceReceiptInputs, MODULE_PATH} from '../protocols/source-receipt-inputs-v1/coverage-source-receipt-inputs.mjs';
import {runReceiptInputs as ordinaryReader} from '../protocols/receipt-inputs-v1/coverage-receipt-inputs.mjs';
import {runBatch as branchBatch, serializedBytes} from '../protocols/source-binding-v1-checkpoint/coverage-batch.mjs';
import {setupSource} from './fixtures/source-receipt-inputs/fixture.mjs';
import {candidateFor, copyModuleClosure, campaignRelative, cleanRelative, read, digest} from './fixtures/source-binding/fixture.mjs';

// One independent temporary project, workerCount=1, awaited serial subtests.
// Genuine neutral checkpoint adoption establishes the immutable c001 lineage.
// The c003 snapshot is an explicitly synthetic read-boundary fixture, not a
// scientific dispatch, decision or a claim that c001/c002 were accepted.
const REVIEWER = 'synthetic-source-c003-reviewer', WORKER = 'synthetic-source-c003-worker';
const STATE = campaignRelative + '/coverage/state.json';
const ordinaryModule = campaignRelative + '/protocols/receipt-inputs-v1/coverage-receipt-inputs.mjs';
const unicode = '🧪中文é e\u0301\\\"\r\n\t𝄞';
const absolute = (f, value) => path.resolve(f.project, typeof value === 'string' ? value : value.path);
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function bounded(value, max = 8192) { assert.ok(serializedBytes(value) <= max, 'Entire JSON plus newline exceeds budget'); return value; }
function good(value, max = 8192) { bounded(value, max); assert.equal(value.error, undefined, value.error); return value; }
function denied(value, pattern = /./, max = 8192) {
  bounded(value, max); assert.equal(typeof value.error, 'string'); assert.match(value.error, pattern);
  assert.equal(value.complete, false); assert.equal(value.nextCursor, null); assert.equal(value.scientificAcceptance, false); return value;
}
function inventory(root) {
  const result = {};
  const visit = (relative = '') => {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const name = path.join(relative, entry.name), filename = path.join(root, name);
      if (entry.isDirectory()) visit(name);
      else result[name] = [digest(filename), String(fs.statSync(filename, {bigint: true}).mtimeNs)];
    }
  };
  visit(); return result;
}
async function observeReads(action) {
  const original = fs.readFileSync, reads = [];
  fs.readFileSync = function(filename, ...args) {
    if (typeof filename === 'string') reads.push(key(filename));
    return original.call(this, filename, ...args);
  };
  try { return {value: await action(), reads}; } finally { fs.readFileSync = original; }
}
async function withBytes(f, ref, bytes, action) {
  const filename = absolute(f, ref), saved = fs.readFileSync(filename);
  try { f.put(filename, bytes); return await action(); } finally { f.put(filename, saved); }
}
async function withState(f, change, action) {
  const saved = fs.readFileSync(absolute(f, STATE)), state = f.state();
  try { change(state, state.papers.find(p => p.paperId === 'origin')); f.put(STATE, canonical(state)); return await action(); }
  finally { f.put(STATE, saved); }
}

async function setup(t) {
  const f = setupSource(t);
  copyModuleClosure(f.project, MODULE_PATH); copyModuleClosure(f.project, ordinaryModule);
  const workRoot = cleanRelative + '/coverage_work/origin/c003';
  const reviewRoot = cleanRelative + '/coverage_verifications/origin/c003';
  const versionRoot = campaignRelative + '/coverage/origin/c003';
  const state = f.state(), paper = state.papers.find(p => p.paperId === 'origin');
  const order = f.put(versionRoot + '/worker.md', 'Synthetic c003 constructor order; no actual dispatch.');
  const reviewOrder = f.put(versionRoot + '/reviewer.md', 'Synthetic c003 independent reader boundary.');
  const guardProfile = f.put(versionRoot + '/guard-order.json', canonical({schemaVersion: 1, profile: 'source-scope-v1',
    paperId: 'origin', iteration: 3, policy: state.guardPolicy, scan: paper.scan, order, workRoot}));
  const guardGuide = f.put(versionRoot + '/guard-order.md', 'Synthetic c003 guard guide.');
  const sourceBinding = paper.sourceEnrollment.sourceBinding;
  const source = f.sourceView.resources.find(resource => resource.type === 'text');
  const sourceRef = {path: source.path, sha256: source.sha256};
  const supplementRef = {path: f.binding.supplement.path, sha256: f.binding.supplement.sha256};
  const integrityOnlyInput = {path: f.answer, sha256: digest(f.answer)};
  const child = f.put(workRoot + '/not-a-direct-input.txt', 'SECRET_NOT_A_DIRECT_INPUT');
  const executionMarker = absolute(f, workRoot + '/reader-must-not-execute.marker');
  const scriptText = "import fs from 'node:fs';\r\nfs.writeFileSync(" + JSON.stringify(executionMarker)
    + ", 'READER_EXECUTED_INPUT');\r\nthrow new Error('READER_MUST_NOT_EXECUTE');\r\n/* " + unicode.repeat(160) + ' */';
  const script = f.put(workRoot + '/synthetic-input.mjs', scriptText);
  const config = f.put(workRoot + '/synthetic-config.json', {fixtureOnly: true, unicode: unicode.repeat(90), nestedRef: child});
  const output = f.put(workRoot + '/synthetic-output.json', {fixtureOnly: true, value: 1});
  const artifact = f.put(workRoot + '/synthetic-derivation.txt', 'Synthetic read fixture, not a scientific claim.');
  const receipt = {schemaVersion: 1, paperId: 'origin', tool: 'synthetic-receipt', version: '1',
    invocation: ['never-run-this-reader-input'], workerCount: 1, startedAt: '2026-10-29T00:00:00Z',
    finishedAt: '2026-10-29T00:00:01Z', exitCode: 0, inputs: [script, config, sourceRef, supplementRef, integrityOnlyInput], outputs: [output]};
  const receiptRef = f.put(workRoot + '/execution-receipt.json', canonical(receipt));
  const candidate = candidateFor(f, f.sourceView, {author: WORKER});
  Object.assign(candidate, {schemaVersion: 2, revision: 3, scanSha256: paper.scan.sha256, sourceBinding});
  // Replace candidateFor's default c001 new evidence with current synthetic refs.
  for (const assessment of candidate.assessments) for (const evidence of assessment.evidence) evidence.artifacts = [artifact];
  candidate.assessments[0].evidence = [{kind: 'new', method: 'analytic_derivation', artifacts: [output],
    mapping: {scope: 'Synthetic only', conditions: 'Synthetic only', dependencyCompatibility: 'Synthetic only'}, execution: {receipt: receiptRef}}];
  const candidateRef = f.put(versionRoot + '/candidate.json', canonical(candidate));
  const scope = {schemaVersion: 2, paperId: 'origin', revision: 3, scanSha256: paper.scan.sha256,
    candidateSha256: candidateRef.sha256, author: WORKER, sourceBinding,
    inventory: {complete: false, missingClaims: [], notes: 'Synthetic read-scope binding only, no acceptance'},
    cards: [], alignments: [], legacyRetainedObligationIds: []};
  const scopeRef = f.put(versionRoot + '/source-scope-v2.json', canonical(scope));
  Object.assign(paper, {iteration: 3, phase: 'source_reviewing', workRoot, order,
    owner: {agent: REVIEWER, role: 'reviewer', startedAt: '2026-10-29T00:00:03Z'},
    workerHistory: [...paper.workerHistory, WORKER], guardEnrollment: {profile: guardProfile, instructions: guardGuide},
    staged: {candidate: candidateRef, worker: WORKER, workOrder: order, reviewRoot, reviewOrder,
      guard: {contract: scopeRef, enrollment: {profile: guardProfile, instructions: guardGuide}, references: [scopeRef]}}});
  state.revision++; f.put(STATE, canonical(state));
  const open = (ref = receiptRef, extra = []) => runSourceReceiptInputs(f.project,
    ['open', 'origin', 'reviewer', REVIEWER, ref.path, ref.sha256, ...extra]);
  const opened = good(await open());
  const manifest = (requests, fields = {}, name = 'source-receipt-inputs-manifest.json') => f.put(reviewRoot + '/' + name,
    {schemaVersion: 1, paperId: 'origin', role: 'reviewer', agent: REVIEWER, sessionKey: opened.sessionKey,
      receipt: receiptRef, requests, ...fields});
  return {...f, workRoot, reviewRoot, versionRoot, sourceBinding, sourceRef, supplementRef, integrityOnlyInput, script, scriptText,
    config, child, output, artifact, receipt, receiptRef, candidate, candidateRef, scope, scopeRef, open, opened, manifest};
}

// Mutations are entirely inside the isolated test fixture. Rebind mechanical
// hashes so negative cases reach their intended boundary, then restore bytes.
async function withBindings(f, change, action) {
  const names = [f.receiptRef.path, f.candidateRef.path, f.scopeRef.path, STATE];
  const saved = names.map(name => [name, fs.readFileSync(absolute(f, name))]);
  const receipt = structuredClone(f.receipt), candidate = structuredClone(f.candidate), scope = structuredClone(f.scope), state = f.state();
  const paper = state.papers.find(p => p.paperId === 'origin');
  try {
    change({receipt, candidate, scope, state, paper});
    const receiptRef = f.put(f.receiptRef.path, canonical(receipt));
    for (const assessment of candidate.assessments) for (const evidence of assessment.evidence)
      if (evidence.execution?.receipt?.path === f.receiptRef.path) evidence.execution.receipt = receiptRef;
    paper.staged.candidate = f.put(f.candidateRef.path, canonical(candidate));
    scope.candidateSha256 = paper.staged.candidate.sha256;
    paper.staged.guard.contract = f.put(f.scopeRef.path, canonical(scope));
    f.put(STATE, canonical(state));
    return await action(receiptRef);
  } finally { for (const [name, bytes] of saved) f.put(name, bytes); }
}
async function recover(f, manifest, maxBytes = 4096) {
  const texts = new Map(), offsets = new Map(), pages = [];
  let page = good(await runSourceReceiptInputs(f.project, ['batch', manifest.path, '--max-bytes', String(maxBytes)]), maxBytes);
  for (let count = 0; ; count++) {
    assert.ok(count < 100, 'Pagination must make bounded progress'); good(page, maxBytes); pages.push(page);
    for (const chunk of page.chunks) {
      assert.equal(chunk.offset, offsets.get(chunk.id) ?? 0); assert.equal(chunk.end - chunk.offset, chunk.chunk.length);
      assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.chunk) && !/[\uD800-\uDBFF]$/.test(chunk.chunk), 'Never split a surrogate pair');
      texts.set(chunk.id, (texts.get(chunk.id) ?? '') + chunk.chunk); offsets.set(chunk.id, chunk.end);
      if (chunk.complete) { assert.equal(chunk.end, chunk.total); assert.equal(hash(texts.get(chunk.id)), chunk.sha256); }
    }
    if (page.complete) { assert.equal(page.nextCursor, null); break; }
    assert.ok(page.nextCursor); page = await runSourceReceiptInputs(f.project, ['read', manifest.path, '--cursor', page.nextCursor, '--max-bytes', String(maxBytes)]);
  }
  return {texts, pages};
}

test('current source-binding receipt inputs use one isolated c003 fixture and serial boundary regressions', async t => {
  const f = await setup(t);

  await t.test('legitimate c003 direct script/config/complete source supplement paginate losslessly without writes or execution', async () => {
    assert.equal(f.opened.inputCount, 4); assert.equal(f.opened.receiptInputCount, 5); assert.equal(f.opened.integrityOnlyInputCount, 1);
    assert.deepEqual(f.opened.sourceBinding, f.sourceBinding); assert.deepEqual(f.opened.scope, f.scopeRef);
    const manifest = f.manifest([{id: 'script', ref: f.script}, {id: 'config', ref: f.config}, {id: 'supplement', ref: f.supplementRef}]);
    const before = inventory(f.project), result = await recover(f, manifest);
    assert.ok(result.pages.length >= 2); assert.equal(result.texts.get('script'), f.scriptText);
    for (const [id, ref] of [['config', f.config], ['supplement', f.supplementRef]]) assert.equal(result.texts.get(id), fs.readFileSync(absolute(f, ref), 'utf8'));
    const prepared = await prepareSourceReceiptInputs({root: f.project, paperId: 'origin', role: 'reviewer', agent: REVIEWER, receipt: f.receiptRef});
    assert.equal(prepared.readInput(f.script), f.scriptText); prepared.recheck();
    assert.deepEqual(inventory(f.project), before, 'Reader must not mutate any file bytes or mtimes');
  });

  await t.test('unchanged branch batch still refuses script/config, and ordinary schema1 route cannot impersonate source reviewer', async () => {
    denied(await ordinaryReader(f.project, ['open', 'origin', 'reviewer', REVIEWER, f.receiptRef.path, f.receiptRef.sha256]), /ordinary|matching|reviewer/i);
    const old = good(await branchBatch(f.project, ['open', 'origin', 'reviewer', REVIEWER]));
    for (const ref of [f.script, f.config]) {
      const manifest = f.put(f.reviewRoot + '/old-branch-manifest.json', {schemaVersion: 1, paperId: 'origin', role: 'reviewer',
        agent: REVIEWER, snapshotKey: old.snapshotKey, requests: [{id: 'ref', ref}]});
      const value = bounded(await branchBatch(f.project, ['batch', manifest.path])); assert.match(value.error, /outside exact authorized|authorized|root/i);
    }
  });

  await t.test('role, actor, constructor history, phase, roots and current iteration fail closed', async () => {
    for (const args of [['worker', WORKER], ['reviewer', 'another-reviewer']])
      denied(await runSourceReceiptInputs(f.project, ['open', 'origin', ...args, f.receiptRef.path, f.receiptRef.sha256]));
    for (const change of [
      paper => { paper.phase = 'reviewing'; }, paper => { paper.owner.role = 'worker'; },
      paper => { paper.workerHistory.push(REVIEWER); }, paper => { paper.iteration = 2; },
      paper => { paper.staged.reviewRoot = f.reviewRoot.replace('c003', 'c002'); }
    ]) await withState(f, (_, paper) => change(paper), async () => denied(await f.open()));
  });

  await t.test('sealed schema2 candidate, current scope and exact sourceBinding cannot be mixed or downgraded', async () => {
    for (const change of [
      ({candidate}) => { candidate.schemaVersion = 1; }, ({candidate}) => { candidate.author = 'other-worker'; },
      ({candidate}) => { candidate.sourceBinding = {...candidate.sourceBinding, sha256: 'f'.repeat(64)}; },
      ({scope}) => { scope.schemaVersion = 1; }, ({scope}) => { scope.revision = 2; },
      ({scope}) => { scope.sourceBinding = {...scope.sourceBinding, sha256: 'f'.repeat(64)}; }
    ]) await withBindings(f, change, async receiptRef => denied(await f.open(receiptRef), /candidate|scope|source|binding/i));
  });

  await t.test('other-paper, private, c001/c002/future, unbound package and traversal inputs are denied before content reads', async () => {
    const refs = [
      f.put(cleanRelative + '/coverage_work/r0001/c003/secret.txt', 'SECRET_OTHER_PAPER'),
      f.put(f.reviewRoot + '/secret.txt', 'SECRET_PRIVATE'),
      f.put(cleanRelative + '/coverage_work/origin/c001/unregistered-old-input.txt', 'SECRET_C001_NOT_IN_ADOPTION_HISTORY'),
      f.put(cleanRelative + '/coverage_work/origin/c002/secret.txt', 'SECRET_C002'),
      f.put(cleanRelative + '/coverage_work/origin/c004/secret.txt', 'SECRET_FUTURE'),
      f.put(path.join(path.dirname(f.answer), 'unbound-old-script.mjs'), 'SECRET_UNBOUND_OLD_RUN_SCRIPT'),
      f.put('reconstructed_sources/dot-20261023/papers/origin/source/not-in-source-binding.m', 'SECRET_UNBOUND_SOURCE')
    ];
    refs.push({path: f.workRoot + '/../c002/secret.txt', sha256: refs[3].sha256});
    for (const ref of refs) await withBindings(f, ({receipt}) => { receipt.inputs.push(ref); }, async receiptRef => {
      const observed = await observeReads(() => f.open(receiptRef)); denied(observed.value, /outside|root|path|travers/i);
      assert.ok(!observed.reads.includes(key(absolute(f, ref))), 'Denied input must not be hashed/read');
      assert.ok(!JSON.stringify(observed.value).includes('SECRET_'));
    });
  });

  await t.test('only directly bound current receipt inputs are granted, never nested refs, outputs or historical receipt aliases', async () => {
    for (const ref of [f.child, f.output, f.integrityOnlyInput, {...f.script, sha256: '0'.repeat(64)}]) {
      const manifest = f.manifest([{id: 'not-input', ref}]);
      const observed = await observeReads(() => runSourceReceiptInputs(f.project, ['batch', manifest.path]));
      denied(observed.value, /direct receipt input|exact|reference/i);
      if (ref.path === f.child.path) assert.ok(!observed.reads.includes(key(absolute(f, ref))));
    }
    const oldReceipt = f.put(cleanRelative + '/coverage_work/origin/c002/old-receipt.json', canonical(f.receipt));
    const unbound = f.put(f.workRoot + '/unbound-receipt.json', canonical(f.receipt));
    for (const ref of [oldReceipt, unbound]) {
      const observed = await observeReads(() => f.open(ref)); denied(observed.value, /receipt|constructor|bound/i);
      assert.ok(!observed.reads.includes(key(absolute(f, ref))));
    }
  });

  await t.test('receipt validity and every linked artifact/output must pass before any unauthorized output is read', async () => {
    const foreign = f.put(cleanRelative + '/coverage_work/r0001/c003/foreign-output.txt', 'SECRET_FOREIGN_OUTPUT');
    const missing = f.put(f.workRoot + '/second-linked-output.txt', 'Synthetic linked artifact absent from outputs');
    for (const change of [
      ({receipt}) => { receipt.exitCode = 1; }, ({receipt}) => { receipt.outputs = []; },
      ({receipt}) => { receipt.command = ['second-invocation']; }, ({receipt}) => { receipt.outputs = [foreign]; },
      ({candidate}) => { const shared = structuredClone(candidate.assessments[0].evidence[0]); shared.artifacts = [missing]; candidate.assessments[1].evidence.push(shared); }
    ]) await withBindings(f, change, async receiptRef => {
      const observed = await observeReads(() => f.open(receiptRef)); denied(observed.value);
      assert.ok(!observed.reads.includes(key(absolute(f, foreign))));
    });
  });

  await t.test('source/candidate/scope/receipt/input/output changes stale the session while unrelated global revision does not', async () => {
    const manifest = f.manifest([{id: 'script', ref: f.script}]), first = good(await runSourceReceiptInputs(f.project, ['batch', manifest.path, '--max-bytes', '2048']), 2048);
    assert.ok(first.nextCursor); const resume = () => runSourceReceiptInputs(f.project, ['read', manifest.path, '--cursor', first.nextCursor]);
    await withState(f, state => { state.revision++; state.papers.find(p => p.paperId === 'r0001').phase = 'unrelated-progress'; }, async () => good(await resume()));
    for (const ref of [f.sourceBinding, f.supplementRef, f.candidateRef, f.scopeRef, f.receiptRef, f.script, f.output, f.firstPass.result, f.integrityOnlyInput])
      await withBytes(f, ref, 'Synthetic changed bytes', async () => denied(await resume(), /hash|changed|mismatch|source|binding/i));
    await withState(f, (_, paper) => { paper.owner.startedAt = '2026-10-29T00:00:04Z'; }, async () => denied(await resume(), /session|stale/i));
    await withBindings(f, ({candidate}) => { candidate.assessments[0].summary += ' changed'; }, async receiptRef => {
      assert.notEqual(good(await f.open(receiptRef)).sessionKey, f.opened.sessionKey); denied(await resume(), /session|stale/i);
    });
  });

  await t.test('public-result metadata field guards reject malformed run IDs and paths before output bytes are read', async () => {
    // These are focused parser-boundary fault injections, not a claim that the
    // immutable adoption chain was re-authored. The complete exact fixture bytes
    // remain unchanged; only the parsed synthetic public-result object is varied
    // so each field guard is reached without weakening any hash validator.
    const publicText = fs.readFileSync(absolute(f, f.firstPass.result), 'utf8');
    for (const mutate of [
      evidence => { evidence.runId = '../foreign-run'; },
      evidence => { evidence.path = '../../r0001/foreign.txt'; },
      evidence => { evidence.path = absolute(f, f.integrityOnlyInput); }
    ]) {
      const originalParse = JSON.parse; let injected = 0;
      JSON.parse = function(text, ...args) {
        const value = originalParse.call(this, text, ...args);
        if (text === publicText) { mutate(value.claims[0].evidence[0]); injected++; }
        return value;
      };
      try {
        const observed = await observeReads(() => f.open()); denied(observed.value, /public evidence|run|relative|path|travers/i);
        assert.ok(injected > 0, 'The public-result field guard was actually exercised');
        assert.ok(!observed.reads.includes(key(absolute(f, f.integrityOnlyInput))), 'Malformed metadata must fail before output reads');
      } finally { JSON.parse = originalParse; }
    }
    assert.equal(fs.readFileSync(absolute(f, f.firstPass.result), 'utf8'), publicText);
  });

  await t.test('prepared recheck and final response reject changes after actual input consumption; module and manifest cursors cannot drift', async () => {
    const options = {root: f.project, paperId: 'origin', role: 'reviewer', agent: REVIEWER, receipt: f.receiptRef};
    const preparation = await observeReads(() => prepareSourceReceiptInputs(options)), prepared = preparation.value;
    const input = await observeReads(() => prepared.readInput(f.script)); assert.equal(input.value, f.scriptText);
    await withBytes(f, f.config, 'Changed after preparation', async () => assert.throws(() => prepared.recheck(), /hash|mismatch/i));
    const count = [...preparation.reads, ...input.reads].filter(name => name === key(absolute(f, f.script))).length;
    const manifest = f.manifest([{id: 'script', ref: f.script}]), originalRead = fs.readFileSync; let reads = 0, mutated = false;
    fs.readFileSync = function(name, ...args) {
      const result = originalRead.call(this, name, ...args);
      if (typeof name === 'string' && key(name) === key(absolute(f, f.script)) && ++reads === count) {
        f.put(f.script.path, 'Changed during consumption'); mutated = true;
      }
      return result;
    };
    try { denied(await runSourceReceiptInputs(f.project, ['batch', manifest.path]), /hash|changed|mismatch/i); assert.equal(mutated, true); }
    finally { fs.readFileSync = originalRead; f.put(f.script.path, f.scriptText); }
    const first = good(await runSourceReceiptInputs(f.project, ['batch', manifest.path, '--max-bytes', '2048']), 2048);
    const moduleBytes = fs.readFileSync(absolute(f, MODULE_PATH));
    await withBytes(f, MODULE_PATH, Buffer.concat([moduleBytes, Buffer.from('\n// Changed only in isolated fixture.\n')]), async () => {
      assert.notEqual(good(await f.open()).sessionKey, f.opened.sessionKey);
      denied(await runSourceReceiptInputs(f.project, ['read', manifest.path, '--cursor', first.nextCursor]), /session|stale/i);
    });
    const changed = read(absolute(f, manifest)); changed.requests[0].id = 'renamed'; f.put(manifest.path, changed);
    denied(await runSourceReceiptInputs(f.project, ['read', manifest.path, '--cursor', first.nextCursor]), /cursor|batch|snapshot/i);
  });

  await t.test('junctions are denied before target reads and manifest/CLI budgets remain bounded', async st => {
    const target = f.put('junction-target/secret.txt', 'SECRET_LINK_TARGET'), link = absolute(f, f.workRoot + '/linked');
    try { fs.symlinkSync(path.dirname(absolute(f, target)), link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { st.skip('Cannot create isolated link: ' + error.code); return; }
      throw error;
    }
    try {
      const linked = {path: f.workRoot + '/linked/secret.txt', sha256: target.sha256};
      await withBindings(f, ({receipt}) => { receipt.inputs.push(linked); }, async receiptRef => {
        const observed = await observeReads(() => f.open(receiptRef)); denied(observed.value, /redirect|link|path/i);
        assert.ok(!observed.reads.includes(key(absolute(f, linked))) && !observed.reads.includes(key(absolute(f, target))));
      });
    } finally { fs.unlinkSync(link); }
    const manifest = f.manifest([{id: 'script', ref: f.script}]);
    const outside = f.put(f.workRoot + '/wrong-manifest.json', read(absolute(f, manifest)));
    for (const args of [['batch', outside.path], ['batch', manifest.path, '--max-bytes', '1023'], ['batch', manifest.path, '--max-bytes', '8193']])
      denied(await runSourceReceiptInputs(f.project, args));
    const cli = f.execute(MODULE_PATH, ['batch', manifest.path, '--max-bytes', '1024']);
    assert.equal(cli.stderr, ''); assert.equal(cli.stdout.trim().split('\n').length, 1); assert.ok(Buffer.byteLength(cli.stdout) <= 1024);
    good(cli.value, 1024); assert.ok(cli.value.nextCursor);
  });
});
