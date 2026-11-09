import fs from 'node:fs';
import path from 'node:path';
import {canonical, hash, fileRef} from '../../../coverage-core.mjs';
import {APPEND_MODULES, APPEND_UPSTREAM, APPEND_RELEASE, APPEND_PROTOCOL} from '../../../protocols/append-correction-v1/append-core.mjs';
import {fixture, installCoverage, copyModuleClosure, candidateFor, refreshBasis, objectHash, read, clone, campaignRelative as base} from '../context-kit/fixture.mjs';

// Isolated synthetic-only fixture, workerCount=1. No production inputs/state.
export const worker = 'synthetic-append-worker', supervisor = 'synthetic-supervisor';
function scopeFor(f, candidate, scan) {
  const cards = [], alignments = [];
  for (const item of candidate.inventory.items) {
    const anchors = item.locators.map((locator, index) => {
      const unit = scan.units.find(row => row.id === locator.unitId), resource = scan.resources.find(row => row.id === unit.resourceId);
      return {id: item.id + ':a' + index, resourceId: resource.id, resourceSha256: resource.sha256, unitId: unit.id,
        ...(resource.type === 'text' ? {start: locator.start, end: locator.end, excerptSha256: locator.excerptSha256,
          quote: fs.readFileSync(resource.path, 'utf8').slice(locator.start, locator.end)} : {semantic: locator.semantic})};
    });
    const claimId = item.id + ':source';
    cards.push({itemId: item.id, itemSha256: objectHash(item), anchors, claims: [{id: claimId, anchorIds: anchors.map(row => row.id),
      statement: 'Synthetic source identity only.', kind: Object.hasOwn(anchors[0], 'quote') ? 'identity' : 'visual_observation',
      modality: 'Synthetic assertion', quantifier: 'Synthetic displayed identity', conditions: ['Synthetic domain only'],
      empiricalTarget: {kind: 'not_empirical', description: 'Synthetic source consistency only.', identityRequirements: []}}]});
    for (const obligation of item.obligations) alignments.push({obligationId: obligation.id, obligationSha256: objectHash(obligation),
      assessmentSha256: objectHash(candidate.assessments.find(row => row.obligationId === obligation.id)), claimIds: [claimId],
      relation: 'original', additionalAssumptions: [], assessedTarget: 'not_empirical', reason: 'Synthetic original target only.'});
  }
  return {schemaVersion: 1, paperId: candidate.paperId, revision: 1, scanSha256: objectHash(scan), candidateSha256: objectHash(candidate), author: candidate.author,
    inventory: {complete: true, missingClaims: [], notes: 'Synthetic full inventory only.'}, cards, alignments, legacyRetainedObligationIds: []};
}

