// Narrow original-reviewer append intake; existing scientific validators unchanged.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {canonical, hash, fileRef, checkRef, validateReview} from '../../coverage-core.mjs';
import {loadPaper, safeWithin, previousFor} from '../../coverage-context.mjs';
import {guardRequired, guardAdmissionReferences, guardPrevious, prepareReviewGuard, guardSummary} from '../../coverage-guard.mjs';
import {writeOnceOrMatch} from '../../repair-flow.mjs';

const BASE = 'research_followup/network3_campaign';
export const MODULE_PATH = BASE + '/protocols/review-append-v1/coverage-review-append.mjs';
export const RELEASE_PATH = BASE + '/architecture/review-append-20261030/release-manifest.json';
export const REQUIRED_UPSTREAM = Object.freeze([
  'paper_library/dot-library.mjs', 'paper_library/library.mjs', 'paper_library/revocations.mjs', 'paper_library/workflow-contract.mjs',
  ...['coverage-context', 'coverage-core', 'coverage-guard', 'coverage-recovery', 'coverage-scan', 'coverage-scope', 'coverage', 'repair-flow'].map(name => BASE + '/' + name + '.mjs'),
  ...['inputs', 'reading', 'results', 'runs'].map(name => 'research_followup/reproduction_clean/runtime/' + name + '.mjs'),
  'research_tree/src/journal-model.mjs', 'research_tree/src/review-model.mjs', 'sources/resolve-source.mjs',
]);
const insist = (ok, message) => { if (!ok) throw Error('Append review: ' + message); };
const equal = (a, b) => canonical(a) === canonical(b), digest = value => hash(canonical(value));
const text = value => typeof value === 'string' && value.trim().length > 0;
const key = name => process.platform === 'win32' ? path.resolve(name).toLowerCase() : path.resolve(name);
const read = name => JSON.parse(fs.readFileSync(name, 'utf8').replace(/^\uFEFF/, ''));
function refPath(root, ref) {
  insist(ref && equal(Object.keys(ref).sort(), ['path', 'sha256']) && text(ref.path) && /^[a-f0-9]{64}$/.test(ref.sha256), 'Invalid exact reference');
  return safeWithin(root, ref.path);
}
const sameRef = (root, a, b) => key(refPath(root, a)) === key(refPath(root, b)) && a.sha256 === b.sha256;
function expected(root, ref, filename, label) { insist(key(refPath(root, ref)) === key(safeWithin(root, filename)), label + ' path differs'); }
function unique(root, refs) {
  const result = new Map();
  for (const ref of refs) { const id = key(refPath(root, ref)), old = result.get(id); insist(!old || old.sha256 === ref.sha256, 'Conflicting reference hashes'); result.set(id, ref); }
  return [...result.values()];
}
function refsIn(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Object.hasOwn(value, 'path') && Object.hasOwn(value, 'sha256')) { output.push(value); return output; }
  for (const child of Object.values(value)) refsIn(child, output);
  return output;
}
function noCollision(root, filename, bytes) {
  const target = safeWithin(root, filename);
  if (fs.existsSync(target)) insist(fs.readFileSync(target).equals(Buffer.from(bytes)), 'Existing frozen output conflicts: ' + path.basename(target));
}

