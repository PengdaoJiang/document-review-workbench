import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

// All inputs, authority records, runs and evidence below are synthetic. The
// production tree supplies code only; no production CLI or state is executed.
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../..');
const implementation = process.env.NETWORK3_REPAIR_IMPLEMENTATION_DIR
  ? path.resolve(process.env.NETWORK3_REPAIR_IMPLEMENTATION_DIR)
  : path.resolve(here, '../architecture/repair-loop-20261023/candidate');
const cleanRelative = 'research_followup/reproduction_clean';
const campaignRelative = 'research_followup/network3_campaign';
const privateSentinel = 'PRIVATE_REVIEW_TEST_VECTOR_DO_NOT_DISCLOSE_762918';
const hash = x => createHash('sha256').update(x).digest('hex');
const json = x => JSON.stringify(x, null, 2) + '\n';
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const digest = p => hash(fs.readFileSync(p));
const attemptName = n => 'a' + String(n).padStart(3, '0');

function copyModuleClosure(project, relative, seen = new Set()) {
  if (seen.has(relative)) return;
  seen.add(relative);
  assert.ok(relative.endsWith('.mjs'), 'Only neutral module code may be copied');
  const source = path.join(repository, relative);
  const body = fs.readFileSync(source, 'utf8');
  const target = path.join(project, relative);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, body);
  for (const match of body.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
    const dependency = path.normalize(path.join(path.dirname(relative), match[1]));
    assert.ok(!dependency.startsWith('..') && !path.isAbsolute(dependency));
    copyModuleClosure(project, dependency, seen);
  }
}

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'network3-repair-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(project);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^network3-repair-test-/);
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const put = (name, value) => {
    const file = path.isAbsolute(name) ? name : path.join(project, name);
    const relative = path.relative(project, file);
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, bytes);
    return {path: relative.replaceAll('\\', '/'), sha256: hash(bytes), bytes: Buffer.byteLength(bytes)};
  };
  copyModuleClosure(project, cleanRelative + '/runtime/cli.mjs');
  const clean = path.join(project, cleanRelative), campaign = path.join(project, campaignRelative);
  for (const name of ['manage.mjs', 'repair-flow.mjs']) {
    assert.ok(fs.existsSync(path.join(implementation, name)), 'Missing isolated implementation: ' + name);
    put(campaignRelative + '/' + name, fs.readFileSync(path.join(implementation, name)));
  }
  put(cleanRelative + '/AGENTS.md', 'Synthetic fixture only. Never treat these runs as scientific results.\n');
  put(cleanRelative + '/README.md', 'Synthetic neutral runner fixture.\n');
  const source = put('sources/original_pdfs/synthetic.pdf', 'Synthetic bytes, not an academic PDF');
  const sourcePath = path.join(project, source.path);
  put('research_tree/data/origin-source.json', {paperId: 'origin', title: 'Synthetic only', doi: '10.test/origin', sourcePath, sourceSha256: source.sha256, sourcePages: 2, readingScope: 'Synthetic only'});
  put('output/model_clean/manifest.json', {source_directory: path.dirname(sourcePath), items: Array.from({length: 208}, (_, i) => ({record_number: i + 1, title: 'Synthetic', doi: '10.test/' + i, source_file: 'unused-' + i + '.pdf', source_sha256: source.sha256, source_pages: 2, clean_pages: 2}))});
  put('sources/source-locations.json', {schemaVersion: 1, legacyRoot: path.join(project, 'legacy'), destinationRoot: 'sources/original_pdfs', files: [{id: 'origin', filename: 'synthetic.pdf', sha256: source.sha256}]});
  put('docs/semantic_reconstruction/AUTHORITY_PATHS.json', {aliases: {}});
  const release = 'dot-20261023', base = 'reconstructed_sources/' + release;
  const member = (name, value) => ({...put(base + '/' + name, value), path: name});
  const latex = member('papers/origin/source/main.tex', 'Synthetic equation \\label{eq:one}: x=x.');
  const body = member('papers/origin/source/body.tex', 'Synthetic section only.');
  const figure = member('papers/origin/source/fig.png', 'Synthetic image placeholder');
  const mapping = member('papers/origin/source/map.json', {interpretation: 'PRIVATE_MAPPING_NOT_ACADEMIC_INPUT'});
  const archive = member('archives/origin.zip', 'Synthetic archive'), version = 'dot-' + archive.sha256;
  const record = {schemaVersion: 1, provider: 'dot', paperId: 'origin', version, status: 'user_selected_dot_reconstruction', source: {sha256: source.sha256}, archive, files: {latex, latexEntries: [latex], dependencies: [body], assets: [figure], mapping, all: [latex, body, figure, mapping]}};
  const recordRef = put(base + '/papers/origin/record.json', record);
  const index = put(base + '/index.json', {schemaVersion: 1, provider: 'dot', release, papers: [{paperId: 'origin', version, record: 'papers/origin/record.json', recordSha256: recordRef.sha256}]});
  put('reconstructed_sources/current.json', {schemaVersion: 1, provider: 'dot', release, index: base + '/index.json', indexSha256: index.sha256});
  const nodes = put('synthetic-authority/nodes.json', [{paper_id: 'origin'}]);
  const edges = put('synthetic-authority/edges.json', []);
  put('docs/network3-research-authorization-20261023.json', {schemaVersion: 1, campaignId: 'synthetic-repair-loop', supervisor: {threadId: 'synthetic-supervisor'}, scope: {nodes, edges, paperIds: ['origin']}, reading: {index: index.path, indexSha256: index.sha256, release}});
  const statePath = path.join(campaign, 'state.json');
  function execute(kind, args, ok = true, {preload} = {}) {
    const script = kind === 'manage' ? path.join(campaign, 'manage.mjs') : path.join(clean, 'runtime/cli.mjs');
    assert.ok(script.startsWith(project + path.sep));
    if (preload) assert.ok(preload.startsWith(project + path.sep), 'Fault injection must be fixture-local');
    const execution = spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), script, ...args], {cwd: project, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: {...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1'}});
    const diagnostic = [args.join(' '), execution.error?.message, execution.stdout, execution.stderr].filter(Boolean).join('\n');
    if (ok) assert.equal(execution.status, 0, diagnostic);
    else assert.notEqual(execution.status, 0, 'Unexpected success: ' + diagnostic);
    return {...execution, diagnostic, value: ok && execution.stdout.trim().startsWith('{') ? JSON.parse(execution.stdout) : undefined};
  }
  const manage = (...args) => execute('manage', args).value;
  const runtime = (...args) => execute('runtime', args).value;
  const state = () => read(statePath), paper = () => state().papers[0];
  const f = {project, clean, campaign, statePath, put, source, version, manage, runtime, execute, state, paper};
  manage('init');
  manage('prepare', 'origin');
  const view = runtime('verify-reading', 'origin');
  f.view = view;
  f.contract = {schemaVersion: 1, paperId: 'origin', inputSha256: view.originalPacket.sha256, sourceSha256: source.sha256, claimInventory: {status: 'complete', basis: 'One synthetic fixture claim only'}, claims: [{claimId: 'origin:c0001', kind: 'independent_check', statement: 'Synthetic fixture check', sourceLocations: [{dot: {version, path: view.primary.path, sha256: view.primary.sha256}, label: 'eq:one'}], sourceConditions: ['Synthetic only'], implementationAssumptions: [], nativeUnits: 'not applicable', conventions: 'synthetic', unknowns: [], successCriteria: ['Expected fixture output']}]};
  return f;
}

