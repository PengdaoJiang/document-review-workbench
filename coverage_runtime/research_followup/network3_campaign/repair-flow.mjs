// Neutral repair lineage. This module never chooses scientific findings or saves the live ledger.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const check = (ok, message) => { if (!ok) throw Error(message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => hash(fs.readFileSync(file));
const clone = value => structuredClone(value);
const hashPattern = /^[a-f0-9]{64}$/;
export function attemptId(value) {
  const number = typeof value === 'string' && /^a\d{3,}$/.test(value) ? Number(value.slice(1)) : value;
  check(Number.isSafeInteger(number) && number > 0, 'Invalid attempt');
  return 'a' + String(number).padStart(3, '0');
}
function keys(value, allowed, name) {
  check(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${name}`);
  check(Object.keys(value).every(key => allowed.includes(key)), `Unexpected ${name} field`);
}
function inside(directory, filename) {
  const base = path.resolve(directory), file = path.resolve(filename);
  const relative = path.relative(base, file);
  check(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative), 'Path outside allowed repair directory');
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) check(!fs.lstatSync(current).isSymbolicLink(), 'Redirected repair path');
  }
  return file;
}
function ref(root, directory, value) {
  check(value && text(value.path) && hashPattern.test(value.sha256), 'Missing sealed repair reference');
  const file = inside(directory, path.resolve(root, value.path));
  check(sha(file) === value.sha256, 'Repair reference hash mismatch: ' + file);
  return {path: file, sha256: value.sha256};
}
export function writeOnceOrMatch(filename, bytes) {
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  const expected = Buffer.from(bytes);
  const match = () => {
    check(!fs.lstatSync(filename).isSymbolicLink() && fs.readFileSync(filename).equals(expected), 'Conflicting immutable repair material: ' + filename);
  };
  if (fs.existsSync(filename)) match();
  else {
    const temporary = filename + '.tmp-' + process.pid + '-' + randomUUID();
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx');
      fs.writeFileSync(descriptor, expected);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      check(fs.readFileSync(temporary).equals(expected), 'Repair material write verification failed');
      // Same-directory hard-link publication is atomic and refuses an occupied final name.
      // A killed writer can leave its unique temp, never a half-published final record.
      try { fs.linkSync(temporary, filename); }
      catch (error) { if (error.code !== 'EEXIST') throw error; match(); }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary); // only this call's exact temp
    }
  }
  return {path: filename, sha256: sha(filename)};
}
function validateRequest(request, paper, decisionRef) {
  keys(request, ['schemaVersion', 'paperId', 'fromAttempt', 'inputVersion', 'candidateResultSha256', 'reviewSha256', 'decisionSha256', 'publicForWorker', 'requiredChanges', 'retainedChecks'], 'repair request');
  check(request.schemaVersion === 1 && request.paperId === paper.paperId && request.fromAttempt === paper.attempt, 'Repair request paper/attempt mismatch');
  check(request.inputVersion === paper.inputVersion && request.candidateResultSha256 === paper.candidate.result.sha256 && request.reviewSha256 === paper.review.sha256 && request.decisionSha256 === decisionRef.sha256, 'Repair request lineage mismatch');
  check(request.publicForWorker === true, 'Repair request must be supervisor-approved public feedback');
  check(Array.isArray(request.requiredChanges) && request.requiredChanges.length > 0, 'Repair request needs concrete requiredChanges');
  const ids = new Set();
  for (const item of request.requiredChanges) {
    keys(item, ['id', 'claimIds', 'problem', 'requestedChange', 'validationExpectation'], 'required change');
    check(text(item.id) && !ids.has(item.id) && text(item.problem) && text(item.requestedChange) && text(item.validationExpectation), 'Invalid/duplicate required change');
    check(Array.isArray(item.claimIds) && item.claimIds.every(id => text(id) && id.startsWith(paper.paperId + ':')), 'Invalid affected claim IDs');
    ids.add(item.id);
  }
  check(Array.isArray(request.retainedChecks), 'retainedChecks must be explicit');
  for (const item of request.retainedChecks) {
    keys(item, ['claimIds', 'scope', 'basis'], 'retained check');
    check(Array.isArray(item.claimIds) && item.claimIds.length > 0 && item.claimIds.every(id => text(id) && id.startsWith(paper.paperId + ':')) && text(item.scope) && text(item.basis), 'Invalid retained check');
  }
}

export async function prepareRepair({root, base, clean, paper, requestPath, verifyResult}) {
  check(paper && /^(origin|r\d{4})$/.test(paper.paperId), 'Unknown repair paper');
  const id = paper.paperId, receiptRoot = path.join(base, 'receipts', id);
  const requestFile = inside(receiptRoot, path.resolve(root, requestPath));
  check(path.extname(requestFile) === '.json', 'Repair request must be JSON');
  const requestBytes = fs.readFileSync(requestFile), requestHash = hash(requestBytes);
  const request = JSON.parse(requestBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (paper.repair && paper.repair.request.sha256 === requestHash) {
    check(request.paperId === id && request.fromAttempt + 1 === paper.attempt, 'Replayed repair request attempt mismatch');
    // A committed replay never increments the attempt, releases an owner or changes a verdict.
    for (const item of paper.repair.materials) ref(root, base, item);
    return {paper, replayed: true, order: paper.order};
  }
  check(paper.phase === 'revision_required' && !paper.owner && !paper.acceptance, 'Expected unowned revision_required paper');
  check(Number.isSafeInteger(paper.attempt) && paper.attempt > 0, 'Invalid previous repair attempt');
  const previousDecision = paper.decisions?.at(-1);
  check(previousDecision?.decision === 'changes_required', 'No supervisor repair decision');
  validateRequest(request, paper, previousDecision);
  const previousCandidate = ref(root, receiptRoot, paper.candidate);
  const previousReview = ref(root, path.join(clean, 'verifications', id, attemptId(paper.attempt)), paper.review);
  const previousDecisionRef = ref(root, receiptRoot, previousDecision);
  const previousResult = ref(root, path.join(clean, 'results', id), paper.candidate.result);
  const previousOrder = ref(root, path.join(base, 'orders', id), paper.order);
  const input = ref(root, clean, paper.inputPacket);
  check(read(input.path).paperId === id, 'Repair input packet paper mismatch');
  const candidateReceipt = read(previousCandidate.path), decision = read(previousDecisionRef.path), review = read(previousReview.path);
  check(candidateReceipt.paperId === id && attemptId(candidateReceipt.attempt) === attemptId(paper.attempt) && candidateReceipt.inputVersion === paper.inputVersion && candidateReceipt.result.sha256 === previousResult.sha256, 'Previous candidate receipt mismatch');
  check(review.paperId === id && (review.attempt === undefined || attemptId(review.attempt) === attemptId(paper.attempt)), 'Previous review identity mismatch');
  check(decision.paperId === id && decision.decision === 'changes_required' && decision.candidateResultSha256 === previousResult.sha256 && decision.reviewSha256 === previousReview.sha256, 'Previous supervisor decision mismatch');
  const verified = await verifyResult(clean, id, path.basename(previousResult.path, '.json'));
  check(verified.sha256 === previousResult.sha256 && verified.record.inputSha256 === paper.inputPacket.sha256, 'Previous frozen result/input mismatch');

  const next = paper.attempt + 1, label = attemptId(next), orderRoot = path.join(base, 'orders', id);
  const publicPath = inside(orderRoot, path.join(orderRoot, label + '-repair-request.json'));
  const snapshotPath = inside(receiptRoot, path.join(receiptRoot, label + '-prior-state.json'));
  const orderPath = inside(orderRoot, path.join(orderRoot, label + '-worker.md'));
  // Deterministic bytes allow recovery after any file was written but before ledger commit.
  const snapshotBytes = encode(paper);
  const orderText = `1. **目标**\n为 ${id} 执行 ${label} 返修，不是重新从零做首轮研究。仅解决公开返修要求及受影响的依赖，保留真正未受影响的检查。使用全新上下文，不另派任务。\n\n2. **选中输入**\n规则：${path.join(clean, 'AGENTS.md')}\n中性接口：${path.join(clean, 'README.md')}\n公开返修要求：${publicPath}\n请求 SHA256：${requestHash}\n本篇输入包：${input.path}\n输入包 SHA256：${input.sha256}\n固定 Dot 版本：${paper.inputVersion}\n上一冻结候选：${previousCandidate.path}\n候选 SHA256：${previousCandidate.sha256}\n上一冻结结果：${previousResult.path}\n结果 SHA256：${previousResult.sha256}\n仅按本篇冻结 run/reading 读取自己的代码、契约、证据及完整 Dot TeX/宏/包内图件。不要读主管完整决定、历史状态快照、旧复核全文或私有测试，不读取其他论文/全局台账。仅包内无法解决的具体疑点才最小回查原PDF。\n\n3. **私有可写根**\n${path.join(clean, 'papers', id)}\n${path.join(clean, 'drafts', id)}\n单写者。用既有中性入口建立本篇新的 runs/${id}/n3-${label}-* 与 results/${id}/n3-${label}-*；旧工单、契约快照、运行、结果和读本不改写。不能只改旧候选轮次冒充新交付。\n\n4. **交付**\n修复源码/契约及推导，明确 change-impact 和每条问题处置；只复用条件、定义和相关依赖未变的有效检查。改变 claim 定义须新 claimId，契约变化不能把不匹配旧run拼进新结果。发布新 resultId，并在 supersedes 精确引用上一结果。写 drafts/${id}/candidate.json：paperId、attempt:"${label}"、inputVersion、resultPath、resultSha256、runIds、reportPath、openIssues，另必须有 repairRequestSha256:"${requestHash}" 和 previousResultSha256:"${previousResult.sha256}"。记录结果仍未知或不成立的范围，不伪造通过。\n\n5. **验收**\n冻结候选交独立新复核者；覆盖变更和受影响范围，并说明保留检查的有效性。不得继承上一轮整篇通过。主管作科学接受，架构代码不作科学判断。计算用明确 workerCount并留资源余量；Wolfram沿既有独占登记，不启动未知占用内核。交付时说明活动计算已自然结束。\n`;
  // Preflight all occupied destinations before any creation; never overwrite different bytes.
  const planned = [[snapshotPath, snapshotBytes], [publicPath, requestBytes], [orderPath, orderText]];
  for (const [file, bytes] of planned) if (fs.existsSync(file)) check(fs.readFileSync(file).equals(Buffer.from(bytes)), 'Conflicting immutable repair material: ' + file);
  const materials = planned.map(([file, bytes]) => writeOnceOrMatch(file, bytes));
  const nextPaper = clone(paper);
  nextPaper.attemptHistory = [...(paper.attemptHistory ?? []), {attempt: paper.attempt, phase: paper.phase, snapshot: materials[0], candidate: clone(paper.candidate), review: clone(paper.review), decision: clone(previousDecision)}];
  nextPaper.repair = {schemaVersion: 1, fromAttempt: paper.attempt, request: materials[1], priorState: materials[0], previousCandidate, previousResult, previousReview, previousDecision: previousDecisionRef, previousOrder, materials};
  nextPaper.attempt = next;
  nextPaper.phase = 'ready';
  nextPaper.owner = null;
  nextPaper.order = {path: path.relative(root, orderPath).replaceAll('\\', '/'), sha256: materials[2].sha256};
  for (const key of ['contract', 'candidate', 'review', 'reviewOrder', 'acceptance', 'latestOwnerUpdate']) nextPaper[key] = null;
  nextPaper.scientificOutcome = 'under_revision';
  nextPaper.nextStep = 'Dispatch a fresh repair worker with this public repair order; do not repeat the completed first pass.';
  return {paper: nextPaper, order: nextPaper.order, replayed: false, event: {kind: 'repair_prepared', paperId: id, attempt: next, requestSha256: requestHash, priorState: materials[0], order: nextPaper.order}};
}

export function validateCandidateAttempt(paper, candidate, verified) {
  check(attemptId(candidate.attempt) === attemptId(paper.attempt), 'Candidate attempt mismatch; stale draft rejected');
  if (!paper.repair) return;
  validateRepairIntegrity(paper);
  const repair = paper.repair;
  check(candidate.repairRequestSha256 === repair.request.sha256 && candidate.previousResultSha256 === repair.previousResult.sha256, 'Repair candidate lineage mismatch');
  check(verified.sha256 !== repair.previousResult.sha256 && path.resolve(verified.path) !== path.resolve(repair.previousResult.path), 'Repair needs a newly published result, not the prior candidate');
  check(verified.record.supersedes.some(prior => prior.resultId === path.basename(repair.previousResult.path, '.json') && prior.sha256 === repair.previousResult.sha256), 'Repair result must supersede its exact previous result');
}

export function validateRepairReview(paper, review) {
  if (!paper.repair) return; // Frozen first-round work orders retain their original interface.
  validateRepairIntegrity(paper);
  check(review.paperId === paper.paperId && attemptId(review.attempt) === attemptId(paper.attempt), 'Repair review attempt mismatch');
  check(paper.owner?.role === 'reviewer' && review.reviewerAgent === paper.owner.agent, 'Repair review owner mismatch');
  keys(review.bindings, ['result', 'candidateReceipt', 'runs'], 'repair review bindings');
  check(review.bindings?.result?.sha256 === paper.candidate.result.sha256 && path.resolve(review.bindings.result.path) === path.resolve(paper.candidate.result.path), 'Repair review result binding mismatch');
  check(review.bindings?.candidateReceipt?.sha256 === paper.candidate.sha256 && path.resolve(review.bindings.candidateReceipt.path) === path.resolve(paper.candidate.path), 'Repair review candidate binding mismatch');
  check(review.repairRequestSha256 === paper.repair.request.sha256, 'Repair review request mismatch');
  const expectedRuns = paper.candidate.runBindings;
  check(Array.isArray(expectedRuns) && expectedRuns.length > 0 && Array.isArray(review.bindings.runs) && review.bindings.runs.length === expectedRuns.length, 'Repair review run coverage mismatch');
  const seen = new Set(), clean = path.dirname(path.dirname(path.dirname(path.resolve(paper.candidate.result.path))));
  for (const binding of review.bindings.runs) {
    keys(binding, ['runId', 'runSha256', 'readingSha256'], 'repair review run');
    const expected = expectedRuns.find(run => run.runId === binding.runId);
    check(expected && !seen.has(binding.runId) && expected.runSha256 === binding.runSha256, 'Repair review run binding mismatch');
    const reading = path.join(clean, 'runs', paper.paperId, binding.runId, 'reading.json');
    check(hashPattern.test(binding.readingSha256) && sha(reading) === binding.readingSha256, 'Repair review reading binding mismatch');
    seen.add(binding.runId);
  }
  const delta = review.deltaReview;
  check(delta && delta.previousReviewSha256 === paper.repair.previousReview.sha256 && Array.isArray(delta.changedScope) && delta.changedScope.length > 0 && Array.isArray(delta.retainedChecks) && Array.isArray(delta.affectedChecks), 'Missing incremental review scope and retained-check accounting');
  check(delta.changedScope.every(text) && delta.affectedChecks.every(text), 'Invalid incremental review scope');
  for (const item of delta.retainedChecks) check(item && text(item.scope) && text(item.basis), 'Retained checks require scope and unchanged-dependency basis');
}

export function validateRepairIntegrity(paper) {
  if (!paper.repair) return;
  for (const item of [...paper.repair.materials, paper.repair.previousCandidate, paper.repair.previousResult, paper.repair.previousReview, paper.repair.previousDecision]) {
    check(item && hashPattern.test(item.sha256) && sha(item.path) === item.sha256, 'Repair lineage material changed');
  }
}

export function repairReviewContext(paper) {
  if (!paper.repair) return '';
  return `\n返修轮增量约定：本轮 ${attemptId(paper.attempt)}，公开修复要求 ${paper.repair.request.path}（${paper.repair.request.sha256}）。你可按需读取本篇上一冻结结果 ${paper.repair.previousResult.path}（${paper.repair.previousResult.sha256}）和上一复核 ${paper.repair.previousReview.path}（${paper.repair.previousReview.sha256}）及其明确绑定的本篇检查；这些属于复核输入，不回传给施工者。核验累计变更及受影响条件/依赖，未变的有效范围保留，不能把旧整篇recommendation当新接受。review.json 必须有 attempt:"${attemptId(paper.attempt)}"、reviewerAgent（你实际的规范任务标识）、repairRequestSha256:"${paper.repair.request.sha256}"。bindings 仅含 result、candidateReceipt、runs：前两项各用本轮精确path/sha256；runs列全本轮runBindings，每项{runId,runSha256,readingSha256}绑定该run的reading.json。其他检查说明放independentChecks，不在bindings另造run/reading别名。deltaReview={previousReviewSha256:"${paper.repair.previousReview.sha256}",changedScope:[非空字符串变更范围],retainedChecks:[{scope,basis}],affectedChecks:[字符串受影响检查]}。保留检查需说明原证据与条件/依赖不变依据，不能沿用未完成/失败项目。逐条交代公开返修要求是否解决。输入完整性与上述结构检查不替代你的科学判断。\n`;
}

export function reconcileRepairEvent(base, event) {
  check(event?.kind === 'repair_prepared' && Number.isSafeInteger(event.revision), 'Missing committed repair event');
  const file = path.join(base, 'events.jsonl');
  const bytes = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  check(!bytes || bytes.endsWith('\n'), 'State committed; event log has an incomplete tail, preserve and repair it explicitly');
  const records = bytes.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const existing = records.find(record => record.revision === event.revision);
  if (existing) check(encode(existing) === encode(event), 'Conflicting committed repair event');
  else fs.appendFileSync(file, JSON.stringify(event) + '\n');
}
