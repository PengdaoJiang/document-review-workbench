// Synthetic-only, disjoint temporary project. No production ledger or scientific
// material is read. All subprocesses use one logical worker and no vendor tools.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {canonical, hash, fileRef} from '../../../coverage-core.mjs';
import {APPEND_MODULES, APPEND_UPSTREAM, APPEND_RELEASE, APPEND_PROTOCOL} from '../../../protocols/guard-append-v1/append-core.mjs';
import {fixture, installCoverage, copyModuleClosure, refreshBasis, decisionFor, objectHash,
  read, clone, digest, campaignRelative as base, cleanRelative as clean} from '../context-kit/fixture.mjs';

export const paperIds = ['r0186', 'r0187'];
export const supervisor = 'synthetic-supervisor';
export const workerFor = id => '/root/cov_' + id + '_c002_worker';
export const reviewerFor = (id, revision) => 'synthetic-independent-' + id + '-c' + revision;
export const protocolRelative = APPEND_PROTOCOL;
export const diagnosticRelative = base + '/coverage/requests/architecture-diagnostic-r0186-r0187-c002-append-20261105.json';
export const authorizationRelative = base + '/coverage/requests/architecture-coordination-r0186-r0187-c002-20261105.json';
export const absolute = (f, ref) => path.resolve(f.project, ref.path);