function construct(f, n, {takeOwnership = true, supersedes = true} = {}) {
  const attempt = attemptName(n), prior = f.paper().attemptHistory?.at(-1);
  if (takeOwnership) f.manage('owner', 'origin', 'synthetic-worker-' + attempt);
  f.put(cleanRelative + '/papers/origin/contract.json', f.contract);
  f.put(cleanRelative + '/papers/origin/entry.cjs', "require('node:fs').writeFileSync('answer.json',JSON.stringify({synthetic:true,attempt:" + n + ',answer:1}));');
  f.put(cleanRelative + '/papers/origin/report.md', 'Synthetic public report for ' + attempt + '.\n');
  const runId = 'n3-synthetic-' + attempt;
  f.put(cleanRelative + '/papers/origin/plan.json', {runId, workerCount: 1, config: {synthetic: true, attempt}, environment: {synthetic: true}, freshContext: {contextId: 'synthetic-context-' + attempt, historyInherited: false, declaredBy: 'test'}, chunks: [{id: 'one', executable: process.execPath, args: ['${SOURCE}/entry.cjs']}]});
  const run = f.runtime('new-run', 'origin', 'plan.json');
  const output = f.runtime('chunk', 'origin', runId, 'one');
  assert.equal(output.state, 'completed');
  f.runtime('finish', 'origin', runId);
  const answer = path.join(path.dirname(output.receiptPath), 'work/answer.json');
  const previous = n > 1 ? f.previousResult : null;
  const result = {schemaVersion: 1, paperId: 'origin', resultId: 'n3-result-' + attempt, phase: 'first_pass', inputSha256: f.view.originalPacket.sha256, contractSha256: digest(path.join(run.runDir, 'source/contract.json')), contract: f.contract, runBindings: [{runId, runSha256: digest(path.join(run.runDir, 'run.json'))}], claims: [{claimId: 'origin:c0001', status: 'reproduced', conclusion: 'Expected synthetic output exists', testedScope: 'Synthetic only', limitations: ['No paper science tested'], evidence: [{role: 'numeric', runId, path: path.relative(run.runDir, answer).replaceAll('\\', '/'), sha256: digest(answer), description: 'Synthetic actual captured output'}]}], assessment: {by: 'synthetic test', at: new Date().toISOString(), basis: 'Fixture only'}, supersedes: previous && supersedes ? [{resultId: path.basename(previous.path, '.json'), sha256: previous.sha256, reason: 'Synthetic explicit repair'}] : []};
  f.put(cleanRelative + '/drafts/origin/result-' + attempt + '.json', result);
  const published = f.runtime('publish-result', 'origin', 'result-' + attempt + '.json');
  const candidate = {paperId: 'origin', attempt, inputVersion: f.version, contractPath: path.join(f.clean, 'papers/origin/contract.json'), runIds: [runId], resultPath: published.path, resultSha256: published.sha256, reportPath: path.join(f.clean, 'papers/origin/report.md'), applicability: {synthetic: true}, openIssues: [], ...(n > 1 ? {repairRequestSha256: digest(path.join(f.campaign, 'receipts/origin/' + attempt + '-repair-request.json')), previousResultSha256: previous.sha256} : {})};
  const candidatePath = path.join(f.clean, 'drafts/origin/candidate.json');
  f.put(candidatePath, candidate);
  return {result, published, candidate, candidatePath, run, output, prior};
}

