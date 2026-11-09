import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as core from '../protocols/source-binding-v1/coverage-core.mjs';
import {resolveSourceView} from '../protocols/source-binding-v1/source-binding.mjs';
import {resolveLocators, assembleCandidate, assembleReview} from '../protocols/source-binding-v1/coverage-authoring.mjs';
import {validateCandidateScope, validateReviewScope} from '../protocols/source-binding-v1/coverage-scope.mjs';
import {unitsFor, bound as boundContext} from '../protocols/source-binding-v1/coverage-context.mjs';
import {runReader} from '../protocols/source-binding-v1/coverage-reader.mjs';
import {installCoverage} from './fixtures/source-binding/fixture.mjs';

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
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'network3-source-core-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(project);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^network3-source-core-test-/);
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
  const member = (name, value) => { const ref = put(base + '/' + name, value); return {...ref, path: name, bytes: fs.statSync(path.join(project, ref.path)).size}; };
  const listingText = 'synthetic_value = 1;\nassert(synthetic_value == 1);\n';
  const includeText = '\\lstinputlisting{algorithm1.m}';
  const latexText = 'Synthetic identity $x=x$.\n\nEvery real x satisfies the identity.\n\\[x-x=0\\]\n' + includeText + '\n';
  const latex = member('papers/origin/source/main.tex', latexText);
  const listing = member('papers/origin/source/algorithm1.m', listingText);
  const body = member('papers/origin/source/body.tex', 'Synthetic appendix identity \\(y=y\\).\n');
  const figure = member('papers/origin/source/fig.png', 'Synthetic image placeholder; not an actual plot');
  const mapping = member('papers/origin/source/map.json', {interpretation: 'PRIVATE_NONACADEMIC_MAPPING_MUST_NOT_BE_SCANNED'});
  const archive = member('archives/origin.zip', 'Synthetic archive'), version = 'dot-' + archive.sha256;
  const record = {schemaVersion: 1, provider: 'dot', paperId: 'origin', version, status: 'user_selected_dot_reconstruction', source: {sha256: source.sha256}, archive, files: {latex, latexEntries: [latex], dependencies: [body], assets: [figure], mapping, all: [latex, body, figure, mapping, listing]}};
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
  return {project, clean, campaign, put, absolute, execute, runtime, view, contract, result, firstPass, run, output, answer, paperIds, authority, version, index, recordRef, listing, listingText, includeText, latexText, base};
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

function candidateFor(f, scan, sourceView, {author = 'synthetic-worker-c001'} = {}) {
  const artifact = f.put(cleanRelative + '/coverage_work/origin/c001/derivation.txt', 'Synthetic derivation artifact: x=x follows from reflexivity. Fixture only.');
  const items = sourceView.units.map((unit, index) => {
    const id = 'origin:i' + String(index + 1).padStart(4, '0');
    const mathematical = ['inline_math', 'display_math', 'math_environment'].includes(unit.kind);
    return {id, kind: mathematical ? 'formula' : 'statement', text: 'Synthetic source item ' + (index + 1),
      locators: [unit.start === null ? {unitId: unit.id, semantic: 'Entire synthetic image fixture'} : {unitId: unit.id, start: unit.start, end: unit.end, excerptSha256: unit.excerptSha256}],
      conditions: ['Synthetic domain only'], units: 'dimensionless', dependencies: index > 0 && index < 3 ? ['origin:i' + String(index).padStart(4, '0')] : [],
      obligations: [{id: id + ':o01', dimension: mathematical ? 'formulaDerivation' : 'statementValidation', kind: 'analytic', statement: 'Check the synthetic identity under its explicit conditions', conditions: ['Synthetic domain only'], successCriterion: 'A directly checkable synthetic derivation'}]};
  });
  const candidate = {schemaVersion: 2, sourceBinding: f.sourceBinding, paperId: 'origin', revision: 1, scanSha256: objectHash(scan), predecessorSha256: null, author,
    inventory: {items, unitDispositions: sourceView.units.map((unit, index) => ({unitId: unit.id, itemIds: [items[index].id], reason: 'Synthetic source unit individually inventoried'})), diagnosticDispositions: scan.diagnostics.map(value => ({diagnosticId: value.id, resolved: true, reason: 'Synthetic diagnostic explicitly inspected; no scientific content inferred'})), complete: true},
    assessments: items.map(item => ({obligationId: item.obligations[0].id, status: 'accepted', outcome: 'supported', summary: 'Synthetic supported obligation', limitations: ['Fixture only, not a scientific claim'], basisItemHashes: {}, evidence: [{kind: 'new', method: 'analytic_derivation', artifacts: [artifact], mapping: {scope: 'Exact synthetic item', conditions: 'Identical synthetic conditions', dependencyCompatibility: 'Explicit synthetic dependencies checked'}}]}))};
  return refreshBasis(candidate);
}

