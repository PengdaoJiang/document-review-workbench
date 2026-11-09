// Opt-in, version-bound admission. Called only by the canonical coverage CLI
// under its existing writer lock; no service, second lock, or scientific verdict.
import fs from 'node:fs';
import path from 'node:path';
import {canonical, hash, fileRef, checkRef, readBoundText} from './coverage-core.mjs';
import {safeWithin} from './coverage-context.mjs';
import {writeOnceOrMatch} from '../../repair-flow.mjs';
import {sourceAdmissionReferences} from './source-admission.mjs';
import {resolveSourceView} from './source-binding.mjs';
import {validateCandidateScope, validateReviewScope} from './coverage-scope.mjs';

const base = 'research_followup/network3_campaign';
const releaseBase = base + '/architecture/batch-scope-20261029';
const releaseNames = ['coverage.mjs', 'coverage-guard.mjs', 'coverage-scope.mjs', 'coverage-batch.mjs', 'COVERAGE_GUARDS.md', 'BATCH_API.md', 'SCOPE_API.md'];
const installedPath = name => `${['BATCH_API.md','SCOPE_API.md'].includes(name)?releaseBase:base}/${name}`;
const insist = (ok, message) => { if (!ok) throw Error('Coverage guard: ' + message); };
const digest = value => hash(canonical(value));
const text = value => typeof value === 'string' && value.trim().length > 0;
const version = paper => 'c' + String(paper.iteration).padStart(3, '0');
const same = (a, b) => canonical(a) === canonical(b);
const key = name => process.platform === 'win32' ? path.resolve(name).toLowerCase() : path.resolve(name);
const sameRef = (root, a, b) => a && b && key(path.resolve(root, a.path)) === key(path.resolve(root, b.path)) && a.sha256 === b.sha256;
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const bound = (root, ref) => JSON.parse(readBoundText(root,ref).replace(/^\uFEFF/, ''));
const frozen = (root, filename, value) => { writeOnceOrMatch(safeWithin(root, filename), canonical(value)); return fileRef(root, filename); };
const versionRoot = (root, paper) => safeWithin(root, `${base}/coverage/${paper.paperId}/${version(paper)}`);
const refsUnique = refs => [...new Map(refs.filter(Boolean).map(ref => [key(ref.path) + ':' + ref.sha256, ref])).values()];

export function guardVersionStarted(root, state, paper) {
  if (!paper.iteration) return false;
  const operations = Object.values(state.operations ?? {});
  const prepared = operations.filter(op => op.response?.paperId === paper.paperId && op.response.iteration === paper.iteration && sameRef(root, op.response.order, paper.order));
  insist(prepared.length === 1, 'Cannot establish the unique preparation boundary for ' + paper.paperId + '/' + version(paper));
  const revision = prepared[0].response.revision;
  insist(Number.isSafeInteger(revision), 'Preparation operation has no committed revision');
  return operations.some(op => op.response?.paperId === paper.paperId && op.response.revision > revision && op.response.owner?.role === 'worker');
}

export function activateGuardPolicy({root, state, request, operationId}) {
  insist(!state.guardPolicy, 'Guard policy already activated; replay its exact original request');
  insist(text(request.supervisor) && text(request.reason), 'Policy activation needs actual supervisor and reason');
  const authority = bound(root, state.authority);
  insist(request.supervisor === (authority.supervisorThreadId ?? authority.supervisor?.threadId), 'Only the bound scientific supervisor activates policy');
  const release = fileRef(root, releaseBase + '/release-manifest.json'), manifest = bound(root, release);
  insist(manifest.schemaVersion === 1 && manifest.releaseId === 'batch-scope-20261029' && Array.isArray(manifest.modules) && manifest.modules.length === releaseNames.length, 'Invalid immutable release manifest');
  insist(new Set(manifest.modules.map(row => row.name)).size === releaseNames.length, 'Duplicate release module');
  const modules = [], installedModules = [];
  for (const name of releaseNames) {
    const row = manifest.modules.find(value => value.name === name); insist(row, 'Missing release module ' + name);
    insist(key(safeWithin(root,row.installed.path)) === key(path.resolve(root,installedPath(name))) && key(safeWithin(root,row.frozen.path)) === key(path.resolve(root,`${releaseBase}/release/${name}`)), 'Release module path mismatch');
    insist(row.installed.sha256 === row.frozen.sha256, 'Installed/released code identity differs');
    checkRef(root,row.installed);checkRef(root,row.frozen);modules.push(row.frozen);installedModules.push(row.installed);
  }
  const legacyExemptions = state.papers.filter(paper => paper.iteration > 0 &&
    (guardVersionStarted(root, state, paper) || ['working', 'awaiting_review', 'reviewing', 'review_received', 'assessed', 'complete'].includes(paper.phase)))
    .map(paper => ({paperId: paper.paperId, iteration: paper.iteration, scan: paper.scan, order: paper.order,
      reason: 'Version already started or staged before policy; no retrospective migration.'}));
  const policy = {schemaVersion: 1, profile: 'source-scope-v1', operationId, activatedAtRevision: state.revision + 1,
    supervisor: request.supervisor, reason: request.reason, release, modules, installedModules, legacyExemptions};
  const ref = frozen(root, `${base}/coverage/guard-policy-v1.json`, policy);
  return {policy: ref, references: [ref, release, ...modules], response: {guardPolicy: ref, legacyExemptions: legacyExemptions.map(({paperId, iteration}) => ({paperId, iteration}))}};
}