function review(f, n, recommendation = 'changes_required', {legacy = false} = {}) {
  const attempt = attemptName(n), current = f.paper();
  f.manage('review-owner', 'origin', 'synthetic-reviewer-' + attempt);
  const value = {
    schemaVersion: 1, paperId: 'origin', ...(legacy ? {} : {attempt}),
    reviewer: 'synthetic-reviewer-' + attempt, freshContext: {historyInherited: false},
    recommendation, scientificOutcome: 'synthetic_only',
    unresolvedObligations: recommendation === 'changes_required' ? ['Synthetic check requires a repair'] : [],
    bindings: {
      result: current.candidate.result,
      candidateReceipt: {path: current.candidate.path, sha256: current.candidate.sha256},
      ...(n > 1 ? {runs: current.candidate.runBindings.map(binding => ({...binding, readingSha256: digest(path.join(f.clean, 'runs/origin', binding.runId, 'reading.json'))}))} : {}),
    },
    privateTest: privateSentinel,
    ...(n > 1 ? {
      reviewerAgent: 'synthetic-reviewer-' + attempt,
      repairRequestSha256: digest(path.join(f.campaign, 'receipts/origin/' + attempt + '-repair-request.json')),
      deltaReview: {
        previousReviewSha256: f.previousReview.sha256,
        changedScope: ['Synthetic requested change independently checked'],
        retainedChecks: [{scope: 'Synthetic unchanged source identity', basis: 'Exact frozen source hash checked'}],
        affectedChecks: ['Synthetic dependent output independently recomputed'],
      },
    } : {}),
  };
  const reviewPath = path.join(f.clean, 'verifications/origin/' + attempt + '/review.json');
  f.put(reviewPath, value);
  return {value, reviewPath};
}

function decide(f, n, decision = 'changes_required', {commit = true} = {}) {
  const current = f.paper(), attempt = attemptName(n);
  f.put(campaignRelative + '/receipts/origin/' + attempt + '-supervisor.json', {schemaVersion: 1, paperId: 'origin', attempt, decision, candidateResultSha256: current.candidate.result.sha256, reviewSha256: current.review.sha256, scientificOutcome: 'synthetic_only', unresolvedObligations: decision === 'changes_required' ? ['Repair the synthetic output check'] : [], acceptedScope: decision === 'accept_bounded' ? 'Synthetic fixture only' : null, terminalForFirstPass: decision === 'accept_bounded'});
  if (commit) f.manage('decide', 'origin');
}