function reviewFor(f, scan, sourceView, candidate, {reviewer = 'synthetic-reviewer-c001'} = {}) {
  const evidence = f.put(cleanRelative + `/coverage_verifications/origin/c${String(candidate.revision).padStart(3, '0')}/independent.txt`, 'Independent synthetic derivation checked from source. Fixture only.');
  return {schemaVersion: 2, sourceBinding: f.sourceBinding, paperId: 'origin', revision: candidate.revision, scanSha256: objectHash(scan), candidateSha256: objectHash(candidate), reviewerAgent: reviewer,
    inventory: {complete: candidate.inventory.complete, resourceIds: sourceView.resources.map(resource => resource.id), checkedAllUnits: true, missingItems: [], notes: 'All synthetic academic resources, units and omitted regions checked', unitExclusions: candidate.inventory.unitDispositions.filter(value => !value.itemIds.length && sourceView.units.find(unit => unit.id === value.unitId).kind !== 'text_block').map(value => ({unitId: value.unitId, reason: 'Independently checked synthetic exclusion'}))},
    entries: candidate.assessments.map(assessment => ({obligationId: assessment.obligationId, assessmentSha256: objectHash(assessment), verdict: assessment.status === 'accepted' ? 'accept' : 'needs_work', reason: 'Independent synthetic scope assessment', evidence: [evidence]})), retainedObligationIds: []};
}

function decisionFor(f, scan, candidate, review) {
  return {schemaVersion: 2, sourceBinding: f.sourceBinding, paperId: 'origin', revision: candidate.revision, scanSha256: objectHash(scan), candidateSha256: objectHash(candidate), reviewSha256: objectHash(review), decision: 'accept_snapshot', acceptedObligationIds: candidate.assessments.filter(value => value.status === 'accepted').map(value => value.obligationId), inventoryAccepted: candidate.inventory.complete && review.inventory.complete, supervisor: 'synthetic-supervisor', rationale: 'Accept only independently checked synthetic obligations'};
}

