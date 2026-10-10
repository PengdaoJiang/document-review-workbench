import fs from 'node:fs';
import path from 'node:path';
import {readJSON,writeJSON,now,hashObject} from './io.mjs';

// Transport closure only: a completed model turn cannot create business evidence.
// The current registered attempt must still pass the existing server finish gate.
export async function finalizeAcceptedRecheck(job,{fetcher=fetch}={}){
 const output=path.join(job.runRoot,'supervisor-finalization.json');
 const save=value=>{const result={at:now(),assignmentId:job.assignmentId,attemptId:job.attemptId,...value};writeJSON(output,result);return result;};
 if(fs.existsSync(path.join(job.runRoot,'delivery.json')))return save({attempted:false,status:'existing_delivery_record_preserved'});
 let input;
 try{
  const session=readJSON(path.join(job.workspace,'session.json'));
  const post=(action)=>fetcher(job.origin+'/role/'+action,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.capability},body:'{}',signal:AbortSignal.timeout(15000)});
  const r=await post('input');if(!r.ok)return save({attempted:false,status:'input_rejected',httpStatus:r.status});input=await r.json();
  const ops=input.recovery?.operations||[],accepted=ops.find(o=>o.action==='recheck'&&o.status==='accepted'&&o.payload?.bundleId===input.bundle?.bundleId&&o.result?.id===input.report?.id);
  if(input.execution?.assignmentId!==job.assignmentId||input.execution?.attemptId!==job.attemptId||input.execution?.kind!=='recheck'||!accepted||ops.some(o=>o.status==='started'||o.action==='worker-gap'&&o.status==='accepted'))return save({attempted:false,status:'no_complete_recheck_delivery'});
  const response=await post('worker-finish'),body=await response.json();
  if(!response.ok)return save({attempted:true,status:'finish_gate_rejected',httpStatus:response.status,code:body.code||'ROLE_REQUEST_REJECTED',acceptedRecheckOperationId:accepted.id});
  if(body.delivered!==true||body.paperApproval!==false||body.kind!=='recheck'||body.reportId!==input.report.id||hashObject(Object.fromEntries(Object.entries(body.receipt||{}).filter(([k])=>!['at','reviewer'].includes(k))))!==hashObject(accepted.payload))return save({attempted:true,status:'acknowledgement_unknown',acceptedRecheckOperationId:accepted.id});
  return save({attempted:true,status:'accepted_existing_recheck',acceptedRecheckOperationId:accepted.id,reportId:body.reportId,resultSha256:hashObject(body),newScientificJudgment:false});
 }catch{return save({attempted:!!input,status:'transport_unknown'});}
}