/** Creates a disjoint temp project with actual unchanged legacy runtime/guard. */
export function setup(t) {
  const f = installCoverage(fixture(t)), put = (name, value) => f.absolute(f.put(name, value));
  const guardRelease = base + '/architecture/batch-scope-20261029';
  for (const name of ['coverage-guard.mjs', 'coverage-scope.mjs', 'coverage-batch.mjs']) copyModuleClosure(f.project, base + '/' + name);
  put(base + '/COVERAGE_GUARDS.md', 'Synthetic immutable guard guide.');
  for (const name of ['BATCH_API.md', 'SCOPE_API.md']) put(guardRelease + '/' + name, 'Synthetic immutable instructions.');
  const guardModules = ['coverage.mjs', 'coverage-guard.mjs', 'coverage-scope.mjs', 'coverage-batch.mjs', 'COVERAGE_GUARDS.md', 'BATCH_API.md', 'SCOPE_API.md'].map(name => {
    const installed = fileRef(f.project, (['BATCH_API.md', 'SCOPE_API.md'].includes(name) ? guardRelease : base) + '/' + name);
    return {name, installed, frozen: put(guardRelease + '/release/' + name, fs.readFileSync(installed.path))};
  });
  put(guardRelease + '/release-manifest.json', {schemaVersion: 1, releaseId: 'batch-scope-20261029', modules: guardModules});
  f.invoke('init'); f.command('guard-policy', {supervisor, reason: 'Synthetic isolated initial guard activation.'}); f.command('prepare');
  f.command('assign', {role: 'worker', agent: worker, freshContext: true, historyInherited: false});
  for (const name of APPEND_MODULES) copyModuleClosure(f.project, APPEND_PROTOCOL + '/' + name);
  const paper = clone(f.paper()), scan = read(paper.scan.path), work = paper.workRoot;
  const source = candidateFor(f, scan, {author: worker}), target = source.inventory.items[0], oldId = target.id;
  target.id = 'origin:i0062'; target.obligations[0].id = target.id + ':o01'; source.assessments[0].obligationId = target.obligations[0].id;
  for (const item of source.inventory.items) item.dependencies = item === target ? [] : [target.id];
  for (const row of source.inventory.unitDispositions) row.itemIds = row.itemIds.map(id => id === oldId ? target.id : id);
  const three = source.inventory.items.flatMap(item => item.locators).filter(locator => Object.hasOwn(locator, 'start')).slice(0, 3);
  target.locators = [...clone(three), clone(three[0])];
  for (const row of source.inventory.unitDispositions) if (target.locators.some(locator => locator.unitId === row.unitId) && !row.itemIds.includes(target.id)) row.itemIds.push(target.id);
  while (source.assessments.length < 23) {
    const id = target.id + ':o' + String(target.obligations.length + 1).padStart(2, '0');
    target.obligations.push({...clone(target.obligations[0]), id}); source.assessments.push({...clone(source.assessments[0]), obligationId: id});
  }
  refreshBasis(source);
  const originalScope = scopeFor(f, source, scan), fixed = clone(source);
  fixed.inventory.items.find(item => item.id === target.id).locators.pop(); refreshBasis(fixed);
  const fixedScope = clone(originalScope); fixedScope.candidateSha256 = objectHash(fixed);
  fixedScope.cards.find(card => card.itemId === target.id).itemSha256 = objectHash(fixed.inventory.items.find(item => item.id === target.id));
  for (const alignment of fixedScope.alignments) alignment.assessmentSha256 = objectHash(fixed.assessments.find(row => row.obligationId === alignment.obligationId));
  const processOld = put(work + '/terminal-process-check.json', {synthetic: true, activeScientificProcesses: []});
  const processNew = put(work + '/terminal-process-check-repair-v002.json', {synthetic: true, activeScientificProcesses: []});
  const modules = APPEND_MODULES.map(name => {
    const installed = fileRef(f.project, APPEND_PROTOCOL + '/' + name);
    return {name, installed, frozen: put(APPEND_RELEASE + '/release/' + name, fs.readFileSync(installed.path))};
  });
  const upstream = APPEND_UPSTREAM.map(name => ({name, ref: fileRef(f.project, name)}));
  const inputs = {originalCandidate: source, originalScope, candidate: fixed, contract: fixedScope};
  let generation = 0;
  function seal(options = {}) {
    const values = clone(inputs);
    options.originalCandidate?.(values.originalCandidate); options.originalScope?.(values.originalScope);
    options.candidate?.(values.candidate); options.contract?.(values.contract);
    const original = {candidate: put(work + '/candidate.json', values.originalCandidate), sourceScope: put(work + '/source-scope.json', values.originalScope)};
    const oldTerminal = {schemaVersion: 1, paperId: 'origin', actor: worker, role: 'worker', roundId: 'c001', threadId: 'synthetic-original-thread',
      assignedAt: paper.owner.startedAt, finishedAt: new Date(Date.parse(paper.owner.startedAt) + 1000).toISOString(),
      terminal: 'candidate_delivered_for_independent_review', noActiveCalculations: true,
      scan: clone(paper.scan), order: clone(paper.order), guardOrder: clone(paper.guardEnrollment.profile), guardOrderText: clone(paper.guardEnrollment.instructions),
      candidate: original.candidate, sourceScope: original.sourceScope, terminalProcessCheck: processOld,
      evidence: values.originalCandidate.assessments.flatMap(row => row.evidence.flatMap(evidence => evidence.artifacts)).slice(0, 1).map(ref => f.absolute(ref))};
    options.oldTerminal?.(oldTerminal);
    original.terminal = put(work + '/terminal.json', oldTerminal);
    const repaired = {candidate: put(work + '/candidate-repair-v002.json', values.candidate), sourceScope: put(work + '/source-scope-repair-v002.json', values.contract)};
    const duplicate = {itemId: target.id, locator: clone(target.locators[0]), oldItemHash: objectHash(values.originalCandidate.inventory.items.find(row => row.id === target.id)),
      newItemHash: objectHash(inputs.candidate.inventory.items.find(row => row.id === target.id)), affectedObligationIds: source.assessments.map(row => row.obligationId).sort()};
    const preservedFiles = [...Object.values(original), processOld, processNew, ...oldTerminal.evidence];
    while (preservedFiles.length < 48) preservedFiles.push(put(work + '/preserved-' + preservedFiles.length + '.txt', 'Synthetic immutable preserved bytes.'));
    const report = {schemaVersion: 1, paperId: 'origin', author: worker, repair: 'v002', valid: true, original, repaired,
      itemId: duplicate.itemId, oldItemSha256: duplicate.oldItemHash, newItemSha256: duplicate.newItemHash, deletedExactDuplicateLocator: duplicate.locator,
      affectedObligations: duplicate.affectedObligationIds, preservedFiles,
      candidateFieldDelta: [], sourceScopeFieldDelta: [], validationBoundary: 'Synthetic corroboration only; deliberately no trusted diff report.'};
    options.report?.(report);
    const repairCheck = put(work + '/repair-v002-check.json', report);
    const terminal = {schemaVersion: 1, paperId: 'origin', actor: worker, role: 'worker', roundId: 'c001', threadId: oldTerminal.threadId, repair: 'v002',
      finishedAt: new Date(Date.parse(paper.owner.startedAt) + 2000).toISOString(), terminal: 'append_only_repair_preserved_pending_safe_supervisor_intake',
      noActiveScientificCalculations: true, scientificComputationsRun: 0, workerCount: 1, originalBytesPreserved: true,
      original, repaired: clone(repaired), repairCheck, processCheck: processNew};
    options.terminal?.(terminal);
    repaired.terminal = put(work + '/terminal-repair-v002.json', terminal);
    const diagnostic = put(base + '/coverage/requests/architecture-diagnostic-r0155-append-correction-20261029.json', {schemaVersion: 1, paperId: 'origin',
      actualFailure: {owner: paper.owner}, refs: {candidate: original.candidate, scope: original.sourceScope, terminal: original.terminal,
        cli: upstream.find(row => row.name === base + '/coverage.mjs').ref, core: upstream.find(row => row.name === base + '/coverage-core.mjs').ref, guard: upstream.find(row => row.name === base + '/coverage-guard.mjs').ref},
      exactDefect: {itemId: duplicate.itemId, duplicatedLocator: duplicate.locator, oldItemHash: duplicate.oldItemHash, deduplicatedItemHash: duplicate.newItemHash, affectedBasisIds: duplicate.affectedObligationIds}});
    const manifest = {schemaVersion: 1, releaseId: 'append-correction-20261029', modules: clone(modules), upstream: clone(upstream), diagnostic,
      repairScope: {paperId: 'origin', iteration: 1, owner: clone(paper.owner), scan: paper.scan, order: paper.order, guardEnrollment: paper.guardEnrollment, original, repaired, repairCheck, duplicate}};
    options.manifest?.(manifest);
    const releaseManifest = put(APPEND_RELEASE + '/release-manifest.json', manifest);
    const request = {schemaVersion: 1, expectedRevision: f.state().revision, paperId: 'origin', iteration: 1, agent: worker, ownerFinished: true,
      noActiveCalculation: true, supervisor, reason: 'Synthetic original-author append-only correction.', scan: paper.scan, order: paper.order,
      guardEnrollment: paper.guardEnrollment, original: clone(original), repaired: clone(repaired), repairCheck, releaseManifest};
    options.request?.(request);
    const requestRef = put(base + '/coverage/requests/append-core-' + (++generation) + '.json', request);
    return {values, original, repaired, report, oldTerminal, terminal, repairCheck, manifest, releaseManifest, requestPayload: request, requestRef};
  }
  return {...f, put, scan, registration: paper, inputs, seal, ...seal()};
}

export {canonical, hash, objectHash, clone, scopeFor};
