/**
 * Read-only, deterministic assembly; never a scientific decision or a writer.
 * Candidate spec (all unmarked fields required):
 * {schemaVersion:2,sourceBinding,author,inventory:{complete,items,unitRules,diagnosticDispositions},
 *  assessments,retainObligationIds:[],evidenceRegistry?:{alias:evidenceSpec},
 *  artifactRegistry?:{alias:path|{path,sha256}},changeImpact?}.
 * Items/obligations retain the core schema. Locators are core locators, or
 * {resourceId|path,quote,start?,end?}, or {resourceId|path,semantic} for assets.
 * Quotes are exact UTF-16 source slices: unique, or explicitly start/end-bound.
 * Every intersected text/math unit is mapped; absent whitespace-only scanner
 * gaps are allowed, but no non-whitespace source character may be omitted.
 * unitRules = [{selector:{resourceId|unitIds:[id],kinds?:[kind]},reason}].
 * Rules explicitly dispose unmapped units only; no filename-based exclusion.
 * Assessments retain the core scientific fields, but omit basisItemHashes.
 * Evidence may be a registry alias string/{alias}, or
 * {kind,method,artifacts:[path|{path,sha256}|{alias}],mapping,
 *  claimIds?:[id],execution?:{receipt:path|{path,sha256}|{alias}}}.
 * Reuse requires claimIds and binds exactly scan.firstPass and selected artifacts.
 * Review spec:
 * {schemaVersion:2,sourceBinding,inventory:{complete,checkedAllUnits,missingItems,notes,
 *  unitExclusions:[{unitId,reason}]},entries:[{obligationId,verdict,reason,
 *  evidence:[path|{path,sha256}|{alias}]}],retainedObligationIds:[],artifactRegistry?}.
 * Both assemblers end at the schema2 core validator with unchanged scientific gates. A caller may
 * save canonical(result.candidate/review) in its own authorized output root.
 */
import fs from 'node:fs';
import path from 'node:path';
import {canonical, hash, fileRef, checkRef, readBoundText, validateCandidate, validateReview, assessCoverage, sameSourceBinding} from './coverage-core.mjs';

import {resolveSourceView} from './source-binding.mjs';

