import fs from 'node:fs';import path from 'node:path';
import {check,hashObject,hashFile,readJSON,writeJSON,immutableWrite,now,safePath,id} from './io.mjs';
import {verifyAuthority} from './inputs.mjs';
import {sourceCandidateBinding} from './source-binding.mjs';

// An additive system binding, never a new source reading or an owner signature.
export function inspectLegacyFaithful(blind,r){
 const s=r.sourceObservation,p=blind.store.config.papers[r.paperId];
 check(p&&s?.reading==='faithful_source_anomaly'&&s.evidence?.reviewedBy==='authorized_source_bridge'&&!s.candidateBinding&&!r.ownerDisposition,'Only the historical bridge observation missing its binding is eligible',409,'SOURCE_BINDING_RECOVERY_SCOPE');
 check(!r.caseId&&!blind.matchRuling(r),'A source migration cannot replace a human case or decision',409,'ALREADY_DECIDED');
 const {bodySha256,at,scope,...body}=s;
 check(bodySha256===hashObject(body)&&(!body.id||body.id===r.id),'Historical observation digest differs',409,'SOURCE_OBSERVATION_CHANGED');
 check(s.bundleId===r.bundleId,'Original report bundle differs',409,'VERSION_CONFLICT');
 const b=blind.bundle(s.bundleId),n=b.nodes.find(x=>x.semanticId===r.semanticId);
 check(b.paperId===r.paperId&&b.owner===p.owner&&n&&s.documentSha256===b.public.document.sha256,'Original source binding identity differs',409,'VERSION_CONFLICT');
 check(s.evidence.sourceSha256===p.source.sha256&&s.evidence.mappingSha256===(p.mapping?.sha256||null),'Historical source/exclusion seals differ',409,'AUTHORITY_CHANGED');verifyAuthority(p);
 check(s.locator?.page>=1&&s.locator.page<=p.source.pages&&Array.isArray(s.locator.bbox)&&s.locator.bbox.length===4&&s.locator.bbox.every(Number.isFinite),'Historical locator is incomplete',409,'SOURCE_BINDING_RECOVERY_SCOPE');
 check(/\.(png|jpe?g)$/i.test(s.evidence.cropRelative||''),'Historical crop reference required',409,'EVIDENCE_CHANGED');
 check(hashFile(safePath(blind.store.config.root,s.evidence.cropRelative))===s.evidence.cropSha256,'Historical source crop changed',409,'EVIDENCE_CHANGED');
 return {reportId:r.id,paperId:r.paperId,semanticId:r.semanticId,observationSha256:hashObject(s),bodySha256,bundleId:b.id,documentSha256:b.public.document.sha256,sourceSha256:p.source.sha256,mappingSha256:p.mapping?.sha256||null,locatorSha256:hashObject(s.locator),cropSha256:s.evidence.cropSha256,candidateBinding:sourceCandidateBinding(blind,b,n)};
}
export function legacyFaithfulBindingValid(blind,r){
 try{
  const m=r.sourceBindingMigration;if(!m||m.schemaVersion!==1||m.kind!=='legacy_source_binding' || m.receiptSha256!==hashObject(m.receipt))return false;
  const receipt=readJSON(safePath(blind.root,'source-binding-migrations/'+id(r.id)+'.json'));
  if(hashObject(receipt)!==m.receiptSha256||receipt.schemaVersion!==1||receipt.kind!=='legacy_source_binding'||!/^[a-f0-9]{64}$/.test(receipt.codeSha256))return false;
  if(hashFile(receipt.authority.path)!==receipt.authority.sha256)return false;
  const proof=inspectLegacyFaithful(blind,r);
  return Object.entries(proof).filter(([key])=>key!=='candidateBinding').every(([key,value])=>hashObject(value)===hashObject(receipt.proof[key]));
 }catch{return false;}
}
export async function recoverLegacyFaithful(q,key,{reason,validation}){
 check(q.v3&&typeof reason==='string'&&reason.length>=40&&validation&&hashFile(validation.path)===validation.sha256,'Tested technical binding recovery evidence required',409,'SOURCE_BINDING_RECOVERY_SCOPE');
 const old=q.blind.report(id(key)),paperId=old.paperId;
 return q.sources.registry.guard(paperId,()=>q.blindExecutors.registry.guard(paperId,()=>{
  check(!q.sources.registry.read(paperId).holder&&!q.blindExecutors.registry.read(paperId).holder,'Source binding recovery waits for both paper roles to release',409,'PAPER_WRITER_ACTIVE');
  const r=q.blind.report(key);q.blind.assertPaperOpen?.(paperId);
  if(r.sourceBindingMigration){check(legacyFaithfulBindingValid(q.blind,r),'Existing migration no longer validates',409,'SOURCE_BINDING_RECOVERY_STALE');return {reportId:key,recovered:true,duplicate:true};}
  const proof=inspectLegacyFaithful(q.blind,r),authority=q.settings.workflowAuthority;check(hashFile(authority.path)===authority.sha256,'Workflow authority changed',409,'AUTHORITY_CHANGED');
  const root=path.join(q.blind.root,'source-binding-migrations');fs.mkdirSync(root,{recursive:true});
  const receipt={schemaVersion:1,kind:'legacy_source_binding',at:now(),proof,authority,validation,reason,codeSha256:hashFile(new URL(import.meta.url)),actor:'review_desk_binding_migration',scope:'Retained historical source observation with freshly verified exact candidate and owner-return lineage. No new source judgment, mathematical pass or owner impersonation.'};
  const file=path.join(root,key+'.json');
  if(fs.existsSync(file)){const saved=readJSON(file);check(hashObject(saved.proof)===hashObject(proof)&&saved.authority.sha256===authority.sha256,'Interrupted recovery proof differs',409,'SOURCE_BINDING_RECOVERY_STALE');Object.assign(receipt,saved);}
  immutableWrite(path.join(root,key+'.before.json'),JSON.stringify(r,null,2)+'\n');immutableWrite(file,JSON.stringify(receipt,null,2)+'\n');
  r.sourceBindingMigration={schemaVersion:1,kind:'legacy_source_binding',receipt,receiptSha256:hashObject(receipt)};r.events.push({at:now(),type:'legacy_source_binding_recovered',receiptSha256:hashObject(receipt),sourceObservationUnchanged:true});q.blind.save('reports',r);
  check(legacyFaithfulBindingValid(q.blind,r),'Written source binding recovery failed verification',409,'SOURCE_BINDING_RECOVERY_STALE');q.kick();return {reportId:key,recovered:true,receiptSha256:hashObject(receipt)};
 }));
}
