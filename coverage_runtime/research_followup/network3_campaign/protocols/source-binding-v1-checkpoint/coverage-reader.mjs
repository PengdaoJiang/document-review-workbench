// Read-only, byte-bounded navigation. No cache, snapshots, gates or ledger writes.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical, hash, fileRef, checkRef, assessCoverage, sameSourceBinding} from './coverage-core.mjs';
import {campaignRelative, loadPaper, previousFor, bound, safeWithin} from './coverage-context.mjs';

const MAX_BYTES = 16 * 1024;
const KINDS = ['items', 'obligations', 'evidence', 'bindings', 'resources', 'units', 'diagnostics', 'delta', 'claims', 'documents'];
const requireThat = (ok, message) => { if (!ok) throw Error('Coverage reader: ' + message); };
const digest = value => hash(canonical(value));
const bytes = value => Buffer.byteLength(JSON.stringify(value) + '\n', 'utf8');
const fit = value => { requireThat(bytes(value) <= MAX_BYTES, 'Response metadata exceeds 16 KiB'); return value; };
const keyPath = filename => process.platform === 'win32' ? filename.toLowerCase() : filename;
const samePath = (a, b) => keyPath(path.resolve(a)) === keyPath(path.resolve(b));
const isMiddle = (text, n) => n > 0 && n < text.length && /[\uD800-\uDBFF]/.test(text[n - 1]) && /[\uDC00-\uDFFF]/.test(text[n]);
const preview = text => {
  text = String(text ?? ''); let end = Math.min(text.length, 160);
  if (isMiddle(text, end)) end--;
  return {text: text.slice(0, end), truncated: end < text.length};
};
function integer(value, fallback, label, minimum = 0) {
  value ??= String(fallback);
  requireThat(/^\d+$/.test(String(value)), 'Invalid ' + label);
  const number = Number(value);
  requireThat(Number.isSafeInteger(number) && number >= minimum, 'Invalid ' + label);
  return number;
}
function parse(argv) {
  const args = [...argv]; let candidatePath = null;
  const index = args.indexOf('--candidate');
  if (index >= 0) {
    requireThat(index === args.length - 2 && args[index + 1] && args.lastIndexOf('--candidate') === index, '--candidate must occur once at the end');
    candidatePath = args[index + 1]; args.splice(index, 2);
  }
  const [command, paperId, role, snapshotKey, kind, key, ...tail] = args;
  requireThat(['open', 'list', 'get', 'read'].includes(command), 'Expected open, list, get or read');
  requireThat(['worker', 'reviewer'].includes(role), 'Expected worker or reviewer role');
  if (command === 'open') requireThat(args.length === 3, 'open expects paperId and role');
  else {
    requireThat(/^[a-f0-9]{64}$/.test(snapshotKey ?? ''), 'Invalid snapshotKey; open the paper first');
    requireThat(KINDS.includes(kind), 'Unknown kind');
    const limits = {list: [5, 7], get: [6, 6], read: [6, 8]}[command];
    requireThat(args.length >= limits[0] && args.length <= limits[1], 'Unexpected arguments');
  }
  return {command, paperId, role, snapshotKey, kind, key, tail, candidatePath};
}
function select(binding, role, candidatePath) {
  const {root, paper} = binding;
  if (paper.owner) requireThat(paper.owner.role === role, 'Role differs from active owner (routing, not OS authentication)');
  let ref = null, selection = null;
  if (candidatePath !== null) {
    requireThat(role === 'worker' && paper.owner?.role === 'worker' && paper.phase === 'source_working', 'Explicit candidate requires the active worker');
    const expected = path.resolve(root, `research_followup/reproduction_clean/coverage_work/${paper.paperId}/c${String(paper.iteration).padStart(3, '0')}`);
    requireThat(typeof paper.workRoot === 'string' && samePath(path.resolve(root, paper.workRoot), expected), 'Registered worker root/version mismatch');
    const workerRoot = safeWithin(root, expected);
    // Inspect raw input before resolving it: normalization must not erase traversal.
    safeWithin(root, candidatePath);
    ref = fileRef(root, safeWithin(workerRoot, path.resolve(root, candidatePath)));
    selection = 'worker_private';
  } else if (role === 'reviewer') {
    requireThat(paper.staged?.candidate, 'Reviewer has no staged candidate');
    ref = paper.staged.candidate; selection = 'staged';
  } else if (paper.latest) { ref = paper.latest.candidate; selection = 'latest_assessed_snapshot'; }
  const candidate = ref ? bound(root, ref) : null;
  if (candidate) {
    requireThat(candidate.schemaVersion === 2, 'Candidate requires source-binding schema');
    sameSourceBinding(root, candidate.sourceBinding, paper.sourceEnrollment.sourceBinding, 'candidate enrolled source binding');
    requireThat(candidate.paperId === paper.paperId && candidate.scanSha256 === paper.scan.sha256 && Number.isSafeInteger(candidate.revision), 'Candidate paper/scan/revision mismatch');
    requireThat(Array.isArray(candidate.inventory?.items) && Array.isArray(candidate.assessments), 'Candidate has no navigable inventory/assessments');
    if (selection !== 'worker_private') requireThat(digest(candidate) === ref.sha256, 'Frozen candidate is not canonical');
    if (selection === 'worker_private') {
      requireThat(candidate.revision === paper.iteration && candidate.author === paper.owner.agent, 'Candidate author/revision differs from active worker');
      requireThat(candidate.predecessorSha256 === (paper.latest?.candidate.sha256 ?? null), 'Candidate predecessor differs from current accepted snapshot');
    }
    if (selection === 'staged') requireThat(candidate.revision === paper.iteration && candidate.author === paper.staged.worker, 'Staged candidate author/revision mismatch');
  }
  return {candidate, ref, selection};
}
function snapshot(binding, role, selected) {
  // No global revision, event stream or other-paper state enters this token.
  return digest({readerSchema: 2, role, paper: binding.paper, selected: {ref: selected.ref, selection: selected.selection}});
}
function indexed(rows, id, label) {
  const result = new Map();
  for (const row of rows) {
    const key = row[id];
    requireThat(typeof key === 'string' && key.length > 0 && key.length <= 512 && !result.has(key), 'Invalid/duplicate ' + label + ' key');
    result.set(key, row);
  }
  return result;
}
function dependencies(items, id, visiting = new Set(), result = new Set()) {
  requireThat(!visiting.has(id), 'Cyclic item dependency');
  if (result.has(id)) return result;
  const item = items.get(id); requireThat(item && Array.isArray(item.dependencies), 'Missing item/dependency');
  visiting.add(id);
  for (const dependency of item.dependencies) dependencies(items, dependency, visiting, result);
  visiting.delete(id); result.add(id); return result;
}
function collections(binding, selected, previous, result) {
  const {root, paper, scan, sourceView} = binding, candidate = selected.candidate;
  const all = Object.fromEntries(KINDS.map(kind => [kind, new Map()]));
  const checkedFiles = new Set(), publicArtifacts = new Set();
  const clean = path.join(root, 'research_followup/reproduction_clean');
  const checkedUnder = (ref, directory) => {
    // Guard scope BEFORE reading bytes, even when an untrusted candidate names a private file.
    const absolute = safeWithin(root, ref.path);
    safeWithin(directory, absolute);
    const key = keyPath(absolute) + ':' + ref.sha256;
    if (!checkedFiles.has(key)) { checkRef(root, ref); checkedFiles.add(key); }
    return key;
  };
  for (const claim of result.claims) for (const evidence of claim.evidence) {
    requireThat(/^[A-Za-z0-9_-]+$/.test(evidence.runId), 'Invalid public evidence run ID');
    const runRoot = path.join(clean, 'runs', paper.paperId, evidence.runId);
    const absolute = safeWithin(runRoot, evidence.path);
    publicArtifacts.add(checkedUnder({path: absolute, sha256: evidence.sha256}, runRoot));
  }
  const checkedEvidence = new Set();
  const checkEvidence = evidence => {
    const id = digest(evidence); if (checkedEvidence.has(id)) return;
    requireThat(['new', 'reuse'].includes(evidence.kind) && Array.isArray(evidence.artifacts), 'Invalid candidate evidence');
    for (const ref of evidence.artifacts) {
      const key = checkedUnder(ref, path.join(clean, evidence.kind === 'new' ? 'coverage_work' : 'runs', paper.paperId));
      if (evidence.kind === 'reuse') requireThat(publicArtifacts.has(key), 'Reuse is outside exact same-paper public evidence');
    }
    if (evidence.execution) checkedUnder(evidence.execution.receipt, path.join(clean, 'coverage_work', paper.paperId));
    if (evidence.legacy) for (const name of ['result', 'review', 'acceptance']) {
      const ref = evidence.legacy[name], expected = scan.firstPass[name];
      requireThat(ref && samePath(path.resolve(root, ref.path), path.resolve(root, expected.path)) && ref.sha256 === expected.sha256, 'Legacy reference differs from same-paper baseline');
      // The private review is a sealed reference only, not a reader content source.
    }
    checkedEvidence.add(id);
  };
  const items = indexed(candidate?.inventory.items ?? [], 'id', 'item');
  const assessments = indexed(candidate?.assessments ?? [], 'obligationId', 'assessment');
  const putEvidence = evidence => {
    const key = 'evidence-' + digest(evidence); all.evidence.set(key, evidence); return key;
  };
  for (const [key, item] of items) {
    all.items.set(key, item);
    for (const definition of item.obligations) {
      requireThat(!all.obligations.has(definition.id), 'Duplicate obligation');
      const original = assessments.get(definition.id); let assessment = null;
      if (original) {
        const {evidence, basisItemHashes, ...rest} = original;
        evidence.forEach(checkEvidence);
        const basisKey = 'binding-' + digest(basisItemHashes);
        all.bindings.set(basisKey, basisItemHashes);
        assessment = {...rest, evidenceKeys: evidence.map(putEvidence), basisKey};
      }
      const {kind, text, conditions, units, locators, dependencies: deps} = item;
      all.obligations.set(definition.id, {itemId: key, definition, itemContext: {kind, text, conditions, units, locators, dependencies: deps}, assessment});
    }
  }
  const dispositions = indexed(candidate?.inventory.unitDispositions ?? [], 'unitId', 'unit disposition');
  const diagnosticDispositions = indexed(candidate?.inventory.diagnosticDispositions ?? [], 'diagnosticId', 'diagnostic disposition');
  for (const resource of sourceView.resources) all.resources.set(resource.id, resource);
  for (const unit of sourceView.units) all.units.set(unit.id, {...unit, disposition: dispositions.get(unit.id) ?? null});
  for (const diagnostic of sourceView.diagnostics) all.diagnostics.set(diagnostic.id, {...diagnostic, disposition: diagnosticDispositions.get(diagnostic.id) ?? null});
  const contract = indexed(result.contract?.claims ?? [], 'claimId', 'baseline contract claim');
  for (const value of result.claims) {
    const {evidence, ...claim} = value;
    all.claims.set(value.claimId, {claim: {...claim, evidenceKeys: evidence.map(putEvidence)}, contract: contract.get(value.claimId) ?? null,
      evidenceBaseRoot: path.join(root, 'research_followup/reproduction_clean/runs', paper.paperId)});
  }
  const oldItems = indexed(previous?.candidate.inventory.items ?? [], 'id', 'prior item');
  const oldAssessments = indexed(previous?.candidate.assessments ?? [], 'obligationId', 'prior assessment');
  const oldObligations = new Map([...oldItems.values()].flatMap(item => item.obligations.map(definition => [definition.id, {itemId: item.id, definition}])));
  const itemHashes = new Map([...items].map(([id, item]) => [id, digest(item)]));
  const oldItemHashes = new Map([...oldItems].map(([id, item]) => [id, digest(item)]));
  const closures = new Map(), oldClosures = new Map();
  const closureFor = (index, cache, id) => {
    if (!cache.has(id)) cache.set(id, [...dependencies(index, id)]);
    return cache.get(id);
  };
  const accepted = new Set(previous?.decision.acceptedObligationIds ?? []), allowed = new Set(paper.allowedScope ?? []);
  const impact = indexed(candidate?.changeImpact ?? [], 'obligationId', 'change impact');
  for (const id of new Set([...all.obligations.keys(), ...oldObligations.keys()])) {
    const current = all.obligations.get(id), before = oldObligations.get(id), assessment = assessments.get(id), oldAssessment = oldAssessments.get(id);
    const currentDependencies = current ? closureFor(items, closures, current.itemId) : [];
    const oldDependencies = before ? closureFor(oldItems, oldClosures, before.itemId) : [];
    const changedDependencies = [...new Set([...currentDependencies, ...oldDependencies])].filter(itemId => itemId !== current?.itemId && (!items.has(itemId) || !oldItems.has(itemId) || itemHashes.get(itemId) !== oldItemHashes.get(itemId)));
    const itemChanged = !!before && !!current && itemHashes.get(current.itemId) !== oldItemHashes.get(before.itemId);
    const assessmentChanged = !!before && (!assessment || !oldAssessment || digest(assessment) !== digest(oldAssessment));
    const basisMatches = !!assessment && digest(assessment.basisItemHashes) === digest(Object.fromEntries(currentDependencies.map(itemId => [itemId, itemHashes.get(itemId)])));
    const category = !before ? 'new' : !current ? 'changed' : changedDependencies.length ? 'dependency_affected' : itemChanged || assessmentChanged || !basisMatches ? 'changed' : accepted.has(id) ? 'unchanged_accepted' : 'old_unaccepted';
    all.delta.set(id, {obligationId: id, category, acceptedBefore: accepted.has(id), scopeSelected: allowed.has(id), missingCurrent: !current,
      itemChanged, assessmentChanged, basisMatches, changedDependencies, changeImpact: impact.get(id) ?? null,
      reason: {new: 'No prior obligation.', changed: 'Definition, item, assessment or dependency basis changed or is missing.', dependency_affected: 'At least one transitive dependency changed.', unchanged_accepted: 'Prior supervisor acceptance and unchanged assessment/current transitive basis; navigation only, not a new acceptance.', old_unaccepted: 'Unchanged prior obligation was not supervisor-accepted; it cannot be inherited as completed.'}[category]});
  }
  // Original public objects stay fully available through bounded canonical reads.
  if (candidate) all.documents.set('candidate', candidate);
  all.documents.set('scan', scan); all.documents.set('sourceBinding', sourceView.binding);
  all.documents.set('sourceView', {baseScan: paper.scan, sourceBinding: paper.sourceEnrollment.sourceBinding, resources: sourceView.resources, units: sourceView.units, diagnostics: sourceView.diagnostics});
  all.documents.set('publicBaseline', result);
  if (previous) all.documents.set('priorDecision', previous.decision);
  return all;
}
function directory(kind, key, content) {
  const row = {key};
  if (kind === 'items') Object.assign(row, {kind: content.kind, preview: preview(content.text), obligationCount: content.obligations.length});
  if (kind === 'obligations') Object.assign(row, {itemId: content.itemId, dimension: content.definition.dimension, status: content.assessment?.status ?? null, preview: preview(content.definition.statement)});
  if (kind === 'evidence') Object.assign(row, {kind: content.kind ?? 'first_pass', method: content.method ?? content.role ?? null});
  if (kind === 'bindings') row.itemCount = Object.keys(content).length;
  if (kind === 'resources') Object.assign(row, {type: content.type, pathPreview: preview(content.path)});
  if (kind === 'units') Object.assign(row, {resourceId: content.resourceId, kind: content.kind, start: content.start, end: content.end, disposition: content.disposition ? content.disposition.itemIds.length ? 'mapped' : 'excluded' : 'unmapped'});
  if (kind === 'diagnostics') Object.assign(row, {resourceId: content.resourceId, resolved: content.disposition?.resolved ?? null});
  if (kind === 'delta') Object.assign(row, {category: content.category, acceptedBefore: content.acceptedBefore, scopeSelected: content.scopeSelected});
  if (kind === 'claims') Object.assign(row, {status: content.claim.status ?? null, preview: preview(content.claim.conclusion)});
  return row;
}

