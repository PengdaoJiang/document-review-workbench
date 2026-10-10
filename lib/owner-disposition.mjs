import fs from 'node:fs';import path from 'node:path';
import {check,hashObject,hashFile,writeJSON,now,DeskError} from './io.mjs';
import {verifyAuthority} from './inputs.mjs';import {sourceCandidateBinding} from './source-binding.mjs';
import {registerLocator,recordSourceObservation,ownerEngine} from './blind-bridge.mjs';
import {preparePackage} from './package.mjs';import {renderSource} from './build.mjs';
import {sourceActorValid} from './source-actor.mjs';

export function validateOwnerDisposition(blind,paperId,body,{sourceActor}={}){
 try{return validateOwnerDispositionBeforeCommit(blind,paperId,body,{sourceActor});}catch(e){if(!e.sourcePrecondition)e.sourcePrecondition={kind:'disposition_precondition',businessMutationStarted:false,bundleId:body.bundleId,reportId:body.id};throw e;}
}
function validateOwnerDispositionBeforeCommit(blind,paperId,body,{sourceActor}={}){
 const r=blind.report(body.id),p=blind.store.config.papers[paperId],b=blind.bundle(body.bundleId),n=b.nodes.find(n=>n.semanticId===r.semanticId);
 check(p&&r.paperId===paperId,'Owner differs',403);check(!blind.matchRuling(r)&&!['closed_ruling','closed_completion','closed_source_correction'].includes(r.status),'A closed local decision cannot be reopened by an owner disposition',409,'ALREADY_DECIDED');
 check(b.paperId===paperId&&b.owner===p.owner&&n&&body.bundleId===b.id,'Exact current owner-frozen input and local semantic identity required',409,'VERSION_CONFLICT');
 if(body.documentSha256!==b.public.document.sha256){const error=new DeskError('documentSha256 must equal the selected bundle.public.document.sha256; manifest.sha256 and the main-file hash name different objects',409,'DOCUMENT_BINDING_MISMATCH');error.sourcePrecondition={kind:'disposition_document_sha256',businessMutationStarted:false,bundleId:b.id,expectedDocumentSha256:b.public.document.sha256};throw error;}
 check(['transcription_uncertain','faithful_source','technical_gap','repair'].includes(body.disposition),'Name the source or technical disposition');
 check(typeof body.note==='string'&&body.note.length>=40&&body.note.length<=8000,'Bounded owner diagnosis required');
 check(!r.caseId||r.ownerDisposition?.bodySha256===hashObject(body),'An existing human case is not replaced by a new disposition',409);
 if(body.disposition==='technical_gap'){check(['compile','source_access','version_conflict','tool_unavailable','unsupported_return'].includes(body.technicalKind),'Technical gap category required');return {r,p,b,n};}
 verifyAuthority(p);check(n,'Original target required');sourceCandidateBinding(blind,b,n);
 check((sourceActor?sourceActorValid(blind.store.root,paperId,p.owner,sourceActor)&&body.evidence?.reviewedBy===sourceActor.threadId:body.evidence?.reviewedBy===p.owner)&&body.evidence.sourceSha256===p.source.sha256&&body.evidence.mappingSha256===(p.mapping?.sha256||null)&&typeof body.evidence.reference==='string'&&body.evidence.reference.length>=20,'Registered source worker check and seals required');
 check(body.locator&&Number.isInteger(body.locator.page)&&body.locator.page>=1&&body.locator.page<=p.source.pages&&Array.isArray(body.locator.bbox)&&body.locator.bbox.length===4&&body.locator.bbox.every(Number.isFinite),'Readable original locator required');
 if(body.disposition==='transcription_uncertain'){
  const q=body.sourceQuestion;check(q&&['unreadable','conflicting_readings','repeated_correction_failure'].includes(q.reason),'Only genuine transcription uncertainty reaches the human');
  check(typeof q.explanation==='string'&&q.explanation.length>=40&&q.explanation.length<=8000&&typeof q.question==='string'&&q.question.length>=5&&q.question.length<=4000,'Bounded source check and exact human decision required');
  check(Array.isArray(q.readings)&&q.readings.length>=2&&q.readings.length<=12&&q.readings.every(x=>typeof x==='string'&&x.length>=1&&x.length<=4000)&&new Set(q.readings).size===q.readings.length,'At least two distinct readings required');
 }
 if(body.disposition==='repair'){check(['construction','transcription_correction'].includes(body.repairKind),'Name construction or proved transcription correction');check(body.completionScope&&Object.keys(body.completionScope).length===3&&['question','conditions','closure'].every(k=>typeof body.completionScope[k]==='string'&&body.completionScope[k].length>=10&&body.completionScope[k].length<=8000),'Bounded neutral repair scope required');check(Array.isArray(body.affectedSemanticIds)&&body.affectedSemanticIds.length>0&&body.affectedSemanticIds.length<=8&&new Set(body.affectedSemanticIds).size===body.affectedSemanticIds.length&&body.affectedSemanticIds[0]===n.semanticId,'Primary and affected fragment identities required');
  if(body.repairSpan){const t=body.repairSpan;check(t&&typeof t==='object'&&!Array.isArray(t)&&typeof t.file==='string'&&typeof t.oldText==='string','repairSpan is the raw target descriptor {file,anchorId,oldText,oldSha256,before,after}, not an enclosing node. Use node.target exactly, or omit repairSpan when the ordinary frozen node is the intended scope.',422,'REPAIR_SPAN_SHAPE');check(body.affectedSemanticIds.length===1&&t.file===n.target.file&&typeof t.oldText==='string'&&t.oldText.length<=32768&&t.oldText.includes(n.target.oldText),'One bounded exact repair span covering the reported fragment required');sourceCandidateBinding(blind,b,{...n,target:t});}
  for(const semanticId of body.affectedSemanticIds){const affected=b.nodes.find(x=>x.semanticId===semanticId);check(affected,'Affected fragment is not in the frozen input');sourceCandidateBinding(blind,b,affected);}
 }
 return {r,p,b,n};
}

