import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as core from '../coverage-core.mjs';

// Synthetic academic inputs only. Every command executes copied neutral code
// inside its own temporary project, never the production campaign or runtime.
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../..');
const campaignRelative = 'research_followup/network3_campaign';
const cleanRelative = 'research_followup/reproduction_clean';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = file => hash(fs.readFileSync(file));
const clone = value => structuredClone(value);

function copyModuleClosure(project, relative, seen = new Set()) {
  if (seen.has(relative)) return;
  seen.add(relative);
  assert.ok(relative.endsWith('.mjs'), 'Only neutral module code is copied');
  const body = fs.readFileSync(path.join(repository, relative), 'utf8');
  const destination = path.join(project, relative);
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  fs.writeFileSync(destination, body);
  for (const match of body.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
    const dependency = path.normalize(path.join(path.dirname(relative), match[1]));
    assert.ok(!dependency.startsWith('..') && !path.isAbsolute(dependency));
    copyModuleClosure(project, dependency, seen);
  }
}

function fixture(t, {diagnostic = false, failedRun = false} = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'network3-coverage-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(project);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^network3-coverage-test-/);
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const put = (name, value) => {
    const file = path.isAbsolute(name) ? name : path.join(project, name);
    const relative = path.relative(project, file);
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, bytes);
    return {path: relative.replaceAll('\\', '/'), sha256: hash(bytes)};
  };
  const absolute = ref => ({...ref, path: path.join(project, ref.path)});
  copyModuleClosure(project, cleanRelative + '/runtime/cli.mjs');
  const clean = path.join(project, cleanRelative), campaign = path.join(project, campaignRelative);
  const source = put('sources/original_pdfs/synthetic.pdf', 'Synthetic bytes, not an academic PDF');
  const sourcePath = path.join(project, source.path);
  put('research_tree/data/origin-source.json', {paperId: 'origin', title: 'Synthetic only', doi: '10.test/origin', sourcePath, sourceSha256: source.sha256, sourcePages: 2, readingScope: 'Synthetic only'});
  put('output/model_clean/manifest.json', {source_directory: path.dirname(sourcePath), items: Array.from({length: 208}, (_, i) => ({record_number: i + 1, title: 'Synthetic', doi: '10.test/' + i, source_file: 'unused-' + i + '.pdf', source_sha256: source.sha256, source_pages: 2, clean_pages: 2}))});
  put('sources/source-locations.json', {schemaVersion: 1, legacyRoot: path.join(project, 'legacy'), destinationRoot: 'sources/original_pdfs', files: [{id: 'origin', filename: 'synthetic.pdf', sha256: source.sha256}]});
  put('docs/semantic_reconstruction/AUTHORITY_PATHS.json', {aliases: {}});
  const release = 'dot-20261023', base = 'reconstructed_sources/' + release;
  const member = (name, value) => ({...put(base + '/' + name, value), path: name});
  const latex = member('papers/origin/source/main.tex', 'Synthetic identity $x=x$.\n\nEvery real x satisfies the identity.\n' + (diagnostic ? '\\[unterminated\n' : '\\[x-x=0\\]\n'));
  const body = member('papers/origin/source/body.tex', 'Synthetic appendix identity \\(y=y\\).\n');
  const figure = member('papers/origin/source/fig.png', 'Synthetic image placeholder; not an actual plot');
  const mapping = member('papers/origin/source/map.json', {interpretation: 'PRIVATE_NONACADEMIC_MAPPING_MUST_NOT_BE_SCANNED'});
  const archive = member('archives/origin.zip', 'Synthetic archive'), version = 'dot-' + archive.sha256;
  const record = {schemaVersion: 1, provider: 'dot', paperId: 'origin', version, status: 'user_selected_dot_reconstruction', source: {sha256: source.sha256}, archive, files: {latex, latexEntries: [latex], dependencies: [body], assets: [figure], mapping, all: [latex, body, figure, mapping]}};
  const recordRef = put(base + '/papers/origin/record.json', record);
  const index = put(base + '/index.json', {schemaVersion: 1, provider: 'dot', release, papers: [{paperId: 'origin', version, record: 'papers/origin/record.json', recordSha256: recordRef.sha256}]});
  put('reconstructed_sources/current.json', {schemaVersion: 1, provider: 'dot', release, index: base + '/index.json', indexSha256: index.sha256});
  const paperIds = ['origin', ...Array.from({length: 52}, (_, i) => 'r' + String(i + 1).padStart(4, '0'))];
  const nodes = put('synthetic-authority/nodes.json', paperIds.map(paper_id => ({paper_id})));
  const edges = put('synthetic-authority/edges.json', []);
  const authority = put('docs/network3-research-authorization-20261023.json', {schemaVersion: 1, campaignId: 'network3-reproduction-20261023', supervisor: {threadId: 'synthetic-supervisor'}, scope: {paperCount: 53, nodes, edges, paperIds}, reading: {index: index.path, indexSha256: index.sha256, release}});
  function execute(relativeScript, args, ok = true) {
    const script = path.join(project, relativeScript);
    assert.ok(script.startsWith(project + path.sep));
    const execution = spawnSync(process.execPath, [script, ...args], {cwd: project, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: {...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1'}});
    const diagnostic = [args.join(' '), execution.error?.message, execution.stdout, execution.stderr].filter(Boolean).join('\n');
    if (ok) assert.equal(execution.status, 0, diagnostic);
    else assert.notEqual(execution.status, 0, 'Unexpected success: ' + diagnostic);
    return {...execution, diagnostic, value: ok && execution.stdout.trim().startsWith('{') ? JSON.parse(execution.stdout) : undefined};
  }
  const runtime = (...args) => execute(cleanRelative + '/runtime/cli.mjs', args).value;
  runtime('handoff', 'origin');
  const view = runtime('verify-reading', 'origin');
  const contract = {schemaVersion: 1, paperId: 'origin', inputSha256: view.originalPacket.sha256, sourceSha256: source.sha256, claimInventory: {status: 'partial', basis: 'One synthetic identity only; not a complete source-item inventory'}, claims: [{claimId: 'origin:c0001', kind: 'author_claim', statement: 'Synthetic identity x=x', sourceLocations: [{dot: {version, path: view.primary.path, sha256: view.primary.sha256}, excerpt: 'x=x'}], sourceConditions: ['x is real'], implementationAssumptions: [], nativeUnits: 'dimensionless', conventions: 'real arithmetic', unknowns: [], successCriteria: ['Identity holds']}]};
  put(cleanRelative + '/papers/origin/contract.json', contract);
  put(cleanRelative + '/papers/origin/entry.cjs', "require('node:fs').writeFileSync('answer.json',JSON.stringify({synthetic:true,answer:1}));" + (failedRun ? 'process.exitCode=1;' : ''));
  put(cleanRelative + '/papers/origin/plan.json', {runId: 'synthetic-run', workerCount: 1, config: {synthetic: true}, environment: {synthetic: true}, freshContext: {contextId: 'synthetic-first-pass', historyInherited: false, declaredBy: 'test'}, chunks: [{id: 'one', executable: process.execPath, args: ['${SOURCE}/entry.cjs']}]});
  const run = runtime('new-run', 'origin', 'plan.json');
  const output = runtime('chunk', 'origin', 'synthetic-run', 'one');
  if (!failedRun) runtime('finish', 'origin', 'synthetic-run');
  const answer = path.join(path.dirname(output.receiptPath), 'work/answer.json');
  const runBindings = [{runId: 'synthetic-run', runSha256: digest(path.join(run.runDir, 'run.json'))}];
  const result = {schemaVersion: 1, paperId: 'origin', resultId: 'synthetic-first-pass', phase: 'first_pass', inputSha256: view.originalPacket.sha256, contractSha256: digest(path.join(run.runDir, 'source/contract.json')), contract, runBindings, claims: [{claimId: 'origin:c0001', status: 'partial', conclusion: 'Synthetic numeric sample only', testedScope: 'One synthetic sample, not an analytic proof', limitations: ['Synthetic fixture only'], evidence: [{role: 'numeric', runId: 'synthetic-run', path: path.relative(run.runDir, answer).replaceAll('\\', '/'), sha256: digest(answer), description: 'Captured synthetic output'}]}], assessment: {by: 'synthetic-worker', at: '2026-10-24T00:00:00Z', basis: 'Fixture only'}, supersedes: []};
  put(cleanRelative + '/drafts/origin/result.json', result);
  const resultRef = runtime('publish-result', 'origin', 'result.json');
  const reviewRef = put(cleanRelative + '/verifications/origin/a001/review.json', {schemaVersion: 1, paperId: 'origin', reviewerAgent: 'synthetic-old-reviewer', recommendation: 'accept_bounded', bindings: {result: resultRef}, independentChecks: [{id: 'synthetic-check', evidence: [{path: answer, sha256: digest(answer)}]}]});
  const acceptanceRef = put(campaignRelative + '/receipts/origin/a001-supervisor.json', {schemaVersion: 1, paperId: 'origin', decision: 'accept_bounded', candidateResultSha256: resultRef.sha256, reviewSha256: reviewRef.sha256});
  const firstPass = {result: {path: resultRef.path, sha256: resultRef.sha256}, review: reviewRef, acceptance: acceptanceRef};
  return {project, clean, campaign, put, absolute, execute, runtime, view, contract, result, firstPass, run, output, answer, paperIds, authority, version, index};
}

function installCoverage(f) {
  copyModuleClosure(f.project, campaignRelative + '/coverage.mjs');
  const papers = f.paperIds.map(paperId => {
    if (paperId === 'origin') return {paperId,
      result: {...f.firstPass.result, legacyResultId: 'synthetic-first-pass'},
      review: {...f.firstPass.review, legacyRecommendation: 'accept_bounded'},
      acceptance: {...f.firstPass.acceptance, decision: 'accept_bounded', acceptedAt: '2026-10-24T00:00:00Z', acceptedScope: ['Synthetic immutable historical metadata']}};
    return {paperId,
      result: f.put(cleanRelative + `/results/${paperId}/synthetic-first-pass.json`, {paperId, fixtureOnly: true}),
      review: f.put(cleanRelative + `/verifications/${paperId}/a001/review.json`, {paperId, fixtureOnly: true}),
      acceptance: f.put(campaignRelative + `/receipts/${paperId}/a001-supervisor.json`, {paperId, fixtureOnly: true})};
  });
  const closure = f.put(campaignRelative + '/synthetic-first-pass-closure.json', {schemaVersion: 1, status: 'first_pass_complete_bounded', papers});
  f.put('docs/network3-coverage-authorization-20261024.json', {schemaVersion: 1, scopeAuthority: f.authority, firstPassClosure: closure, supervisor: {threadId: 'synthetic-supervisor'}});
  f.put(campaignRelative + '/state.json', {phase: 'first_pass_complete_bounded', protectedSentinel: 'DO_NOT_REOPEN_OR_REWRITE'});
  let requestCount = 0;
  const state = () => read(path.join(f.campaign, 'coverage/state.json'));
  const invoke = (command, request = null, ok = true) => f.execute(campaignRelative + '/coverage.mjs', [command, ...(request ? [request.path] : [])], ok);
  const request = (fields = {}) => f.put(campaignRelative + '/coverage/requests/r' + String(++requestCount).padStart(4, '0') + '.json', {expectedRevision: state().revision, paperId: 'origin', ...fields});
  const command = (name, fields = {}, ok = true) => {
    const submitted = request(fields);
    return {...invoke(name, submitted, ok), request: submitted};
  };
  return {...f, closure, state, invoke, request, command, paper: () => state().papers.find(paper => paper.paperId === 'origin')};
}

function protectedInventory(project) {
  const result = {};
  const allowedRoots = [campaignRelative + '/coverage/', cleanRelative + '/coverage_work/', cleanRelative + '/coverage_verifications/'];
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(project, relative), {withFileTypes: true})) {
      const child = path.join(relative, entry.name), normalized = child.replaceAll('\\', '/');
      if (entry.isDirectory()) visit(child);
      else if (!allowedRoots.some(root => normalized.startsWith(root))) result[normalized] = digest(path.join(project, child));
    }
  };
  visit('');
  return result;
}

