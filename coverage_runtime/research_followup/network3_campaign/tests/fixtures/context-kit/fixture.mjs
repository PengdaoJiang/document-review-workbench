import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as core from '../../../coverage-core.mjs';

// Synthetic academic inputs only. Every command executes copied neutral code
// inside its own temporary project, never the production campaign or runtime.
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../../..');
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

function fixture(t, {diagnostic = false, failedRun = false, mainText = null} = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'network3-context-kit-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(project);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^network3-context-kit-test-/);
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
  const latex = member('papers/origin/source/main.tex', mainText ?? ('Synthetic identity $x=x$.\n\nEvery real x satisfies the identity.\n' + (diagnostic ? '\\[unterminated\n' : '\\[x-x=0\\]\n')));
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

export {fixture, installCoverage, scenario, candidateFor, reviewFor, decisionFor, refreshBasis, objectHash, copyModuleClosure, protectedInventory, campaignRelative, cleanRelative, read, clone, hash, digest, executedEvidence};

