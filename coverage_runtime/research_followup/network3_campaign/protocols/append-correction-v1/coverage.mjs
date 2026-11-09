// Narrow append-only original-actor intake. The scientific supervisor alone
// may invoke the writer; check and verify never mutate the ledger.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {canonical,hash,fileRef,checkRef} from '../../coverage-core.mjs';
import {safeWithin} from '../../coverage-context.mjs';
import {guardAdmissionReferences,guardReviewInstructions,guardSummary} from '../../coverage-guard.mjs';
import {writeOnceOrMatch} from '../../repair-flow.mjs';
import {runCoverage as runLegacyCoverage} from '../../coverage.mjs';
import {prepareAppendCorrection} from './append-core.mjs';

const base='research_followup/network3_campaign';
const insist=(ok,message)=>{if(!ok)throw Error('Append intake: '+message);};
const same=(a,b)=>canonical(a)===canonical(b);
const key=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
const suffix=revision=>'c'+String(revision).padStart(3,'0');
const rel=(root,filename)=>path.relative(root,filename).split(path.sep).join('/');
const read=filename=>JSON.parse(fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,''));
function bound(root,reference){const bytes=fs.readFileSync(checkRef(root,reference));insist(hash(bytes)===reference.sha256,'Actual bound JSON bytes changed');const text=bytes.toString('utf8');insist(Buffer.from(text,'utf8').equals(bytes),'Bound JSON is not UTF-8');return JSON.parse(text.replace(/^\uFEFF/,''));}
function sameRef(root,a,b){return a&&b&&key(path.resolve(root,a.path))===key(path.resolve(root,b.path))&&a.sha256===b.sha256;}
function unique(root,references){const paths=new Map();for(const ref of references){const name=key(path.resolve(root,ref.path)),old=paths.get(name);insist(!old||old.sha256===ref.sha256,'Conflicting identity for one referenced path');if(!old)paths.set(name,ref);}return [...paths.values()];}
function reference(root,name,bytes){return {path:safeWithin(root,name),sha256:hash(bytes)};}
function preflight(outputs){for(const output of outputs){if(fs.existsSync(output.ref.path)){insist(fs.lstatSync(output.ref.path).isFile()&&!fs.lstatSync(output.ref.path).isSymbolicLink(),'Output is not a regular immutable file');insist(fs.readFileSync(output.ref.path).equals(Buffer.from(output.bytes)),'Conflicting immutable output: '+output.ref.path);}}}
function registration(state,paper){return {state:Object.fromEntries(['schemaVersion','phase','revision','authority','scope','firstPassClosure','guardPolicy'].filter(k=>Object.hasOwn(state,k)).map(k=>[k,structuredClone(state[k])])),paper:structuredClone(paper)};}
function initialState(reg){return {...structuredClone(reg.state),papers:[structuredClone(reg.paper)],operations:{}};}
function ledgerShape(state){
  insist(state?.schemaVersion===1&&Number.isSafeInteger(state.revision)&&state.revision>=0&&state.revision<Number.MAX_SAFE_INTEGER,'Invalid ledger schema or revision');
  insist(state.operations&&typeof state.operations==='object'&&!Array.isArray(state.operations),'Invalid ledger operations map');
  insist(Array.isArray(state.papers)&&state.papers.every(p=>p&&typeof p==='object'&&!Array.isArray(p)&&typeof p.paperId==='string'&&typeof p.phase==='string'),'Invalid ledger paper registration');
}
function campaignIdentity(root,state){
  const authorityPath=safeWithin(root,'docs/network3-coverage-authorization-20261024.json');
  insist(sameRef(root,state.authority,fileRef(root,authorityPath)),'Coverage authority differs from installed authority');
  const authority=bound(root,state.authority),source=bound(root,authority.scopeAuthority),ids=source.scope.paperIds;
  insist(Array.isArray(ids)&&ids.length===53&&new Set(ids).size===53&&same(state.scope,[...ids].sort()),'Fixed 53-paper ledger scope differs');
  const nodes=bound(root,source.scope.nodes),closure=bound(root,authority.firstPassClosure);
  insist(same(nodes.map(n=>n.paper_id).sort(),[...ids].sort())&&closure.status==='first_pass_complete_bounded'&&same(closure.papers.map(p=>p.paperId).sort(),[...ids].sort()),'Bound scope nodes or first-pass closure differs');
  insist(sameRef(root,state.firstPassClosure,authority.firstPassClosure),'Ledger closure reference differs');return closure;
}