const objectHash = value => hash(core.canonical(value));
function refreshBasis(candidate) {
  const byId = new Map(candidate.inventory.items.map(item => [item.id, item]));
  const hashes = Object.fromEntries(candidate.inventory.items.map(item => [item.id, objectHash(item)]));
  const collect = (id, result = new Set()) => {
    if (result.has(id)) return result;
    result.add(id);
    for (const dependency of byId.get(id).dependencies) collect(dependency, result);
    return result;
  };
  for (const assessment of candidate.assessments) {
    const item = candidate.inventory.items.find(value => value.obligations.some(obligation => obligation.id === assessment.obligationId));
    assessment.basisItemHashes = Object.fromEntries([...collect(item.id)].sort().map(id => [id, hashes[id]]));
  }
  return candidate;
}

function candidateFor(f, scan, {author = 'synthetic-worker-c001'} = {}) {
  const artifact = f.put(cleanRelative + '/coverage_work/origin/c001/derivation.txt', 'Synthetic derivation artifact: x=x follows from reflexivity. Fixture only.');
  const items = scan.units.map((unit, index) => {
    const id = 'origin:i' + String(index + 1).padStart(4, '0');
    const mathematical = ['inline_math', 'display_math', 'math_environment'].includes(unit.kind);
    return {id, kind: mathematical ? 'formula' : 'statement', text: 'Synthetic source item ' + (index + 1),
      locators: [unit.start === null ? {unitId: unit.id, semantic: 'Entire synthetic image fixture'} : {unitId: unit.id, start: unit.start, end: unit.end, excerptSha256: unit.excerptSha256}],
      conditions: ['Synthetic domain only'], units: 'dimensionless', dependencies: index > 0 && index < 3 ? ['origin:i' + String(index).padStart(4, '0')] : [],
      obligations: [{id: id + ':o01', dimension: mathematical ? 'formulaDerivation' : 'statementValidation', kind: 'analytic', statement: 'Check the synthetic identity under its explicit conditions', conditions: ['Synthetic domain only'], successCriterion: 'A directly checkable synthetic derivation'}]};
  });
  const candidate = {schemaVersion: 1, paperId: 'origin', revision: 1, scanSha256: objectHash(scan), predecessorSha256: null, author,
    inventory: {items, unitDispositions: scan.units.map((unit, index) => ({unitId: unit.id, itemIds: [items[index].id], reason: 'Synthetic source unit individually inventoried'})), diagnosticDispositions: scan.diagnostics.map(value => ({diagnosticId: value.id, resolved: true, reason: 'Synthetic diagnostic explicitly inspected; no scientific content inferred'})), complete: true},
    assessments: items.map(item => ({obligationId: item.obligations[0].id, status: 'accepted', outcome: 'supported', summary: 'Synthetic supported obligation', limitations: ['Fixture only, not a scientific claim'], basisItemHashes: {}, evidence: [{kind: 'new', method: 'analytic_derivation', artifacts: [artifact], mapping: {scope: 'Exact synthetic item', conditions: 'Identical synthetic conditions', dependencyCompatibility: 'Explicit synthetic dependencies checked'}}]}))};
  return refreshBasis(candidate);
}