function addSyntheticPapers(f) {
  const release = 'reconstructed_sources/dot-20261023', index = read(path.join(f.project, release, 'index.json'));
  const locations = read(path.join(f.project, 'sources/source-locations.json'));
  const sourceManifest = read(path.join(f.project, 'output/model_clean/manifest.json'));
  for (const id of paperIds) {
    const source = f.put('sources/original_pdfs/' + id + '.pdf', 'Synthetic bytes for ' + id + '; not an academic PDF.');
    const member = (name, value) => ({...f.put(release + '/' + name, value), path: name});
    const latex = member('papers/' + id + '/source/main.tex', 'Synthetic identity $x=x$.\n\nEvery real x satisfies reflexivity.\n\\[x-x=0\\]\n');
    const body = member('papers/' + id + '/source/body.tex', 'Synthetic appendix identity \\(y=y\\).\n');
    const figure = member('papers/' + id + '/source/fig.png', 'Synthetic image placeholder, not a scientific figure.');
    const mapping = member('papers/' + id + '/source/map.json', {fixtureOnly: true});
    const archive = member('archives/' + id + '.zip', 'Synthetic archive ' + id), version = 'dot-' + archive.sha256;
    const record = f.put(release + '/papers/' + id + '/record.json', {schemaVersion: 1, provider: 'dot', paperId: id, version,
      status: 'user_selected_dot_reconstruction', source: {sha256: source.sha256}, archive,
      files: {latex, latexEntries: [latex], dependencies: [body], assets: [figure], mapping, all: [latex, body, figure, mapping]}});
    index.papers.push({paperId: id, version, record: 'papers/' + id + '/record.json', recordSha256: record.sha256});
    locations.files.push({id, filename: id + '.pdf', sha256: source.sha256});
    const row = sourceManifest.items.find(value => value.record_number === Number(id.slice(1)));
    Object.assign(row, {source_file: id + '.pdf', source_sha256: source.sha256, clean_pdf_sha256: source.sha256});
    f.put('output/latex/preservation/' + id + '/mapping.json', {record_number: Number(id.slice(1)), source_file: id + '.pdf',
      reference_pdf: {sha256: source.sha256}, excluded_visible_elements: []});
  }
  f.put('sources/source-locations.json', locations); f.put('output/model_clean/manifest.json', sourceManifest);
  const indexRef = f.put(release + '/index.json', index);
  f.put('reconstructed_sources/current.json', {schemaVersion: 1, provider: 'dot', release: 'dot-20261023', index: indexRef.path, indexSha256: indexRef.sha256});
  const ids = ['origin', ...Array.from({length: 50}, (_, i) => 'r' + String(i + 1).padStart(4, '0')), ...paperIds];
  const nodes = f.put('synthetic-authority/nodes.json', ids.map(paper_id => ({paper_id})));
  const authority = read(absolute(f, f.authority));
  authority.scope.paperIds = ids; authority.scope.nodes = nodes;
  authority.reading.indexSha256 = indexRef.sha256;
  f.authority = f.put(f.authority.path, authority); f.paperIds = ids;
  const firstPassById = {};
  for (const id of paperIds) {
    f.runtime('handoff', id); const view = f.runtime('verify-reading', id), version = view.edition.version;
    const contract = {schemaVersion: 1, paperId: id, inputSha256: view.originalPacket.sha256, sourceSha256: view.original.sourceSha256 ?? view.original.sha256,
      claimInventory: {status: 'partial', basis: 'One synthetic identity only'},
      claims: [{claimId: id + ':c0001', kind: 'author_claim', statement: 'Synthetic identity x=x',
        sourceLocations: [{dot: {version, path: view.primary.path, sha256: view.primary.sha256}, excerpt: 'x=x'}],
        sourceConditions: ['x is real'], implementationAssumptions: [], nativeUnits: 'dimensionless', conventions: 'real arithmetic',
        unknowns: [], successCriteria: ['Identity holds']}]};
    // The source ref is the source resolver's frozen original, not an inferred
    // authority from an arbitrary package descriptor.
    contract.sourceSha256 = digest(path.join(f.project, 'sources/original_pdfs/' + id + '.pdf'));
    f.put(clean + '/papers/' + id + '/contract.json', contract);
    f.put(clean + '/papers/' + id + '/entry.cjs', "require('node:fs').writeFileSync('answer.json',JSON.stringify({fixtureOnly:true,answer:1}));");
    f.put(clean + '/papers/' + id + '/plan.json', {runId: 'synthetic-run', workerCount: 1, config: {fixtureOnly: true}, environment: {fixtureOnly: true},
      freshContext: {contextId: 'synthetic-first-pass-' + id, historyInherited: false, declaredBy: 'test'},
      chunks: [{id: 'one', executable: process.execPath, args: ['${SOURCE}/entry.cjs']}]});
    const run = f.runtime('new-run', id, 'plan.json'), output = f.runtime('chunk', id, 'synthetic-run', 'one');
    f.runtime('finish', id, 'synthetic-run');
    const answer = path.join(path.dirname(output.receiptPath), 'work/answer.json');
    const result = {schemaVersion: 1, paperId: id, resultId: 'synthetic-first-pass', phase: 'first_pass', inputSha256: view.originalPacket.sha256,
      contractSha256: digest(path.join(run.runDir, 'source/contract.json')), contract,
      runBindings: [{runId: 'synthetic-run', runSha256: digest(path.join(run.runDir, 'run.json'))}],
      claims: [{claimId: id + ':c0001', status: 'partial', conclusion: 'Synthetic numeric sample only', testedScope: 'One synthetic sample',
        limitations: ['Fixture only'], evidence: [{role: 'numeric', runId: 'synthetic-run', path: path.relative(run.runDir, answer).replaceAll('\\', '/'),
          sha256: digest(answer), description: 'Synthetic output'}]}],
      assessment: {by: 'synthetic-worker', at: '2026-10-24T00:00:00Z', basis: 'Fixture only'}, supersedes: []};
    f.put(clean + '/drafts/' + id + '/result.json', result);
    const published = f.runtime('publish-result', id, 'result.json');
    const review = f.put(clean + '/verifications/' + id + '/a001/review.json', {schemaVersion: 1, paperId: id, reviewerAgent: 'synthetic-first-reviewer',
      recommendation: 'accept_bounded', bindings: {result: published}, independentChecks: [{id: 'fixture-check', evidence: [{path: answer, sha256: digest(answer)}]}]});
    const acceptance = f.put(base + '/receipts/' + id + '/a001-supervisor.json', {schemaVersion: 1, paperId: id, decision: 'accept_bounded',
      candidateResultSha256: published.sha256, reviewSha256: review.sha256});
    firstPassById[id] = {result: {path: published.path, sha256: published.sha256}, review, acceptance};
  }
  return firstPassById;
}