function publication(root,state,paper,request,requestRef,operationId,prepared){
  const directory=base+'/coverage/'+paper.paperId+'/c001';
  const candidateBytes=canonical(prepared.candidate),scopeBytes=canonical(prepared.contract);
  const candidate=reference(root,directory+'/candidate.json',candidateBytes),contract=reference(root,directory+'/source-scope.json',scopeBytes);
  const requiredReferences=unique(root,[...prepared.references,requestRef]);
  const receiptValue={schemaVersion:1,kind:'original_actor_append_correction',paperId:paper.paperId,iteration:1,operationId,committedRevision:request.expectedRevision+1,
    request:requestRef,releaseManifest:request.releaseManifest,registration:registration(state,paper),proof:prepared.proof,requiredReferences,candidate,contract,scientificAcceptance:false};
  const receiptBytes=canonical(receiptValue),receipt=reference(root,directory+'/append-correction-receipt.json',receiptBytes);
  const reviewRoot=safeWithin(root,'research_followup/reproduction_clean/coverage_verifications/'+paper.paperId+'/c001');
  const guard={enrollment:paper.guardEnrollment,contract,contractSource:request.repaired.sourceScope,appendCorrection:receipt,references:[]};
  const staged={candidate,worker:request.agent,workOrder:paper.order,reviewRoot:rel(root,reviewRoot),guard};
  const orderBytes=reviewerOrder(root,{...paper,staged},reviewRoot)+guardReviewInstructions(paper)+'\n## Append-only correction provenance\nThe original actor supplied a mechanically restricted duplicate-locator correction. All original drafts remain immutable. Correction receipt: '+canonical(receipt)+'. Read the frozen candidate and source-scope normally; all original independent review and scientific acceptance gates remain mandatory. This receipt is not scientific acceptance; the full reference inventory need not be loaded into model context.\n';
  const reviewOrder=reference(root,directory+'/reviewer.md',orderBytes);staged.reviewOrder=reviewOrder;
  guard.references=unique(root,[...requiredReferences,candidate,contract,receipt,reviewOrder]);
  const outputs=[{ref:candidate,bytes:candidateBytes},{ref:contract,bytes:scopeBytes},{ref:receipt,bytes:receiptBytes},{ref:reviewOrder,bytes:orderBytes}];
  return {receipt,receiptValue,staged,outputs,references:guard.references};
}

function reviewerOrder(root,paper,reviewRoot) {
  return `1. **目标**\n独立复核${paper.paperId}/${suffix(paper.iteration)}逐项覆盖候选。你不是施工者；不重跑无关已有效检查。首次独立检查全文未列区域和扫描遗漏，后续核对变化及传递影响。\n\n2. **选中输入**\n协议${path.join(root,'research_followup/network3_campaign/COVERAGE_WORKFLOW.md')}\n扫描${JSON.stringify(paper.scan)}\n候选${JSON.stringify(paper.staged.candidate)}\n首轮精确证据${JSON.stringify(paper.firstPass)}\n上次覆盖${JSON.stringify(paper.latest??null)}\nDot及必要宏/图是默认阅读；不得例行重读PDF，不读别篇或全局科学预设。旧同篇复核私有测试仅你可读，返修只给公开问题/必要条件。\n\n3. **私有可写根**\n${reviewRoot}\n只写你的新review、检查代码/输出/回执。不改候选、原文、旧证据、运行器或业务总表。工具按需并遵守资源登记。\n\n4. **交付**\nreview.json精确绑定正式冻结candidate/scan，reviewerAgent为实际登记标识。检查全部学术资源、数学单元/文本块/图片和宏遗漏；空映射数学/资产需逐个unitExclusions说明。逐义务绑定assessment哈希并给accept或needs_work及证据。完全未变且已独立接受的义务可列retainedObligationIds，但前提/依赖改变或旧检查只是partial不可继承。明确补做、内部未做和真正外部阻塞；不为缺工作制造外部阻塞。\n\n5. **验收**\n复核建议不是主管接受。只有来源清单审定、义务独立证据适当且主管逐项接受才计信用；数值符合、符号等价、一般证明和原实验复现不混同。完成后报告review路径/身份及计算终态；不从流水正常退出推出论文全核验完成。\n`;
}