function reviewFor(f, scan, candidate, {reviewer = 'synthetic-reviewer-c001'} = {}) {
  const evidence = f.put(cleanRelative + `/coverage_verifications/origin/c${String(candidate.revision).padStart(3, '0')}/independent.txt`, 'Independent synthetic derivation checked from source. Fixture only.');
  return {schemaVersion: 1, paperId: 'origin', revision: candidate.revision, scanSha256: objectHash(scan), candidateSha256: objectHash(candidate), reviewerAgent: reviewer,
    inventory: {complete: candidate.inventory.complete, resourceIds: scan.resources.map(resource => resource.id), checkedAllUnits: true, missingItems: [], notes: 'All synthetic academic resources, units and omitted regions checked', unitExclusions: candidate.inventory.unitDispositions.filter(value => !value.itemIds.length && scan.units.find(unit => unit.id === value.unitId).kind !== 'text_block').map(value => ({unitId: value.unitId, reason: 'Independently checked synthetic exclusion'}))},
    entries: candidate.assessments.map(assessment => ({obligationId: assessment.obligationId, assessmentSha256: objectHash(assessment), verdict: assessment.status === 'accepted' ? 'accept' : 'needs_work', reason: 'Independent synthetic scope assessment', evidence: [evidence]})), retainedObligationIds: []};
}

function decisionFor(scan, candidate, review) {
  return {schemaVersion: 1, paperId: 'origin', revision: candidate.revision, scanSha256: objectHash(scan), candidateSha256: objectHash(candidate), reviewSha256: objectHash(review), decision: 'accept_snapshot', acceptedObligationIds: candidate.assessments.filter(value => value.status === 'accepted').map(value => value.obligationId), inventoryAccepted: candidate.inventory.complete && review.inventory.complete, supervisor: 'synthetic-supervisor', rationale: 'Accept only independently checked synthetic obligations'};
}

async function scenario(t, options = {}) {
  const f = fixture(t, options);
  const scan = await core.makeScan({root: f.project, paperId: 'origin', reading: f.view, firstPass: f.firstPass});
  const candidate = candidateFor(f, scan), review = reviewFor(f, scan, candidate), decision = decisionFor(scan, candidate, review);
  const validate = (value = candidate, previous = null) => core.validateCandidate({root: f.project, scan, scanSha256: objectHash(scan), candidate: value, previous});
  const validateReview = (value = review, proposed = candidate, previous = null, identities = {}) => core.validateReview({root: f.project, scan, candidate: proposed, candidateSha256: objectHash(proposed), review: value, reviewer: value.reviewerAgent, worker: proposed.author, previous, ...identities});
  return {...f, scan, candidate, review, decision, validate, validateReview};
}

function executedEvidence(f) {
  const output = f.put(cleanRelative + '/coverage_work/origin/c001/numeric.json', {fixtureOnly: true, sample: 1, identity: true});
  const receipt = f.put(cleanRelative + '/coverage_work/origin/c001/numeric-receipt.json', {schemaVersion: 1, paperId: 'origin', tool: 'synthetic-fixture', version: '1', command: ['synthetic-test', 'not-real-science'], workerCount: 1, startedAt: '2026-10-24T00:00:00Z', finishedAt: '2026-10-24T00:00:01Z', exitCode: 0, inputs: [f.view.primary], outputs: [output]});
  return {kind: 'new', method: 'numeric_test', artifacts: [output], mapping: {scope: 'One synthetic sample', conditions: 'Same stated sample only', dependencyCompatibility: 'Synthetic dependency checked'}, execution: {receipt}};
}

