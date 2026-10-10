import {compatibleHumanAuthority} from './human-authority.mjs';
import fs from 'node:fs';import path from 'node:path';
import {check,hashFile,hashObject,readJSON,writeJSON,immutableWrite,now,sha} from './io.mjs';

const routedStates=new Set(['human_required','awaiting_human','human_decided','human_decided_pending_mechanical_application']);
const scopedKinds=new Set(['recheck','reviewer_math','math_followup','owner_business','owner_resume','location']);
export function assignmentHumanRoute(q,a){
 if(!q.humanRouting?.enabled||a.packetOnly||a.requestId)return null;
 const kinds=a.kind?[a.kind]:(a.origins||[]).filter(x=>x.origin==='production').map(x=>typeof q.get==='function'?q.get(x.id)?.kind:q.jobs().find(j=>j.id===x.id)?.kind);
 if(!kinds.length||kinds.some(k=>!scopedKinds.has(k)))return null;
 const ids=[...new Set([a.reportId,...(a.businessIdentity?.reportIds||a.reportIds||[])].filter(Boolean))];if(!ids.length)return null;
 const routes=ids.map(id=>({reportId:id,route:q.humanRouting.reportRoute(q.blind.report(id))}));
 if(routes.some(x=>!routedStates.has(x.route?.state)))return null;
 return {authority:q.humanRouting.settings.authority,routes:routes.map(({reportId,route:r})=>({reportId,stableFragmentId:r.stableFragmentId,epoch:r.epoch,state:r.state,caseId:r.humanCase?.caseId||null,decisionId:r.lock?.decisionId||null,triggerProofSha256:r.proof?.sha256||null})),scope:'Required human workflow supersedes only this local work. No successful blind/source delivery or mathematical pass is inferred.'};
}
function operations(pool,a,kind){
 const roots=kind==='blind'?[path.join(pool.root,'operations',a.id)]:a.attempts.map(t=>path.join(t.runRoot,'operations')),out=[];
 for(const root of roots)if(fs.existsSync(root))for(const name of fs.readdirSync(root)){const f=name.endsWith('.json')?path.join(root,name):path.join(root,name,'operation.json');if(fs.existsSync(f))out.push({path:f,sha256:hashFile(f),record:readJSON(f)});}return out;
}
export async function handoffInactiveHumanWork(pool,a,kind){
 if(!['pending','technical_gap'].includes(a.status)||pool.registry.read(a.paperId).holder)return false;
 const q=pool.production,route=assignmentHumanRoute(q,a);if(!route)return false;
 return pool.registry.guard(a.paperId,async state=>{
  if(state.holder)return false;let current=pool.get(a.id);if(!['pending','technical_gap'].includes(current.status))return false;
  if(operations(pool,current,kind).some(o=>['started','interrupted'].includes(o.record.status)))return false;
  const observedDigest=hashObject(current),t=current.attempts.at(-1);let exit=null;
  if(t){const file=path.join(t.runRoot,'supervisor-exit.json');if(!fs.existsSync(file))return false;const bytes=fs.readFileSync(file),record=JSON.parse(bytes.toString('utf8')),fileSha256=sha(bytes);
   if(!record.released||record.assignmentId!==current.id||record.attemptId!==t.id)return false;
   if(t.supervisorIdentity){const live=await pool.registry.probe(t.supervisorIdentity.pid);if(live?.createdAt===t.supervisorIdentity.createdAt)return false;}
   exit={path:file,sha256:fileSha256,record};
  }
  current=pool.get(a.id);if(hashObject(current)!==observedDigest||!['pending','technical_gap'].includes(current.status))return false;
  if(exit&&hashFile(exit.path)!==exit.sha256)return false;
  const actual=assignmentHumanRoute(q,current);if(!actual||pool.registry.read(a.paperId).holder||operations(pool,current,kind).some(o=>['started','interrupted'].includes(o.record.status)))return false;
  const requests=path.join(q.blind.root,'tool-requests');if(fs.existsSync(requests)&&fs.readdirSync(requests).filter(f=>f.endsWith('.json')).map(f=>readJSON(path.join(requests,f))).some(r=>actual.routes.some(x=>x.reportId===r.reportId)&&['running','recovery_required'].includes(r.status)))return false;
  const record={schemaVersion:1,at:now(),assignmentId:current.id,paperId:current.paperId,kind,previousStatus:current.status,previousDelivery:current.delivery||null,previousProblemCode:current.problemCode||null,route:actual,exit,operations:operations(pool,current,kind).map(({path,sha256})=>({path,sha256})),scope:'Program handoff to required human workflow after verified inactivity; historical attempts and unknown deliveries are never labeled successful.'};
  const file=path.join(pool.root,'human-handoffs',current.id+'-'+hashObject(record).slice(0,16)+'.json');immutableWrite(file,JSON.stringify(record,null,2)+'\n');
  current.status='human_handoff';current.humanHandoff={path:file,sha256:hashFile(file)};current.events.push({at:now(),type:'required_human_workflow_handoff',receipt:current.humanHandoff});pool.save(current);
  for(const job of q.jobs().filter(j=>j.id===current.id||j.blindAssignmentId===current.id||j.sourceAssignmentId===current.id)){
   job.status='cancelled';job.humanHandoff=current.humanHandoff;job.result='superseded_by_required_human_workflow';job.events.push({at:now(),type:'human_handoff',scope:record.scope});q.save(job);
  }q.kick();return true;
 });
}
export function verifyHumanHandoff(q,a){
 try{const ref=a.humanHandoff;check(ref&&hashFile(ref.path)===ref.sha256,'Handoff receipt changed');const r=readJSON(ref.path),route=assignmentHumanRoute(q,a);check(r.assignmentId===a.id&&r.paperId===a.paperId&&route&&compatibleHumanAuthority(q.humanRouting.settings,r.route.authority),'Handoff scope changed');
  if(r.exit)check(hashFile(r.exit.path)===r.exit.sha256&&r.exit.record.released&&r.exit.record.assignmentId===a.id&&a.attempts.some(t=>t.id===r.exit.record.attemptId),'Natural exit evidence changed');
  for(const op of r.operations||[])check(hashFile(op.path)===op.sha256,'Handoff operation evidence changed');
  check(r.route.routes.every(x=>route.routes.some(y=>y.reportId===x.reportId&&y.stableFragmentId===x.stableFragmentId&&y.epoch===x.epoch)),'Fragment was reopened or moved');return true;
 }catch{return false;}
}
