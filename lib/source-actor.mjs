import fs from 'node:fs';
import path from 'node:path';
import {check,readJSON,writeJSON,hashObject,hashFile,safePath} from './io.mjs';

export function executionState(config,paperId,dataRoot=path.join(config.root,'data/production')){
 const file=path.join(dataRoot,'source-executors/registry/papers',paperId+'.json');return fs.existsSync(file)?readJSON(file):null;
}
export function assertLegacyExecution(config,paperId,dataRoot){check(executionState(config,paperId,dataRoot)?.mode!=='cli','Permanent owner execution was safely handed off; use the registered temporary worker',409,'OWNER_HANDED_OFF');}
export function persistSourceActor(dataRoot,paper,holder){
 check(holder.threadId&&holder.child&&holder.phase==='running','Actual fresh CLI identity has not registered',409,'WORKER_IDENTITY_PENDING');
 const proof={schemaVersion:1,paperId:paper.paperId,historicalOwner:paper.owner,writeRoot:path.resolve(paper.root),workerId:holder.workerId,threadId:holder.threadId,assignmentId:holder.assignmentId,attemptId:holder.attemptId,generation:holder.generation,tokenSha256:holder.tokenSha256,controller:holder.controller,child:holder.child};
 const relative='source-executors/actors/'+holder.workerId+'.json',file=path.join(dataRoot,relative);
 if(fs.existsSync(file))check(hashObject(readJSON(file))===hashObject(proof),'Execution identity changed',409,'WRITER_FENCED');else writeJSON(file,proof);
 return {...proof,proofRelative:relative,proofSha256:hashFile(file)};
}
export function sourceActorValid(dataRoot,paperId,owner,actor){
 try{return !!actor&&actor.paperId===paperId&&actor.historicalOwner===owner&&actor.threadId!==owner&&actor.proofRelative==='source-executors/actors/'+actor.workerId+'.json'&&hashFile(safePath(dataRoot,actor.proofRelative))===actor.proofSha256&&hashObject(readJSON(safePath(dataRoot,actor.proofRelative)))===hashObject(Object.fromEntries(Object.entries(actor).filter(([k])=>!['proofRelative','proofSha256'].includes(k))));}catch{return false;}
}