export async function prepareAppendedReview({root, state, paper, request}) {
  root = path.resolve(root);
  const keys = ['schemaVersion', 'expectedRevision', 'paperId', 'agent', 'ownerFinished', 'noActiveCalculation', 'supervisor', 'release', 'ownerTerminal', 'review', 'scopeReview'];
  insist(request && equal(Object.keys(request).sort(), keys.sort()) && request.schemaVersion === 1, 'Request schema differs');
  insist(Number.isSafeInteger(request.expectedRevision) && request.expectedRevision === state.revision, 'Stale expectedRevision');
  insist(request.ownerFinished === true && request.noActiveCalculation === true && text(request.supervisor), 'Actual supervisor must confirm natural owner/calculation completion');
  const binding = loadPaper(root, request.paperId);
  insist(equal(binding.paper, paper) && equal(read(binding.statePath), state), 'Current state/paper changed');
  insist(paper.phase === 'reviewing' && paper.owner?.role === 'reviewer' && paper.owner.agent === request.agent
    && !Object.hasOwn(paper, 'sourceEnrollment') && !paper.staged?.review, 'Matching original ordinary reviewer required');
  insist(request.agent !== paper.staged.worker && !(paper.workerHistory ?? []).includes(request.agent), 'Reviewer is not independent');
  insist(guardRequired(root, state, paper) && paper.staged.guard?.contract, 'This route requires unchanged active source-scope gates');
  const refs = [];
  function bytes(ref) {
    refPath(root, ref); const value = fs.readFileSync(checkRef(root, ref));
    insist(hash(value) === ref.sha256, 'Actual consumed bytes differ'); refs.push(ref); return value;
  }
  function json(ref) {
    insist(fs.statSync(refPath(root, ref)).size <= 32 * 1024 * 1024, 'Bound JSON too large');
    const value = bytes(ref), decoded = value.toString('utf8'); insist(Buffer.from(decoded).equals(value), 'Invalid UTF-8');
    return JSON.parse(decoded.replace(/^\uFEFF/, ''));
  }
  const authority = json(state.authority), scope = json(authority.scopeAuthority);
  insist(request.supervisor === (authority.supervisorThreadId ?? authority.supervisor?.threadId), 'Wrong scientific supervisor');
  json(scope.scope.nodes); json(authority.firstPassClosure);
  expected(root, request.release, RELEASE_PATH, 'release');
  const release = json(request.release);
  insist(release.schemaVersion === 1 && release.releaseId === 'review-append-20261030', 'Invalid release');
  expected(root, release.entry, MODULE_PATH, 'module'); bytes(release.entry);
  insist(Array.isArray(release.upstream) && release.upstream.length === REQUIRED_UPSTREAM.length, 'Dependency seal differs');
  for (const name of REQUIRED_UPSTREAM) {
    const matches = release.upstream.filter(ref => key(refPath(root, ref)) === key(path.resolve(root, name)));
    insist(matches.length === 1, 'Missing/duplicate upstream dependency'); bytes(matches[0]);
  }
  expected(root, release.diagnostic, BASE + '/coverage/requests/interface-diagnostic-r0162-appended-review-20261030.json', 'diagnostic');
  const diagnostic = json(release.diagnostic);
  insist(diagnostic.paperId === paper.paperId && diagnostic.iteration === paper.iteration && equal(diagnostic.owner, paper.owner), 'Original actor/version differs');
  insist(sameRef(root, diagnostic.stagedCandidate, paper.staged.candidate), 'Candidate differs from diagnosed version');
  expected(root, diagnostic.neutralModule, BASE + '/coverage-guard.mjs', 'original guard'); bytes(diagnostic.neutralModule);
  const version = 'c' + String(paper.iteration).padStart(3, '0');
  const privateRoot = safeWithin(root, `research_followup/reproduction_clean/coverage_verifications/${paper.paperId}/${version}`);
  insist(key(safeWithin(root, paper.staged.reviewRoot)) === key(privateRoot)
    && key(safeWithin(root, diagnostic.registeredReviewRoot)) === key(privateRoot), 'Registered private root differs');
  const editions = diagnostic.observedReviewVersions;
  for (const name of ['review.json', 'scope-review.json', 'final/review.json', 'final/scope-review.json'])
    expected(root, editions[name], path.join(privateRoot, name), 'diagnosed pair');
  insist(sameRef(root, request.review, editions['final/review.json']) && sameRef(root, request.scopeReview, editions['final/scope-review.json']), 'New pair differs from exact diagnosed delivery');
  insist(key(path.dirname(refPath(root, request.review))) === key(path.dirname(refPath(root, request.scopeReview))), 'New pair must be co-located');
  expected(root, request.ownerTerminal, path.join(privateRoot, 'terminal-receipt.json'), 'owner terminal');
  insist(sameRef(root, request.ownerTerminal, release.ownerTerminal), 'Original terminal differs from release');
  const terminal = json(request.ownerTerminal);
  insist(terminal.schemaVersion === 1 && terminal.paperId === paper.paperId && terminal.revision === paper.iteration
    && terminal.reviewerAgent === paper.owner.agent && terminal.ownerStartedAt === paper.owner.startedAt
    && terminal.state === 'reviewer_completed_pending_supervisor_intake', 'Original terminal identity/state differs');
  for (const [name, ref] of Object.entries({scan: paper.scan, candidate: paper.staged.candidate, reviewOrder: paper.staged.reviewOrder,
    guardOrder: paper.guardEnrollment.profile, sourceScope: paper.staged.guard.contract}))
    insist(sameRef(root, terminal[name], ref), 'Terminal binding differs: ' + name);
  insist(sameRef(root, terminal.deliverables?.review, request.review) && sameRef(root, terminal.deliverables?.scopeReview, request.scopeReview)
    && sameRef(root, terminal.initialDrafts?.review, editions['review.json']) && sameRef(root, terminal.initialDrafts?.scopeReview, editions['scope-review.json']), 'Terminal does not bind both retained and final pairs');
  const execution = terminal.execution;
  insist(execution?.workerCount === 1 && execution.scientificRuns === 0 && execution.finalizer?.endedNaturally === true
    && execution.finalizer.observedExitCode === 0 && Array.isArray(execution.activeTaskOwnedBackgroundProcesses) && !execution.activeTaskOwnedBackgroundProcesses.length
    && Array.isArray(execution.activeTaskOwnedScientificPids) && !execution.activeTaskOwnedScientificPids.length, 'Terminal has pending/unknown execution');
  const allowedExternal = [paper.scan, paper.staged.candidate, paper.staged.reviewOrder, paper.guardEnrollment.profile, paper.staged.guard.contract];
  const terminalRefs = refsIn(terminal);
  insist(terminalRefs.length <= 1024, 'Terminal reference inventory too large');
  // Resolve every terminal path before reading its file; no recursive content grant.
  for (const ref of terminalRefs) {
    if (!allowedExternal.some(known => sameRef(root, known, ref))) safeWithin(privateRoot, refPath(root, ref));
  }
  for (const ref of terminalRefs) bytes(ref);
  const oldReview = json(editions['review.json']); json(editions['scope-review.json']);
  const review = json(request.review), scopeReview = json(request.scopeReview);
  const candidate = json(paper.staged.candidate), scan = json(paper.scan);
  insist(digest(candidate) === paper.staged.candidate.sha256 && equal(scan, binding.scan), 'Noncanonical/mismatched candidate or scan');
  insist(review.reviewerAgent === paper.owner.agent && oldReview.reviewerAgent === paper.owner.agent
    && review.candidateSha256 === paper.staged.candidate.sha256 && oldReview.candidateSha256 === paper.staged.candidate.sha256, 'Review author/candidate changed');
  const oldEntries = new Map(oldReview.entries.map(entry => [entry.obligationId, entry]));
  insist(oldEntries.size === oldReview.entries.length && review.entries.length === oldEntries.size
    && new Set(review.entries.map(entry => entry.obligationId)).size === oldEntries.size
    && review.entries.every(entry => oldEntries.get(entry.obligationId)?.verdict === entry.verdict)
    && equal([...review.retainedObligationIds].sort(), [...oldReview.retainedObligationIds].sort()), 'This correction cannot change verdicts or retained IDs');
  const changed = review.entries.filter(entry => entry.reason !== oldEntries.get(entry.obligationId).reason).map(entry => entry.obligationId).sort();
  insist(diagnostic.deltaSummary?.verdictsIdentical === true && equal(changed, [...diagnostic.deltaSummary.changedReasonIds].sort()), 'Reason delta differs from diagnosed correction');
  // The legacy core checks these same evidence categories, but hashes first.
  // Pre-authorize every main-review artifact before calling it; retain its
  // full independent-evidence, alias, assessment and scientific validation.
  const paperReviewRoot = safeWithin(root, `research_followup/reproduction_clean/coverage_verifications/${paper.paperId}`);
  for (const entry of review.entries) {
    const assessment = candidate.assessments.find(value => value.obligationId === entry.obligationId);
    insist(assessment && Array.isArray(entry.evidence), 'Unknown assessment or invalid review evidence');
    const reusedOnly = assessment.evidence.length > 0 && assessment.evidence.every(value => value.kind === 'reuse');
    const reusedRefs = [scan.firstPass.review, ...assessment.evidence.filter(value => value.kind === 'reuse').flatMap(value => value.artifacts)];
    for (const ref of entry.evidence) {
      const relative = path.relative(paperReviewRoot, refPath(root, ref));
      const own = !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
      insist(own || (reusedOnly && reusedRefs.some(value => sameRef(root, value, ref))), 'Main review evidence outside exact authorized support');
    }
  }
  refs.push(...guardAdmissionReferences(root, state, paper), ...scan.resources.map(({path, sha256}) => ({path, sha256})), ...refsIn(review));
  const previous = guardPrevious(root, paper.latest, previousFor(root, paper));
  // Select only the paired sidecar's location for the existing pure guard.
  // Neither actual paper nor state is changed by this projection.
  const projected = {...paper, staged: {...paper.staged, reviewRoot: path.dirname(refPath(root, request.review))}};
  const guarded = prepareReviewGuard({root, state, paper: projected, scan, candidate, review, actor: paper.owner.agent, previous});
  insist(guarded, 'Required scope guard is absent');
  await validateReview({root, scan, candidate, candidateSha256: paper.staged.candidate.sha256, review,
    reviewer: paper.owner.agent, worker: paper.staged.worker, previous});
  // Preserve the exact evidence just authorized by the unchanged validator.
  // A candidate JSON seal alone cannot detect later changes to its artifacts.
  // Receipt expansion is one hop only, never arbitrary referenced content.
  for (const assessment of candidate.assessments) for (const evidence of assessment.evidence) {
    refs.push(...evidence.artifacts);
    if (evidence.kind === 'reuse') refs.push(evidence.legacy.result, evidence.legacy.review, evidence.legacy.acceptance);
    if (evidence.execution) {
      const receipt = json(evidence.execution.receipt);
      refs.push(...receipt.inputs, ...receipt.outputs);
    }
  }
  refs.push(...refsIn(scopeReview));
  const references = unique(root, refs), identity = digest(paper);
  const recheck = () => {
    for (const ref of references) checkRef(root, ref);
    insist(digest(loadPaper(root, paper.paperId).paper) === identity, 'Original owner/paper changed during validation');
    guarded.recheck(); for (const ref of references) checkRef(root, ref);
  };
  const directory = safeWithin(root, `${BASE}/coverage/${paper.paperId}/${version}`);
  const proof = {schemaVersion: 1, protocol: 'review-append-v1', paperId: paper.paperId, iteration: paper.iteration,
    originalOwner: paper.owner, candidate: paper.staged.candidate, scan: paper.scan, registeredReviewRoot: paper.staged.reviewRoot,
    release: request.release, diagnostic: release.diagnostic, terminal: request.ownerTerminal,
    original: {review: editions['review.json'], scopeReview: editions['scope-review.json']},
    appended: {review: request.review, scopeReview: request.scopeReview}, scientificAcceptance: false};
  const publications = [['scope-review.json', canonical(scopeReview)], ['review.json', canonical(review)], ['append-review-proof.json', canonical(proof)]];
  const preflight = () => { for (const [name, content] of publications) noCollision(root, path.join(directory, name), content); };
  recheck(); preflight();
  return {paperId: paper.paperId, review, reviewRef: request.review, scopeReviewRef: request.scopeReview,
    terminalRef: request.ownerTerminal, references, recheck, commit() {
      recheck(); preflight(); const guard = guarded.commit();
      for (const [name, content] of publications) writeOnceOrMatch(safeWithin(root, path.join(directory, name)), content);
      const frozen = fileRef(root, path.join(directory, 'review.json')), proofRef = fileRef(root, path.join(directory, 'append-review-proof.json'));
      guard.references = unique(root, [...guard.references, ...references, proofRef, frozen]);
      recheck(); for (const ref of guard.references) checkRef(root, ref);
      return {review: frozen, guard, proof: proofRef, references: guard.references};
    }};
}