function installGuard(f) {
  const release = base + '/architecture/batch-scope-20261029';
  for (const name of ['coverage-guard.mjs', 'coverage-scope.mjs', 'coverage-batch.mjs']) copyModuleClosure(f.project, base + '/' + name);
  f.put(base + '/COVERAGE_GUARDS.md', 'Synthetic immutable scope guard guide. Not scientific acceptance.');
  for (const name of ['BATCH_API.md', 'SCOPE_API.md']) f.put(release + '/' + name, 'Synthetic immutable ' + name);
  const modules = ['coverage.mjs', 'coverage-guard.mjs', 'coverage-scope.mjs', 'coverage-batch.mjs', 'COVERAGE_GUARDS.md', 'BATCH_API.md', 'SCOPE_API.md'].map(name => {
    const installed = fileRef(f.project, (['BATCH_API.md', 'SCOPE_API.md'].includes(name) ? release : base) + '/' + name);
    return {name, installed, frozen: f.put(release + '/release/' + name, fs.readFileSync(installed.path))};
  });
  f.put(release + '/release-manifest.json', {schemaVersion: 1, releaseId: 'batch-scope-20261029', modules});
}

function candidateFor(f, id, scan) {
  const artifact = f.put(clean + '/coverage_work/' + id + '/c001/derivation.txt', 'Synthetic reflexivity derivation; no real scientific claim.');
  const items = scan.units.map((unit, i) => {
    const itemId = id + ':i' + String(i === 0 ? 35 : i === 1 ? 73 : 100 + i).padStart(4, '0');
    return {id: itemId, kind: ['inline_math', 'display_math', 'math_environment'].includes(unit.kind) ? 'formula' : 'statement', text: 'Synthetic source item ' + i,
      locators: [unit.start === null ? {unitId: unit.id, semantic: 'Entire synthetic asset'} : {unitId: unit.id, start: unit.start, end: unit.end, excerptSha256: unit.excerptSha256}],
      conditions: ['Synthetic domain only'], units: 'dimensionless', dependencies: [], obligations: [{id: itemId + ':o01',
        dimension: i < 2 ? 'algorithmValidation' : 'statementValidation', kind: i < 2 ? 'algorithm' : 'analytic', statement: 'Check synthetic identity',
        conditions: ['Synthetic domain only'], successCriterion: 'Directly inspectable synthetic verification'}]};
  });
  const candidate = {schemaVersion: 1, paperId: id, revision: 1, scanSha256: objectHash(scan), predecessorSha256: null, author: workerFor(id),
    inventory: {complete: true, items, unitDispositions: scan.units.map((unit, i) => ({unitId: unit.id, itemIds: [items[i].id], reason: 'Synthetic source unit explicitly mapped'})),
      diagnosticDispositions: scan.diagnostics.map(row => ({diagnosticId: row.id, resolved: true, reason: 'Synthetic diagnostic explicitly checked'}))},
    assessments: items.map((item, i) => ({obligationId: item.obligations[0].id, status: i < 2 ? 'pending' : 'accepted', outcome: i < 2 ? 'partial' : 'supported',
      summary: 'Synthetic obligation only', limitations: ['Fixture only'], basisItemHashes: {}, evidence: i < 2 ? [] : [{kind: 'new', method: 'analytic_derivation', artifacts: [artifact],
        mapping: {scope: 'Exact synthetic item', conditions: 'Same synthetic domain', dependencyCompatibility: 'No synthetic dependency change'}}]}))};
  return refreshBasis(candidate);
}

