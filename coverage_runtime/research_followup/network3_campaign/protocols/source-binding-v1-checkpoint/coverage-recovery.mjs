// Pure proof admission for a completed original actor whose registered owner was released.
// No worker registration, scientific acceptance, process control or filesystem mutation.
import fs from 'node:fs';
import path from 'node:path';
import {canonical, hash, checkRef} from './coverage-core.mjs';

const insist = (ok, message) => { if (!ok) throw Error('Released delivery: ' + message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const SHA = /^[a-f0-9]{64}$/;
const equal = (a, b) => canonical(a) === canonical(b);
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a, b) => pathKey(path.resolve(a)) === pathKey(path.resolve(b));
const fields = ['schemaVersion', 'expectedRevision', 'paperId', 'iteration', 'agent',
  'ownerFinished', 'noActiveCalculation', 'supervisor', 'reason', 'releaseOperationId',
  'releaseRequest', 'releaseReceipt', 'terminalEvidence', 'ownerCheckpoint', 'scan',
  'order', 'delivery', 'candidate', 'sourceBinding'];

function shape(value, names, label) {
  insist(value && typeof value === 'object' && !Array.isArray(value), label + ' must be an object');
  insist(equal(Object.keys(value).sort(), [...names].sort()), label + ' has missing or unknown fields');
}
function reference(ref, label) {
  shape(ref, ['path', 'sha256'], label);
  insist(text(ref.path) && SHA.test(ref.sha256), 'Invalid ' + label);
  return ref;
}
function contained(directory, filename) {
  const relative = path.relative(path.resolve(directory), path.resolve(filename));
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

/** Called under the existing coverage writer lock, after normal idempotency/revision checks. */
export function validateReleasedDelivery({root, state, paper, request, command}) {
  root = path.resolve(root);
  insist(['recover-intake', 'recover-review'].includes(command), 'Unknown recovery command');
  shape(request, fields, 'Recovery request');
  insist(request.schemaVersion === 2 && Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0,
    'Invalid request schema/revision');
  insist(request.expectedRevision === state.revision, 'Stale expectedRevision');
  insist(text(request.paperId) && /^[A-Za-z0-9_-]+$/.test(request.paperId) && request.paperId === paper.paperId,
    'Paper identity mismatch');
  insist(Number.isSafeInteger(request.iteration) && request.iteration > 0 && request.iteration === paper.iteration,
    'Iteration mismatch');
  insist(text(request.agent) && text(request.supervisor) && text(request.reason), 'Actor, supervisor and reason are required');
  insist(request.ownerFinished === true && request.noActiveCalculation === true,
    'Confirmed natural completion and no active calculation are required');
  insist(SHA.test(request.releaseOperationId), 'Invalid release operation identity');
  insist(paper.owner === null, 'Current paper has an active or unknown owner');

  const worker = command === 'recover-intake', role = worker ? 'worker' : 'reviewer';
  const initialPhase = worker ? 'source_ready' : 'source_awaiting_review', assignedPhase = worker ? 'source_working' : 'source_reviewing';
  insist(paper.phase === initialPhase, 'Wrong recovery phase');
  const version = 'c' + String(paper.iteration).padStart(3, '0');
  const ledger = path.join(root, 'research_followup/network3_campaign/coverage');
  const requests = path.join(ledger, 'requests'), paperLedger = path.join(ledger, paper.paperId);
  const versionLedger = path.join(paperLedger, version);
  const privateRoot = path.join(root, 'research_followup/reproduction_clean',
    worker ? 'coverage_work' : 'coverage_verifications', paper.paperId, version);
  const checked = new Map();

  function sameRef(a, b, label) {
    reference(a, label); reference(b, label + ' binding');
    insist(samePath(path.resolve(root, a.path), path.resolve(root, b.path)) && a.sha256 === b.sha256,
      label + ' differs from exact binding');
  }
  function file(ref, directory, label, exactPath = null) {
    reference(ref, label);
    const absolute = path.resolve(root, ref.path);
    // Scope guard precedes checkRef and every read, so a hostile ref cannot probe private siblings.
    insist(contained(directory, absolute), label + ' is outside its allowed directory');
    if (exactPath) insist(samePath(absolute, exactPath), label + ' is not the exact registered file');
    const actual = checkRef(root, ref); // Also rejects raw traversal, ADS, symlinks and non-files.
    const raw = fs.readFileSync(actual);
    insist(hash(raw) === ref.sha256, label + ' changed during read');
    const frozenRef = {path: actual, sha256: ref.sha256};
    checked.set(pathKey(actual) + ':' + ref.sha256, frozenRef);
    return {path: actual, raw};
  }
  function json(ref, directory, label, exactPath = null) {
    const entry = file(ref, directory, label, exactPath);
    return {...entry, value: JSON.parse(entry.raw.toString('utf8').replace(/^\uFEFF/, ''))};
  }

  sameRef(request.sourceBinding,paper.sourceEnrollment?.sourceBinding,'Source binding');
  sameRef(request.scan, paper.scan, 'Scan');
  const scan = json(request.scan, paperLedger, 'Scan', path.join(paperLedger, 'scan.json')).value;
  insist(scan.paperId === paper.paperId, 'Scan paper mismatch');
  let stagedCandidate = null;
  if (worker) {
    insist(paper.staged === null && request.candidate === null, 'Worker recovery cannot replace staged work');
    insist(text(paper.workRoot) && samePath(path.resolve(root, paper.workRoot), privateRoot), 'Worker root/version mismatch');
    insist((paper.workerHistory ?? []).includes(request.agent), 'Original constructor was not registered for this paper');
    sameRef(request.order, paper.order, 'Original worker order');
  } else {
    insist(paper.staged && !paper.staged.review, 'Review is missing staged candidate or already delivered');
    insist(text(paper.staged.reviewRoot) && samePath(path.resolve(root, paper.staged.reviewRoot), privateRoot),
      'Reviewer root/version mismatch');
    insist(request.agent !== paper.staged.worker && !(paper.workerHistory ?? []).includes(request.agent),
      'Historical constructor cannot independently review this paper');
    sameRef(request.order, paper.staged.reviewOrder, 'Original review order');
    sameRef(request.candidate, paper.staged.candidate, 'Staged candidate');
    stagedCandidate = json(request.candidate, versionLedger, 'Staged candidate', path.join(versionLedger, 'candidate.json')).value;
    insist(stagedCandidate.paperId === paper.paperId && stagedCandidate.revision === paper.iteration &&
      stagedCandidate.author === paper.staged.worker && stagedCandidate.scanSha256 === request.scan.sha256,
    'Staged candidate identity mismatch');
  }
  file(request.order, versionLedger, 'Original order', path.join(versionLedger, worker ? 'worker.md' : 'reviewer.md'));

  const releaseRequest = json(request.releaseRequest, requests, 'Original release request').value;
  insist(hash(canonical({command: 'release', request: releaseRequest})) === request.releaseOperationId,
    'Release request does not identify the committed release operation');
  insist(releaseRequest.paperId === paper.paperId && releaseRequest.agent === request.agent &&
    releaseRequest.ownerFinished === true && releaseRequest.noActiveCalculation === true &&
    Number.isSafeInteger(releaseRequest.expectedRevision) && releaseRequest.expectedRevision >= 0 &&
    text(releaseRequest.supervisor) && text(releaseRequest.reason), 'Original release request identity/termination mismatch');
  sameRef(releaseRequest.terminalEvidence, request.terminalEvidence, 'Original release terminal witness');

  const operation = state.operations?.[request.releaseOperationId];
  insist(operation && operation.response && Array.isArray(operation.references), 'Release operation is not committed');
  const response = operation.response;
  insist(response.paperId === paper.paperId && response.phase === initialPhase &&
    response.revision === releaseRequest.expectedRevision + 1 && response.revision <= state.revision,
  'Committed release response identity/revision mismatch');
  sameRef(response.release, request.releaseReceipt, 'Committed release receipt');
  insist(operation.references.length === 2, 'Committed release has unexpected reference set');
  sameRef(operation.references[0], request.releaseReceipt, 'Committed release receipt reference');
  sameRef(operation.references[1], request.terminalEvidence, 'Committed terminal witness reference');

  const samePaper = Object.entries(state.operations).filter(([, value]) => value?.response?.paperId === paper.paperId);
  insist(samePaper.every(([, value]) => Number.isSafeInteger(value.response.revision) &&
    value.response.revision >= 0 && value.response.revision <= state.revision), 'Invalid same-paper operation revision');
  const revisions = samePaper.map(([, value]) => value.response.revision);
  insist(new Set(revisions).size === revisions.length, 'Ambiguous same-paper operation ordering');
  samePaper.sort((a, b) => a[1].response.revision - b[1].response.revision);
  insist(samePaper.at(-1)?.[0] === request.releaseOperationId,
    'A later same-paper mutation invalidates recovery from this release');
  const assignment = samePaper.at(-2)?.[1]?.response;

  const release = json(request.releaseReceipt, versionLedger, 'Frozen release receipt',
    path.join(versionLedger, `release-${request.releaseOperationId}.json`)).value;
  insist(hash(canonical(release)) === request.releaseReceipt.sha256, 'Release receipt is not canonical frozen evidence');
  insist(release.paperId === paper.paperId && release.iteration === paper.iteration &&
    release.owner?.agent === request.agent && release.owner.role === role && text(release.owner.startedAt) &&
    release.confirmedBy === releaseRequest.supervisor && release.reason === releaseRequest.reason,
  'Frozen release actor/version/confirmation mismatch');
  sameRef(release.terminalEvidence, request.terminalEvidence, 'Frozen release terminal witness');
  insist(assignment?.phase === assignedPhase && equal(assignment.owner, release.owner),
    'Release is not immediately preceded by the exact original owner registration');

  const witness = json(request.terminalEvidence, requests, 'Supervisor terminal witness').value;
  insist(witness.paperId === paper.paperId && witness.agent === request.agent &&
    witness.ownerFinished === true && witness.noActiveCalculation === true && witness.supervisor === release.confirmedBy,
  'Supervisor terminal witness identity/termination mismatch');
  sameRef(witness.ownerCheckpoint, request.ownerCheckpoint, 'Original owner checkpoint');
  const checkpoint = json(request.ownerCheckpoint, privateRoot, 'Original owner checkpoint', path.join(privateRoot, 'terminal-source-v2.json')).value;
  insist(checkpoint.schemaVersion===2,'Source recovery checkpoint requires schemaVersion 2');
  insist(checkpoint.paperId === paper.paperId && checkpoint.revision === paper.iteration && checkpoint.noActiveCalculation === true,
    'Owner checkpoint paper/version/termination mismatch');
  if (worker) {
    insist(checkpoint.agent === request.agent && checkpoint.terminalState === 'candidate_frozen_ready_for_independent_review',
      'Original worker has no completed candidate delivery');
    sameRef(checkpoint.candidate, request.delivery, 'Original candidate delivery');
  } else {
    insist(checkpoint.reviewerAgent === request.agent && checkpoint.status === 'review_delivered' &&
      checkpoint.scanSha256 === request.scan.sha256 && checkpoint.candidateSha256 === request.candidate.sha256,
    'Original reviewer delivery identity/scan/candidate mismatch');
    sameRef(checkpoint.review, request.delivery, 'Original review delivery');
  }
  sameRef(checkpoint.sourceBinding,request.sourceBinding,'Original checkpoint source binding');
  const deliveryRecord = json(request.delivery, privateRoot, 'Original delivery');
  const delivery = deliveryRecord.value;
  insist(delivery.schemaVersion===2,'Source delivery requires schemaVersion 2');
  sameRef(delivery.sourceBinding,request.sourceBinding,'Original delivery source binding');
  insist(delivery.paperId === paper.paperId && delivery.revision === paper.iteration && delivery.scanSha256 === request.scan.sha256,
    'Delivered paper/revision/scan mismatch');
  if (worker) insist(delivery.author === request.agent && delivery.predecessorSha256 === (paper.latest?.candidate.sha256 ?? null),
    'Delivered constructor/predecessor mismatch');
  else insist(delivery.reviewerAgent === request.agent && delivery.candidateSha256 === request.candidate.sha256,
    'Delivered reviewer/candidate mismatch');

  const references = [...checked.values()].map(ref => ({...ref}));
  const recovery = {schemaVersion: 2,sourceBinding:request.sourceBinding, kind: 'released_original_actor_delivery', command,
    paperId: paper.paperId, iteration: paper.iteration, actor: request.agent, role,
    releaseOperationId: request.releaseOperationId, releaseRevision: response.revision,
    releaseReceipt: {...request.releaseReceipt}, terminalEvidence: {...request.terminalEvidence},
    ownerCheckpoint: {...request.ownerCheckpoint}, delivery: {...request.delivery},
    scientificAcceptance: false, freshContextClaimed: false};
  return {actor: request.agent, deliveryPath: deliveryRecord.path, delivery, references, recovery,
    recheck() { for (const ref of references) checkRef(root, ref); }};
}


