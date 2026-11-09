/**
 * Additive, explicit review authoring; never dispatches or writes a ledger.
 * Manifest (all unmarked fields required):
 * {schemaVersion:1,scanSha256,candidateSha256,reviewerAgent,
 *  inventory:{complete,checkedAllUnits,missingItems,notes,unitExclusions},
 *  entryFiles:[{path,sha256}],retainedObligationIds:[],artifactRegistry?}.
 * Each part is exactly {entries:[{obligationId,verdict,reason,evidence}]}.
 * Paths are project-relative or absolute, not manifest-relative. Manifest and
 * parts belong to the currently registered reviewRoot/cNNN. Part order and
 * entry order are preserved. Scientific fields have no defaults. Nothing here
 * establishes reading coverage, evidence sufficiency or supervisor acceptance.
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical, fileRef, checkRef} from './coverage-core.mjs';
import {assembleReview} from './coverage-authoring.mjs';
import {bound, safeWithin, loadPaper, previousFor} from './coverage-context.mjs';
import {writeOnceOrMatch} from './repair-flow.mjs';

const insist = (value, message) => { if (!value) throw Error('Coverage review parts: ' + message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = filename => process.platform === 'win32' ? filename.toLowerCase() : filename;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const inventoryFields = ['complete', 'checkedAllUnits', 'missingItems', 'notes', 'unitExclusions'];
function shape(value, fields, required, label) {
  insist(plain(value), label + ' must be an object');
  for (const field of Object.keys(value)) insist(fields.includes(field), label + ': unexpected field ' + field);
  for (const field of required) insist(Object.hasOwn(value, field), label + ': missing ' + field);
}
function stringArray(value, label) {
  insist(Array.isArray(value) && value.every(text), label + ' must be an explicit string array');
}
function inventoryShape(inventory) {
  shape(inventory, inventoryFields, inventoryFields, 'review inventory');
  insist(typeof inventory.complete === 'boolean', 'inventory.complete must be explicit boolean');
  insist(inventory.checkedAllUnits === true, 'inventory.checkedAllUnits must explicitly be true');
  stringArray(inventory.missingItems, 'inventory.missingItems');
  insist(text(inventory.notes), 'inventory.notes requires an explicit scientific account');
  insist(Array.isArray(inventory.unitExclusions), 'inventory.unitExclusions must be an explicit array');
  for (const exclusion of inventory.unitExclusions) {
    shape(exclusion, ['unitId', 'reason'], ['unitId', 'reason'], 'unit exclusion');
    insist(text(exclusion.unitId) && text(exclusion.reason), 'unit exclusion needs explicit ID and reason');
  }
}
function entryShape(entry) {
  const fields = ['obligationId', 'verdict', 'reason', 'evidence'];
  shape(entry, fields, fields, 'review entry');
  insist(text(entry.obligationId), 'review entry needs obligationId');
  insist(['accept', 'needs_work'].includes(entry.verdict), 'review entry needs explicit accept/needs_work verdict');
  insist(text(entry.reason), 'review entry needs explicit scientific reason');
  insist(Array.isArray(entry.evidence), 'review entry needs explicit evidence array');
  insist(entry.verdict !== 'accept' || entry.evidence.length > 0, 'accepted independent review needs supporting evidence');
}
function scoped(root, reviewRoot, filename) {
  // Inspect the original spelling before path.resolve can erase traversal.
  return safeWithin(reviewRoot, safeWithin(root, filename));
}
function diagnosticPage(ids) {
  return {count: ids.length, ids: ids.slice(0, 20), truncated: ids.length > 20};
}
function coverageDiagnostics(candidate, entries, retained) {
  const expected = new Set(candidate.assessments.map(value => value.obligationId));
  const counts = new Map(), entryIds = new Set(entries.map(value => value.obligationId));
  for (const id of [...entryIds, ...retained]) counts.set(id, 0);
  for (const id of [...entries.map(value => value.obligationId), ...retained]) counts.set(id, counts.get(id) + 1);
  return {
    missing: diagnosticPage([...expected].filter(id => !counts.has(id))),
    duplicate: diagnosticPage([...counts].filter(([, count]) => count > 1).map(([id]) => id)),
    unknown: diagnosticPage([...counts.keys()].filter(id => !expected.has(id))),
    entryRetainedOverlap: diagnosticPage([...new Set(retained)].filter(id => entryIds.has(id))),
  };
}

export async function runReviewParts(root, argv) {
  root = path.resolve(root);
  const [command, paperId, ...args] = argv;
  if (!command || command === 'help') return {
    commands: ['check <paperId> <manifestPath>', 'assemble <paperId> <manifestPath> <newReviewPath>'],
    partShape: '{entries:[{obligationId,verdict,reason,evidence}]}',
    gate: 'Only mechanical assembly; complete bound reading, independent inventory/evidence review and supervisor decisions remain mandatory.',
  };
  insist(['check', 'assemble'].includes(command), 'Unknown command');
  insist(args.length === (command === 'check' ? 1 : 2), 'Expected manifest path' + (command === 'assemble' ? ' and new review path' : ''));
  const {paper, scan} = loadPaper(root, paperId);
  insist(paper.owner?.role === 'reviewer' && text(paper.owner.agent) && paper.phase === 'reviewing', 'No active matching registered reviewer owner');
  insist(Number.isSafeInteger(paper.iteration) && paper.iteration > 0 && paper.staged?.candidate, 'Missing current staged candidate/version');
  const expectedRoot = `research_followup/reproduction_clean/coverage_verifications/${paperId}/c${String(paper.iteration).padStart(3, '0')}`;
  insist(text(paper.staged.reviewRoot) && key(path.resolve(root, paper.staged.reviewRoot)) === key(path.resolve(root, expectedRoot)), 'Review root differs from registered paper/version');
  const reviewRoot = safeWithin(root, paper.staged.reviewRoot);
  const manifestPath = scoped(root, reviewRoot, args[0]);
  const manifestRef = fileRef(root, manifestPath), manifest = bound(root, manifestRef);
  const required = ['schemaVersion', 'scanSha256', 'candidateSha256', 'reviewerAgent', 'inventory', 'entryFiles', 'retainedObligationIds'];
  shape(manifest, [...required, 'artifactRegistry'], required, 'review parts manifest');
  insist(manifest.schemaVersion === 1, 'Manifest requires schemaVersion 1');
  insist(sha(manifest.scanSha256) && manifest.scanSha256 === paper.scan.sha256, 'Manifest scanSha256 differs from current snapshot');
  insist(sha(manifest.candidateSha256) && manifest.candidateSha256 === paper.staged.candidate.sha256, 'Manifest candidateSha256 differs from current staged snapshot');
  insist(manifest.reviewerAgent === paper.owner.agent, 'Manifest reviewerAgent differs from registered owner');
  inventoryShape(manifest.inventory);
  stringArray(manifest.retainedObligationIds, 'retainedObligationIds');
  insist(Array.isArray(manifest.entryFiles), 'entryFiles must be an explicit ref array');
  const entries = [], partRefs = [], inputPaths = new Set([key(manifestPath)]);
  for (const ref of manifest.entryFiles) {
    shape(ref, ['path', 'sha256'], ['path', 'sha256'], 'entry file reference');
    insist(text(ref.path) && sha(ref.sha256), 'Entry files require exact path/SHA256');
    const filename = scoped(root, reviewRoot, ref.path);
    insist(!inputPaths.has(key(filename)), 'Duplicate entry file path or manifest alias');
    inputPaths.add(key(filename));
    const checkedRef = {path: filename, sha256: ref.sha256};
    const part = bound(root, checkedRef);
    shape(part, ['entries'], ['entries'], 'entry part');
    insist(Array.isArray(part.entries), 'Part entries must be an explicit array');
    part.entries.forEach(entryShape);
    entries.push(...part.entries);
    partRefs.push(checkedRef);
  }
  const candidate = bound(root, paper.staged.candidate);
  insist(candidate.paperId === paperId && candidate.revision === paper.iteration && candidate.scanSha256 === paper.scan.sha256, 'Staged candidate paper/revision/scan mismatch');
  const diagnostics = coverageDiagnostics(candidate, entries, manifest.retainedObligationIds);
  const exactCoverage = Object.values(diagnostics).every(value => value.count === 0);
  const recheck = () => {
    // The entire paper row binds owner, phase, current stage and iteration. A
    // different paper may legitimately advance the global ledger concurrently.
    insist(canonical(loadPaper(root, paperId).paper) === canonical(paper), 'Paper ownership/stage/version changed during assembly; no output written');
    checkRef(root, manifestRef);
    for (const ref of partRefs) { scoped(root, reviewRoot, ref.path); checkRef(root, ref); }
    checkRef(root, paper.staged.candidate);
  };
  if (!exactCoverage) {
    recheck();
    insist(command === 'check', 'Review obligation coverage has missing, duplicate, unknown or entry/retained-overlap IDs: ' + canonical(diagnostics));
    return {paperId, valid: false, diagnostics, ledgerWritten: false, scientificAcceptance: false};
  }
  const spec = {schemaVersion: 1, inventory: manifest.inventory, entries, retainedObligationIds: manifest.retainedObligationIds};
  if (Object.hasOwn(manifest, 'artifactRegistry')) spec.artifactRegistry = manifest.artifactRegistry;
  // Only an in-memory merge. The original assembler invokes the unchanged core
  // validator, including independent evidence, partial/gap and retention gates.
  const assembled = await assembleReview({root, scan, candidate, candidateSha256: manifest.candidateSha256,
    spec, reviewer: manifest.reviewerAgent, worker: paper.staged.worker, previous: previousFor(root, paper)});
  recheck();
  if (command === 'check') return {paperId, valid: true, diagnostics, ledgerWritten: false, scientificAcceptance: false};
  const outputPath = scoped(root, reviewRoot, args[1]);
  insist(outputPath.endsWith('.json'), 'Output must be JSON');
  insist(!inputPaths.has(key(outputPath)), 'Output cannot overwrite manifest or entry parts');
  writeOnceOrMatch(outputPath, canonical(assembled.review));
  return {paperId, output: fileRef(root, outputPath), valid: assembled.check.valid,
    ledgerWritten: false, scientificAcceptance: false,
    next: 'Report this path to the supervisor. The unchanged coverage review/decide workflow is still required.'};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  runReviewParts(root, process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value, null, 2) + '\n'))
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