export async function runReviewAppend(root, argv) {
  root = path.resolve(root);
  insist(Array.isArray(argv) && argv.length === 2 && ['check', 'review-append'].includes(argv[0]), 'Expected check/review-append <supervisor request>');
  const [command, requestPath] = argv, ledger = safeWithin(root, BASE + '/coverage');
  const requestFile = safeWithin(safeWithin(root, BASE + '/coverage/requests'), safeWithin(root, requestPath));
  const requestRef = fileRef(root, requestFile), request = read(requestFile);
  insist(digest(request) === requestRef.sha256, 'Supervisor request must be canonical UTF-8');
  const statePath = safeWithin(root, BASE + '/coverage/state.json'), state = read(statePath);
  const operationId = digest({command: 'review-append-v1', request});
  if (command === 'check') {
    const prepared = await prepareAppendedReview({root, state, paper: state.papers.find(p => p.paperId === request.paperId), request});
    checkRef(root, requestRef); prepared.recheck();
    return {valid: true, paperId: request.paperId, review: prepared.reviewRef, scopeReview: prepared.scopeReviewRef, scientificAcceptance: false, productionMutation: false};
  }
  const lockPath = safeWithin(root, path.join(ledger, '.writer.lock')), token = randomUUID();
  fs.writeFileSync(lockPath, canonical({pid: process.pid, token, startedAt: new Date().toISOString(), command: 'review-append'}), {flag: 'wx'});
  try {
    insist(equal(read(statePath), state), 'Coverage state changed before writer acquisition'); checkRef(root, requestRef);
    if (state.operations[operationId]) {
      for (const ref of state.operations[operationId].references) checkRef(root, ref);
      return {...state.operations[operationId].response, replayed: true};
    }
    const paper = state.papers.find(p => p.paperId === request.paperId);
    const prepared = await prepareAppendedReview({root, state, paper, request});
    checkRef(root, requestRef); prepared.recheck();
    const frozen = prepared.commit();
    // Same business transition as the canonical review command, never decide.
    paper.staged.guard = frozen.guard; paper.staged.review = frozen.review; paper.staged.reviewer = request.agent;
    paper.owner = null; paper.phase = 'review_received';
    const references = unique(root, [requestRef, ...frozen.references, ...guardAdmissionReferences(root, state, paper)]);
    for (const ref of references) checkRef(root, ref);
    state.revision++; state.updatedAt = new Date().toISOString();
    state.phase = state.papers.every(p => p.phase === 'complete') ? 'coverage_complete' : 'coverage_active';
    const response = {paperId: paper.paperId, phase: paper.phase, review: frozen.review, guard: guardSummary(frozen.guard),
      appendProof: frozen.proof, revision: state.revision, scientificAcceptance: false};
    state.operations[operationId] = {response, references};
    const temp = safeWithin(root, path.join(ledger, `.state-${process.pid}-${randomUUID()}.tmp`));
    const fd = fs.openSync(temp, 'wx');
    try { fs.writeFileSync(fd, canonical(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { insist(equal(read(temp), state), 'State readback mismatch'); fs.renameSync(temp, statePath); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return response;
  } finally {
    if (fs.existsSync(lockPath)) { insist(read(lockPath).token === token, 'Writer ownership changed; lock retained'); fs.unlinkSync(lockPath); }
  }
}
if (process.argv[1] && key(process.argv[1]) === key(fileURLToPath(import.meta.url))) {
  try { console.log(JSON.stringify(await runReviewAppend(process.cwd(), process.argv.slice(2)))); }
  catch (error) { console.error(String(error?.message ?? error).slice(0, 1200)); process.exitCode = 1; }
}
