import fs from 'node:fs';
import path from 'node:path';
import {readJSON,writeJSON,check,hashObject,now,id} from './lib/io.mjs';
const action=process.argv[2],opts=Object.fromEntries(process.argv.slice(3).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));
try{
 const session=readJSON(opts['--session']),payload=opts['--body']?readJSON(opts['--body']):{};let outbox;
 if(action!=='input'){try{id(payload.operationId);}catch(e){e.code='LOCAL_OPERATION_ID_INVALID';e.requestSent=false;throw e;}outbox=path.join(path.dirname(opts['--session']),'outbox',payload.operationId+'.json');const digest=hashObject({action,payload});if(fs.existsSync(outbox))check(readJSON(outbox).digest===digest,'Local operation ID/payload conflict');else writeJSON(outbox,{action,payload,digest,status:'pending',at:now()});}
 const response=await fetch(session.origin+'/api/source/'+action,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.secret},body:JSON.stringify({...payload,paperId:session.paperId,assignmentId:session.assignmentId,attemptId:session.attemptId})}),value=await response.json();
 let presented=value;
 if(response.ok&&action==='input'&&session.contextFormat){
  const {compactWorkerInput,CONTEXT_FORMAT}=await import('./worker-context.mjs');
  check(session.contextFormat===CONTEXT_FORMAT,'Unknown context format',409,'CONTEXT_FORMAT');
  const contextRoot=path.dirname(path.resolve(opts['--session']));
  if(opts['--out'])check(path.resolve(opts['--out'])===path.join(contextRoot,'input.json'),'Compact input must stay beside its session',409,'CONTEXT_PATH');
  presented=compactWorkerInput(value,{root:contextRoot,role:'source'});
  writeJSON(path.join(contextRoot,'input.json'),presented);
 }
 if(outbox)writeJSON(outbox,{...readJSON(outbox),status:response.ok?'accepted':'rejected',response:value,updatedAt:now()});if(opts['--out'])writeJSON(opts['--out'],presented);console.log(JSON.stringify(presented));if(!response.ok)process.exitCode=1;
}catch(e){const localId=e.code==='LOCAL_OPERATION_ID_INVALID'&&e.requestSent===false;console.error(JSON.stringify({error:e.message,code:e.code||'DELIVERY_UNKNOWN',...(localId?{requestSent:false,outboxCreated:false,operationIdRules:{maxLength:96,pattern:'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$'}}:{}),note:localId?'Rejected before outbox creation or HTTP. Preserve this diagnostic, choose a short valid operationId for this unsent request, and keep that ID and payload stable for subsequent retries.':'Inspect the same operation/outbox and retry the same ID and payload after reconciliation; do not create a replacement operation blindly.'}));process.exitCode=1;}