function completeToRevision(f, n = 1) {
  const constructed = construct(f, n);
  f.manage('intake', 'origin');
  const checked = review(f, n, 'changes_required', {legacy: n === 1});
  f.manage('receive-review', 'origin');
  decide(f, n);
  return {constructed, checked};
}

function request(f, n = 2) {
  const current = f.paper(), decision = current.decisions.at(-1);
  const value = {schemaVersion: 1, paperId: 'origin', fromAttempt: n - 1, inputVersion: f.version, candidateResultSha256: current.candidate.result.sha256, reviewSha256: current.review.sha256, decisionSha256: decision.sha256, publicForWorker: true, requiredChanges: [{id: 'synthetic-fix-' + n, claimIds: ['origin:c0001'], problem: 'Synthetic output check needs correction', requestedChange: 'Correct only the synthetic fixture check', validationExpectation: 'Produce new independently checkable synthetic output'}], retainedChecks: [{claimIds: ['origin:c0001'], scope: 'Synthetic original identity remains fixed', basis: 'Existing exact input identity'}]};
  const requestPath = path.join(f.campaign, 'receipts/origin/' + attemptName(n) + '-repair-request.json');
  f.put(requestPath, value);
  return {value, requestPath};
}

function prepareRepair(f, n = 2) {
  const old = f.paper();
  f.previousResult = old.candidate.result;
  f.previousReview = old.review;
  const prepared = request(f, n);
  f.manage('prepare-repair', 'origin', prepared.requestPath);
  return prepared;
}

function preservedFiles(f) {
  const result = {};
  for (const relative of [campaignRelative + '/receipts', campaignRelative + '/orders', cleanRelative + '/runs', cleanRelative + '/results', cleanRelative + '/verifications']) {
    const root = path.join(f.project, relative);
    if (!fs.existsSync(root)) continue;
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target);
        else if (entry.isFile()) result[target] = digest(target);
        else assert.fail('Unexpected nonregular fixture evidence');
      }
    };
    visit(root);
  }
  return result;
}
function assertPreserved(snapshot) {
  for (const [file, expected] of Object.entries(snapshot)) assert.equal(digest(file), expected, 'Historical evidence mutated: ' + file);
}
function rejectsUnchanged(f, command, args = [], pattern) {
  const stateBytes = fs.readFileSync(f.statePath);
  const eventsPath = path.join(f.campaign, 'events.jsonl'), eventsBytes = fs.readFileSync(eventsPath);
  const result = f.execute('manage', [command, 'origin', ...args], false);
  if (pattern) assert.match(result.diagnostic, pattern);
  assert.deepEqual(fs.readFileSync(f.statePath), stateBytes, 'Failed command mutated state');
  assert.deepEqual(fs.readFileSync(eventsPath), eventsBytes, 'Failed command appended a business event');
  return result;
}

test('real CLI a001 → repair a002 → bounded acceptance preserves all old evidence and private review', t => {
  const f = fixture(t);
  completeToRevision(f);
  const old = structuredClone(f.paper()), frozen = preservedFiles(f);
  const {requestPath} = prepareRepair(f);
  const repaired = f.paper();
  assert.equal(repaired.phase, 'ready');
  assert.equal(repaired.attempt, 2);
  assert.equal(repaired.owner, null);
  for (const key of ['contract', 'candidate', 'review', 'acceptance']) assert.equal(repaired[key], null);
  assert.equal(repaired.attemptHistory.length, 1);
  assert.ok(JSON.stringify(repaired.attemptHistory).includes(old.candidate.result.sha256));
  assert.ok(JSON.stringify(repaired.attemptHistory).includes(old.review.sha256));
  const order = fs.readFileSync(path.resolve(f.project, repaired.order.path), 'utf8');
  assert.ok(order.includes(digest(requestPath)));
  assert.ok(!order.includes(privateSentinel));
  assert.ok(!order.includes(old.review.path), 'Private prior review path leaked into worker order');
  assert.ok(!order.includes('PRIVATE_MAPPING_NOT_ACADEMIC_INPUT'));
  assertPreserved(frozen);
  const before = fs.readFileSync(f.statePath), events = fs.readFileSync(path.join(f.campaign, 'events.jsonl'));
  f.manage('prepare-repair', 'origin', requestPath);
  assert.deepEqual(fs.readFileSync(f.statePath), before, 'Idempotent prepare advanced state');
  assert.deepEqual(fs.readFileSync(path.join(f.campaign, 'events.jsonl')), events);
  construct(f, 2);
  const activeState = fs.readFileSync(f.statePath);
  f.manage('prepare-repair', 'origin', requestPath);
  assert.deepEqual(fs.readFileSync(f.statePath), activeState, 'Replay must not release or reset an active repair worker');
  f.manage('intake', 'origin');
  const second = f.paper();
  assert.notEqual(second.candidate.result.sha256, old.candidate.result.sha256);
  assert.notEqual(second.candidate.result.path, old.candidate.result.path);
  review(f, 2, 'accept_bounded');
  f.manage('receive-review', 'origin');
  decide(f, 2, 'accept_bounded', {commit: false});
  const awaitingDecision = f.paper();
  for (const filename of [awaitingDecision.review.path, awaitingDecision.candidate.path, awaitingDecision.candidate.result.path]) {
    const bytes = fs.readFileSync(filename);
    f.put(filename, Buffer.concat([bytes, Buffer.from('\nsynthetic post-review tamper')]));
    try { rejectsUnchanged(f, 'decide'); }
    finally { f.put(filename, bytes); }
  }
  f.manage('decide', 'origin');
  assert.equal(f.paper().phase, 'accepted_bounded');
  assert.equal(f.paper().attempt, 2);
  assert.equal(f.paper().attemptHistory.length, 1);
  const acceptedState = fs.readFileSync(f.statePath);
  f.manage('prepare-repair', 'origin', requestPath);
  assert.deepEqual(fs.readFileSync(f.statePath), acceptedState, 'Replay must not reset a completed bounded verdict');
  assertPreserved(frozen);
});

