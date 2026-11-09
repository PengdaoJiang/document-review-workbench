// Additive, read-only batch transport. No ledger, service, acceptance or writes.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical, hash, checkRef, fileRef, sameSourceBinding} from './coverage-core.mjs';
import {loadPaper, safeWithin} from './coverage-context.mjs';
import {runReader} from './coverage-reader.mjs';

export const MAX_BATCH_BYTES = 8192;
export const MIN_BATCH_BYTES = 1024;
const CLEAN = 'research_followup/reproduction_clean';
const CAMPAIGN = 'research_followup/network3_campaign';
const SHA = /^[a-f0-9]{64}$/;
const fail = message => { throw Error('Coverage batch: ' + message); };
const insist = (ok, message) => { if (!ok) fail(message); };
const digest = value => hash(canonical(value));
const keyPath = value => process.platform === 'win32' ? value.toLowerCase() : value;
const same = (a, b) => keyPath(path.resolve(a)) === keyPath(path.resolve(b));
const middle = (text, n) => n > 0 && n < text.length && /[\uD800-\uDBFF]/.test(text[n - 1]) && /[\uDC00-\uDFFF]/.test(text[n]);
export const serializedBytes = value => Buffer.byteLength(JSON.stringify(value) + '\n', 'utf8');
function shape(value, allowed, required = allowed) {
  insist(value && typeof value === 'object' && !Array.isArray(value), 'Expected object');
  insist(Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)), 'Unexpected or missing fields');
}
function boundedInteger(value, low, high, label) {
  insist(/^\d+$/.test(String(value)), 'Invalid ' + label);
  const n = Number(value);
  insist(Number.isSafeInteger(n) && n >= low && n <= high, 'Invalid ' + label);
  return n;
}
function parse(argv) {
  insist(Array.isArray(argv) && argv.every(value => typeof value === 'string'), 'Expected argv strings');
  const args = [...argv], options = {maxBytes: MAX_BATCH_BYTES, cursor: null, candidatePath: null};
  for (const [flag, field] of [['--max-bytes', 'maxBytes'], ['--cursor', 'cursor'], ['--candidate', 'candidatePath']]) {
    const i = args.indexOf(flag);
    if (i < 0) continue;
    insist(i === args.lastIndexOf(flag) && i + 1 < args.length && !args[i + 1].startsWith('--'), 'Invalid ' + flag);
    options[field] = args[i + 1]; args.splice(i, 2);
  }
  options.maxBytes = boundedInteger(options.maxBytes, MIN_BATCH_BYTES, MAX_BATCH_BYTES, 'max-bytes (1024..8192)');
  const [command, ...values] = args;
  insist(['open', 'batch', 'read'].includes(command), 'Expected open, batch or read');
  insist(command === 'open' ? values.length === 3 && options.cursor === null : values.length === 1 && options.candidatePath === null, 'Unexpected arguments');
  return {command, values, ...options};
}
function active(binding, role, agent = null) {
  const {root, paper} = binding;
  insist(['worker', 'reviewer'].includes(role), 'Invalid role');
  insist(paper.owner?.role === role && paper.phase === (role === 'worker' ? 'source_working' : 'source_reviewing'), 'No active matching owner/phase');
  insist(agent === null || paper.owner.agent === agent, 'Agent differs from active owner');
  insist(Number.isSafeInteger(paper.iteration) && paper.iteration > 0, 'Invalid iteration');
  const expected = path.resolve(root, `${CLEAN}/${role === 'worker' ? 'coverage_work' : 'coverage_verifications'}/${paper.paperId}/c${String(paper.iteration).padStart(3, '0')}`);
  const registered = role === 'worker' ? paper.workRoot : paper.staged?.reviewRoot;
  insist(typeof registered === 'string' && same(path.resolve(root, registered), expected), 'Registered private root/version mismatch');
  return safeWithin(root, registered);
}
function readUtf8(root, ref, tracked) {
  const absolute = checkRef(root, ref), raw = fs.readFileSync(absolute), text = raw.toString('utf8');
  insist(hash(raw) === ref.sha256, 'File changed during read');
  insist(Buffer.from(text, 'utf8').equals(raw), 'Artifact is not valid UTF-8; use a bound asset viewer');
  const prior = tracked.get(keyPath(absolute));
  insist(!prior || prior.sha256 === ref.sha256, 'Conflicting versions of one input in a batch');
  tracked.set(keyPath(absolute), {path: absolute, sha256: ref.sha256});
  return text;
}
function validRef(root, ref) {
  shape(ref, ['path', 'sha256']);
  insist(typeof ref.path === 'string' && !/[\x00-\x1f]/.test(ref.path) && SHA.test(ref.sha256), 'Invalid artifact ref');
  return safeWithin(root, ref.path);
}
function within(directory, absolute) {
  const relative = path.relative(directory, absolute);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function readerTail(candidatePath) { return candidatePath === null ? [] : ['--candidate', candidatePath]; }
function candidateBoundary(binding, role, candidatePath, privateRoot) {
  const {root, paper} = binding, textRefs = new Map();
  const refKey = ref => keyPath(validRef(root, ref)) + ':' + ref.sha256;
  const parseBound = ref => JSON.parse(readUtf8(root, ref, textRefs).replace(/^\uFEFF/, ''));
  const baseline = parseBound(paper.firstPass.result), publicRefs = new Set(), priorRefs = new Set();
  insist(baseline.paperId === paper.paperId, 'Public baseline paper mismatch');
  for (const claim of baseline.claims) for (const evidence of claim.evidence) {
    insist(/^[A-Za-z0-9_-]+$/.test(evidence.runId), 'Invalid public evidence run');
    const directory = path.resolve(root, `${CLEAN}/runs/${paper.paperId}/${evidence.runId}`);
    publicRefs.add(refKey({path: safeWithin(directory, evidence.path), sha256: evidence.sha256}));
  }
  const directory = path.resolve(root, `${CLEAN}/coverage_work/${paper.paperId}`);
  if (paper.latest) {
    const previous = parseBound(paper.latest.candidate);
    insist(previous.schemaVersion === 2, 'Prior candidate requires source-binding schema');
    sameSourceBinding(root, previous.sourceBinding, paper.sourceEnrollment.sourceBinding, 'prior enrolled source binding');
    insist(previous.paperId === paper.paperId && previous.scanSha256 === paper.scan.sha256, 'Prior candidate binding mismatch');
    for (const assessment of previous.assessments) for (const evidence of assessment.evidence) if (evidence.kind === 'new') {
      for (const ref of [...evidence.artifacts, ...(evidence.execution ? [evidence.execution.receipt] : [])]) {
        safeWithin(directory, validRef(root, ref)); priorRefs.add(refKey(ref));
      }
    }
  }
  let selected;
  if (candidatePath !== null) {
    insist(role === 'worker', 'Only an active worker may select a private candidate');
    safeWithin(root, candidatePath); selected = fileRef(root, safeWithin(privateRoot, path.resolve(root, candidatePath)));
  } else if (role === 'reviewer') selected = paper.staged?.candidate;
  if (!selected) return;
  const candidate = parseBound(selected);
  insist(candidate.schemaVersion === 2, 'Candidate requires source-binding schema');
  sameSourceBinding(root, candidate.sourceBinding, paper.sourceEnrollment.sourceBinding, 'candidate enrolled source binding');
  insist(candidate.paperId === paper.paperId && candidate.scanSha256 === paper.scan.sha256, 'Candidate binding mismatch');
  const current = path.resolve(directory, `c${String(paper.iteration).padStart(3, '0')}`);
  // This is a boundary-only preflight, before the old reader hashes any named
  // artifact. It never substitutes for the reader/scientific validators.
  for (const assessment of candidate.assessments) for (const evidence of assessment.evidence) {
    insist(['new', 'reuse'].includes(evidence.kind), 'Invalid evidence kind');
    for (const ref of [...evidence.artifacts, ...(evidence.execution ? [evidence.execution.receipt] : [])]) {
      const absolute = validRef(root, ref), key = refKey(ref);
      insist(evidence.kind === 'new' ? within(current, absolute) || priorRefs.has(key) : publicRefs.has(key),
        'Current candidate artifact is outside its current root and exact prior public evidence');
    }
  }
}
async function openBound(root, paperId, role, agent, candidatePath) {
  const binding = loadPaper(root, paperId), privateRoot = active(binding, role, agent);
  candidateBoundary(binding, role, candidatePath, privateRoot);
  const opened = await runReader(root, ['open', paperId, role, ...readerTail(candidatePath)]);
  return {binding, opened, privateRoot};
}
function manifestIdentity(root, filename) {
  const absolute = safeWithin(root, filename), relative = path.relative(root, absolute).replaceAll('\\', '/');
  const match = relative.match(/^research_followup\/reproduction_clean\/(coverage_work|coverage_verifications)\/(origin|r\d{4})\/c\d{3,}\/.+$/i);
  insist(match, 'Manifest must be inside an active own-role private root');
  const role = match[1].toLowerCase() === 'coverage_work' ? 'worker' : 'reviewer', paperId = match[2].toLowerCase();
  const binding = loadPaper(root, paperId), privateRoot = active(binding, role);
  safeWithin(privateRoot, absolute); // Reject sibling/root/version before reading manifest bytes.
  insist(fs.statSync(absolute).size <= 1024 * 1024, 'Manifest exceeds 1 MiB');
  return {absolute, paperId, role};
}
function allowlist(binding, opened, role, tracked) {
  const {root, paper, scan, sourceView} = binding, allowed = new Map(), binary = new Set();
  const refKey = ref => keyPath(validRef(root, ref)) + ':' + ref.sha256;
  const add = (ref, directory = null, isBinary = false) => {
    const absolute = validRef(root, ref);
    if (directory) safeWithin(directory, absolute);
    allowed.set(refKey(ref), ref); if (isBinary) binary.add(refKey(ref));
  };
  const exact = (ref, relative) => {
    insist(ref && same(validRef(root, ref), path.resolve(root, relative)), 'Guard reference differs from exact same-paper/release path');
    add(ref);
  };
  const versionRoot = iteration => {
    insist(Number.isSafeInteger(iteration) && iteration > 0, 'Invalid guard iteration');
    return `${CAMPAIGN}/coverage/${paper.paperId}/c${String(iteration).padStart(3, '0')}`;
  };
  const enrollment = paper.guardEnrollment ?? paper.staged?.guard?.enrollment;
  if (enrollment) {
    exact(enrollment.profile, versionRoot(paper.iteration) + '/guard-order.json');
    exact(enrollment.instructions, versionRoot(paper.iteration) + '/guard-order.md');
    const profile = JSON.parse(readUtf8(root, enrollment.profile, tracked).replace(/^\uFEFF/, ''));
    insist(profile.schemaVersion === 1 && profile.profile === 'source-scope-v1' && profile.paperId === paper.paperId && profile.iteration === paper.iteration
      && refKey(profile.scan) === refKey(paper.scan) && refKey(profile.order) === refKey(paper.order) && profile.workRoot === paper.workRoot, 'Guard profile binding mismatch');
    exact(profile.policy, CAMPAIGN + '/coverage/guard-policy-v1.json');
    const policy = JSON.parse(readUtf8(root, profile.policy, tracked).replace(/^\uFEFF/, ''));
    insist(policy.schemaVersion === 1 && policy.profile === 'source-scope-v1' && Array.isArray(policy.modules), 'Invalid guard policy');
    const releaseRoot = CAMPAIGN + '/architecture/batch-scope-20261029';
    exact(policy.release, releaseRoot + '/release-manifest.json');
    const moduleNames = new Set(['coverage.mjs', 'coverage-guard.mjs', 'coverage-scope.mjs', 'coverage-batch.mjs', 'COVERAGE_GUARDS.md', 'BATCH_API.md', 'SCOPE_API.md']);
    for (const ref of policy.modules) {
      const filename = path.basename(validRef(root, ref));
      insist(moduleNames.has(filename), 'Unknown frozen neutral guard module');
      exact(ref, releaseRoot + '/release/' + filename);
    }
  }
  // Exact source-enrollment fields only; no recursive authority from checkpoint/draft refs.
  for (const name of ['profile', 'sourceBinding', 'releaseManifest', 'supplementOrder']) add(paper.sourceEnrollment[name]);
  const sourceRelease = JSON.parse(readUtf8(root, paper.sourceEnrollment.releaseManifest, tracked).replace(/^\uFEFF/, ''));
  // loadPaper/sourceAdmissionReferences already validate the exact release module set and paths.
  for (const row of sourceRelease.modules) add(row.frozen);
  // Explicit typed fields only: never expose guard.references, contractSource,
  // scopeReviewSource or recursively treat sidecar refs as new permissions.
  if (paper.latest?.guard?.contract) exact(paper.latest.guard.contract, versionRoot(paper.latest.iteration) + '/source-scope-v2.json');
  if (role === 'reviewer') {
    if (paper.staged?.guard?.contract) exact(paper.staged.guard.contract, versionRoot(paper.iteration) + '/source-scope-v2.json');
    if (paper.latest?.guard?.scopeReview) exact(paper.latest.guard.scopeReview, versionRoot(paper.latest.iteration) + '/scope-review-v2.json');
  }
  for (const resource of sourceView.resources) add({path: resource.path, sha256: resource.sha256}, null, resource.type !== 'text');
  for (const ref of [paper.scan, paper.firstPass.result, paper.firstPass.acceptance,
    role === 'worker' ? paper.order : paper.staged?.reviewOrder,
    paper.latest?.candidate, paper.latest?.decision, opened.candidate?.ref].filter(Boolean)) add(ref);
  const result = JSON.parse(readUtf8(root, paper.firstPass.result, tracked).replace(/^\uFEFF/, ''));
  insist(result.paperId === paper.paperId, 'Public result paper mismatch');
  for (const claim of result.claims) for (const evidence of claim.evidence) {
    insist(/^[A-Za-z0-9_-]+$/.test(evidence.runId), 'Invalid public evidence run');
    const directory = path.resolve(root, `${CLEAN}/runs/${paper.paperId}/${evidence.runId}`);
    add({path: safeWithin(directory, evidence.path), sha256: evidence.sha256}, directory);
  }
  // Only explicit same-paper candidate artifacts, never an arbitrary directory walk.
  const candidates = [paper.latest?.candidate && {ref: paper.latest.candidate, historical: true},
    opened.candidate?.ref && {ref: opened.candidate.ref, historical: opened.candidate.selection === 'latest_assessed_snapshot'}].filter(Boolean);
  for (const {ref, historical} of candidates) {
    const candidate = JSON.parse(readUtf8(root, ref, tracked).replace(/^\uFEFF/, ''));
    insist(candidate.schemaVersion === 2, 'Candidate requires source-binding schema');
    sameSourceBinding(root, candidate.sourceBinding, paper.sourceEnrollment.sourceBinding, 'candidate enrolled source binding');
    insist(candidate.paperId === paper.paperId && candidate.scanSha256 === paper.scan.sha256, 'Candidate binding mismatch');
    for (const assessment of candidate.assessments) for (const evidence of assessment.evidence) {
      if (evidence.kind === 'new') {
        const directory = path.resolve(root, `${CLEAN}/coverage_work/${paper.paperId}`);
        const currentDirectory = path.resolve(directory, `c${String(paper.iteration).padStart(3, '0')}`);
        for (const artifact of [...evidence.artifacts, ...(evidence.execution ? [evidence.execution.receipt] : [])]) {
          const absolute = validRef(root, artifact);
          insist(historical || within(currentDirectory, absolute) || allowed.has(refKey(artifact)), 'Current candidate artifact is outside its current root and exact prior public evidence');
          add(artifact, directory);
        }
      } else {
        insist(evidence.kind === 'reuse', 'Invalid evidence kind');
        for (const artifact of evidence.artifacts) insist(allowed.has(refKey(artifact)), 'Reuse is outside exact same-paper public evidence');
      }
    }
  }
  if (role === 'reviewer') {
    for (const ref of [paper.firstPass.review, paper.latest?.review, paper.latest?.guard?.scopeReview].filter(Boolean)) {
      add(ref);
      const review = JSON.parse(readUtf8(root, ref, tracked).replace(/^\uFEFF/, ''));
      insist(review.paperId === paper.paperId, 'Private review paper mismatch');
      const privateRoots = ['verifications', 'coverage_verifications'].map(name => path.resolve(root, `${CLEAN}/${name}/${paper.paperId}`));
      // A sealed review's exact refs may authorize private artifacts, but refs in
      // those artifacts do not recursively expand authority to arbitrary files.
      const walk = value => {
        if (!value || typeof value !== 'object') return;
        if (!Array.isArray(value) && Object.keys(value).length === 2 && Object.hasOwn(value, 'path') && Object.hasOwn(value, 'sha256')) {
          const absolute = validRef(root, value);
          if (privateRoots.some(directory => within(directory, absolute))) add(value);
          return;
        }
        for (const child of Object.values(value)) walk(child);
      };
      walk(review);
    }
  }
  return {allowed, binary, refKey};
}
function validateReaderArgs(request, manifest, candidatePath) {
  insist(Array.isArray(request.argv) && request.argv.length <= 10 && request.argv.every(value => typeof value === 'string' && value.length <= 4096), 'Invalid reader argv');
  const args = [...request.argv], index = args.indexOf('--candidate');
  if (index >= 0) {
    insist(index === args.length - 2 && args.lastIndexOf('--candidate') === index && candidatePath !== null && args[index + 1] === candidatePath, 'Reader candidate differs from manifest');
    args.splice(index, 2);
  } else insist(candidatePath === null, 'Reader argv must retain manifest --candidate');
  insist(['open', 'get', 'list', 'read'].includes(args[0]) && args[1] === manifest.paperId && args[2] === manifest.role, 'Reader request differs from same-paper role');
  if (args[0] !== 'open') insist(args[3] === manifest.snapshotKey, 'Reader snapshot differs from manifest');
  return args;
}
async function readerObject(root, request, manifest, candidatePath) {
  const args = validateReaderArgs(request, manifest, candidatePath), value = await runReader(root, request.argv);
  if (args[0] === 'get') {
    if (Object.hasOwn(value, 'content')) return {text: canonical(value.content), encoding: 'canonical-json', scope: 'object'};
    insist(value.contentNotInline && value.read?.argv, 'Unknown oversized reader response');
    const next = [...value.read.argv], chunks = []; let offset = 0;
    for (;;) {
      next[6] = String(offset); next[7] = '12000';
      const part = await runReader(root, next);
      insist(part.offset === offset && !part.binaryNotRead, 'Unexpected reader object continuation');
      chunks.push(part.chunk);
      if (part.nextOffset === null) { const text = chunks.join(''); insist(hash(text) === value.sha256, 'Object continuation hash mismatch'); return {text, encoding: 'canonical-json', scope: 'object'}; }
      insist(part.nextOffset > offset, 'Reader continuation made no progress'); offset = part.nextOffset;
    }
  }
  if (args[0] === 'read') {
    insist(!value.binaryNotRead, 'Binary resource requires a bound asset viewer');
    const chunks = [value.chunk], next = [...args, ...readerTail(candidatePath)];
    // A read request means the exact remaining content from its explicit start.
    // The supplied length is a transport window, not permission to omit the tail.
    next.splice(6, args.length - 6, String(value.offset), '12000');
    let current = value;
    while (current.nextOffset !== null) {
      next[6] = String(current.nextOffset);
      const part = await runReader(root, next);
      insist(part.sha256 === value.sha256 && part.offset === current.end && part.end > part.offset, 'Reader continuation changed');
      chunks.push(part.chunk); current = part;
    }
    const text = chunks.join('');
    insist(text.length === value.utf16Length - value.offset && (value.offset !== 0 || hash(text) === value.sha256), 'Reader remainder hash/length mismatch');
    return {text, encoding: value.encoding, scope: value.offset === 0 ? 'full-content' : `remainder-from-utf16-${value.offset}`};
  }
  return {text: canonical(value), encoding: 'canonical-json', scope: args[0] === 'list' ? 'directory-preview-page' : 'navigation-response'};
}
function cursorToken(batchKey, index, offset, object) {
  const payload = [1, batchKey, index, offset, object.requestKey, object.sha256];
  return Buffer.from(canonical(payload)).toString('base64url') + '.' + digest(payload);
}
function decodeCursor(token, batchKey, objects) {
  insist(typeof token === 'string' && token.length <= 1024 && /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token), 'Invalid cursor');
  const [body, seal] = token.split('.'); let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { fail('Invalid cursor encoding'); }
  insist(Array.isArray(payload) && payload.length === 6 && payload[0] === 1 && digest(payload) === seal && Buffer.from(canonical(payload)).toString('base64url') === body, 'Cursor integrity mismatch');
  const [, key, index, offset, requestKey, sha256] = payload;
  insist(key === batchKey, 'Stale cursor: manifest, snapshot or content changed');
  insist(Number.isSafeInteger(index) && index >= 0 && index < objects.length && Number.isSafeInteger(offset) && offset >= 0, 'Invalid cursor position');
  const object = objects[index];
  insist(object.requestKey === requestKey && object.sha256 === sha256, 'Cursor request/content mismatch');
  insist(offset < object.text.length || (offset === 0 && object.text.length === 0), 'Invalid exhausted cursor');
  insist(!middle(object.text, offset), 'Cursor splits UTF-16 surrogate pair');
  return {index, offset};
}
/** Pure byte-bounded paginator. Objects must be fully materialized and sealed. */
export function pageObjects(objects, batchKey, {cursor = null, maxBytes = MAX_BATCH_BYTES} = {}) {
  maxBytes = boundedInteger(maxBytes, MIN_BATCH_BYTES, MAX_BATCH_BYTES, 'max-bytes');
  insist(Array.isArray(objects) && objects.length > 0 && objects.length <= 1024 && SHA.test(batchKey), 'Invalid batch objects');
  const ids = new Set();
  for (const object of objects) {
    insist(object && typeof object.text === 'string' && typeof object.id === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(object.id)
      && !ids.has(object.id) && SHA.test(object.requestKey) && SHA.test(object.sha256) && hash(object.text) === object.sha256,
    'Invalid or changed batch object seal');
    insist(['canonical-json', 'utf8-artifact', 'utf8-source'].includes(object.encoding) && typeof object.scope === 'string' && object.scope.length <= 80, 'Invalid batch encoding/scope');
    ids.add(object.id);
  }
  let {index, offset} = cursor === null ? {index: 0, offset: 0} : decodeCursor(cursor, batchKey, objects);
  const output = {schemaVersion: 1, batchKey, maxBytes, requestCount: objects.length, complete: false, chunks: [], nextCursor: null};
  const setNext = (i, n) => { output.complete = i === objects.length; output.nextCursor = output.complete ? null : cursorToken(batchKey, i, n, objects[i]); };
  setNext(index, offset);
  while (index < objects.length) {
    const object = objects[index], start = offset;
    const make = end => ({requestIndex: index, id: object.id, requestKey: object.requestKey, sha256: object.sha256,
      encoding: object.encoding, scope: object.scope, offset: start, end, total: object.text.length,
      complete: end === object.text.length, chunk: object.text.slice(start, end)});
    const attempt = end => {
      output.chunks.push(make(end));
      setNext(end === object.text.length ? index + 1 : index, end === object.text.length ? 0 : end);
      const fits = serializedBytes(output) <= maxBytes; output.chunks.pop(); return fits;
    };
    let end = object.text.length;
    if (!attempt(end)) {
      let low = start, high = end;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (attempt(mid)) low = mid; else high = mid - 1; }
      end = middle(object.text, low) ? low - 1 : low;
      if (end === start) { setNext(index, start); break; }
    }
    output.chunks.push(make(end));
    if (end === object.text.length) { index++; offset = 0; } else offset = end;
    setNext(index, offset);
    if (end < object.text.length) break;
  }
  insist(output.chunks.length > 0 && serializedBytes(output) <= maxBytes, 'Metadata cannot fit output budget');
  return output;
}
async function execute(root, options) {
  root = path.resolve(root);
  const {command, values, candidatePath, maxBytes, cursor} = options;
  if (command === 'open') {
    const [paperId, role, agent] = values;
    insist(agent.length > 0 && agent.length <= 200, 'Invalid agent');
    const {opened, privateRoot} = await openBound(root, paperId, role, agent, candidatePath);
    const current = await openBound(root, paperId, role, agent, candidatePath);
    insist(current.opened.snapshotKey === opened.snapshotKey, 'Paper/owner changed during open');
    const output = {schemaVersion: 1, paperId, role, agent, snapshotKey: opened.snapshotKey,
      privateRoot: path.relative(root, privateRoot).replaceAll('\\', '/'), maxBytes, complete: true, scientificAcceptance: false};
    insist(serializedBytes(output) <= maxBytes, 'Open metadata exceeds output budget'); return output;
  }
  const identity = manifestIdentity(root, values[0]), tracked = new Map(), manifestRef = fileRef(root, identity.absolute);
  const manifest = JSON.parse(readUtf8(root, manifestRef, tracked).replace(/^\uFEFF/, ''));
  shape(manifest, ['schemaVersion', 'paperId', 'role', 'agent', 'snapshotKey', 'candidatePath', 'requests'], ['schemaVersion', 'paperId', 'role', 'agent', 'snapshotKey', 'requests']);
  insist(manifest.schemaVersion === 1 && manifest.paperId === identity.paperId && manifest.role === identity.role && SHA.test(manifest.snapshotKey), 'Manifest identity mismatch');
  insist(typeof manifest.agent === 'string' && manifest.agent.length > 0 && manifest.agent.length <= 200, 'Invalid manifest agent');
  const selectedPath = manifest.candidatePath ?? null;
  insist(selectedPath === null || typeof selectedPath === 'string', 'Invalid candidatePath');
  const {binding, opened, privateRoot} = await openBound(root, manifest.paperId, manifest.role, manifest.agent, selectedPath);
  insist(opened.snapshotKey === manifest.snapshotKey, 'Stale manifest snapshot; reopen and author a new manifest');
  const permissions = allowlist(binding, opened, manifest.role, tracked), seen = new Set(), objects = [], materialized = new Map();
  insist(Array.isArray(manifest.requests) && manifest.requests.length > 0 && manifest.requests.length <= 1024, 'Expected 1..1024 requests');
  for (const request of manifest.requests) {
    shape(request, ['id', 'argv', 'ref'], ['id']);
    insist(typeof request.id === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(request.id) && !seen.has(request.id), 'Invalid or duplicate request id'); seen.add(request.id);
    insist(Object.hasOwn(request, 'argv') !== Object.hasOwn(request, 'ref'), 'Request needs exactly one argv or ref');
    // Per-invocation reuse only. Duplicate requests retain separate identities
    // and positions; no persistent cache can hide later source/owner changes.
    const contentKey = digest(request.argv ? {argv: request.argv} : {ref: request.ref});
    let value = materialized.get(contentKey);
    if (!value && request.argv) value = await readerObject(root, request, manifest, selectedPath);
    else if (!value) {
      const absolute = validRef(root, request.ref), key = permissions.refKey(request.ref);
      insist(permissions.allowed.has(key) || within(privateRoot, absolute), 'Artifact is outside exact authorized same-paper refs/own root');
      insist(!permissions.binary.has(key) && !/\.(?:pdf|png|jpe?g|gif|webp|zip|woff2?|exe|dll)$/i.test(absolute), 'Binary artifact requires a bound asset viewer');
      value = {text: readUtf8(root, request.ref, tracked), encoding: 'utf8-artifact', scope: 'full-content'};
    }
    materialized.set(contentKey, value);
    objects.push({id: request.id, requestKey: digest(request), sha256: hash(value.text), ...value});
  }
  const batchKey = digest({schemaVersion: 1, manifest: manifestRef, snapshotKey: opened.snapshotKey,
    objects: objects.map(({text, ...descriptor}) => ({...descriptor, total: text.length}))});
  const output = pageObjects(objects, batchKey, {cursor, maxBytes});
  // Re-read all input seals and this paper's own snapshot immediately before
  // return; an unrelated paper/global revision is deliberately not a dependency.
  for (const ref of tracked.values()) checkRef(root, ref);
  const current = await openBound(root, manifest.paperId, manifest.role, manifest.agent, selectedPath);
  insist(current.opened.snapshotKey === opened.snapshotKey, 'Paper/owner/candidate changed during batch');
  for (const ref of tracked.values()) checkRef(root, ref);
  binding.sourceView.recheck();
  return output;
}
/** One page only; API errors are bounded values, just like CLI errors. */
export async function runBatch(root, argv) {
  let maxBytes = MAX_BATCH_BYTES;
  try { const options = parse(argv); maxBytes = options.maxBytes; return await execute(root, options); }
  catch (error) {
    // Do not echo arbitrary argv/paths/file content into an error. Preserve only
    // a short diagnostic, cap escaped JSON bytes including its final newline.
    let message = String(error?.message ?? 'Batch failed').slice(0, 240);
    let output = {schemaVersion: 1, error: message, complete: false, nextCursor: null, scientificAcceptance: false};
    while (serializedBytes(output) > maxBytes && message.length) { message = message.slice(0, -1); output.error = message; }
    return output;
  }
}

if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  runBatch(root, process.argv.slice(2)).then(value => { process.stdout.write(JSON.stringify(value) + '\n'); if (value.error) process.exitCode = 1; });
}