async function audit(root,state,paper){
  const matches=[...(paper.history??[]),...(paper.latest?[paper.latest]:[]),...(paper.iteration===1&&paper.staged?[{...paper.staged,iteration:1}]:[])].filter(s=>s.iteration===1);
  insist(matches.length===1,'Expected exactly one retained c001 staged/frozen correction snapshot');
  const snapshot=matches[0],receiptRef=snapshot.guard?.appendCorrection;
  insist(receiptRef,'Missing required append-correction receipt');
  const receiptPath=safeWithin(root,base+'/coverage/'+paper.paperId+'/c001/append-correction-receipt.json');
  insist(key(path.resolve(root,receiptRef.path))===key(receiptPath),'Append receipt path differs from exact c001 ledger');
  const receipt=bound(root,receiptRef);
  insist(receipt.schemaVersion===1&&receipt.kind==='original_actor_append_correction'&&receipt.paperId===paper.paperId&&receipt.iteration===1&&receipt.scientificAcceptance===false,'Invalid frozen append correction receipt');
  const requestPath=safeWithin(safeWithin(root,base+'/coverage/requests'),path.resolve(root,receipt.request.path));
  insist(key(requestPath)===key(path.resolve(root,receipt.request.path)),'Receipt request path escaped scope');
  const request=bound(root,receipt.request),operationId=hash(canonical({command:'intake-append',request}));
  insist(receipt.operationId===operationId&&receipt.committedRevision===request.expectedRevision+1,'Frozen receipt operation identity differs');
  const registered=receipt.registration;
  insist(registered?.paper?.paperId===paper.paperId&&registered.paper.iteration===1&&sameRef(root,registered.state.authority,state.authority)&&sameRef(root,registered.state.guardPolicy,state.guardPolicy)&&sameRef(root,registered.paper.scan,paper.scan),'Frozen initial registration/source differs from the live campaign');
  const projected=initialState(registered),initialPaper=projected.papers[0];
  const prepared=await prepareAppendCorrection({root,state:projected,paper:initialPaper,request});
  const expected=publication(root,projected,initialPaper,request,receipt.request,operationId,prepared);
  insist(same(receipt,expected.receiptValue)&&sameRef(root,receiptRef,expected.receipt),'Correction receipt/proof/required references changed');
  insist(sameRef(root,snapshot.candidate,expected.staged.candidate)&&sameRef(root,snapshot.guard.contract,expected.staged.guard.contract)&&sameRef(root,snapshot.guard.contractSource,request.repaired.sourceScope)&&same(snapshot.guard.enrollment,initialPaper.guardEnrollment),'Snapshot lost exact candidate/scope/enrollment lineage');
  insist(Array.isArray(snapshot.guard.references),'Missing correction reference inventory');
  for(const ref of expected.references)insist(snapshot.guard.references.some(actual=>sameRef(root,actual,ref)),'Missing required append lineage reference: '+ref.path);
  for(const ref of snapshot.guard.references)checkRef(root,ref);
  for(const output of expected.outputs){checkRef(root,output.ref);insist(fs.readFileSync(output.ref.path).equals(Buffer.from(output.bytes)),'Actual frozen append output bytes differ');}
  prepared.recheck();
  return {receipt:receiptRef,requiredReferenceCount:expected.references.length,operationId};
}