test('scan is source-bound, includes every academic resource, and is not a completion certificate', async t => {
  const f = await scenario(t);
  assert.equal(f.scan.resources.length, 3);
  assert.ok(f.scan.resources.some(value => value.path.endsWith('body.tex')));
  assert.ok(f.scan.units.some(value => value.kind === 'asset'));
  assert.ok(f.scan.units.some(value => value.kind === 'text_block'));
  assert.ok(!JSON.stringify(f.scan.resources).includes('map.json'));
  assert.ok(!f.scan.resources.some(value => value.path.endsWith('.pdf')));
  assert.deepEqual(await core.makeScan({root: f.project, paperId: 'origin', reading: f.view, firstPass: f.firstPass}), f.scan);
  const checked = await f.validate();
  assert.equal(checked.valid, true);
  assert.equal(checked.metrics.settled, 0, 'Candidate claims alone earn no accepted credit');
  const withoutDecision = core.assessCoverage({scan: f.scan, candidate: f.candidate});
  assert.equal(withoutDecision.coverageComplete, false);
  assert.equal(withoutDecision.coveragePercent, null);
  await f.validateReview();
  const metrics = core.assessCoverage({scan: f.scan, candidate: f.candidate, review: f.review, decision: f.decision});
  assert.equal(metrics.coverageComplete, true);
  assert.equal(metrics.settled, f.candidate.assessments.length);
  assert.equal(metrics.supported, metrics.settled);
});

test('candidate rejects omitted unit, asset, diagnostic, orphan mapping and invented locator', async t => {
  const f = await scenario(t, {diagnostic: true});
  assert.ok(f.scan.diagnostics.length > 0);
  for (const kind of ['text_block', 'asset']) {
    const bad = clone(f.candidate), unit = f.scan.units.find(value => value.kind === kind);
    bad.inventory.unitDispositions = bad.inventory.unitDispositions.filter(value => value.unitId !== unit.id);
    await assert.rejects(f.validate(bad), /unit dispositions/);
  }
  const noDiagnostic = clone(f.candidate);
  noDiagnostic.inventory.diagnosticDispositions.pop();
  await assert.rejects(f.validate(noDiagnostic), /diagnostic dispositions/);
  const unresolved = clone(f.candidate);
  unresolved.inventory.diagnosticDispositions[0].resolved = false;
  await assert.rejects(f.validate(unresolved), /complete inventory.*unresolved/);
  const orphan = clone(f.candidate);
  orphan.inventory.unitDispositions[0].itemIds = [];
  await assert.rejects(f.validate(orphan), /omits a located item/);
  const forged = clone(f.candidate);
  const locator = forged.inventory.items.find(value => value.locators[0].start !== undefined).locators[0];
  locator.excerptSha256 = '0'.repeat(64);
  refreshBasis(forged);
  await assert.rejects(f.validate(forged), /locator excerpt hash mismatch/);
});

test('review requires all resources, exact current candidate and a different actual reviewer', async t => {
  const f = await scenario(t);
  const omitted = clone(f.review);
  omitted.inventory.resourceIds.pop();
  await assert.rejects(f.validateReview(omitted), /review resources/);
  const stale = clone(f.review);
  stale.revision = 0;
  await assert.rejects(f.validateReview(stale), /exact candidate\/scan\/revision/);
  const wrongHash = clone(f.review);
  wrongHash.candidateSha256 = '0'.repeat(64);
  await assert.rejects(f.validateReview(wrongHash), /exact candidate\/scan\/revision/);
  const selfReview = clone(f.review);
  selfReview.reviewerAgent = f.candidate.author;
  await assert.rejects(f.validateReview(selfReview), /candidate author|actually registered different agent/);
  const wrongAgent = {reviewer: 'unregistered-reviewer'};
  await assert.rejects(f.validateReview(f.review, f.candidate, null, wrongAgent), /actually registered different agent/);
  const noEvidence = clone(f.review);
  noEvidence.entries[0].evidence = [];
  await assert.rejects(f.validateReview(noEvidence), /independent review needs supporting evidence/);
  const missingObligation = clone(f.review);
  missingObligation.entries.pop();
  await assert.rejects(f.validateReview(missingObligation), /review obligation coverage/);
  const excluded = clone(f.candidate), assetUnit = f.scan.units.find(value => value.kind === 'asset');
  const omittedItem = excluded.inventory.items.find(value => value.locators.some(locator => locator.unitId === assetUnit.id));
  excluded.inventory.items = excluded.inventory.items.filter(value => value.id !== omittedItem.id);
  excluded.assessments = excluded.assessments.filter(value => !omittedItem.obligations.some(obligation => obligation.id === value.obligationId));
  for (const item of excluded.inventory.items) item.dependencies = item.dependencies.filter(value => value !== omittedItem.id);
  for (const disposition of excluded.inventory.unitDispositions) disposition.itemIds = disposition.itemIds.filter(value => value !== omittedItem.id);
  refreshBasis(excluded);
  await f.validate(excluded);
  const excludedReview = reviewFor(f, f.scan, excluded);
  assert.ok(excludedReview.inventory.unitExclusions.some(value => value.unitId === assetUnit.id));
  excludedReview.inventory.unitExclusions = [];
  await assert.rejects(f.validateReview(excludedReview, excluded), /review unit exclusions/);
});

test('numeric samples cannot discharge a general analytic obligation, and execution receipts are hash-bound', async t => {
  const f = await scenario(t);
  const bad = clone(f.candidate);
  bad.assessments[0].evidence = [executedEvidence(f)];
  await assert.rejects(f.validate(bad), /numeric agreement is not a general proof/);
  bad.inventory.items[0].obligations[0].kind = 'empirical';
  bad.inventory.items[0].obligations[0].dimension = 'simulationValidation';
  refreshBasis(bad);
  await f.validate(bad);
  const noReceipt = clone(bad);
  delete noReceipt.assessments[0].evidence[0].execution;
  await assert.rejects(f.validate(noReceipt), /requires an execution receipt/);
  const receiptPath = path.resolve(f.project, bad.assessments[0].evidence[0].execution.receipt.path);
  const original = fs.readFileSync(receiptPath);
  f.put(receiptPath, {...read(receiptPath), exitCode: 1});
  await assert.rejects(f.validate(bad), /file hash mismatch/);
  f.put(receiptPath, original);
  const wrongOutput = clone(bad);
  wrongOutput.assessments[0].evidence[0].artifacts = [f.put(cleanRelative + '/coverage_work/origin/c001/unrecorded.json', {notCaptured: true})];
  await assert.rejects(f.validate(wrongOutput), /output inventory does not cover/);
});