const fail = (ok, message) => { if (!ok) throw new Error('Coverage authoring: ' + message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const text = value => typeof value === 'string' && value.trim().length > 0;
const objectHash = value => hash(canonical(value));
const clone = value => JSON.parse(canonical(value));
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const cleanRelative = 'research_followup/reproduction_clean';

function shape(value, allowed, required, label) {
  fail(plain(value), label + ' must be an object');
  for (const key of Object.keys(value)) fail(allowed.includes(key), label + ': unexpected field ' + key);
  for (const key of required) fail(Object.hasOwn(value, key), label + ': missing ' + key);
}
function array(value, label) { fail(Array.isArray(value), label + ' must be an array'); return value; }
function strings(value, label, nonempty = false) {
  array(value, label); fail(value.every(text) && (!nonempty || value.length > 0), label + ' must contain nonempty strings');
  fail(new Set(value).size === value.length, label + ' contains duplicates');
  return value;
}
function contained(directory, filename) {
  const rel = path.relative(path.resolve(directory), path.resolve(filename));
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function samePath(root, left, right) { return pathKey(path.resolve(root, left)) === pathKey(path.resolve(root, right)); }
function explicitBoolean(value, label) { fail(typeof value === 'boolean', label + ' must be explicit boolean'); }

function sourceReader(root, scan) {
  const resources = new Map(scan.resources.map(resource => [resource.id, resource]));
  const units = new Map(scan.units.map(unit => [unit.id, unit]));
  const cache = new Map();
  const read = resource => {
    if (!cache.has(resource.id)) {
      const bytes = fs.readFileSync(checkRef(root, {path: resource.path, sha256: resource.sha256}));
      fail(hash(bytes) === resource.sha256, 'actual source bytes hash mismatch');
      const source = bytes.toString('utf8');
      fail(Buffer.from(source, 'utf8').equals(bytes), 'source is not valid UTF-8');
      cache.set(resource.id, source);
    }
    return cache.get(resource.id);
  };
  return {resources, units, read};
}
function boundary(source, offset) {
  const before = source.charCodeAt(offset - 1), after = source.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}
function checkedRange(source, start, end, label) {
  fail(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= source.length, label + ' requires a nonempty in-bounds UTF-16 range');
  fail(boundary(source, start) && boundary(source, end), label + ' splits a UTF-16 surrogate pair');
}
function resolveOne(root, scan, locator, reader) {
  fail(plain(locator), 'locator must be an object');
  if (Object.hasOwn(locator, 'unitId')) {
    const unit = reader.units.get(locator.unitId); fail(unit, 'unknown locator unitId');
    const resource = reader.resources.get(unit.resourceId); fail(resource, 'unit references an unknown resource');
    if (resource.type !== 'text') {
      shape(locator, ['unitId', 'semantic'], ['unitId', 'semantic'], 'binary locator');
      fail(text(locator.semantic), 'binary locator needs explicit semantic location');
      checkRef(root, {path: resource.path, sha256: resource.sha256});
    } else {
      shape(locator, ['unitId', 'start', 'end', 'excerptSha256'], ['unitId', 'start', 'end', 'excerptSha256'], 'core text locator');
      const source = reader.read(resource);
      checkedRange(source, locator.start, locator.end, 'core locator');
      fail(locator.start >= unit.start && locator.end <= unit.end, 'core locator is outside its unit');
      fail(hash(source.slice(locator.start, locator.end)) === locator.excerptSha256, 'core locator excerpt hash mismatch');
    }
    return [clone(locator)];
  }
  shape(locator, ['resourceId', 'path', 'quote', 'start', 'end', 'semantic'], [], 'source locator');
  fail(Object.hasOwn(locator, 'resourceId') !== Object.hasOwn(locator, 'path'), 'source locator needs exactly one resourceId or path');
  let resource;
  if (Object.hasOwn(locator, 'resourceId')) {
    fail(text(locator.resourceId), 'source locator resourceId must be nonempty');
    resource = reader.resources.get(locator.resourceId);
  } else {
    fail(text(locator.path) && !locator.path.replaceAll('\\', '/').split('/').some(part => part === '.' || part === '..'), 'source locator path must be exact, without traversal');
    const matches = scan.resources.filter(value => samePath(root, value.path, locator.path));
    fail(matches.length === 1, 'source locator path must identify exactly one bound resource');
    resource = matches[0];
  }
  fail(resource, 'source locator references an unknown resource');
  const resourceUnits = scan.units.filter(unit => unit.resourceId === resource.id);
  if (resource.type !== 'text') {
    fail(!['quote', 'start', 'end'].some(key => Object.hasOwn(locator, key)) && text(locator.semantic), 'asset locator needs semantic, not a text range');
    fail(resourceUnits.length === 1, 'asset must have exactly one source unit');
    checkRef(root, {path: resource.path, sha256: resource.sha256});
    return [{unitId: resourceUnits[0].id, semantic: locator.semantic}];
  }
  fail(!Object.hasOwn(locator, 'semantic') && text(locator.quote), 'text locator needs a nonempty exact quote, not semantic');
  const source = reader.read(resource);
  fail(Object.hasOwn(locator, 'start') === Object.hasOwn(locator, 'end'), 'explicit locator range needs both start and end');
  let start, end;
  if (Object.hasOwn(locator, 'start')) {
    ({start, end} = locator);
    checkedRange(source, start, end, 'source locator');
    fail(source.slice(start, end) === locator.quote, 'quote differs from explicit source range');
  } else {
    start = source.indexOf(locator.quote);
    fail(start >= 0, 'quote not found in bound source');
    fail(source.indexOf(locator.quote, start + 1) < 0, 'ambiguous quote; provide exact start/end');
    end = start + locator.quote.length;
    checkedRange(source, start, end, 'source locator');
  }
  const intersections = resourceUnits.filter(unit => unit.start < end && unit.end > start)
    .map(unit => ({unit, start: Math.max(unit.start, start), end: Math.min(unit.end, end)}))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.unit.id.localeCompare(b.unit.id));
  fail(intersections.length > 0, 'quote has no scan-unit coverage');
  let covered = start;
  for (const part of intersections) {
    if (part.start > covered) fail(!/\S/u.test(source.slice(covered, part.start)), 'quote crosses an uncovered non-whitespace source range');
    covered = Math.max(covered, part.end);
  }
  fail(covered >= end || !/\S/u.test(source.slice(covered, end)), 'quote ends in an uncovered non-whitespace source range');
  return intersections.map(part => ({unitId: part.unit.id, start: part.start, end: part.end, excerptSha256: hash(source.slice(part.start, part.end))}));
}

/** Resolve only exact bound resources; offsets and excerpt hashes are mechanical. */
export function resolveLocators({root, scan, sourceBinding, locator}) {
  const sourceView = resolveSourceView({root, scan, sourceBinding});
  const result = resolveOne(root, sourceView, locator, sourceReader(root, sourceView));
  sourceView.recheck(); return result;
}

function artifactShape(value, label, allowAlias = true) {
  if (typeof value === 'string') { fail(text(value), label + ' path is empty'); return; }
  if (plain(value) && Object.hasOwn(value, 'alias')) {
    fail(allowAlias, label + ' registry entries cannot chain aliases');
    shape(value, ['alias'], ['alias'], label); fail(text(value.alias), label + ' alias is empty'); return;
  }
  shape(value, ['path', 'sha256'], ['path', 'sha256'], label);
  fail(text(value.path) && /^[a-f0-9]{64}$/.test(value.sha256 ?? ''), label + ' requires exact path/SHA256');
}
function artifactResolver(root, registry = {}) {
  fail(plain(registry), 'artifactRegistry must be an object');
  for (const [alias, value] of Object.entries(registry)) {
    fail(text(alias), 'artifactRegistry alias is empty'); artifactShape(value, 'artifactRegistry ' + alias, false);
  }
  return (input, policy) => {
    artifactShape(input, 'artifact');
    let selected = input;
    if (plain(input) && Object.hasOwn(input, 'alias')) {
      fail(Object.hasOwn(registry, input.alias), 'unknown artifact alias: ' + input.alias);
      selected = registry[input.alias];
    }
    const filename = typeof selected === 'string' ? selected : selected.path;
    // Scope is checked before opening the file; hashing is not permission to
    // inspect other papers or constructor-private/reviewer-private roots.
    const expected = policy(filename);
    const actual = fileRef(root, filename);
    if (typeof selected !== 'string') fail(actual.sha256 === selected.sha256, 'artifact supplied hash mismatch');
    if (expected) fail(actual.sha256 === expected.sha256, 'artifact differs from exact frozen reference');
    return actual;
  };
}
function newPolicy(root, scan, role) {
  const scope = path.join(root, cleanRelative, role === 'reviewer' ? 'coverage_verifications' : 'coverage_work', scan.paperId);
  return filename => { fail(contained(scope, path.resolve(root, filename)), 'new artifact is outside this paper ' + role + ' root'); return null; };
}
function evidenceShape(value) {
  shape(value, ['kind', 'method', 'artifacts', 'mapping', 'claimIds', 'execution'], ['kind', 'method', 'artifacts', 'mapping'], 'evidence spec');
  fail(['new', 'reuse'].includes(value.kind) && text(value.method), 'evidence needs explicit kind and method');
  array(value.artifacts, 'evidence artifacts'); value.artifacts.forEach(ref => artifactShape(ref, 'evidence artifact'));
  shape(value.mapping, ['scope', 'conditions', 'dependencyCompatibility'], ['scope', 'conditions', 'dependencyCompatibility'], 'evidence mapping');
  for (const field of ['scope', 'conditions', 'dependencyCompatibility']) fail(text(value.mapping[field]), 'evidence mapping needs explicit ' + field);
  if (value.kind === 'reuse') {
    strings(value.claimIds, 'reuse claimIds', true); fail(!Object.hasOwn(value, 'execution'), 'reuse cannot carry new execution');
  } else {
    fail(!Object.hasOwn(value, 'claimIds'), 'new evidence cannot carry legacy claimIds');
    if (Object.hasOwn(value, 'execution')) {
      shape(value.execution, ['receipt'], ['receipt'], 'execution spec'); artifactShape(value.execution.receipt, 'execution receipt');
    }
  }
}
function evidenceResolver(root, scan, registry, resolveArtifact) {
  fail(plain(registry), 'evidenceRegistry must be an object');
  for (const [alias, value] of Object.entries(registry)) { fail(text(alias), 'evidenceRegistry alias is empty'); evidenceShape(value); }
  let legacyResult;
  function permitted(claimIds) {
    if (!legacyResult) {
      legacyResult = JSON.parse(readBoundText(root, scan.firstPass.result).replace(/^\uFEFF/, ''));
      fail(legacyResult.paperId === scan.paperId && Array.isArray(legacyResult.claims) && Array.isArray(legacyResult.contract?.claims), 'legacy result identity/claims mismatch');
    }
    return claimIds.flatMap(claimId => {
      const claim = legacyResult.claims.find(value => value.claimId === claimId);
      fail(claim && legacyResult.contract.claims.some(value => value.claimId === claimId), 'unknown legacy claim: ' + claimId);
      return array(claim.evidence, 'legacy claim evidence').map(ref => {
        fail(text(ref.runId) && /^[A-Za-z0-9_-]+$/.test(ref.runId) && text(ref.path), 'invalid legacy evidence run/path');
        fail(!path.isAbsolute(ref.path) && !ref.path.replaceAll('\\', '/').split('/').some(part => part === '.' || part === '..'), 'legacy evidence path must be run-relative without traversal');
        const runRoot = path.join(root, cleanRelative, 'runs', scan.paperId, ref.runId);
        const filename = path.join(runRoot, ref.path);
        fail(contained(runRoot, filename), 'legacy evidence escapes its same-paper run');
        return {path: filename, sha256: ref.sha256};
      });
    });
  }
  return input => {
    let value = input;
    if (typeof input === 'string' || (plain(input) && Object.hasOwn(input, 'alias'))) {
      if (typeof input !== 'string') shape(input, ['alias'], ['alias'], 'evidence alias');
      const alias = typeof input === 'string' ? input : input.alias;
      fail(text(alias) && Object.hasOwn(registry, alias), 'unknown evidence alias: ' + alias); value = registry[alias];
    }
    evidenceShape(value);
    const evidence = {kind: value.kind, method: value.method, artifacts: [], mapping: clone(value.mapping)};
    if (value.kind === 'new') {
      evidence.artifacts = value.artifacts.map(ref => resolveArtifact(ref, newPolicy(root, scan, 'worker')));
      if (Object.hasOwn(value, 'execution')) evidence.execution = {receipt: resolveArtifact(value.execution.receipt, newPolicy(root, scan, 'worker'))};
    } else {
      const allowed = permitted(value.claimIds);
      evidence.artifacts = value.artifacts.map(ref => resolveArtifact(ref, filename => {
        const match = allowed.find(item => samePath(root, item.path, filename));
        fail(match, 'reuse artifact is not selected exact claim evidence'); return match;
      }));
      for (const key of ['result', 'review', 'acceptance']) checkRef(root, scan.firstPass[key]);
      evidence.legacy = {...clone(scan.firstPass), claimIds: [...value.claimIds]};
    }
    return evidence;
  };
}

function unitDispositions(scan, items, rules) {
  array(rules, 'inventory unitRules');
  const mapping = new Map(scan.units.map(unit => [unit.id, []]));
  for (const item of items) for (const locator of item.locators) {
    const ids = mapping.get(locator.unitId); fail(ids, 'unknown item locator unit');
    if (!ids.includes(item.id)) ids.push(item.id);
  }
  const reasons = new Map(), resourceIds = new Set(scan.resources.map(resource => resource.id));
  for (const rule of rules) {
    shape(rule, ['selector', 'reason'], ['selector', 'reason'], 'unit rule'); fail(text(rule.reason), 'unit rule requires an explicit reason');
    shape(rule.selector, ['resourceId', 'unitIds', 'kinds'], [], 'unit selector');
    const selector = rule.selector;
    fail(Object.hasOwn(selector, 'resourceId') !== Object.hasOwn(selector, 'unitIds'), 'unit selector needs exactly resourceId or unitIds');
    if (Object.hasOwn(selector, 'resourceId')) fail(resourceIds.has(selector.resourceId), 'unit rule has unknown resourceId');
    else { strings(selector.unitIds, 'selector unitIds', true); fail(selector.unitIds.every(id => mapping.has(id)), 'unit rule has unknown unitId'); }
    if (Object.hasOwn(selector, 'kinds')) {
      strings(selector.kinds, 'selector kinds', true);
      fail(selector.kinds.every(kind => scan.units.some(unit => unit.kind === kind)), 'unit rule has unknown kind');
    }
    const matches = scan.units.filter(unit => (Object.hasOwn(selector, 'resourceId') ? unit.resourceId === selector.resourceId : selector.unitIds.includes(unit.id)) && (!selector.kinds || selector.kinds.includes(unit.kind)));
    fail(matches.length > 0, 'unit selector matches no units');
    for (const unit of matches) if (mapping.get(unit.id).length === 0) {
      fail(!reasons.has(unit.id), 'overlapping rules for unmapped unit: ' + unit.id); reasons.set(unit.id, rule.reason);
    }
  }
  return scan.units.map(unit => {
    const itemIds = mapping.get(unit.id);
    fail(itemIds.length > 0 || reasons.has(unit.id), 'unmapped unit requires explicit disposition: ' + unit.id);
    return {unitId: unit.id, itemIds, reason: itemIds.length ? 'Mapped by explicit item source locators: ' + itemIds.join(', ') : reasons.get(unit.id)};
  });
}
function bases(items) {
  const byId = new Map();
  for (const item of items) { fail(!byId.has(item.id), 'duplicate item ID'); byId.set(item.id, item); }
  const result = new Map();
  function closure(id, visiting = new Set(), found = new Set()) {
    fail(!visiting.has(id), 'cyclic item dependency: ' + id);
    if (found.has(id)) return found;
    const item = byId.get(id); fail(item, 'unknown item dependency: ' + id);
    visiting.add(id);
    for (const dependency of strings(item.dependencies, 'item dependencies')) closure(dependency, visiting, found);
    visiting.delete(id); found.add(id); return found;
  }
  for (const item of items) {
    const basis = Object.fromEntries([...closure(item.id)].sort().map(id => [id, objectHash(byId.get(id))]));
    for (const obligation of array(item.obligations, 'item obligations')) {
      fail(!result.has(obligation.id), 'duplicate obligation ID'); result.set(obligation.id, basis);
    }
  }
  return result;
}

/** Author declares all science; only hashes, references and mappings are filled. */
export async function assembleCandidate({root, scan, scanSha256, spec, previous = null}) {
  const required = ['schemaVersion', 'sourceBinding', 'author', 'inventory', 'assessments', 'retainObligationIds'];
  shape(spec, [...required, 'evidenceRegistry', 'artifactRegistry', 'changeImpact'], required, 'candidate authoring spec');
  fail(spec.schemaVersion === 2 && text(spec.author), 'candidate spec needs schemaVersion 2 and actual author');
  fail(scanSha256 === objectHash(scan), 'scan hash mismatch');
  shape(spec.inventory, ['complete', 'items', 'unitRules', 'diagnosticDispositions'], ['complete', 'items', 'unitRules', 'diagnosticDispositions'], 'inventory spec');
  explicitBoolean(spec.inventory.complete, 'inventory.complete');
  const sourceView = resolveSourceView({root, scan, sourceBinding: spec.sourceBinding});
  const reader = sourceReader(root, sourceView);
  const items = array(spec.inventory.items, 'inventory items').map(input => {
    const fields = ['id', 'kind', 'text', 'locators', 'conditions', 'units', 'dependencies', 'obligations'];
    shape(input, fields, fields, 'item spec');
    const resolved = array(input.locators, 'item locators').flatMap(locator => resolveOne(root, sourceView, locator, reader));
    const keys = resolved.map(canonical);
    fail(new Set(keys).size === keys.length, 'duplicate resolved item locators');
    const locators = resolved;
    return {...clone(input), locators};
  });
  const basisByObligation = bases(items);
  const resolveArtifact = artifactResolver(root, spec.artifactRegistry);
  const resolveEvidence = evidenceResolver(root, scan, spec.evidenceRegistry ?? {}, resolveArtifact);
  const byObligation = new Map();
  for (const input of array(spec.assessments, 'assessments')) {
    const requiredAssessment = ['obligationId', 'status', 'outcome', 'summary', 'limitations', 'evidence'];
    shape(input, [...requiredAssessment, 'applicabilityReason', 'blocker'], requiredAssessment, 'assessment spec');
    fail(basisByObligation.has(input.obligationId) && !byObligation.has(input.obligationId), 'unknown/duplicate assessment obligation');
    byObligation.set(input.obligationId, {...clone(input), basisItemHashes: clone(basisByObligation.get(input.obligationId)), evidence: array(input.evidence, 'assessment evidence').map(resolveEvidence)});
  }
  const retained = strings(spec.retainObligationIds, 'retainObligationIds');
  if (retained.length) {
    fail(previous?.candidate && previous?.review && previous?.decision && previous.sha256 === objectHash(previous.candidate), 'retain requires a previously accepted exact snapshot');
    assessCoverage({root, scan, candidate: previous.candidate, review: previous.review, decision: previous.decision});
    for (const id of retained) {
      fail(basisByObligation.has(id) && !byObligation.has(id), 'retained obligation is unknown or also newly assessed');
      const old = previous.candidate.assessments.find(assessment => assessment.obligationId === id);
      fail(old && old.status === 'accepted' && previous.decision.acceptedObligationIds.includes(id), 'retained obligation was not supervisor accepted: ' + id);
      fail(canonical(old.basisItemHashes) === canonical(basisByObligation.get(id)), 'retained definition or transitive dependency changed: ' + id);
      // Preserve the exact old assessment; never re-hash changed premises into it.
      byObligation.set(id, clone(old));
    }
  }
  fail(byObligation.size === basisByObligation.size, 'every obligation needs an explicit assessment or accepted retention');
  const candidate = {
    schemaVersion: 2, sourceBinding: clone(spec.sourceBinding), paperId: scan.paperId, revision: previous ? previous.candidate.revision + 1 : 1,
    scanSha256, predecessorSha256: previous ? previous.sha256 : null, author: spec.author,
    inventory: {complete: spec.inventory.complete, items, unitDispositions: unitDispositions(sourceView, items, spec.inventory.unitRules), diagnosticDispositions: clone(spec.inventory.diagnosticDispositions)},
    assessments: [...basisByObligation.keys()].map(id => byObligation.get(id)),
  };
  if (Object.hasOwn(spec, 'changeImpact')) candidate.changeImpact = clone(spec.changeImpact);
  const check = await validateCandidate({root, scan, scanSha256, candidate, previous});
  sourceView.recheck();
  return {candidate, check, summary: {
    kind: 'candidate', paperId: scan.paperId, revision: candidate.revision, sha256: objectHash(candidate),
    items: items.length, obligations: candidate.assessments.length, retainedObligations: retained.length,
    mappedUnits: candidate.inventory.unitDispositions.filter(value => value.itemIds.length > 0).length,
    explicitlyExcludedUnits: candidate.inventory.unitDispositions.filter(value => value.itemIds.length === 0).length,
    verification: check.verification,
  }};
}

/** Review judgments remain explicit; only binding fields and file hashes fill. */
export async function assembleReview({root, scan, candidate, candidateSha256, spec, reviewer, worker, previous = null}) {
  const required = ['schemaVersion', 'sourceBinding', 'inventory', 'entries', 'retainedObligationIds'];
  shape(spec, [...required, 'artifactRegistry'], required, 'review authoring spec');
  fail(spec.schemaVersion === 2, 'review spec requires schemaVersion 2');
  sameSourceBinding(root, spec.sourceBinding, candidate.sourceBinding, 'review authoring source binding');
  const sourceView = resolveSourceView({root, scan, sourceBinding: spec.sourceBinding});
  const inventoryFields = ['complete', 'checkedAllUnits', 'missingItems', 'notes', 'unitExclusions'];
  shape(spec.inventory, inventoryFields, inventoryFields, 'review inventory spec');
  explicitBoolean(spec.inventory.complete, 'review inventory.complete');
  fail(spec.inventory.checkedAllUnits === true, 'review must explicitly check all units');
  fail(candidateSha256 === objectHash(candidate), 'candidate hash mismatch');
  const resolveArtifact = artifactResolver(root, spec.artifactRegistry);
  const assessmentById = new Map(candidate.assessments.map(value => [value.obligationId, value]));
  const entries = array(spec.entries, 'review entries').map(input => {
    shape(input, ['obligationId', 'verdict', 'reason', 'evidence'], ['obligationId', 'verdict', 'reason', 'evidence'], 'review entry spec');
    const assessment = assessmentById.get(input.obligationId); fail(assessment, 'review entry references unknown obligation');
    const reusedOnly = assessment.evidence.length > 0 && assessment.evidence.every(value => value.kind === 'reuse');
    const allowed = reusedOnly ? [scan.firstPass.review, ...assessment.evidence.flatMap(value => value.artifacts)] : [];
    const scope = path.join(root, cleanRelative, 'coverage_verifications', scan.paperId);
    return {...clone(input), assessmentSha256: objectHash(assessment), evidence: array(input.evidence, 'review evidence').map(ref => resolveArtifact(ref, filename => {
      if (contained(scope, path.resolve(root, filename))) return null;
      const match = allowed.find(value => samePath(root, value.path, filename));
      fail(match, 'review evidence is outside independent same-paper roots or exact reused evidence'); return match;
    }))};
  });
  const review = {
    schemaVersion: 2, sourceBinding: clone(spec.sourceBinding), paperId: scan.paperId, revision: candidate.revision,
    scanSha256: candidate.scanSha256, candidateSha256, reviewerAgent: reviewer,
    inventory: {...clone(spec.inventory), resourceIds: sourceView.resources.map(value => value.id)},
    entries, retainedObligationIds: [...strings(spec.retainedObligationIds, 'retainedObligationIds')],
  };
  const check = await validateReview({root, scan, candidate, candidateSha256, review, reviewer, worker, previous});
  sourceView.recheck();
  return {review, check, summary: {
    kind: 'review', paperId: scan.paperId, revision: review.revision, sha256: objectHash(review),
    entries: entries.length, retainedObligations: review.retainedObligationIds.length,
    verification: check.verification,
  }};
}
