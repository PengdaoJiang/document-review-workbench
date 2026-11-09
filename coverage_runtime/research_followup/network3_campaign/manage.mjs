import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyResult,validateContract} from '../reproduction_clean/runtime/results.mjs';
import {prepareRepair,validateCandidateAttempt,validateRepairReview,validateRepairIntegrity,repairReviewContext,writeOnceOrMatch,reconcileRepairEvent} from './repair-flow.mjs';
const base=path.dirname(fileURLToPath(import.meta.url)), root=path.resolve(base,'../..');
const clean=path.join(root,'research_followup/reproduction_clean'), statePath=path.join(base,'state.json');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const now=()=>new Date().toISOString();
const assert=(ok,s)=>{if(!ok)throw Error(s);};
const authPath=path.join(root,'docs/network3-research-authorization-20261023.json'), auth=read(authPath);
function save(state,event){state.updatedAt=now();state.revision++;const stamped={at:state.updatedAt,revision:state.revision,...event};if(event.kind==='repair_prepared')state.papers.find(p=>p.paperId===event.paperId).repair.commitEvent=stamped;const temp=statePath+'.tmp-'+process.pid;fs.writeFileSync(temp,JSON.stringify(state,null,2)+'\n',{flag:'wx'});fs.renameSync(temp,statePath);fs.appendFileSync(path.join(base,'events.jsonl'),JSON.stringify(stamped)+'\n');renderStatus(state);}
function renderStatus(state){
 const labels={queued:'待派发',ready:'工单就绪',researching:'研究中',awaiting_review:'候选已收，待复核',reviewing:'独立复核中',revision_required:'待返修',review_received:'复核已收，待决定',accepted_bounded:'已接受有界结果',externally_blocked:'外部阻塞'};
 const counts={};for(const p of state.papers)counts[labels[p.phase]??p.phase]=(counts[labels[p.phase]??p.phase]??0)+1;
 const count=key=>state.papers.filter(p=>p[key]).length;
 const lines=['# 网络 3.0 科研进度','',`更新：${state.updatedAt}（UTC），总表修订 ${state.revision}。`,``, '固定范围 53 篇。这里统计主管已收取并登记的证据，不将研究重建、运行退出或候选发布记为独立科学完成。','',Object.entries(counts).map(([k,v])=>`${k} ${v}`).join('；')+'。','',`已收契约 ${count('contract')}/53；已收冻结候选 ${count('candidate')}/53；已收独立复核 ${count('review')}/53；已接受有界结果 ${count('acceptance')}/53。`,'','有界结果可能是成功复现、经过验证的不匹配或原文信息不足；它们不互相替代。四维适用性、科学结论及未解决义务以逐篇结果和接受记录为准。','', '| 论文 | 阶段 | 当前执行者 | 科学结论 |', '|---|---|---|---|'];
 for(const p of state.papers)lines.push(`| ${p.paperId} | ${labels[p.phase]??p.phase} | ${p.owner?.agent??'—'} | ${p.scientificOutcome??'unassessed'} |`);
 lines.push('','机器记录：[state.json](state.json)。授权：[固定 53 篇授权](../../docs/network3-research-authorization-20261023.json)。旧批复台保持退役、source/blind 0/0。','');fs.writeFileSync(path.join(base,'STATUS.md'),lines.join('\n'));
}
function cli(...args){const r=spawnSync(process.execPath,[path.join(clean,'runtime/cli.mjs'),...args],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});assert(r.status===0,r.stderr||r.error?.message||'CLI failed');return r.stdout;}
const [command,id,argument]=process.argv.slice(2);
if(command==='init'){
 assert(!fs.existsSync(statePath),'State already exists; inspect and resume, never reset.');
 for(const ref of [auth.scope.nodes,auth.scope.edges,auth.reading]){const p=ref.path??ref.index,h=ref.sha256??ref.indexSha256;assert(sha(path.join(root,p))===h,'Authority hash mismatch: '+p);}
 const ids=read(path.join(root,auth.scope.nodes.path)).map(n=>n.paper_id).sort();assert(JSON.stringify(ids)===JSON.stringify([...auth.scope.paperIds].sort()),'Scope membership mismatch');
 const dot=read(path.join(root,auth.reading.index));
 const state={schemaVersion:1,campaignId:auth.campaignId,supervisorThreadId:auth.supervisor.threadId,soleWriter:'/root',authority:{path:path.relative(root,authPath).replaceAll('\\','/'),sha256:sha(authPath)},status:'active',revision:0,createdAt:now(),updatedAt:null,scope:{paperCount:ids.length,paperIds:auth.scope.paperIds,nodes:auth.scope.nodes,edges:auth.scope.edges},reading:auth.reading,legacyDeskResumed:false,scientificCompletion:false,papers:auth.scope.paperIds.map(paperId=>({paperId,phase:'queued',owner:null,attempt:0,order:null,inputVersion:dot.papers.find(p=>p.paperId===paperId)?.version??null,inputPacket:null,contract:null,candidate:null,review:null,acceptance:null,scientificOutcome:'unassessed',openIssues:[],nextStep:'Prepare a neutral single-paper input and dispatch a fresh worker.'}))};
 assert(state.papers.every(p=>p.inputVersion),'Missing Dot identity');save(state,{kind:'initialized',paperCount:ids.length});console.log(JSON.stringify({status:state.status,paperCount:ids.length,statePath}));
}else{
 const state=read(statePath), paper=state.papers.find(p=>p.paperId===id);
 if(command==='prepare'){
  assert(paper&&paper.phase==='queued'&&!paper.owner,'Paper is not unowned and queued');
  const handoff=cli('handoff',id), view=JSON.parse(cli('verify-reading',id));assert(view.edition.version===paper.inputVersion,'Selected input version changed');
  const attempt='a001',dir=path.join(base,'orders',id);fs.mkdirSync(dir,{recursive:true});
  const order=path.join(dir,attempt+'-worker.md');
  const content=`1. **目标**\n为 ${id} 完成本轮独立首轮研究：从完整 Dot 包建立关键贡献清单，并逐项完成适用的原貌复现、算法一致性验证、公式推导、仿真验证。使用无历史继承上下文；不得另派代理或联系其他聊天。不要将任务退出视为科学通过。\n\n2. **选中输入**\n${handoff}\n只读本工单和上述中性规则/运行器，以及本篇固定 Dot 的完整 TeX、包内图件、必要宏；原 PDF 仅用于包内无法解决的具体疑点的最小范围回查。不得读全局总表、图分类、旧研究、其他论文结果。工具路径可只读探测；每项参数和模型均由本篇独立确定。\n\n3. **私有可写根**\n${path.join(clean,'papers',id)}\n${path.join(clean,'drafts',id)}\n通过现有运行器创建本篇新的 runs/${id}/n3-* 和 results/${id}/n3-*。一个写者；不要改运行器、原文、Dot、输入包或全局状态。运行计划明确 workerCount，初始轻计算用 1，并限制底层 BLAS/OpenMP 为 1；重工作另报实际资源需求。仅使用当前任务已登记且所有权明确的计算工具；不得启动或终止未归属的外部进程。\n\n4. **交付**\n契约 contract.json、完整贡献/条件清单、可重跑的新代码、推导及逐项研究说明、运行计划、实际输出和失败/缺口，均在本篇私有根内。使用中性 CLI 冻结 run 并发布不可覆盖 result（发布仅是候选）。另在 drafts/${id}/candidate.json 写交接清单，包含 paperId、attempt、inputVersion、contractPath、runIds、resultPath、resultSha256、reportPath、四维适用性与覆盖、openIssues。科学验证优先使用完整 Dot 包；仅包内无法解决的具体歧义、实质缺项或有依据的转写疑点才定点回查 PDF，简记理由。公式重要、推导、复核或填页码都不是例行回查理由，不修改读本。sourceLocations 可用绑定的 Dot version/path/sha256 加语义定位，未知 page 省略。需要的公式原文定位、原文未定义的实现假设、统计不确定度均明确记录。原文信息不足须调查后给具体证据，不能为赶进度省略可做的验证。\n\n5. **验收**\n主管将冻结候选交另一个新上下文独立复核。验收看全文关键命题和适用义务是否都有证据、数学条件是否正确、代码是否忠实、图表/实验是否可复查，不要求所有工具或强造不适用实验。运行成功、自测通过、发表工具同意均不能替代独立复核。最终回复给候选路径/哈希、完成范围、仍未解决项及当前无活动计算的事实；真实工具阻塞请及时回报并继续独立可做部分。\n`;
  fs.writeFileSync(order,content,{flag:'wx'});paper.phase='ready';paper.attempt=1;paper.order={path:path.relative(root,order).replaceAll('\\','/'),sha256:sha(order)};paper.inputPacket=view.originalPacket;paper.nextStep='Spawn a fresh worker with only this work order.';save(state,{kind:'prepared',paperId:id,order:paper.order});console.log(JSON.stringify({paperId:id,order:paper.order,inputPacket:paper.inputPacket}));
 }else if(command==='prepare-repair'){
  assert(argument,'Expected a supervisor-authored public repair request path');
  const prepared=await prepareRepair({root,base,clean,paper,requestPath:argument,verifyResult});
  if(prepared.replayed){reconcileRepairEvent(base,paper.repair.commitEvent);renderStatus(state);console.log(JSON.stringify({paperId:id,phase:paper.phase,attempt:paper.attempt,replayed:true,order:paper.order}));}
  else{state.papers[state.papers.indexOf(paper)]=prepared.paper;save(state,prepared.event);console.log(JSON.stringify({paperId:id,phase:prepared.paper.phase,attempt:prepared.paper.attempt,replayed:false,order:prepared.order,repair:prepared.paper.repair}));}
 }else if(command==='owner'){
  assert(paper&&paper.phase==='ready'&&!paper.owner&&argument,'Expected a ready paper and actual agent identifier');paper.owner={agent:argument,role:'worker',startedAt:now(),freshContext:true,historyInherited:false};paper.phase='researching';paper.nextStep='Await frozen candidate; owner performs the paper-specific work.';save(state,{kind:'worker_started',paperId:id,owner:paper.owner});console.log(JSON.stringify({paperId:id,phase:paper.phase,owner:paper.owner}));
 }else if(command==='worker-update'){
  assert(paper&&paper.owner&&argument,'Expected assigned owner and factual update');paper.latestOwnerUpdate={at:now(),agent:paper.owner.agent,basis:'Owner message; not supervisor scientific acceptance',text:argument};save(state,{kind:'owner_checkpoint',paperId:id,update:paper.latestOwnerUpdate});console.log(JSON.stringify({paperId:id,updated:true}));
 }else if(command==='observe-contract'){
  assert(paper&&paper.phase==='researching'&&paper.owner,'Expected an active assigned worker');const file=path.join(clean,'papers',id,'contract.json'),contract=read(file);validateContract(contract,read(paper.inputPacket.path),paper.inputPacket.sha256,JSON.parse(cli('verify-reading',id)));paper.contract={path:file,sha256:sha(file),inventory:contract.claimInventory,claimCount:contract.claims.length,observedAt:now(),provisionalUntilCandidateIntake:true};save(state,{kind:'working_contract_observed',paperId:id,contract:paper.contract});console.log(JSON.stringify({paperId:id,claimCount:contract.claims.length,inventory:contract.claimInventory.status}));
 }else if(command==='intake'){
  assert(paper&&paper.phase==='researching'&&paper.owner,'Expected a live assigned paper; independently confirm its worker has ended before intake');
  const candidatePath=path.join(clean,'drafts',id,'candidate.json'),candidate=read(candidatePath);
  assert(candidate.paperId===id&&candidate.inputVersion===paper.inputVersion,'Candidate identity or version mismatch');
  const resultPath=path.resolve(root,candidate.resultPath);
  assert(path.dirname(resultPath)===path.join(clean,'results',id),'Candidate result is outside its immutable result directory');
  const resultId=path.basename(resultPath,'.json'),verified=await verifyResult(clean,id,resultId);
  assert(verified.sha256===candidate.resultSha256,'Candidate result hash mismatch');
  assert(verified.record.inputSha256===paper.inputPacket.sha256,'Candidate input changed');
  validateCandidateAttempt(paper,candidate,verified);
  const attempt='a'+String(paper.attempt).padStart(3,'0'),receiptDir=path.join(base,'receipts',id);fs.mkdirSync(receiptDir,{recursive:true});
  const receiptPath=path.join(receiptDir,attempt+'-candidate.json');
  const receipt={schemaVersion:1,paperId:id,attempt,receivedAt:fs.existsSync(receiptPath)?read(receiptPath).receivedAt:now(),worker:paper.owner,order:paper.order,candidatePath,candidateSha256:sha(candidatePath),candidate,result:{path:verified.path,sha256:verified.sha256},inputVersion:paper.inputVersion,runBindings:verified.record.runBindings,claimStatuses:verified.record.claims.map(c=>({claimId:c.claimId,status:c.status})),mechanicalVerification:'passed; not scientific acceptance'};
  writeOnceOrMatch(receiptPath,JSON.stringify(receipt,null,2)+'\n');
  paper.contract={sha256:verified.record.contractSha256,inventory:verified.record.contract.claimInventory,claimCount:verified.record.contract.claims.length};paper.candidate={path:receiptPath,sha256:sha(receiptPath),result:receipt.result,runBindings:receipt.runBindings};paper.ownerHistory=[...(paper.ownerHistory??[]),{...paper.owner,releasedAt:now(),releaseBasis:'Supervisor observed worker completion and received candidate'}];paper.owner=null;paper.phase='awaiting_review';paper.openIssues=candidate.openIssues??[];paper.nextStep='Dispatch a different fresh reviewer against the exact frozen candidate.';
  const orderPath=path.join(base,'orders',id,attempt+'-reviewer.md'),writable=path.join(clean,'verifications',id,attempt);
  fs.mkdirSync(writable,{recursive:true});
  const content=`1. **目标**\n独立复核 ${id} 的本轮冻结候选，核验完整 Dot 内容的关键贡献覆盖及适用的原貌复现、算法验证、公式推导、仿真验证。你不是施工者，使用新的无历史上下文，不预设施工结论正确。不得另派代理或联系其他聊天。\n\n2. **选中输入**\n只读本工单、中性规则 ${path.join(clean,'AGENTS.md')}、协议 ${path.join(clean,'README.md')}、冻结交接 ${receiptPath}（SHA256 ${sha(receiptPath)}）、冻结结果 ${verified.path}（SHA256 ${verified.sha256}），以及其中明确绑定的本篇 runs、reading.json、Dot 全文/必要宏与包内图资产；封印原 PDF 只在包内无法解决的具体疑点上最小范围回查。先核对所有输入/结果/运行 SHA。只使用冻结 source 和输出，不读可变 papers 草稿、其他论文、旧研究、图筛选或主管科学推断。可只读中性 runtime API。\n\n3. **私有可写根**\n${writable}\n所有新核查代码、运行、编译缓存、报告仅在此目录。不得改施工候选、运行器或全局状态。单个轻计算 workerCount=1、BLAS/OpenMP=1；工具路径可只读核实。使用当前部署已登记的 Python 解释器并记录实际版本。需要尚未登记的计算工具时，报告具体必要性，同时继续不依赖它的核查。\n\n4. **交付**\n本目录写 review.json 和易读 review.md，包含 paperId、attempt、reviewer 标识、新上下文声明、精确 candidate/result/run/reading 绑定、逐 claim 独立结论、四个维度适用性/覆盖、原文关键贡献是否遗漏、实际独立检查及相应源码/输出 SHA、blockingFindings、limitations、建议接受范围或返修要求。直接查本篇完整 Dot 正文及包内图件，尽量不打开、抽取或渲染原 PDF；仅具体歧义、缺项或有依据的转写疑点允许定点回查，推导/重要公式/独立复核/填页码本身均不是回查理由；独立推导关键条件，检查实现与断言，独立设计适量有区分力的测试或反例。不得仅重复候选输出/自测就给通过。定量实验检查原参数出处、缺省假设、指标、种子、统计不确定度和结论强度。将科学错误、转写差异、实现问题、外部信息不足及工具失败分开。存在真实可修复缺口则具体报返修；不可实施的原文缺口可以验证为有界调查结论，不冒称完全复现。\n\n5. **验收**\n主管依据你的实际独立证据和明确范围接受或返修。review.json 的 recommendation 为 accept_bounded / changes_required / externally_blocked 之一，同时声明 scientificOutcome 与 unresolvedObligations。请给具体问题和必要复现条件，保留私有测试不向施工者整包公开。结尾报告 review.json 路径/哈希与活动计算状态；不要改论文或代表主管接受。\n`;
  writeOnceOrMatch(orderPath,content+repairReviewContext(paper));paper.reviewOrder={path:path.relative(root,orderPath).replaceAll('\\','/'),sha256:sha(orderPath)};
  save(state,{kind:'candidate_received',paperId:id,candidate:paper.candidate,reviewOrder:paper.reviewOrder});console.log(JSON.stringify({paperId:id,candidate:paper.candidate,reviewOrder:paper.reviewOrder,claims:paper.contract.claimCount}));
 }else if(command==='review-owner'){
  assert(paper&&paper.phase==='awaiting_review'&&!paper.owner&&argument,'Expected an unowned review and actual fresh reviewer identifier');assert(!(paper.ownerHistory??[]).some(o=>o.agent===argument),'Reviewer must differ from all workers');paper.owner={agent:argument,role:'reviewer',startedAt:now(),freshContext:true,historyInherited:false};paper.phase='reviewing';paper.nextStep='Await independent review of the frozen candidate.';save(state,{kind:'reviewer_started',paperId:id,owner:paper.owner});console.log(JSON.stringify({paperId:id,phase:paper.phase,owner:paper.owner}));
 }else if(command==='receive-review'){
  assert(paper&&paper.phase==='reviewing'&&paper.owner?.role==='reviewer','Expected an assigned review; confirm reviewer has completed before receipt');
  const attempt='a'+String(paper.attempt).padStart(3,'0'),reviewPath=path.join(clean,'verifications',id,attempt,'review.json'),review=read(reviewPath);
  validateRepairReview(paper,review);
  assert(review.paperId===id,'Review paper identity mismatch');assert(['accept_bounded','changes_required','externally_blocked'].includes(review.recommendation),'Missing independent recommendation');assert(JSON.stringify(review).includes(paper.candidate.result.sha256),'Review does not explicitly bind the candidate result hash');
  const verified=await verifyResult(clean,id,path.basename(paper.candidate.result.path,'.json'));assert(verified.sha256===paper.candidate.result.sha256,'Candidate changed while under review');
  paper.review={path:reviewPath,sha256:sha(reviewPath),receivedAt:now(),reviewer:paper.owner,recommendation:review.recommendation,independentBindingCheck:'Exact result hash present and frozen result mechanically reverified; supervisor assesses scientific scope separately.'};paper.ownerHistory=[...(paper.ownerHistory??[]),{...paper.owner,releasedAt:now(),releaseBasis:'Supervisor observed completed independent review'}];paper.owner=null;paper.phase='review_received';paper.nextStep='Supervisor examines independent evidence and makes a bounded decision.';save(state,{kind:'review_received',paperId:id,review:paper.review});console.log(JSON.stringify({paperId:id,review:paper.review}));
 }else if(command==='decide'){
  validateRepairIntegrity(paper);
  assert(paper&&paper.phase==='review_received'&&!paper.owner,'Expected received independent review');const attempt='a'+String(paper.attempt).padStart(3,'0'),decisionPath=path.join(base,'receipts',id,attempt+'-supervisor.json'),decision=read(decisionPath);
  assert(sha(paper.candidate.path)===paper.candidate.sha256&&sha(paper.candidate.result.path)===paper.candidate.result.sha256&&sha(paper.review.path)===paper.review.sha256,'Candidate/result/review bytes changed before decision');
  assert(decision.paperId===id&&decision.candidateResultSha256===paper.candidate.result.sha256&&decision.reviewSha256===paper.review.sha256,'Supervisor decision is not bound to this candidate/review');assert(['accept_bounded','changes_required','externally_blocked'].includes(decision.decision),'Invalid supervisor decision');assert(typeof decision.scientificOutcome==='string'&&Array.isArray(decision.unresolvedObligations),'Decision must separate science and remaining work');
  paper.decisions=[...(paper.decisions??[]),{path:decisionPath,sha256:sha(decisionPath),decision:decision.decision}];paper.scientificOutcome=decision.scientificOutcome;paper.openIssues=decision.unresolvedObligations;
  if(decision.decision==='accept_bounded'){assert(paper.review.recommendation==='accept_bounded','Cannot accept an unresolved adverse independent review');paper.acceptance={path:decisionPath,sha256:sha(decisionPath),acceptedAt:now(),scope:decision.acceptedScope,terminalForFirstPass:decision.terminalForFirstPass===true};paper.phase='accepted_bounded';paper.nextStep=decision.nextStep??'Consume only this exact result version in downstream synthesis; preserve limits.';}else{paper.phase=decision.decision==='changes_required'?'revision_required':'externally_blocked';paper.nextStep=decision.nextStep??'Resolve the explicitly recorded remaining obligations.';}
  save(state,{kind:'supervisor_decision',paperId:id,decision:paper.decisions.at(-1),scientificOutcome:paper.scientificOutcome});console.log(JSON.stringify({paperId:id,phase:paper.phase,scientificOutcome:paper.scientificOutcome}));
 }else if(command==='render'){
  renderStatus(state);console.log(JSON.stringify({path:path.join(base,'STATUS.md'),revision:state.revision}));
 }else if(command==='status'){
  const phases={};for(const p of state.papers)phases[p.phase]=(phases[p.phase]??0)+1;console.log(JSON.stringify({campaignId:state.campaignId,revision:state.revision,phases,contracts:state.papers.filter(p=>p.contract).length,candidates:state.papers.filter(p=>p.candidate).length,reviews:state.papers.filter(p=>p.review).length,accepted:state.papers.filter(p=>p.acceptance).length,total:state.papers.length}));
 }else throw Error('Commands: init | prepare <id> | prepare-repair <id> <public-request.json> | owner <id> <actual-agent-id> | worker-update <id> <text> | observe-contract <id> | intake <id> | review-owner <id> <actual-agent-id> | receive-review <id> | decide <id> | render | status');
}
