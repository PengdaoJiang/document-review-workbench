import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {check,id,uid,sha,hashObject,hashFile,readJSON,writeJSON,acquireLock,now} from './io.mjs';
import {run} from './process.mjs';
import {validateResearch,PROFILES,leanProgram,leanDependencies} from './research-math.mjs';
import {wolframProgram} from './wolfram-research.mjs';
import {WolframRegistry} from './wolfram-registry.mjs';
import {MathRequestQueue} from './math-request-queue.mjs';
import {registerRunner,REGISTRATION_TIMEOUT_MS,runnerTimeout,RegistrationWindow} from './runner-registration.mjs';
const loadedResearchSeal={broker:hashFile(new URL(import.meta.url)),schema:hashFile(new URL('./research-math.mjs',import.meta.url)),wolfram:hashFile(new URL('./wolfram-research.mjs',import.meta.url)),registry:hashFile(new URL('./wolfram-registry.mjs',import.meta.url)),queue:hashFile(new URL('./math-request-queue.mjs',import.meta.url)),runnerRegistration:hashFile(new URL('./runner-registration.mjs',import.meta.url))};

export async function foreignWolfram(){
  if(process.platform!=='win32')return [];
  const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name = 'wolfram.exe' OR Name = 'WolframKernel.exe' OR Name = 'MathKernel.exe' OR Name = 'math.exe' OR Name = 'wolframscript.exe'\" | Select-Object Name,ProcessId,ParentProcessId,CreationDate) | ConvertTo-Json -Compress"],{timeout:10000});
  check(r.code===0&&!r.timedOut,'Cannot establish Wolfram process ownership',503,'RESOURCE_UNKNOWN');const result=r.output.trim()?JSON.parse(r.output):[];return Array.isArray(result)?result:[result];
}
export async function prepareWolfram(settings,programRoot){
  if(settings.wolframIdleProviderCleanup===true){
    const cleanup=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(programRoot,'wolfram-provider-cleanup.ps1')],{input:JSON.stringify({program:settings.wolfram,stateRoot:settings.stateRoot,ownerPid:process.pid}),timeout:15000});
    check(cleanup.code===0&&!cleanup.timedOut,'Wolfram provider preflight failed; no kernel admitted',503,'RESOURCE_UNKNOWN');return JSON.parse(cleanup.output.replace(/^\uFEFF/,''));
  }
  return {records:[],scope:'Automatic idle-provider cleanup disabled'};
}
export function validateExpression(task){
  check(task?.operation==='compare'&&['equal','not_equal'].includes(task.claim),'Supported bounded task: exact comparison');let count=0;
  function walk(x,depth=0){check(++count<=256&&depth<=16,'Expression is too large');if(Number.isSafeInteger(x)){check(Math.abs(x)<=1_000_000_000,'Integer too large');return 32;}
    check(Array.isArray(x)&&x.length===3&&['add','sub','mul','div','pow','min'].includes(x[0]),'Unsupported expression');if(x[0]==='pow')check(Number.isInteger(x[2])&&Math.abs(x[2])<=10,'Bounded integer exponent required');const a=walk(x[1],depth+1),b=walk(x[2],depth+1),bound=x[0]==='pow'?a*Math.max(1,Math.abs(x[2])):a+b+2;check(bound<=16384,'Exact arithmetic exceeds bounded bit size');return bound;}
  walk(task.left);walk(task.right);return task;
}
const wlExpr=x=>Number.isInteger(x)?String(x):({add:'Plus',sub:'Subtract',mul:'Times',div:'Divide',pow:'Power',min:'Min'})[x[0]]+'['+wlExpr(x[1])+','+wlExpr(x[2])+']';
// Lean accepts a deliberately small integer proposition. General formalization
// is not silently translated or admitted through a free-form code endpoint.
function leanExpr(x){if(Number.isInteger(x))return '('+x+' : Int)';check(['add','sub','mul','pow'].includes(x[0]),'Lean endpoint supports integer algebra only',422,'TOOL_UNSUPPORTED');if(x[0]==='pow')check(x[2]>=0,'Natural exponent required');return '('+leanExpr(x[1])+({add:' + ',sub:' - ',mul:' * ',pow:' ^ '})[x[0]]+(x[0]==='pow'?x[2]:leanExpr(x[2]))+')';}
async function bounded(program,args,{cwd,input='',timeout=20000,onSpawn,environment={}}){
  return await new Promise(resolve=>{
    const child=spawn(program,args,{cwd,windowsHide:true,shell:false,env:{...process.env,...environment,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',LEAN_NUM_THREADS:'1'},stdio:['pipe','pipe','pipe']});onSpawn(child.pid);let output='',timedOut=false,overflow=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill();},timeout);
    for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{if(output.length+b.length>65536){overflow=true;child.kill();}else output+=b.toString('utf8');});
    child.stdin.on('error',()=>{});child.stdin.end(input);
    child.once('error',()=>{clearTimeout(timer);resolve({code:null,output:'Tool process could not start',timedOut:false});});
    child.once('close',code=>{clearTimeout(timer);resolve({code,output,timedOut,overflow});});
  });
}
export class MathBroker {
  registrationWindow=new RegistrationWindow();
  constructor(blind,settings){this.blind=blind;this.settings=settings;this.busy=false;this.active=null;this.inFlight=new Map();this.registry=new WolframRegistry(settings.stateRoot||blind.leaseRoot);this.requests=new MathRequestQueue(path.join(blind.root,'tool-requests'),{resolveCapability:key=>this.blind.read('capabilities',key),handoffFor:request=>this.humanHandoffFor(request),available:()=>!this.busy&&!this.registry.read(),execute:async request=>{this.activeRequestId=request.id;try{const cap=this.blind.read('capabilities',request.capabilityId);this.blind.assertCapability?.(cap);return await this.executeOnce(cap,request.payload);}finally{this.activeRequestId=null;}},recoverResult:request=>this.blind.all('checks').find(c=>c.requestId===request.id&&c.finishedAt&&c.executionCompleted&&hashObject(c.task)===hashObject(request.payload.task))?.public||null});}
  resources(){return {wolframRegistration:this.registry.read(),registrationPath:this.registry.file,requests:this.requests.all().map(({payload,capabilityId,...r})=>r),active:this.active,problem:this.requests.lastError||null,legacy:['review-desk-dispatch.lock','review-desk-math-owner.lock','wolfram-owner.lock','review-desk-checker-lease.json'].map(name=>{const file=path.join(this.settings.stateRoot,name);return {name,record:fs.existsSync(file)?readJSON(file):null};})};}
  humanHandoffFor(request){const h=this.blind.humanRouting;if(!h?.enabled)return null;const report=this.blind.report(request.reportId),route=h.reportRoute(report);
    const effective=['human_required','awaiting_human','human_decided','human_decided_pending_mechanical_application'].includes(route?.state)?route:h.nodeRoute(report.bundleId,report.nodeId,report.focusQuote||report.quote);
    return effective&&['human_required','awaiting_human','human_decided','human_decided_pending_mechanical_application'].includes(effective.state)?{authority:h.settings.authority,reportId:report.id,stableFragmentId:effective.stableFragmentId,state:effective.state,decisionId:effective.lock?.decisionId||null,epoch:effective.epoch||0}:null;}
  stop(){this.requests.stop();}
  recoverLock(name){
    check(['review-desk-dispatch.lock','review-desk-math-owner.lock','wolfram-owner.lock'].includes(name),'Only named cooperative locks may be recovered');check(!this.busy,'Current broker is active',409,'MATH_BUSY');const file=path.join(this.settings.stateRoot,name),record=readJSON(file);
    for(const pid of [record.pid,record.childPid].filter(Boolean)){let live=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')live=false;}check(!live,'Recorded process may still be active; no lock removed',409,'RESOURCE_BUSY');}
    // Never recover a live process or terminate an unknown process to gain room.
    const proof={id:uid(),name,record,recoveredAt:now(),method:'Confirmed recorded owner and child PIDs absent; no process terminated'};writeJSON(path.join(this.blind.root,'lock-recoveries',proof.id+'.json'),proof);fs.unlinkSync(file);return proof;
  }
  async execute(cap,body){
    this.blind.assertCapability?.(cap);
    if(body.engine==='wolfram'){check(['checker','reviewer_math'].includes(cap.role),'Mathematical role required',403,'ROLE_DENIED');const r=this.blind.report(cap.reportId);check(r.encoding&&r.encoding.sha256===body.encodingSha256&&hashObject(r.encoding.task)===hashObject(body.task),'Exact audited tool payload required',409);const prior=this.requests.existing(cap,body);if(!prior||!['completed','resource_blocked','human_handoff'].includes(prior.status))this.blind.checker(cap);return this.requests.enqueue(cap,body);}
    const request=hashObject({capabilityId:cap.id,body});if(this.inFlight.has(request))return this.inFlight.get(request);
    const work=Promise.resolve().then(()=>this.executeOnce(cap,body));this.inFlight.set(request,work);try{return await work;}finally{this.inFlight.delete(request);}
  }
  async executeOnce(cap,body){
    if(body.task?.operation==='research')return this.executeResearch(cap,body);
    const r=this.blind.checker(cap);check(r.encoding&&body.encodingSha256===r.encoding.sha256&&hashObject(body.task)===hashObject(r.encoding.task),'Audit this exact encoding first',409);validateExpression(body.task);check(['exact','lean','wolfram'].includes(body.engine),'Unknown mathematics tool');
    check(!this.busy,'One local mathematics process is active',409,'MATH_BUSY');const key=hashObject({reportId:r.id,claimId:cap.claimId,engine:body.engine,task:body.task,encodingSha256:r.encoding.sha256}).slice(0,24);
    const prior=this.blind.all('checks').find(x=>x.id===key);if(prior?.success)return prior.public;
    this.busy=true;const cfg=this.settings;let release,releaseWolfram;const root=path.join(this.blind.root,'tool-jobs',key);fs.mkdirSync(root,{recursive:true});
    const receipt={id:key,reportId:r.id,encodingSha256:r.encoding.sha256,task:body.task,taskSha256:hashObject(body.task),engine:body.engine,startedAt:now(),workers:1,timeoutMs:cfg.timeoutMs,success:false};
    try{
      release=acquireLock(path.join(cfg.stateRoot,'review-desk-math-owner.lock'));this.active=key;const lockRecord={pid:process.pid,createdAt:now(),jobId:key,jobRoot:root,childPid:null};writeJSON(path.join(cfg.stateRoot,'review-desk-math-owner.lock'),lockRecord);
      // Fail closed when a previous own child survived a broker/service crash.
      for(const old of this.blind.all('checks'))if(old.childPid&&!old.finishedAt){let live=true;try{process.kill(old.childPid,0);}catch(e){if(e.code==='ESRCH')live=false;}check(!live,'An earlier recorded mathematics child may still be active',409,'RESOURCE_BUSY');}
      if(body.engine==='wolfram')check(false,'Use the structured research adapter for registered Wolfram work',422,'TOOL_UNSUPPORTED');
      let program,args,input='';
      if(body.engine==='exact'){program=cfg.python;args=['-I',path.join(this.blind.store.config.root,'math-worker.py')];input=JSON.stringify(body.task);}
      if(body.engine==='lean'){program=cfg.lean;const text='set_option maxHeartbeats 100000\nset_option maxRecDepth 256\ntheorem checked_instance : '+leanExpr(body.task.left)+(body.task.claim==='equal'?' = ':' ≠ ')+leanExpr(body.task.right)+' := by decide\n#print axioms checked_instance\n';fs.writeFileSync(path.join(root,'Check.lean'),text);receipt.codeSha256=sha(text);args=['-j1','-M'+cfg.memoryMiB,'Check.lean'];}
      if(body.engine==='wolfram'){program=cfg.wolfram;const code='ClearAll["Global`*"]; $HistoryLength=0; $Assumptions=True; Print[InputForm[TimeConstrained[MemoryConstrained[FullSimplify['+wlExpr(body.task.left)+(body.task.claim==='equal'?'==':'!=')+wlExpr(body.task.right)+'],268435456,$Failed],10,$Aborted]]]; Quit[];';fs.writeFileSync(path.join(root,'Check.wl'),code);receipt.codeSha256=sha(code);args=[...(cfg.wolframLicenseFile?['-pwfile',cfg.wolframLicenseFile]:[]),'-noinit','-noprompt','-script','Check.wl'];}
      check(fs.existsSync(program),'Installed tool is unavailable',503,'TOOL_UNAVAILABLE');receipt.executableSha256=hashFile(program);
      const result=await bounded(program,args,{cwd:root,input,environment:body.engine==='wolfram'?cfg.wolframLicenseEnvironment:{},timeout:Math.min(cfg.timeoutMs,30000),onSpawn:pid=>{receipt.childPid=pid;writeJSON(path.join(cfg.stateRoot,'review-desk-math-owner.lock'),{...lockRecord,childPid:pid});if(releaseWolfram)writeJSON(path.join(cfg.stateRoot,'wolfram-owner.lock'),{...lockRecord,childPid:pid});this.blind.save('checks',receipt);}});
      writeJSON(path.join(root,'process.json'),result);receipt.outputSha256=hashObject(result);receipt.finishedAt=now();receipt.success=result.code===0&&!result.timedOut&&!result.overflow;
      let evidence;if(body.engine==='exact'&&receipt.success){try{evidence=JSON.parse(result.output);receipt.success=body.task.claim==='equal'?evidence.equal:!evidence.equal;}catch{receipt.success=false;}}
      if(body.engine==='lean'&&receipt.success){receipt.success=/does not depend on any axioms/.test(result.output)&&!/(sorryAx|sorry|error:)/i.test(result.output);evidence={axioms:'none',theorem:'checked_instance',claim:'this encoded integer proposition only'};}
      if(body.engine==='wolfram'&&receipt.success){const raw=result.output.trim();receipt.success=['True','"True"','InputForm[True]'].includes(raw);evidence={result:receipt.success?'True':raw,wireFormat:raw,claim:'this encoded instance only'};}
      receipt.public={id:key,engine:body.engine,success:receipt.success,task:body.task,encodingSha256:r.encoding.sha256,evidence:evidence||null,reason:receipt.success?null:result.timedOut?'bounded_timeout':'tool_did_not_validate_claim'};
    }catch(e){receipt.errorCode=e.code||'TOOL_ERROR';receipt.finishedAt=now();receipt.public={id:key,engine:body.engine,success:false,reason:receipt.errorCode};}
    finally{this.blind.save('checks',receipt);releaseWolfram?.();release?.();this.active=null;this.busy=false;}
    return receipt.public;
  }
  async executeResearch(cap,body){
    const r=this.blind.checker(cap);check(r.encoding&&body.encodingSha256===r.encoding.sha256&&hashObject(body.task)===hashObject(r.encoding.task),'Audit this exact research encoding first',409);check(!this.busy,'One local mathematics process is active',409,'MATH_BUSY');
    const key=hashObject({reportId:r.id,claimId:cap.claimId,engine:body.engine,task:body.task,encodingSha256:r.encoding.sha256,researchVersion:2,loadedResearchSeal}).slice(0,24),prior=this.blind.all('checks').find(x=>x.id===key);if(prior?.success)return prior.public;
    this.busy=true;let release,registration,releaseRegistration=()=>{};const attempt=(prior?.attempt||0)+1,root=path.join(this.blind.root,'tool-jobs',key,'attempt-'+attempt);fs.mkdirSync(root,{recursive:true});
    const receipt={id:key,attempt,previousAttempts:prior?[...(prior.previousAttempts||[]),prior]:[],requestId:this.activeRequestId||null,reportId:r.id,bundleId:r.bundleId,nodeId:r.nodeId,documentSha256:r.encoding.documentSha256,encodingSha256:r.encoding.sha256,task:body.task,taskSha256:hashObject(body.task),engine:body.engine,startedAt:now(),workers:1,success:false};
    try{
      validateResearch(body.task);check(['sympy','lean','wolfram'].includes(body.engine),'Research adapter unavailable; no implicit fallback',422,'TOOL_UNSUPPORTED');check((body.task.kind==='formal')===(body.engine==='lean'),'Formal jobs require Lean; CAS jobs require a CAS engine',422,'ENCODING_ERROR');
      const profile=PROFILES[body.task.profile||'standard'];Object.assign(receipt,profile,{profile:body.task.profile||'standard'});this.active=key;const lock={pid:process.pid,createdAt:now(),jobId:key,jobRoot:root,childPid:null};
      if(body.engine!=='wolfram'){release=acquireLock(path.join(this.settings.stateRoot,'review-desk-math-owner.lock'));writeJSON(path.join(this.settings.stateRoot,'review-desk-math-owner.lock'),lock);}
      const programRoot=this.blind.store.config.root;let program,args,input='',deps,code;
      writeJSON(path.join(root,'input.json'),body.task);receipt.loadedResearchSeal=loadedResearchSeal;receipt.compilerSha256=loadedResearchSeal.schema;
      if(body.engine==='sympy'){program=this.settings.python;code=fs.readFileSync(path.join(programRoot,'research-worker.py'),'utf8');fs.writeFileSync(path.join(root,'Program.py'),code);args=['-I','Program.py'];input=JSON.stringify(body.task);}
      if(body.engine==='lean'){program=this.settings.lean;const generated=leanProgram(body.task);code=generated.code;receipt.symbolMap=generated.symbolMap;deps=leanDependencies(this.settings,generated.imports);writeJSON(path.join(root,'dependencies-before.json'),deps);receipt.dependenciesSha256=deps.sha256;receipt.dependencyModules=deps.modules;fs.writeFileSync(path.join(root,'Check.lean'),code);args=['-j1','-M'+profile.memoryMiB,'-o','Check.olean','Check.lean'];}
      if(body.engine==='wolfram'){
        releaseRegistration=this.registrationWindow.begin();
        if(this.settings.registryAuthority){check(hashFile(this.settings.registryAuthority.path)===this.settings.registryAuthority.sha256&&readJSON(this.settings.registryAuthority.path).messageId==='00000000-0000-4000-8000-991f028c7d51','Registered cleanup authority changed',409,'REGISTRY_AUTHORITY_CHANGED');receipt.registryAuthority=this.settings.registryAuthority;}
        registration=await this.registry.acquire({requestId:this.activeRequestId||key,reportId:r.id,roleId:cap.roleId||null,jobRoot:root});check(registration,'Another request holds the atomic Wolfram registration',409,'REGISTRY_BUSY');receipt.registration={...registration,path:this.registry.file};this.registry.phase(registration.token,'cleaning');
        receipt.providerCleanupScriptSha256=hashFile(path.join(programRoot,'wolfram-registered-cleanup.ps1'));let cleanupActor=Promise.resolve();
        const cleanup=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(programRoot,'wolfram-registered-cleanup.ps1')],{input:JSON.stringify({program:this.settings.wolfram,registration:{path:this.registry.file,token:registration.token,ownerPid:process.pid}}),timeout:30000,onSpawn:pid=>{cleanupActor=this.registry.actor(registration.token,pid,'cleanup');cleanupActor.catch(()=>{});}});await cleanupActor;
        check(cleanup.code===0&&!cleanup.timedOut,'Registered Wolfram cleanup failed',503,'REGISTRY_CLEANUP_FAILED');receipt.providerCleanup=JSON.parse(cleanup.output.replace(/^\uFEFF/,''));this.registry.validate(registration.token);this.registry.phase(registration.token,'computing');
        program=this.settings.wolfram;const generated=wolframProgram(body.task);code=generated.code;receipt.symbolMap=generated.symbolMap;receipt.compilerSha256=loadedResearchSeal.wolfram;
        fs.writeFileSync(path.join(root,'Check.wl'),code);args=[...(this.settings.wolframLicenseFile?['-pwfile',this.settings.wolframLicenseFile]:[]),'-noinit','-noprompt','-script','Check.wl'];
      }
      receipt.codeSha256=sha(code);receipt.executableSha256=hashFile(program);receipt.runnerSha256=hashFile(path.join(programRoot,'research-runner.py'));fs.copyFileSync(path.join(programRoot,'research-runner.py'),path.join(root,'Runner.py'));
      const launch={program,args,input,...profile,registrationTimeoutMs:REGISTRATION_TIMEOUT_MS,leanPath:deps?.search.join(path.delimiter),licenseProfile:body.engine==='wolfram',licenseEnvironment:body.engine==='wolfram'?this.settings.wolframLicenseEnvironment:undefined,pythonVenv:body.engine==='sympy',...(registration?{registration:{path:this.registry.file,token:registration.token,ownerPid:process.pid}}:{})};writeJSON(path.join(root,'launch.json'),launch);let runnerActor=Promise.resolve();
      const runner=await run(this.settings.python,['-I','Runner.py'],{cwd:root,input:JSON.stringify(launch),timeout:registration?runnerTimeout(profile):profile.timeoutMs+20000,onSpawn:pid=>{receipt.childPid=pid;if(registration){runnerActor=registerRunner(this.registry,registration.token,pid,root).catch(e=>{e.stage='runner_registration';throw e;}).finally(releaseRegistration);runnerActor.catch(()=>{});}else writeJSON(path.join(this.settings.stateRoot,'review-desk-math-owner.lock'),{...lock,childPid:pid});this.blind.save('checks',receipt);}});
      writeJSON(path.join(root,'launcher-result.json'),runner);let handshake;try{const decoded=JSON.parse(runner.output);if(decoded.phase==='runner_registration'&&decoded.engineStarted===false)handshake=decoded;}catch{}if(handshake)receipt.runnerRegistration={...handshake,registrationTimeoutMs:REGISTRATION_TIMEOUT_MS};await runnerActor;if(handshake){const e=Error('Runner actor did not complete the bounded registration handshake');e.code=handshake.errorCode;e.stage='runner_registration';throw e;}check(runner.code===0&&!runner.timedOut,'Bounded research launcher failed',503,'RESOURCE_FAILURE');const result=JSON.parse(runner.output);receipt.timings={registrationElapsedMs:result.registrationElapsedMs,executionElapsedMs:result.executionElapsedMs,scope:result.executionTimingScope};writeJSON(path.join(root,'process.json'),result);receipt.actualChildPid=result.childPid;receipt.outputSha256=hashObject(result);receipt.executionCompleted=result.code===0&&!result.timedOut&&!result.overflow;receipt.controls={jobObject:result.jobObject,workers:1,memoryMiB:profile.memoryMiB,timeoutMs:profile.timeoutMs,filesystemSandbox:false,networkSandbox:false,executionBoundary:'Generated allowlisted programs only; no arbitrary host code or task-selected paths/imports/network calls. Trusted runtime retains host permissions.'};
      let evidence;
      if(receipt.executionCompleted&&body.engine==='sympy'){evidence=JSON.parse(result.output);const dependency=path.join(root,'dependencies.json');check(hashFile(dependency)===evidence.dependenciesSha256,'Actual Python dependency receipt differs',409,'DEPENDENCY_CHANGED');receipt.dependenciesSha256=evidence.dependenciesSha256;}
      if(receipt.executionCompleted&&body.engine==='wolfram'){
        const wire=result.output.split(/\r?\n/).find(x=>x.startsWith('REVIEW_RESULT:'));check(wire,'Wolfram did not return a framed result',503,'TOOL_RESULT_MISSING');evidence=JSON.parse(wire.slice('REVIEW_RESULT:'.length));
        check(evidence.processId===result.childPid&&evidence.parallelKernels===0&&evidence.engine==='Wolfram Language','Wolfram process receipt mismatch',409,'TOOL_IDENTITY');receipt.runtimeVersion=evidence.version;
        receipt.dependenciesSha256=hashObject({executableSha256:receipt.executableSha256,version:evidence.version,compilerSha256:receipt.compilerSha256});receipt.dependencyScope='Installed Wolfram runtime version and executable hash; proprietary internal loaded modules are not individually sealed.';
        try{receipt.postRunProcesses=await foreignWolfram();}catch(e){receipt.postRunObservationError=e.message;}receipt.actualChildCreatedAt=result.childCreatedAt;
      }
      if(body.engine==='lean'){
        if(deps)for(const [file,hash] of Object.entries(deps.files))check(hashFile(file)===hash,'Lean dependency changed during proof',409,'DEPENDENCY_CHANGED');
        const match=result.output.match(/depends on axioms:\s*\[([^\]]*)\]/),none=/does not depend on any axioms/.test(result.output),axioms=match?match[1].split(',').map(x=>x.trim()).filter(Boolean):[];
        const safe=receipt.executionCompleted&&(none||match)&&axioms.every(x=>['propext','Classical.choice','Quot.sound'].includes(x))&&!/\bsorry|\bAdmit|error:/i.test(result.output);
        evidence={assessment:safe?'formal_proof':'unresolved_formal',claim:body.task.claim,claimTruth:safe?'true':'unknown',verdictVersion:2,conclusion:safe?'checked_no_contradiction':'unknown',axioms,proofCode:code,symbolMap:receipt.symbolMap,diagnostic:result.output.replace(/[A-Za-z]:[\\/][^\r\n]*/g,'[installed dependency path omitted]').slice(0,16000),scope:'Actual Lean kernel elaboration proves the submitted equal or not_equal claim against sealed installed mathlib, not the whole paper. Listed standard axioms are trusted; no sorry, custom axioms or native_decide accepted. Lean field division is total; source-definedness must be included in the audited hypotheses.'};if(safe)receipt.proofArtifactSha256=hashFile(path.join(root,'Check.olean'));
      }
      evidence=evidence||{assessment:result.timedOut?'resource_timeout':result.overflow?'output_bound':'runtime_failure',conclusion:'unknown'};
      receipt.success=receipt.executionCompleted&&['checked_no_contradiction','contradiction'].includes(evidence.conclusion);receipt.public={id:key,engine:body.engine,success:receipt.success,executionCompleted:receipt.executionCompleted,encodingSha256:receipt.encodingSha256,codeSha256:receipt.codeSha256,dependenciesSha256:receipt.dependenciesSha256||null,task:body.task,evidence,reason:receipt.success?null:evidence.assessment};
    }catch(e){if(e.stage==='runner_registration'){receipt.phase='runner_registration';receipt.engineStarted=false;}receipt.errorCode=e.code||'RESEARCH_FAILURE';receipt.errorDiagnostic={message:e.message,stage:e.stage||null,syscall:e.syscall||null,path:e.path||null,dest:e.dest||null};receipt.public={id:key,engine:body.engine,success:false,executionCompleted:false,reason:receipt.errorCode,evidence:{assessment:/^REGISTR(Y|ATION)_/.test(e.code||'')?'resource_blocked':e.code==='ENCODING_ERROR'?'encoding_error':e.code==='TOOL_UNSUPPORTED'?'unsupported':e.code==='CONDITION_GAP'?'condition_gap':'resource_or_dependency_gap',conclusion:e.code==='ENCODING_ERROR'?'encoding_error':'unknown'}};}
    finally{releaseRegistration();receipt.finishedAt=now();this.blind.save('checks',receipt);try{if(registration){receipt.registrationAtCompletion=this.registry.phase(registration.token,'returning');receipt.registrationRelease=this.registry.release(registration.token,{requestId:this.activeRequestId||key,receiptId:key,workCompleted:!!receipt.executionCompleted,reason:receipt.errorCode||null,allWolframExitNotRequired:true});this.blind.save('checks',receipt);}}finally{release?.();this.active=null;this.busy=false;}}return receipt.public;
  }
}