export function scopeFor(f, candidate, scan, {legacy = []} = {}) {
  const cards = [], alignments = [];
  for (const item of candidate.inventory.items) {
    if (item.obligations.every(row => legacy.includes(row.id))) continue;
    const anchors = item.locators.map((locator, i) => {
      const unit = scan.units.find(row => row.id === locator.unitId), resource = scan.resources.find(row => row.id === unit.resourceId);
      return {id: item.id + ':a' + i, resourceId: resource.id, resourceSha256: resource.sha256, unitId: unit.id,
        ...(resource.type === 'text' ? {start: locator.start, end: locator.end, excerptSha256: locator.excerptSha256,
          quote: fs.readFileSync(resource.path, 'utf8').slice(locator.start, locator.end)} : {semantic: locator.semantic})};
    });
    const claimId = item.id + ':source';
    cards.push({itemId: item.id, itemSha256: objectHash(item), anchors, claims: [{id: claimId, anchorIds: anchors.map(row => row.id),
      statement: 'Synthetic source identity only.', kind: Object.hasOwn(anchors[0], 'quote') ? 'identity' : 'visual_observation', modality: 'Synthetic assertion',
      quantifier: 'Synthetic displayed identity', conditions: ['Synthetic domain only'],
      empiricalTarget: {kind: 'not_empirical', description: 'Synthetic source identity only', identityRequirements: []}}]});
    for (const obligation of item.obligations.filter(row => !legacy.includes(row.id))) alignments.push({obligationId: obligation.id,
      obligationSha256: objectHash(obligation), assessmentSha256: objectHash(candidate.assessments.find(row => row.obligationId === obligation.id)),
      claimIds: [claimId], relation: 'original', additionalAssumptions: [], assessedTarget: 'not_empirical', reason: 'Synthetic original target only.'});
  }
  return {schemaVersion: 1, paperId: candidate.paperId, revision: candidate.revision, scanSha256: objectHash(scan), candidateSha256: objectHash(candidate), author: candidate.author,
    inventory: {complete: true, missingClaims: [], notes: 'Synthetic full inventory only.'}, cards, alignments, legacyRetainedObligationIds: [...legacy]};
}

function reviewFor(f, candidate, scan, actor) {
  const evidence = f.put(clean + '/coverage_verifications/' + candidate.paperId + '/c' + String(candidate.revision).padStart(3, '0') + '/independent.txt', 'Independent synthetic review evidence.');
  return {schemaVersion: 1, paperId: candidate.paperId, revision: candidate.revision, scanSha256: objectHash(scan), candidateSha256: objectHash(candidate), reviewerAgent: actor,
    inventory: {complete: true, resourceIds: scan.resources.map(row => row.id), checkedAllUnits: true, missingItems: [], notes: 'All synthetic units independently inspected', unitExclusions: []},
    entries: candidate.assessments.map(row => ({obligationId: row.obligationId, assessmentSha256: objectHash(row), verdict: row.status === 'accepted' ? 'accept' : 'needs_work',
      reason: 'Independent synthetic obligation inspection', evidence: [evidence]})), retainedObligationIds: []};
}

export function scopeReviewFor(f, candidate, contract, review, scan) {
  const evidence = [f.put(f.paper(candidate.paperId).staged.reviewRoot + '/scope-independent.txt', 'Independent source-scope synthetic review evidence.')];
  return {schemaVersion: 1, paperId: candidate.paperId, revision: candidate.revision, scanSha256: objectHash(scan), candidateSha256: objectHash(candidate),
    contractSha256: objectHash(contract), reviewSha256: objectHash(review), reviewerAgent: review.reviewerAgent,
    inventory: {complete: true, checkedUnlistedSource: true, missingClaims: [], notes: 'Synthetic unlisted regions independently checked', evidence},
    cards: contract.cards.map(row => ({itemId: row.itemId, cardSha256: objectHash(row), verdict: 'aligned', reason: 'Independent synthetic source match', evidence})),
    entries: contract.alignments.map(row => ({obligationId: row.obligationId, alignmentSha256: objectHash(row), verdict: 'aligned', reason: 'Independent synthetic target match', evidence})),
    retainedItemIds: [], retainedObligationIds: []};
}

