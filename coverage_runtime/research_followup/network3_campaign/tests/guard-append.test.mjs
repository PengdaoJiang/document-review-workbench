import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setup, files, acceptThroughLegacy, paperIds, workerFor, absolute, canonical, clone, read, digest,
  objectHash, protocolRelative, APPEND_RELEASE, campaignRelative as base} from './fixtures/guard-append/fixture.mjs';

// All source, business state, immutable releases and fault injections below live
// in an independently allocated synthetic temp root. Run with workerCount=1 /
// --test-concurrency=1. No real scientific data, tools, dispatch or acceptance.
const stateFile = f => path.join(f.campaign, 'coverage/state.json');
const frozen = (f, id, name) => path.join(f.campaign, 'coverage', id, 'c002', name);
const runner = async f => (await import(pathToFileURL(path.join(f.project, protocolRelative, 'coverage.mjs')).href)).runCoverage;
const requestValue = (f, fields = {}, id = 'r0186') => { const reference = f.request(fields, id); return {reference, value: read(reference.path)}; };
const reseal = (f, options = {}) => Object.assign(f, f.seal(options));
const sameRef = (f, a, b) => absolute(f, a).toLowerCase() === absolute(f, b).toLowerCase() && a.sha256 === b.sha256;
async function reject(f, run, command, request, pattern = /Append|guard|scope|hash|reference|mismatch|differs|unsupported|Stale|ENOENT|EEXIST/i) {
  const before = files(f.project), state = clone(f.state());
  await assert.rejects(run(f.project, [command, request.path]), pattern);
  assert.deepEqual(f.state(), state, 'A rejected command must not mutate the ledger');
  assert.deepEqual(files(f.project), before, 'A pre-publication rejection must not leave an output, temp or owned lock');
}

test('both exact c002 repairs check read-only, intake, verify, use original independent review/decide and replay', async t => {
  const f = setup(t), run = await runner(f), requests = {};
  for (const id of paperIds) {
    const before = files(f.project), request = f.request({}, id), registration = clone(f.paper(id));
    const afterRequest = files(f.project), checked = await run(f.project, ['check', request.path]);
    assert.equal(checked.valid, true); assert.equal(checked.iteration, 2); assert.equal(checked.scientificAcceptance, false);
    assert.equal(checked.proof.methodEdits.length, id === 'r0186' ? 2 : 0);
    assert.ok(checked.proof.falseLegacyExemptionsRemoved > 0);
    assert.deepEqual(files(f.project), afterRequest, 'check cannot write frozen outputs or state');
    assert.ok(Object.keys(afterRequest).length > Object.keys(before).length, 'Only the explicitly submitted request was added');
    const response = await run(f.project, ['intake-append', request.path]); requests[id] = request;
    assert.equal(response.scientificAcceptance, false); assert.equal(f.paper(id).phase, 'awaiting_review');
    assert.equal(f.paper(id).owner, null); assert.equal(f.paper(id).staged.worker, workerFor(id));
    for (const field of ['scan', 'order', 'guardEnrollment', 'firstPass', 'history', 'latest', 'iteration', 'allowedScope']) assert.deepEqual(f.paper(id)[field], registration[field]);
    const receipt = read(absolute(f, f.paper(id).staged.guard.appendCorrection));
    assert.equal(receipt.scientificAcceptance, false);
    for (const ref of [...Object.values(f.deliveries[id].original), ...Object.values(f.deliveries[id].repaired), ...f.deliveries[id].scope.preserved]) {
      assert.equal(digest(absolute(f, ref)), ref.sha256);
      assert.ok(receipt.requiredReferences.some(row => sameRef(f, row, ref)), 'Original/repaired/preserved lineage is retained');
    }
    assert.equal((await run(f.project, ['verify', id])).appendCorrection.verified, true);
    acceptThroughLegacy(f, id); assert.equal(f.paper(id).phase, 'complete');
    assert.equal(f.legacyInvoke('verify', {path: id}).value.coverageComplete, true);
    assert.equal((await run(f.project, ['verify', id])).coverageComplete, true);
  }
  for (const id of paperIds) {
    const before = files(f.project);
    assert.equal((await run(f.project, ['intake-append', requests[id].path])).replayed, true);
    assert.deepEqual(files(f.project), before, 'Exact replay never republishes or increments state');
  }
});

