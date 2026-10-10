import {recordReviewImpact} from './lib/math-continuity.mjs';
import {roleDiagnostic} from './lib/role-diagnostic.mjs';
import {HumanRouting} from './lib/human-routing.mjs';
import {recoverLegacyFaithful} from './lib/source-binding-recovery.mjs';
import http from 'node:http';
import {loadCaseExplanations,localizeCaseExplanations} from './lib/case-explanations.mjs';
import fs from 'node:fs';
import {requestCorrespondence} from './lib/source-correspondence.mjs';
import {requestReportScope,submitReportScope} from './lib/report-scope.mjs';
import {Worker} from 'node:worker_threads';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setup,credentials,ROOT} from './setup.mjs';
import {Store} from './lib/store.mjs';
import {PreviewQueue} from './lib/previews.mjs';
import {NotificationQueue} from './lib/notifications.mjs';
import {BlindStore} from './lib/blind-store.mjs';
import {MathBroker} from './lib/math-broker.mjs';
import {ProductionReview} from './lib/production-review.mjs';
import {bridgeReport,registerLocator,recordSourceObservation,verifyReworkReceipt} from './lib/blind-bridge.mjs';
import {ownerDisposition} from './lib/owner-disposition.mjs';
import {resumeAuditedMath,migrateLegacyLocation} from './lib/workflow-migration.mjs';
import {OwnerLifecycle} from './lib/owner-lifecycle.mjs';
import {CompletionPublisher} from './lib/completion-publisher.mjs';
import {SourceExecutors} from './lib/source-executors.mjs';
import {BlindExecutors} from './lib/blind-executors.mjs';
import {CliPoolSettings} from './lib/cli-pool-settings.mjs';
import {taskDashboard} from './lib/task-dashboard.mjs';
import {readJSON,writeJSON,check,DeskError,uid,now,id,safePath,acquireLock,hashFile,hashObject,inside} from './lib/io.mjs';