export function acceptThroughLegacy(f, id, {partial = false} = {}) {
  const candidate = read(absolute(f, f.paper(id).staged.candidate)), contract = read(absolute(f, f.paper(id).staged.guard.contract));
  const scan = read(absolute(f, f.paper(id).scan)), actor = reviewerFor(id, candidate.revision);
  f.legacyCommand('assign', id, {role: 'reviewer', agent: actor, freshContext: true, historyInherited: false});
  const review = reviewFor(f, candidate, scan, actor), scopeReview = scopeReviewFor(f, candidate, contract, review, scan);
  const delivery = f.put(f.paper(id).staged.reviewRoot + '/review.json', review); f.put(f.paper(id).staged.reviewRoot + '/scope-review.json', scopeReview);
  f.legacyCommand('review', id, {agent: actor, ownerFinished: true, reviewPath: delivery.path});
  const decision = {...decisionFor(scan, candidate, review), paperId: id}; if (partial) decision.acceptedObligationIds.pop();
  const decisionRef = f.put(base + '/coverage/requests/synthetic-decision-' + id + '-c' + candidate.revision + '.json', decision);
  f.legacyCommand('decide', id, {decisionPath: decisionRef.path});
  return {candidate, contract, review, scopeReview, decision};
}

export function files(root) {
  const values = {};
  function visit(relative = '') { for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
    const name = path.join(relative, entry.name); if (entry.isDirectory()) visit(name); else values[name] = digest(path.join(root, name));
  } }
  visit(); return values;
}

