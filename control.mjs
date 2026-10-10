import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setup,credentials,ROOT} from './setup.mjs';
import {readJSON,check} from './lib/io.mjs';
const command=process.argv[2]||'status',options=Object.fromEntries(process.argv.slice(3).map(a=>a.split('=')));
const fixture=options['--mode']==='fixture',dataRoot=path.resolve(options['--data']||path.join(ROOT,'data',fixture?'fixture':'production'));
const maintenancePath=path.join(dataRoot,'maintenance-pause.json'),maintenance=fs.existsSync(maintenancePath)?readJSON(maintenancePath):null;
if(command==='start')check(!maintenance?.paused||options['--maintenance-drain']==='true','User maintenance pause is active. Normal startup is blocked; only receipt drain is permitted until an explicit user resume.',409,'MAINTENANCE_PAUSED');
const config=options['--config']?readJSON(options['--config']):setup(),auth=credentials(dataRoot,config);
const runtimePath=path.join(dataRoot,'runtime.json');
async function live(){if(!fs.existsSync(runtimePath))return null;const rt=readJSON(runtimePath);if(rt.stoppedAt)return null;try{const h=await fetch('http://127.0.0.1:'+rt.port+'/health',{signal:AbortSignal.timeout(1500)}).then(r=>r.json());return h.service==='paper-review-desk'&&h.instanceId===rt.instanceId&&h.pid===rt.pid?{...rt,busy:h.busy}:null;}catch{return null;}}
function link(rt){return 'http://127.0.0.1:'+rt.port+'/#access='+auth.uiKey;}
let rt=await live();
if(command==='start'){
  if(!rt){
    const lock=path.join(dataRoot,'server.lock');
    if(fs.existsSync(lock)){const x=readJSON(lock);let alive=true;try{process.kill(x.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}check(!alive,'Recorded service PID still exists; refusing to replace its lock');fs.unlinkSync(lock);}
    const out=fs.openSync(path.join(dataRoot,'service.stdout.log'),'a'),err=fs.openSync(path.join(dataRoot,'service.stderr.log'),'a');
    const child=spawn(config.tools.node,[path.join(ROOT,'server.mjs'),'--data='+dataRoot,'--mode='+(fixture?'fixture':'production'),'--port='+(options['--port']||(fixture?65432:config.port)),'--config='+(options['--config']||path.join(ROOT,'config.json')),...(options['--maintenance-drain']==='true'?['--maintenance-drain=true']:[])],{cwd:ROOT,detached:true,windowsHide:true,stdio:['ignore',out,err]});child.unref();fs.closeSync(out);fs.closeSync(err);
    for(let i=0;i<30&&!rt;i++){await new Promise(r=>setTimeout(r,300));rt=await live();}
    check(rt,'Service did not start. See its own stderr log; no other service was stopped.');
  }
  console.log(JSON.stringify({running:true,pid:rt.pid,port:rt.port,mode:rt.mode,url:link(rt)},null,2));
}else if(command==='stop'){
  check(rt,'No matching live review-desk service');
  const r=await fetch('http://127.0.0.1:'+rt.port+'/internal/shutdown',{method:'POST',headers:{Authorization:'Bearer '+auth.admin}}),b=await r.json();check(r.ok,b.error||'Stop failed');console.log(JSON.stringify(b));
}else if(command==='status'||command==='url')console.log(JSON.stringify(rt?{running:true,pid:rt.pid,port:rt.port,mode:rt.mode,busy:rt.busy,url:link(rt)}:{running:false},null,2));
else throw new Error('Use start, stop, status or url');
