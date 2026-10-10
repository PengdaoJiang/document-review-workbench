import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {fork,spawn} from 'node:child_process';import {once} from 'node:events';
import {ROOT} from '../setup.mjs';import {writeJSON,readJSON,hashFile,sha} from '../lib/io.mjs';import {createReadService} from '../lib/read-service.mjs';
const evidence=path.join(ROOT,'tests/runs/read-service-'+Date.now());fs.mkdirSync(evidence,{recursive:true});
function fixture(name){const root=path.join(evidence,name),dataRoot=path.join(root,'data'),pack=path.join(dataRoot,'cases/test-case/package');fs.mkdirSync(pack,{recursive:true});fs.mkdirSync(path.join(root,'public'));fs.writeFileSync(path.join(root,'public/index.html'),'<html>isolated page</html>');fs.writeFileSync(path.join(root,'public/app.js'),'void 0;');
 const request={id:'test-case',fixture:true,spec:{paperId:'p',kind:'equation',locator:{label:'isolated locator'},question:'synthetic question',target:{oldText:'x'}},artifacts:{originalCrop:'crop.png'},baseBuild:{pdfSha256:'a'.repeat(64),inputSha256:'b'.repeat(64)}};
 writeJSON(path.join(pack,'request.json'),request);writeJSON(path.join(pack,'seal.json'),{files:[{file:'crop.png',sha256:sha('synthetic pixels')}]});fs.writeFileSync(path.join(pack,'crop.png'),'synthetic pixels');writeJSON(path.join(dataRoot,'cases/test-case/state.json'),{version:1,status:'pending',updatedAt:new Date().toISOString(),draft:{version:0,tex:'x',note:''}});
 writeJSON(path.join(dataRoot,'cli-pools/settings.json'),{revision:1,source:8,blind:16});
 return {root,dataRoot,config:{root,project:root,papers:{p:{paperId:'p',title:'Synthetic',owner:'test'}}},fixture:true,auth:{cookie:'test-cookie',csrf:'test-csrf'},port:0,backendPort:1,paperIds:['p'],humanSettings:{enabled:true},metadata:{pid:process.pid,instanceId:'synthetic'},initialState:{busy:false,observedAt:new Date().toISOString()},uiVersion:'test-ui'};
}
const cookie=port=>({Cookie:'review_desk_'+port+'=test-cookie'});
async function get(port,url,headers=cookie(port)){return fetch('http://127.0.0.1:'+port+url,{headers,signal:AbortSignal.timeout(10000)});}
function files(root,rel=''){return fs.readdirSync(path.join(root,rel),{withFileTypes:true}).flatMap(e=>{const n=path.join(rel,e.name);return e.isDirectory()?files(root,n):[[n,hashFile(path.join(root,n))]];});}
function message(child,type){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',listener);reject(Error('Missing '+type));},15000),listener=value=>{if(value.type===type||value.type==='error'){clearTimeout(timer);child.off('message',listener);value.type==='error'?reject(Error(value.error)):resolve(value);}};child.on('message',listener);});}
test('read-only routes preserve auth, fresh atomic records, sealed bytes and leave no writes',async t=>{
 const f=fixture('records'),before=files(f.dataRoot),reader=await createReadService(f);t.after(()=>reader.close());const port=reader.port;
 assert.equal((await get(port,'/api/cases',{})).status,401);
 assert.equal((await get(port,'/api/cases',{...cookie(port),Origin:'https://foreign.invalid'})).status,403);
 const badHost=await new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port,path:'/api/cases',headers:{...cookie(port),Host:'localhost:'+port}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(badHost,403);
 assert.equal((await get(port,'/api/cases',{...cookie(port),'Sec-Fetch-Site':'cross-site'})).status,403);
 assert.equal((await (await get(port,'/api/bootstrap')).json()).csrf,'test-csrf');
 assert.equal((await (await get(port,'/api/cases')).json()).items[0].id,'test-case');
 assert.equal((await (await get(port,'/api/cases/test-case')).json()).state.draft.tex,'x');
 const tasks=await (await get(port,'/api/tasks')).json();assert.equal(tasks.settings.source,8);assert.equal(tasks.fragmentHuman.length,1);
 assert.equal(await (await get(port,'/api/cases/test-case/assets/originalCrop')).text(),'synthetic pixels');
 assert.deepEqual(files(f.dataRoot),before);
 const p=path.join(f.dataRoot,'cases/test-case/state.json'),s=readJSON(p);s.draft.tex='atomic revision';s.version++;writeJSON(p,s);assert.equal((await (await get(port,'/api/cases/test-case')).json()).state.draft.tex,'atomic revision');
 writeJSON(path.join(f.dataRoot,'cli-pools/settings.json'),{revision:2,source:0,blind:16});assert.equal((await (await get(port,'/api/tasks')).json()).settings.source,0);
 fs.writeFileSync(path.join(f.dataRoot,'cases/test-case/package/crop.png'),'tampered');const changed=await get(port,'/api/cases/test-case/assets/originalCrop');assert.equal(changed.status,409);assert.equal((await changed.json()).code,'EVIDENCE_CHANGED');
 const r=readJSON(path.join(f.dataRoot,'cases/test-case/package/request.json'));r.artifacts.originalCrop='../state.json';writeJSON(path.join(f.dataRoot,'cases/test-case/package/request.json'),r);writeJSON(path.join(f.dataRoot,'cases/test-case/package/seal.json'),{files:[{file:'../state.json',sha256:hashFile(p)}]});assert.equal((await get(port,'/api/cases/test-case/assets/originalCrop')).status,400);
 reader.update({busy:false,observedAt:new Date(Date.now()-10000).toISOString()});const health=await (await get(port,'/health',{})).json();assert.equal(health.busy,true);assert.equal(health.readService.backendStateFresh,false);
 reader.update({busy:false,observedAt:new Date().toISOString(),closing:true});assert.equal((await get(port,'/app.js',{})).status,503);
});
test('independent reader stays responsive while business main thread is blocked; mutations are forwarded exactly once',async t=>{
 const f=fixture('blocked'),child=fork(new URL('./read-service-host.mjs',import.meta.url),[],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr.on('data',c=>errors+=c);let stopped=false;
 t.after(async()=>{if(!stopped){const done=message(child,'stopped');child.send({type:'stop'});await done;}assert.equal(errors,'');});
 const ready=message(child,'ready');child.send({type:'start',options:f});const {port}=await ready;
 const blocked=message(child,'blocking'),unblocked=message(child,'unblocked');child.send({type:'block',ms:2400});await blocked;
 const started=performance.now(),reads=await Promise.all(['/health','/app.js','/api/cases','/api/cases/test-case','/api/tasks'].map(url=>get(port,url)));const elapsed=performance.now()-started;
 assert.ok(reads.every(r=>r.ok));assert.ok(elapsed<1200,'Reads were blocked by business main thread: '+elapsed);
 const body=JSON.stringify({operationId:'one-id',tex:'synthetic draft'}),writeStart=performance.now();const posted=fetch('http://127.0.0.1:'+port+'/api/cases/test-case/draft',{method:'POST',headers:{...cookie(port),Origin:'http://127.0.0.1:'+port,'X-Review-Token':'test-csrf','Content-Type':'application/json',Authorization:'Bearer fixture-only'},body,signal:AbortSignal.timeout(8000)});
 await unblocked;const response=await posted,value=await response.json();assert.equal(value.writes,1);assert.equal(value.body,body);assert.equal(value.authorization,'Bearer fixture-only');assert.equal(value.host,'127.0.0.1:'+port);assert.equal(response.status,200);assert.ok(response.headers.get('set-cookie').includes('test-backend-cookie'));
 assert.ok(performance.now()-writeStart>900,'Mutation bypassed the business main thread');
 const rejected=await fetch('http://127.0.0.1:'+port+'/api/cases/test-case/draft',{method:'POST',headers:{...cookie(port),'Content-Type':'application/json'},body});assert.equal(rejected.status,403);
 const delegated=await (await get(port,'/internal/read-probe')).json();assert.equal(delegated.writes,2);assert.equal(delegated.path,'/internal/read-probe');
 const done=message(child,'stopped');child.send({type:'stop'});await done;stopped=true;await assert.rejects(get(port,'/health',{}));
});
test('actual service uses a single business instance and closes its frontend before releasing runtime',async t=>{
 const f=fixture('full-server/review_desk'),config=path.join(f.root,'config.json'),disabled=path.join(f.root,'disabled.json');
 for(const entry of fs.readdirSync(ROOT,{withFileTypes:true}))if(entry.isFile()&&/\.(mjs|py)$/.test(entry.name))fs.copyFileSync(path.join(ROOT,entry.name),path.join(f.root,entry.name));
 for(const dir of ['lib','public'])fs.cpSync(path.join(ROOT,dir),path.join(f.root,dir),{recursive:true});
 const workerFile=path.join(f.root,'read-service-worker.mjs');fs.writeFileSync(workerFile,fs.readFileSync(workerFile,'utf8').replace('const service=await createReadService(workerData);',"const runtime=JSON.parse((await import('node:fs')).readFileSync((await import('node:path')).join(workerData.dataRoot,'runtime.json'),'utf8'));if(runtime.instanceId!==workerData.metadata.instanceId||runtime.pid!==workerData.metadata.pid||runtime.stoppedAt)throw Error('Service identity must be durable before public reads begin');const service=await createReadService(workerData);"));
 const library=path.join(f.root,'paper_library');fs.mkdirSync(library,{recursive:true});for(const name of ['promotion.mjs','library.mjs','workflow-contract.mjs','revocations.mjs'])fs.copyFileSync(path.join(ROOT,'paper_library',name),path.join(library,name));
 const sources=path.join(f.root,'sources');fs.mkdirSync(sources,{recursive:true});fs.copyFileSync(path.join(ROOT,'sources/resolve-source.mjs'),path.join(sources,'resolve-source.mjs'));
 writeJSON(path.join(f.root,'math-config.json'),{...readJSON(path.join(ROOT,'math-config.json')),stateRoot:path.join(f.root,'math-state')});
 writeJSON(config,{...f.config,tools:{node:process.execPath}});writeJSON(disabled,{enabled:false});
 const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const child=spawn(process.execPath,[path.join(f.root,'server.mjs'),'--mode=fixture','--data='+f.dataRoot,'--port='+port,'--config='+config,'--production-config='+disabled,'--source-config='+disabled,'--blind-config='+disabled],{windowsHide:true,stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',c=>stderr+=c);let exited=false;child.on('exit',()=>exited=true);
 const exit=once(child,'exit');let health;for(let n=0;n<100&&!health&&!exited;n++){try{const r=await get(port,'/health',{});if(r.ok)health=await r.json();}catch{}if(!health)await new Promise(r=>setTimeout(r,100));}
 t.after(()=>{if(!exited)child.kill();});assert.ok(health,'Service startup failed: '+stderr);assert.equal(health.pid,child.pid);assert.equal(health.readService.independentThread,true);
 const runtime=readJSON(path.join(f.dataRoot,'runtime.json'));assert.equal(runtime.instanceId,health.instanceId);assert.equal(runtime.readService.independentThread,true);
 const auth=readJSON(path.join(f.dataRoot,'credentials.json'));const session=await fetch('http://127.0.0.1:'+port+'/api/session',{method:'POST',headers:{Origin:'http://127.0.0.1:'+port,'Content-Type':'application/json'},body:JSON.stringify({key:auth.uiKey})});assert.equal(session.status,200);assert.match(session.headers.get('set-cookie'),new RegExp('review_desk_'+port+'='));
 const blocked=await fetch('http://127.0.0.1:'+port+'/internal/shutdown',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(blocked.status,403);
 const stop=await fetch('http://127.0.0.1:'+port+'/internal/shutdown',{method:'POST',headers:{Authorization:'Bearer '+auth.admin,'Content-Type':'application/json'},body:'{}'});assert.equal(stop.status,200);assert.equal((await stop.json()).stopping,true);const [code]=await exit;assert.equal(code,0,stderr);
 assert.ok(readJSON(path.join(f.dataRoot,'runtime.json')).stoppedAt);assert.equal(fs.existsSync(path.join(f.dataRoot,'server.lock')),false);await assert.rejects(get(port,'/health',{}));
});