// Only the registered owner submits a disposition. Retrying an accepted packet
// is technical assembly of that same immutable payload, not another adjudication.
export async function ownerDisposition(blind,paperId,body,{sourceActor,authority,correction}={}){
 const existing=blind.report(body.id),digest=hashObject(body);
 check(existing.paperId===paperId,'Owner differs',403);
 const human=blind.humanRouting?.reportRoute(existing);
 if(human?.state==='human_required')return blind.humanRouting.assemble(existing.id,{authority});
 blind.humanRouting?.assertReportAction(existing,'source_disposition');
 if(existing.ownerDisposition?.bodySha256===digest&&!existing.ownerDisposition.technicalFailure&&['awaiting_human','source_anomaly_preserved','owner_technical_blocked','owner_rework','completion_recheck','closed_completion','closed_source_correction'].includes(existing.status))return {id:existing.id,status:existing.status,caseId:existing.caseId,duplicate:true};
 const {r,p,b,n}=validateOwnerDisposition(blind,paperId,body,{sourceActor});
 check(!r.ownerDisposition||r.ownerDisposition.bodySha256===digest||['technical_gap','repair'].includes(r.ownerDisposition.payload.disposition),'Previous owner disposition is immutable; retain its result',409);
 if(r.ownerDisposition&&r.ownerDisposition.bodySha256!==digest)r.ownerDispositionHistory=[...(r.ownerDispositionHistory||[]),r.ownerDisposition];
 r.ownerDisposition=r.ownerDisposition?.bodySha256===digest?r.ownerDisposition:{bodySha256:digest,payload:body,at:now(),priorStatus:r.status,by:sourceActor?.threadId||p.owner,...(sourceActor?{sourceActor}:{}),...(correction?{correction}:{})};
 if(body.disposition==='technical_gap'){
  r.status='owner_technical_blocked';r.ownerReturnAttention={at:now(),problem:body.note,technicalKind:body.technicalKind};r.events.push({at:now(),type:r.status});blind.save('reports',r);return {id:r.id,status:r.status,technicalKind:body.technicalKind};
 }
 registerLocator(blind,paperId,b.id,n.nodeId,body.locator,body.evidence,{sourceActor});blind.save('reports',r);
 if(body.disposition==='faithful_source'&&blind.humanRouting?.reconcileReport(r)?.state==='human_required')return blind.humanRouting.assemble(r.id,{authority});
 if(body.disposition==='repair'){
  if(r.ownerReceipt)r.ownerReturnHistory=[...(r.ownerReturnHistory||[]),{id:r.id,paperId:r.paperId,semanticId:r.semanticId,bundleId:r.bundleId,reworkBaseBundleId:r.reworkBaseBundleId,screening:r.screening,returnedBundleId:r.returnedBundleId,ownerReceipt:r.ownerReceipt}];
  r.reworkBaseBundleId=b.id;delete r.ownerReceipt;delete r.returnedBundleId;
  r.status='source_triage';r.events.push({at:now(),type:'owner_registered_source_repair',kind:body.repairKind});blind.save('reports',r);
  blind.screen(r.id,{action:'owner_rework',reason:'Original paper owner verified a bounded source repair; no implementation-model content decision.',reworkKind:body.repairKind,completionScope:body.completionScope,affectedSemanticIds:body.affectedSemanticIds,...(body.repairSpan?{repairSpan:body.repairSpan}:{})});const accepted=blind.receiveRework(paperId,r.id);return {id:r.id,status:accepted.status,receivedAt:accepted.receivedAt,repairKind:body.repairKind,affectedSemanticIds:body.affectedSemanticIds,action:'Continue this repair in the same owner working directory, then return its actual build and comparison.'};
 }
 if(body.disposition==='faithful_source'){
  const out=path.join(blind.root,'owner-source',r.id,digest),receiptFile=path.join(out,'render.json');let render,observed;
  authority?.trackRoot?.(out);
  try{if(fs.existsSync(receiptFile))render=JSON.parse(fs.readFileSync(receiptFile,'utf8'));else{render=await renderSource(blind.store.config,p,body.locator,p.source.path,out);writeJSON(receiptFile,render);}
   const crop=path.join(out,render.pages[0].cropFile);
   observed=recordSourceObservation(blind,r.id,{id:r.id,bundleId:b.id,documentSha256:b.public.document.sha256,reading:'faithful_source_anomaly',note:body.note,locator:body.locator,evidence:{...body.evidence,...(sourceActor?{sourceActor}:{}),cropRelative:path.relative(blind.store.config.root,crop).replaceAll('\\','/'),cropSha256:hashFile(crop)}});
  }catch(e){r.status='owner_technical_blocked';r.ownerDisposition.technicalFailure={at:now(),code:e.code||'SOURCE_RENDER_FAILED',message:e.message};r.ownerReturnAttention={at:now(),technicalKind:'source_access',problem:e.message};blind.save('reports',r);return {id:r.id,status:r.status,technicalGap:r.ownerDisposition.technicalFailure};}
  const completed=blind.report(r.id);
  if(completed.ownerDisposition?.technicalFailure){const failure=completed.ownerDisposition.technicalFailure;completed.ownerDisposition.technicalFailureHistory=[...(completed.ownerDisposition.technicalFailureHistory||[]),failure];delete completed.ownerDisposition.technicalFailure;delete completed.ownerReturnAttention;if(completed.status==='owner_technical_blocked')completed.status='source_anomaly_preserved';completed.events.push({at:now(),type:'source_assembly_recovered',dispositionSha256:digest,previousFailure:failure,sourceObservationSha256:completed.sourceObservation.bodySha256});blind.save('reports',completed);}
  if(blind.humanRouting?.reconcileReport(completed)?.state==='human_required')return await blind.humanRouting.assemble(r.id,{authority});
  return observed;
 }
 r.status='human_packet_pending';r.events.push({at:now(),type:'owner_transcription_uncertainty'});blind.save('reports',r);
 try{
  const q=body.sourceQuestion,candidateBinding=sourceCandidateBinding(blind,b,n);
  const spec={schemaVersion:1,paperId,owner:p.owner,issueId:'blind-'+r.id,revision:1,kind:n.kind,fixture:blind.store.fixture,category:'owner_transcription_uncertainty',reason:q.reason,boundedCheck:q.explanation,sourceQuestion:q,question:q.question,readings:q.readings,locator:body.locator,target:n.target,...ownerEngine(blind.store.root,p),ownerSourceOrigin:{reportId:r.id,bundleId:b.id,originalReportBundleId:r.bundleId,documentSha256:b.public.document.sha256,semanticId:n.semanticId,contentSha256:n.contentSha256,dispositionSha256:digest,candidateBinding,scope:'Current original-owner frozen transcription question; old mathematical evidence stays on its original bundle. No mathematical result or repeated rework is required.'}};
  let packageId=r.ownerDisposition.packageId;
  if(sourceActor)spec.ownerSourceOrigin.sourceActor=sourceActor;
  if(packageId&&sourceActor){const file=path.join(blind.store.root,'staging',packageId,'request.json');if(fs.existsSync(file)&&!readPackageActor(file,sourceActor)){r.ownerDisposition.packageHistory=[...(r.ownerDisposition.packageHistory||[]),{packageId,at:now(),reason:'Unaccepted package lacks its actual registered source actor; rebuild the same immutable question envelope.'}];delete r.ownerDisposition.packageId;packageId=null;blind.save('reports',r);}}
  if(!packageId){({packageId}=await preparePackage(blind.store.config,blind.store.root,spec,{fixture:blind.store.fixture,authority}));r.ownerDisposition.packageId=packageId;blind.save('reports',r);}
  const submitted=blind.store.submit(packageId,paperId);r.caseId=submitted.id;r.status='awaiting_human';delete r.ownerDisposition.technicalFailure;r.events.push({at:now(),type:'owner_question_in_human_pool',caseId:r.caseId});blind.save('reports',r);return {id:r.id,status:r.status,caseId:r.caseId};
 }catch(e){r.ownerDisposition.technicalFailure={at:now(),code:e.code||'PACKET_BUILD_FAILED',message:e.message};blind.save('reports',r);return {id:r.id,status:r.status,technicalGap:r.ownerDisposition.technicalFailure};}
}
function readPackageActor(file,actor){const recorded=JSON.parse(fs.readFileSync(file,'utf8')).spec?.ownerSourceOrigin?.sourceActor;return !!recorded&&hashObject(recorded)===hashObject(actor);}