async function scenario(t) {
  const f = fixture(t);
  const scan = await core.makeScan({root: f.project, paperId: 'origin', reading: f.view, firstPass: f.firstPass});
  const baseScan = f.put(campaignRelative + '/coverage/origin/scan.json', core.canonical(scan));
  const start = f.latexText.indexOf(f.includeText);
  const binding = {schemaVersion: 1, protocol: 'source-supplement-v1', paperId: 'origin', baseScan,
    edition: Object.fromEntries(['version','release','indexSha256','recordSha256'].map(key => [key, f.view.edition[key]])),
    index: f.index, record: f.recordRef, includingResource: f.view.primary,
    include: {command: 'lstinputlisting', start, end: start + f.includeText.length, excerptSha256: hash(f.includeText), literalTarget: 'algorithm1.m'},
    supplement: {path: f.base + '/' + f.listing.path, sha256: f.listing.sha256}, supplementBytes: f.listing.bytes, kind: 'utf8_listing'};
  f.sourceBinding = f.put(campaignRelative + '/coverage/origin/c001/source-binding.json', core.canonical(binding));
  const sourceView = resolveSourceView({root: f.project, scan, sourceBinding: f.sourceBinding});
  const candidate = candidateFor(f, scan, sourceView), review = reviewFor(f, scan, sourceView, candidate), decision = decisionFor(f, scan, candidate, review);
  const validate = (value = candidate, previous = null) => core.validateCandidate({root: f.project, scan, scanSha256: objectHash(scan), candidate: value, previous});
  const validateReview = (value = review, proposed = candidate, previous = null, identities = {}) => core.validateReview({root: f.project, scan, candidate: proposed, candidateSha256: objectHash(proposed), review: value, reviewer: value.reviewerAgent, worker: proposed.author, previous, ...identities});
  return {...f, scan, binding, sourceView, candidate, review, decision, validate, validateReview};
}
function scoped(f) {
  const {candidate, scan, sourceView} = f;
  const cards = candidate.inventory.items.map(item => {
    const loc = item.locators[0], unit = sourceView.units.find(u => u.id === loc.unitId), resource = sourceView.resources.find(r => r.id === unit.resourceId);
    const aid = item.id + ':a01', cid = item.id + ':claim01';
    const anchor = {id: aid, resourceId: resource.id, resourceSha256: resource.sha256, unitId: unit.id};
    if (resource.type === 'text') Object.assign(anchor, {start: loc.start, end: loc.end, excerptSha256: loc.excerptSha256, quote: fs.readFileSync(resource.path, 'utf8').slice(loc.start, loc.end)});
    else anchor.semantic = loc.semantic;
    return {itemId: item.id, itemSha256: objectHash(item), anchors: [anchor], claims: [{id: cid, anchorIds: [aid],
      statement: 'Synthetic source assertion', kind: resource.type === 'text' ? 'analytic' : 'visual_observation',
      modality: 'asserted', quantifier: 'all synthetic inputs', conditions: ['Synthetic domain only'],
      empiricalTarget: {kind: 'not_empirical', description: 'Synthetic structural fixture', identityRequirements: []}}]};
  });
  const contract = {schemaVersion: 2, sourceBinding: f.sourceBinding, paperId: 'origin', revision: 1,
    scanSha256: objectHash(scan), candidateSha256: objectHash(candidate), author: candidate.author,
    inventory: {complete: true, missingClaims: [], notes: 'All synthetic units are explicitly covered'},
    cards, alignments: candidate.inventory.items.map(item => {
      const obligation = item.obligations[0], assessment = candidate.assessments.find(a => a.obligationId === obligation.id);
      return {obligationId: obligation.id, obligationSha256: objectHash(obligation), assessmentSha256: objectHash(assessment),
        claimIds: [item.id + ':claim01'], relation: 'original', additionalAssumptions: [], assessedTarget: 'not_empirical',
        reason: 'Exact synthetic source scope'};
    }), legacyRetainedObligationIds: []};
  const check = () => validateCandidateScope({root: f.project, scan, candidate, candidateSha256: objectHash(candidate), contract, author: candidate.author});
  return {contract, check};
}
test('schema2 accepts real supplementary UTF-16 locators and preserves frozen base scan bytes', async t => {
  const f = await scenario(t), before = core.canonical(f.scan), result = await f.validate();
  assert.equal(result.valid, true);
  assert.equal(f.sourceView.unit.kind, 'source_code');
  assert.equal(f.sourceView.additionalUnits.length, 1);
  assert.equal(f.candidate.scanSha256, objectHash(f.scan));
  assert.notEqual(f.candidate.scanSha256, objectHash({resources: f.sourceView.resources, units: f.sourceView.units}));
  assert.equal(core.canonical(f.scan), before);
  assert.ok(!f.scan.resources.some(r => r.path.endsWith('algorithm1.m')));
  const loc = resolveLocators({root: f.project, scan: f.scan, sourceBinding: f.sourceBinding, locator: {path: f.binding.supplement.path, quote: 'synthetic_value = 1;'}});
  assert.equal(loc[0].unitId, f.sourceView.unit.id);
  assert.equal(loc[0].start, 0);
  assert.equal((await f.validateReview()).valid, true);
  assert.equal(core.assessCoverage({root: f.project, scan: f.scan, candidate: f.candidate, review: f.review, decision: f.decision}).coverageComplete, true);
  assert.equal(scoped(f).check().valid, true);
});
test('missing supplementary unit, unknown locator, bad excerpt, forged effective scan all fail', async t => {
  const f = await scenario(t);
  const missing = clone(f.candidate); missing.inventory.unitDispositions = missing.inventory.unitDispositions.filter(d => d.unitId !== f.sourceView.unit.id);
  await assert.rejects(f.validate(missing), /unit dispositions/);
  const unknown = clone(f.candidate); unknown.inventory.items.at(-1).locators[0].unitId = 'not-a-source-unit';
  await assert.rejects(f.validate(unknown), /unknown unit/);
  const bad = clone(f.candidate); bad.inventory.items.at(-1).locators[0].excerptSha256 = '0'.repeat(64);
  await assert.rejects(f.validate(bad), /excerpt hash/);
  const forged = {...f.scan, resources: f.sourceView.resources, units: f.sourceView.units};
  await assert.rejects(core.validateCandidate({root: f.project, scan: forged, scanSha256: objectHash(forged), candidate: {...f.candidate, scanSha256: objectHash(forged)}}), /no longer matches/);
  const review = clone(f.review); review.inventory.resourceIds.pop();
  await assert.rejects(f.validateReview(review), /review resources/);
});
test('new schema and exact source binding are mandatory across candidate review decision and scopes', async t => {
  const f = await scenario(t);
  const missing = clone(f.candidate); delete missing.sourceBinding;
  await assert.rejects(f.validate(missing), /sourceBinding/);
  await assert.rejects(f.validate({...f.candidate, schemaVersion: 1}), /identity/);
  const other = f.put(campaignRelative + '/coverage/origin/c001/other-binding.json', core.canonical(f.binding));
  const review = {...f.review, sourceBinding: other};
  await assert.rejects(f.validateReview(review), /source binding/);
  assert.throws(() => core.assessCoverage({root: f.project, scan: f.scan, candidate: f.candidate, review: f.review, decision: {...f.decision, sourceBinding: other}}), /source binding/);
  const {contract, check} = scoped(f); contract.sourceBinding = other; assert.throws(check, /source binding/);
  const next = clone(f.candidate); next.revision = 2; next.predecessorSha256 = objectHash(f.candidate); next.sourceBinding = other;
  await assert.rejects(f.validate(next, {candidate: f.candidate, sha256: objectHash(f.candidate), review: f.review, decision: f.decision}), /source binding/);
});
test('receipt admits only exact supplementary input, not a sibling file or source as evidence output', async t => {
  const f = await scenario(t), candidate = clone(f.candidate);
  const item = candidate.inventory.items.at(-1), assessment = candidate.assessments.at(-1);
  item.obligations[0].kind = 'algorithm'; item.obligations[0].dimension = 'algorithmValidation';
  const script = f.put(cleanRelative + '/coverage_work/origin/c001/test-script.txt', 'Synthetic test metadata, not an executed research claim');
  const output = f.put(cleanRelative + '/coverage_work/origin/c001/test-output.txt', 'Synthetic output fixture');
  const receiptObject = {schemaVersion: 1, paperId: 'origin', tool: 'synthetic-only', version: '1', command: ['synthetic-fixture'],
    workerCount: 1, startedAt: '2026-10-29T00:00:00Z', finishedAt: '2026-10-29T00:00:01Z', exitCode: 0,
    inputs: [script, f.binding.supplement], outputs: [output]};
  const receipt = f.put(cleanRelative + '/coverage_work/origin/c001/receipt.json', receiptObject);
  assessment.evidence = [{kind: 'new', method: 'implementation_test', artifacts: [output], mapping: {scope: 'Synthetic', conditions: 'Synthetic', dependencyCompatibility: 'Synthetic'}, execution: {receipt}}];
  refreshBasis(candidate); assert.equal((await f.validate(candidate)).valid, true);
  const sibling = f.put('reconstructed_sources/other/algorithm1.m', f.listingText);
  const badReceipt = f.put(cleanRelative + '/coverage_work/origin/c001/bad-receipt.json', {...receiptObject, inputs: [script, sibling]});
  const bad = clone(candidate); bad.assessments.at(-1).evidence[0].execution.receipt = badReceipt;
  await assert.rejects(f.validate(bad), /outside the same-paper source/);
  const direct = clone(candidate); direct.assessments.at(-1).evidence[0].artifacts = [f.binding.supplement];
  await assert.rejects(f.validate(direct), /outside the paper coverage roots/);
});
test('scientific method, independent review, source quote and original-target gates are unchanged', async t => {
  const f = await scenario(t), bad = clone(f.candidate);
  bad.inventory.items.at(-1).obligations[0].kind = 'empirical'; refreshBasis(bad);
  await assert.rejects(f.validate(bad), /evidence method cannot support/);
  await assert.rejects(f.validateReview({...f.review, reviewerAgent: f.candidate.author}), /review identity/);
  const own = clone(f.review); own.entries[0].evidence = f.candidate.assessments[0].evidence[0].artifacts;
  await assert.rejects(f.validateReview(own), /independent coverage evidence/);
  const scopedCase = scoped(f); scopedCase.contract.cards.at(-1).anchors[0].quote = 'unrelated synthetic text';
  assert.throws(scopedCase.check, /quote/);
  const narrowing = scoped(f); narrowing.contract.alignments.at(-1).additionalAssumptions = ['one chosen input only'];
  assert.ok(narrowing.check().blockedObligationIds.includes(f.candidate.assessments.at(-1).obligationId));
});
test('authoring assembles union locators and review inventory without hashing the effective view as a scan', async t => {
  const f = await scenario(t);
  const spec = {schemaVersion: 2, sourceBinding: f.sourceBinding, author: f.candidate.author,
    inventory: {complete: true, items: clone(f.candidate.inventory.items), unitRules: [], diagnosticDispositions: clone(f.candidate.inventory.diagnosticDispositions)},
    assessments: f.candidate.assessments.map(({basisItemHashes, ...value}) => value), retainObligationIds: []};
  spec.inventory.items.at(-1).locators = [{path: f.binding.supplement.path, quote: f.listingText}];
  const assembled = await assembleCandidate({root: f.project, scan: f.scan, scanSha256: objectHash(f.scan), spec});
  assert.equal(assembled.candidate.scanSha256, objectHash(f.scan));
  const reviewSpec = {schemaVersion: 2, sourceBinding: f.sourceBinding,
    inventory: Object.fromEntries(Object.entries(f.review.inventory).filter(([key]) => key !== 'resourceIds')),
    entries: f.review.entries.map(({assessmentSha256, ...entry}) => entry), retainedObligationIds: []};
  const review = await assembleReview({root: f.project, scan: f.scan, candidate: assembled.candidate, candidateSha256: objectHash(assembled.candidate),
    spec: reviewSpec, reviewer: f.review.reviewerAgent, worker: assembled.candidate.author});
  assert.ok(review.review.inventory.resourceIds.includes(f.sourceView.resource.id));
  assert.equal(review.review.scanSha256, objectHash(f.scan));
});