export function setup(t, {selectedPaper = 'r0186'} = {}) {
  const seed = fixture(t), firstPassById = addSyntheticPapers(seed);
  const firstPassBytes = Object.values(firstPassById).flatMap(row => Object.values(row)).map(ref => ({ref, bytes: fs.readFileSync(absolute(seed, ref))}));
  const f = installCoverage(seed);
  for (const {ref, bytes} of firstPassBytes) f.put(ref.path, bytes);
  const initialClosure = read(absolute(f, f.closure));
  for (const row of initialClosure.papers) if (firstPassById[row.paperId]) for (const field of ['result', 'review', 'acceptance']) row[field] = firstPassById[row.paperId][field];
  const closure = f.put(f.closure.path, initialClosure);
  f.put('docs/network3-coverage-authorization-20261024.json', {schemaVersion: 1, scopeAuthority: f.authority, firstPassClosure: closure, supervisor: {threadId: supervisor}});
  let serial = 0;
  const put = (name, value) => f.absolute(f.put(name, value));
  const paper = (id = selectedPaper) => f.state().papers.find(row => row.paperId === id);
  const legacyRequest = (id, fields) => put(base + '/coverage/requests/guard-append-legacy-' + (++serial) + '.json', {expectedRevision: f.state().revision, paperId: id, ...fields});
  const legacyInvoke = (command, argument = null, ok = true) => f.execute(base + '/coverage.mjs', [command, ...(argument ? [argument.path] : [])], ok);
  const legacyCommand = (command, id = selectedPaper, fields = {}, ok = true) => { const request = legacyRequest(id, fields); return {...legacyInvoke(command, request, ok), request}; };
  const result = {...f, put, paper, legacyInvoke, legacyCommand, selectedPaper, registrations: {}, inputs: {}, scans: {}};
  installGuard(result); legacyInvoke('init'); legacyCommand('guard-policy', selectedPaper, {supervisor, reason: 'Synthetic guarded c001 and c002.'});
  for (const id of paperIds) {
    legacyCommand('prepare', id); legacyCommand('assign', id, {role: 'worker', agent: workerFor(id), freshContext: true, historyInherited: false});
    const scan = read(absolute(result, paper(id).scan)), candidate = candidateFor(result, id, scan), contract = scopeFor(result, candidate, scan);
    const original = put(paper(id).workRoot + '/candidate.json', candidate); put(paper(id).workRoot + '/source-scope.json', contract);
    legacyCommand('intake', id, {agent: workerFor(id), ownerFinished: true, candidatePath: original.path});
    acceptThroughLegacy(result, id); assert.equal(paper(id).phase, 'assessed');
    legacyCommand('continue', id); legacyCommand('assign', id, {role: 'worker', agent: workerFor(id), freshContext: true, historyInherited: false});
    const registered = clone(paper(id)), source = clone(candidate);
    Object.assign(source, {revision: 2, predecessorSha256: registered.latest.candidate.sha256});
    const script = put(registered.workRoot + '/synthetic-check.mjs', 'export const fixtureOnly = true;');
    const output = put(registered.workRoot + '/synthetic-output.json', {fixtureOnly: true, exactIdentity: true});
    const receipt = put(registered.workRoot + '/synthetic-receipt.json', {schemaVersion: 1, paperId: id, tool: 'synthetic-fixture', version: '1',
      command: ['synthetic-no-real-science'], workerCount: 1, startedAt: '2026-11-05T00:00:00Z', finishedAt: '2026-11-05T00:00:01Z', exitCode: 0, inputs: [script], outputs: [output]});
    for (const [i, assessment] of source.assessments.slice(0, 2).entries()) {
      const mapping = {scope: 'Exact synthetic algorithm', conditions: 'Synthetic conditions only', dependencyCompatibility: 'No changed synthetic premises'};
      Object.assign(assessment, {status: 'accepted', outcome: 'supported', evidence: [
        ...Array.from({length: i + 1}, () => ({kind: 'new', method: 'source_consistency', artifacts: [output], mapping: clone(mapping)})),
        {kind: 'new', method: id === 'r0186' ? 'numeric_test' : 'implementation_test', artifacts: [output], execution: {receipt}, mapping}]});
    }
    const repaired = clone(source); if (id === 'r0186') for (const [i, assessment] of repaired.assessments.slice(0, 2).entries()) assessment.evidence[i + 1].method = 'implementation_test';
    const previous = read(absolute(result, registered.latest.decision)), originalScope = scopeFor(result, source, scan, {legacy: previous.acceptedObligationIds});
    const repairedScope = scopeFor(result, repaired, scan);
    if (id === 'r0186') repairedScope.inventory.notes += ' Append-only original-author repair v002 restores the 47 previously guarded accepted alignments and their exact c001 source cards; no already-guarded obligation is reclassified as exempt legacy credit. The 12 mixed-item unresolved originals remain unknown; only their claim references are reconciled to the restored cards. Restoration does not assert prior inventory acceptance or new scientific acceptance.';
    // Restored prior guarded cards/alignments are byte-for-byte objects from the
    // accepted c001 contract, not freshly invented lineage.
    const priorContract = read(absolute(result, registered.latest.guard.contract));
    const restoredCards = priorContract.cards.filter(row => candidate.inventory.items.find(item => item.id === row.itemId).obligations.every(o => previous.acceptedObligationIds.includes(o.id)));
    const restoredAlignments = priorContract.alignments.filter(row => previous.acceptedObligationIds.includes(row.obligationId));
    repairedScope.cards = [...originalScope.cards, ...clone(restoredCards)];
    repairedScope.alignments = [...repairedScope.alignments.filter(row => !previous.acceptedObligationIds.includes(row.obligationId)), ...clone(restoredAlignments)];
    result.registrations[id] = registered; result.scans[id] = scan;
    result.inputs[id] = {originalCandidate: source, originalScope, candidate: repaired, contract: repairedScope, restoredCards, restoredAlignments, script, output, receipt};
  }
  for (const name of APPEND_MODULES) copyModuleClosure(f.project, APPEND_PROTOCOL + '/' + name);
  const modules = APPEND_MODULES.map(name => { const installed = fileRef(f.project, APPEND_PROTOCOL + '/' + name); return {name, installed, frozen: put(APPEND_RELEASE + '/release/' + name, fs.readFileSync(installed.path))}; });
  const upstream = APPEND_UPSTREAM.map(name => ({name, ref: fileRef(f.project, name)}));
  result.releaseModules = modules; result.releaseUpstream = upstream;
  put(base + '/coverage/execution-control.json', {schemaVersion: 1, phase: 'active', pauseInForce: false, newAdmissions: true});
  // Sealing below is deliberately contained in this synthetic fixture. It never
  // changes an installed release or any production business object.
  result.seal = options => seal(result, options ?? {});
  Object.assign(result, result.seal());
  result.request = (fields = {}, id = selectedPaper) => put(base + '/coverage/requests/guard-append-request-' + (++serial) + '.json', {...clone(result.requestPayloads[id]), expectedRevision: f.state().revision, ...fields});
  result.invoke = (command, argument, ok = true) => f.execute(APPEND_PROTOCOL + '/coverage.mjs', [command, argument.path], ok);
  result.command = (command, fields = {}, ok = true, id = selectedPaper) => { const request = result.request(fields, id); return {...result.invoke(command, request, ok), request}; };
  return result;
}

