import fs from 'node:fs';
import path from 'node:path';
import {readJSON,writeJSON,hashFile,check,now} from './lib/io.mjs';
import {PaperWriterRegistry} from './lib/paper-writer-registry.mjs';
import {launchFreshSourceWorker,verifyWorkerLogin} from './lib/codex-source-worker.mjs';
import {maintenancePaused} from './lib/cli-pool-settings.mjs';
import {progressRecorder} from './lib/cli-progress.mjs';
import {finalizeAcceptedRecheck} from './lib/blind-finalize.mjs';

const job=readJSON(process.argv[2]),registry=new PaperWriterRegistry(job.registryRoot);let lease,processExit,released=false;
try{
 check(!maintenancePaused(job.dataRoot),'Maintenance pause prevents blind admission',503,'MAINTENANCE_PAUSED');
 check(hashFile(job.cli)===job.cliSha256,'Upgraded CLI bytes changed',409,'CLI_CHANGED');
 const authProof=verifyWorkerLogin(job.cli);lease=await registry.acquire(job.paperId,job.assignmentId,job.attemptId);
 const response=await fetch(job.origin+'/api/blind-worker/session',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+lease.secret},body:JSON.stringify({paperId:job.paperId,assignmentId:job.assignmentId,attemptId:job.attemptId})});
 const activated=await response.json();if(!response.ok||activated.workspace!==job.workspace)writeJSON(path.join(job.runRoot,'activation-error.json'),{at:now(),httpStatus:response.status,code:activated.code||'SESSION_REJECTED',message:activated.error||'Workspace binding differs',assignmentId:job.assignmentId,attemptId:job.attemptId});check(response.ok&&activated.workspace===job.workspace,'Blind session activation failed: '+(activated.code||'SESSION_REJECTED'),503,'BLIND_SESSION_REJECTED');
 const protocolFile=path.join(job.workspace,'PROTOCOL.txt');check(hashFile(protocolFile)===activated.protocolSha256,'Neutral protocol changed');
 const schema=path.join(job.runRoot,'result-schema.json');writeJSON(schema,{type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['delivered','technical_gap']},summary:{type:'string'}},required:['status','summary']});
 check(!maintenancePaused(job.dataRoot),'Maintenance pause prevents CLI launch',503,'MAINTENANCE_PAUSED');
 await registry.launching(job.paperId,lease.secret,job.runRoot);
 const execution=launchFreshSourceWorker({cli:job.cli,cwd:job.workspace,runRoot:job.runRoot,prompt:fs.readFileSync(protocolFile,'utf8'),schema,role:'blind',authProof,onEvent:progressRecorder(job.runRoot),onStarted:pid=>registry.attachChild(job.paperId,lease.secret,pid),onThread:threadId=>registry.attachThread(job.paperId,lease.secret,threadId)});
 processExit=await execution.completion;
 if(processExit.exitCode===0)await finalizeAcceptedRecheck(job);
 for(let n=0;n<120&&!released;n++)try{await registry.release(job.paperId,lease.secret,{processExit,paperApproval:false});released=true;}catch(e){if(!['WRITER_BUSY','PAPER_WRITER_ACTIVE'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,1000));}
 writeJSON(path.join(job.runRoot,'supervisor-exit.json'),{at:now(),assignmentId:job.assignmentId,attemptId:job.attemptId,released,processExit,paperApproval:false});
}catch(e){
 if(lease&&registry.read(job.paperId).holder?.phase==='registered')try{await registry.release(job.paperId,lease.secret,{status:'technical_gap',code:e.code||'FAILED'});released=true;}catch{}
 writeJSON(path.join(job.runRoot,'supervisor-exit.json'),{at:now(),assignmentId:job.assignmentId,attemptId:job.attemptId,released:released||!lease,processExit:processExit||null,error:{code:e.code||'FAILED'},paperApproval:false});process.exitCode=1;
}