test('request schema, fixed paper/version, owner, supervisor, terminal attestation and revision fail closed', async t => {
  const f = setup(t), run = await runner(f);
  const cases = [
    {paperId: 'origin'}, {paperId: 'r0188'}, {schemaVersion: 2}, {iteration: 1}, {iteration: 3},
    {agent: 'replacement-worker'}, {supervisor: 'architecture-not-supervisor'}, {ownerFinished: false},
    {noActiveCalculation: false}, {reason: ''}, {expectedRevision: f.state().revision - 1},
    {expectedRevision: f.state().revision + 1}, {extraPermission: true},
    {order: {...f.requestPayloads.r0186.order, sha256: '0'.repeat(64)}},
    {guardEnrollment: f.requestPayloads.r0187.guardEnrollment},
  ];
  for (const fields of cases) for (const command of ['check', 'intake-append']) await reject(f, run, command, f.request(fields));
  for (const command of ['init', 'assign', 'review', 'decide', 'continue']) await assert.rejects(run(f.project, [command, 'r0186']), /Expected check/);
  const escaped = f.put('outside-requests.json', f.requestPayloads.r0186);
  await reject(f, run, 'check', escaped, /escape|outside|within|Unsafe/i);
});

test('live owner, phase, prior accepted snapshot, guard enrollment and allowed registration cannot be substituted', async t => {
  const f = setup(t), run = await runner(f), original = fs.readFileSync(stateFile(f));
  const cases = [
    p => { p.owner.agent = 'replacement'; }, p => { p.owner.startedAt = '2000-01-01T00:00:00Z'; },
    p => { p.iteration = 3; }, p => { p.phase = 'ready'; }, p => { p.phase = 'complete'; },
    p => { p.staged = {}; }, Object.assign(p => { delete p.guardEnrollment; }, {expected: /^Error: Coverage: canonical value must contain only JSON values$/}), p => { p.sourceEnrollment = {}; },
    p => { p.latest.metrics.syntheticTamper = true; }, p => { p.history.push(clone(p.latest)); },
    p => { delete p.latest.guard; }, p => { p.workRoot = p.workRoot.replace('r0186', 'r0187'); },
  ];
  for (const mutate of cases) {
    const state = JSON.parse(original); mutate(state.papers.find(row => row.paperId === 'r0186')); f.put(stateFile(f), canonical(state));
    const request = f.request(); await reject(f, run, 'check', request, mutate.expected); await reject(f, run, 'intake-append', request, mutate.expected);
    f.put(stateFile(f), original);
  }
});

test('release manifest, exact whitelist, authorization and diagnostic cannot broaden or weaken the bounded repair', async t => {
  const f = setup(t), run = await runner(f);
  const cases = [
    {manifest: value => { value.releaseId = 'unapproved'; }},
    {manifest: value => { value.modules.pop(); }},
    {manifest: value => { value.upstream.pop(); }},
    {manifest: value => { value.repairScopes.push(clone(value.repairScopes[0])); }},
    {manifest: value => { value.repairScopes[0].paperId = 'r0188'; }},
    {manifest: value => { value.repairScopes[0].iteration = 1; }},
    {manifest: value => { value.repairScopes[0].owner.agent = 'replacement'; }},
    {manifest: value => { value.repairScopes[0].preserved.pop(); }},
    {diagnostic: value => { value.papers[0].preservedOriginalFileCount--; }},
    {diagnostic: value => { value.scientificAcceptance = true; }},
    {authorization: value => { value.authorization.reply = 'inferred'; }},
    {authorization: value => { value.authorization.source = 'agent'; }},
    {authorization: value => { value.diagnostic.sha256 = '0'.repeat(64); }},
  ];
  for (const options of cases) {
    reseal(f, options); const request = f.request(); await reject(f, run, 'check', request); await reject(f, run, 'intake-append', request);
  }
  reseal(f); assert.equal((await run(f.project, ['check', f.request().path])).valid, true);
});

