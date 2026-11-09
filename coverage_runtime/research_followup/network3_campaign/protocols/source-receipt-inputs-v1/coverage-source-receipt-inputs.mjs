// Read-only current source-binding receipt inputs. No old-version grants or execution.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical, hash, checkRef, fileRef} from '../source-binding-v1-checkpoint/coverage-core.mjs';
import {loadPaper, safeWithin} from '../source-binding-v1-checkpoint/coverage-context.mjs';
import {sourceAdmissionReferences} from '../source-binding-v1-checkpoint/source-admission.mjs';
import {guardReferences} from '../source-binding-v1-checkpoint/coverage-guard.mjs';
import {pageObjects, serializedBytes, MAX_BATCH_BYTES, MIN_BATCH_BYTES} from '../source-binding-v1-checkpoint/coverage-batch.mjs';

export const PROTOCOL = 'current-source-reviewer-receipt-inputs-v1';
export const MODULE_PATH = 'research_followup/network3_campaign/protocols/source-receipt-inputs-v1/coverage-source-receipt-inputs.mjs';
const CAMPAIGN = 'research_followup/network3_campaign', CLEAN = 'research_followup/reproduction_clean';
const SHA = /^[a-f0-9]{64}$/;
const insist = (value, message) => { if (!value) throw Error('Source receipt inputs: ' + message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => canonical(a) === canonical(b);
const key = filename => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);
const digest = value => hash(canonical(value));
function shape(value, allowed, required = allowed) {
  insist(plain(value) && Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k)), 'Unexpected or missing fields');
}
function reference(root, ref) {
  shape(ref, ['path', 'sha256']);
  insist(text(ref.path) && !/[\x00-\x1f]/.test(ref.path) && SHA.test(ref.sha256), 'Invalid exact reference');
  return safeWithin(root, ref.path);
}
const refKey = (root, ref) => key(reference(root, ref)) + ':' + ref.sha256;
const sameRef = (root, a, b) => refKey(root, a) === refKey(root, b);
function inside(directory, filename) {
  const relative = path.relative(directory, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function bounded(value, min, max, label) {
  insist(/^\d+$/.test(String(value)), 'Invalid ' + label);
  const n = Number(value); insist(Number.isSafeInteger(n) && n >= min && n <= max, 'Invalid ' + label); return n;
}
function currentIdentity(root, paperId, role, agent) {
  insist(/^(origin|r\d{4})$/.test(paperId) && role === 'reviewer' && text(agent) && agent.length <= 200, 'Current reviewer identity required');
  const binding = loadPaper(root, paperId), {paper} = binding;
  insist(paper.phase === 'source_reviewing' && paper.owner?.role === role && paper.owner.agent === agent
    && Number.isFinite(Date.parse(paper.owner.startedAt)) && paper.sourceEnrollment?.protocol === 'source-supplement-v1', 'No matching checkpoint source-binding active reviewer');
  insist(Number.isSafeInteger(paper.iteration) && paper.iteration > 0, 'Invalid current iteration');
  insist(paper.staged?.candidate && text(paper.staged.worker) && paper.staged.worker !== agent
    && !(paper.workerHistory ?? []).includes(agent), 'Independent current staged reviewer required');
  const version = 'c' + String(paper.iteration).padStart(3, '0');
  const workRoot = safeWithin(root, `${CLEAN}/coverage_work/${paperId}/${version}`);
  const reviewRoot = safeWithin(root, `${CLEAN}/coverage_verifications/${paperId}/${version}`);
  insist(text(paper.workRoot) && key(safeWithin(root, paper.workRoot)) === key(workRoot)
    && text(paper.staged.reviewRoot) && key(safeWithin(root, paper.staged.reviewRoot)) === key(reviewRoot), 'Registered roots/version differ');
  insist(key(reference(root, paper.staged.candidate)) === key(path.resolve(root, `${CAMPAIGN}/coverage/${paperId}/${version}/candidate.json`)), 'Candidate is not exact current frozen candidate');
  return {...binding, workRoot, reviewRoot, identity: digest({protocol: PROTOCOL, paper})};
}

/** Metadata/seal validation only; denied inputs are never read before scope checks. */
export async function prepareSourceReceiptInputs({root, paperId, role, agent, receipt}) {
  root = path.resolve(root);
  const binding = currentIdentity(root, paperId, role, agent), {paper, scan, sourceView, workRoot, reviewRoot} = binding;
  const tracked = new Map();
  function consume(ref) {
    const filename = reference(root, ref), old = tracked.get(key(filename));
    insist(!old || old.sha256 === ref.sha256, 'Conflicting hashes for one file');
    const checked = checkRef(root, ref), bytes = fs.readFileSync(checked);
    insist(hash(bytes) === ref.sha256, 'Actual consumed bytes differ from reference');
    tracked.set(key(filename), {path: filename, sha256: ref.sha256}); return bytes;
  }
  function consumeAll(refs) {
    const pending = new Map();
    for (const ref of refs) {
      const id = key(reference(root, ref)), old = pending.get(id);
      insist(!old || old.sha256 === ref.sha256, 'Conflicting hashes for one file'); pending.set(id, ref);
    }
    for (const ref of pending.values()) consume(ref);
  }
  function utf8(ref) {
    const bytes = consume(ref), value = bytes.toString('utf8');
    insist(Buffer.from(value, 'utf8').equals(bytes), 'Input is not valid UTF-8'); return value;
  }
  function json(ref, max = 32 * 1024 * 1024) {
    insist(fs.statSync(reference(root, ref)).size <= max, 'Bound JSON exceeds size limit');
    return JSON.parse(utf8(ref).replace(/^\uFEFF/, ''));
  }
  // Fixed governance inputs are integrity references, never content grants.
  const state = JSON.parse(fs.readFileSync(binding.statePath, 'utf8').replace(/^\uFEFF/, ''));
  insist(equal(state.papers.find(p => p.paperId === paperId), paper), 'Paper changed during binding');
  const expectedAuthority = path.resolve(root, 'docs/network3-coverage-authorization-20261024.json');
  insist(key(reference(root, state.authority)) === key(expectedAuthority), 'Authority path mismatch');
  const authority = json(state.authority), scope = json(authority.scopeAuthority);
  json(scope.scope.nodes); json(authority.firstPassClosure);
  const checkedScan = json(paper.scan);
  insist(equal(checkedScan, scan) && digest(checkedScan) === paper.scan.sha256, 'Scan changed during binding');
  const moduleRef = fileRef(root, path.resolve(root, MODULE_PATH)); consume(moduleRef);
  const candidate = json(paper.staged.candidate);
  insist(digest(candidate) === paper.staged.candidate.sha256 && candidate.schemaVersion === 2 && candidate.paperId === paperId
    && candidate.revision === paper.iteration && candidate.author === paper.staged.worker
    && candidate.scanSha256 === paper.scan.sha256 && Array.isArray(candidate.assessments)
    && sameRef(root, candidate.sourceBinding, paper.sourceEnrollment.sourceBinding), 'Staged candidate/source binding mismatch');
  // Immutable admission history is integrity-only, never a readInput grant.
  consumeAll([...sourceAdmissionReferences(root, paper), ...guardReferences(root, paper)]);
  const sourceBinding = paper.sourceEnrollment.sourceBinding;
  const sourceScope = paper.staged.guard?.contract;
  const version = 'c' + String(paper.iteration).padStart(3, '0');
  insist(key(reference(root, sourceScope)) === key(path.resolve(root, `${CAMPAIGN}/coverage/${paperId}/${version}/source-scope-v2.json`)), 'Scope is not exact current frozen source scope');
  const contract = json(sourceScope);
  insist(digest(contract) === sourceScope.sha256 && contract.schemaVersion === 2 && contract.paperId === paperId
    && contract.revision === paper.iteration && contract.author === paper.staged.worker
    && contract.scanSha256 === paper.scan.sha256 && contract.candidateSha256 === paper.staged.candidate.sha256
    && sameRef(root, contract.sourceBinding, sourceBinding), 'Current scope/candidate/source binding mismatch');
  const receiptPath = reference(root, receipt);
  insist(inside(workRoot, receiptPath), 'Receipt outside current same-paper constructor root');
  const linked = [];
  for (const assessment of candidate.assessments) {
    insist(Array.isArray(assessment.evidence), 'Candidate evidence list required');
    for (const evidence of assessment.evidence) {
      if (evidence.kind !== 'new' || !evidence.execution) continue;
      shape(evidence.execution, ['receipt']);
      if (sameRef(root, evidence.execution.receipt, receipt)) linked.push(evidence);
    }
  }
  insist(linked.length > 0, 'Receipt is not explicitly bound by current new candidate evidence');
  const value = json(receipt, 1024 * 1024);
  const fields = ['schemaVersion', 'paperId', 'tool', 'version', 'command', 'invocation', 'workerCount', 'startedAt', 'finishedAt', 'exitCode', 'inputs', 'outputs'];
  shape(value, fields, ['paperId', 'tool', 'version', 'workerCount', 'startedAt', 'finishedAt', 'exitCode', 'inputs', 'outputs']);
  insist((value.schemaVersion === undefined || value.schemaVersion === 1) && value.paperId === paperId && text(value.tool) && text(value.version)
    && Number.isInteger(value.workerCount) && value.workerCount >= 1 && value.exitCode === 0, 'Invalid receipt identity/tool/workerCount/exitCode');
  const invocation = value.command ?? value.invocation;
  insist(Object.hasOwn(value, 'command') !== Object.hasOwn(value, 'invocation'), 'Exactly one command or invocation required');
  insist(text(invocation) || (Array.isArray(invocation) && invocation.length > 0 && invocation.every(text)) || (plain(invocation) && Object.keys(invocation).length > 0), 'Empty invocation');
  insist(Number.isFinite(Date.parse(value.startedAt)) && Number.isFinite(Date.parse(value.finishedAt)) && Date.parse(value.finishedAt) >= Date.parse(value.startedAt), 'Invalid receipt time range');
  for (const name of ['inputs', 'outputs']) insist(Array.isArray(value[name]) && value[name].length > 0 && value[name].length <= 1024, 'Receipt needs 1..1024 ' + name);
  const resources = new Map(sourceView.resources.map(resource => [refKey(root, {path: resource.path, sha256: resource.sha256}), resource]));
  // Existing public first-pass outputs may be dependencies of a current run.
  // Bind their exact typed refs for integrity only, never as text-read grants.
  safeWithin(safeWithin(root, `${CLEAN}/results/${paperId}`), reference(root, paper.firstPass.result));
  const publicResult = json(paper.firstPass.result), publicOutputs = new Map();
  insist(publicResult.paperId === paperId && Array.isArray(publicResult.claims), 'Public result identity differs');
  for (const claim of publicResult.claims) {
    insist(Array.isArray(claim.evidence), 'Public result evidence list required');
    for (const evidence of claim.evidence) {
      insist(typeof evidence.runId === 'string' && /^[A-Za-z0-9_-]+$/.test(evidence.runId), 'Invalid public evidence run');
      insist(text(evidence.path) && !path.isAbsolute(evidence.path), 'Public evidence path must be relative to its exact run');
      const directory = safeWithin(root, `${CLEAN}/runs/${paperId}/${evidence.runId}`);
      const ref = {path: safeWithin(directory, evidence.path), sha256: evidence.sha256};
      publicOutputs.set(refKey(root, ref), ref);
    }
  }
  const inputRefs = new Map(), integrityOnlyInputs = new Map(), binary = new Set();
  // Complete all path checks before hashing ANY receipt input/output/artifact.
  for (const ref of value.inputs) {
    const absolute = reference(root, ref), id = refKey(root, ref), resource = resources.get(id);
    const readable = inside(workRoot, absolute) || resource;
    insist(readable || publicOutputs.has(id), 'Input outside current constructor root, exact academic resources or bound public-output integrity');
    if (readable) {
      if (resource && resource.type !== 'text') binary.add(id);
      inputRefs.set(id, ref);
    } else integrityOnlyInputs.set(id, ref);
  }
  for (const ref of value.outputs) insist(inside(workRoot, reference(root, ref)), 'Output outside current constructor root');
  const artifacts = [];
  for (const evidence of linked) {
    insist(Array.isArray(evidence.artifacts) && evidence.artifacts.length > 0, 'Linked evidence lacks artifacts');
    for (const ref of evidence.artifacts) {
      insist(inside(workRoot, reference(root, ref)), 'Evidence artifact outside current constructor root');
      insist(value.outputs.some(output => sameRef(root, output, ref)), 'Receipt outputs do not cover every linked evidence artifact'); artifacts.push(ref);
    }
  }
  consumeAll([...inputRefs.values(), ...integrityOnlyInputs.values(), ...value.outputs, ...artifacts]);
  const sessionKey = digest({protocol: PROTOCOL, module: moduleRef, identity: binding.identity, candidate: paper.staged.candidate, scan: paper.scan, sourceBinding, sourceScope, receipt});
  const recheck = () => {
    sourceView.recheck();
    for (const ref of tracked.values()) checkRef(root, ref);
    const current = currentIdentity(root, paperId, role, agent);
    insist(current.identity === binding.identity, 'Owner/paper/candidate/source binding changed during receipt reading');
    current.sourceView.recheck(); sourceView.recheck();
    for (const ref of tracked.values()) checkRef(root, ref);
  };
  const readInput = ref => {
    const id = refKey(root, ref), absolute = reference(root, ref);
    insist(inputRefs.has(id), 'Request is not an exact direct receipt input');
    insist(!binary.has(id) && !/\.(?:pdf|png|jpe?g|gif|webp|zip|woff2?|exe|dll)$/i.test(absolute), 'Binary input requires a bound asset viewer');
    const result = utf8(ref);
    insist(!result.includes('\u0000'), 'Binary NUL bytes are not text input');
    return result;
  };
  recheck();
  return {sessionKey, paperId, role, agent, receipt, candidate: paper.staged.candidate, sourceBinding, scope: sourceScope,
    inputRefs: [...inputRefs.values()], receiptInputCount: value.inputs.length, integrityOnlyInputCount: integrityOnlyInputs.size, reviewRoot, recheck, readInput};
}

function parse(argv) {
  insist(Array.isArray(argv) && argv.every(arg => typeof arg === 'string'), 'Expected string argv');
  const args = [...argv], options = {maxBytes: MAX_BATCH_BYTES, cursor: null};
  for (const [flag, field] of [['--max-bytes', 'maxBytes'], ['--cursor', 'cursor']]) {
    const at = args.indexOf(flag); if (at < 0) continue;
    insist(at === args.lastIndexOf(flag) && at + 1 < args.length && !args[at + 1].startsWith('--'), 'Invalid flag');
    options[field] = args[at + 1]; args.splice(at, 2);
  }
  options.maxBytes = bounded(options.maxBytes, MIN_BATCH_BYTES, MAX_BATCH_BYTES, 'max-bytes');
  const [command, ...values] = args;
  insist(command === 'open' ? values.length === 5 && options.cursor === null : ['batch', 'read'].includes(command) && values.length === 1, 'Expected open or batch/read arguments');
  return {command, values, ...options};
}
async function execute(root, {command, values, cursor, maxBytes}) {
  root = path.resolve(root);
  if (command === 'open') {
    const [paperId, role, agent, receiptPath, receiptSha] = values;
    const prepared = await prepareSourceReceiptInputs({root, paperId, role, agent, receipt: {path: receiptPath, sha256: receiptSha}});
    const output = {schemaVersion: 1, protocol: PROTOCOL, sessionKey: prepared.sessionKey, paperId, role, agent, receipt: prepared.receipt,
      sourceBinding: prepared.sourceBinding, scope: prepared.scope, inputCount: prepared.inputRefs.length,
      receiptInputCount: prepared.receiptInputCount, integrityOnlyInputCount: prepared.integrityOnlyInputCount, maxBytes, complete: true, scientificAcceptance: false};
    insist(serializedBytes(output) <= maxBytes, 'Open metadata exceeds page budget'); prepared.recheck(); return output;
  }
  const manifestPath = safeWithin(root, values[0]), relative = path.relative(root, manifestPath).replaceAll('\\', '/');
  const match = relative.match(/^research_followup\/reproduction_clean\/coverage_verifications\/(origin|r\d{4})\/c\d{3,}\/.+$/);
  insist(match, 'Manifest must be in a current reviewer private root');
  const binding = loadPaper(root, match[1]);
  const current = currentIdentity(root, match[1], 'reviewer', binding.paper.owner?.agent);
  safeWithin(current.reviewRoot, manifestPath);
  insist(fs.statSync(manifestPath).size <= 1024 * 1024, 'Manifest exceeds 1 MiB');
  const manifestRef = fileRef(root, manifestPath), raw = fs.readFileSync(manifestPath);
  insist(hash(raw) === manifestRef.sha256 && Buffer.from(raw.toString('utf8'), 'utf8').equals(raw), 'Manifest bytes changed or are not UTF-8');
  const manifest = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  shape(manifest, ['schemaVersion', 'paperId', 'role', 'agent', 'sessionKey', 'receipt', 'requests']);
  insist(manifest.schemaVersion === 1 && manifest.paperId === match[1] && SHA.test(manifest.sessionKey), 'Invalid manifest identity');
  const prepared = await prepareSourceReceiptInputs({root, ...manifest});
  insist(prepared.sessionKey === manifest.sessionKey, 'Stale receipt session; reopen and create a new manifest');
  insist(Array.isArray(manifest.requests) && manifest.requests.length > 0 && manifest.requests.length <= 1024, 'Expected 1..1024 input requests');
  const ids = new Set(), objects = [], cache = new Map();
  for (const request of manifest.requests) {
    shape(request, ['id', 'ref']);
    insist(typeof request.id === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(request.id) && !ids.has(request.id), 'Invalid or duplicate request id'); ids.add(request.id);
    const id = refKey(root, request.ref);
    if (!cache.has(id)) cache.set(id, prepared.readInput(request.ref));
    const content = cache.get(id);
    objects.push({id: request.id, requestKey: digest(request), sha256: hash(content), text: content, encoding: 'utf8-artifact', scope: 'direct-receipt-input'});
  }
  const batchKey = digest({protocol: PROTOCOL, manifest: manifestRef, sessionKey: prepared.sessionKey, objects: objects.map(({text, ...rest}) => ({...rest, total: text.length}))});
  const output = pageObjects(objects, batchKey, {cursor, maxBytes});
  checkRef(root, manifestRef); prepared.recheck(); checkRef(root, manifestRef); return output;
}
export async function runSourceReceiptInputs(root, argv) {
  let maxBytes = MAX_BATCH_BYTES;
  try { const options = parse(argv); maxBytes = options.maxBytes; return await execute(root, options); }
  catch (error) {
    let message = String(error?.message ?? 'Receipt input read failed').slice(0, 240);
    const output = {schemaVersion: 1, error: message, complete: false, nextCursor: null, scientificAcceptance: false};
    while (serializedBytes(output) > maxBytes && message.length) { message = message.slice(0, -1); output.error = message; } return output;
  }
}
if (process.argv[1] && key(process.argv[1]) === key(fileURLToPath(import.meta.url))) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const output = await runSourceReceiptInputs(root, process.argv.slice(2));
  process.stdout.write(JSON.stringify(output) + '\n'); if (output.error) process.exitCode = 1;
}