test('second repair advances a002 → a003 with exact immediate predecessor, not a001', t => {
  const f = fixture(t);
  completeToRevision(f);
  const first = structuredClone(f.paper());
  prepareRepair(f, 2);
  completeToRevision(f, 2);
  const second = structuredClone(f.paper()), frozen = preservedFiles(f);
  prepareRepair(f, 3);
  assert.equal(f.paper().attempt, 3);
  assert.equal(f.paper().attemptHistory.length, 2);
  const third = construct(f, 3);
  assert.equal(third.candidate.previousResultSha256, second.candidate.result.sha256);
  assert.deepEqual(third.result.supersedes.map(p => p.sha256), [second.candidate.result.sha256]);
  f.put(third.candidatePath, {...third.candidate, previousResultSha256: first.candidate.result.sha256});
  rejectsUnchanged(f, 'intake');
  f.put(third.candidatePath, third.candidate);
  f.manage('intake', 'origin');
  const checked = review(f, 3, 'accept_bounded');
  const staleReview = structuredClone(checked.value);
  staleReview.deltaReview.previousReviewSha256 = first.review.sha256;
  f.put(checked.reviewPath, staleReview);
  rejectsUnchanged(f, 'receive-review');
  f.put(checked.reviewPath, checked.value);
  f.manage('receive-review', 'origin');
  decide(f, 3, 'accept_bounded');
  assert.equal(f.paper().phase, 'accepted_bounded');
  assertPreserved(frozen);
});

