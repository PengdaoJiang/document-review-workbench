// Standalone neutral client. Its outbox contains only reviewer payloads and
// receipts, never capabilities or private source paths.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [sessionFile,action='input',payloadFile]=process.argv.slice(2);
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const session=read(sessionFile),dir=path.join(path.dirname(sessionFile),'outbox');
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const digest=x=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
const save=(file,x)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(x,null,2)+'\n');fs.renameSync(temp,file);};
const payload=payloadFile?read(payloadFile):{};
if(!Number.isInteger(session.port)||session.port<1024||session.port>65535||!['input','ack','report-scope','coverage','report','discover','revise-proposal','sync','delivery-complete','review-impact','math-inventory','math-open','encoding','tool','finish','recheck','worker-finish','worker-gap'].includes(action))throw Error('ROLE_REQUEST_REJECTED');
const failure=(code,details={})=>Object.assign(new Error(code),{public:{error:code,...details}});
async function post(endpoint,body){
  for(const delay of [0,400,1200,3000]){
    if(delay)await new Promise(r=>setTimeout(r,delay));
    let response;
    try{response=await fetch('http://127.0.0.1:'+session.port+'/role/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.capability},body:JSON.stringify(body)});}
    catch{if(delay!==3000)continue;throw failure('ROLE_TRANSPORT_UNKNOWN');}
    let result;try{result=await response.json();}catch{throw failure('ROLE_RESPONSE_UNAVAILABLE');}
    if(!response.ok)throw failure(result.code||'ROLE_REQUEST_REJECTED',{...(result.diagnostic?{diagnostic:result.diagnostic}:{}),...(result.fields?{fields:result.fields}:{})});
    if(!result||typeof result!=='object'||result.error)throw failure('ROLE_RESPONSE_UNAVAILABLE');
    return result;
  }
}
function journal(body){
  const {proposalId:explicit,...exact}=body,proposalId=explicit||digest(exact);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(proposalId))throw failure('PROPOSAL_ID_INVALID');
  const file=path.join(dir,proposalId+'.json'),sha256=digest(exact);
  if(fs.existsSync(file)){const old=read(file);if(old.payloadSha256!==sha256)throw failure('PROPOSAL_ID_CONFLICT');return {file,entry:old};}
  const entry={proposalId,payloadSha256:sha256,payload:exact,status:'pending',createdAt:new Date().toISOString(),events:[]};save(file,entry);return {file,entry};
}
async function deliver(body){
  const {file,entry}=journal(body);
  try{
    await post('discover',{proposalId:entry.proposalId,payload:entry.payload});
    const result=await post('report',{...entry.payload,proposalId:entry.proposalId});
    if(typeof result.id!=='string')throw failure('ROLE_RESPONSE_UNAVAILABLE');
    const receipt=result.delivery;
    if(!receipt||receipt.status!=='accepted'||receipt.reportId!==result.id||receipt.proposalId!==entry.proposalId||receipt.payloadSha256!==entry.payloadSha256||receipt.assignmentId!==(session.discoveryAssignmentId||session.assignmentId))throw failure('ROLE_RECEIPT_MISMATCH');
    entry.status='accepted';entry.receipt=result;entry.events.push({at:new Date().toISOString(),status:'accepted',reportId:result.id});save(file,entry);return result;
  }catch(e){entry.status=['ROLE_TRANSPORT_UNKNOWN','ROLE_RESPONSE_UNAVAILABLE','ROLE_RECEIPT_MISMATCH'].includes(e.public?.error)?'delivery_unknown':'rejected';entry.events.push({at:new Date().toISOString(),status:entry.status,diagnostic:e.public||{error:'ROLE_REQUEST_FAILED'}});save(file,entry);throw e;}
}
async function sync(){
  const entries=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>read(path.join(dir,f))):[];
  const problems=[];for(const x of entries.filter(x=>x.status!=='superseded'))try{await deliver({...x.payload,proposalId:x.proposalId});}catch(e){problems.push({proposalId:x.proposalId,...e.public});}
  if(problems.length)throw failure('DELIVERY_INCOMPLETE',{problems});return {complete:true,proposalIds:entries.map(x=>x.proposalId)};
}
try{
  let result;
  if(action==='report')result=await deliver(payload);
  else if(action==='discover'){const {entry}=journal(payload.payload||payload);result=await post('discover',{proposalId:entry.proposalId,payload:entry.payload});}
  else if(action==='revise-proposal'){
    result=await post(action,payload);const original=path.join(dir,payload.proposalId+'.json');
    if(fs.existsSync(original)){const old=read(original);old.status='superseded';old.events.push({at:new Date().toISOString(),type:'explicit_correction',receipt:result.original});save(original,old);}
    journal({...result.replacement.payload,proposalId:result.replacement.proposalId});
  }
  else if(action==='sync')result=await sync();
  else if(['coverage','math-inventory','delivery-complete'].includes(action)){
    const delivery=await sync();result=await post(action,{...payload,delivery});
  }else result=await post(action,payload);
  if(action==='input'&&session.contextFormat){
    const {compactWorkerInput,CONTEXT_FORMAT}=await import('./worker-context.mjs');
    if(session.contextFormat!==CONTEXT_FORMAT)throw failure('CONTEXT_FORMAT');
    result=compactWorkerInput(result,{root:path.dirname(path.resolve(sessionFile)),role:'blind'});
    save(path.join(path.dirname(sessionFile),'input.json'),result);
  }
  console.log(JSON.stringify(result,null,2));
}catch(e){console.log(JSON.stringify(e.public||{error:/^CONTEXT_[A-Z_]+$/.test(e.code||'')?e.code:'ROLE_REQUEST_FAILED'}));process.exitCode=1;}
