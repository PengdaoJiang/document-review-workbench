import fs from 'node:fs';
import path from 'node:path';
import {check,DeskError,hashObject,readJSON,writeJSON,now,id,hashFile} from './io.mjs';
import {forbiddenLocation} from './blind-input.mjs';
import {sourceCandidateBinding} from './source-binding.mjs';
import {sourceActorValid} from './source-actor.mjs';
import {legacyFaithfulBindingValid} from './source-binding-recovery.mjs';

export function roleField(condition,field,rule,details={}) {
  if(condition)return;
  const e=new DeskError('Invalid '+field+': '+rule,422,'ROLE_FIELD_INVALID');
  e.fields=[{field,rule,...details}];throw e;
}
export function neutralField(value,field,maxLength=8000) {
  roleField(typeof value==='string'&&!!value.trim(),field,'nonempty_string');
  roleField(value.length<=maxLength,field,'max_length',{maxLength,actualLength:value.length});
  roleField(!forbiddenLocation(value),field,'neutral_text_only');return value;
}
export function proposalPayload(body){const {proposalId,...payload}=body;return payload;}
export function proposalIdentity(body){return body.proposalId||hashObject(proposalPayload(body));}
export class DiscoveryLedger {
  constructor(blind){this.blind=blind;this.root=path.join(blind.root,'discoveries');fs.mkdirSync(this.root,{recursive:true});}
  all(){return fs.readdirSync(this.root).filter(f=>f.endsWith('.json')).map(f=>readJSON(path.join(this.root,f)));}
  save(x){writeJSON(path.join(this.root,x.id+'.json'),x);return x;}
  public(x){return {id:x.id,proposalId:x.proposalId,assignmentId:x.assignmentId,paperId:x.paperId,bundleId:x.bundleId,documentSha256:x.documentSha256,payloadSha256:x.payloadSha256,status:x.status,deliveryResolved:this.accepted(x),reportId:x.reportId,diagnostic:x.diagnostic,events:x.events};}
  accepted(x,seen=new Set()) {if(x.status==='accepted')return true;if(x.status==='human_decided'){const route=this.blind.humanRouting?.nodeRoute(x.bundleId,x.payload.nodeId);return route?.state==='human_decided'&&route.lock.decisionId===x.humanDisposition?.decisionId;}if(x.status!=='superseded'||seen.has(x.id))return false;seen.add(x.id);const next=this.all().find(n=>n.id===x.replacementId);return !!next&&next.assignmentId===x.assignmentId&&this.accepted(next,seen);}
  revise(cap,{proposalId,correctedPayload,reason}){
    const old=this.forCap(cap).find(x=>x.proposalId===proposalId);neutralField(reason,'reason',2000);
    if(old?.status==='superseded'){
      const next=this.all().find(x=>x.id===old.replacementId);
      check(next?.payloadSha256===hashObject(proposalPayload(correctedPayload))&&next.events[0]?.origin?.reason===reason,'A correction retry must match the existing immutable replacement and reason',409,'PROPOSAL_ID_CONFLICT');
      return {original:this.public(old),replacement:{...this.public(next),payload:next.payload}};
    }
    check(old?.status==='rejected','Only an explicitly rejected proposal can receive a correction',409,'PROPOSAL_ID_CONFLICT');
    roleField(['bundleId','documentSha256','nodeId','lane'].every(k=>correctedPayload[k]===old.payload[k]),'correctedPayload','same_frozen_issue_scope');
    const revisedId=hashObject({parent:old.id,payload:correctedPayload}).slice(0,64),next=this.discover(cap,{proposalId:revisedId,payload:correctedPayload,origin:{correctionOf:old.id,reason}});
    old.status='superseded';old.replacementId=next.id;old.events.push({at:now(),type:'explicit_correction',replacementId:next.id,reason});this.save(old);return {original:this.public(old),replacement:{...this.public(next),payload:next.payload}};
  }
  discover(cap,{payload,proposalId=proposalIdentity(payload),origin}) {
    check(cap.role==='reporter','Reporter required',403,'ROLE_DENIED');
    roleField(payload&&typeof payload==='object','payload','object');id(proposalId);
    const b=this.blind.bundle(cap.bundleId);
    roleField(payload.bundleId===b.id&&payload.documentSha256===b.public.document.sha256,'bundleId/documentSha256','assigned_frozen_version');
    const assignmentId=cap.discoveryAssignmentId||cap.assignmentId,key=hashObject({assignmentId,proposalId}).slice(0,24),body=proposalPayload(payload),digest=hashObject(body),file=path.join(this.root,key+'.json');
    if(fs.existsSync(file)){const old=readJSON(file);check(old.payloadSha256===digest,'A proposal identity cannot replace its original payload',409,'PROPOSAL_ID_CONFLICT');return old;}
    return this.save({id:key,proposalId,assignmentId,roleId:cap.roleId,paperId:b.paperId,bundleId:b.id,documentSha256:b.public.document.sha256,payloadSha256:digest,payload:body,status:'pending',createdAt:now(),events:[{at:now(),type:'discovered',...(origin?{origin}:{})}]});
  }
  transition(entry,status,extra={}) {
    const x=readJSON(path.join(this.root,entry.id+'.json'));
    if(x.status==='accepted')return x;
    Object.assign(x,extra,{status,updatedAt:now()});x.events.push({at:now(),type:status,...extra});return this.save(x);
  }
  submit(cap,body){
    const entry=this.discover(cap,{payload:body});
    const human=this.blind.humanRouting?.nodeRoute(cap.bundleId,body.nodeId,body.focusQuote||body.quote);
    if(human?.state==='human_decided'&&human.wholeNode!==false){
      const node=this.blind.viewBundle(cap.bundleId).nodes.find(n=>n.nodeId===body.nodeId);roleField(node&&body.quote===node.quote,'nodeId/quote','exact_assigned_node');
      const saved=this.transition(entry,'human_decided',{humanDisposition:{stableFragmentId:human.stableFragmentId,decisionId:human.lock.decisionId,closureBasis:'human_decided',mathematicalPass:false}});
      return {id:entry.id,status:'human_decided',scope:'Existing final user decision; no new blind judgment or duplicate human case.',delivery:this.public(saved)};
    }
    try{const report=this.blind.submit(cap,proposalPayload(body));this.transition(entry,'accepted',{reportId:report.id});return {...report,delivery:this.public(readJSON(path.join(this.root,entry.id+'.json')))};}
    catch(e){this.transition(entry,'rejected',{diagnostic:{code:e.code||'ROLE_REQUEST_REJECTED',...(e.fields?{fields:e.fields}:{})}});throw e;}
  }
  forCap(cap){return this.all().filter(x=>x.assignmentId===(cap.discoveryAssignmentId||cap.assignmentId)&&x.roleId===cap.roleId);}
  verifyDelivery(cap,body){
    const entries=this.forCap(cap),ids=body?.proposalIds;
    check(body?.complete===true&&Array.isArray(ids)&&new Set(ids).size===ids.length,'Explicit discovery reconciliation is required; sync the local outbox and declare every proposal',409,'DELIVERY_INCOMPLETE');
    check(entries.every(x=>ids.includes(x.proposalId)||this.accepted(x))&&ids.every(k=>entries.some(x=>x.proposalId===k))&&entries.every(x=>this.accepted(x)),'Discovered proposals are missing, rejected or not durably accepted',409,'DELIVERY_INCOMPLETE');return entries;
  }
}