test('only the exact two method edits and exact prior guarded scope restoration are accepted', async t => {
  const f = setup(t), run = await runner(f);
  const cases = [
    {candidate: value => { value.inventory.items[0].text += ' unrelated edit'; }},
    {candidate: value => { value.assessments[0].evidence[1].method = 'formal_proof'; }},
    {candidate: value => { value.assessments[1].evidence[2].method = 'numeric_test'; }},
    {candidate: value => { value.assessments[2].summary += ' changed accepted item'; }},
    {candidate: value => { value.predecessorSha256 = '0'.repeat(64); }},
    {contract: value => { value.legacyRetainedObligationIds = [f.inputs.r0186.originalScope.legacyRetainedObligationIds[0]]; }},
    {contract: value => { value.cards.pop(); }, expected: /^Error: Coverage: canonical value must contain only JSON values$/},
    {contract: value => { value.alignments.pop(); }, expected: /^Error: Coverage: canonical value must contain only JSON values$/},
    {contract: value => { value.cards.at(-1).claims[0].statement += ' weaker invented claim'; }},
    {contract: value => { value.alignments.at(-1).relation = 'auxiliary'; }},
    {contract: value => { value.alignments[0].additionalAssumptions.push('Unapproved assumption'); }},
    {contract: value => { value.inventory.notes += ' unrelated edit'; }},
    {originalScope: value => { value.legacyRetainedObligationIds.push(value.alignments[0].obligationId); }},
  ];
  for (const hooks of cases) {
    reseal(f, {r0186: hooks}); const request = f.request(); await reject(f, run, 'check', request, hooks.expected); await reject(f, run, 'intake-append', request, hooks.expected);
  }
  reseal(f); assert.equal((await run(f.project, ['check', f.request().path])).valid, true);
});

test('terminal schemas, natural completion, time ordering, actor, process state and preserved originals are mandatory', async t => {
  const f = setup(t), run = await runner(f);
  const cases = [
    ['r0186', {oldTerminal: value => { value.agent = 'replacement'; }}],
    ['r0186', {oldTerminal: value => { value.ownerFinished = false; }}],
    ['r0186', {oldTerminal: value => { value.assignmentStartedAt = '2000-01-01T00:00:00Z'; }}],
    ['r0186', {terminal: value => { value.noActiveCalculation = false; }}],
    ['r0186', {terminal: value => { value.newScientificExecutions = 1; }}],
    ['r0186', {terminal: value => { value.scientificAcceptance = true; }}],
    ['r0186', {terminal: value => { value.completedAt = '2000-01-01T00:00:00Z'; }}],
    ['r0186', {terminal: value => { value.retentionChain.publicPriorScope.sha256 = '0'.repeat(64); }}],
    ['r0186', {terminal: value => { value.preservation.preExistingFiles[0].identical = false; }}],
    ['r0186', {audit: value => { value.author = 'replacement'; }}],
    ['r0187', {terminal: value => { value.processState.activeCalculations = ['synthetic-active']; }}],
    ['r0187', {terminal: value => { value.processState.backgroundJobs = 1; }}],
    ['r0187', {terminal: value => { value.processState.newScientificExperiments = 1; }}],
    ['r0187', {audit: value => { value.allPreexistingFilesUnchanged.pop(); }}],
  ];
  for (const [id, hooks] of cases) {
    reseal(f, {[id]: hooks}); const request = f.request({}, id);
    await reject(f, run, 'check', request); await reject(f, run, 'intake-append', request);
  }
});

test('actual immutable bytes for sources, prior evidence, release and all raw deliveries are rechecked', async t => {
  const f = setup(t), run = await runner(f), request = f.request();
  const scope = f.deliveries.r0186.scope;
  const refs = [f.releaseManifest, f.diagnostic, f.authorization, ...Object.values(scope.original), ...Object.values(scope.repaired), scope.audit,
    ...Object.values(scope.baseline), scope.preserved.at(-1), {path: f.scans.r0186.resources[0].path, sha256: f.scans.r0186.resources[0].sha256},
    f.inputs.r0186.output, f.inputs.r0186.receipt, f.releaseUpstream[0].ref, f.releaseModules[0].frozen];
  for (const ref of refs) {
    const filename = absolute(f, ref), bytes = fs.readFileSync(filename); f.put(filename, Buffer.concat([bytes, Buffer.from(' ')]));
    await reject(f, run, 'check', request, /hash|bytes|changed|mismatch/i);
    await reject(f, run, 'intake-append', request, /hash|bytes|changed|mismatch/i); f.put(filename, bytes);
  }
});