test('prepare-repair rejects invalid authority, shape, phase and path without any state change', t => {
  const f = fixture(t);
  completeToRevision(f);
  const original = request(f), revisionState = fs.readFileSync(f.statePath);
  const badRequests = [
    ['wrong paper', r => {r.paperId = 'r0001';}],
    ['wrong attempt', r => {r.fromAttempt = 0;}],
    ['wrong input', r => {r.inputVersion = 'dot-' + '0'.repeat(64);}],
    ['wrong result hash', r => {r.candidateResultSha256 = '0'.repeat(64);}],
    ['wrong review hash', r => {r.reviewSha256 = '0'.repeat(64);}],
    ['wrong decision hash', r => {r.decisionSha256 = '0'.repeat(64);}],
    ['not public', r => {r.publicForWorker = false;}],
    ['unknown root field', r => {r.privateReview = privateSentinel;}],
    ['unknown change field', r => {r.requiredChanges[0].privateTest = privateSentinel;}],
    ['unknown retained field', r => {r.retainedChecks[0].automaticPass = true;}],
    ['no repair items', r => {r.requiredChanges = [];}],
    ['foreign claim', r => {r.requiredChanges[0].claimIds = ['r0001:c0001'];}],
    ['missing validation expectation', r => {delete r.requiredChanges[0].validationExpectation;}],
  ];
  for (const [label, mutate] of badRequests) {
    const bad = structuredClone(original.value); mutate(bad); f.put(original.requestPath, bad);
    assert.doesNotThrow(() => rejectsUnchanged(f, 'prepare-repair', [original.requestPath]), label);
  }
  f.put(original.requestPath, original.value);
  for (const mutate of [s => {s.papers[0].owner = {agent: 'active-worker', role: 'worker'};}, s => {s.papers[0].phase = 'researching';}, s => {s.papers[0].phase = 'externally_blocked';}, s => {s.papers[0].decisions.at(-1).decision = 'accept_bounded';}]) {
    const modified = JSON.parse(revisionState); mutate(modified); f.put(f.statePath, modified);
    rejectsUnchanged(f, 'prepare-repair', [original.requestPath]);
  }
  f.put(f.statePath, revisionState);
  const old = f.paper();
  for (const filename of [old.candidate.path, old.review.path, old.decisions.at(-1).path, old.candidate.result.path, path.resolve(f.project, old.order.path), old.inputPacket.path]) {
    const bytes = fs.readFileSync(filename);
    f.put(filename, Buffer.concat([bytes, Buffer.from('\nsynthetic tamper')]));
    try { rejectsUnchanged(f, 'prepare-repair', [original.requestPath]); }
    finally { f.put(filename, bytes); }
  }
  const elsewhere = path.join(f.project, 'elsewhere/a002-repair-request.json');
  f.put(elsewhere, original.value);
  rejectsUnchanged(f, 'prepare-repair', [elsewhere]);
  const wrongPaper = path.join(f.campaign, 'receipts/r0001/a002-repair-request.json');
  f.put(wrongPaper, original.value);
  rejectsUnchanged(f, 'prepare-repair', [wrongPaper]);
  assert.equal(f.paper().phase, 'revision_required');
});

test('repair candidate intake rejects stale, cross-input and same-result impersonation', t => {
  const f = fixture(t);
  const first = completeToRevision(f).constructed;
  prepareRepair(f);
  f.manage('owner', 'origin', 'synthetic-worker-a002');
  rejectsUnchanged(f, 'intake');
  const second = construct(f, 2, {takeOwnership: false});
  const failures = [
    c => {c.attempt = 'a001';}, c => {delete c.attempt;},
    c => {c.inputVersion = 'dot-' + '0'.repeat(64);},
    c => {c.repairRequestSha256 = '0'.repeat(64);},
    c => {c.previousResultSha256 = '0'.repeat(64);},
    c => {c.resultPath = first.published.path; c.resultSha256 = first.published.sha256;},
  ];
  for (const mutate of failures) {
    const value = structuredClone(second.candidate); mutate(value); f.put(second.candidatePath, value);
    rejectsUnchanged(f, 'intake');
    assert.ok(!fs.existsSync(path.join(f.campaign, 'receipts/origin/a002-candidate.json')));
  }
  f.put(second.candidatePath, second.candidate);
  const priorReviewBytes = fs.readFileSync(f.previousReview.path);
  f.put(f.previousReview.path, Buffer.concat([priorReviewBytes, Buffer.from('\nsynthetic tamper')]));
  rejectsUnchanged(f, 'intake');
  f.put(f.previousReview.path, priorReviewBytes);
  const researchingState = fs.readFileSync(f.statePath), changedInput = f.state();
  changedInput.papers[0].inputPacket.sha256 = '0'.repeat(64);
  f.put(f.statePath, changedInput);
  rejectsUnchanged(f, 'intake');
  f.put(f.statePath, researchingState);
  f.manage('intake', 'origin');
  const frozen = preservedFiles(f);
  rejectsUnchanged(f, 'intake');
  assertPreserved(frozen);
});

test('new result without explicit supersession is not admitted as repaired evidence', t => {
  const f = fixture(t);
  completeToRevision(f);
  prepareRepair(f);
  construct(f, 2, {supersedes: false});
  rejectsUnchanged(f, 'intake');
});