test('legacy reuse verifies exact claims, evidence bytes, evidence roles and first-pass bindings', async t => {
  const f = await scenario(t);
  const reused = clone(f.candidate);
  reused.inventory.items[0].obligations[0].kind = 'empirical';
  reused.inventory.items[0].obligations[0].dimension = 'simulationValidation';
  refreshBasis(reused);
  reused.assessments[0].evidence = [{kind: 'reuse', method: 'numeric_test', artifacts: [{path: f.answer, sha256: digest(f.answer)}], mapping: {scope: 'Exact one-sample historical synthetic evidence, not the whole claim group', conditions: 'No broadening of original sample conditions', dependencyCompatibility: 'Same synthetic definitions'}, legacy: {...f.firstPass, claimIds: ['origin:c0001']}}];
  await f.validate(reused);
  const invented = clone(reused);
  invented.assessments[0].evidence[0].legacy.claimIds = ['origin:c9999'];
  await assert.rejects(f.validate(invented), /unknown legacy claim/);
  const wrongRole = clone(reused);
  wrongRole.assessments[0].evidence[0].method = 'analytic_derivation';
  await assert.rejects(f.validate(wrongRole), /required evidence role/);
  const wrongArtifact = clone(reused);
  wrongArtifact.assessments[0].evidence[0].artifacts = [f.put(cleanRelative + '/coverage_work/origin/c001/not-old-evidence.txt', 'Not present in the old output inventory')];
  await assert.rejects(f.validate(wrongArtifact), /exact matching claim evidence/);
  const wrongAcceptance = clone(reused);
  wrongAcceptance.assessments[0].evidence[0].legacy.acceptance = f.put(campaignRelative + '/receipts/origin/forged.json', {paperId: 'origin', decision: 'accept_bounded'});
  await assert.rejects(f.validate(wrongAcceptance), /legacy acceptance reference differs/);
});

test('incremental snapshots retain unchanged checks but reject definition/dependency drift and deleted obligations', async t => {
  const f = await scenario(t);
  await f.validateReview();
  const previous = {candidate: f.candidate, sha256: objectHash(f.candidate), review: f.review, decision: f.decision};
  const next = clone(f.candidate);
  next.revision = 2;
  next.predecessorSha256 = previous.sha256;
  next.author = 'synthetic-worker-c002';
  const retained = reviewFor(f, f.scan, next, {reviewer: 'synthetic-reviewer-c002'});
  retained.entries = [];
  retained.retainedObligationIds = next.assessments.map(value => value.obligationId);
  await f.validate(next, previous);
  await f.validateReview(retained, next, previous);
  const definitionChanged = clone(next);
  definitionChanged.inventory.items[0].conditions.push('New unverified condition');
  await assert.rejects(f.validate(definitionChanged, previous), /stale or incomplete transitive basis/);
  refreshBasis(definitionChanged);
  const staleRetention = reviewFor(f, f.scan, definitionChanged, {reviewer: 'synthetic-reviewer-c002'});
  staleRetention.entries = [];
  staleRetention.retainedObligationIds = next.assessments.map(value => value.obligationId);
  await assert.rejects(f.validateReview(staleRetention, definitionChanged, previous), /assessment\/dependency basis changed/);
  const dependencyChanged = clone(next);
  dependencyChanged.inventory.items[0].text += ' altered foundation';
  const changedHash = objectHash(dependencyChanged.inventory.items[0]);
  dependencyChanged.assessments[0].basisItemHashes[dependencyChanged.inventory.items[0].id] = changedHash;
  await assert.rejects(f.validate(dependencyChanged, previous), /stale or incomplete transitive basis/);
  const deleted = clone(next), removed = deleted.inventory.items.pop();
  deleted.assessments = deleted.assessments.filter(value => value.obligationId !== removed.obligations[0].id);
  for (const disposition of deleted.inventory.unitDispositions) disposition.itemIds = disposition.itemIds.filter(id => id !== removed.id);
  await assert.rejects(f.validate(deleted, previous), /cannot delete an existing item/);
  const deletedObligation = clone(next);
  deletedObligation.inventory.items[0].obligations[0].id = 'origin:i0001:o02';
  deletedObligation.assessments[0].obligationId = 'origin:i0001:o02';
  refreshBasis(deletedObligation);
  await assert.rejects(f.validate(deletedObligation, previous), /cannot delete an existing obligation/);
});

test('internal work and external blockers remain in the denominator and cannot be accepted as complete', async t => {
  const f = await scenario(t);
  const blocked = clone(f.candidate), assessment = blocked.assessments[0];
  assessment.status = 'external_blocked';
  assessment.outcome = 'inconclusive';
  assessment.evidence = [];
  assessment.blocker = {missing: 'Synthetic original measurement samples absent', affectedObligations: [assessment.obligationId], attemptedAlternatives: ['Inspected complete synthetic source and all assets'], whyExternal: 'Original samples require an outside holder', releaseCondition: 'Exact synthetic sample release becomes available'};
  await f.validate(blocked);
  const review = reviewFor(f, f.scan, blocked), decision = decisionFor(f.scan, blocked, review);
  await f.validateReview(review, blocked);
  const metrics = core.assessCoverage({scan: f.scan, candidate: blocked, review, decision});
  assert.equal(metrics.obligations, f.candidate.assessments.length);
  assert.equal(metrics.externalBlocked, 1);
  assert.equal(metrics.coverageComplete, false);
  assert.ok(metrics.coveragePercent < 100);
  const forgedDecision = clone(decision);
  forgedDecision.acceptedObligationIds.push(assessment.obligationId);
  assert.throws(() => core.assessCoverage({scan: f.scan, candidate: blocked, review, decision: forgedDecision}), /cannot settle an unaccepted\/incomplete/);
  const unsupportedBlocker = clone(blocked);
  delete unsupportedBlocker.assessments[0].blocker.releaseCondition;
  await assert.rejects(f.validate(unsupportedBlocker), /missing releaseCondition/);
  const internal = clone(blocked);
  internal.assessments[0].status = 'internal_gap';
  delete internal.assessments[0].blocker;
  await f.validate(internal);
  const internalReview = reviewFor(f, f.scan, internal), internalDecision = decisionFor(f.scan, internal, internalReview);
  const internalMetrics = core.assessCoverage({scan: f.scan, candidate: internal, review: internalReview, decision: internalDecision});
  assert.equal(internalMetrics.internalGap, 1);
  assert.equal(internalMetrics.externalBlocked, 0);
  assert.equal(internalMetrics.coverageComplete, false);
});