test('shared writer lock, stale requests, pause control and output conflicts are fail closed without lock theft', async t => {
  const f = setup(t), run = await runner(f), request = f.request(), lock = path.join(f.campaign, 'coverage/.writer.lock');
  const foreign = {pid: process.pid, token: 'synthetic-foreign-owner', startedAt: '2000-01-01T00:00:00Z'};
  f.put(lock, canonical(foreign)); await reject(f, run, 'intake-append', request, /EEXIST/);
  assert.deepEqual(read(lock), foreign); fs.unlinkSync(lock);
  const control = path.join(f.campaign, 'coverage/execution-control.json'), originalControl = fs.readFileSync(control);
  for (const fields of [{phase: 'paused'}, {pauseInForce: true}, {newAdmissions: false}]) {
    f.put(control, {...JSON.parse(originalControl), ...fields});
    assert.equal((await run(f.project, ['check', request.path])).valid, true, 'Readonly diagnosis remains available while paused');
    await reject(f, run, 'intake-append', request, /Execution control/);
  }
  f.put(control, originalControl);
  const candidate = frozen(f, 'r0186', 'candidate.json'); f.put(candidate, 'Conflicting pre-existing frozen output');
  await reject(f, run, 'check', request, /Conflicting immutable output/); await reject(f, run, 'intake-append', request, /Conflicting immutable output/);
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'Conflicting pre-existing frozen output'); fs.unlinkSync(candidate);
  await run(f.project, ['intake-append', f.request({}, 'r0187').path]);
  await reject(f, run, 'intake-append', request, /Stale/);
});

test('partial immutable freeze survives failure and retries after another paper advances the global revision', async t => {
  const f = setup(t), run = await runner(f), request = f.request(), before = clone(f.state());
  const target = frozen(f, 'r0186', 'source-scope.json'), originalLink = fs.linkSync; let injected = false;
  fs.linkSync = function(source, destination, ...args) {
    if (!injected && path.resolve(destination).toLowerCase() === target.toLowerCase()) { injected = true; throw Error('synthetic publish fault'); }
    return originalLink.call(this, source, destination, ...args);
  };
  try { await assert.rejects(run(f.project, ['intake-append', request.path]), /synthetic publish fault/); }
  finally { fs.linkSync = originalLink; }
  assert.ok(injected); assert.deepEqual(f.state(), before); assert.ok(fs.existsSync(frozen(f, 'r0186', 'candidate.json')));
  assert.ok(!fs.existsSync(target)); assert.ok(!fs.existsSync(path.join(f.campaign, 'coverage/.writer.lock')));
  const candidateHash = digest(frozen(f, 'r0186', 'candidate.json'));
  await run(f.project, ['intake-append', f.request({}, 'r0187').path]);
  const retry = f.request(); assert.equal((await run(f.project, ['intake-append', retry.path])).scientificAcceptance, false);
  assert.equal(digest(frozen(f, 'r0186', 'candidate.json')), candidateHash);
  assert.equal((await run(f.project, ['verify', 'r0186'])).appendCorrection.verified, true);
  assert.equal((await run(f.project, ['intake-append', retry.path])).replayed, true);
});

test('all four frozen outputs retain the same receipt across a failed state commit and unrelated revision advance', async t => {
  const f = setup(t), run = await runner(f), request = f.request(), before = clone(f.state());
  const originalRename = fs.renameSync; let injected = false;
  fs.renameSync = function(source, destination, ...args) {
    if (!injected && path.resolve(destination).toLowerCase() === stateFile(f).toLowerCase()) { injected = true; throw Error('synthetic state commit fault'); }
    return originalRename.call(this, source, destination, ...args);
  };
  try { await assert.rejects(run(f.project, ['intake-append', request.path]), /synthetic state commit fault/); }
  finally { fs.renameSync = originalRename; }
  assert.ok(injected); assert.deepEqual(f.state(), before);
  const names = ['candidate.json', 'source-scope.json', 'append-correction-receipt.json', 'reviewer.md'];
  const hashes = Object.fromEntries(names.map(name => { const filename = frozen(f, 'r0186', name); assert.ok(fs.existsSync(filename)); return [name, digest(filename)]; }));
  assert.ok(!fs.existsSync(path.join(f.campaign, 'coverage/.writer.lock')));
  assert.ok(!fs.readdirSync(path.join(f.campaign, 'coverage')).some(name => /^\.state-.*\.tmp$/.test(name)));
  await run(f.project, ['intake-append', f.request({}, 'r0187').path]);
  assert.ok(f.state().revision > before.revision);
  const retry = f.request(), retryValue = read(retry.path);
  assert.equal(retryValue.expectedRevision, f.state().revision);
  await run(f.project, ['intake-append', retry.path]);
  for (const name of names) assert.equal(digest(frozen(f, 'r0186', name)), hashes[name], 'Matching pre-frozen ' + name + ' must never be rewritten');
  const committed = Object.values(f.state().operations).find(op => op.request?.sha256 === retry.sha256);
  assert.ok(committed); assert.equal(committed.response.appendCorrection.sha256, hashes['append-correction-receipt.json']);
  assert.equal((await run(f.project, ['verify', 'r0186'])).appendCorrection.verified, true);
  assert.equal((await run(f.project, ['intake-append', retry.path])).replayed, true);
});