test('repair review rejects stale and loose hash mentions, wrong bindings and absent delta evidence', t => {
  const f = fixture(t);
  const first = completeToRevision(f).checked;
  prepareRepair(f);
  construct(f, 2);
  f.manage('intake', 'origin');
  const current = review(f, 2, 'accept_bounded');
  f.put(current.reviewPath, first.value);
  rejectsUnchanged(f, 'receive-review');
  const failures = [
    r => {r.attempt = 'a001';}, r => {delete r.attempt;},
    r => {r.reviewerAgent = 'synthetic-worker-a002';}, r => {delete r.reviewerAgent;},
    r => {r.bindings.result.sha256 = '0'.repeat(64);},
    r => {r.bindings.result.path = f.previousResult.path;},
    r => {r.bindings.candidateReceipt.sha256 = '0'.repeat(64);},
    r => {r.bindings.candidateReceipt.path = path.join(f.project, 'unrelated.json');},
    r => {delete r.bindings.runs;}, r => {r.bindings.runs = [];},
    r => {r.bindings.runs[0].runId = 'n3-synthetic-a001';},
    r => {r.bindings.runs[0].runSha256 = '0'.repeat(64);},
    r => {r.bindings.runs[0].readingSha256 = '0'.repeat(64);},
    r => {delete r.bindings.runs[0].readingSha256;},
    r => {r.bindings.runs.push({...r.bindings.runs[0]});},
    r => {r.bindings.extra = 'not allowed';},
    r => {r.repairRequestSha256 = '0'.repeat(64);},
    r => {r.deltaReview.previousReviewSha256 = '0'.repeat(64);},
    r => {delete r.deltaReview;},
    r => {delete r.deltaReview.affectedChecks;},
    r => {r.mention = r.bindings.result.sha256; delete r.bindings;},
  ];
  for (const mutate of failures) {
    const value = structuredClone(current.value); mutate(value); f.put(current.reviewPath, value);
    rejectsUnchanged(f, 'receive-review');
  }
  f.put(current.reviewPath, current.value);
  f.manage('receive-review', 'origin');
  assert.equal(f.paper().phase, 'review_received');
});

test('changed repair request and partial worker-order collision fail closed without overwriting', t => {
  const f = fixture(t);
  completeToRevision(f);
  const original = request(f);
  const collision = path.join(f.campaign, 'orders/origin/a002-worker.md');
  f.put(collision, 'Existing partial artifact must never be overwritten.\n');
  const collisionBytes = fs.readFileSync(collision);
  rejectsUnchanged(f, 'prepare-repair', [original.requestPath]);
  assert.deepEqual(fs.readFileSync(collision), collisionBytes);
  // Remove only this exact synthetic obstruction, never a tree or production path.
  fs.unlinkSync(collision);
  f.previousResult = f.paper().candidate.result;
  f.previousReview = f.paper().review;
  f.manage('prepare-repair', 'origin', original.requestPath);
  const workerOrderBytes = fs.readFileSync(collision);
  const changed = structuredClone(original.value); changed.requiredChanges[0].problem += ' changed after dispatch';
  f.put(original.requestPath, changed);
  rejectsUnchanged(f, 'prepare-repair', [original.requestPath]);
  assert.deepEqual(fs.readFileSync(collision), workerOrderBytes);
});

test('material write interruptions resume from exact immutable bytes without advancing twice', async t => {
  const f = fixture(t);
  completeToRevision(f);
  const original = request(f), paper = f.paper(), stateBytes = fs.readFileSync(f.statePath);
  const {prepareRepair, writeOnceOrMatch} = await import(pathToFileURL(path.join(f.campaign, 'repair-flow.mjs')));
  const {verifyResult} = await import(pathToFileURL(path.join(f.clean, 'runtime/results.mjs')));
  const options = {root: f.project, base: f.campaign, clean: f.clean, paper, requestPath: original.requestPath, verifyResult};
  const snapshot = path.join(f.campaign, 'receipts/origin/a002-prior-state.json');
  const publicRequest = path.join(f.campaign, 'orders/origin/a002-repair-request.json');
  const workerOrder = path.join(f.campaign, 'orders/origin/a002-worker.md');
  const realWrite = fs.writeFileSync, realLink = fs.linkSync;
  const interruptedTarget = path.join(f.campaign, 'atomic-write-fixture.json');
  fs.writeFileSync = function (filename, ...rest) {
    if (typeof filename === 'number') {
      realWrite.call(fs, filename, 'synthetic partial bytes');
      throw Object.assign(new Error('Synthetic interrupted temporary write'), {code: 'EIO'});
    }
    return realWrite.call(fs, filename, ...rest);
  };
  try { assert.throws(() => writeOnceOrMatch(interruptedTarget, 'complete synthetic bytes'), /Synthetic interrupted temporary write/); }
  finally { fs.writeFileSync = realWrite; }
  assert.ok(!fs.existsSync(interruptedTarget), 'A partial temporary write must never become the immutable final file');
  writeOnceOrMatch(interruptedTarget, 'complete synthetic bytes');
  assert.equal(fs.readFileSync(interruptedTarget, 'utf8'), 'complete synthetic bytes');
  for (const target of [publicRequest, workerOrder]) {
    fs.linkSync = function (source, destination, ...rest) {
      if (path.resolve(String(destination)) === target) throw Object.assign(new Error('Synthetic material write failure'), {code: 'EIO'});
      return realLink.call(fs, source, destination, ...rest);
    };
    try { await assert.rejects(prepareRepair(options), /Synthetic material write failure/); }
    finally { fs.linkSync = realLink; }
    assert.deepEqual(fs.readFileSync(f.statePath), stateBytes);
    assert.equal(fs.readFileSync(snapshot, 'utf8'), json(paper));
    assert.ok(!fs.existsSync(target), 'A failed atomic publication must not leave a half-final artifact');
  }
  assert.equal(digest(publicRequest), digest(original.requestPath));
  assert.ok(!fs.existsSync(workerOrder));
  const persisted = {[snapshot]: digest(snapshot), [publicRequest]: digest(publicRequest)};
  f.manage('prepare-repair', 'origin', original.requestPath);
  assert.equal(f.paper().attempt, 2);
  assert.equal(f.paper().attemptHistory.length, 1);
  assertPreserved(persisted);
  const committed = fs.readFileSync(f.statePath);
  f.manage('prepare-repair', 'origin', original.requestPath);
  assert.deepEqual(fs.readFileSync(f.statePath), committed);
});

