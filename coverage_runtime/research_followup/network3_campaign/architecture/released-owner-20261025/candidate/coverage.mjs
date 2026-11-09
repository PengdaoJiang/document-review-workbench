// Additive item-level research administration. The supervisor is its sole business writer.
// No scientific execution, old-ledger mutation, source rewriting or service startup occurs here.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyResult} from '../reproduction_clean/runtime/results.mjs';
import {verifyRun} from '../reproduction_clean/runtime/runs.mjs';
import {writeOnceOrMatch} from './repair-flow.mjs';
import {canonical, hash, fileRef, checkRef, makeScan, validateCandidate, validateReview, assessCoverage} from './coverage-core.mjs';
import {validateReleasedDelivery} from './coverage-recovery.mjs';

const insist = (value, message) => { if (!value) throw Error(message); };
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const validText = value => typeof value === 'string' && value.trim().length > 0;
const equal = (a,b) => canonical(a) === canonical(b);
const now = () => new Date().toISOString();
const suffix = revision => 'c' + String(revision).padStart(3,'0');
const rel = (root, filename) => path.relative(root, filename).split(path.sep).join('/');
function safe(root, filename) {
  const base = path.resolve(root), target = path.resolve(root, filename);
  const relative = path.relative(base, target);
  insist(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative), 'Path escapes coverage root');
  let cursor = target;
  while (true) {
    if (fs.existsSync(cursor)) insist(!fs.lstatSync(cursor).isSymbolicLink(), 'Redirected coverage path');
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return target;
}
function freeze(root, filename, value) {
  const target = safe(root, filename);
  writeOnceOrMatch(target, canonical(value));
  return fileRef(root, target);
}
function loadBound(root, reference) { return read(checkRef(root, reference)); }
function prior(root, paper) {
  if (!paper.latest) return null;
  return {candidate:loadBound(root,paper.latest.candidate),sha256:paper.latest.candidate.sha256,
    review:loadBound(root,paper.latest.review),decision:loadBound(root,paper.latest.decision)};
}
function snapshotRefs(paper) { return paper.latest ? [paper.latest.candidate,paper.latest.review,paper.latest.decision] : []; }
function knownGapIds(root,paper) {
  const p=prior(root,paper); if (!p) return [];
  const accepted = new Set(p.decision.acceptedObligationIds);
  return p.candidate.assessments.filter(a=>!accepted.has(a.obligationId)||a.status!=='accepted').map(a=>a.obligationId);
}
function workerOrder(root,paper,version,workRoot) {
  return `1. **目标**\n${paper.paperId} / ${version}：建立或补齐逐式、逐重要表述覆盖；不是重做首轮。先检查本篇完整固定Dot包，盘点编号/无编号/多行子式、承载断言的行内式、定义/前提/单位、算法步骤、正文/图表/附录的重要结论。词法扫描仅是候选，必须补充宏生成或图片内的内容。先映射有效旧证据，只计算缺项、薄弱项及受影响依赖。\n\n2. **选中输入**\n覆盖协议：${path.join(root,'research_followup/network3_campaign/COVERAGE_WORKFLOW.md')}\n封印扫描：${paper.scan.path} SHA256 ${paper.scan.sha256}\n首轮公开候选：${paper.firstPass.result.path} SHA256 ${paper.firstPass.result.sha256}\n主管接受范围：${paper.firstPass.acceptance.path} SHA256 ${paper.firstPass.acceptance.sha256}\n上次覆盖：${paper.latest?JSON.stringify({candidate:paper.latest.candidate,decision:paper.latest.decision}):'无；首轮53/53不构成逐项信用'}\n选定补做义务：${JSON.stringify(paper.allowedScope??[])}\n显式重开理由：${JSON.stringify(paper.reopenReasons??{})}\n只读本篇Dot完整TeX/宏/图件和明确绑定的同篇已接受成果。旧review路径只作精确引用，不读取私有保留测试；复核者负责确认旧复核适用性。禁止全库摘要、图分类、其他论文参数作本篇前提。原PDF只在包内具体疑点无法解决时最小回查。\n\n3. **私有可写根**\n${workRoot}\n新代码、输出、candidate.json及执行回执仅在此新目录。旧papers/drafts/runs/results/reviews、Dot和全局状态不写。使用现有工具执行实际所需小任务，声明workerCount并留CPU余量；Wolfram遵守已验证机器登记，不因本单绕过许可/终止活动计算。不新造全局模型，不要求每项跑所有工具。\n\n4. **交付**\n按协议提交完整版本的candidate.json：原位置→条目→适用义务→前提/依赖→精确证据与逐项结论。扫描全部units和资源逐条处置；完整性仍须另人复核。已有证据不能凭group reproduced广播通过，要逐项写scope/条件/依赖兼容依据。原样携带未改变的已接受assessment；条件或依赖改变时重新绑定并审查影响范围。计算用真实输入/输出/工具版本/命令/exitCode回执；手推给可检查推导。新测试、反例、未复现、工具故障及外部缺项分开。\n\n5. **验收**\n清单完整性、证据充分性、科学结论和执行状态分开。pending/internal_gap/external_blocked不能计为完成；不适用需原文依据和独立同意。重复/非学术定位保留理由，不能删困难项提高百分比。一个一般命题不能仅凭数值网格通过。输出候选路径、实际agent标识及无活动计算的状态，交由不同复核者；不得另派任务或改全局账本。\n`;
}
function reviewerOrder(root,paper,reviewRoot) {
  return `1. **目标**\n独立复核${paper.paperId}/${suffix(paper.iteration)}逐项覆盖候选。你不是施工者；不重跑无关已有效检查。首次独立检查全文未列区域和扫描遗漏，后续核对变化及传递影响。\n\n2. **选中输入**\n协议${path.join(root,'research_followup/network3_campaign/COVERAGE_WORKFLOW.md')}\n扫描${JSON.stringify(paper.scan)}\n候选${JSON.stringify(paper.staged.candidate)}\n首轮精确证据${JSON.stringify(paper.firstPass)}\n上次覆盖${JSON.stringify(paper.latest??null)}\nDot及必要宏/图是默认阅读；不得例行重读PDF，不读别篇或全局科学预设。旧同篇复核私有测试仅你可读，返修只给公开问题/必要条件。\n\n3. **私有可写根**\n${reviewRoot}\n只写你的新review、检查代码/输出/回执。不改候选、原文、旧证据、运行器或业务总表。工具按需并遵守资源登记。\n\n4. **交付**\nreview.json精确绑定正式冻结candidate/scan，reviewerAgent为实际登记标识。检查全部学术资源、数学单元/文本块/图片和宏遗漏；空映射数学/资产需逐个unitExclusions说明。逐义务绑定assessment哈希并给accept或needs_work及证据。完全未变且已独立接受的义务可列retainedObligationIds，但前提/依赖改变或旧检查只是partial不可继承。明确补做、内部未做和真正外部阻塞；不为缺工作制造外部阻塞。\n\n5. **验收**\n复核建议不是主管接受。只有来源清单审定、义务独立证据适当且主管逐项接受才计信用；数值符合、符号等价、一般证明和原实验复现不混同。完成后报告review路径/身份及计算终态；不从流水正常退出推出论文全核验完成。\n`;
}
export async function runCoverage(root, argv) {
  root=path.resolve(root);
  const campaign=safe(root,'research_followup/network3_campaign'), clean=safe(root,'research_followup/reproduction_clean');
  const ledger=safe(campaign,'coverage'), statePath=path.join(ledger,'state.json');
  const authorityPath=safe(root,'docs/network3-coverage-authorization-20261024.json');
  const authority=read(authorityPath), sourceAuthority=loadBound(root,authority.scopeAuthority);
  const ids=sourceAuthority.scope.paperIds;
  insist(Array.isArray(ids)&&ids.length===53&&new Set(ids).size===53,'Coverage requires the exact authorized 53 distinct papers');
  const nodes=loadBound(root,sourceAuthority.scope.nodes);
  insist(equal([...ids].sort(),nodes.map(n=>n.paper_id).sort()),'Scope nodes differ from authorization');
  const closure=loadBound(root,authority.firstPassClosure);
  insist(closure.status==='first_pass_complete_bounded'&&equal(closure.papers.map(p=>p.paperId).sort(),[...ids].sort()),'First-pass baseline membership mismatch');
  const [command,requestPath]=argv;
  if(command==='help'||!command) return {commands:['init','prepare <request.json>','assign <request.json>','release <request.json>','intake <request.json>','review <request.json>','recover-intake <request.json>','recover-review <request.json>','decide <request.json>','continue <request.json>','status','outline <paperId>','plan <paperId>','verify <paperId>'],note:'Business writes belong only to the research supervisor. First-pass state and frozen evidence are never changed.'};
  const state=fs.existsSync(statePath)?read(statePath):null;
  if(state){checkRef(root,state.authority);insist(state.authority.sha256===fileRef(root,authorityPath).sha256,'Coverage authority changed');insist(equal(state.scope,[...ids].sort()),'Ledger scope mismatch');}
  function lookup(id){const paper=state?.papers.find(p=>p.paperId===id);insist(paper,'Unknown/out-of-scope paper');return paper;}
  async function verifyPaper(paper) {
    if(!paper.latest)return {paperId:paper.paperId,inventoryAccepted:false,coverageComplete:false};
    const scan=loadBound(root,paper.scan);let previous=null,metrics;
    // Recheck the frozen incremental chain mechanically, without repeating research.
    for(const snapshot of [...paper.history,paper.latest]){
      const candidate=loadBound(root,snapshot.candidate),review=loadBound(root,snapshot.review),decision=loadBound(root,snapshot.decision);
      insist(snapshot.iteration===candidate.revision,'Snapshot iteration mismatch');
      await validateReview({root,scan,candidate,candidateSha256:snapshot.candidate.sha256,review,reviewer:review.reviewerAgent,worker:candidate.author,previous});
      metrics=assessCoverage({scan,candidate,review,decision});
      insist(equal(metrics,snapshot.metrics),'Saved coverage metrics differ from frozen decisions');
      previous={candidate,sha256:snapshot.candidate.sha256,review,decision};
    }
    return metrics;
  }
  if(command==='status'){
    if(!state)return {status:'not_initialized',scope:53,inventoryAudited:0,completedPapers:0,globalCompletionPercent:null};
    const metrics=state.papers.filter(p=>p.latest).map(p=>p.latest.metrics);
    const inventories=metrics.filter(m=>m.inventoryAccepted===true).length;
    const completed=metrics.filter(m=>m.coverageComplete===true).length;
    const totals=Object.fromEntries(['items','formulas','statements','obligations','settled','supported','refuted','notApplicable','partial','internalGap','externalBlocked','pending','awaitingAcceptance','completedItems'].map(key=>[key,metrics.reduce((sum,m)=>sum+m[key],0)]));
    const applicable=totals.obligations-totals.notApplicable,applicableSettled=totals.settled-totals.notApplicable;
    return {status:completed===53?'coverage_complete':'coverage_in_progress',revision:state.revision,scope:53,prepared:state.papers.filter(p=>p.scan).length,inventoryAudited:inventories,completedPapers:completed,paperCompletionPercent:100*completed/53,totals,applicableObligations:applicable,applicableSettled,globalCompletionPercent:inventories===53&&applicable>0?100*applicableSettled/applicable:null,denominatorNote:inventories===53?'All inventories accepted. Global percentage measures settled applicable obligations; supported/refuted/justified NA remain separate.':'Partial recorded counts only: full source-item/obligation denominator is not yet established. Do not substitute old 701 groups or 53 acceptances.',papers:state.papers.map(p=>({paperId:p.paperId,phase:p.phase,owner:p.owner,iteration:p.iteration,metrics:p.latest?.metrics??null})),integrityNote:'Saved supervisor decisions. Use verify <paperId> to recheck current bound evidence bytes; this command does not scientifically re-review them.'};
  }
  if(command==='plan') {const paper=lookup(requestPath);return {paperId:paper.paperId,phase:paper.phase,firstPass:paper.firstPass,scan:paper.scan,latest:paper.latest,gapObligationIds:knownGapIds(root,paper),rule:'Reuse unchanged independently valid evidence. Read the pending/internal/external reasons before scheduling; external blockers are not automatic rerun work.'};}
  if(command==='outline'){
    const paper=lookup(requestPath);insist(paper.scan,'Prepare the fixed source inventory first');
    const scan=loadBound(root,paper.scan);
    return {paperId:paper.paperId,scan:paper.scan,inputVersion:scan.inputVersion,resources:scan.resources.map(resource=>{
      const units=scan.units.filter(u=>u.resourceId===resource.id);
      return {...resource,unitCounts:Object.fromEntries([...new Set(units.map(u=>u.kind))].map(kind=>[kind,units.filter(u=>u.kind===kind).length])),diagnostics:scan.diagnostics.filter(d=>d.resourceId===resource.id)};
    }),note:'Candidate units include templates, not a scientific denominator. Read academic files normally; select source locators programmatically rather than loading the full scan JSON into model context.'};
  }
  if(command==='verify')return verifyPaper(lookup(requestPath));
  insist(['init','prepare','assign','release','intake','review','recover-intake','recover-review','decide','continue'].includes(command),'Unknown coverage command');
  fs.mkdirSync(ledger,{recursive:true});
  const lockPath=safe(ledger,'.writer.lock'),token=randomUUID();
  fs.writeFileSync(lockPath,canonical({pid:process.pid,token,startedAt:now(),command}),{flag:'wx'});
  try {
    // Re-read under the lock, rejecting a concurrent state change rather than losing it.
    const current=fs.existsSync(statePath)?read(statePath):null;
    insist(equal(current,state),'Coverage state changed before writer acquisition; retry with current revision');
    if(command==='init') {
      if(state)return {status:'already_initialized',revision:state.revision,scope:53};
      const papers=ids.map(paperId=>{
        const historical=closure.papers.find(p=>p.paperId===paperId);
        // Old closure references sometimes include descriptive metadata. Project the
        // file identity without rewriting history or relaxing the new strict schema.
        const firstPass={paperId,...Object.fromEntries(['result','review','acceptance'].map(key=>[key,{path:historical[key].path,sha256:historical[key].sha256}]))};
        return {paperId,phase:'unprepared',owner:null,iteration:0,firstPass,scan:null,latest:null,history:[]};
      });
      const next={schemaVersion:1,phase:'coverage_active',revision:0,createdAt:now(),updatedAt:now(),authority:fileRef(root,authorityPath),scope:[...ids].sort(),firstPassClosure:authority.firstPassClosure,operations:{},papers};
      saveState(next);return {status:'initialized',revision:0,scope:53};
    }
    insist(state,'Initialize coverage before assigning work');
    insist(requestPath,'Expected a supervisor request JSON');
    const requestFile=safe(safe(ledger,'requests'),path.resolve(root,requestPath));
    const request=read(requestFile),operationId=hash(canonical({command,request}));
    if(state.operations[operationId]){
      for(const reference of state.operations[operationId].references??[])checkRef(root,reference);
      return {...state.operations[operationId].response,replayed:true};
    }
    insist(request.expectedRevision===state.revision,'Stale expectedRevision');
    const paper=lookup(request.paperId),version=suffix(paper.iteration||1);
    let response,references=[];
    if(command==='prepare'||command==='continue') {
      const first=command==='prepare';
      insist(!paper.owner&&(first?paper.phase==='unprepared':['assessed','complete'].includes(paper.phase)),'Paper is not at a safe preparation boundary');
      if(first){
        const resultPath=checkRef(root,paper.firstPass.result);
        const verified=await verifyResult(clean,paper.paperId,path.basename(resultPath,'.json'));
        insist(verified.sha256===paper.firstPass.result.sha256,'First-pass result changed');
        const review=loadBound(root,paper.firstPass.review),decision=loadBound(root,paper.firstPass.acceptance);
        insist(decision.decision==='accept_bounded'&&decision.paperId===paper.paperId&&decision.candidateResultSha256===verified.sha256&&decision.reviewSha256===paper.firstPass.review.sha256&&review.paperId===paper.paperId,'First-pass acceptance mismatch');
        const readings=verified.record.runBindings.map(r=>verifyRun(clean,paper.paperId,r.runId,{requireCurrentSource:false}).readingView);
        insist(readings.length&&readings.every(v=>equal(v,readings[0])),'First-pass result has inconsistent reading views');
        insist(readings[0].mode==='dot_latex','Item coverage requires the pinned Dot package');
        const scan=await makeScan({root,paperId:paper.paperId,reading:readings[0],firstPass:{result:paper.firstPass.result,review:paper.firstPass.review,acceptance:paper.firstPass.acceptance}});
        paper.scan=freeze(root,path.join(ledger,paper.paperId,'scan.json'),scan);paper.allowedScope=[];paper.reopenReasons={};
      }else{
        await verifyPaper(paper);
        const gaps=knownGapIds(root,paper),old=prior(root,paper),allIds=new Set(old.candidate.assessments.map(a=>a.obligationId));
        const selected=request.obligationIds??gaps;
        insist(Array.isArray(selected)&&new Set(selected).size===selected.length&&selected.every(id=>allIds.has(id)),'Invalid delta obligation scope');
        const reasons=request.reopenReasons??{};
        for(const id of selected)insist(gaps.includes(id)||validText(reasons[id]),'Reopening an accepted obligation needs a concrete reason');
        insist(selected.length>0||old.decision.inventoryAccepted===false,'Nothing to repair; do not manufacture a whole-paper rerun');
        paper.allowedScope=selected;paper.reopenReasons=reasons;
      }
      paper.iteration++;const nextVersion=suffix(paper.iteration);
      const workRoot=safe(clean,`coverage_work/${paper.paperId}/${nextVersion}`);
      const orderPath=safe(ledger,`${paper.paperId}/${nextVersion}/worker.md`);
      writeOnceOrMatch(orderPath,workerOrder(root,paper,nextVersion,workRoot));
      paper.order=fileRef(root,orderPath);paper.workRoot=rel(root,workRoot);paper.phase='ready';paper.staged=null;
      response={paperId:paper.paperId,phase:paper.phase,iteration:paper.iteration,order:paper.order,scan:paper.scan,workRoot:paper.workRoot,selectedObligationIds:paper.allowedScope};references=[paper.order,paper.scan];
    }else if(command==='assign'){
      insist(!paper.owner&&validText(request.agent)&&request.freshContext===true&&request.historyInherited===false,'Actual fresh agent registration required');
      insist((request.role==='worker'&&paper.phase==='ready')||(request.role==='reviewer'&&paper.phase==='awaiting_review'),'Wrong assignment phase/role');
      if(request.role==='reviewer')insist(request.agent!==paper.staged.worker&&!(paper.workerHistory??[]).includes(request.agent),'Worker cannot independently review this paper');
      if(request.role==='worker')paper.workerHistory=[...new Set([...(paper.workerHistory??[]),request.agent])];
      paper.owner={agent:request.agent,role:request.role,startedAt:now()};paper.phase=request.role==='worker'?'working':'reviewing';
      response={paperId:paper.paperId,owner:paper.owner,phase:paper.phase};
    }else if(command==='release'){
      insist(paper.owner?.agent===request.agent&&['working','reviewing'].includes(paper.phase),'Release must name the registered active owner');
      insist(request.ownerFinished===true&&request.noActiveCalculation===true&&validText(request.reason),'Release requires confirmed owner/calculation termination and reason, not a timeout');
      const terminal=checkRef(root,request.terminalEvidence);
      safe(safe(ledger,'requests'),terminal);
      const released={paperId:paper.paperId,iteration:paper.iteration,owner:paper.owner,reason:request.reason,terminalEvidence:request.terminalEvidence,confirmedBy:request.supervisor};
      insist(validText(request.supervisor),'Release requires the actual supervisor');
      const receipt=freeze(root,path.join(ledger,paper.paperId,version,`release-${operationId}.json`),released);
      paper.phase=paper.owner.role==='worker'?'ready':'awaiting_review';paper.owner=null;
      response={paperId:paper.paperId,phase:paper.phase,release:receipt};references=[receipt,request.terminalEvidence];
    }else if(command==='intake'||command==='recover-intake'){
      const recovery=command==='recover-intake'?validateReleasedDelivery({root,state,paper,request,command}):null;
      if(!recovery)insist(paper.phase==='working'&&paper.owner?.role==='worker'&&paper.owner.agent===request.agent&&request.ownerFinished===true,'Confirm the assigned worker naturally finished before intake');
      const actor=recovery?.actor??paper.owner.agent;
      const candidate=recovery?recovery.delivery:read(safe(safe(root,paper.workRoot),path.resolve(root,request.candidatePath)));
      const scan=loadBound(root,paper.scan),previous=prior(root,paper);
      insist(candidate.author===actor&&candidate.revision===paper.iteration,'Candidate author/revision mismatch');
      insist(candidate.predecessorSha256===(paper.latest?.candidate.sha256??null),'Candidate predecessor mismatch');
      await validateCandidate({root,scan,scanSha256:paper.scan.sha256,candidate,previous});
      if(previous){
        const allowed=new Set(paper.allowedScope),oldById=new Map(previous.candidate.assessments.map(x=>[x.obligationId,x]));
        // New inventory items and their affected dependencies may expand work, but existing
        // accepted assessments cannot be silently recomputed outside the declared delta.
        for(const assessment of candidate.assessments){const old=oldById.get(assessment.obligationId);if(old&&previous.decision.acceptedObligationIds.includes(assessment.obligationId)&&!equal(old,assessment)&&!allowed.has(assessment.obligationId)){
          const impact=candidate.changeImpact?.find(x=>x.obligationId===assessment.obligationId);
          insist(impact&&validText(impact.reason)&&Array.isArray(impact.dependsOnChangedItems)&&impact.dependsOnChangedItems.length,'Changed retained assessment needs explicit dependency-impact explanation');
        }}
      }
      recovery?.recheck();
      const frozen=freeze(root,path.join(ledger,paper.paperId,version,'candidate.json'),candidate);
      const reviewRoot=safe(clean,`coverage_verifications/${paper.paperId}/${version}`);
      paper.staged={candidate:frozen,worker:actor,workOrder:paper.order,reviewRoot:rel(root,reviewRoot)};
      paper.workerHistory=[...new Set([...(paper.workerHistory??[]),actor])];paper.owner=null;paper.phase='awaiting_review';
      const reviewOrderPath=safe(ledger,`${paper.paperId}/${version}/reviewer.md`);
      writeOnceOrMatch(reviewOrderPath,reviewerOrder(root,paper,reviewRoot));paper.staged.reviewOrder=fileRef(root,reviewOrderPath);
      response={paperId:paper.paperId,phase:paper.phase,candidate:frozen,reviewOrder:paper.staged.reviewOrder,reviewRoot:paper.staged.reviewRoot,...(recovery?{recovery:recovery.recovery}:{})};references=[frozen,paper.staged.reviewOrder,...(recovery?.references??[])];
    }else if(command==='review'||command==='recover-review'){
      const recovery=command==='recover-review'?validateReleasedDelivery({root,state,paper,request,command}):null;
      if(!recovery)insist(paper.phase==='reviewing'&&paper.owner?.role==='reviewer'&&paper.owner.agent===request.agent&&request.ownerFinished===true,'Confirm the assigned independent reviewer naturally finished');
      const actor=recovery?.actor??paper.owner.agent;
      const review=recovery?recovery.delivery:read(safe(safe(root,paper.staged.reviewRoot),path.resolve(root,request.reviewPath)));
      const candidate=loadBound(root,paper.staged.candidate),scan=loadBound(root,paper.scan);
      await validateReview({root,scan,candidate,candidateSha256:paper.staged.candidate.sha256,review,reviewer:actor,worker:paper.staged.worker,previous:prior(root,paper)});
      recovery?.recheck();
      const frozen=freeze(root,path.join(ledger,paper.paperId,version,'review.json'),review);
      paper.staged.review=frozen;paper.staged.reviewer=actor;paper.owner=null;paper.phase='review_received';
      response={paperId:paper.paperId,phase:paper.phase,review:frozen,...(recovery?{recovery:recovery.recovery}:{})};references=[frozen,...(recovery?.references??[])];
    }else if(command==='decide'){
      insist(paper.phase==='review_received'&&!paper.owner,'Expected completed independent review');
      const decisionFile=safe(safe(ledger,'requests'),path.resolve(root,request.decisionPath));
      const decision=read(decisionFile),candidate=loadBound(root,paper.staged.candidate),review=loadBound(root,paper.staged.review),scan=loadBound(root,paper.scan);
      insist(decision.paperId===paper.paperId&&decision.revision===paper.iteration&&decision.candidateSha256===paper.staged.candidate.sha256&&decision.reviewSha256===paper.staged.review.sha256,'Decision does not bind this exact candidate/review');
      await validateCandidate({root,scan,scanSha256:paper.scan.sha256,candidate,previous:prior(root,paper)});
      await validateReview({root,scan,candidate,candidateSha256:paper.staged.candidate.sha256,review,reviewer:paper.staged.reviewer,worker:paper.staged.worker,previous:prior(root,paper)});
      const metrics=assessCoverage({scan,candidate,review,decision});
      const frozen=freeze(root,path.join(ledger,paper.paperId,version,'decision.json'),decision);
      if(paper.latest)paper.history.push(paper.latest);
      paper.latest={iteration:paper.iteration,candidate:paper.staged.candidate,review:paper.staged.review,decision:frozen,metrics};paper.staged=null;paper.phase=metrics.coverageComplete?'complete':'assessed';
      response={paperId:paper.paperId,phase:paper.phase,metrics,latest:paper.latest};references=snapshotRefs(paper);
    }
    state.revision++;state.updatedAt=now();state.phase=state.papers.every(p=>p.phase==='complete')?'coverage_complete':'coverage_active';
    response={...response,revision:state.revision};state.operations[operationId]={response,references};saveState(state);return response;
    function saveState(next){
      const temp=safe(ledger,`.state-${process.pid}-${randomUUID()}.tmp`);
      const descriptor=fs.openSync(temp,'wx');
      try{fs.writeFileSync(descriptor,canonical(next));fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
      try{insist(equal(read(temp),next),'State readback mismatch');fs.renameSync(temp,statePath);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
    }
  }finally{
    if(fs.existsSync(lockPath)){insist(read(lockPath).token===token,'Writer ownership changed; lock retained');fs.unlinkSync(lockPath);}
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await runCoverage(process.cwd(),process.argv.slice(2)),null,2));}
  catch(error){console.error(error.stack??String(error));process.exitCode=1;}
}