test('TOCTOU changes to source, prior baseline, sidecar, campaign refs and request are caught before publication', async t => {
  const f = setup(t), run = await runner(f), request = f.request();
  const authority = read(absolute(f, f.state().authority)), scopeAuthority = read(absolute(f, authority.scopeAuthority));
  const refs = [f.deliveries.r0186.repaired.sourceScope, f.deliveries.r0186.scope.baseline.contract,
    {path: f.scans.r0186.resources[0].path, sha256: f.scans.r0186.resources[0].sha256},
    authority.scopeAuthority, scopeAuthority.scope.nodes, authority.firstPassClosure, request];
  const trigger = absolute(f, f.deliveries.r0186.repaired.candidate).toLowerCase();
  for (const command of ['check', 'intake-append']) for (const ref of refs) {
    const filename = absolute(f, ref), bytes = fs.readFileSync(filename), before = files(f.project), state = clone(f.state()), originalRead = fs.readFileSync;
    let injected = false;
    fs.readFileSync = function(name, ...args) {
      if (!injected && typeof name === 'string' && path.resolve(name).toLowerCase() === trigger) {
        injected = true; fs.writeFileSync(filename, Buffer.concat([bytes, Buffer.from(' ')]));
      }
      return originalRead.call(this, name, ...args);
    };
    try { await assert.rejects(run(f.project, [command, request.path]), /hash|bytes|changed|mismatch/i); }
    finally { fs.readFileSync = originalRead; f.put(filename, bytes); }
    assert.ok(injected, 'Race actually crossed the candidate read boundary'); assert.deepEqual(f.state(), state); assert.deepEqual(files(f.project), before);
  }
});

test('verified lineage cannot omit prior guard references, overwrite prior acceptance or forget a constructor', async t => {
  const f = setup(t), run = await runner(f), request = f.request();
  await run(f.project, ['intake-append', request.path]);
  const saved = fs.readFileSync(stateFile(f));
  const cases = [
    p => { p.staged.guard.references = p.staged.guard.references.filter(ref => !sameRef(f, ref, f.deliveries.r0186.scope.baseline.contract)); },
    p => { p.latest.metrics.syntheticTamper = true; },
    p => { p.workerHistory = []; },
    p => { p.staged.worker = 'replacement'; },
    p => { p.staged.guard.contractSource = f.deliveries.r0186.original.sourceScope; },
  ];
  for (const mutate of cases) {
    const state = JSON.parse(saved); mutate(state.papers.find(row => row.paperId === 'r0186')); f.put(stateFile(f), canonical(state));
    await reject(f, run, 'verify', {path: 'r0186'}); await reject(f, run, 'intake-append', request);
    f.put(stateFile(f), saved);
  }
  acceptThroughLegacy(f, 'r0186');
  const before = files(f.project); assert.equal((await run(f.project, ['verify', 'r0186'])).coverageComplete, true); assert.deepEqual(files(f.project), before);
  const control = path.join(f.campaign, 'coverage/execution-control.json');
  f.put(control, {schemaVersion: 1, phase: 'paused', pauseInForce: true, newAdmissions: false});
  assert.equal((await run(f.project, ['verify', 'r0186'])).coverageComplete, true, 'Later pause does not erase immutable accepted evidence');
});