test('candidate receipt survives an intake order collision and identical retry commits once', t => {
  const f = fixture(t);
  completeToRevision(f);
  prepareRepair(f);
  construct(f, 2);
  const orderPath = path.join(f.campaign, 'orders/origin/a002-reviewer.md');
  f.put(orderPath, 'Synthetic conflicting reviewer order; preserve this exact file.\n');
  const collisionBytes = fs.readFileSync(orderPath);
  rejectsUnchanged(f, 'intake');
  assert.deepEqual(fs.readFileSync(orderPath), collisionBytes);
  const receiptPath = path.join(f.campaign, 'receipts/origin/a002-candidate.json');
  assert.ok(fs.existsSync(receiptPath), 'Synthetic failure must occur after candidate receipt materialization');
  const receiptBytes = fs.readFileSync(receiptPath);
  fs.unlinkSync(orderPath); // One exact synthetic obstruction, never recursive deletion.
  f.manage('intake', 'origin');
  assert.equal(f.paper().phase, 'awaiting_review');
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBytes);
  assert.equal(f.paper().ownerHistory.filter(item => item.agent === 'synthetic-worker-a002').length, 1);
  const frozen = preservedFiles(f);
  rejectsUnchanged(f, 'intake');
  assertPreserved(frozen);
});

test('same request repairs an event-append interruption after state commit without another revision', t => {
  const f = fixture(t);
  completeToRevision(f);
  const original = request(f), prior = f.state();
  const eventsPath = path.join(f.campaign, 'events.jsonl'), eventsBytes = fs.readFileSync(eventsPath);
  const preload = path.join(f.project, 'synthetic-fail-event-append.cjs');
  f.put(preload, "const fs=require('node:fs');const path=require('node:path');const original=fs.appendFileSync;fs.appendFileSync=function(file,...args){if(path.resolve(String(file))===" + JSON.stringify(eventsPath) + "){throw Object.assign(new Error('Synthetic event append interruption'),{code:'EIO'});}return original.call(fs,file,...args);};\n");
  const failed = f.execute('manage', ['prepare-repair', 'origin', original.requestPath], false, {preload});
  assert.match(failed.diagnostic, /Synthetic event append interruption/);
  assert.equal(f.state().revision, prior.revision + 1, 'State should have committed before the event append fault');
  assert.equal(f.paper().phase, 'ready');
  assert.equal(f.paper().attempt, 2);
  assert.deepEqual(fs.readFileSync(eventsPath), eventsBytes);
  const committed = fs.readFileSync(f.statePath), frozen = preservedFiles(f);
  f.manage('prepare-repair', 'origin', original.requestPath);
  assert.deepEqual(fs.readFileSync(f.statePath), committed, 'Event reconciliation must not advance ledger revision');
  const after = fs.readFileSync(eventsPath), events = after.toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event => event.kind === 'repair_prepared').length, 1);
  assert.equal(events.at(-1).revision, prior.revision + 1);
  f.manage('prepare-repair', 'origin', original.requestPath);
  assert.deepEqual(fs.readFileSync(eventsPath), after, 'Repeated reconciliation must not duplicate the event');
  assertPreserved(frozen);
});