test('CLI isolates writes, enforces revisions and ownership, and supplements only the missing obligation', async t => {
  const f = installCoverage(fixture(t));
  const protectedBefore = protectedInventory(f.project);
  assert.equal(f.invoke('init').value.status, 'initialized');
  assert.equal(f.invoke('init').value.status, 'already_initialized');
  for (const kind of ['result', 'review', 'acceptance']) assert.deepEqual(Object.keys(f.paper().firstPass[kind]).sort(), ['path', 'sha256'], 'Old expanded references are projected, not rewritten or accepted as loose new refs');
  assert.equal(f.state().revision, 0);
  const prepared = f.command('prepare');
  assert.equal(prepared.value.iteration, 1);
  assert.equal(f.invoke('prepare', prepared.request).value.replayed, true);
  assert.equal(f.state().revision, 1);
  const stale = f.command('assign', {expectedRevision: 0, role: 'worker', agent: 'synthetic-worker-c001', freshContext: true, historyInherited: false}, false);
  assert.match(stale.stderr, /Stale expectedRevision/);
  assert.equal(f.state().revision, 1);
  f.command('assign', {role: 'worker', agent: 'synthetic-worker-c001', freshContext: true, historyInherited: false});
  const scan = read(f.paper().scan.path);
  const candidate = candidateFor(f, scan);
  candidate.assessments[0].status = 'internal_gap';
  candidate.assessments[0].outcome = 'inconclusive';
  candidate.assessments[0].summary = 'Synthetic single missing derivation, not an external blocker';
  candidate.assessments[0].evidence = [];
  const candidateFile = f.put(f.paper().workRoot + '/candidate.json', candidate);
  const intake = f.command('intake', {agent: candidate.author, ownerFinished: true, candidatePath: candidateFile.path});
  assert.equal(f.invoke('intake', intake.request).value.replayed, true);
  assert.equal(f.paper().phase, 'awaiting_review');
  const badOwner = f.command('assign', {role: 'reviewer', agent: candidate.author, freshContext: true, historyInherited: false}, false);
  assert.match(badOwner.stderr, /Worker cannot independently review/);
  const reviewer = 'synthetic-reviewer-c001';
  f.command('assign', {role: 'reviewer', agent: reviewer, freshContext: true, historyInherited: false});
  const review = reviewFor(f, scan, candidate, {reviewer});
  const reviewFile = f.put(f.paper().staged.reviewRoot + '/review.json', review);
  f.command('review', {agent: reviewer, ownerFinished: true, reviewPath: reviewFile.path});
  const decision = decisionFor(scan, candidate, review);
  const decisionFile = f.put(campaignRelative + '/coverage/requests/decision-c001.json', decision);
  const firstDecision = f.command('decide', {decisionPath: decisionFile.path});
  assert.equal(firstDecision.value.phase, 'assessed');
  assert.equal(firstDecision.value.metrics.internalGap, 1);
  assert.equal(firstDecision.value.metrics.settled, candidate.assessments.length - 1);
  assert.equal(firstDecision.value.metrics.coverageComplete, false);
  assert.equal(f.invoke('decide', firstDecision.request).value.replayed, true);
  const firstSnapshot = clone(f.paper().latest);
  const continuation = f.command('continue');
  assert.deepEqual(continuation.value.selectedObligationIds, [candidate.assessments[0].obligationId]);
  assert.equal(continuation.value.iteration, 2);
  const next = clone(candidate);
  next.revision = 2;
  next.predecessorSha256 = firstSnapshot.candidate.sha256;
  next.author = 'synthetic-worker-c002';
  next.assessments[0].status = 'accepted';
  next.assessments[0].outcome = 'supported';
  next.assessments[0].summary = 'Only the missing synthetic derivation supplemented';
  next.assessments[0].evidence = [{kind: 'new', method: 'analytic_derivation', artifacts: [f.put(cleanRelative + '/coverage_work/origin/c002/supplement.txt', 'Synthetic supplementary proof only for the missing obligation')], mapping: {scope: 'Only the previously missing obligation', conditions: 'Unchanged synthetic conditions', dependencyCompatibility: 'Original definitions and dependencies remain byte-identical'}}];
  for (let i = 1; i < next.assessments.length; i++) assert.deepEqual(next.assessments[i], candidate.assessments[i]);
  f.command('assign', {role: 'worker', agent: next.author, freshContext: true, historyInherited: false});
  const nextCandidateFile = f.put(f.paper().workRoot + '/candidate.json', next);
  f.command('intake', {agent: next.author, ownerFinished: true, candidatePath: nextCandidateFile.path});
  const nextReviewer = 'synthetic-reviewer-c002';
  f.command('assign', {role: 'reviewer', agent: nextReviewer, freshContext: true, historyInherited: false});
  const nextReview = reviewFor(f, scan, next, {reviewer: nextReviewer});
  nextReview.entries = nextReview.entries.filter(value => value.obligationId === next.assessments[0].obligationId);
  nextReview.retainedObligationIds = next.assessments.slice(1).map(value => value.obligationId);
  const nextReviewFile = f.put(f.paper().staged.reviewRoot + '/review.json', nextReview);
  f.command('review', {agent: nextReviewer, ownerFinished: true, reviewPath: nextReviewFile.path});
  const nextDecision = decisionFor(scan, next, nextReview);
  const nextDecisionFile = f.put(campaignRelative + '/coverage/requests/decision-c002.json', nextDecision);
  const settled = f.command('decide', {decisionPath: nextDecisionFile.path});
  assert.equal(settled.value.phase, 'complete');
  assert.equal(settled.value.metrics.coverageComplete, true);
  assert.equal(settled.value.metrics.settled, next.assessments.length);
  assert.equal(f.paper().history.length, 1);
  assert.equal(f.paper().history[0].candidate.sha256, firstSnapshot.candidate.sha256);
  const verified = f.execute(campaignRelative + '/coverage.mjs', ['verify', 'origin']).value;
  assert.equal(verified.coverageComplete, true, 'c002 verification follows its actual predecessor chain');
  const status = f.invoke('status').value;
  assert.equal(status.scope, 53);
  assert.equal(status.completedPapers, 1);
  assert.equal(status.globalCompletionPercent, null, 'One audited paper does not establish the global item denominator');
  const unnecessary = f.command('continue', {}, false);
  assert.match(unnecessary.stderr, /Nothing to repair/);
  assert.deepEqual(protectedInventory(f.project), protectedBefore, 'Old state, frozen first-pass evidence and source release bytes are untouched');
});