test('independent schema2 scope review binds supplementary quotes and rejects mixed bindings', async t => {
  const f = await scenario(t), {contract} = scoped(f), evidence = f.review.entries[0].evidence;
  const scopeReview = {schemaVersion: 2, sourceBinding: f.sourceBinding, paperId: 'origin', revision: 1,
    scanSha256: objectHash(f.scan), candidateSha256: objectHash(f.candidate), contractSha256: objectHash(contract), reviewSha256: objectHash(f.review), reviewerAgent: f.review.reviewerAgent,
    inventory: {complete: true, checkedUnlistedSource: true, missingClaims: [], notes: 'Independent synthetic complete-source check', evidence},
    cards: contract.cards.map(card => ({itemId: card.itemId, cardSha256: objectHash(card), verdict: 'aligned', reason: 'Synthetic independent scope check', evidence})),
    entries: contract.alignments.map(alignment => ({obligationId: alignment.obligationId, alignmentSha256: objectHash(alignment), verdict: 'aligned', reason: 'Synthetic original target independently checked', evidence})),
    retainedItemIds: [], retainedObligationIds: []};
  const check = () => validateReviewScope({root: f.project, scan: f.scan, candidate: f.candidate, candidateSha256: objectHash(f.candidate), contract,
    contractSha256: objectHash(contract), review: f.review, scopeReview, reviewer: f.review.reviewerAgent, worker: f.candidate.author});
  assert.equal(check().inventoryEligible, true);
  assert.equal(check().eligibleObligationIds.length, f.candidate.assessments.length);
  scopeReview.sourceBinding = f.put(campaignRelative + '/coverage/origin/c001/alternate-binding.json', core.canonical(f.binding));
  assert.throws(check, /source binding/);
});