const technicalAssessments=new Set(['encoding_error','resource_blocked','resource_or_dependency_gap','resource_timeout','runtime_failure','output_bound']);
export function mathTechnicalGap(blind,r){
  if(r.mathResult?.outcome==='encoding_error'||['math_resource_blocked','encoding_error'].includes(r.status))return true;
  const key=r.mathResult?.toolReceiptId;if(!key)return !!r.mathRecoveryPending;
  let t;if(typeof blind.read==='function'){try{const actual=blind.read('checks',key);if(actual.id===key)t=actual;}catch(e){if(e.code!=='ENOENT')throw e;}}else t=blind.all('checks').find(x=>x.id===key);
  return !t||t.executionCompleted===false||technicalAssessments.has(t.public?.evidence?.assessment);
}
export function faithfulDispositionValid(blind,r){
  const s=r.sourceObservation,p=blind.store.config.papers[r.paperId],d=r.ownerDisposition;
  const owned=d?.payload?.disposition==='faithful_source'&&(d.sourceActor?sourceActorValid(blind.store.root,r.paperId,p.owner,d.sourceActor)&&d.by===d.sourceActor.threadId&&s?.evidence?.reviewedBy===d.sourceActor.threadId&&hashObject(s?.evidence?.sourceActor)===hashObject(d.sourceActor):d.by===p.owner&&s?.evidence?.reviewedBy===p.owner);
  const legacy=s?.evidence?.reviewedBy==='authorized_source_bridge'&&(s.candidateBinding||legacyFaithfulBindingValid(blind,r));
  if(!s||s.reading!=='faithful_source_anomaly'||(!owned&&!legacy)||s.evidence.sourceSha256!==p.source.sha256)return false;
  try{
    const b=blind.bundle(s.bundleId),n=b.nodes.find(x=>x.semanticId===r.semanticId);
    if(!n||s.documentSha256!==b.public.document.sha256)return false;
    sourceCandidateBinding(blind,b,n);
    return hashFile(p.source.path)===p.source.sha256&&hashFile(path.join(blind.store.config.root,s.evidence.cropRelative))===s.evidence.cropSha256;
  }catch{return false;}
}