export async function runReader(root, argv) {
  root = path.resolve(root);
  const request = parse(argv), {command, paperId, role, kind, key, tail, candidatePath} = request;
  const binding = loadPaper(root, paperId), {paper, scan} = binding;
  const selected = select(binding, role, candidatePath), snapshotKey = snapshot(binding, role, selected);
  if (command !== 'open') requireThat(request.snapshotKey === snapshotKey, 'Stale snapshotKey; reopen this paper');
  const previous = previousFor(root, paper);
  if (previous) {
    requireThat(digest(previous.candidate) === previous.sha256, 'Previous candidate is not canonical');
    requireThat(digest(previous.review) === paper.latest.review.sha256 && digest(previous.decision) === paper.latest.decision.sha256, 'Previous review/decision is not canonical');
    requireThat(previous.decision.candidateSha256 === paper.latest.candidate.sha256 && previous.decision.reviewSha256 === paper.latest.review.sha256, 'Previous decision reference binding mismatch');
    // Mechanical decision binding only. Never return a private review body.
    assessCoverage({root, scan, candidate: previous.candidate, review: previous.review, decision: previous.decision});
  }
  const result = bound(root, paper.firstPass.result);
  requireThat(result.paperId === paperId && Array.isArray(result.claims), 'Public baseline paper mismatch');
  const all = collections(binding, selected, previous, result);
  const base = {schemaVersion: 1, paperId, role, snapshotKey, command};
  const argsFor = (action, type, id, ...extra) => [action, paperId, role, snapshotKey, type, ...(id === null ? [] : [id]), ...extra.map(String), ...(candidatePath === null ? [] : ['--candidate', candidatePath])];
  let output;
  if (command === 'open') {
    output = {...base, phase: paper.phase, iteration: paper.iteration, owner: paper.owner ?? null,
      candidate: selected.candidate ? {ref: selected.ref, revision: selected.candidate.revision, author: selected.candidate.author, selection: selected.selection} : null,
      source: {baseScan: paper.scan, sourceBinding: paper.sourceEnrollment.sourceBinding, inputVersion: scan.inputVersion},
      publicBaseline: {result: paper.firstPass.result, acceptance: paper.firstPass.acceptance},
      priorAcceptedCount: previous?.decision.acceptedObligationIds.length ?? 0,
      selectedObligationCount: paper.allowedScope?.length ?? 0,
      inventoryReviewRequired: true, priorInventoryAccepted: previous?.decision.inventoryAccepted === true,
      counts: Object.fromEntries(KINDS.map(type => [type, all[type].size])),
      commands: {list: argsFor('list', 'obligations', null, 0, 10), source: argsFor('list', 'resources', null, 0, 10), delta: argsFor('list', 'delta', null, 0, 10)},
      rules: ['Navigation only: lists/previews/scans/delta do not establish original text, inventory completeness, evidence adequacy or acceptance.',
        'Read the entire bound academic package and necessary macros/graphics, including unlisted regions. Delta never waives independent inventory review.',
        'Only unchanged supervisor-accepted obligations can be considered for retention; old pending/partial/unaccepted work is not complete. Existing intake/review/decide gates are unchanged.',
        'get/read restore complete objects. Obligation assessment evidenceKeys and basisKey resolve to evidence/bindings; documents exposes complete original public objects. No private review text is returned.',
        'Snapshot keys bind this paper and selection, not other papers. --candidate is only for the active worker\'s current private root. Role checks are routing, not OS authentication.']};
  } else if (command === 'list') {
    const offset = integer(key, 0, 'offset'), limit = integer(tail[0], 10, 'limit', 1);
    requireThat(limit <= 100, 'List limit must be 1..100');
    const entries = [...all[kind]], records = [];
    output = {...base, kind, total: entries.length, offset, nextOffset: null, complete: false, preview: true, records,
      note: 'ID directory and explicit previews only, not source text or a completeness audit. Use get/read for the complete record.'};
    for (let index = offset; index < Math.min(offset + limit, entries.length); index++) {
      const [id, content] = entries[index], row = directory(kind, id, content);
      records.push(row); output.nextOffset = index + 1 < entries.length ? index + 1 : null;
      if (bytes(output) > MAX_BYTES) { records.pop(); output.nextOffset = index; break; }
    }
    requireThat(records.length > 0 || offset >= entries.length, 'Directory entry cannot fit the response bound');
  } else {
    const metadataOnly = command === 'read' && kind === 'resources' && key.endsWith(':metadata');
    const contentKey = metadataOnly ? key.slice(0, -9) : key;
    requireThat(all[kind].has(contentKey), 'Unknown key in ' + kind);
    const content = all[kind].get(contentKey), serialized = canonical(content);
    const descriptor = {...base, kind, key, sha256: hash(serialized), utf16Length: serialized.length, utf8Bytes: Buffer.byteLength(serialized, 'utf8')};
    if (command === 'get') {
      output = {...descriptor, content};
      if (bytes(output) > MAX_BYTES) output = {...descriptor, contentNotInline: true, encoding: 'canonical-json',
        read: {argv: argsFor('read', kind, kind === 'resources' && content.type === 'text' ? key + ':metadata' : key, 0, 2048)},
        note: 'No fields truncated: read and concatenate all canonical JSON chunks to reconstruct this complete object. A resources :metadata key reads metadata instead of source text.'};
    } else {
      let text = serialized, encoding = 'canonical-json';
      if (kind === 'resources' && content.type === 'text' && !metadataOnly) {
        const raw = fs.readFileSync(checkRef(root, {path: content.path, sha256: content.sha256}));
        requireThat(hash(raw) === content.sha256, 'actual resource bytes hash mismatch');
        text = raw.toString('utf8'); requireThat(Buffer.from(text, 'utf8').equals(raw), 'Resource is not valid UTF-8'); encoding = 'utf8-source';
      }
      const offset = integer(tail[0], 0, 'offset'), length = integer(tail[1], 2048, 'length', 1);
      requireThat(offset <= text.length && !isMiddle(text, offset), 'Read offset is out of range or splits a UTF-16 surrogate pair');
      const make = end => ({...base, kind, key, encoding, sha256: hash(text), utf16Length: text.length, utf8Bytes: Buffer.byteLength(text, 'utf8'),
        offset, end, nextOffset: end < text.length ? end : null, complete: end === text.length, chunk: text.slice(offset, end),
        ...(kind === 'resources' && content.type !== 'text' ? {binaryNotRead: true, ref: {path: content.path, sha256: content.sha256}} : {})});
      let end = Math.min(text.length, offset + length);
      if (isMiddle(text, end)) end--;
      if (end === offset && offset < text.length) end = offset + (isMiddle(text, offset + 1) ? 2 : 1);
      output = make(end);
      if (bytes(output) > MAX_BYTES) {
        let lo = offset, hi = end;
        while (lo < hi) { const middle = Math.ceil((lo + hi) / 2); if (bytes(make(middle)) <= MAX_BYTES) lo = middle; else hi = middle - 1; }
        end = isMiddle(text, lo) ? lo - 1 : lo; output = make(end);
        requireThat(end > offset || offset === text.length, 'Read metadata cannot fit the response bound');
      }
    }
  }
  // Recheck immediately before returning; no partial mixed-version response.
  const current = loadPaper(root, paperId), currentSelection = select(current, role, candidatePath);
  requireThat(snapshot(current, role, currentSelection) === snapshotKey, 'Paper/owner/candidate changed during read; reopen');
  for (const ref of paper.latest ? Object.values({candidate: paper.latest.candidate, review: paper.latest.review, decision: paper.latest.decision}) : []) checkRef(root, ref);
  binding.sourceView.recheck();
  return fit(output);
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  runReader(root, process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value) + '\n'))
    .catch(error => { process.stdout.write(JSON.stringify({error: String(error.message).slice(0, 2000), scientificAcceptance: false}) + '\n'); process.exitCode = 1; });
}