test('old same-paper run receipts, frozen source/config and newly added attempt members stay sealed after preparation', async t => {
  const f = setup(t), run = await runner(f), request = f.request();
  const {prepareAppendCorrection} = await import(pathToFileURL(path.join(f.project, protocolRelative, 'append-core.mjs')).href);
  const prepared = await prepareAppendCorrection({root: f.project, state: f.state(), paper: f.paper(), request: read(request.path)});
  const runRoot = path.join(f.clean, 'runs/r0186/synthetic-run'), members = Object.keys(files(runRoot));
  const receipt = members.find(name => /receipt[^\\/]*\.json$/i.test(name) && !name.endsWith('run.json'));
  const source = members.find(name => /source[\\/]entry\.cjs$/.test(name));
  assert.ok(receipt, 'The actual synthetic first-pass runtime produced a chunk receipt');
  assert.ok(source, 'The actual synthetic first-pass runtime froze its source');
  const targets = ['run.json', 'config.json', receipt, source].map(name => ({filename: path.join(runRoot, name), added: false}));
  targets.push({filename: path.join(runRoot, path.dirname(receipt), 'synthetic-added-attempt.json'), added: true});
  for (const {filename, added} of targets) {
    const original = added ? null : fs.readFileSync(filename);
    f.put(filename, added ? {fixtureOnly: true, unauthorizedNewAttempt: true} : Buffer.concat([original, Buffer.from(' ')]));
    try { assert.throws(() => prepared.recheck(), /hash|bytes|membership|changed/i); }
    finally { if (added) fs.unlinkSync(filename); else f.put(filename, original); }
    prepared.recheck();
  }
  const trigger = absolute(f, f.inputs.r0186.output).toLowerCase();
  for (const {filename, added} of targets) {
    const original = added ? null : fs.readFileSync(filename), before = files(f.project), state = clone(f.state()), originalRead = fs.readFileSync;
    let injected = false;
    fs.readFileSync = function(name, ...args) {
      if (!injected && typeof name === 'string' && path.resolve(name).toLowerCase() === trigger) {
        injected = true; fs.writeFileSync(filename, added ? '{"fixtureOnly":true,"newAttempt":true}' : Buffer.concat([original, Buffer.from(' ')]));
      }
      return originalRead.call(this, name, ...args);
    };
    try { await assert.rejects(run(f.project, ['intake-append', request.path]), /hash|bytes|membership|changed/i); }
    finally { fs.readFileSync = originalRead; if (added) fs.unlinkSync(filename); else f.put(filename, original); }
    assert.ok(injected); assert.deepEqual(f.state(), state); assert.deepEqual(files(f.project), before);
  }
  const emptyAttempt = path.join(runRoot, 'chunks/one/attempt-9999.partial');
  fs.mkdirSync(emptyAttempt);
  try { assert.throws(() => prepared.recheck(), /membership|changed/i, 'Empty directories are immutable run membership too'); }
  finally { fs.rmdirSync(emptyAttempt); }
  prepared.recheck();
  await run(f.project, ['intake-append', request.path]);
  fs.mkdirSync(emptyAttempt);
  try { await reject(f, run, 'verify', {path: 'r0186'}, /membership|proof|receipt|partial|frozen|changed|^Error: Completed chunk followed by another attempt$/i); }
  finally { fs.rmdirSync(emptyAttempt); }
  assert.equal((await run(f.project, ['verify', 'r0186'])).appendCorrection.verified, true);
});

test('a junction or symbolic-link directory inside a frozen same-paper run is rejected without following its target', async t => {
  const f = setup(t), run = await runner(f), request = f.request(), state = clone(f.state());
  const {prepareAppendCorrection} = await import(pathToFileURL(path.join(f.project, protocolRelative, 'append-core.mjs')).href);
  const prepared = await prepareAppendCorrection({root: f.project, state, paper: f.paper(), request: read(request.path)});
  const sentinel = f.put('synthetic-link-target/sentinel.txt', 'Synthetic target stays unchanged.');
  const target = path.dirname(sentinel.path), junction = path.join(f.clean, 'runs/r0186/synthetic-run/synthetic-junction');
  assert.ok(path.relative(f.project, target) && !path.relative(f.project, target).startsWith('..'));
  try { fs.symlinkSync(target, junction, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) { t.skip('Host cannot create synthetic directory links: ' + error.code); return; }
    throw error;
  }
  try {
    assert.ok(fs.lstatSync(junction).isSymbolicLink());
    assert.throws(() => prepared.recheck(), /redirect|link|non-regular|membership/i);
    for (const command of ['check', 'intake-append']) await assert.rejects(run(f.project, [command, request.path]), /redirect|link|non-regular|membership/i);
    assert.deepEqual(f.state(), state); assert.equal(digest(sentinel.path), sentinel.sha256);
    assert.ok(!fs.existsSync(frozen(f, 'r0186', 'candidate.json')));
    assert.ok(!fs.existsSync(path.join(f.campaign, 'coverage/.writer.lock')));
  } finally { fs.unlinkSync(junction); }
  assert.equal(digest(sentinel.path), sentinel.sha256);
});
