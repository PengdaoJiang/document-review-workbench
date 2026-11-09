// Pure, narrowly released append-only correction proof. Never writes or runs science.
import fs from 'node:fs';
import path from 'node:path';
import {canonical, hash, checkRef, validateCandidate} from '../../coverage-core.mjs';
import {validateCandidateScope} from '../../coverage-scope.mjs';
import {guardRequired, guardAdmissionReferences} from '../../coverage-guard.mjs';

const BASE = 'research_followup/network3_campaign';
export const APPEND_PROTOCOL = BASE + '/protocols/append-correction-final-v1';
export const APPEND_RELEASE = BASE + '/architecture/append-correction-final-20261029';
export const APPEND_MODULES = Object.freeze(['append-core.mjs', 'coverage.mjs']);
export const APPEND_UPSTREAM = Object.freeze([
  'paper_library/dot-library.mjs', 'paper_library/library.mjs', 'paper_library/revocations.mjs', 'paper_library/workflow-contract.mjs',
  ...['coverage-context', 'coverage-core', 'coverage-guard', 'coverage-recovery', 'coverage-scan', 'coverage-scope', 'coverage', 'repair-flow'].map(name => BASE + '/' + name + '.mjs'),
  ...['inputs', 'reading', 'results', 'runs'].map(name => 'research_followup/reproduction_clean/runtime/' + name + '.mjs'),
  'research_tree/src/journal-model.mjs', 'research_tree/src/review-model.mjs', 'sources/resolve-source.mjs',
]);
const DIAGNOSTIC = BASE + '/coverage/requests/architecture-diagnostic-r0155-append-correction-20261029.json';
const SHA = /^[a-f0-9]{64}$/;
const insist = (ok, message) => { if (!ok) throw Error('Append correction: ' + message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => hash(canonical(value));
const equal = (a, b) => canonical(a) === canonical(b);
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (directory, target) => { const rel = path.relative(directory, target); return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const sameRef = (root, a, b) => plain(a) && plain(b) && text(a.path) && text(b.path) && key(path.resolve(root, a.path)) === key(path.resolve(root, b.path)) && a.sha256 === b.sha256;
function shape(value, keys, label) {
  insist(plain(value) && equal(Object.keys(value).sort(), [...keys].sort()), label + ' fields differ');
}
function refShape(ref) { shape(ref, ['path', 'sha256'], 'reference'); insist(text(ref.path) && SHA.test(ref.sha256), 'invalid reference'); }
function expectedRef(root, ref, relative, label) {
  refShape(ref); insist(key(path.resolve(root, ref.path)) === key(path.resolve(root, relative)), label + ' path differs');
}
function raw(root, ref) {
  refShape(ref);
  const filename = checkRef(root, ref), bytes = fs.readFileSync(filename);
  insist(hash(bytes) === ref.sha256, 'actual bytes mismatch: ' + filename);
  return bytes;
}
function json(root, ref) {
  const bytes = raw(root, ref), value = bytes.toString('utf8');
  insist(Buffer.from(value, 'utf8').equals(bytes), 'invalid UTF-8: ' + ref.path);
  return JSON.parse(value.replace(/^\uFEFF/, ''));
}
function uniqueRefs(root, refs) {
  const found = new Map();
  for (const ref of refs) {
    refShape(ref); const name = key(path.resolve(root, ref.path)), old = found.get(name);
    insist(!old || old.sha256 === ref.sha256, 'conflicting reference hashes');
    if (!old) found.set(name, ref);
  }
  return [...found.values()];
}
function refsIn(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Object.hasOwn(value, 'path') && Object.hasOwn(value, 'sha256')) { refShape(value); output.push(value); return output; }
  for (const child of Object.values(value)) refsIn(child, output);
  return output;
}
function exactIds(actual, expected, label) {
  insist(Array.isArray(actual) && actual.every(text) && new Set(actual).size === actual.length && equal([...actual].sort(), [...expected].sort()), label + ' IDs differ');
}
function editionIntegrityRefs(root, scan) {
  const edition = scan.reading.edition;
  insist(edition?.provider === 'dot' && /^dot-[A-Za-z0-9_-]+$/.test(edition.release ?? ''), 'fixed Dot edition required');
  const base = 'reconstructed_sources/' + edition.release;
  const index = {path: path.resolve(root, base + '/index.json'), sha256: edition.indexSha256};
  const recordRef = {path: edition.recordPath, sha256: edition.recordSha256};
  expectedRef(root, recordRef, base + '/papers/' + scan.paperId + '/record.json', 'edition record');
  const indexValue = json(root, index), record = json(root, recordRef);
  const entry = indexValue.papers?.filter(row => row.paperId === scan.paperId);
  insist(entry?.length === 1 && entry[0].version === edition.version && entry[0].record === 'papers/' + scan.paperId + '/record.json' && entry[0].recordSha256 === recordRef.sha256, 'edition index identity differs');
  insist(record.paperId === scan.paperId && record.version === edition.version && record.provider === 'dot' && Array.isArray(record.files?.all), 'edition record identity differs');
  const members = [];
  function member(descriptor, prefix) {
    const ref = {path: descriptor?.path, sha256: descriptor?.sha256}; refShape(ref);
    insist(!path.isAbsolute(ref.path) && !ref.path.includes('\\') && ref.path.split('/').every(part => part && part !== '.' && part !== '..') && ref.path.startsWith(prefix), 'edition member escapes exact package');
    const projected = {path: path.resolve(root, base, ref.path), sha256: ref.sha256}; raw(root, projected); members.push(projected);
  }
  insist(record.archive?.path === 'archives/' + scan.paperId + '.zip' && edition.version === 'dot-' + record.archive.sha256, 'edition archive identity differs');
  member(record.archive, 'archives/');
  for (const ref of record.files.all) member(ref, 'papers/' + scan.paperId + '/');
  // Integrity references only: no added scan resource, source unit, reader grant,
  // or recursive interpretation of arbitrary path-bearing package content.
  return [index, recordRef, ...members];
}
function validateRepairScope(root, scope) {
  shape(scope, ['paperId', 'iteration', 'owner', 'scan', 'order', 'guardEnrollment', 'original', 'repaired', 'repairCheck', 'duplicate'], 'repairScope');
  insist(/^(origin|r\d{4})$/.test(scope.paperId) && scope.iteration === 1, 'only fixed c001 is supported');
  shape(scope.owner, ['agent', 'role', 'startedAt'], 'owner');
  insist(text(scope.owner.agent) && scope.owner.role === 'worker' && Number.isFinite(Date.parse(scope.owner.startedAt)), 'invalid original worker');
  const ledger = BASE + '/coverage/' + scope.paperId, work = 'research_followup/reproduction_clean/coverage_work/' + scope.paperId + '/c001';
  expectedRef(root, scope.scan, ledger + '/scan.json', 'scan');
  expectedRef(root, scope.order, ledger + '/c001/worker.md', 'order');
  shape(scope.guardEnrollment, ['profile', 'instructions'], 'guardEnrollment');
  expectedRef(root, scope.guardEnrollment.profile, ledger + '/c001/guard-order.json', 'guard profile');
  expectedRef(root, scope.guardEnrollment.instructions, ledger + '/c001/guard-order.md', 'guard instructions');
  for (const [group, suffix] of [['original', ''], ['repaired', '-repair-v002']]) {
    shape(scope[group], ['candidate', 'sourceScope', 'terminal'], group);
    for (const [field, stem] of [['candidate', 'candidate'], ['sourceScope', 'source-scope'], ['terminal', 'terminal']]) expectedRef(root, scope[group][field], work + '/' + stem + suffix + '.json', group + ' ' + field);
  }
  expectedRef(root, scope.repairCheck, work + '/repair-v002-check.json', 'repair report');
  const duplicate = scope.duplicate;
  shape(duplicate, ['itemId', 'locator', 'oldItemHash', 'newItemHash', 'affectedObligationIds'], 'duplicate');
  insist(duplicate.itemId === scope.paperId + ':i0062' && SHA.test(duplicate.oldItemHash) && SHA.test(duplicate.newItemHash) && duplicate.oldItemHash !== duplicate.newItemHash, 'bound duplicate identity/hash differs');
  insist(plain(duplicate.locator) && Array.isArray(duplicate.affectedObligationIds) && duplicate.affectedObligationIds.length === 23, 'repair requires exact 23 affected bases');
  exactIds(duplicate.affectedObligationIds, duplicate.affectedObligationIds, 'affected basis');
}

/** Fixed release/module whitelist. Hashes pin actual bytes, not parsed JSON alone. */
export function loadAppendRelease({root, reference}) {
  insist(text(root) && path.isAbsolute(root), 'absolute project root required');
  expectedRef(root, reference, APPEND_RELEASE + '/release-manifest.json', 'release manifest');
  const manifest = json(root, reference), references = [reference];
  shape(manifest, ['schemaVersion', 'releaseId', 'modules', 'upstream', 'diagnostic', 'repairScope'], 'release manifest');
  insist(manifest.schemaVersion === 1 && manifest.releaseId === 'append-correction-final-20261029', 'unsupported release');
  insist(Array.isArray(manifest.modules) && Array.isArray(manifest.upstream), 'release module lists required');
  exactIds(manifest.modules.map(row => row.name), APPEND_MODULES, 'release modules');
  for (const row of manifest.modules) {
    shape(row, ['name', 'installed', 'frozen'], 'release module');
    expectedRef(root, row.installed, APPEND_PROTOCOL + '/' + row.name, 'installed module');
    expectedRef(root, row.frozen, APPEND_RELEASE + '/release/' + row.name, 'frozen module');
    insist(row.installed.sha256 === row.frozen.sha256 && raw(root, row.installed).equals(raw(root, row.frozen)), 'installed/frozen module differs');
    references.push(row.installed, row.frozen);
  }
  exactIds(manifest.upstream.map(row => row.name), APPEND_UPSTREAM, 'upstream whitelist');
  for (const row of manifest.upstream) {
    shape(row, ['name', 'ref'], 'upstream module'); expectedRef(root, row.ref, row.name, 'upstream module'); raw(root, row.ref); references.push(row.ref);
  }
  expectedRef(root, manifest.diagnostic, DIAGNOSTIC, 'diagnostic');
  const diagnostic = json(root, manifest.diagnostic), scope = manifest.repairScope;
  validateRepairScope(root, scope);
  insist(diagnostic.schemaVersion === 1 && diagnostic.paperId === scope.paperId && equal(diagnostic.actualFailure?.owner, scope.owner), 'diagnostic original identity differs');
  for (const [field, legacy] of [['candidate', 'candidate'], ['sourceScope', 'scope'], ['terminal', 'terminal']]) insist(sameRef(root, scope.original[field], diagnostic.refs?.[legacy]), 'diagnostic original ' + field + ' differs');
  const defect = diagnostic.exactDefect;
  insist(defect?.itemId === scope.duplicate.itemId && equal(defect.duplicatedLocator, scope.duplicate.locator) && defect.oldItemHash === scope.duplicate.oldItemHash && defect.deduplicatedItemHash === scope.duplicate.newItemHash, 'diagnostic duplicate differs');
  exactIds(scope.duplicate.affectedObligationIds, defect.affectedBasisIds ?? [], 'diagnostic affected bases');
  for (const [field, name] of [['cli', 'coverage.mjs'], ['core', 'coverage-core.mjs'], ['guard', 'coverage-guard.mjs']]) insist(sameRef(root, diagnostic.refs?.[field], manifest.upstream.find(row => row.name === BASE + '/' + name)?.ref), 'diagnostic upstream ' + field + ' differs');
  references.push(manifest.diagnostic);
  const recheck = () => { for (const ref of references) raw(root, ref); };
  recheck(); return {manifest, references, recheck};
}

function deriveCandidate(original, scope) {
  const candidate = structuredClone(original), items = new Map(), obligationItems = new Map();
  for (const item of original.inventory.items) {
    insist(!items.has(item.id), 'duplicate original item'); items.set(item.id, item);
    for (const obligation of item.obligations) { insist(!obligationItems.has(obligation.id), 'duplicate original obligation'); obligationItems.set(obligation.id, item.id); }
  }
  const target = items.get(scope.duplicate.itemId);
  insist(target && digest(target) === scope.duplicate.oldItemHash, 'old item hash differs');
  const duplicateKey = canonical(scope.duplicate.locator), seen = new Set(); let removed = 0;
  const locators = target.locators.filter(locator => {
    const id = canonical(locator); if (!seen.has(id)) { seen.add(id); return true; }
    insist(id === duplicateKey, 'unexpected duplicate locator'); removed++; return false;
  });
  insist(removed === 1 && target.locators.filter(locator => canonical(locator) === duplicateKey).length === 2, 'exact repeated locator was not removed once');
  candidate.inventory.items.find(item => item.id === target.id).locators = locators;
  insist(digest(candidate.inventory.items.find(item => item.id === target.id)) === scope.duplicate.newItemHash, 'deduplicated item hash differs');
  function closure(id, active = new Set(), out = new Set()) {
    insist(!active.has(id), 'cyclic original dependency'); if (out.has(id)) return out;
    const item = items.get(id); insist(item && Array.isArray(item.dependencies), 'missing original dependency');
    active.add(id); for (const dep of item.dependencies) closure(dep, active, out); active.delete(id); out.add(id); return out;
  }
  exactIds(original.assessments.map(row => row.obligationId), [...obligationItems.keys()], 'original assessments');
  const affected = [];
  for (const assessment of original.assessments) {
    const ids = [...closure(obligationItems.get(assessment.obligationId))].sort();
    const expected = Object.fromEntries(ids.map(id => [id, digest(items.get(id))]));
    insist(equal(assessment.basisItemHashes, expected), 'original transitive basis differs: ' + assessment.obligationId);
    if (ids.includes(target.id)) {
      affected.push(assessment.obligationId);
      candidate.assessments.find(row => row.obligationId === assessment.obligationId).basisItemHashes[target.id] = scope.duplicate.newItemHash;
    }
  }
  exactIds(affected, scope.duplicate.affectedObligationIds, 'derived affected bases');
  return {candidate, affected: affected.sort(), locatorsBefore: target.locators.length, locatorsAfter: locators.length};
}
function deriveScope(originalScope, original, candidate, duplicate) {
  insist(originalScope.candidateSha256 === digest(original), 'original scope candidate binding differs');
  const contract = structuredClone(originalScope), oldItems = new Map(original.inventory.items.map(item => [item.id, item])), oldAssessments = new Map(original.assessments.map(row => [row.obligationId, row]));
  let changedCard = 0;
  for (const card of contract.cards) {
    insist(oldItems.has(card.itemId) && card.itemSha256 === digest(oldItems.get(card.itemId)), 'original scope item binding differs');
    if (card.itemId === duplicate.itemId) { card.itemSha256 = duplicate.newItemHash; changedCard++; }
  }
  insist(changedCard === 1, 'exactly one original target card required');
  let changedAlignments = 0;
  for (const row of contract.alignments) {
    insist(oldAssessments.has(row.obligationId) && row.assessmentSha256 === digest(oldAssessments.get(row.obligationId)), 'original scope assessment binding differs');
    if (duplicate.affectedObligationIds.includes(row.obligationId)) { row.assessmentSha256 = digest(candidate.assessments.find(a => a.obligationId === row.obligationId)); changedAlignments++; }
  }
  insist(changedAlignments === 23, 'exactly 23 affected scope alignments required');
  contract.candidateSha256 = digest(candidate); return contract;
}

/** Complete immutable-object proof plus unchanged candidate/scope gates; no publication. */
export async function prepareAppendCorrection({root, state, paper, request}) {
  shape(request, ['schemaVersion', 'expectedRevision', 'paperId', 'iteration', 'agent', 'ownerFinished', 'noActiveCalculation', 'supervisor', 'reason', 'scan', 'order', 'guardEnrollment', 'original', 'repaired', 'repairCheck', 'releaseManifest'], 'request');
  const release = loadAppendRelease({root, reference: request.releaseManifest}), {manifest} = release, scope = manifest.repairScope;
  insist(request.schemaVersion === 1 && Number.isSafeInteger(request.expectedRevision) && request.expectedRevision === state.revision, 'stale revision or unsupported request');
  insist(paper && paper.phase === 'working' && paper.iteration === 1 && !paper.staged && !paper.latest && Array.isArray(paper.history) && paper.history.length === 0 && !Object.hasOwn(paper, 'sourceEnrollment'), 'only unaccepted working c001 without history/source enrollment is admissible');
  insist(Array.isArray(state.papers) && state.papers.filter(row => row.paperId === paper.paperId).length === 1 && equal(state.papers.find(row => row.paperId === paper.paperId), paper), 'paper is not the exact live registration');
  insist(paper.paperId === scope.paperId && request.paperId === scope.paperId && request.iteration === 1 && equal(paper.owner, scope.owner) && request.agent === scope.owner.agent, 'original owner/startedAt identity differs');
  insist(request.ownerFinished === true && request.noActiveCalculation === true && text(request.reason), 'current natural completion attestation required');
  const authority = json(root, state.authority);
  insist(text(request.supervisor) && request.supervisor === (authority.supervisorThreadId ?? authority.supervisor?.threadId), 'bound scientific supervisor required');
  for (const field of ['scan', 'order', 'guardEnrollment', 'original', 'repaired', 'repairCheck']) insist(equal(request[field], scope[field]), 'request ' + field + ' differs from release');
  for (const field of ['scan', 'order', 'guardEnrollment']) insist(equal(paper[field], scope[field]), 'live ' + field + ' differs from release');
  const work = path.resolve(root, 'research_followup/reproduction_clean/coverage_work/' + paper.paperId + '/c001');
  insist(text(paper.workRoot) && key(path.resolve(root, paper.workRoot)) === key(work), 'registered work root differs');
  insist(guardRequired(root, state, paper) && paper.guardEnrollment, 'existing source-scope guard required');
  const references = [...release.references, state.authority, ...guardAdmissionReferences(root, state, paper), ...refsIn(scope)];
  const scan = json(root, scope.scan), original = json(root, scope.original.candidate), candidate = json(root, scope.repaired.candidate);
  const originalScope = json(root, scope.original.sourceScope), contract = json(root, scope.repaired.sourceScope);
  const oldTerminal = json(root, scope.original.terminal), terminal = json(root, scope.repaired.terminal), repairCheck = json(root, scope.repairCheck);
  insist(scan.paperId === paper.paperId && digest(scan) === scope.scan.sha256 && original.author === scope.owner.agent && candidate.author === scope.owner.agent, 'scan/candidate author identity differs');
  for (const value of [oldTerminal, terminal]) insist(value.schemaVersion === 1 && value.paperId === paper.paperId && value.actor === scope.owner.agent && value.role === 'worker' && value.roundId === 'c001' && text(value.threadId), 'terminal actual actor/role/roundId differs');
  insist(oldTerminal.threadId === terminal.threadId && oldTerminal.assignedAt === scope.owner.startedAt, 'terminal thread/registration differs');
  insist(oldTerminal.terminal === 'candidate_delivered_for_independent_review' && oldTerminal.noActiveCalculations === true, 'original terminal is not naturally completed');
  insist(terminal.repair === 'v002' && terminal.terminal === 'append_only_repair_preserved_pending_safe_supervisor_intake' && terminal.noActiveScientificCalculations === true && terminal.scientificComputationsRun === 0 && terminal.workerCount === 1 && terminal.originalBytesPreserved === true, 'repair terminal is not an append-only natural completion');
  const oldFinished = Date.parse(oldTerminal.finishedAt), finished = Date.parse(terminal.finishedAt);
  insist(Number.isFinite(oldFinished) && oldFinished >= Date.parse(scope.owner.startedAt) && Number.isFinite(finished) && finished > oldFinished, 'repair terminal finishedAt is not strictly later');
  for (const [field, ref] of [['scan', scope.scan], ['order', scope.order], ['guardOrder', scope.guardEnrollment.profile], ['guardOrderText', scope.guardEnrollment.instructions], ['candidate', scope.original.candidate], ['sourceScope', scope.original.sourceScope]]) insist(sameRef(root, oldTerminal[field], ref), 'original terminal ' + field + ' differs');
  insist(equal(terminal.original, scope.original) && equal(terminal.repaired, {candidate: scope.repaired.candidate, sourceScope: scope.repaired.sourceScope}) && sameRef(root, terminal.repairCheck, scope.repairCheck), 'repair terminal raw refs differ');
  expectedRef(root, oldTerminal.terminalProcessCheck, path.join(work, 'terminal-process-check.json'), 'original process checkpoint');
  expectedRef(root, terminal.processCheck, path.join(work, 'terminal-process-check-repair-v002.json'), 'repaired process checkpoint');
  insist(repairCheck.schemaVersion === 1 && repairCheck.paperId === paper.paperId && repairCheck.author === scope.owner.agent && repairCheck.repair === 'v002' && repairCheck.valid === true, 'repair report identity differs');
  insist(equal(repairCheck.original, scope.original) && equal(repairCheck.repaired, terminal.repaired), 'repair report raw refs differ');
  insist(repairCheck.itemId === scope.duplicate.itemId && repairCheck.oldItemSha256 === scope.duplicate.oldItemHash && repairCheck.newItemSha256 === scope.duplicate.newItemHash && equal(repairCheck.deletedExactDuplicateLocator, scope.duplicate.locator), 'repair report target differs');
  exactIds(repairCheck.affectedObligations, scope.duplicate.affectedObligationIds, 'repair report affected bases');
  insist(Array.isArray(repairCheck.preservedFiles) && repairCheck.preservedFiles.length === 48 && uniqueRefs(root, repairCheck.preservedFiles).length === 48, 'exact 48 distinct preserved file refs required');
  const terminalRefs = [...refsIn(oldTerminal), ...refsIn(terminal), ...refsIn(repairCheck)];
  const publicRefs = [scope.scan, scope.order, scope.guardEnrollment.profile, scope.guardEnrollment.instructions];
  for (const ref of terminalRefs) {
    const target = path.resolve(root, ref.path);
    insist(inside(work, target) || publicRefs.some(allowed => sameRef(root, allowed, ref)), 'terminal/report ref outside exact permitted scope');
    references.push(ref);
  }
  for (const ref of repairCheck.preservedFiles) insist(inside(work, path.resolve(root, ref.path)), 'preserved file outside exact owner root');
  for (const ref of [scope.original.candidate, scope.original.sourceScope, scope.original.terminal, oldTerminal.terminalProcessCheck, terminal.processCheck, ...refsIn(oldTerminal).filter(ref => inside(work, path.resolve(root, ref.path)))]) insist(repairCheck.preservedFiles.some(saved => sameRef(root, saved, ref)), 'preserved inventory omits original delivery/process/evidence');
  // Reconstruct the whole objects independently; no report delta or PASS substitutes.
  const derived = deriveCandidate(original, scope);
  insist(equal(candidate, derived.candidate), 'candidate has edits beyond exact duplicate/basis correction');
  const expectedScope = deriveScope(originalScope, original, derived.candidate, scope.duplicate);
  insist(equal(contract, expectedScope), 'source scope has edits beyond exact 25 binding changes');
  // Frozen reading entries may carry descriptive source metadata. Only the
  // legacy validator's explicit academic fields grant files, never recursive
  // path discovery; project those entries to strict refs for actual-byte checks.
  const readingRefs = [scan.reading.originalPacket, scan.reading.primary, ...(scan.reading.original ? [scan.reading.original] : []),
    ...(scan.reading.latexEntries ?? []), ...(scan.reading.dependencies ?? []), ...(scan.reading.assets ?? [])]
    .map(ref => ({path: ref.path, sha256: ref.sha256}));
  references.push(...scan.resources.map(resource => ({path: resource.path, sha256: resource.sha256})), ...readingRefs, ...Object.values(scan.firstPass), ...editionIntegrityRefs(root, scan));
  const checkedReferences = uniqueRefs(root, references);
  const recheck = () => { for (const ref of checkedReferences) raw(root, ref); };
  recheck();
  await validateCandidate({root, scan, scanSha256: scope.scan.sha256, candidate, previous: null});
  validateCandidateScope({root, scan, candidate, candidateSha256: digest(candidate), contract, author: scope.owner.agent, previous: null});
  recheck();
  const proof = {schemaVersion: 1, verification: 'mechanical_append_correction_not_scientific_acceptance', itemId: scope.duplicate.itemId,
    oldItemHash: scope.duplicate.oldItemHash, newItemHash: scope.duplicate.newItemHash,
    locatorsBefore: derived.locatorsBefore, locatorsAfter: derived.locatorsAfter, affectedObligationIds: derived.affected,
    candidateBindingChanges: 24, scopeBindingChanges: 25, preservedFileCount: 48,
    originalCandidateObjectSha256: digest(original), candidateObjectSha256: digest(candidate), originalScopeObjectSha256: digest(originalScope), scopeObjectSha256: digest(contract)};
  return {manifest, scan, candidate, contract, proof, references: checkedReferences, recheck};
}
