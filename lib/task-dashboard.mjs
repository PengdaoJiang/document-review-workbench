import fs from 'node:fs';
import path from 'node:path';
import {readJSON,now,hashFile,hashObject} from './io.mjs';
import {maintenancePaused} from './cli-pool-settings.mjs';

const actions={input:'读取当前任务',ack:'确认收取',discover:'保存发现',report:'提交发现',coverage:'保存阅读覆盖','math-inventory':'保存数学覆盖','math-open':'领取数学核查',encoding:'登记工具编码',tool:'等待或执行数学工具',finish:'保存数学结论',recheck:'提交局部复核','worker-finish':'提交交付回执','worker-gap':'登记技术问题',render:'生成原文裁图',freeze:'冻结候选版本',disposition:'登记原文处置',patch:'执行有界修改',build:'本地编译与对照',return:'提交修改回传','apply-decision':'应用已保存批复','technical-gap':'登记技术问题'};
const phases={starting:'正在启动',working:'CLI 正在处理任务',tool_running:'CLI 正在调用工具',turn_finished:'CLI 回合结束 · 待交付核验',failed:'CLI 报告运行失败'};
const kinds={review:'整篇 TeX 盲审',math_supplement:'整篇数学覆盖补查',math_followup:'本篇数学接续',reviewer_math:'已交接的数学核查',recheck:'局部返修复核',delivery_recovery:'原提案送达恢复'};
const codes={HUMAN_LINEAGE_ADMISSION_BLOCKED:'历史片段关联待修复；已拦截重复原文任务',USER_MAINTENANCE_PAUSE:'维护暂停；保留检查点，等待明确恢复',DELIVERY_MISSING:'进程已退出，缺少可核实的交付回执',DELIVERY_EVIDENCE_INVALID:'交付与实际业务回执不匹配',SUPERVISOR_EXIT_UNKNOWN:'控制进程退出状态未确认，须核对后重试',BLIND_DELIVERY_UNKNOWN:'请求送达未知，先核对原回执',CLI_CHANGED:'已登记 CLI 路径或程序校验不符',WORKER_AUTH_REQUIRED:'现有 CLI 登录待核实',BLIND_SESSION_REJECTED:'盲审会话未通过登记验证'};
const ident=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(x)?x:null;
const stamp=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))?x:null;
const title=x=>typeof x==='string'&&!/(?:[A-Z]:[\\/]|Bearer\s|sk-[A-Za-z0-9]|capability|password|<system|reasoning|api[_ -]?key)/i.test(x)?x.slice(0,240):'已登记论文';
function progress(t){if(!t?.runRoot)return null;const p=path.join(t.runRoot,'progress.json');try{return fs.existsSync(p)?readJSON(p):null;}catch{return null;}}
function latestSourceAction(t){const root=t?.runRoot?path.join(t.runRoot,'operations'):null;if(!root||!fs.existsSync(root))return null;const ops=fs.readdirSync(root).map(k=>path.join(root,k,'operation.json')).filter(f=>fs.existsSync(f)).map(f=>{try{return readJSON(f);}catch{return null;}}).filter(Boolean).sort((a,b)=>(b.acceptedAt||b.at||'').localeCompare(a.acceptedAt||a.at||''));return ops[0];}
function recordedSourceDelivery(a,t){try{const file=path.join(t.runRoot,'delivery.json'),d=readJSON(file),op=readJSON(d.operation.path);return d.assignmentId===a.id&&d.attemptId===t.id&&d.result?.status!=='technical_gap'&&d.result?.paperApproval===false&&op.status==='accepted'&&op.action==='finish'&&hashFile(d.operation.path)===d.operation.sha256&&hashObject(op.result)===hashObject(d.result);}catch{return false;}}
function row(pool,a,t,context,history=false){
 const paused=context.paused,p=progress(t),source=pool==='source';let op=null;
 if(source&&t?.runRoot){if(!context.sourceActions.has(t.runRoot))context.sourceActions.set(t.runRoot,latestSourceAction(t));op=context.sourceActions.get(t.runRoot);}
 const status=history?'exited':a.status,request=!source&&!history?context.mathRequests.find(r=>r.assignmentId===a.id&&r.attemptId===t?.id):null;
 const userPause=!history&&(a.problemCode||a.delivery?.code)==='USER_MAINTENANCE_PAUSE';
 let category=userPause?'waiting':['launching','running'].includes(status)?'running':status==='pending'?(paused?'waiting':'queued'):['delivered','exited','human_handoff'].includes(status)?'exited':'blocked';
 let phase=history?'进程已退出':status==='human_handoff'?'局部任务已转交人工裁决':status==='delivered'?'业务交付已核实':userPause?'暂停检查点已保存':category==='blocked'?'技术问题待处理':paused&&category!=='running'?'维护暂停':status==='pending'?'等待执行名额':phases[p?.phase]||'等待进程登记';
 if(!history&&category==='running'&&request){phase=request.status==='queued'?'等待 Wolfram 独占登记':request.status==='running'?'Wolfram 串行计算中':'数学请求恢复待核实';if(request.status==='queued')category='waiting';}
 let actualExit=null;const exitPath=t?.runRoot?path.join(t.runRoot,'supervisor-exit.json'):null;if(exitPath&&fs.existsSync(exitPath))try{const e=readJSON(exitPath);if(e.released)actualExit=e.at;}catch{}
 const startedAt=stamp(t?.startedAt),exitedAt=stamp(t?.exitedAt)||stamp(actualExit),lastActivityAt=[stamp(a.lastActivityAt),stamp(op?.acceptedAt||op?.at),stamp(p?.lastActivityAt),stamp(a.updatedAt),startedAt].filter(Boolean).sort((x,y)=>Date.parse(y)-Date.parse(x))[0]||null;
 const code=ident(history?t?.problemCode:(a.problemCode||a.delivery?.code)),reason=paused&&category!=='running'&&category!=='exited'?codes.USER_MAINTENANCE_PAUSE:codes[code]|| (category==='blocked'?'有已保存的技术缺口；核对原回执后接续':null);
 const action=op?.action||a.lastAction,lastAction=source&&action==='finish'?'提交原文任务交付':actions[action]||'等待下一项可观察动作';
 return {pool,paperId:ident(a.paperId),title:title(context.store.config.papers[a.paperId]?.title||a.paperId),assignmentId:ident(a.id),attemptId:ident(t?.id),model:source?'gpt-6-luna':'gpt-6-astra',effort:'max',kind:source?'原文核对 / 有界返修':kinds[a.kind]||'已登记盲审任务',category,phase,lastAction,startedAt,exitedAt,lastActivityAt,elapsedSeconds:startedAt?Math.max(0,Math.floor(((exitedAt?Date.parse(exitedAt):Date.now())-Date.parse(startedAt))/1000)):null,reason,problemCode:code,reportId:ident(a.reportId),requestId:ident(a.requestId),parentAssignmentIds:(a.origins||[]).map(x=>ident(x.id)).filter(Boolean),deliveryVerified:history?t?.deliveryVerified===true:a.status==='delivered',paperSignoff:false,resultUrl:'/api/tasks/'+pool+'/'+ident(a.id)+'/receipt',exitCode:Number.isInteger(t?.exitCode)?t.exitCode:null};
}
export function taskDashboard({store,sources,blindExecutors,math,pools,blind}){
 const context={store,sources,blindExecutors,math,pools,blind,paused:maintenancePaused(store.root),sourceActions:new Map(),mathRequests:(math?.requests?.all?.()||[]).filter(r=>['queued','running','recovery_required'].includes(r.status))},current=[],history=[];
 for(const [pool,executor] of [['source',sources],['blind',blindExecutors]])for(const a of executor?.assignments?.()||[]){
  const last=a.attempts?.at(-1);current.push(row(pool,a,last,context));
  for(const t of a.attempts||[]){let exit=null;const f=t.runRoot?path.join(t.runRoot,'supervisor-exit.json'):null;if(f&&fs.existsSync(f))try{exit=readJSON(f);}catch{}
   if(t.exitedAt||exit?.released){const verified=t.deliveryVerified??(pool==='source'&&recordedSourceDelivery(a,t));history.push(row(pool,a,{...t,deliveryVerified:verified===true,exitedAt:t.exitedAt||exit.at,exitCode:exit?.processExit?.exitCode??t.exitCode},context,true));}
  }
 }
 const settings=pools.read(),summary={};for(const pool of ['source','blind']){const rows=current.filter(x=>x.pool===pool);summary[pool]={limit:settings[pool],running:rows.filter(x=>x.category==='running').length,queued:rows.filter(x=>x.category==='queued').length,waiting:rows.filter(x=>x.category==='waiting').length,blocked:rows.filter(x=>x.category==='blocked').length,delivered:rows.filter(x=>x.deliveryVerified).length,activeProcesses:rows.filter(x=>['running','waiting'].includes(x.category)&&x.attemptId&&!x.exitedAt).length};}
 return {at:now(),maintenance:{paused:context.paused,automaticResume:false},settings,summary,tasks:current,history:history.sort((a,b)=>(b.exitedAt||'').localeCompare(a.exitedAt||'')).slice(0,100),boundaries:{wholeDiskReadIsolation:false,blindWritableSandbox:'workspace-write',math:'single_registered_wolfram_owner',exitIsSignoff:false}};
}