test('CLI rejects changed replay receipts, out-of-root requests and non-53 scope', async t => {
  const f = installCoverage(fixture(t));
  f.invoke('init');
  const prepared = f.command('prepare');
  const order = f.paper().order;
  f.put(order.path, fs.readFileSync(order.path, 'utf8') + '\nTampered synthetic receipt');
  const replay = f.invoke('prepare', prepared.request, false);
  assert.match(replay.stderr, /file hash mismatch/);
  assert.equal(f.state().revision, 1);
  const outsideRequest = f.put('outside-request.json', {expectedRevision: 1, paperId: 'origin', role: 'worker', agent: 'worker', freshContext: true, historyInherited: false});
  assert.match(f.invoke('assign', outsideRequest, false).stderr, /Path escapes coverage root/);
  assert.ok(!fs.existsSync(path.join(f.campaign, 'coverage/.writer.lock')), 'Owned writer lock is released after failures');
  const authority = read(path.join(f.project, f.authority.path));
  authority.scope.paperIds.pop();
  const shortAuthority = f.put(f.authority.path, authority);
  const coverageAuthorityFile = path.join(f.project, 'docs/network3-coverage-authorization-20261024.json');
  f.put(coverageAuthorityFile, {...read(coverageAuthorityFile), scopeAuthority: shortAuthority});
  assert.match(f.invoke('status', null, false).stderr, /exact authorized 53 distinct papers/);
});

test('new execution and independent review cannot borrow another paper or the constructor evidence root', async t => {
  const f = await scenario(t);
  const candidate = clone(f.candidate);
  candidate.inventory.items[0].obligations[0].kind = 'empirical';
  candidate.inventory.items[0].obligations[0].dimension = 'simulationValidation';
  refreshBasis(candidate);
  candidate.assessments[0].evidence = [executedEvidence(f)];
  const execution = candidate.assessments[0].evidence[0].execution;
  const receiptPath = path.resolve(f.project, execution.receipt.path), receipt = read(receiptPath);
  receipt.inputs = [f.put(cleanRelative + '/coverage_work/r0001/c001/foreign.txt', 'Different paper evidence cannot supply this experiment')];
  execution.receipt = f.put(receiptPath, receipt);
  await assert.rejects(f.validate(candidate), /execution input is outside the same-paper/);
  const borrowedReview = clone(f.review);
  borrowedReview.entries[0].evidence = f.candidate.assessments[0].evidence[0].artifacts;
  await assert.rejects(f.validateReview(borrowedReview), /independent coverage evidence or exact reused evidence/);
  const foreignReview = clone(f.review);
  foreignReview.entries[0].evidence = [f.put(cleanRelative + '/coverage_verifications/r0001/c001/foreign-review.txt', 'Another paper review')];
  await assert.rejects(f.validateReview(foreignReview), /independent coverage evidence or exact reused evidence/);
});

test('dependency impact declarations require an actual changed ancestor and a genuinely accepted predecessor', async t => {
  const f = await scenario(t);
  const previous = {candidate: f.candidate, sha256: objectHash(f.candidate), review: f.review, decision: f.decision};
  const changed = clone(f.candidate);
  changed.revision = 2;
  changed.predecessorSha256 = previous.sha256;
  changed.author = 'synthetic-worker-c002';
  changed.inventory.items[0].conditions.push('A specific revised domain condition');
  refreshBasis(changed);
  const target = changed.inventory.items[2], ancestor = changed.inventory.items[0];
  changed.changeImpact = [{obligationId: target.obligations[0].id, reason: 'Changed foundation propagates through the explicit two-edge dependency chain', dependsOnChangedItems: [ancestor.id]}];
  await f.validate(changed, previous);
  const unchangedItem = clone(changed);
  unchangedItem.changeImpact[0].dependsOnChangedItems = [changed.inventory.items[1].id];
  await assert.rejects(f.validate(unchangedItem, previous), /genuinely changed items/);
  const unrelated = clone(changed), unrelatedItem = unrelated.inventory.items.at(-1);
  unrelatedItem.text += ' changed but unrelated';
  refreshBasis(unrelated);
  unrelated.changeImpact[0].dependsOnChangedItems = [unrelatedItem.id];
  await assert.rejects(f.validate(unrelated, previous), /dependency closure/);
  const forgedPrevious = clone(previous);
  forgedPrevious.decision.candidateSha256 = '0'.repeat(64);
  await assert.rejects(f.validate(changed, forgedPrevious), /decision does not bind exact/);
  const cyclic = clone(f.candidate);
  cyclic.inventory.items[0].dependencies = [cyclic.inventory.items[2].id];
  await assert.rejects(f.validate(cyclic), /cyclic item dependency/);
});