function policyFor(root, state, active = false) {
  if (!state.guardPolicy) return null;
  const policy = bound(root, state.guardPolicy);
  insist(policy.schemaVersion === 1 && policy.profile === 'source-scope-v1' && Array.isArray(policy.modules) && Array.isArray(policy.legacyExemptions), 'Invalid immutable policy');
  checkRef(root,policy.release);
  for (const ref of policy.modules) checkRef(root, ref);
  if(active)for(const ref of policy.installedModules)checkRef(root,ref);
  return policy;
}
export function guardPolicyReferences(root, state) {
  const policy = policyFor(root, state, true);
  return policy ? [state.guardPolicy, policy.release, ...policy.modules] : [];
}
export function guardAdmissionReferences(root, state, paper) {
  return [...guardPolicyReferences(root, state), ...(paper ? guardReferences(root, paper) : []), ...(paper?.staged?.guard?.references ?? [])];
}
export function guardRecoveryState(root, state, paper, request, command) {
  const references=[];
  const finish=projected=>({state:projected,references,recheck(){for(const ref of references)checkRef(root,ref);}});
  const guarded=guardRequired(root,state,paper);
  if(guarded) {
    insist(paper.guardEnrollment,'Guarded recovery lacks enrollment');
    const worker=command==='recover-intake', directory=safeWithin(root,worker?paper.workRoot:paper.staged.reviewRoot);
    const checkpointPath=safeWithin(directory,safeWithin(root,request.ownerCheckpoint.path));
    insist(key(checkpointPath)===key(path.join(directory,'terminal-source-v2.json')),'Recovery checkpoint is not the exact owner terminal record');
    const checkpoint=bound(root,request.ownerCheckpoint);
    insist(sameRef(root,checkpoint.sourceBinding,paper.sourceEnrollment.sourceBinding),'Original terminal checkpoint source binding differs');
    const field=worker?'sourceScope':'scopeReview',declared=checkpoint[field];
    insist(declared&&text(declared.path),'Original terminal checkpoint lacks exact '+field+' reference');
    const sidecar=safeWithin(directory,safeWithin(root,declared.path));
    insist(key(sidecar)===key(path.join(directory,worker?'source-scope-v2.json':'scope-review-v2.json')),'Terminal '+field+' is not the exact conventional sidecar');
    checkRef(root,declared); // Original terminal bytes bind the raw authored sidecar.
    references.push(request.ownerCheckpoint,declared);
  }
  const operation = state.operations?.[request.releaseOperationId];
  if(!operation)return finish(state);
  const policyActiveAtRelease=state.guardPolicy&&operation.response?.revision>=bound(root,state.guardPolicy).activatedAtRevision;
  if(!guarded&&!policyActiveAtRelease&&operation.references?.length===2&&!operation.response.guardReferences)return finish(state);
  const extra = [...guardAdmissionReferences(root, state, paper),...sourceAdmissionReferences(root,paper)];
  insist(extra.length > 0 && same(operation.references.slice(2), extra) && same(operation.response.guardReferences, extra), 'Recovery release guard reference set changed');
  for (const ref of extra) checkRef(root, ref);
  // The unchanged legacy validator still checks its exact two original release
  // references. Only this independently verified additive metadata is projected.
  references.push(...extra);
  return finish({...state, operations: {...state.operations, [request.releaseOperationId]: {...operation, references: operation.references.slice(0, 2)}}});
}
export function guardRequired(root, state, paper) {
  if(paper.sourceEnrollment){insist(policyFor(root,state,true),'Source branch lost its original guard policy');sourceAdmissionReferences(root,paper);return true;}
  const policy = policyFor(root, state, true);
  if (!policy) {insist(!paper.guardEnrollment&&!paper.staged?.guard,'Guarded version lost its policy');return false;}
  const exempt = policy.legacyExemptions.find(row => row.paperId === paper.paperId && row.iteration === paper.iteration);
  if (exempt) {
    insist(sameRef(root, exempt.scan, paper.scan) && sameRef(root, exempt.order, paper.order), 'Legacy exemption identity changed');
    insist(!paper.guardEnrollment, 'Legacy version unexpectedly carries new enrollment');
  }
  return !exempt;
}

