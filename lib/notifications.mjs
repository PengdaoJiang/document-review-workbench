import fs from 'node:fs';
import path from 'node:path';
import {DesktopMcp} from './desktop-mcp.mjs';
import {readJSON,writeJSON,check,id,now,hashObject,hashFile} from './io.mjs';
import {fifo} from './dispatch-order.mjs';
import {ownerRouting} from './owner-routing.mjs';

export const PROTOCOL='review-desk-v2';
const terminal=new Set(['owner_received','blocked','cancelled']);
export class NotificationQueue {
  constructor(store,settings,{adapterFactory,auto=true}={}){
    this.store=store;this.settings=settings;this.root=path.join(store.root,'notifications');
    fs.mkdirSync(this.root,{recursive:true});fs.mkdirSync(path.join(store.root,'connections'),{recursive:true});
    this.enabled=!!settings?.enabled&&settings.dataRoots.some(x=>path.resolve(x)===path.resolve(store.root));
    this.adapterFactory=adapterFactory||(()=>new DesktopMcp(settings));this.auto=auto;this.busy=false;this.stopped=false;this.lastError=null;
    for(const j of this.jobs())if(j.status==='sending'){j.status='delivery_unknown';j.problem='Service restarted before notification acknowledgement; reconcile the existing thread before any retry.';this.save(j);}
  }
  jobs(){return fs.readdirSync(this.root).filter(x=>x.endsWith('.json')).map(x=>readJSON(path.join(this.root,x))).sort(fifo);}
  job(key){return readJSON(path.join(this.root,id(key)+'.json'));}
  connection(paperId){const f=path.join(this.store.root,'connections',id(paperId)+'.json');return fs.existsSync(f)?readJSON(f):null;}
  additionalPaperIds(){return this.sources?.production?.settings?.additionalReview?.paperIds||[];}
  enrolled(paperId){return !!this.store.config.papers[paperId]?.enrollment||this.additionalPaperIds().includes(paperId);}
  assertOwner(paperId){
    check(this.enabled,'Desktop notifications are not enabled for this pool',503,'WAKE_NOT_CONNECTED');
    const p=this.store.config.papers[paperId];
    if(this.enrolled(paperId)){
      const sources=this.sources,production=sources?.production;
      check(!this.store.fixture&&sources?.enabled&&production?.enabled&&production.store===this.store&&this.additionalPaperIds().includes(paperId),'Additional paper requires its production CLI enrollment',403,'ENROLLMENT_ROUTE_REQUIRED');
      check(production.owner(paperId)===p,'Enrolled notification owner differs',409,'OWNER_CHANGED');sources.authority();
      const state=sources.registry.read(paperId);
      check(state.mode==='cli'&&state.enrollment?.authority?.sha256===p.enrollment.authoritySha256&&path.resolve(state.enrollment.writeRoot)===path.resolve(p.root),'Additional paper source handoff is absent or changed',409,'HANDOFF_REQUIRED');
      return p;
    }
    check(p&&this.settings.paperIds.includes(paperId),'Paper not admitted for Desktop integration',403);
    const authorization=readJSON(this.settings.authorizationPath);check(hashFile(this.settings.authorizationPath)===this.settings.authorizationSha256,'Notification authorization record changed',409);
    const current=readJSON(this.store.config.batchPath).papers.find(x=>x.paperId===paperId);
    check(current?.threadId===p.owner&&authorization.owners[paperId]===p.owner,'Current batch owner differs from authorized owner',409,'OWNER_CHANGED');
    return p;
  }
  syncCase(j){if(j.requestId){const s=this.store.state(j.requestId);if(s.decision?.id===j.decisionId){const notification={status:j.status,id:j.id,owner:j.owner,decisionId:j.decisionId,sentAt:j.sentAt||null,ownerReceivedAt:j.ownerReceivedAt||null,problem:j.problem||null,...(j.sourceAssignmentId?{executionMode:'fresh_cli',sourceAssignmentId:j.sourceAssignmentId}:{})};if(JSON.stringify(s.notification)!==JSON.stringify(notification)){s.notification=notification;this.store.save(j.requestId,s);}}}}
  save(j){j.updatedAt=now();writeJSON(path.join(this.root,j.id+'.json'),j);this.syncCase(j);return j;}
  create(paperId,kind,details={}){
    const p=this.assertOwner(paperId),identity={protocol:PROTOCOL,kind,paperId,owner:p.owner,requestId:details.requestId||null,decisionId:details.decisionId||null};
    // Preserve already-created jobs when upgrading the pool-qualified key.
    const existing=this.jobs().find(j=>Object.entries(identity).every(([k,v])=>(j[k]??null)===v));if(existing)return existing;
    const key=hashObject({...identity,pool:path.resolve(this.store.root)});
    const f=path.join(this.root,key+'.json');if(fs.existsSync(f))return this.job(key);
    const j={schemaVersion:1,id:key,protocol:PROTOCOL,kind,paperId,owner:p.owner,pool:path.resolve(this.store.root),status:'queued',createdAt:now(),attempts:0,reconciliations:0,events:[],...details};
    this.save(j);this.kick();return j;
  }
  enroll(paperId){return this.create(paperId,'connect');}
  attachBlind(blind,authorization){this.blind=blind;this.blindAuthorization=authorization;}
  assertReworkAuthority(){const a=this.blindAuthorization;check(a&&hashFile(a.path)===a.sha256,'Rework authorization unavailable',403);const proof=readJSON(a.path);check((['00000000-0000-4000-8000-1aaa9e19ce08','00000000-0000-4000-8000-7a30c323dfbc'].includes(proof.userMessageId)&&proof.permissions?.b16BoundedOwnerRework)||(proof.userMessageId==='00000000-0000-4000-8000-35f1471d1a5b'&&proof.permissions?.currentB16OwnerFreezeLocateReworkMessages),'Bounded B16 rework authority required',403);return proof;}
  admittedRework(r){
    if(this.enrolled(r.paperId)){this.assertOwner(r.paperId);return true;}
    const proof=this.assertReworkAuthority();if(!this.store.fixture)return true;
    const p=proof.fixtureReworkPilot,c=this.store.config;
    if(!p)return false;
    check(p.paperId===r.paperId&&p.owner===c.papers[r.paperId]?.owner&&path.resolve(p.dataRoot)===path.resolve(this.store.root)&&path.resolve(p.paperRoot)===path.resolve(c.papers[r.paperId].root)&&c.fixtureReworkOwner===p.owner,'Fixture rework scope differs from the sealed human authorization',403);
    check(r.attempts<=p.maxAttempts&&this.blind.all('reports').filter(x=>x.lane==='completion'&&x.paperId===p.paperId&&x.status!=='duplicate').length<=p.maxReports,'Bounded fixture pilot limit reached',403);return true;
  }
  enqueueRework(key){
    if(!this.enabled||!this.blind)return null;const r=this.blind.report(key);if(r.status!=='owner_rework'||r.receivedAt)return null;if(!this.admittedRework(r))return null;
    const existing=this.jobs().find(j=>j.kind==='rework'&&j.reworkId===r.id&&j.reworkAttempt===r.attempts);if(existing)return existing;
    const p=this.assertOwner(r.paperId),keyId=hashObject({protocol:PROTOCOL,kind:'rework',paperId:r.paperId,owner:p.owner,reworkId:r.id,reworkAttempt:r.attempts,pool:path.resolve(this.store.root)});
    const j={schemaVersion:1,id:keyId,protocol:PROTOCOL,kind:'rework',paperId:r.paperId,owner:p.owner,pool:path.resolve(this.store.root),status:'queued',createdAt:now(),attempts:0,reconciliations:0,events:[],reworkId:r.id,reworkAttempt:r.attempts};this.save(j);this.kick();return j;
  }
  acknowledgeRework(key){const r=this.blind.report(key),j=this.jobs().find(j=>j.kind==='rework'&&j.reworkId===key&&j.reworkAttempt===r.attempts);if(j)this.ack(j.id);}
  enqueueDecision(key){
    if(!this.enabled)return null;const r=this.store.request(key),s=this.store.state(key);
    if(!s.decision||s.supersededBy||s.ownerReceivedAt)return null;
    if(['blind_source_fidelity','owner_transcription_uncertainty'].includes(r.spec.category)&&s.decision.action==='accept')return null;
    check(r.fixture===this.store.fixture,'Notification pool mismatch',403);
    if(r.fixture)check(this.settings.fixturePilot?.paperId===r.spec.paperId&&this.settings.fixturePilot?.dataRoot===path.resolve(this.store.root),'Fixture is not the admitted owner pilot',403);
    else check(s.decision.by==='local_user','Only a saved human decision may notify production owners',403);
    const job=this.create(r.spec.paperId,'decision',{requestId:key,decisionId:s.decision.id,fixture:r.fixture});
    if(!this.connection(r.spec.paperId)&&!this.sources?.migrated(r.spec.paperId))this.enroll(r.spec.paperId);return job;
  }
  recover(){if(!this.enabled)return;for(const j of this.jobs())this.syncCase(j);for(const x of this.store.list()){try{this.enqueueDecision(x.id);}catch(e){const s=this.store.state(x.id);s.notification={status:'blocked',problem:e.message};this.store.save(x.id,s);}}if(this.blind)for(const r of this.blind.all('reports'))if(r.status==='owner_rework')try{this.enqueueRework(r.id);}catch(e){this.lastError=e.message;}this.kick();}
  connectOwner(paperId,owner,notificationId){
    const p=this.assertOwner(paperId),j=this.job(notificationId);check(j.kind==='connect'&&j.paperId===paperId&&j.owner===owner&&p.owner===owner,'Connection acknowledgement differs',403);
    check(['sending','sent','delivery_unknown','owner_received'].includes(j.status),'Connection notification was not dispatched',409);
    let c=this.connection(paperId);if(!c||c.owner!==owner){c={protocol:PROTOCOL,paperId,owner,connectedAt:now(),notificationId:j.id};writeJSON(path.join(this.store.root,'connections',paperId+'.json'),c);}
    this.ack(j.id);return c;
  }
  ack(key){const j=this.job(key);if(j.status!=='owner_received'){j.ownerReceivedAt=now();j.status='owner_received';delete j.problem;j.events.push({at:now(),type:'owner_received'});this.save(j);}this.kick();return j;}
  acknowledgeDecision(key,decisionId){const j=this.jobs().find(x=>x.requestId===key&&x.decisionId===decisionId);if(j)this.ack(j.id);}
  requestReconciliation(key){const j=this.job(key);this.assertOwner(j.paperId);check(j.status==='delivery_unknown','Only an unknown delivery needs reconciliation',409);j.reconciliations=0;j.nextAttemptAt=0;j.events.push({at:now(),type:'reconciliation_requested'});this.save(j);this.kick();return j;}
  prompt(j){
    if(j.kind==='rework'){
      const proof=this.assertReworkAuthority();const r=this.blind.report(j.reworkId);check(this.admittedRework(r),'Fixture is not admitted',403);const client=path.join(this.store.config.root,'blind.mjs').replaceAll('\\','/'),options=`--paper=${j.paperId} --data="${this.store.root.replaceAll('\\','/')}" --config="${this.settings.poolConfigs[path.resolve(this.store.root)]}" --checkpoint`+(this.store.fixture?' --mode=fixture':'');
      if(this.store.fixture)return `[REVIEW-DESK ${j.id}]\n明确隔离的真实原 owner 返工联调，绝非生产重建或人类论文审批。用户在统筹聊天 ${proof.sourceThreadId} 的消息 ${proof.userMessageId} 原话“${proof.userQuote}”；你可以用 read_thread 核验。授权封印：${this.blindAuthorization.path}。你仍是 ${j.paperId} 唯一原重建 owner，保持当前模型设置，在安全检查点处理。\n唯一可写论文根：${proof.fixtureReworkPilot.paperRoot}；唯一数据根：${proof.fixtureReworkPilot.dataRoot}。生产论文、原文、批准库和原有决定不可写。此轮只修明确植入的测试 TODO，不纠正科学。\n先运行 node "${client}" receive ${options} --id=${r.id} --out="${proof.fixtureReworkPilot.paperRoot}/work/rework-received.json"。若回执表明已回传或已关闭，直接报告已有结果，勿重复改文。\n冻结版本 ${r.bundleId}，局部 ${r.semanticId}。问题：${r.question}\n精确片段：${r.quote}\n关闭要求：${r.closure}\n请自己查看配置中的封印原文及该段可读裁图，修复上述隔离副本。可读取 ${this.settings.poolConfigs[path.resolve(this.store.root)]} 及同目录 freeze.json 作为定位模板；不得从旧 fixture 的答案复制替代原文检查。保留同一 semanticId，更新 oldText/oldSha256/before/after 并记录准确 locator 和 reviewedBy=${j.owner}，将新 spec 和过程记录放在本隔离副本 work 下。\n运行 node "${client}" return ${options} --id=${r.id} --node=${r.semanticId} --spec="<隔离副本中新 spec 的绝对路径>" --out="${proof.fixtureReworkPilot.paperRoot}/work/rework-returned.json"。命令实际本地编译并生成版本绑定的原文/候选对照，请查看生成裁图核验后在自己的聊天报告路径和哈希。独立复核由平台另行派发；你的回传不批准论文。\n不使用内置 LaTeX 编译，不处理其他旧任务，不联系其他聊天，不轮询空队列。`;
      return `[REVIEW-DESK ${j.id}]\n完工性监督返工通知。用户本轮授权记录 ${this.blindAuthorization.path}，用户原话“${proof.userQuote}”。你仍是 ${j.paperId} 唯一原重建 owner；保持当前模型设置，在安全检查点处理。\nnode "${client}" receive ${options} --id=${r.id}\n\n冻结版本 ${r.bundleId}，局部 ${r.semanticId}。工程问题：${r.question}\n工程筛查依据：${r.screening?.reason||'明确施工问题，仍须原文核对'}\n精确片段：${r.quote}\n所需闭环：${r.closure}\n\n只核对这一施工问题和必要上下文；必须自己查看原文后改自己的 canonical TeX。盲审报告不是转写真值，也不允许科学纠错。保存新的局部定位 spec（旧有 nodes 格式，准确 oldText/oldSha256/before/after、同一 semanticId、owner 核对的原文 locator），随后运行 node "${client}" return ${options} --id=${r.id} --node=${r.semanticId} --spec="<你的修订定位文件>"。该命令冻结新版本、实际本地编译并生成局部原文对照；确认未完工的施工修补才回盲审做声明范围的局部完工复核；单纯已证转写修正按已指定路线记录。不得因同一科学疑问再次返修。${ownerRouting(this.store.config.root,j.paperId,r.id)}不要改批准库，不使用内置 LaTeX 编译，不联系其他聊天。`;
    }
    const c=this.store.config,worker=path.join(c.root,'worker.mjs').replaceAll('\\','/');
    const options=`--paper=${j.paperId} --data="${this.store.root.replaceAll('\\','/')}" --config="${this.settings.poolConfigs[path.resolve(this.store.root)]}"`+(this.store.fixture?' --mode=fixture':'');
    const action=j.kind==='connect'?`node "${worker}" connect ${options} --notification=${j.id}`:`node "${worker}" process ${options} --id=${j.requestId} --decision=${j.decisionId} --checkpoint`;
    return `[REVIEW-DESK ${j.id}]\n本机论文批复台事件通知，协议 ${PROTOCOL}。授权记录：${this.settings.authorizationPath}（用户在统筹聊天原话“好，让他补齐”；范围仅当前 B16 既有 owner 和局部批复链路）。你仍是 ${j.paperId} 唯一 owner，不变更模型或推理设置。\n\n${j.kind==='connect'?'本次仅接入确认，不重建、不改变论文内容，也不创建疑单。':j.fixture?'这是明确隔离的 fixture 联调，测试决定只可作用于配置中的 review_desk 隔离副本，绝不是生产审批。':'网页已保存此局部的人类决定。核验 requestId/decisionId 和原文、输入版本后处理；退回决定只收取，不应用。'}\n请在当前工作安全检查点运行：\n${action}\n\n命令按唯一目标校验、锁与事务日志应用并用实际本地编译器回传。目标变更或不唯一时保留决定并报冲突，不模糊替换。重复通知先看同一决定的持久回执，不能重复应用。只处理上述决定/接入，不处理其他旧任务、不进行整篇重做、不改变已批准库、不使用内置 LaTeX 编译。结束时在本聊天回复收取/结果即可，不向其他聊天发消息、不循环轮询空池。整篇内容和对照件仍需按项目流程复核，此通知不批准整篇。`;
  }
  async adapter(){if(!this.client||this.client.closed){this.client?.close();this.client=this.adapterFactory();try{await this.client.connect();}catch(e){this.client.close();this.client=null;throw e;}
      if(this.client.child)writeJSON(path.join(this.store.root,'desktop-runtime.json'),{pid:this.client.child.pid,servicePid:process.pid,startedAt:now(),serverPath:this.settings.serverPath,callerThreadId:this.settings.callerThreadId});
    }return this.client;}
  async reconcile(j,client){
    let cursor;let found=false;
    for(let page=0;page<3;page++){
      const v=await client.call('read_thread',{threadId:j.owner,turnLimit:10,includeOutputs:false,maxOutputCharsPerItem:18000,...(cursor?{cursor}:{})});
      found=v.turns?.some(t=>t.items?.some(item=>{if(item.type!=='userMessage')return false;const text=Array.isArray(item.content)?item.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'):String(item.content||'');return text.includes('[REVIEW-DESK '+j.id+']')&&text.includes('--data="'+this.store.root.replaceAll('\\','/')+'"');}));
      if(found||!v.page?.hasMore)break;cursor=v.page.nextCursor;
    }
    j=this.job(j.id);if(j.status==='owner_received')return;
    j.reconciliations++;if(found){j.status='sent';j.sentAt=j.sentAt||now();delete j.problem;j.events.push({at:now(),type:'sent_reconciled'});}
    else{j.status='delivery_unknown';j.problem='No delivery acknowledgement or matching visible thread message was found. No blind resend; inspect this notification before resolving.';j.nextAttemptAt=Date.now()+60000;}
    this.save(j);
  }
  async step(j){
    try{
      const paper=this.assertOwner(j.paperId);check(paper.owner===j.owner,'Notification owner changed',409,'OWNER_CHANGED');
      if(this.sources?.managed(j.paperId)&&await this.sources.route('notification',j))return;
      check(!this.enrolled(j.paperId),'Enrolled paper cannot fall back to its historical owner chat',409,'ENROLLMENT_ROUTE_REQUIRED');
      if(j.kind==='rework'){this.assertReworkAuthority();const r=this.blind.report(j.reworkId);if(r.receivedAt&&r.attempts===j.reworkAttempt){this.ack(j.id);return;}if(r.status!=='owner_rework'||r.attempts!==j.reworkAttempt){j.status='cancelled';this.save(j);return;}check(this.admittedRework(r),'Fixture not admitted',403);}
      if(j.kind==='decision'){
        const s=this.store.state(j.requestId);if(s.supersededBy){j.status='cancelled';j.problem='Request superseded before notification';this.save(j);return;}
        if(s.ownerReceivedAt){this.ack(j.id);return;}
        if(!this.connection(j.paperId)){j.status='waiting_connection';j.nextAttemptAt=Date.now()+10000;this.save(j);return;}
      }
      const client=await this.adapter();
      if(j.status==='delivery_unknown'){await this.reconcile(j,client);return;}
      const v=await client.call('wait_threads',{targets:[{threadId:j.owner}],timeoutMs:0});
      const t=v.polls?.find(x=>x.thread?.id===j.owner);check(t,'Desktop did not return this owner status',503,'OWNER_STATUS_UNKNOWN');
      if(!['idle','notLoaded'].includes(t.thread.status?.type)||t.latestTurn?.status==='inProgress'){
        if(j.status!=='waiting_owner')j.events.push({at:now(),type:'waiting_owner',ownerStatus:t.thread.status});
        j.status='waiting_owner';j.nextAttemptAt=Date.now()+15000;j.lastOwnerStatus=t.thread.status;this.save(j);return;
      }
      j.status='sending';j.attempts++;j.dispatchStartedAt=now();j.dispatchOwnerStatus=t.thread.status;j.events.push({at:now(),type:'sending',ownerStatus:t.thread.status});delete j.problem;this.save(j);
      // No model/thinking override; the existing Desktop task remains the execution owner.
      const receipt=await client.call('send_message_to_thread',{threadId:j.owner,prompt:this.prompt(j)},{callId:'review-desk-'+j.id});
      check(receipt.threadId===j.owner,'Desktop receipt names a different owner',502);
      j=this.job(j.id);j.sentAt=j.sentAt||now();j.transportReceipt=receipt;if(j.status!=='owner_received')j.status='sent';j.events.push({at:now(),type:'sent'});delete j.problem;this.save(j);this.lastError=null;
    }catch(error){
      j=this.job(j.id);if(j.status==='owner_received')return;
      if(j.status==='sending')j.status='delivery_unknown';else if(['OWNER_CHANGED','TRANSPORT_CHANGED'].includes(error.code)||error.status===403)j.status='blocked';else if(j.status!=='delivery_unknown')j.status='retry_wait';
      j.problem=error.message;j.nextAttemptAt=Date.now()+30000;j.events.push({at:now(),type:j.status,message:error.message});this.save(j);this.lastError=error.message;
    }
  }
  async drain(){if(!this.enabled||this.busy||this.stopped)return;await this.sources?.production?.blindExecutors?.math?.registrationWindow?.wait();if(this.busy||this.stopped)return;this.busy=true;
    try{for(const j of this.jobs())if(!terminal.has(j.status)&&!['sent','source_pending'].includes(j.status)&&!(j.status==='delivery_unknown'&&j.reconciliations>=3)&&(!j.nextAttemptAt||j.nextAttemptAt<=Date.now())){await this.sources?.production?.blindExecutors?.math?.registrationWindow?.wait();if(this.stopped)break;await this.step(j);}}
    finally{this.busy=false;if(this.jobs().some(j=>!terminal.has(j.status)&&!['sent','source_pending'].includes(j.status)&&!(j.status==='delivery_unknown'&&j.reconciliations>=3)))this.kick(10000);}
  }
  kick(delay=25){if(!this.enabled||!this.auto||this.stopped)return;clearTimeout(this.timer);this.timer=setTimeout(()=>this.drain().catch(e=>{this.lastError=e.message;}),delay);this.timer.unref();}
  summary(){const admitted=this.enabled?[...new Set([...this.settings.paperIds,...this.additionalPaperIds()])].filter(p=>{if(!this.store.config.papers[p])return false;if(!this.enrolled(p))return true;try{this.assertOwner(p);return true;}catch{return false;}}):[];return {status:this.enabled?(this.lastError?'transport_error':'enabled'):'not_connected',automatic:this.enabled,protocol:PROTOCOL,connected:admitted.filter(p=>this.connection(p)?.owner===this.store.config.papers[p].owner).length,admitted:admitted.length,problem:this.lastError,...(this.sources?.enabled?{executionMode:'fresh_cli',migrated:admitted.filter(p=>this.sources.migrated(p)).length}:{})};}
  stop(){this.stopped=true;clearTimeout(this.timer);this.client?.close();const f=path.join(this.store.root,'desktop-runtime.json');if(fs.existsSync(f)){const r=readJSON(f);if(r.servicePid===process.pid)writeJSON(f,{...r,stoppedAt:now()});}}
}
