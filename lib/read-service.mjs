import {loadCaseExplanations,localizeCaseExplanations} from './case-explanations.mjs';
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
import {Store} from './store.mjs';import {HumanRouting} from './human-routing.mjs';import {taskDashboard} from './task-dashboard.mjs';
import {check,readJSON,sha,id,safePath} from './io.mjs';

const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"};
const staticFiles=new Set(['/','/case-explanations-view.js','/app.js','/image-viewer.js','/state-view.js','/blind-view.js','/tasks-view.js','/style.css','/tasks-style.css']);
const rows=root=>fs.existsSync(root)?fs.readdirSync(root).filter(f=>f.endsWith('.json')).map(f=>readJSON(path.join(root,f))):[];
const preview=p=>p?{id:p.id,caseId:p.caseId,status:p.status,fragmentSha256:p.fragmentSha256,build:p.build,rendered:p.rendered,artifacts:p.artifacts,error:p.error,errorCode:p.errorCode,attempt:p.attempt}:null;

// The front service owns no business object constructors, recovery routines,
// registries, compilers or queues. It reads atomic records and immutable assets;
// every operation outside the explicit GET allowlist goes to the sole writer.
export async function createReadService(options){
  const {root,dataRoot,config,fixture,auth,metadata,backendPort,paperIds=[],humanSettings}=options;
  let port=options.port,state=options.initialState||{busy:true,observedAt:null},closing=false;
  const store=Object.assign(Object.create(Store.prototype),{root:dataRoot,config,fixture});
  const human=Object.assign(Object.create(HumanRouting.prototype),{enabled:!!humanSettings?.enabled,settings:humanSettings,root:path.join(dataRoot,'fragment-human'),store,q:{store,paperIds:()=>paperIds}});
  const settingsFile=path.join(dataRoot,'cli-pools/settings.json');
  const dashboard=()=>({...taskDashboard({store,sources:{assignments:()=>rows(path.join(dataRoot,'source-executors/assignments'))},blindExecutors:{assignments:()=>rows(path.join(dataRoot,'blind-executors/assignments'))},math:{requests:{all:()=>rows(path.join(dataRoot,'blind/tool-requests'))}},pools:{read:()=>fs.existsSync(settingsFile)?readJSON(settingsFile):{schemaVersion:1,revision:0,source:2,blind:4,...options.poolDefaults}}}),fragmentHuman:human.enabled?human.statusMany(paperIds):[]});
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  const file=(res,target,mime,expected)=>{check(fs.statSync(target).isFile(),'Missing artifact',404);const bytes=fs.readFileSync(target);if(expected)check(sha(bytes)===expected,'Artifact hash changed',409,'EVIDENCE_CHANGED');res.writeHead(200,{'Content-Type':mime||({'.png':'image/png','.pdf':'application/pdf','.tex':'text/plain; charset=utf-8','.json':'application/json','.txt':'text/plain; charset=utf-8'})[path.extname(target)]||'application/octet-stream','Content-Length':bytes.length});res.end(bytes);};
  const browser=req=>check((req.headers.cookie||'').split(';').map(x=>x.trim()).includes('review_desk_'+port+'='+auth.cookie),'Open the private local launch link first',401,'LOGIN_REQUIRED');
  const caseExplanations=loadCaseExplanations(root);
  const caseView=key=>{const r=store.request(key),s=store.state(key);return {request:{id:r.id,fixture:r.fixture,spec:r.spec,intentDigest:r.intentDigest,version:r.version,source:r.source,main:r.main,engine:r.engine,artifacts:r.artifacts,candidateRender:r.candidateRender,humanEscalation:r.humanEscalation||null,baseBuild:{pdfSha256:r.baseBuild.pdfSha256,inputSha256:r.baseBuild.inputSha256}},humanExplanationZh:localizeCaseExplanations(r,caseExplanations),state:s,preview:s.latestPreview?preview(store.preview(s.latestPreview)):null};};
  const proxy=(req,res)=>{const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,headers:{...req.headers,connection:'close'},agent:false},reply=>{for(const [key,value] of Object.entries(reply.headers))if(value!==undefined&&!['connection','keep-alive','transfer-encoding'].includes(key))res.setHeader(key,value);res.writeHead(reply.statusCode);reply.on('error',()=>res.destroy());reply.pipe(res);});upstream.on('error',()=>{if(!res.headersSent)json(res,502,{error:'Business service is temporarily unavailable; preserve the request and reconcile its receipt before retrying a write.',code:'BACKEND_UNAVAILABLE'});else res.end();});req.on('aborted',()=>upstream.destroy());req.pipe(upstream);};
  const server=http.createServer((req,res)=>{for(const [key,value] of Object.entries(headers))res.setHeader(key,value);
    try{
      const origin='http://127.0.0.1:'+port;check(req.headers.host==='127.0.0.1:'+port,'Host rejected',403,'HOST');if(req.headers.origin)check(req.headers.origin===origin,'Cross-origin request rejected',403,'ORIGIN');if(req.headers['sec-fetch-site'])check(['same-origin','none'].includes(req.headers['sec-fetch-site']),'Cross-site request rejected',403);check(!closing,'Service is draining existing connections',503,'SERVICE_DRAINING');
      const url=new URL(req.url,origin),parts=url.pathname.split('/').filter(Boolean);
      if(req.method!=='GET')return proxy(req,res);
      if(url.pathname==='/health'){const age=state.observedAt?Date.now()-Date.parse(state.observedAt):Infinity;return json(res,200,{...metadata,busy:age>1500?true:state.busy,readService:{independentThread:true,backendObservedAt:state.observedAt,backendStateFresh:age<=1500}});}
      if(staticFiles.has(url.pathname)){const name=url.pathname==='/'?'index.html':url.pathname.slice(1);return file(res,path.join(root,'public',name),name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');}
      const readPath=['/api/bootstrap','/api/cases','/api/tasks'].includes(url.pathname)||parts[0]==='api'&&['cases','previews'].includes(parts[1])||parts[0]==='api'&&parts[1]==='tasks'&&parts[4]==='receipt';
      if(!readPath)return proxy(req,res);browser(req);
      if(url.pathname==='/api/bootstrap')return json(res,200,{csrf:auth.csrf,fixture,instanceId:metadata.instanceId,uiVersion:options.uiVersion,mode:fixture?'fixture':'production',wake:state.wake,papers:Object.values(config.papers).map(p=>({paperId:p.paperId,title:p.title,owner:p.owner,engine:p.engine})),items:store.list()});
      if(url.pathname==='/api/cases')return json(res,200,{uiVersion:options.uiVersion,items:store.list(),wake:state.wake});
      if(url.pathname==='/api/tasks')return json(res,200,dashboard());
      if(parts[1]==='tasks'&&parts[4]==='receipt'){const row=dashboard().tasks.find(r=>r.pool===parts[2]&&r.assignmentId===parts[3]);check(row,'Unknown task receipt',404);return json(res,200,{assignmentId:row.assignmentId,paperId:row.paperId,attemptId:row.attemptId,kind:row.kind,deliveryVerified:row.deliveryVerified,phase:row.phase,reportId:row.reportId,requestId:row.requestId,problemCode:row.problemCode,paperSignoff:false,scope:'此处仅为工单交付状态；论文签核和人工接受独立记录。'});}
      if(parts[1]==='cases'){
        const key=id(parts[2]);if(parts.length===3)return json(res,200,caseView(key));
        if(parts[3]==='assets'){const r=store.request(key);check(Object.hasOwn(r.artifacts,parts[4]),'Unknown artifact',404);const pack=path.join(store.caseRoot(key),'package'),rel=r.artifacts[parts[4]],expected=readJSON(path.join(pack,'seal.json')).files.find(f=>f.file===rel)?.sha256;check(expected,'Missing artifact seal',409);return file(res,safePath(pack,rel),undefined,expected);}
        if(parts[3]==='result'){const s=store.state(key);check(s.verification,'No verified result yet',404);return file(res,safePath(dataRoot,'results/'+id(s.verification.packageId)+'/'+(parts[4]==='tex'?'result.tex':'result.pdf')),undefined,parts[4]==='tex'?s.verification.texSha256:s.verification.pdfSha256);}
      }
      if(parts[1]==='previews'){const p=store.preview(parts[2]);if(parts.length===3)return json(res,200,preview(p));check(p.status==='succeeded'&&Object.hasOwn(p.artifacts,parts[4]),'Preview artifact unavailable',404);return file(res,safePath(path.join(dataRoot,'previews',p.id),p.artifacts[parts[4]]),undefined,p.artifactHashes?.[parts[4]]||(parts[4]==='pdf'?p.build.pdfSha256:undefined));}
      return json(res,404,{error:'Not found',code:'NOT_FOUND'});
    }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.message,code:error.code||'INTERNAL'});else res.end();}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});port=server.address().port;
  return {port,update(next){state=next;if(next.closing)closing=true;},close:()=>new Promise(resolve=>{closing=true;server.close(resolve);server.closeIdleConnections();}),server};
}