const options=Object.fromEntries(process.argv.slice(2).map(a=>a.split('=')));
const config=options['--config']?readJSON(options['--config']):setup();
const fixture=options['--mode']==='fixture';
const dataRoot=path.resolve(options['--data']||path.join(ROOT,'data',fixture?'fixture':'production'));
inside(ROOT,dataRoot);
const maintenancePath=path.join(dataRoot,'maintenance-pause.json'),maintenance=fs.existsSync(maintenancePath)?readJSON(maintenancePath):null;
check(!maintenance?.paused||options['--maintenance-drain']==='true','User maintenance pause is active; normal service startup is blocked.',409,'MAINTENANCE_PAUSED');
const maintenanceNote='User requested an upgrade pause. Preserve all existing receipts and pending work; start no new calculation, compile, render or paper edit. A source worker may submit technical-gap with code USER_MAINTENANCE_PAUSE and a checkpoint reason, then exit and release its registration. Resume only after explicit user authorization.';
const port=Number(options['--port']||config.port);
check(port>=1024&&port<=65535,'Invalid local port');
fs.mkdirSync(dataRoot,{recursive:true});const release=acquireLock(path.join(dataRoot,'server.lock'));
const auth=credentials(dataRoot,config),instanceId=uid(),store=new Store(config,dataRoot,fixture),previews=new PreviewQueue(store);
const transportPath=path.join(ROOT,'desktop-transport.json');
const notifications=new NotificationQueue(store,fs.existsSync(transportPath)?readJSON(transportPath):null);
const blind=new BlindStore(store),math=new MathBroker(blind,readJSON(path.join(ROOT,'math-config.json')));
const blindTransport=path.join(ROOT,'blind-transport.json');notifications.attachBlind(blind,fs.existsSync(blindTransport)?readJSON(blindTransport):null);
const productionPath=options['--production-config']||path.join(ROOT,'production-review.json');
const production=new ProductionReview(blind,notifications,fs.existsSync(productionPath)?readJSON(productionPath):null);
const sourceSettings=options['--source-config']||path.join(ROOT,'source-executors.json');
const sources=new SourceExecutors(production,fs.existsSync(sourceSettings)?readJSON(sourceSettings):null);
production.sources=sources;notifications.sources=sources;
const blindSettings=options['--blind-config']||path.join(ROOT,'blind-executors.json');
const blindExecutors=new BlindExecutors(production,fs.existsSync(blindSettings)?readJSON(blindSettings):null);
production.blindExecutors=blindExecutors;blind.assertCapability=cap=>blindExecutors.assertCapability(cap);
blind.claimManaged=r=>blindExecutors.claimManaged(r);
blindExecutors.math=math;
const pools=new CliPoolSettings(dataRoot,{source:sources.settings?.maxConcurrent??2});sources.pools=pools;blindExecutors.pools=pools;
if(maintenance?.paused){production.stop();notifications.stop();sources.stop();blindExecutors.stop();math.stop();}
const loadedCode=Object.fromEntries(['lib/previews.mjs','lib/sealed-fragment.mjs','lib/role-diagnostic.mjs','lib/target.mjs','read-service-worker.mjs','lib/read-service.mjs','lib/human-authority.mjs','lib/background-plan.mjs','lib/math-continuity.mjs','lib/reading-continuity.mjs','lib/source-binding-recovery.mjs','lib/runner-registration.mjs','research-runner.py','server.mjs','lib/production-review.mjs','lib/review-ledger.mjs','lib/math-coverage.mjs','lib/math-history-binding.mjs','lib/review-workflow-v3.mjs','lib/workflow-migration.mjs','lib/owner-routing.mjs','lib/owner-disposition.mjs','lib/owner-lifecycle.mjs','lib/blind-store.mjs','lib/blind-bridge.mjs','lib/source-binding.mjs','lib/rework-evidence.mjs','lib/math-broker.mjs','lib/math-request-queue.mjs','lib/wolfram-registry.mjs','lib/notifications.mjs','lib/desktop-mcp.mjs'].map(f=>[f,hashFile(path.join(ROOT,f))]));
const owners=new OwnerLifecycle(production,production.enabled&&production.v3?production.settings.ownerRegistry:null);
for(const name of ['lib/io.mjs','lib/process.mjs','lib/source-executors.mjs','lib/source-business.mjs','lib/source-actor.mjs','lib/paper-writer-registry.mjs','lib/codex-source-worker.mjs','source-supervisor.mjs','source-worker-client.mjs','lib/apply.mjs','lib/recovery.mjs','lib/package.mjs'])loadedCode[name]=hashFile(path.join(ROOT,name));
production.owners=owners;
const humanRouting=new HumanRouting(production,production.settings?.humanEscalation);
production.humanRouting=humanRouting;blind.humanRouting=humanRouting;store.humanRouting=humanRouting;
if(humanRouting.enabled)humanRouting.reconcile();
for(const name of ['lib/source-correspondence.mjs','lib/report-scope.mjs','lib/range-lineage.mjs','lib/acceptance-carry.mjs','lib/human-routing.mjs','lib/human-edit-view.mjs','lib/human-handoff.mjs','lib/fragment-human-routing.mjs','lib/fragment-alias-adapter.mjs','lib/store.mjs','lib/blind-input.mjs','public/app.js','public/index.html','public/style.css','public/state-view.js'])loadedCode[name]=hashFile(path.join(ROOT,name));
const publisher=new CompletionPublisher(production,owners,production.settings?.completionPublication);
production.publisher=publisher;if(maintenance?.paused)publisher.stop();
loadedCode['public/image-viewer.js']=hashFile(path.join(ROOT,'public/image-viewer.js'));
const caseExplanations=loadCaseExplanations(ROOT);
loadedCode['public/case-explanations-view.js']=hashFile(path.join(ROOT,'public/case-explanations-view.js'));
loadedCode['lib/case-explanations.mjs']=hashFile(path.join(ROOT,'lib/case-explanations.mjs'));
if(fs.existsSync(path.join(ROOT,'localization/case-explanations.zh-CN.json')))loadedCode['localization/case-explanations.zh-CN.json']=hashFile(path.join(ROOT,'localization/case-explanations.zh-CN.json'));
const uiVersion=hashObject({files:Object.fromEntries(['public/case-explanations-view.js','public/app.js','public/image-viewer.js','public/index.html','public/style.css','public/state-view.js','public/tasks-view.js','public/blind-view.js','public/tasks-style.css'].map(f=>[f,hashFile(path.join(ROOT,f))])),caseExplanations:loadedCode['localization/case-explanations.zh-CN.json']||null});
const loadedConfiguration=Object.fromEntries([options['--config']||path.join(ROOT,'config.json'),productionPath,sourceSettings,blindSettings,...(production.settings?.ownerRegistry?[production.settings.ownerRegistry.path]:[])].filter(f=>fs.existsSync(f)).map(f=>[path.relative(ROOT,f).replaceAll('\\','/'),hashFile(f)]));
for(const name of ['lib/completion-publisher.mjs','lib/source-disposition-correction.mjs','lib/blind-finalize.mjs','lib/inputs.mjs','lib/build.mjs','local-build-job.mjs','paper_library/promotion.mjs','paper_library/library.mjs','paper_library/workflow-contract.mjs','paper_library/revocations.mjs'])loadedCode[name]=hashFile(path.join(ROOT,name));
if(owners.enabled)blind.assertPaperOpen=paperId=>owners.assertOpen(paperId);
if(production.enabled)notifications.attachBlind(blind,{path:production.settings.authorizationPath,sha256:production.settings.authorizationSha256});
for(const name of ['lib/blind-executors.mjs','lib/cli-pool-settings.mjs','lib/cli-progress.mjs','lib/task-dashboard.mjs','blind-supervisor.mjs','blind-role.mjs','worker-context.mjs','context-read.mjs','public/tasks-view.js','public/blind-view.js'])loadedCode[name]=hashFile(path.join(ROOT,name));
let cachedBlindSummary=null,cachedBlindAt=0;
const blindSummary=()=>{if(cachedBlindSummary&&Date.now()-cachedBlindAt<5000)return cachedBlindSummary;cachedBlindSummary={...blind.summary(),production:production.summary(),owners:owners.summary(),publication:publisher.summary(),sourceExecutors:sources.summary(),roles:production.enabled?{executionMode:blindExecutors.enabled?'fresh_cli':'legacy_chats',permanentReporters:blindExecutors.enabled?0:4,permanentCheckers:production.v3?0:1,reviewersDoMathematics:!!production.v3,automaticModelPolling:false}:blind.summary().roles};cachedBlindAt=Date.now();return cachedBlindSummary;};
const tasks=()=>({...taskDashboard({store,sources,blindExecutors,math,pools,blind}),fragmentHuman:humanRouting.enabled?humanRouting.statusMany(production.paperIds()):[]});
let bridgeBusy=false;
const origin='http://127.0.0.1:'+port;
sources.origin=origin;
blindExecutors.origin=origin;
const cookieName='review_desk_'+port;
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
async function body(req){check((req.headers['content-type']||'').split(';')[0]==='application/json','Use JSON',415);let size=0,chunks=[];for await(const x of req){size+=x.length;check(size<=2*1024*1024,'Request body too large',413);chunks.push(x);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new DeskError('Malformed JSON');}}
function browser(req,write=false){const cookies=(req.headers.cookie||'').split(';').map(x=>x.trim());check(cookies.includes(cookieName+'='+auth.cookie),'Open the private local launch link first',401,'LOGIN_REQUIRED');if(write){check(req.headers.origin===origin,'Write origin rejected',403,'ORIGIN');check(req.headers['x-review-token']===auth.csrf,'Missing local write authorization',403,'CSRF');if(/^\/api\/cases\/[^/]+\/(draft|preview|decision|defer)$/.test(new URL(req.url,origin).pathname))check(req.headers['x-review-client']==='human-lan-v1','界面已更新。请先保留本机未同步文本，再用新版入口打开；本次保存尚未提交。',428,'CLIENT_UPDATE_REQUIRED');}}
function worker(req,paperId){id(paperId);check(config.papers[paperId]&&req.headers.authorization==='Bearer '+auth.workers[paperId],'Owner capability rejected',403,'OWNER_AUTH');check(!req.headers.origin,'Worker endpoints are not browser endpoints',403);if(req.method==='POST')check(!sources.migrated(paperId),'Permanent owner execution was handed off; current assignment token required',409,'OWNER_HANDED_OFF');return config.papers[paperId];}
function file(res,p,mime,expected){check(fs.statSync(p).isFile(),'Missing artifact',404);if(expected)check(hashFile(p)===expected,'Artifact hash changed',409,'EVIDENCE_CHANGED');res.writeHead(200,{'Content-Type':mime||({'.png':'image/png','.pdf':'application/pdf','.tex':'text/plain; charset=utf-8','.json':'application/json','.txt':'text/plain; charset=utf-8'})[path.extname(p)]||'application/octet-stream','Content-Length':fs.statSync(p).size});fs.createReadStream(p).pipe(res);}
function publicPreview(p){return p?{id:p.id,caseId:p.caseId,status:p.status,fragmentSha256:p.fragmentSha256,build:p.build,rendered:p.rendered,artifacts:p.artifacts,error:p.error,errorCode:p.errorCode,attempt:p.attempt}:null;}
function caseView(key){const r=store.request(key),s=store.state(key);return {request:{id:r.id,fixture:r.fixture,spec:r.spec,intentDigest:r.intentDigest,version:r.version,source:r.source,main:r.main,engine:r.engine,artifacts:r.artifacts,candidateRender:r.candidateRender,humanEscalation:r.humanEscalation||null,baseBuild:{pdfSha256:r.baseBuild.pdfSha256,inputSha256:r.baseBuild.inputSha256}},humanExplanationZh:localizeCaseExplanations(r,caseExplanations),state:s,preview:s.latestPreview?publicPreview(store.preview(s.latestPreview)):null};}
async function performBlindRole(cap,action,b){
 if(action==='report-scope')return submitReportScope(production,cap,b);
 if(action==='ack')return production.ack(cap,b);
 if(action==='coverage')return production.coverage(cap,b);
 if(action==='discover')return blind.discovery.public(blind.discovery.discover(cap,b));
 if(action==='revise-proposal')return blind.discovery.revise(cap,b);
 if(action==='report'){const r=blind.discovery.submit(cap,b);notifications.enqueueRework(r.id);production.kick();return r;}
 if(action==='delivery-complete')return production.deliveryComplete(cap,b);
 if(action==='review-impact')return recordReviewImpact(production,cap,b);
 if(action==='math-inventory')return production.mathCoverage.submit(cap,b);
 if(action==='math-open'){check(production.v3&&production.mathAdmitted(),'Reviewer mathematics admission is paused',503,'MAINTENANCE_PAUSED');return blindExecutors.openMath(cap,b.id);}
 if(action==='encoding')return blind.recordEncoding(cap,b);
 if(action==='tool'){if(maintenance?.paused){const cached=math.requests.existing(cap,b);check(b.engine==='wolfram'&&cached&&['completed','resource_blocked'].includes(cached.status),maintenanceNote,503,'MAINTENANCE_PAUSED');}return math.execute(cap,b);}
 if(action==='finish'){const r=blind.finishMath(cap,b);production.kick();return r;}
 if(action==='recheck'){const r=blind.completionReview(cap,b);notifications.enqueueRework(r.id);production.kick();return r;}
 if(action==='worker-finish')return blindExecutors.finish(cap);
 if(action==='worker-gap')return blindExecutors.gap(cap,b);
 throw new DeskError('Role action rejected',403,'ROLE_DENIED');
}
let closing=false;
function activeWorkers(){return [sources,blindExecutors].some(pool=>pool.assignments().some(a=>['launching','running'].includes(a.status))||fs.readdirSync(path.join(pool.registry.root,'papers')).some(f=>f.endsWith('.json')&&readJSON(path.join(pool.registry.root,'papers',f)).holder));}
function serviceBusy(){return publisher.busy||previews.busy||notifications.busy||math.busy||bridgeBusy||production.busy||sources.busy||blindExecutors.busy||!!sources.activeOperations||!!blindExecutors.activeOperations||activeWorkers();}
const server=http.createServer(async(req,res)=>{
  for(const [k,v] of Object.entries({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"}))res.setHeader(k,v);
  try{
    check(req.headers.host==='127.0.0.1:'+port,'Host rejected',403,'HOST');
    if(req.headers.origin)check(req.headers.origin===origin,'Cross-origin request rejected',403,'ORIGIN');
    if(req.headers['sec-fetch-site'])check(['same-origin','none'].includes(req.headers['sec-fetch-site']),'Cross-site request rejected',403);
    const url=new URL(req.url,origin),parts=url.pathname.split('/').filter(Boolean);
    check(!closing,'Service is draining existing connections',503,'SERVICE_DRAINING');
    if(url.pathname!=='/health'&&url.pathname!=='/internal/shutdown')await math.registrationWindow.wait();
    check(!closing,'Service is draining existing connections',503,'SERVICE_DRAINING');
    if(maintenance?.paused&&req.method==='POST'){
      const allowed=parts[0]==='role'&&['input','ack','coverage','discover','revise-proposal','report','delivery-complete','math-inventory','tool','finish','recheck','worker-finish','worker-gap'].includes(parts[1])||parts[0]==='api'&&parts[1]==='source'&&['input','finish','technical-gap'].includes(parts[2])||parts[0]==='internal'&&parts[1]==='blind'&&['status','source-status','resources','maintenance-status'].includes(parts[2])||url.pathname==='/internal/shutdown'||url.pathname==='/api/session'||url.pathname==='/api/task-pools';
      check(allowed,maintenanceNote,503,'MAINTENANCE_PAUSED');
    }
    if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{service:'paper-review-desk',instanceId,pid:process.pid,mode:fixture?'fixture':'production',workflowVersion:production.v3?3:2,loadedCode,loadedConfiguration,busy:serviceBusy(),startedAt,maintenance:maintenance?.paused?{paused:true,receiptDrain:true,newWorkEnabled:false,automaticResume:false}:null});
    if(parts[0]==='role'){
      try{
        check(!req.headers.origin&&req.method==='POST'&&parts.length===2,'Role request rejected',403,'ROLE_DENIED');
        const cap=blind.capability((req.headers.authorization||'').replace(/^Bearer /,'')),b=await body(req);
        if(parts[1]==='input'){check(!Object.keys(b).length&&!url.search,'Role input selectors are not accepted',403);return json(res,200,{...(cap.cliActor?blindExecutors.input(cap):production.roleInput(cap)),...(maintenance?.paused?{maintenance:{paused:true,note:maintenanceNote}}:{})});}
        if(cap.cliActor){const result=await blindExecutors.operation(cap,parts[1],b,()=>performBlindRole(cap,parts[1],b));return json(res,200,result);}
        if(parts[1]==='ack')return json(res,200,production.ack(cap,b));
        if(parts[1]==='coverage')return json(res,200,production.coverage(cap,b));
        if(parts[1]==='discover')return json(res,200,blind.discovery.public(blind.discovery.discover(cap,b)));
        if(parts[1]==='revise-proposal')return json(res,200,blind.discovery.revise(cap,b));
        if(parts[1]==='report'){const r=blind.discovery.submit(cap,b);notifications.enqueueRework(r.id);production.kick();return json(res,200,r);}
        if(parts[1]==='delivery-complete')return json(res,200,production.deliveryComplete(cap,b));
        if(parts[1]==='review-impact')return json(res,200,recordReviewImpact(production,cap,b));
        if(parts[1]==='math-inventory')return json(res,200,production.mathCoverage.submit(cap,b));
        if(parts[1]==='math-open'){check(production.v3&&production.mathAdmitted()&&cap.role==='reporter','Only an admitted original blind reviewer may open its mathematical report',403,'ROLE_DENIED');const r=blind.report(b.id);check(r.paperId===blind.bundle(cap.bundleId).paperId&&cap.roleId,'Report differs from the assigned original review',403,'ROLE_DENIED');return json(res,200,blind.claimReviewerMath(r.id,cap.roleId));}
        if(parts[1]==='encoding')return json(res,200,blind.recordEncoding(cap,b));
        if(parts[1]==='tool'){if(maintenance?.paused){const cached=math.requests.existing(cap,b);check(b.engine==='wolfram'&&cached&&['completed','resource_blocked'].includes(cached.status),maintenanceNote,503,'MAINTENANCE_PAUSED');}return json(res,200,await math.execute(cap,b));}
        if(parts[1]==='finish'){const r=blind.finishMath(cap,b);production.kick();return json(res,200,r);}
        if(parts[1]==='recheck'){const r=blind.completionReview(cap,b);notifications.enqueueRework(r.id);production.kick();return json(res,200,r);}
        throw new DeskError('Role request rejected',403,'ROLE_DENIED');
      }catch(e){return json(res,e.status||400,roleDiagnostic(e));}
    }
    if(url.pathname==='/api/blind-worker/session'){
      check(!req.headers.origin&&req.method==='POST'&&blindExecutors.enabled,'Registered blind worker required',403);
      const {paperId,assignmentId,attemptId}=await body(req),secret=(req.headers.authorization||'').replace(/^Bearer /,'');return json(res,200,await blindExecutors.activate(paperId,secret,{assignmentId,attemptId}));
    }
    if(parts[0]==='api'&&parts[1]==='source'){
      check(!req.headers.origin&&req.method==='POST'&&parts.length===3,'Source endpoint requires local worker POST',403);check(sources.enabled,'Source workers are not enabled',503);
      const {paperId,assignmentId,attemptId,...payload}=await body(req),secret=(req.headers.authorization||'').replace(/^Bearer /,''),scope={assignmentId,attemptId};id(paperId);id(assignmentId);id(attemptId);
      if(parts[2]==='input')return json(res,200,{...await sources.input(paperId,secret,scope),...(maintenance?.paused?{maintenance:{paused:true,note:maintenanceNote}}:{})});
      if(owners.enabled)owners.assertOpen(paperId);return json(res,200,await sources.operation(paperId,secret,scope,parts[2],payload));
    }
    if(parts[0]==='internal'&&parts[1]==='blind'){
      check(!req.headers.origin&&req.headers.authorization==='Bearer '+auth.admin&&req.method==='POST','Admin capability rejected',403);const b=await body(req);
      if(parts[2]==='status')return json(res,200,blindSummary());
      if(parts[2]==='source-status')return json(res,200,sources.summary());
      if(parts[2]==='blind-reconcile-operation')return json(res,200,blindExecutors.reconcileOperation(b.assignmentId,b.operationId,b.reason));
      if(parts[2]==='blind-resume')return json(res,200,await blindExecutors.resume(b.assignmentId,b.reason));
      if(parts[2]==='source-handoff')return json(res,200,await sources.handoff(b.paperId));
      if(parts[2]==='source-archive')return json(res,200,await sources.archive(b.owner));
      if(parts[2]==='source-resume')return json(res,200,await sources.resume(b.assignmentId,b.reason));
      if(parts[2]==='source-amend-recovery')return json(res,200,await sources.amendRecovery(b.assignmentId,b));
      if(parts[2]==='source-recover-writer')return json(res,200,await sources.registry.recover(b.paperId,b.tokenSha256,b.reason));
      if(parts[2]==='source-recover-guard')return json(res,200,await sources.registry.recoverGuard(b.paperId,b.nonce,b.reason));
      if(parts[2]==='start-production')return json(res,200,production.start());
      if(parts[2]==='enable-exhaustive')return json(res,200,production.enableExhaustive(b));
      if(parts[2]==='reconcile-discoveries')return json(res,200,production.reconcileDiscoveries(b.entries));
      if(parts[2]==='recover-delivery')return json(res,200,production.recoverDelivery(b.assignmentId));
      if(parts[2]==='resume-reviewer-technical')return json(res,200,production.resumeReviewerTechnical(b.id,b.reason));
      if(parts[2]==='blind-complete-stopped-recheck')return json(res,200,await blindExecutors.completeStoppedRecheck(b.assignmentId,b.reason));
      if(parts[2]==='blind-complete-stopped-reading')return json(res,200,await blindExecutors.completeStoppedReading(b.assignmentId,b.reason));
      if(parts[2]==='publication-status')return json(res,200,publisher.summary());
      if(parts[2]==='publication-run'){check(!publisher.busy,'Publication already running',409,'WRITER_BUSY');publisher.kick();return json(res,202,{queued:true});}
      if(parts[2]==='owner-gate')return json(res,200,owners.gate(b.paperId));
      if(parts[2]==='owner-release')return json(res,200,owners.release(b.paperId,b.versionId));
      if(parts[2]==='owner-archive')return json(res,200,await owners.archive(b.owner));
      if(parts[2]==='owner-rotate')return json(res,200,owners.rotate(b.owner,b.paperId));
      if(parts[2]==='reviewer-math-admission')return json(res,200,production.admitReviewerMath(b.enabled));
      if(parts[2]==='resume-audited-math')return json(res,200,resumeAuditedMath(production,b.id,b));
      if(parts[2]==='resume-owner-technical')return json(res,200,production.resumeOwnerTechnical(b.id,b.reason));
      if(parts[2]==='resume-completion')return json(res,200,production.resumeCompletion(b.id,b));
      if(parts[2]==='migrate-location')return json(res,200,migrateLegacyLocation(production,b.id,b));
      if(parts[2]==='recover-registration')return json(res,200,await math.registry.recover(b.token,b.reason));
      if(parts[2]==='resume-tool-request')return json(res,200,await math.requests.resume(b.id,b.reason));
      if(production.v3&&['claim','resume-math','retry-math','math-admission'].includes(parts[2]))throw new DeskError('Independent checker route retired; use original-reviewer v3 recovery/admission',409,'RETIRED_ROUTE');
      if(parts[2]==='retry-math')return json(res,200,production.retryMath(b.id,b.reason));
      if(parts[2]==='unmerge')return json(res,200,production.unmerge(b.id,b.reason));
      if(parts[2]==='math-admission')return json(res,200,production.admitMath(b.enabled));
      if(parts[2]==='resume-math')return json(res,200,production.resumeMath(b.id,b.reason));
      if(parts[2]==='request-source-correspondence')return json(res,200,requestCorrespondence(production,b.id,b));
      if(parts[2]==='request-report-scope')return json(res,200,requestReportScope(production,b.id,b));
      if(parts[2]==='request-location')return json(res,200,production.requestLocation(b.id,b.reason));
      if(parts[2]==='reconcile-dispatch')return json(res,200,production.reconcileDispatch(b.id,b.reason));
      if(parts[2]==='resume-assignment')return json(res,200,production.resumeAssignment(b.id,b.reason));
      if(parts[2]==='resume-owner-return')return json(res,200,production.resumeOwnerReturn(b.id,b.reason));
      if(parts[2]==='resume-owner-packet'){check(!bridgeBusy,'Source bridge is busy',409);const r=blind.report(b.id);check((r.status==='human_packet_pending'||(r.status==='owner_technical_blocked'&&r.ownerDisposition?.payload.disposition==='faithful_source'))&&r.ownerDisposition?.payload,'Pending original owner packet required',409);if(r.status==='owner_technical_blocked'){r.status='source_triage';delete r.ownerReturnAttention;blind.save('reports',r);}bridgeBusy=true;try{return json(res,200,await ownerDisposition(blind,r.paperId,r.ownerDisposition.payload));}finally{bridgeBusy=false;production.kick();}}
      if(parts[2]==='recover-source-binding')return json(res,200,await recoverLegacyFaithful(production,b.id,b));
      if(parts[2]==='source-observation'){const r=recordSourceObservation(blind,b.id,b);production.kick();return json(res,200,r);}
      if(parts[2]==='resources')return json(res,200,math.resources());
      if(parts[2]==='maintenance-status'){check(maintenance?.paused,'Maintenance pause is not active',409);for(const a of sources.assignments())await sources.reconcile(a);for(const a of blindExecutors.assignments())await blindExecutors.reconcile(a);return json(res,200,{paused:true,newDispatch:false,newSourceLaunch:false,newBlindLaunch:false,newWolframAcquisition:false,automaticResume:false,activeOperations:(sources.activeOperations||0)+(blindExecutors.activeOperations||0),activeWorkers:activeWorkers(),source:sources.summary(),blind:{stopped:blindExecutors.stopped,busy:blindExecutors.busy,activeOperations:blindExecutors.activeOperations,holders:blindExecutors.assignments().filter(a=>blindExecutors.registry.read(a.paperId).holder).map(a=>({paperId:a.paperId,assignmentId:a.id}))},math:{busy:math.busy,requestPumpStopped:math.requests.stopped,registrationHeld:!!math.registry.read()},notificationsStopped:notifications.stopped,productionStopped:production.stopped});}
      if(parts[2]==='recover-lock')return json(res,200,math.recoverLock(b.name));
      if(parts[2]==='grant')return json(res,200,blind.issueCapability(b.role,b.scope));
      if(parts[2]==='claim')return json(res,200,blind.claimMath());
      if(parts[2]==='locate'){const r=registerLocator(blind,b.paperId,b.bundleId,b.nodeId,b.locator,b.evidence,{bridge:true});production.locationReceived(b.paperId,b.bundleId,b.nodeId);return json(res,200,r);}
      if(parts[2]==='screen'){const r=blind.screen(b.id,b);notifications.enqueueRework(r.id);production.kick();return json(res,200,r);}
      if(parts[2]==='bridge'){check(!bridgeBusy,'Source bridge is busy',409);bridgeBusy=true;try{return json(res,200,await bridgeReport(blind,b.id,{supplement:!!b.supplement,sourceQuestion:b.sourceQuestion}));}finally{bridgeBusy=false;production.kick();}}
      throw new DeskError('Unknown blind admin endpoint',404);
    }
    if(url.pathname.startsWith('/internal/integration/')){
      check(!req.headers.origin&&req.headers.authorization==='Bearer '+auth.admin,'Admin capability rejected',403);
      if(req.method==='GET'&&url.pathname==='/internal/integration/status')return json(res,200,{...notifications.summary(),jobs:notifications.jobs(),connections:Object.keys(config.papers).map(p=>notifications.connection(p)).filter(Boolean)});
      if(req.method==='POST'&&url.pathname==='/internal/integration/enroll'){const b=await body(req);return json(res,200,notifications.enroll(b.paperId));}
      if(req.method==='POST'&&url.pathname==='/internal/integration/reconcile'){const b=await body(req);return json(res,200,notifications.requestReconciliation(b.id));}
      throw new DeskError('Unknown integration endpoint',404);
    }
    if(req.method==='POST'&&url.pathname==='/internal/shutdown'){
      check(!req.headers.origin&&req.headers.authorization==='Bearer '+auth.admin,'Admin capability rejected',403);check(!serviceBusy(),'Local work or registered workers remain active; wait for checkpoints and releases before stopping',409,'BUILD_ACTIVE');closing=true;publisher.stop();sources.stop();blindExecutors.stop();production.stop();notifications.stop();math.stop();json(res,200,{stopping:true});return drainHttp();
    }
    if(req.method==='GET'&&['/','/case-explanations-view.js','/app.js','/state-view.js','/blind-view.js','/tasks-view.js','/style.css','/tasks-style.css'].includes(url.pathname)){const name=url.pathname==='/'?'index.html':url.pathname.slice(1);return file(res,path.join(ROOT,'public',name),name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');}
    if(req.method==='POST'&&url.pathname==='/api/session'){check(req.headers.origin===origin,'Session requires same-origin launch',403);const b=await body(req);check(b.key===auth.uiKey,'Invalid launch key',403);res.setHeader('Set-Cookie',cookieName+'='+auth.cookie+'; HttpOnly; SameSite=Strict; Path=/');return json(res,200,{authenticated:true});}
    if(parts[0]==='api'&&parts[1]==='worker'){
      const b=req.method==='GET'?Object.fromEntries(url.searchParams):await body(req);const paper=worker(req,b.paperId);
      if(req.method==='POST'&&owners.enabled)owners.assertOpen(b.paperId);
      if(!fixture){const current=readJSON(config.batchPath).papers.find(p=>p.paperId===b.paperId);check(current?.threadId===paper.owner,'Batch owner changed; reconcile registry before proceeding',409,'OWNER_CHANGED');}
      if(req.method==='POST'&&parts[2]==='blind'){
        if(parts[3]==='disposition'){check(!bridgeBusy,'Source bridge is busy',409);bridgeBusy=true;try{return json(res,200,await ownerDisposition(blind,b.paperId,b));}finally{bridgeBusy=false;production.kick();}}
        if(parts[3]==='freeze')return json(res,200,blind.freeze(b.paperId,b.spec));
        if(parts[3]==='freeze-review')return json(res,200,production.freeze(b.paperId,b));
        if(parts[3]==='locate'){const r=registerLocator(blind,b.paperId,b.bundleId,b.nodeId,b.locator,b.evidence);production.locationReceived(b.paperId,b.bundleId,b.nodeId);return json(res,200,r);}
        if(parts[3]==='inbox')return json(res,200,blind.all('reports').filter(r=>r.paperId===b.paperId&&['owner_rework','owner_escalation','needs_source_evidence'].includes(r.status)));
        if(parts[3]==='receive'){const r=blind.receiveRework(b.paperId,b.id);notifications.acknowledgeRework(r.id);return json(res,200,{report:r,binding:blind.bundle(r.reworkBaseBundleId||r.bundleId)});}
        if(parts[3]==='return'){const bundle=blind.bundle(b.bundleId);verifyReworkReceipt(blind,bundle,b.receipt);const result=blind.returnRework(b.paperId,b.id,b.bundleId,b.receipt);production.kick();return json(res,200,result);}
        throw new DeskError('Unknown owner blind endpoint',404);
      }
      if(req.method==='POST'&&parts[2]==='submit')return json(res,200,store.submit(b.packageId,b.paperId));
      if(req.method==='GET'&&parts[2]==='inbox')return json(res,200,{owner:paper.owner,wake:notifications.summary(),connection:notifications.connection(b.paperId),items:store.list().filter(x=>x.paperId===b.paperId).map(x=>({id:x.id,state:store.state(x.id)}))});
      if(req.method==='GET'&&parts[2]==='case'){const r=store.request(b.id);check(r.spec.paperId===b.paperId,'Paper differs',403);return json(res,200,{request:r,state:store.state(b.id)});}
      if(req.method==='POST'&&parts[2]==='connect')return json(res,200,notifications.connectOwner(b.paperId,paper.owner,b.notificationId));
      if(req.method==='POST'&&parts[2]==='receive'){const received=store.receive(b.id,paper.owner,b.decisionId);notifications.acknowledgeDecision(b.id,b.decisionId);return json(res,200,received);}
      if(req.method==='POST'&&parts[2]==='report')return json(res,200,store.report(b.id,paper.owner,b));
      throw new DeskError('Unknown worker endpoint',404);
    }
    browser(req,req.method!=='GET');
    if(req.method==='GET'&&url.pathname==='/api/tasks')return json(res,200,tasks());
    if(req.method==='POST'&&url.pathname==='/api/task-pools'){const result=pools.update(await body(req));sources.kick();blindExecutors.kick();return json(res,200,{...result,paused:maintenance?.paused===true});}
    if(req.method==='GET'&&parts[0]==='api'&&parts[1]==='tasks'&&parts[4]==='receipt'){const row=tasks().tasks.find(r=>r.pool===parts[2]&&r.assignmentId===parts[3]);check(row,'Unknown task receipt',404);return json(res,200,{assignmentId:row.assignmentId,paperId:row.paperId,attemptId:row.attemptId,kind:row.kind,deliveryVerified:row.deliveryVerified,phase:row.phase,reportId:row.reportId,requestId:row.requestId,problemCode:row.problemCode,paperSignoff:false,scope:'此处仅为工单交付状态；论文签核和人工接受独立记录。'});}
    if(req.method==='GET'&&url.pathname==='/api/blind')return json(res,200,blindSummary());
    if(req.method==='GET'&&url.pathname==='/api/bootstrap')return json(res,200,{csrf:auth.csrf,fixture,instanceId,uiVersion,mode:fixture?'fixture':'production',wake:notifications.summary(),papers:Object.values(config.papers).map(p=>({paperId:p.paperId,title:p.title,owner:p.owner,engine:p.engine})),items:store.list()});
    if(req.method==='GET'&&url.pathname==='/api/cases')return json(res,200,{uiVersion,items:store.list(),wake:notifications.summary()});
    if(parts[0]==='api'&&parts[1]==='cases'){
      const key=id(parts[2]);
      if(req.method==='GET'&&parts.length===3)return json(res,200,caseView(key));
      if(req.method==='GET'&&parts[3]==='assets') {const r=store.request(key);check(Object.hasOwn(r.artifacts,parts[4]),'Unknown artifact',404);const pack=path.join(store.caseRoot(key),'package'),rel=r.artifacts[parts[4]],expected=readJSON(path.join(pack,'seal.json')).files.find(f=>f.file===rel)?.sha256;check(expected,'Missing artifact seal',409);return file(res,safePath(pack,rel),undefined,expected);}
      if(req.method==='GET'&&parts[3]==='result'){const s=store.state(key);check(s.verification,'No verified result yet',404);return file(res,safePath(dataRoot,'results/'+id(s.verification.packageId)+'/'+(parts[4]==='tex'?'result.tex':'result.pdf')),undefined,parts[4]==='tex'?s.verification.texSha256:s.verification.pdfSha256);}
      if(req.method==='POST'){const b=await body(req);if(parts[3]==='draft')return json(res,200,store.editDraft(key,b));if(parts[3]==='defer')return json(res,200,store.defer(key,b));if(parts[3]==='decision'){store.decide(key,b);blind.reconcileRulings();try{notifications.enqueueDecision(key);}catch(e){const s=store.state(key);s.notification={status:'blocked',problem:e.message};store.save(key,s);}return json(res,200,store.state(key));}if(parts[3]==='preview')return json(res,202,publicPreview(previews.enqueue(key,b.draftVersion,!!b.retry)));}
    }
    if(req.method==='GET'&&parts[0]==='api'&&parts[1]==='previews') {const p=store.preview(parts[2]);if(parts.length===3)return json(res,200,publicPreview(p));check(p.status==='succeeded'&&Object.hasOwn(p.artifacts,parts[4]),'Preview artifact unavailable',404);return file(res,safePath(path.join(dataRoot,'previews',p.id),p.artifacts[parts[4]]),undefined,p.artifactHashes?.[parts[4]]||(parts[4]==='pdf'?p.build.pdfSha256:undefined));}
    throw new DeskError('Not found',404);
  }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.message,code:e.code||'INTERNAL',...(e.sourcePrecondition?{precondition:e.sourcePrecondition}:{})});else res.end();}
});
const startedAt=now();
server.requestTimeout=30000;server.headersTimeout=60000;
function cleanup(){clearInterval(readerHeartbeat);publisher.stop();sources.stop();blindExecutors.stop();try{release();}catch{}const p=path.join(dataRoot,'runtime.json');if(fs.existsSync(p)&&readJSON(p).instanceId===instanceId)writeJSON(p,{...readJSON(p),stoppedAt:now()});}
server.once('error',e=>{cleanup();console.error(e.message);process.exit(1);});
let reader=null,readerHeartbeat=null,readerStopping=false,readerRestarts=0,lastWake=null;
function readState(){if(!math.registrationWindow.pending)lastWake=notifications.summary();return {observedAt:now(),busy:serviceBusy(),wake:lastWake,closing};}
async function startReader(){
 const worker=new Worker(path.join(ROOT,'read-service-worker.mjs'),{workerData:{root:ROOT,dataRoot,config,fixture,auth,port,backendPort:server.address().port,paperIds:production.enabled?production.paperIds():[],humanSettings:production.settings?.humanEscalation,poolDefaults:pools.defaults,uiVersion,metadata:{service:'paper-review-desk',pid:process.pid,instanceId,mode:fixture?'fixture':'production',workflowVersion:production.v3?3:2,loadedCode,loadedConfiguration,startedAt,maintenance:maintenance?.paused?{paused:true,receiptDrain:true,newWorkEnabled:false,automaticResume:false}:null},initialState:readState()}});reader=worker;
 worker.on('error',error=>console.error(JSON.stringify({code:'READ_SERVICE_ERROR',message:error.message})));
 worker.on('exit',code=>{if(reader===worker)reader=null;if(!readerStopping&&!closing){console.error(JSON.stringify({code:'READ_SERVICE_EXIT',exitCode:code}));if(readerRestarts++<3)setTimeout(()=>{if(!closing)void startReader().catch(error=>console.error(JSON.stringify({code:'READ_SERVICE_RESTART_FAILED',message:error.message})));},500);}});
 await new Promise((resolve,reject)=>{const ready=message=>{if(message.type==='ready'){worker.off('message',ready);resolve();}};worker.on('message',ready);worker.once('error',reject);worker.once('exit',code=>reject(Error('Read service exited before ready: '+code)));});
}
server.listen(0,'127.0.0.1',async()=>{try{
 writeJSON(path.join(dataRoot,'runtime.json'),{pid:process.pid,port,host:'127.0.0.1',instanceId,startedAt,mode:fixture?'fixture':'production',workflowVersion:production.v3?3:2,loadedCode,loadedConfiguration,dataRoot,configPath:options['--config']||path.join(ROOT,'config.json'),readService:{independentThread:true},maintenance:maintenance?.paused?{paused:true,receiptDrain:true}:null});
 await startReader();readerHeartbeat=setInterval(()=>{try{reader?.postMessage({type:'state',state:readState()});}catch{}},1000);readerHeartbeat.unref();
 console.log(JSON.stringify({service:'paper-review-desk',pid:process.pid,port,mode:fixture?'fixture':'production',startedAt}));if(!maintenance?.paused){previews.recover();notifications.recover();production.kick();sources.kick();blindExecutors.kick();publisher.kick();}
 }catch(error){closing=true;readerStopping=true;reader?.terminate();cleanup();console.error(error.message);process.exit(1);}});
function drainHttp(){closing=true;readerStopping=true;reader?.postMessage({type:'state',state:readState()});server.close(async()=>{const current=reader;if(current){const exited=new Promise(resolve=>current.once('exit',resolve));current.postMessage({type:'stop'});const timeout=setTimeout(()=>current.terminate(),2000);await exited;clearTimeout(timeout);}cleanup();process.exit(0);});server.closeIdleConnections();const timer=setTimeout(()=>{if(!serviceBusy())server.closeAllConnections();},2000);timer.unref();}
function gracefulStop(){if(!serviceBusy()){publisher.stop();sources.stop();blindExecutors.stop();production.stop();notifications.stop();math.stop();drainHttp();}}
process.on('SIGTERM',gracefulStop);process.on('SIGINT',gracefulStop);