const canonical = core.canonical;
const worker='synthetic-source-worker', supervisor='synthetic-supervisor';
const protocolBase=campaignRelative+'/protocols/source-binding-v1';
const releaseBase=campaignRelative+'/architecture/source-supplement-20261029';
const moduleNames=['coverage.mjs','coverage-guard.mjs','coverage-recovery.mjs','source-admission.mjs','source-binding.mjs','coverage-core.mjs','coverage-scope.mjs','coverage-context.mjs','coverage-reader.mjs','coverage-authoring.mjs','coverage-kit.mjs','coverage-batch.mjs','coverage-review-parts.mjs'];
const absolute=(f,ref)=>path.resolve(f.project,ref.path);
function legacyRelease(f){
 copyModuleClosure(f.project,campaignRelative+'/coverage-batch.mjs');
 const oldBase=campaignRelative+'/architecture/batch-scope-20261029';
 f.put(campaignRelative+'/COVERAGE_GUARDS.md','Synthetic source-scope guard guide.');
 for(const name of ['BATCH_API.md','SCOPE_API.md'])f.put(oldBase+'/'+name,'Synthetic neutral guide.');
 const modules=['coverage.mjs','coverage-guard.mjs','coverage-scope.mjs','coverage-batch.mjs','COVERAGE_GUARDS.md','BATCH_API.md','SCOPE_API.md'].map(name=>{
  const installedName=(['BATCH_API.md','SCOPE_API.md'].includes(name)?oldBase:campaignRelative)+'/'+name;
  const file=path.join(f.project,installedName),installed={path:installedName,sha256:digest(file)};
  return {name,installed,frozen:f.put(oldBase+'/release/'+name,fs.readFileSync(file))};
 });
 f.put(oldBase+'/release-manifest.json',{schemaVersion:1,releaseId:'batch-scope-20261029',modules});
}
function enrolledReaderFixture(t,{adopt=true}={}){
 const legacy=installCoverage(fixture(t));copyModuleClosure(legacy.project,protocolBase+'/coverage.mjs');
 // Also ship adapter modules not directly imported by the CLI.
 for(const name of moduleNames)copyModuleClosure(legacy.project,protocolBase+'/'+name);
 legacyRelease(legacy);
 legacy.invoke('init');legacy.command('guard-policy',{supervisor,reason:'Synthetic guard activation.'});
 legacy.command('prepare');legacy.command('assign',{role:'worker',agent:worker,freshContext:true,historyInherited:false});
 const scan=read(legacy.paper().scan.path),reading=scan.reading,main=fs.readFileSync(reading.primary.path,'utf8');
 const literal='\\lstinputlisting{algorithm1.m}',start=main.indexOf(literal);
 assert.ok(start>=0);
 const supplementPath=path.join(path.dirname(reading.primary.path),'algorithm1.m');
 const binding={schemaVersion:1,protocol:'source-supplement-v1',paperId:'origin',baseScan:legacy.paper().scan,
  edition:Object.fromEntries(['version','release','indexSha256','recordSha256'].map(key=>[key,reading.edition[key]])),
  index:{path:'reconstructed_sources/'+reading.edition.release+'/index.json',sha256:reading.edition.indexSha256},
  record:{path:reading.edition.recordPath,sha256:reading.edition.recordSha256},includingResource:reading.primary,
  include:{command:'lstinputlisting',start,end:start+literal.length,excerptSha256:hash(literal),literalTarget:'algorithm1.m'},
  supplement:{path:supplementPath,sha256:digest(supplementPath)},supplementBytes:fs.statSync(supplementPath).size,kind:'utf8_listing'};
 const proposedBinding=legacy.put(releaseBase+'/proposed-binding.json',canonical(binding));
 const modules=moduleNames.map(name=>{const installed={path:protocolBase+'/'+name,sha256:digest(path.join(legacy.project,protocolBase,name))};return {name,installed,frozen:legacy.put(releaseBase+'/release/'+name,fs.readFileSync(absolute(legacy,installed)))};});
 const releaseManifest=legacy.put(releaseBase+'/release-manifest.json',{schemaVersion:1,releaseId:'source-supplement-20261029',protocol:'source-supplement-v1',
  repairScope:{paperId:'origin',iteration:1,baseScan:legacy.paper().scan,sourceBindingSha256:objectHash(binding)},modules});
 const paper=legacy.paper(),draft=legacy.put(paper.workRoot+'/original-draft.txt','Original actor draft retained without relabeling.');
 const oldDrafts=['candidate.json','source-scope.json','terminal.json'].map(name=>legacy.put(paper.workRoot+'/'+name,{legacyDraft:name,actor:worker}));
 const checkpoint={schemaVersion:1,status:'source_adoption_safe_checkpoint',paperId:'origin',revision:1,agent:worker,role:'worker',
  scan:paper.scan,order:paper.order,guardEnrollment:paper.guardEnrollment,noActiveCalculation:true,noConcurrentReadWrite:true,
  preservedDrafts:[draft,...oldDrafts],checkpointedAt:'2026-10-29T00:00:00Z'};
 const ownerCheckpoint=legacy.put(paper.workRoot+'/source-adoption-checkpoint.json',checkpoint);
 const adoptFields={schemaVersion:1,paperId:'origin',iteration:1,agent:worker,supervisor,reason:'Exact synthetic omitted listing repair.',
  scan:paper.scan,order:paper.order,guardEnrollment:paper.guardEnrollment,sourceBinding:proposedBinding,releaseManifest,ownerCheckpoint};
 const invoke=(command,request=null,ok=true)=>legacy.execute(protocolBase+'/coverage.mjs',[command,...(request?[request.path]:[])],ok);
 const command=(name,fields={},ok=true)=>{const request=legacy.request(fields);return {...invoke(name,request,ok),request};};
 const f={...legacy,invokeLegacy:legacy.invoke,commandLegacy:legacy.command,invoke,command,scan,binding,proposedBinding,releaseManifest,checkpoint,ownerCheckpoint,adoptFields,draft,oldDrafts};
 if(adopt){f.adoption=command('source-adopt',adoptFields);const view=resolveSourceView({root:f.project,scan,sourceBinding:f.paper().sourceEnrollment.sourceBinding});f.sourceView={...scan,resources:view.resources,units:view.units,diagnostics:view.diagnostics};}
 return f;
}
/** One content read is corrupted in memory; every file on disk remains sealed.
 * Match the immediate caller so preflight/recheck reads still see correct bytes. */
