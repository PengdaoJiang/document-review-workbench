// Neutral coverage provenance and shape checks. No execution, initialization,
// publication, scientific judgment, or writes are performed by this module.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {verifyResult} from '../../../reproduction_clean/runtime/results.mjs';
import {scanTex} from '../../coverage-scan.mjs';

import {resolveSourceView} from './source-binding.mjs';

const SHA = /^[a-f0-9]{64}$/;
const PAPER = /^(origin|r\d{4})$/;
const DIMENSIONS = ['formulaDerivation', 'algorithmValidation', 'simulationValidation', 'statementValidation'];
const METHODS = ['analytic_derivation', 'symbolic_identity', 'formal_proof', 'numeric_test', 'statistical_estimate', 'implementation_test', 'source_consistency', 'counterexample'];
const EXECUTED = new Set(['symbolic_identity', 'formal_proof', 'numeric_test', 'statistical_estimate', 'implementation_test']);
const cleanRelative = 'research_followup/reproduction_clean';
const requireThat = (ok, message) => { if (!ok) throw new Error('Coverage: ' + message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function shape(value, fields, required, label) {
  requireThat(plain(value), label + ' must be an object');
  for (const key of Object.keys(value)) requireThat(fields.includes(key), label + ': unexpected field ' + key);
  for (const key of required) requireThat(Object.hasOwn(value, key), label + ': missing ' + key);
}
function strings(value, label, nonempty = false) {
  requireThat(Array.isArray(value) && value.every(text) && (!nonempty || value.length > 0), label + ' must be a string array' + (nonempty ? ' with at least one entry' : ''));
}
function unique(value, label) {
  requireThat(Array.isArray(value) && new Set(value).size === value.length, label + ' contains duplicates or is not an array');
}
function sameSet(value, expected, label) {
  unique(value, label);
  requireThat(value.length === expected.length && value.every(x => expected.includes(x)), label + ' must exactly cover the expected IDs');
}
export function canonical(value) {
  function stable(v) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') { requireThat(Number.isFinite(v), 'non-finite canonical number'); return v; }
    if (Array.isArray(v)) return v.map(stable);
    requireThat(plain(v), 'canonical value must contain only JSON values');
    return Object.fromEntries(Object.keys(v).sort().map(key => [key, stable(v[key])]));
  }
  return JSON.stringify(stable(value));
}
export function hash(bytes) {
  requireThat(typeof bytes === 'string' || bytes instanceof Uint8Array, 'hash expects text or bytes');
  return createHash('sha256').update(bytes).digest('hex');
}
const objectHash = value => hash(canonical(value));
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
function contained(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return !!rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}
function safeFile(root, filename) {
  requireThat(text(root) && path.isAbsolute(root) && text(filename) && !/[\x00-\x1f]/.test(filename), 'invalid root or file path');
  const inputParts = filename.replaceAll('\\', '/').split('/');
  requireThat(!inputParts.includes('..') && !inputParts.includes('.'), 'relative traversal is forbidden');
  const absolute = path.resolve(root, filename);
  requireThat(contained(root, absolute), 'file is outside the project root: ' + filename);
  const suffix = absolute.slice(path.parse(absolute).root.length);
  requireThat(!suffix.includes(':'), 'alternate data stream is forbidden');
  let cursor = absolute;
  for (;;) {
    requireThat(!fs.lstatSync(cursor).isSymbolicLink(), 'redirected path is forbidden: ' + cursor);
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  requireThat(fs.statSync(absolute).isFile(), 'not a regular file: ' + filename);
  requireThat(pathKey(fs.realpathSync(absolute)) === pathKey(absolute), 'redirected file: ' + filename);
  return absolute;
}
/** Returns an absolute {path,sha256}; only existing root-contained files. */
export function fileRef(root, filename) {
  const absolute = safeFile(root, filename);
  return {path: absolute, sha256: hash(fs.readFileSync(absolute))};
}
/** Returns the checked absolute path, never creates or rewrites anything. */
export function checkRef(root, ref) {
  shape(ref, ['path', 'sha256'], ['path', 'sha256'], 'file reference');
  requireThat(SHA.test(ref.sha256), 'invalid file SHA256');
  const actual = fileRef(root, ref.path);
  requireThat(actual.sha256 === ref.sha256, 'file hash mismatch: ' + actual.path);
  return actual.path;
}
export function readBoundText(root, ref) {
  const bytes = fs.readFileSync(checkRef(root, ref));
  requireThat(hash(bytes) === ref.sha256, 'actual read bytes hash mismatch');
  const value = bytes.toString('utf8');
  requireThat(Buffer.from(value, 'utf8').equals(bytes), 'bound text is not valid UTF-8');
  return value;
}
function jsonRef(root, ref) { return JSON.parse(readBoundText(root, ref).replace(/^\uFEFF/, '')); }
export function sameSourceBinding(root, a, b, label = 'source binding') {
  shape(a, ['path', 'sha256'], ['path', 'sha256'], label);
  shape(b, ['path', 'sha256'], ['path', 'sha256'], label);
  requireThat(text(a.path) && text(b.path) && SHA.test(a.sha256) && SHA.test(b.sha256), 'invalid ' + label);
  sameRef(root, a, b, label);
}
function sameRef(root, a, b, label) {
  requireThat(pathKey(path.resolve(root, a.path)) === pathKey(path.resolve(root, b.path)) && a.sha256 === b.sha256, label + ' reference differs');
}
function scopedNewPath(root, paperId, filename) {
  return contained(path.join(root, cleanRelative, 'coverage_work', paperId), filename);
}
function readingResources(root, paperId, reading) {
  requireThat(reading?.paperId === paperId && reading.mode === 'dot_latex' && reading.edition?.provider === 'dot', 'scan requires the same-paper frozen Dot reading');
  requireThat(/^dot-[a-f0-9]{64}$/.test(reading.edition.version ?? '') && text(reading.edition.release) && SHA.test(reading.edition.indexSha256 ?? '') && SHA.test(reading.edition.recordSha256 ?? ''), 'incomplete frozen Dot edition binding');
  checkRef(root, reading.originalPacket);
  const gathered = [reading.primary, ...(reading.latexEntries ?? []), ...(reading.dependencies ?? []), ...(reading.assets ?? [])];
  requireThat(gathered.length > 0, 'empty reading whitelist');
  const assets = new Set((reading.assets ?? []).map(x => pathKey(path.resolve(root, x.path))));
  const seen = new Map();
  for (const ref of gathered) {
    const absolute = checkRef(root, ref), key = pathKey(absolute), old = seen.get(key);
    if (old) { requireThat(old.sha256 === ref.sha256, 'conflicting duplicate reading resource'); continue; }
    const type = /\.(tex|sty|cls|ltx|bib|txt)$/i.test(absolute) ? 'text' : assets.has(key) ? 'asset' : 'binary_dependency';
    seen.set(key, {id: 'res-' + objectHash({path: absolute, sha256: ref.sha256}), path: absolute, sha256: ref.sha256, type});
  }
  return [...seen.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function baseline(root, paperId, refs) {
  shape(refs, ['result', 'review', 'acceptance'], ['result', 'review', 'acceptance'], 'firstPass');
  const result = jsonRef(root, refs.result), review = jsonRef(root, refs.review), acceptance = jsonRef(root, refs.acceptance);
  requireThat([result, review, acceptance].every(x => x.paperId === paperId), 'first-pass paper identity mismatch');
  requireThat(acceptance.decision === 'accept_bounded' && review.recommendation === 'accept_bounded', 'first-pass result lacks bounded independent acceptance');
  requireThat(acceptance.candidateResultSha256 === refs.result.sha256 && acceptance.reviewSha256 === refs.review.sha256, 'first-pass acceptance does not bind this result and review');
  requireThat(Array.isArray(result.claims) && Array.isArray(result.contract?.claims), 'first-pass result lacks explicit claims');
  return {result, review, acceptance};
}
function textBytes(root, resource) {
  const bytes = fs.readFileSync(checkRef(root, {path: resource.path, sha256: resource.sha256}));
  requireThat(hash(bytes) === resource.sha256, 'actual source bytes hash mismatch');
  const value = bytes.toString('utf8');
  requireThat(Buffer.from(value, 'utf8').equals(bytes), 'text resource is not valid UTF-8: ' + resource.path);
  return value;
}
/** Caller obtains reading from verifyRun(...,{requireCurrentSource:false}). */
export async function makeScan({root, paperId, reading, firstPass}) {
  requireThat(PAPER.test(paperId), 'invalid paperId');
  const prior = baseline(root, paperId, firstPass);
  requireThat(prior.result.inputSha256 === reading.originalPacket.sha256, 'first-pass result used a different input packet');
  const clean = path.join(root, cleanRelative), expected = path.join(clean, 'results', paperId, prior.result.resultId + '.json');
  requireThat(pathKey(checkRef(root, firstPass.result)) === pathKey(expected), 'first-pass result is not the exact immutable result file');
  const verified = await verifyResult(clean, paperId, prior.result.resultId);
  requireThat(verified.sha256 === firstPass.result.sha256, 'first-pass frozen result failed verification');
  for (const binding of verified.record.runBindings) {
    const runRoot = path.join(clean, 'runs', paperId, binding.runId);
    const run = jsonRef(root, {path: path.join(runRoot, 'run.json'), sha256: binding.runSha256});
    requireThat(run.readingViewPath === 'reading.json', 'first-pass run has no frozen Dot reading');
    const frozenReading = jsonRef(root, {path: path.join(runRoot, 'reading.json'), sha256: run.readingViewSha256});
    requireThat(canonical(frozenReading) === canonical(reading), 'scan reading differs from the first-pass frozen run reading');
  }
  const resources = readingResources(root, paperId, reading), units = [], diagnostics = [];
  for (const resource of resources) {
    if (resource.type !== 'text') {
      units.push({id: 'unit-' + objectHash({resourceId: resource.id, sha256: resource.sha256, kind: resource.type}), resourceId: resource.id, start: null, end: null, kind: resource.type, excerptSha256: resource.sha256});
      continue;
    }
    const source = textBytes(root, resource), found = scanTex(source);
    requireThat(Array.isArray(found.math) && Array.isArray(found.blocks) && Array.isArray(found.diagnostics), 'scanner returned an invalid result');
    for (const range of [...found.math, ...found.blocks].sort((a, b) => a.start - b.start || a.end - b.end || String(a.kind).localeCompare(String(b.kind)))) {
      requireThat(Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start && range.end <= source.length && text(range.kind), 'scanner returned an invalid range');
      const body = {resourceId: resource.id, start: range.start, end: range.end, kind: range.kind, excerptSha256: hash(source.slice(range.start, range.end))};
      units.push({id: 'unit-' + objectHash({sha256: resource.sha256, ...body}), ...body});
    }
    for (const diagnostic of found.diagnostics) {
      requireThat(plain(diagnostic), 'scanner diagnostic must be an object');
      const body = {...diagnostic, resourceId: resource.id};
      delete body.id;
      diagnostics.push({id: 'diag-' + objectHash({sha256: resource.sha256, ...body}), ...body});
    }
  }
  unique(units.map(x => x.id), 'scan units'); unique(diagnostics.map(x => x.id), 'scan diagnostics');
  return {schemaVersion: 1, paperId, inputVersion: reading.edition.version, reading, firstPass, resources, units, diagnostics};
}
function candidateStructure(root, scan, scanSha256, candidate, previous) {
  const fields = ['schemaVersion', 'sourceBinding', 'paperId', 'revision', 'scanSha256', 'predecessorSha256', 'author', 'inventory', 'assessments'];
  shape(candidate, [...fields, 'changeImpact'], fields, 'candidate');
  requireThat(candidate.schemaVersion === 2 && candidate.paperId === scan.paperId && candidate.scanSha256 === scanSha256, 'candidate scan/paper identity mismatch');
  requireThat(Number.isInteger(candidate.revision) && candidate.revision >= 1 && text(candidate.author), 'candidate requires an actual author and integer revision');
  if (previous) {
    requireThat(previous.candidate.schemaVersion === 2, 'previous candidate requires source-binding schema');
    sameSourceBinding(root, candidate.sourceBinding, previous.candidate.sourceBinding, 'previous source binding');
    for (const value of [previous.review, previous.decision].filter(Boolean)) {
      requireThat(value.schemaVersion === 2, 'previous snapshot requires source-binding schema');
      sameSourceBinding(root, candidate.sourceBinding, value.sourceBinding, 'previous snapshot source binding');
    }
    requireThat(previous.sha256 === objectHash(previous.candidate), 'previous candidate hash mismatch');
    requireThat(previous.candidate.paperId === candidate.paperId && previous.candidate.scanSha256 === scanSha256, 'previous candidate belongs to another paper/scan');
    requireThat(candidate.predecessorSha256 === previous.sha256 && candidate.revision === previous.candidate.revision + 1, 'candidate predecessor/revision mismatch');
  } else requireThat(candidate.predecessorSha256 === null && candidate.revision === 1, 'first candidate requires revision 1 and null predecessor');
  shape(candidate.inventory, ['items', 'unitDispositions', 'diagnosticDispositions', 'complete'], ['items', 'unitDispositions', 'diagnosticDispositions', 'complete'], 'inventory');
  requireThat(typeof candidate.inventory.complete === 'boolean' && Array.isArray(candidate.inventory.items) && candidate.inventory.items.length > 0, 'inventory must explicitly contain nonempty items');
  requireThat(Array.isArray(candidate.assessments), 'assessments must be an array');
}
function previousDefinitions(previous, items, obligations) {
  if (!previous) return;
  for (const old of previous.candidate.inventory.items) {
    requireThat(items.has(old.id), 'cannot delete an existing item: ' + old.id);
    for (const obligation of old.obligations) requireThat(obligations.has(obligation.id), 'cannot delete an existing obligation: ' + obligation.id);
  }
}
function closure(items, id, visiting = new Set(), output = new Set()) {
  requireThat(!visiting.has(id), 'cyclic item dependency at ' + id);
  if (output.has(id)) return output;
  const item = items.get(id); requireThat(item, 'unknown item dependency: ' + id);
  visiting.add(id);
  for (const dependency of item.dependencies) closure(items, dependency, visiting, output);
  visiting.delete(id); output.add(id); return output;
}
function checkReceipt(root, scan, sourceView, execution, artifacts) {
  const paperId = scan.paperId;
  shape(execution, ['receipt'], ['receipt'], 'execution');
  const receiptPath = checkRef(root, execution.receipt);
  requireThat(scopedNewPath(root, paperId, receiptPath), 'new execution receipt is outside the paper coverage roots');
  const receipt = jsonRef(root, execution.receipt);
  const fields = ['schemaVersion', 'paperId', 'tool', 'version', 'command', 'invocation', 'workerCount', 'startedAt', 'finishedAt', 'exitCode', 'inputs', 'outputs'];
  shape(receipt, fields, ['paperId', 'tool', 'version', 'workerCount', 'startedAt', 'finishedAt', 'exitCode', 'inputs', 'outputs'], 'execution receipt');
  requireThat(receipt.paperId === paperId && text(receipt.tool) && text(receipt.version) && Number.isInteger(receipt.workerCount) && receipt.workerCount >= 1 && receipt.exitCode === 0, 'invalid execution identity/tool/workerCount/exitCode');
  requireThat(receipt.schemaVersion === undefined || receipt.schemaVersion === 1, 'unsupported execution receipt schema');
  const invocation = receipt.command ?? receipt.invocation;
  requireThat((Object.hasOwn(receipt, 'command') !== Object.hasOwn(receipt, 'invocation')) && (text(invocation) || (Array.isArray(invocation) && invocation.length > 0 && invocation.every(text)) || (plain(invocation) && Object.keys(invocation).length > 0)), 'receipt needs exactly one nonempty command or invocation');
  requireThat(Number.isFinite(Date.parse(receipt.startedAt)) && Number.isFinite(Date.parse(receipt.finishedAt)) && Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt), 'invalid execution time range');
  requireThat(Array.isArray(receipt.inputs) && receipt.inputs.length > 0 && Array.isArray(receipt.outputs) && receipt.outputs.length > 0, 'receipt needs actual input and output references');
  const academic = [scan.reading.originalPacket, scan.reading.primary, ...(scan.reading.original ? [scan.reading.original] : []), ...(scan.reading.latexEntries ?? []), ...(scan.reading.dependencies ?? []), ...(scan.reading.assets ?? []), ...Object.values(scan.firstPass), ...sourceView.additionalResources.map(({path, sha256}) => ({path, sha256}))];
  for (const ref of receipt.inputs) {
    const absolute = checkRef(root, ref);
    requireThat(scopedNewPath(root, paperId, absolute) || contained(path.join(root, cleanRelative, 'runs', paperId), absolute) || academic.some(x => pathKey(path.resolve(root, x.path)) === pathKey(absolute) && x.sha256 === ref.sha256), 'execution input is outside the same-paper source/evidence scope');
  }
  for (const ref of receipt.outputs) requireThat(scopedNewPath(root, paperId, checkRef(root, ref)), 'execution output is outside the paper coverage roots');
  for (const artifact of artifacts) requireThat(receipt.outputs.some(ref => pathKey(path.resolve(root, ref.path)) === pathKey(path.resolve(root, artifact.path)) && ref.sha256 === artifact.sha256), 'execution output inventory does not cover an artifact');
}
async function evidenceCheck(root, scan, sourceView, evidence, legacyCache, decisive) {
  shape(evidence, ['kind', 'method', 'artifacts', 'mapping', 'legacy', 'execution'], ['kind', 'method', 'artifacts', 'mapping'], 'evidence');
  requireThat(['reuse', 'new'].includes(evidence.kind) && METHODS.includes(evidence.method), 'invalid evidence kind/method');
  shape(evidence.mapping, ['scope', 'conditions', 'dependencyCompatibility'], ['scope', 'conditions', 'dependencyCompatibility'], 'evidence mapping');
  for (const key of ['scope', 'conditions', 'dependencyCompatibility']) requireThat(text(evidence.mapping[key]), 'evidence mapping needs explicit ' + key);
  requireThat(Array.isArray(evidence.artifacts) && evidence.artifacts.length > 0, 'evidence needs actual artifacts, not only a result reference');
  const artifactPaths = evidence.artifacts.map(ref => checkRef(root, ref));
  unique(artifactPaths.map(pathKey), 'evidence artifacts');
  if (evidence.kind === 'new') {
    requireThat(!Object.hasOwn(evidence, 'legacy'), 'new evidence cannot carry legacy approval');
    for (const absolute of artifactPaths) requireThat(scopedNewPath(root, scan.paperId, absolute), 'new evidence artifact is outside the paper coverage roots');
    if (EXECUTED.has(evidence.method)) requireThat(evidence.execution, 'computed evidence requires an execution receipt');
    if (evidence.execution) checkReceipt(root, scan, sourceView, evidence.execution, evidence.artifacts);
    return;
  }
  requireThat(!Object.hasOwn(evidence, 'execution'), 'reuse uses frozen execution receipts, not a replacement execution claim');
  shape(evidence.legacy, ['result', 'claimIds', 'review', 'acceptance'], ['result', 'claimIds', 'review', 'acceptance'], 'legacy evidence');
  for (const key of ['result', 'review', 'acceptance']) { sameRef(root, evidence.legacy[key], scan.firstPass[key], 'legacy ' + key); checkRef(root, evidence.legacy[key]); }
  strings(evidence.legacy.claimIds, 'legacy claimIds', true); unique(evidence.legacy.claimIds, 'legacy claimIds');
  if (!legacyCache.value) {
    const prior = baseline(root, scan.paperId, scan.firstPass);
    const expected = path.join(root, cleanRelative, 'results', scan.paperId, prior.result.resultId + '.json');
    requireThat(pathKey(checkRef(root, scan.firstPass.result)) === pathKey(expected), 'legacy result must be the exact immutable result file');
    const verified = await verifyResult(path.join(root, cleanRelative), scan.paperId, prior.result.resultId);
    requireThat(verified.sha256 === scan.firstPass.result.sha256, 'legacy frozen result verification failed');
    legacyCache.value = verified.record;
  }
  const result = legacyCache.value, permitted = [];
  for (const claimId of evidence.legacy.claimIds) {
    const claim = result.claims.find(x => x.claimId === claimId);
    requireThat(claim && result.contract.claims.some(x => x.claimId === claimId), 'unknown legacy claim: ' + claimId);
    for (const ref of claim.evidence) permitted.push({path: path.join(root, cleanRelative, 'runs', scan.paperId, ref.runId, ref.path), sha256: ref.sha256, role: ref.role, runId: ref.runId, relative: ref.path});
  }
  const roles = {symbolic_identity: ['symbolic'], formal_proof: ['formal'], numeric_test: ['numeric'], statistical_estimate: ['numeric'], implementation_test: ['numeric', 'runtime_performance'], analytic_derivation: ['source_review'], source_consistency: ['source_review'], counterexample: ['source_review', 'symbolic', 'numeric', 'formal']};
  for (const artifact of evidence.artifacts) {
    const matches = permitted.filter(ref => pathKey(ref.path) === pathKey(path.resolve(root, artifact.path)) && ref.sha256 === artifact.sha256 && roles[evidence.method].includes(ref.role));
    requireThat(matches.length > 0, 'reuse artifact is not exact matching claim evidence with the required evidence role');
    if (decisive) for (const match of matches) {
      if (!match.relative.startsWith('chunks/')) continue;
      const parts = /^chunks\/([^/]+)\/(attempt-\d{4}\.(completed|failed))\//.exec(match.relative);
      requireThat(parts && parts[3] === 'completed', 'failed legacy execution cannot support a decisive assessment');
      const receiptFile = path.join(root, cleanRelative, 'runs', scan.paperId, match.runId, 'chunks', parts[1], parts[2], 'receipt.json');
      const receipt = jsonRef(root, fileRef(root, receiptFile));
      requireThat(receipt.state === 'completed' && receipt.exitCode === 0 && receipt.signal == null && receipt.error == null && !receipt.integrityError, 'legacy computed evidence lacks successful completed execution');
    }
  }
}
/** Strict schema: unknown candidate/item/obligation/assessment/evidence fields fail. */
export async function validateCandidate({root, scan, scanSha256, candidate, previous = null}) {
  requireThat(SHA.test(scanSha256 ?? '') && scanSha256 === objectHash(scan), 'scan hash mismatch; use canonical frozen scan bytes');
  const rebuilt = await makeScan({root, paperId: scan.paperId, reading: scan.reading, firstPass: scan.firstPass});
  requireThat(canonical(rebuilt) === canonical(scan), 'scan no longer matches source bytes or scanner output');
  candidateStructure(root, scan, scanSha256, candidate, previous);
  const sourceView = resolveSourceView({root, scan, sourceBinding: candidate.sourceBinding});
  const items = new Map(), obligations = new Map(), unitMap = new Map(sourceView.units.map(x => [x.id, x])), resourceMap = new Map(sourceView.resources.map(x => [x.id, x]));
  const itemHashes = {}, sourceTexts = new Map();
  for (const item of candidate.inventory.items) {
    const fields = ['id', 'kind', 'text', 'locators', 'conditions', 'units', 'dependencies', 'obligations'];
    shape(item, fields, fields, 'item');
    requireThat(new RegExp('^' + scan.paperId + ':i[0-9]{4,}$').test(item.id ?? '') && !items.has(item.id), 'invalid/duplicate item ID');
    requireThat(['formula', 'statement'].includes(item.kind) && text(item.text) && text(item.units), 'item needs kind/text/explicit units');
    strings(item.conditions, 'item conditions'); strings(item.dependencies, 'item dependencies'); unique(item.dependencies, 'item dependencies');
    requireThat(Array.isArray(item.locators) && item.locators.length > 0, 'item needs actual source locators');
    for (const locator of item.locators) {
      const unit = unitMap.get(locator.unitId); requireThat(unit, 'locator references an unknown unit');
      const resource = resourceMap.get(unit.resourceId);
      if (resource.type !== 'text') {
        shape(locator, ['unitId', 'semantic'], ['unitId', 'semantic'], 'binary locator');
        requireThat(text(locator.semantic), 'binary locator needs a specific semantic location');
      } else {
        shape(locator, ['unitId', 'start', 'end', 'excerptSha256'], ['unitId', 'start', 'end', 'excerptSha256'], 'text locator');
        requireThat(Number.isInteger(locator.start) && Number.isInteger(locator.end) && locator.start >= unit.start && locator.end <= unit.end && locator.end > locator.start, 'locator must be a nonempty subrange of its source unit');
        if (!sourceTexts.has(resource.id)) sourceTexts.set(resource.id, textBytes(root, resource));
        requireThat(hash(sourceTexts.get(resource.id).slice(locator.start, locator.end)) === locator.excerptSha256, 'locator excerpt hash mismatch');
      }
    }
    unique(item.locators.map(canonical), 'item locators');
    requireThat(Array.isArray(item.obligations) && item.obligations.length > 0, 'item must have explicit obligations, including definitions/NA');
    for (const obligation of item.obligations) {
      const fields = ['id', 'dimension', 'kind', 'statement', 'conditions', 'successCriterion'];
      shape(obligation, fields, fields, 'obligation');
      requireThat(new RegExp('^' + item.id + ':o[0-9]{2,}$').test(obligation.id ?? '') && !obligations.has(obligation.id), 'invalid/duplicate obligation ID');
      requireThat(DIMENSIONS.includes(obligation.dimension) && ['analytic', 'identity', 'empirical', 'algorithm', 'definition'].includes(obligation.kind) && text(obligation.statement) && text(obligation.successCriterion), 'obligation needs explicit kind/dimension/statement/success criterion');
      strings(obligation.conditions, 'obligation conditions'); obligations.set(obligation.id, {itemId: item.id, definition: obligation});
    }
    items.set(item.id, item); itemHashes[item.id] = objectHash(item);
  }
  previousDefinitions(previous, items, obligations);
  const dependencies = new Map([...items.keys()].map(id => [id, [...closure(items, id)].sort()]));
  if (Object.hasOwn(candidate, 'changeImpact')) {
    requireThat(Array.isArray(candidate.changeImpact), 'changeImpact must be an array');
    unique(candidate.changeImpact.map(x => x.obligationId), 'changeImpact obligations');
    if (candidate.changeImpact.length) {
      requireThat(previous?.review && previous?.decision, 'changeImpact requires the previous independent review and decision');
      reviewShape(root, scan, previous.candidate, previous.sha256, previous.review, sourceView);
      decisionShape(root, scan, previous.candidate, previous.review, previous.decision);
    }
    for (const impact of candidate.changeImpact) {
      shape(impact, ['obligationId', 'reason', 'dependsOnChangedItems'], ['obligationId', 'reason', 'dependsOnChangedItems'], 'change impact');
      const obligation = obligations.get(impact.obligationId);
      requireThat(previous?.decision?.acceptedObligationIds?.includes(impact.obligationId) && obligation && text(impact.reason), 'changeImpact is only for a previously accepted existing obligation with a concrete reason');
      strings(impact.dependsOnChangedItems, 'dependsOnChangedItems', true); unique(impact.dependsOnChangedItems, 'dependsOnChangedItems');
      for (const itemId of impact.dependsOnChangedItems) {
        const old = previous.candidate.inventory.items.find(x => x.id === itemId);
        requireThat(items.has(itemId) && dependencies.get(obligation.itemId).includes(itemId) && (!old || objectHash(old) !== itemHashes[itemId]), 'changeImpact must identify genuinely changed items in this obligation dependency closure');
      }
    }
  }
  const dispositions = candidate.inventory.unitDispositions;
  requireThat(Array.isArray(dispositions), 'unitDispositions must be an array');
  sameSet(dispositions.map(x => x.unitId), [...unitMap.keys()], 'unit dispositions');
  for (const disposition of dispositions) {
    shape(disposition, ['unitId', 'itemIds', 'reason'], ['unitId', 'itemIds', 'reason'], 'unit disposition');
    strings(disposition.itemIds, 'disposition itemIds'); unique(disposition.itemIds, 'disposition itemIds'); requireThat(text(disposition.reason), 'unit disposition needs a reason');
    for (const id of disposition.itemIds) requireThat(items.get(id)?.locators.some(loc => loc.unitId === disposition.unitId), 'unit disposition item has no matching locator');
    for (const item of items.values()) if (item.locators.some(loc => loc.unitId === disposition.unitId)) requireThat(disposition.itemIds.includes(item.id), 'unit disposition omits a located item');
  }
  const diagnostics = candidate.inventory.diagnosticDispositions;
  requireThat(Array.isArray(diagnostics), 'diagnosticDispositions must be an array');
  sameSet(diagnostics.map(x => x.diagnosticId), scan.diagnostics.map(x => x.id), 'diagnostic dispositions');
  for (const disposition of diagnostics) {
    shape(disposition, ['diagnosticId', 'resolved', 'reason'], ['diagnosticId', 'resolved', 'reason'], 'diagnostic disposition');
    requireThat(typeof disposition.resolved === 'boolean' && text(disposition.reason), 'diagnostic needs an explicit resolution and reason');
  }
  requireThat(!candidate.inventory.complete || diagnostics.every(x => x.resolved), 'complete inventory cannot retain unresolved parser diagnostics');
  sameSet(candidate.assessments.map(x => x.obligationId), [...obligations.keys()], 'assessments');
  // makeScan just reverified every bound run; reuse that checked exact result
  // within this validation only, while each evidence reference is re-hashed.
  const legacyCache = {value: baseline(root, scan.paperId, scan.firstPass).result}, assessmentHashes = {};
  for (const assessment of candidate.assessments) {
    const fields = ['obligationId', 'status', 'outcome', 'summary', 'limitations', 'basisItemHashes', 'evidence', 'applicabilityReason', 'blocker'];
    shape(assessment, fields, ['obligationId', 'status', 'outcome', 'summary', 'limitations', 'basisItemHashes', 'evidence'], 'assessment');
    requireThat(['pending', 'internal_gap', 'external_blocked', 'accepted'].includes(assessment.status) && ['supported', 'refuted', 'partial', 'inconclusive', 'not_applicable'].includes(assessment.outcome) && text(assessment.summary), 'invalid scoped assessment');
    strings(assessment.limitations, 'assessment limitations');
    const obligation = obligations.get(assessment.obligationId), expected = Object.fromEntries(dependencies.get(obligation.itemId).map(id => [id, itemHashes[id]]));
    requireThat(canonical(assessment.basisItemHashes) === canonical(expected), 'stale or incomplete transitive basisItemHashes for ' + assessment.obligationId);
    requireThat(Array.isArray(assessment.evidence), 'assessment evidence must be an array');
    for (const evidence of assessment.evidence) await evidenceCheck(root, scan, sourceView, evidence, legacyCache, assessment.status === 'accepted');
    if (assessment.status === 'accepted') {
      requireThat(['supported', 'refuted', 'not_applicable'].includes(assessment.outcome) && assessment.evidence.length > 0, 'accepted assessment needs decisive scoped evidence');
      const methods = assessment.evidence.map(x => x.method);
      if (assessment.outcome === 'not_applicable') requireThat(text(assessment.applicabilityReason) && methods.includes('source_consistency'), 'not_applicable needs a reason and source-consistency evidence');
      if (assessment.outcome === 'refuted') requireThat(methods.includes('counterexample'), 'refuted needs explicit counterexample evidence');
      if (assessment.outcome === 'supported') {
        const adequate = {analytic: ['analytic_derivation', 'formal_proof'], identity: ['analytic_derivation', 'formal_proof', 'symbolic_identity'], empirical: ['numeric_test', 'statistical_estimate', 'implementation_test'], algorithm: ['analytic_derivation', 'formal_proof', 'implementation_test'], definition: ['source_consistency', 'analytic_derivation', 'formal_proof']};
        requireThat(methods.some(x => adequate[obligation.definition.kind].includes(x)), 'evidence method cannot support this obligation kind; numeric agreement is not a general proof');
      }
    }
    if (assessment.outcome === 'not_applicable') requireThat(text(assessment.applicabilityReason), 'NA must have an explicit applicabilityReason');
    else requireThat(!Object.hasOwn(assessment, 'applicabilityReason'), 'applicabilityReason belongs only to NA');
    if (assessment.status === 'external_blocked') {
      shape(assessment.blocker, ['missing', 'affectedObligations', 'attemptedAlternatives', 'whyExternal', 'releaseCondition'], ['missing', 'affectedObligations', 'attemptedAlternatives', 'whyExternal', 'releaseCondition'], 'external blocker');
      for (const key of ['missing', 'whyExternal', 'releaseCondition']) requireThat(text(assessment.blocker[key]), 'external blocker needs ' + key);
      strings(assessment.blocker.attemptedAlternatives, 'attemptedAlternatives', true); strings(assessment.blocker.affectedObligations, 'affectedObligations', true); unique(assessment.blocker.affectedObligations, 'affectedObligations');
      requireThat(assessment.blocker.affectedObligations.includes(assessment.obligationId) && assessment.blocker.affectedObligations.every(id => obligations.has(id)), 'blocker must identify this and only existing obligations');
    } else requireThat(!Object.hasOwn(assessment, 'blocker'), 'only external_blocked may carry an external blocker');
    assessmentHashes[assessment.obligationId] = objectHash(assessment);
  }
  sourceView.recheck();
  return {valid: true, verification: 'mechanical_provenance_and_structure_not_scientific_acceptance', itemHashes, assessmentHashes, metrics: counts(candidate), requiredUnitExclusions: dispositions.filter(x => x.itemIds.length === 0 && unitMap.get(x.unitId).kind !== 'text_block').map(x => x.unitId)};
}
function reviewShape(root, scan, candidate, candidateSha256, review, sourceView) {
  const fields = ['schemaVersion', 'sourceBinding', 'paperId', 'revision', 'scanSha256', 'candidateSha256', 'reviewerAgent', 'inventory', 'entries', 'retainedObligationIds'];
  shape(review, fields, fields, 'review');
  requireThat(review.schemaVersion === 2 && review.paperId === candidate.paperId && review.revision === candidate.revision && review.scanSha256 === candidate.scanSha256 && review.candidateSha256 === candidateSha256 && candidateSha256 === objectHash(candidate), 'review does not bind the exact candidate/scan/revision');
  sameSourceBinding(root, review.sourceBinding, candidate.sourceBinding, 'review source binding');
  requireThat(text(review.reviewerAgent) && review.reviewerAgent !== candidate.author, 'review identity cannot be empty or the candidate author');
  requireThat(candidate.scanSha256 === objectHash(scan), 'review scan hash mismatch');
  const fields2 = ['complete', 'resourceIds', 'checkedAllUnits', 'missingItems', 'notes', 'unitExclusions'];
  shape(review.inventory, fields2, fields2, 'review inventory');
  sameSet(review.inventory.resourceIds, sourceView.resources.map(x => x.id), 'review resources');
  requireThat(typeof review.inventory.complete === 'boolean' && review.inventory.checkedAllUnits === true && text(review.inventory.notes), 'review must explicitly inspect all units and explain inventory coverage');
  strings(review.inventory.missingItems, 'missingItems');
  requireThat(!review.inventory.complete || (candidate.inventory.complete && review.inventory.missingItems.length === 0), 'complete review inventory conflicts with candidate or missing items');
  requireThat(Array.isArray(review.entries) && Array.isArray(review.retainedObligationIds), 'review entries/retained IDs must be arrays');
  sameSet([...review.entries.map(x => x.obligationId), ...review.retainedObligationIds], candidate.assessments.map(x => x.obligationId), 'review obligation coverage');
}
function decisionShape(root, scan, candidate, review, decision) {
  const fields = ['schemaVersion', 'sourceBinding', 'paperId', 'revision', 'scanSha256', 'candidateSha256', 'reviewSha256', 'decision', 'acceptedObligationIds', 'inventoryAccepted', 'supervisor', 'rationale'];
  shape(decision, fields, fields, 'decision');
  requireThat(decision.schemaVersion === 2 && decision.paperId === candidate.paperId && decision.revision === candidate.revision && decision.scanSha256 === objectHash(scan) && decision.candidateSha256 === objectHash(candidate) && decision.reviewSha256 === objectHash(review), 'decision does not bind exact scan/candidate/review');
  sameSourceBinding(root, decision.sourceBinding, candidate.sourceBinding, 'decision source binding');
  requireThat(decision.decision === 'accept_snapshot' && text(decision.supervisor) && text(decision.rationale) && typeof decision.inventoryAccepted === 'boolean', 'decision needs actual supervisor and scoped rationale');
  strings(decision.acceptedObligationIds, 'acceptedObligationIds'); unique(decision.acceptedObligationIds, 'acceptedObligationIds');
  const accepted = new Set([...review.entries.filter(x => x.verdict === 'accept').map(x => x.obligationId), ...review.retainedObligationIds]);
  for (const id of decision.acceptedObligationIds) requireThat(accepted.has(id) && candidate.assessments.some(x => x.obligationId === id && x.status === 'accepted'), 'decision cannot settle an unaccepted/incomplete obligation: ' + id);
  requireThat(!decision.inventoryAccepted || (candidate.inventory.complete && review.inventory.complete && review.inventory.missingItems.length === 0), 'cannot accept an incomplete inventory');
}
export async function validateReview({root, scan, candidate, candidateSha256, review, reviewer, worker, previous = null}) {
  const checked = await validateCandidate({root, scan, scanSha256: objectHash(scan), candidate, previous});
  const sourceView = resolveSourceView({root, scan, sourceBinding: candidate.sourceBinding});
  reviewShape(root, scan, candidate, candidateSha256, review, sourceView);
  requireThat(text(reviewer) && text(worker) && reviewer !== worker && candidate.author === worker && review.reviewerAgent === reviewer, 'reviewer must be the actually registered different agent');
  requireThat(Array.isArray(review.inventory.unitExclusions), 'review must explicitly inspect excluded non-text units');
  sameSet(review.inventory.unitExclusions.map(x => x.unitId), checked.requiredUnitExclusions, 'review unit exclusions');
  for (const exclusion of review.inventory.unitExclusions) { shape(exclusion, ['unitId', 'reason'], ['unitId', 'reason'], 'review unit exclusion'); requireThat(text(exclusion.reason), 'independent exclusion needs a reason'); }
  for (const entry of review.entries) {
    shape(entry, ['obligationId', 'assessmentSha256', 'verdict', 'reason', 'evidence'], ['obligationId', 'assessmentSha256', 'verdict', 'reason', 'evidence'], 'review entry');
    requireThat(entry.assessmentSha256 === checked.assessmentHashes[entry.obligationId] && ['accept', 'needs_work'].includes(entry.verdict) && text(entry.reason), 'review entry has stale assessment or missing verdict/reason');
    requireThat(Array.isArray(entry.evidence) && (entry.verdict !== 'accept' || entry.evidence.length > 0), 'accepted independent review needs supporting evidence');
    const assessment = candidate.assessments.find(x => x.obligationId === entry.obligationId);
    const reusedOnly = assessment.evidence.length > 0 && assessment.evidence.every(x => x.kind === 'reuse');
    const reusedRefs = [scan.firstPass.review, ...assessment.evidence.filter(x => x.kind === 'reuse').flatMap(x => x.artifacts)];
    let independentSupport = false;
    for (const ref of entry.evidence) {
      const absolute = checkRef(root, ref);
      const ownReview = contained(path.join(root, cleanRelative, 'coverage_verifications', scan.paperId), absolute);
      if (ownReview) requireThat(!candidate.assessments.some(value => value.evidence.some(item => item.artifacts.some(artifact => artifact.sha256 === ref.sha256 || pathKey(path.resolve(root, artifact.path)) === pathKey(absolute)))), 'independent review artifact aliases constructor evidence by path or SHA256');
      const legacySupport = reusedOnly && reusedRefs.some(x => pathKey(path.resolve(root, x.path)) === pathKey(absolute) && x.sha256 === ref.sha256);
      requireThat(ownReview || legacySupport, 'review evidence must be this paper independent coverage evidence or exact reused evidence');
      independentSupport ||= ownReview || legacySupport;
    }
    if (entry.verdict === 'accept') requireThat(independentSupport, 'independent acceptance cannot be based only on constructor artifacts');
  }
  if (review.retainedObligationIds.length) {
    requireThat(previous?.review && previous?.decision, 'retained obligations need a previously independently accepted snapshot');
    reviewShape(root, scan, previous.candidate, previous.sha256, previous.review, sourceView);
    decisionShape(root, scan, previous.candidate, previous.review, previous.decision);
    for (const id of review.retainedObligationIds) {
      const before = previous.candidate.assessments.find(x => x.obligationId === id), current = candidate.assessments.find(x => x.obligationId === id);
      requireThat(previous.decision.acceptedObligationIds.includes(id) && before && objectHash(before) === objectHash(current), 'retained obligation is unaccepted or its assessment/dependency basis changed: ' + id);
      const priorItem = previous.candidate.inventory.items.find(x => x.obligations.some(o => o.id === id));
      requireThat(priorItem && Object.entries(current.basisItemHashes).every(([itemId, sha]) => previous.candidate.inventory.items.some(item => item.id === itemId && objectHash(item) === sha)), 'retained obligation definition or transitive dependency changed');
    }
  }
  sourceView.recheck();
  return {valid: true, verification: 'mechanical_binding_not_scientific_judgment', candidateSha256, reviewSha256: objectHash(review), acceptedObligationIds: [...review.entries.filter(x => x.verdict === 'accept').map(x => x.obligationId), ...review.retainedObligationIds], inventoryComplete: review.inventory.complete, itemHashes: checked.itemHashes, assessmentHashes: checked.assessmentHashes};
}
function counts(candidate, acceptedIds = []) {
  const settled = new Set(acceptedIds), rows = candidate.assessments, items = candidate.inventory.items;
  const accepted = rows.filter(x => settled.has(x.obligationId));
  return {items: items.length, formulas: items.filter(x => x.kind === 'formula').length, statements: items.filter(x => x.kind === 'statement').length, obligations: rows.length, settled: accepted.length,
    supported: accepted.filter(x => x.outcome === 'supported').length, refuted: accepted.filter(x => x.outcome === 'refuted').length, notApplicable: accepted.filter(x => x.outcome === 'not_applicable').length,
    partial: rows.filter(x => x.outcome === 'partial').length, internalGap: rows.filter(x => x.status === 'internal_gap').length, externalBlocked: rows.filter(x => x.status === 'external_blocked').length, pending: rows.filter(x => x.status === 'pending').length,
    awaitingAcceptance: rows.filter(x => x.status === 'accepted' && !settled.has(x.obligationId)).length, completedItems: items.filter(x => x.obligations.length > 0 && x.obligations.every(o => settled.has(o.id))).length};
}
/** Call after validateCandidate/validateReview and checked receipt-file hashes. */
export function assessCoverage({root, scan, candidate, review = null, decision = null}) {
  requireThat(candidate.paperId === scan.paperId && candidate.scanSha256 === objectHash(scan), 'coverage summary scan identity mismatch');
  requireThat(candidate.schemaVersion === 2, 'coverage requires source-binding schema');
  const sourceView = resolveSourceView({root, scan, sourceBinding: candidate.sourceBinding});
  if (review) reviewShape(root, scan, candidate, objectHash(candidate), review, sourceView);
  if (decision) { requireThat(review, 'decision requires an independent review'); decisionShape(root, scan, candidate, review, decision); }
  sourceView.recheck();
  const metrics = counts(candidate, decision?.acceptedObligationIds ?? []), inventoryAccepted = decision?.inventoryAccepted === true;
  const nonempty = metrics.items > 0 && metrics.obligations > 0 && scan.units.length > 0;
  return {...metrics, inventoryDeclaredComplete: candidate.inventory.complete, inventoryReviewedComplete: review?.inventory.complete === true, inventoryAccepted,
    coveragePercent: inventoryAccepted && nonempty ? 100 * metrics.settled / metrics.obligations : null,
    coverageComplete: inventoryAccepted && nonempty && metrics.settled === metrics.obligations && metrics.pending === 0 && metrics.internalGap === 0 && metrics.externalBlocked === 0,
    claimBoundary: 'Counts describe explicitly inventoried and independently accepted obligations, not automatic scientific correctness or full historical experiment reproduction.'};
}
