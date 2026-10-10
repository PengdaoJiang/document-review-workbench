import path from 'node:path';
import {readJSON,check} from './io.mjs';
export function client(dataRoot,paperId){
  const rt=readJSON(path.join(dataRoot,'runtime.json')),a=readJSON(path.join(dataRoot,'credentials.json'));
  check(!rt.stoppedAt,'Review desk is stopped');
  return async(endpoint,body,method='POST')=>{
    const data={paperId,...body};const url='http://127.0.0.1:'+rt.port+'/api/worker/'+endpoint+(method==='GET'?'?'+new URLSearchParams(data):'');
    const r=await fetch(url,{method,headers:{Authorization:'Bearer '+a.workers[paperId],...(method==='POST'?{'Content-Type':'application/json'}:{})},body:method==='POST'?JSON.stringify(data):undefined,signal:AbortSignal.timeout(60000)});
    const b=await r.json();check(r.ok,b.error||'Worker request failed',r.status,b.code);return b;
  };
}
