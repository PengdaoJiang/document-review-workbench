// Narrow, additive original-actor admission for the released r0186/r0187 c002
// repairs. Only the scientific supervisor writes; check/verify are read-only.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {canonical, hash, fileRef, checkRef} from '../../coverage-core.mjs';
import {safeWithin} from '../../coverage-context.mjs';
import {guardAdmissionReferences, guardReviewInstructions, guardSummary} from '../../coverage-guard.mjs';
import {writeOnceOrMatch} from '../../repair-flow.mjs';
import {runCoverage as runLegacyCoverage} from '../../coverage.mjs';
import {prepareAppendCorrection} from './append-core.mjs';

const base = 'research_followup/network3_campaign';
const supported = new Set(['r0186', 'r0187']);
const insist = (ok, message) => { if (!ok) throw Error('Guard append intake: ' + message); };
const same = (a, b) => canonical(a) === canonical(b);
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const rel = (root, filename) => path.relative(root, filename).split(path.sep).join('/');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
function bound(root, reference) {
  const bytes = fs.readFileSync(checkRef(root, reference));
  insist(hash(bytes) === reference.sha256, 'Actual bound JSON bytes changed');
  const text = bytes.toString('utf8');
  insist(Buffer.from(text, 'utf8').equals(bytes), 'Bound JSON is not UTF-8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}
function sameRef(root, a, b) {
  return !!a && !!b && typeof a.path === 'string' && typeof b.path === 'string'
    && key(path.resolve(root, a.path)) === key(path.resolve(root, b.path)) && a.sha256 === b.sha256;
}
function unique(root, references) {
  const paths = new Map();
  for (const ref of references) {
    insist(ref && typeof ref.path === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256), 'Invalid lineage reference');
    const name = key(path.resolve(root, ref.path)), old = paths.get(name);
    insist(!old || old.sha256 === ref.sha256, 'Conflicting identity for one referenced path');
    if (!old) paths.set(name, ref);
  }
  return [...paths.values()];
}
const reference = (root, name, bytes) => ({path: safeWithin(root, name), sha256: hash(bytes)});
function preflight(root, outputs) {
  for (const output of outputs) {
    const target = safeWithin(root, output.ref.path);
    insist(hash(output.bytes) === output.ref.sha256, 'Planned output identity changed');
    if (fs.existsSync(target)) {
      insist(fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink(), 'Output is not a regular immutable file');
      insist(fs.readFileSync(target).equals(Buffer.from(output.bytes)), 'Conflicting immutable output: ' + target);
    }
  }
}
function registration(state, paper) {
  return {state: Object.fromEntries(['schemaVersion', 'authority', 'scope', 'firstPassClosure', 'guardPolicy']
    .filter(k => Object.hasOwn(state, k)).map(k => [k, structuredClone(state[k])])), paper: structuredClone(paper)};
}
const intentFor = request => Object.fromEntries(Object.entries(request).filter(([name]) => name !== 'expectedRevision'));
// This is an identity-only validator projection, not a reconstructed production
// revision or execution state. The actual operation/request is checked separately.
const initialState = reg => ({...structuredClone(reg.state), revision: 0, papers: [structuredClone(reg.paper)], operations: {}});
function ledgerShape(state) {
  insist(state?.schemaVersion === 1 && Number.isSafeInteger(state.revision) && state.revision >= 0 && state.revision < Number.MAX_SAFE_INTEGER, 'Invalid ledger schema or revision');
  insist(state.operations && typeof state.operations === 'object' && !Array.isArray(state.operations), 'Invalid ledger operations map');
  insist(Array.isArray(state.papers) && state.papers.every(p => p && typeof p === 'object' && !Array.isArray(p) && typeof p.paperId === 'string' && typeof p.phase === 'string'), 'Invalid ledger paper registration');
}
function campaignIdentity(root, state) {
  const authorityPath = safeWithin(root, 'docs/network3-coverage-authorization-20261024.json');
  insist(sameRef(root, state.authority, fileRef(root, authorityPath)), 'Coverage authority differs from installed authority');
  const authority = bound(root, state.authority), source = bound(root, authority.scopeAuthority), ids = source.scope.paperIds;
  insist(Array.isArray(ids) && ids.length === 53 && new Set(ids).size === 53 && same(state.scope, [...ids].sort()), 'Fixed 53-paper ledger scope differs');
  const nodes = bound(root, source.scope.nodes), closure = bound(root, authority.firstPassClosure);
  insist(same(nodes.map(n => n.paper_id).sort(), [...ids].sort()) && closure.status === 'first_pass_complete_bounded'
    && same(closure.papers.map(p => p.paperId).sort(), [...ids].sort()), 'Bound scope nodes or first-pass closure differs');
  insist(sameRef(root, state.firstPassClosure, authority.firstPassClosure), 'Ledger closure reference differs');
  return {closure, references: [state.authority, authority.scopeAuthority, source.scope.nodes, authority.firstPassClosure]};
}

// Mutable execution control is an admission gate, never an immutable evidence
// dependency. A later pause must not invalidate an already frozen correction.
// There is intentionally no missing-file or isolated-fixture bypass.
function activeExecution(root) {
  const filename = safeWithin(root, base + '/coverage/execution-control.json'), ref = fileRef(root, filename);
  const inspect = () => {
    const value = bound(root, ref);
    insist(value.schemaVersion === 1 && value.phase === 'active' && value.pauseInForce === false && value.newAdmissions === true,
      'Execution control must explicitly allow active, unpaused new admissions');
  };
  inspect();
  return {recheck: inspect};
}

function publication(root, state, paper, request, prepared, campaignReferences) {
  insist(supported.has(paper.paperId) && paper.iteration === 2 && request.iteration === 2, 'Only released r0186/r0187 c002 is admissible');
  const directory = base + '/coverage/' + paper.paperId + '/c002';
  const candidateBytes = canonical(prepared.candidate), scopeBytes = canonical(prepared.contract);
  const candidate = reference(root, directory + '/candidate.json', candidateBytes), contract = reference(root, directory + '/source-scope.json', scopeBytes);
  const requiredReferences = unique(root, [...prepared.references, ...campaignReferences]);
  // Frozen outputs bind the immutable intent, not an unrelated paper's global
  // ledger revision or the path of a retried supervisor request. Consequently a
  // failed freeze can be resumed after another paper advances the ledger.
  const receiptValue = {schemaVersion: 1, kind: 'original_actor_append_correction', paperId: paper.paperId, iteration: 2,
    intent: intentFor(request), releaseManifest: request.releaseManifest,
    registration: registration(state, paper), proof: prepared.proof, requiredReferences, candidate, contract, scientificAcceptance: false};
  const receiptBytes = canonical(receiptValue), receipt = reference(root, directory + '/append-correction-receipt.json', receiptBytes);
  const reviewRoot = safeWithin(root, 'research_followup/reproduction_clean/coverage_verifications/' + paper.paperId + '/c002');
  const guard = {enrollment: paper.guardEnrollment, contract, contractSource: request.repaired.sourceScope, appendCorrection: receipt, references: []};
  const staged = {candidate, worker: request.agent, workOrder: paper.order, reviewRoot: rel(root, reviewRoot), guard};
  const orderBytes = reviewerOrder(root, {...paper, staged}, reviewRoot) + guardReviewInstructions(paper)
    + '\n## Append-only correction provenance\nThe original actor supplied the narrowly released c002 guard-restoration correction. Original drafts, terminal checkpoints and failed proposals remain immutable. Correction receipt: '
    + canonical(receipt) + '. Read the frozen candidate and source-scope normally. Retain unchanged accepted assessments and inspect the exact changed bindings and retained guard obligations; no legacy downgrade is allowed. All original independent review and scientific acceptance gates remain mandatory. This receipt is not scientific acceptance; the full reference inventory need not be loaded into model context.\n';
  const reviewOrder = reference(root, directory + '/reviewer.md', orderBytes);
  staged.reviewOrder = reviewOrder;
  guard.references = unique(root, [...requiredReferences, candidate, contract, receipt, reviewOrder]);
  const outputs = [{ref: candidate, bytes: candidateBytes}, {ref: contract, bytes: scopeBytes}, {ref: receipt, bytes: receiptBytes}, {ref: reviewOrder, bytes: orderBytes}];
  return {receipt, receiptValue, staged, outputs, references: guard.references};
}

function reviewerOrder(root, paper, reviewRoot) {
  return `1. **目标**\n独立复核${paper.paperId}/c002逐项覆盖候选。你不是施工者；不重跑无关已有效检查。首次独立检查全文未列区域和扫描遗漏，后续核对变化及传递影响。\n\n2. **选中输入**\n协议${path.join(root, 'research_followup/network3_campaign/COVERAGE_WORKFLOW.md')}\n扫描${JSON.stringify(paper.scan)}\n候选${JSON.stringify(paper.staged.candidate)}\n首轮精确证据${JSON.stringify(paper.firstPass)}\n上次覆盖${JSON.stringify(paper.latest ?? null)}\nDot及必要宏/图是默认阅读；不得例行重读PDF，不读别篇或全局科学预设。旧同篇复核私有测试仅你可读，返修只给公开问题/必要条件。\n\n3. **私有可写根**\n${reviewRoot}\n只写你的新review、检查代码/输出/回执。不改候选、原文、旧证据、运行器或业务总表。工具按需并遵守资源登记。\n\n4. **交付**\nreview.json精确绑定正式冻结candidate/scan，reviewerAgent为实际登记标识。检查全部学术资源、数学单元/文本块/图片和宏遗漏；空映射数学/资产需逐个unitExclusions说明。逐义务绑定assessment哈希并给accept或needs_work及证据。完全未变且已独立接受的义务可列retainedObligationIds，但前提/依赖改变或旧检查只是partial不可继承。明确补做、内部未做和真正外部阻塞；不为缺工作制造外部阻塞。\n\n5. **验收**\n复核建议不是主管接受。只有来源清单审定、义务独立证据适当且主管逐项接受才计信用；数值符合、符号等价、一般证明和原实验复现不混同。完成后报告review路径/身份及计算终态；不从流水正常退出推出论文全核验完成。\n`;
}

function admissionView(root, state, paperId, request, requestRef, planned) {
  const next = structuredClone(state), paper = next.papers.find(row => row.paperId === paperId);
  paper.staged = structuredClone(planned.staged);
  paper.workerHistory = [...new Set([...(paper.workerHistory ?? []), request.agent])];
  paper.owner = null;
  paper.phase = 'awaiting_review';
  // The prior snapshots, accepted decisions, allowed scope and original actor
  // identity are carried without reinterpretation or business-state edits.
  const references = unique(root, [...planned.references, ...guardAdmissionReferences(root, next, paper), requestRef]);
  const response = {paperId, phase: paper.phase, candidate: paper.staged.candidate, reviewOrder: paper.staged.reviewOrder,
    reviewRoot: paper.staged.reviewRoot, guard: guardSummary(paper.staged.guard), appendCorrection: planned.receipt,
    scientificAcceptance: false, revision: request.expectedRevision + 1};
  return {next, references, response};
}

async function audit(root, state, paper) {
  insist(supported.has(paper.paperId) && Array.isArray(paper.history), 'Only retained r0186/r0187 c002 corrections are supported');
  const chain = [...paper.history, ...(paper.latest ? [paper.latest] : [])];
  const matches = [...chain, ...(paper.iteration === 2 && paper.staged ? [{...paper.staged, iteration: 2}] : [])].filter(s => s.iteration === 2);
  insist(matches.length === 1, 'Expected exactly one retained c002 staged/frozen correction snapshot');
  const snapshot = matches[0], receiptRef = snapshot.guard?.appendCorrection;
  insist(receiptRef, 'Missing required append-correction receipt');
  const receiptPath = safeWithin(root, base + '/coverage/' + paper.paperId + '/c002/append-correction-receipt.json');
  insist(key(path.resolve(root, receiptRef.path)) === key(receiptPath), 'Append receipt path differs from exact c002 ledger');
  const receipt = bound(root, receiptRef);
  insist(receipt.schemaVersion === 1 && receipt.kind === 'original_actor_append_correction' && receipt.paperId === paper.paperId
    && receipt.iteration === 2 && receipt.scientificAcceptance === false, 'Invalid frozen append correction receipt');
  const operations = Object.entries(state.operations).filter(([, op]) => sameRef(root, op?.response?.appendCorrection, receiptRef));
  insist(operations.length === 1, 'Expected exactly one committed operation for this correction intent');
  const [operationId, operation] = operations[0], requestRef = operation.request;
  insist(requestRef && typeof requestRef.path === 'string', 'Committed operation lacks its actual request reference');
  const requestPath = safeWithin(safeWithin(root, base + '/coverage/requests'), path.resolve(root, requestRef.path));
  insist(key(requestPath) === key(path.resolve(root, requestRef.path)), 'Committed request path escaped scope');
  const request = bound(root, requestRef);
  insist(operationId === hash(canonical({command: 'intake-append', request})) && same(intentFor(request), receipt.intent)
    && Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0 && request.expectedRevision < state.revision,
    'Committed request does not bind the frozen intent/revision');
  const registered = receipt.registration;
  insist(registered?.paper?.paperId === paper.paperId && registered.paper.iteration === 2
    && sameRef(root, registered.state.authority, state.authority) && sameRef(root, registered.state.guardPolicy, state.guardPolicy)
    && sameRef(root, registered.paper.scan, paper.scan) && same(registered.paper.firstPass, paper.firstPass)
    && same(registered.state.scope, state.scope), 'Frozen initial registration/source differs from the live campaign');
  const initialSnapshots = [...registered.paper.history, ...(registered.paper.latest ? [registered.paper.latest] : [])];
  for (const original of initialSnapshots) {
    const retained = chain.filter(row => row.iteration === original.iteration);
    insist(retained.length === 1 && same(retained[0], original), 'Prior accepted snapshot changed or disappeared');
  }
  insist(Array.isArray(paper.workerHistory) && [...(registered.paper.workerHistory ?? []), request.agent].every(actor => paper.workerHistory.includes(actor)),
    'Historical constructor identity changed or disappeared');
  const projected = initialState(registered), initialPaper = projected.papers[0];
  ledgerShape(projected);
  const campaign = campaignIdentity(root, projected);
  // Re-run the full append proof and the unchanged candidate/scope validators
  // against the original registration, never the current later iteration.
  const proofRequest = {...structuredClone(receipt.intent), expectedRevision: 0};
  const prepared = await prepareAppendCorrection({root, state: projected, paper: initialPaper, request: proofRequest});
  const expected = publication(root, projected, initialPaper, proofRequest, prepared, campaign.references);
  insist(same(receipt, expected.receiptValue) && sameRef(root, receiptRef, expected.receipt), 'Correction receipt/proof/required references changed');
  insist(sameRef(root, snapshot.candidate, expected.staged.candidate) && sameRef(root, snapshot.guard.contract, expected.staged.guard.contract)
    && sameRef(root, snapshot.guard.contractSource, request.repaired.sourceScope) && same(snapshot.guard.enrollment, initialPaper.guardEnrollment),
    'Snapshot lost exact candidate/scope/enrollment lineage');
  if (paper.iteration === 2 && paper.staged) {
    insist(snapshot.worker === request.agent && sameRef(root, snapshot.workOrder, initialPaper.order)
      && sameRef(root, snapshot.reviewOrder, expected.staged.reviewOrder) && snapshot.reviewRoot === expected.staged.reviewRoot,
      'Staged correction changed its actor/order/review root');
  }
  insist(Array.isArray(snapshot.guard.references), 'Missing correction reference inventory');
  for (const ref of expected.references) insist(snapshot.guard.references.some(actual => sameRef(root, actual, ref)), 'Missing required append lineage reference: ' + ref.path);
  for (const ref of snapshot.guard.references) checkRef(root, ref);
  for (const output of expected.outputs) {
    checkRef(root, output.ref);
    insist(fs.readFileSync(output.ref.path).equals(Buffer.from(output.bytes)), 'Actual frozen append output bytes differ');
  }
  const view = admissionView(root, projected, paper.paperId, request, requestRef, expected);
  insist(operation && same(operation.response, view.response) && same(operation.references, view.references), 'Committed operation differs from the frozen original admission');
  const recheck = () => {
    prepared.recheck();
    for (const ref of [...campaign.references, ...snapshot.guard.references, ...view.references]) checkRef(root, ref);
  };
  recheck();
  return {receipt: receiptRef, requiredReferenceCount: expected.references.length, operationId, recheck};
}

export async function runCoverage(root, argv) {
  root = path.resolve(root);
  const [command, arg] = argv;
  if (!command || command === 'help') return {commands: ['check <request.json>', 'intake-append <request.json>', 'verify <paperId>'],
    note: 'Only the scientific supervisor writes, and only the released r0186/r0187 c002 repairs are admitted. Independent review/decide/continue remain on the unchanged original CLI. No scientific execution or acceptance is performed.'};
  insist(argv.length === 2 && ['check', 'intake-append', 'verify'].includes(command), 'Expected check, intake-append or verify with one argument');
  const ledger = safeWithin(root, base + '/coverage'), statePath = safeWithin(ledger, 'state.json'), stateRef = fileRef(root, statePath), state = bound(root, stateRef);
  ledgerShape(state);
  const campaign = campaignIdentity(root, state), {closure} = campaign;
  const lookup = id => {
    insist(supported.has(id), 'Only released r0186/r0187 c002 repairs are supported');
    const rows = state.papers.filter(p => p.paperId === id);
    insist(state.scope.includes(id) && rows.length === 1, 'Unknown or ambiguous paper');
    const paper = rows[0], first = closure.papers.find(p => p.paperId === id);
    insist(!Object.hasOwn(paper, 'workerHistory') || (Array.isArray(paper.workerHistory) && paper.workerHistory.every(agent => typeof agent === 'string' && agent.trim())), 'Invalid workerHistory registration');
    for (const k of ['result', 'review', 'acceptance']) insist(same(paper.firstPass[k], {path: first[k].path, sha256: first[k].sha256}), 'Paper first-pass baseline differs from closure');
    return paper;
  };
  if (command === 'verify') {
    const paper = lookup(arg), correction = await audit(root, state, paper), legacy = await runLegacyCoverage(root, ['verify', paper.paperId]);
    correction.recheck();
    checkRef(root, stateRef);
    const {recheck: _recheck, ...details} = correction;
    return {...legacy, appendCorrection: {...details, verified: true},
      note: 'Mechanical correction lineage and original evidence validation only; staged intake is not scientific acceptance, re-review or a new approval.'};
  }
  const requestFile = safeWithin(safeWithin(root, base + '/coverage/requests'), path.resolve(root, arg));
  const requestRef = fileRef(root, requestFile), request = bound(root, requestRef), operationId = hash(canonical({command: 'intake-append', request}));
  const paper = lookup(request.paperId);
  if (command === 'check') {
    const prepared = await prepareAppendCorrection({root, state, paper, request});
    const planned = publication(root, state, paper, request, prepared, campaign.references);
    preflight(root, planned.outputs);
    prepared.recheck();
    for (const ref of [...planned.receiptValue.requiredReferences, requestRef]) checkRef(root, ref);
    checkRef(root, stateRef);
    return {paperId: paper.paperId, iteration: 2, valid: true, scientificAcceptance: false, proof: prepared.proof,
      requiredReferenceCount: planned.references.length, note: 'Read-only mechanical check. Actual admission separately requires active, unpaused execution control.'};
  }
  const control = activeExecution(root), lockPath = safeWithin(ledger, '.writer.lock'), token = randomUUID();
  fs.writeFileSync(lockPath, canonical({pid: process.pid, token, startedAt: new Date().toISOString(), command}), {flag: 'wx'});
  let committed = false;
  const ownLock = () => {
    safeWithin(ledger, '.writer.lock');
    insist(fs.existsSync(lockPath) && read(lockPath).token === token, 'Writer ownership changed; lock retained');
  };
  try {
    ownLock(); control.recheck(); checkRef(root, stateRef); checkRef(root, requestRef);
    if (Object.hasOwn(state.operations, operationId)) {
      const op = state.operations[operationId];
      insist(Array.isArray(op.references), 'Replay operation lacks reference inventory');
      for (const ref of op.references) checkRef(root, ref);
      const verified = await audit(root, state, paper);
      insist(verified.operationId === operationId && sameRef(root, op.response.appendCorrection, verified.receipt), 'Replay operation differs from frozen append receipt');
      verified.recheck(); ownLock(); control.recheck(); checkRef(root, stateRef); checkRef(root, requestRef);
      return {...op.response, replayed: true};
    }
    insist(request.expectedRevision === state.revision, 'Stale expectedRevision');
    guardAdmissionReferences(root, state, null);
    const prepared = await prepareAppendCorrection({root, state, paper, request});
    const planned = publication(root, state, paper, request, prepared, campaign.references);
    preflight(root, planned.outputs);
    const beforeWrite = () => {
      ownLock(); control.recheck(); checkRef(root, stateRef); prepared.recheck();
      for (const ref of [...planned.receiptValue.requiredReferences, requestRef]) checkRef(root, ref);
    };
    beforeWrite();
    for (const output of planned.outputs) {
      // A previous failed attempt may leave matching immutable files. Never
      // overwrite/remove them, and never commit a state for partial outputs.
      beforeWrite(); preflight(root, planned.outputs);
      writeOnceOrMatch(safeWithin(root, output.ref.path), output.bytes);
      beforeWrite(); checkRef(root, output.ref);
    }
    beforeWrite();
    const view = admissionView(root, state, paper.paperId, request, requestRef, planned), {next, references, response} = view;
    for (const ref of references) checkRef(root, ref);
    next.revision++;
    next.updatedAt = new Date().toISOString();
    next.phase = next.papers.every(p => p.phase === 'complete') ? 'coverage_complete' : 'coverage_active';
    next.operations[operationId] = {request: requestRef, response, references};
    const temporary = safeWithin(ledger, '.state-' + process.pid + '-' + randomUUID() + '.tmp'), fd = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(fd, canonical(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      insist(same(read(temporary), next), 'State readback mismatch');
      beforeWrite();
      for (const ref of references) checkRef(root, ref);
      fs.renameSync(temporary, statePath); committed = true;
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    ownLock(); control.recheck(); prepared.recheck();
    for (const ref of references) checkRef(root, ref);
    insist(fs.readFileSync(statePath).equals(Buffer.from(canonical(next))), 'Committed state readback changed; delivery status requires reconciliation');
    return response;
  } catch (error) {
    if (committed) throw new Error('Guard append admission was committed, but post-commit verification failed; do not claim success or dispatch. Reconcile and replay the exact request. ' + String(error?.message ?? error), {cause: error});
    throw error;
  } finally {
    if (fs.existsSync(lockPath)) { ownLock(); fs.unlinkSync(lockPath); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runCoverage(process.cwd(), process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
}