function seal(f, options) {
  const scopes = [], deliveries = {};
  for (const id of paperIds) {
    const registration = clone(f.registrations[id]), work = registration.workRoot, values = clone(f.inputs[id]), hooks = options[id] ?? {}, is186 = id === 'r0186';
    for (const field of ['originalCandidate', 'originalScope', 'candidate', 'contract']) hooks[field]?.(values[field]);
    const original = {candidate: f.put(work + '/candidate.json', values.originalCandidate), sourceScope: f.put(work + '/source-scope.json', values.originalScope)};
    const repaired = {candidate: is186 ? f.put(work + '/candidate-repair-v003.json', values.candidate) : original.candidate,
      sourceScope: f.put(work + (is186 ? '/source-scope-repair-v003.json' : '/source-scope-repair-v002.json'), values.contract)};
    const processOld = f.put(work + '/terminal-process-check.json', {fixtureOnly: true, activeScientificProcesses: []});
    const processNew = f.put(work + '/terminal-process-check-repair-v002.json', {fixtureOnly: true, activeScientificProcesses: []});
    const common = {schemaVersion: 1, paperId: id, revision: 2, agent: workerFor(id), ownerFinished: true, noActiveCalculation: true, workerCount: 1, scientificAcceptance: false};
    const oldTerminal = {...common, candidate: original.candidate, sourceScope: original.sourceScope,
      ...(is186 ? {role: 'worker', assignmentStartedAt: registration.owner.startedAt, completedAt: new Date(Date.parse(registration.owner.startedAt) + 1000).toISOString()}
        : {registeredStartedAt: registration.owner.startedAt, frozenAt: new Date(Date.parse(registration.owner.startedAt) + 1000).toISOString()})};
    hooks.oldTerminal?.(oldTerminal); original.terminal = f.put(work + (is186 ? '/terminal-checkpoint.json' : '/terminal.json'), oldTerminal);
    const preserved = [original.candidate, original.sourceScope, original.terminal, processOld, processNew, values.script, values.output, values.receipt];
    while (preserved.length < (id === 'r0186' ? 27 : 36)) preserved.push(f.put(work + '/preserved-' + preserved.length + '.txt', 'Synthetic immutable preserved bytes.'));
    const report = {schemaVersion: 1, paperId: id, revision: 2, author: workerFor(id), fixtureOnly: true,
      ...(is186 ? {} : {allPreexistingFilesUnchanged: clone(preserved)})};
    hooks.audit?.(report); const audit = f.put(work + (is186 ? '/candidate-repair-audit-v003.json' : '/source-scope-repair-v002-audit.json'), report);
    const baseline = {candidate: registration.latest.candidate, review: registration.latest.review, decision: registration.latest.decision,
      contract: registration.latest.guard.contract, scopeReview: registration.latest.guard.scopeReview};
    const terminal = {...common, candidate: repaired.candidate, ...(is186 ? {
      role: 'worker', assignmentStartedAt: registration.owner.startedAt, completedAt: new Date(Date.parse(registration.owner.startedAt) + 2000).toISOString(),
      repairVersion: 3, newScientificExecutions: 0, terminalState: 'repair_frozen_ready_for_supervisor_intake_awaiting_scientific_review',
      sourceScope: repaired.sourceScope, deltaAndRetentionEvidence: audit,
      retentionChain: {originalCandidate: original.candidate, originalSourceScope: original.sourceScope, originalTerminal: original.terminal,
        publicPriorCandidate: baseline.candidate, publicPriorDecision: baseline.decision, publicPriorScope: baseline.contract},
      preservation: {preExistingFiles: preserved.map(ref => ({...ref, identical: true}))}
    } : {frozenAt: new Date(Date.parse(registration.owner.startedAt) + 2000).toISOString(), repairVersion: 'v002',
      state: 'append_only_source_scope_repair_frozen', originalSourceScope: original.sourceScope, originalTerminal: original.terminal,
      previousPublicSourceScope: baseline.contract, repairedSourceScope: repaired.sourceScope, audit,
      processState: {activeCalculations: [], backgroundJobs: 0, newScientificExperiments: 0}})};
    hooks.terminal?.(terminal); repaired.terminal = f.put(work + (is186 ? '/terminal-repair-v003.json' : '/terminal-repair-v002.json'), terminal);
    const scope = {paperId: id, iteration: 2, owner: clone(registration.owner), scan: registration.scan, order: registration.order,
      guardEnrollment: registration.guardEnrollment, original, repaired, audit, baseline,
      priorSnapshotSha256: objectHash(registration.latest), historySha256: objectHash(registration.history), preserved};
    hooks.scope?.(scope); scopes.push(scope); deliveries[id] = {values, original, repaired, oldTerminal, terminal, report, audit, scope};
  }
  const diagnosticObject = {schemaVersion: 1, scientificAcceptance: false, papers: scopes.map(scope => ({...clone(scope), preservedOriginalFileCount: scope.preserved.length}))}; options.diagnostic?.(diagnosticObject);
  const diagnostic = f.put(diagnosticRelative, diagnosticObject);
  const authorizationObject = {schemaVersion: 1, diagnostic, authorization: {source: 'direct_human_reply_in_sending_chat', reply: '允许发送并协调修复'}}; options.authorization?.(authorizationObject);
  const authorization = f.put(authorizationRelative, authorizationObject);
  const manifest = {schemaVersion: 1, releaseId: 'guard-append-20261105', modules: clone(f.releaseModules), upstream: clone(f.releaseUpstream), diagnostic, authorization, repairScopes: scopes};
  options.manifest?.(manifest); const releaseManifest = f.put(APPEND_RELEASE + '/release-manifest.json', manifest);
  const requestPayloads = Object.fromEntries(scopes.map(scope => [scope.paperId, {schemaVersion: 1, expectedRevision: f.state().revision,
    paperId: scope.paperId, iteration: 2, agent: scope.owner.agent, ownerFinished: true, noActiveCalculation: true, supervisor,
    reason: 'Synthetic original-actor c002 guarded append repair only.', releaseManifest, scan: scope.scan, order: scope.order,
    guardEnrollment: scope.guardEnrollment, original: clone(scope.original), repaired: clone(scope.repaired), audit: scope.audit}]));
  return {manifest, releaseManifest, diagnostic, authorization, scopes, deliveries, requestPayloads};
}

export {canonical, hash, objectHash, clone, read, digest, APPEND_PROTOCOL, APPEND_RELEASE, APPEND_MODULES, APPEND_UPSTREAM, base as campaignRelative, clean as cleanRelative};