test('counterexamples and independently justified non-applicability remain distinct from supported reproduction', async t => {
  const f = await scenario(t), candidate = clone(f.candidate);
  candidate.assessments[0].outcome = 'refuted';
  candidate.assessments[0].evidence[0].method = 'counterexample';
  candidate.assessments[1].outcome = 'not_applicable';
  candidate.assessments[1].applicabilityReason = 'Synthetic definition states no empirical experiment';
  candidate.assessments[1].evidence[0].method = 'source_consistency';
  await f.validate(candidate);
  const review = reviewFor(f, f.scan, candidate), decision = decisionFor(f.scan, candidate, review);
  await f.validateReview(review, candidate);
  const metrics = core.assessCoverage({scan: f.scan, candidate, review, decision});
  assert.equal(metrics.refuted, 1);
  assert.equal(metrics.notApplicable, 1);
  assert.equal(metrics.supported, metrics.settled - 2);
  assert.equal(metrics.coverageComplete, true, 'Explicitly resolved negative outcomes may complete coverage, not successful reproduction');
  const unexplained = clone(candidate);
  delete unexplained.assessments[1].applicabilityReason;
  await assert.rejects(f.validate(unexplained), /not_applicable needs a reason/);
  const noSourceCheck = clone(candidate);
  noSourceCheck.assessments[1].evidence[0].method = 'analytic_derivation';
  await assert.rejects(f.validate(noSourceCheck), /source-consistency evidence/);
});

test('CLI owner release requires exact ownership, explicit natural termination and a bound local receipt', async t => {
  const f = installCoverage(fixture(t));
  f.invoke('init');
  f.command('prepare');
  const agent = 'synthetic-exited-worker';
  f.command('assign', {role: 'worker', agent, freshContext: true, historyInherited: false});
  const evidence = f.put(campaignRelative + '/coverage/requests/worker-terminal.json', {agent, status: 'naturally_exited', activeCalculations: 0, fixtureOnly: true});
  const release = {agent, ownerFinished: true, noActiveCalculation: true, reason: 'Synthetic naturally ended worker; preserve work and reassign at saved boundary', supervisor: 'synthetic-supervisor', terminalEvidence: evidence};
  assert.match(f.command('release', {...release, agent: 'different-owner'}, false).stderr, /registered active owner/);
  assert.match(f.command('release', {...release, noActiveCalculation: false}, false).stderr, /not a timeout/);
  assert.match(f.command('release', {...release, ownerFinished: false}, false).stderr, /not a timeout/);
  assert.match(f.command('release', {...release, supervisor: ''}, false).stderr, /actual supervisor/);
  const foreignReceipt = f.put('outside-terminal.json', {agent, status: 'naturally_exited', fixtureOnly: true});
  assert.match(f.command('release', {...release, terminalEvidence: foreignReceipt}, false).stderr, /Path escapes coverage root/);
  const released = f.command('release', release);
  assert.equal(released.value.phase, 'ready');
  assert.equal(f.paper().owner, null);
  assert.equal(f.invoke('release', released.request).value.replayed, true);
  const newAgent = 'synthetic-replacement-worker';
  f.command('assign', {role: 'worker', agent: newAgent, freshContext: true, historyInherited: false});
  const scan = read(f.paper().scan.path), candidate = candidateFor(f, scan, {author: newAgent});
  const candidateFile = f.put(f.paper().workRoot + '/candidate.json', candidate);
  f.command('intake', {agent: newAgent, ownerFinished: true, candidatePath: candidateFile.path});
  assert.match(f.command('assign', {role: 'reviewer', agent, freshContext: true, historyInherited: false}, false).stderr, /Worker cannot independently review/);
  const reviewer = 'synthetic-exited-reviewer';
  f.command('assign', {role: 'reviewer', agent: reviewer, freshContext: true, historyInherited: false});
  const reviewerEvidence = f.put(campaignRelative + '/coverage/requests/reviewer-terminal.json', {agent: reviewer, status: 'naturally_exited', activeCalculations: 0, fixtureOnly: true});
  const reviewerReleased = f.command('release', {...release, agent: reviewer, terminalEvidence: reviewerEvidence});
  assert.equal(reviewerReleased.value.phase, 'awaiting_review');
  assert.equal(f.paper().owner, null);
  assert.equal(f.paper().staged.candidate.sha256, objectHash(candidate));
});

test('failed legacy output is retained as a diagnostic but cannot be promoted into a decisive accepted result', async t => {
  const f = await scenario(t, {failedRun: true});
  assert.equal(f.output.state, 'failed');
  assert.equal(read(f.output.receiptPath).exitCode, 1);
  const candidate = clone(f.candidate);
  candidate.inventory.items[0].obligations[0].kind = 'empirical';
  candidate.inventory.items[0].obligations[0].dimension = 'simulationValidation';
  refreshBasis(candidate);
  candidate.assessments[0].evidence = [{kind: 'reuse', method: 'numeric_test', artifacts: [{path: f.answer, sha256: digest(f.answer)}], mapping: {scope: 'Exact sample output from the failed historical process', conditions: 'Same synthetic conditions', dependencyCompatibility: 'Same definitions; failure is not hidden'}, legacy: {...f.firstPass, claimIds: ['origin:c0001']}}];
  await assert.rejects(f.validate(candidate), /failed|completed|decisive/i);
  candidate.assessments[0].status = 'internal_gap';
  candidate.assessments[0].outcome = 'partial';
  candidate.assessments[0].summary = 'Preserved failed execution diagnostic; no scientific success credit';
  await f.validate(candidate);
  const review = reviewFor(f, f.scan, candidate), decision = decisionFor(f.scan, candidate, review);
  await f.validateReview(review, candidate);
  assert.equal(core.assessCoverage({scan: f.scan, candidate, review, decision}).coverageComplete, false);
});

test('constructor and reviewer cannot manufacture independence from shared or copied private review artifacts', async t => {
  const f = await scenario(t);
  const shared = f.review.entries[0].evidence[0];
  const leaked = clone(f.candidate);
  leaked.assessments[0].evidence[0].artifacts = [shared];
  await assert.rejects(f.validate(leaked), /outside the paper coverage roots/);
  const workArtifact = f.candidate.assessments[0].evidence[0].artifacts[0];
  const copied = f.put(cleanRelative + '/coverage_verifications/origin/c001/copied-constructor.txt', fs.readFileSync(path.resolve(f.project, workArtifact.path)));
  const copiedReview = clone(f.review);
  copiedReview.entries[0].evidence = [copied];
  await assert.rejects(f.validateReview(copiedReview), /copied|same.*hash|constructor|independent/i);
});