export async function runCoverage(root,argv){
  root=path.resolve(root);const [command,arg]=argv;
  if(!command||command==='help')return {commands:['check <request.json>','intake-append <request.json>','verify <paperId>'],note:'Only the scientific supervisor writes. All downstream review/decide/continue commands remain on the unchanged legacy CLI. No scientific execution or acceptance is performed.'};
  insist(argv.length===2&&['check','intake-append','verify'].includes(command),'Expected check, intake-append or verify with one argument');
  const ledger=safeWithin(root,base+'/coverage'),statePath=path.join(ledger,'state.json'),state=read(statePath);ledgerShape(state);const closure=campaignIdentity(root,state);
  const lookup=id=>{const rows=state.papers.filter(p=>p.paperId===id);insist(state.scope.includes(id)&&rows.length===1,'Unknown or ambiguous paper');const paper=rows[0],first=closure.papers.find(p=>p.paperId===id);insist(!Object.hasOwn(paper,'workerHistory')||(Array.isArray(paper.workerHistory)&&paper.workerHistory.every(agent=>typeof agent==='string'&&agent.trim())),'Invalid workerHistory registration');for(const k of ['result','review','acceptance'])insist(same(paper.firstPass[k],{path:first[k].path,sha256:first[k].sha256}),'Paper first-pass baseline differs from closure');return paper;};
  if(command==='verify'){
    const paper=lookup(arg),correction=await audit(root,state,paper),legacy=await runLegacyCoverage(root,['verify',paper.paperId]);
    insist(same(read(statePath),state),'State changed during readonly verification; retry');
    return {...legacy,appendCorrection:{...correction,verified:true},note:'Mechanical correction lineage and legacy evidence verification, not scientific re-review or new approval.'};
  }
  const requestFile=safeWithin(safeWithin(root,base+'/coverage/requests'),path.resolve(root,arg)),requestRef=fileRef(root,requestFile),request=bound(root,requestRef),operationId=hash(canonical({command:'intake-append',request}));
  const paper=lookup(request.paperId);
  if(command==='check'){
    const prepared=await prepareAppendCorrection({root,state,paper,request});
    const planned=publication(root,state,paper,request,requestRef,operationId,prepared);preflight(planned.outputs);prepared.recheck();checkRef(root,requestRef);
    insist(same(read(statePath),state),'State changed during readonly check; retry');
    return {paperId:paper.paperId,iteration:1,valid:true,scientificAcceptance:false,proof:prepared.proof,requiredReferenceCount:planned.references.length};
  }
  const lockPath=path.join(ledger,'.writer.lock'),token=randomUUID();
  fs.writeFileSync(lockPath,canonical({pid:process.pid,token,startedAt:new Date().toISOString(),command}),{flag:'wx'});
  try{
    insist(same(read(statePath),state),'Coverage state changed before writer acquisition; retry with current revision');checkRef(root,requestRef);
    if(state.operations?.[operationId]){
      const op=state.operations[operationId];for(const ref of op.references??[])checkRef(root,ref);
      const verified=await audit(root,state,paper);
      insist(verified.operationId===operationId&&sameRef(root,op.response.appendCorrection,verified.receipt),'Replay operation differs from frozen append receipt');
      return {...op.response,replayed:true};
    }
    insist(request.expectedRevision===state.revision,'Stale expectedRevision');guardAdmissionReferences(root,state,null);
    const prepared=await prepareAppendCorrection({root,state,paper,request});
    const planned=publication(root,state,paper,request,requestRef,operationId,prepared);preflight(planned.outputs);
    prepared.recheck();for(const ref of planned.receiptValue.requiredReferences)checkRef(root,ref);
    for(const output of planned.outputs)writeOnceOrMatch(output.ref.path,output.bytes);
    prepared.recheck();for(const ref of planned.references)checkRef(root,ref);
    paper.staged=planned.staged;paper.workerHistory=[...new Set([...(paper.workerHistory??[]),request.agent])];paper.owner=null;paper.phase='awaiting_review';
    const references=unique(root,[...planned.references,...guardAdmissionReferences(root,state,paper)]);for(const ref of references)checkRef(root,ref);
    state.revision++;state.updatedAt=new Date().toISOString();state.phase=state.papers.every(p=>p.phase==='complete')?'coverage_complete':'coverage_active';
    const response={paperId:paper.paperId,phase:paper.phase,candidate:paper.staged.candidate,reviewOrder:paper.staged.reviewOrder,reviewRoot:paper.staged.reviewRoot,guard:guardSummary(paper.staged.guard),appendCorrection:planned.receipt,scientificAcceptance:false,revision:state.revision};
    state.operations[operationId]={response,references};
    const temporary=path.join(ledger,'.state-'+process.pid+'-'+randomUUID()+'.tmp'),fd=fs.openSync(temporary,'wx');
    try{fs.writeFileSync(fd,canonical(state));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    try{insist(same(read(temporary),state),'State readback mismatch');fs.renameSync(temporary,statePath);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    return response;
  }finally{if(fs.existsSync(lockPath)){insist(read(lockPath).token===token,'Writer ownership changed; lock retained');fs.unlinkSync(lockPath);}}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await runCoverage(process.cwd(),process.argv.slice(2)),null,2));}catch(error){console.error(error.stack??String(error));process.exitCode=1;}
}