export function enrollGuard({root, state, paper}) {
  if (!guardRequired(root, state, paper)) return null;
  insist(paper.phase === 'source_ready' && !paper.owner && !paper.staged, 'Enrollment requires the pre-worker ready boundary');
  if(paper.guardEnrollment)return {enrollment:paper.guardEnrollment,references:guardReferences(root,paper)};
  const policy = policyFor(root, state), directory = versionRoot(root, paper);
  insist(policy,'Source-scope policy must remain installed');
  const profile = {schemaVersion: 1, profile: policy.profile, paperId: paper.paperId, iteration: paper.iteration,
    policy: state.guardPolicy, scan: paper.scan, order: paper.order, workRoot: paper.workRoot};
  const enrollment = frozen(root, path.join(directory, 'guard-order.json'), profile);
  const instructions = '# Guarded version supplement\n\nThis supplement binds ' + paper.paperId + '/' + version(paper) + '. Read the exact policy guide at ' +
    policy.modules.find(ref => path.basename(ref.path) === 'COVERAGE_GUARDS.md').path + '.\n\n' +
    'Source-binding protocol '+JSON.stringify(paper.sourceEnrollment)+'. This new supplement explicitly replaces only the legacy schema/file-name instructions: worker delivers candidate-source-v2.json and source-scope-v2.json; reviewer delivers review-source-v2.json and scope-review-v2.json; completed actors use terminal-source-v2.json. Candidate/review/decision/source-scope/scope-review require schemaVersion 2 and the exact sourceBinding; scanSha256 remains the original base scan hash. Use research_followup/network3_campaign/protocols/source-binding-v1-checkpoint/coverage-reader.mjs, coverage-kit.mjs, coverage-authoring.mjs, coverage-review-parts.mjs and coverage-batch.mjs. Preserve every original adoption-checkpoint draft reference without overwrite. All original scientific gates remain unchanged. No guarded sidecar means no intake; no automatic legacy fallback. Original claims, bounded checks and corrected variants stay distinct.\n';
  writeOnceOrMatch(path.join(directory, 'guard-order.md'), instructions);
  const guide = fileRef(root, path.join(directory, 'guard-order.md'));
  paper.guardEnrollment = {profile: enrollment, instructions: guide};
  return {enrollment: paper.guardEnrollment, references: [enrollment, guide, state.guardPolicy, policy.release, ...policy.modules]};
}

export function guardReferences(root, paper) {
  if (!paper.guardEnrollment) return [];
  const {profile, instructions} = paper.guardEnrollment, enrollment = bound(root, profile);
  insist(enrollment.paperId === paper.paperId && enrollment.iteration === paper.iteration && sameRef(root, enrollment.scan, paper.scan) && sameRef(root, enrollment.order, paper.order) && enrollment.workRoot === paper.workRoot, 'Enrollment differs from exact version/source/order');
  const policy = bound(root, enrollment.policy);
  const refs = refsUnique([profile, instructions, enrollment.policy, policy.release, ...policy.modules, paper.scan, paper.order]);
  for (const ref of refs) checkRef(root, ref);
  return refs;
}

export function guardPrevious(root, snapshot, previous) {
  if (!snapshot?.guard) return previous;
  const guard = snapshot.guard;
  for (const ref of guard.references) checkRef(root, ref);
  return {...previous, contract: bound(root, guard.contract), contractSha256: guard.contract.sha256,
    scopeReview: guard.scopeReview ? bound(root, guard.scopeReview) : undefined,
    scopeReviewSha256: guard.scopeReview?.sha256};
}

function rawSidecar(root, directory, filename) {
  const expected = safeWithin(root, directory), target = safeWithin(expected, path.join(expected, filename));
  const ref = fileRef(root, target), value = bound(root, ref);
  return {ref, value};
}

export function prepareCandidateGuard({root, state, paper, scan, candidate, actor, previous}) {
  if (!guardRequired(root, state, paper)) return null;
  insist(paper.guardEnrollment, 'Guarded version lacks pre-worker enrollment');
  const view=resolveSourceView({root,scan,sourceBinding:paper.sourceEnrollment.sourceBinding});
  const references = [...guardReferences(root, paper),...sourceAdmissionReferences(root,paper)], source = rawSidecar(root, paper.workRoot, 'source-scope-v2.json');
  references.push(source.ref,...view.resources.map(resource=>({path:resource.path,sha256:resource.sha256})));
  validateCandidateScope({root, scan, candidate, candidateSha256: digest(candidate), contract: source.value, author: actor, previous});
  const recheck = () => { for (const ref of references) checkRef(root, ref); };
  return {recheck, commit() { recheck(); const contract = frozen(root, path.join(versionRoot(root, paper), 'source-scope-v2.json'), source.value);
    const all = refsUnique([...references, contract]); for (const ref of all) checkRef(root, ref);
    return {enrollment: paper.guardEnrollment, contract, contractSource: source.ref, references: all}; }};
}