async function rejectCorruptActualRead(target, callerMatch, operation) {
  const originalRead = fs.readFileSync, expected = originalRead(target), expectedSha = hash(expected);
  let injected = 0;
  fs.readFileSync = function(filename, ...options) {
    const result = originalRead.call(this, filename, ...options);
    const caller = new Error().stack.split('\n')[2] ?? '';
    if (!injected && typeof filename === 'string' && path.resolve(filename).toLowerCase() === path.resolve(target).toLowerCase() && callerMatch(caller)) {
      injected++;
      return typeof result === 'string' ? 'CORRUPTED_ACTUAL_READ' : Buffer.from('CORRUPTED_ACTUAL_READ');
    }
    return result;
  };
  try {
    await assert.rejects(async () => operation(), /actual (?:source|resource|read) bytes hash mismatch/);
  } finally { fs.readFileSync = originalRead; }
  assert.equal(injected, 1, 'The precise content read must be exercised');
  assert.equal(hash(originalRead(target)), expectedSha, 'Disk bytes were never changed');
}
test('actual source bytes are checked in core scope authoring and context despite correct later disk rechecks', async t => {
  const f = await scenario(t), target = absolute(f, f.binding.supplement), scope = scoped(f);
  await rejectCorruptActualRead(target, caller => caller.includes('textBytes') && caller.includes('coverage-core.mjs'), () => f.validate());
  await rejectCorruptActualRead(target, caller => caller.includes('coverage-scope.mjs'), () => scope.check());
  await rejectCorruptActualRead(target, caller => caller.includes('coverage-authoring.mjs'), () => resolveLocators({
    root: f.project, scan: f.scan, sourceBinding: f.sourceBinding, locator: {path: f.binding.supplement.path, quote: 'synthetic_value = 1;'}}));
  await rejectCorruptActualRead(target, caller => caller.includes('unitsFor') && caller.includes('coverage-context.mjs'), () => unitsFor({
    root: f.project, paper: {paperId: 'origin'}, sourceView: f.sourceView}, f.sourceView.resource.id));
  await rejectCorruptActualRead(absolute(f, f.binding.baseScan), caller => caller.includes('readBoundText'), () => boundContext(f.project, f.binding.baseScan));
  const originalRecheck = f.sourceView.recheck; let checked = 0;
  f.sourceView.recheck = () => { checked++; return originalRecheck(); };
  assert.equal(unitsFor({root: f.project, paper: {paperId: 'origin'}, sourceView: f.sourceView}, f.sourceView.resource.id).units.length, 1);
  assert.equal(checked, 1, 'Context rechecks its source view immediately before returning');
});
test('reader refuses corrupted returned raw bytes although immutable source and all later reads remain correct', async t => {
  const f = enrolledReaderFixture(t), opened = await runReader(f.project, ['open', 'origin', 'worker']);
  const view = resolveSourceView({root: f.project, scan: f.scan, sourceBinding: f.paper().sourceEnrollment.sourceBinding});
  const argv = ['read', 'origin', 'worker', opened.snapshotKey, 'resources', view.resource.id, '0', '100'];
  await rejectCorruptActualRead(absolute(f, f.binding.supplement), caller => caller.includes('runReader') && caller.includes('coverage-reader.mjs'),
    () => runReader(f.project, argv));
  const result = await runReader(f.project, argv);
  assert.equal(result.chunk, fs.readFileSync(absolute(f, f.binding.supplement), 'utf8'));
  assert.equal(result.sha256, f.binding.supplement.sha256);
});