export function prepareReviewGuard({root, state, paper, scan, candidate, review, actor, previous}) {
  if (!guardRequired(root, state, paper)) return null;
  insist(paper.staged?.guard?.contract, 'Guarded candidate has no frozen source-scope contract');
  const priorGuard = paper.staged.guard;
  const references = refsUnique([...guardReferences(root, paper),...sourceAdmissionReferences(root,paper), ...priorGuard.references]);
  for (const ref of references) checkRef(root, ref);
  const contract = bound(root, priorGuard.contract), source = rawSidecar(root, paper.staged.reviewRoot, 'scope-review-v2.json');
  references.push(source.ref);
  validateReviewScope({root, scan, candidate, candidateSha256: digest(candidate), contract, contractSha256: priorGuard.contract.sha256,
    review, scopeReview: source.value, reviewer: actor, worker: paper.staged.worker, historicalConstructors: paper.workerHistory ?? [], previous});
  references.push(...scopeEvidence(source.value));
  const recheck = () => { for (const ref of references) checkRef(root, ref); };
  return {recheck, commit() { recheck(); const scopeReview = frozen(root, path.join(versionRoot(root, paper), 'scope-review-v2.json'), source.value);
    const all = refsUnique([...references, scopeReview]); for (const ref of all) checkRef(root, ref);
    return {...priorGuard, scopeReview, scopeReviewSource: source.ref, historicalConstructors: [...(paper.workerHistory ?? [])], references: all}; }};
}

function scopeEvidence(scopeReview) {
  return [...scopeReview.inventory.evidence,...scopeReview.cards.flatMap(row=>row.evidence),...scopeReview.entries.flatMap(row=>row.evidence)];
}

export function verifyGuardSnapshot({root, scan, candidate, review, decision = null, guard, previous, workerHistory = []}) {
  if (!guard) return null;
  const view=resolveSourceView({root,scan,sourceBinding:candidate.sourceBinding});
  for (const ref of guard.references) checkRef(root, ref);
  const contract = bound(root, guard.contract), scopeReview = bound(root, guard.scopeReview);
  const checked = validateReviewScope({root, scan, candidate, candidateSha256: digest(candidate), contract, contractSha256: guard.contract.sha256,
    review, scopeReview, reviewer: review.reviewerAgent, worker: candidate.author, historicalConstructors: guard.historicalConstructors ?? workerHistory, previous});
  if (decision) {
    const allowed = new Set([...checked.eligibleObligationIds, ...(checked.inheritedLegacyIds ?? [])]);
    insist(decision.acceptedObligationIds.every(id => allowed.has(id)), 'Decision accepts an obligation outside independent source-scope approval');
    insist(!decision.inventoryAccepted || checked.inventoryEligible, 'Decision inventory lacks independent source-scope eligibility');
  }
  const references=refsUnique([...guard.references,...scopeEvidence(scopeReview),...view.resources.map(resource=>({path:resource.path,sha256:resource.sha256}))]);
  return {checked, recheck: () => { for (const ref of references) checkRef(root, ref); }};
}

export function guardReviewInstructions(paper) {
  if(paper.sourceEnrollment)return '\n## Exact source-binding v2 delivery instructions\nRead '+paper.sourceEnrollment.supplementOrder.path+' (SHA256 '+paper.sourceEnrollment.supplementOrder.sha256+'). Source enrollment: '+canonical(paper.sourceEnrollment)+'. Use the parallel source-binding-v1-checkpoint reader/kit/authoring/review-parts/batch modules, never the legacy entrypoints for this branch. Deliver review-source-v2.json and scope-review-v2.json with schemaVersion 2 and exact sourceBinding, then terminal-source-v2.json. Bind the frozen '+paper.staged.guard.contract.path+'. Original scan and scientific independence gates are unchanged; preserve old files without overwrite.\n';
  return paper.guardEnrollment ? '\n## Version-bound source-scope supplement\nRead ' + paper.guardEnrollment.instructions.path +
    ' (SHA256 ' + paper.guardEnrollment.instructions.sha256 + '). Independently deliver scope-review-v2.json in this review root, binding the frozen source-scope-v2.json. Original review gates remain mandatory.\n' : '';
}
export function guardSummary(guard) {
  return guard ? {enrollment:guard.enrollment,contract:guard.contract,...(guard.scopeReview?{scopeReview:guard.scopeReview}:{})} : null;
}


