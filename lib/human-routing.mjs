import fs from 'node:fs';
import path from 'node:path';
import {check,hashObject,hashFile,readJSON,writeJSON,immutableWrite,acquireLock,now,id,sha,safePath} from './io.mjs';
import {inputManifest,verifyAuthority} from './inputs.mjs';
import {sourceActorValid} from './source-actor.mjs';
import {ownerEngine} from './blind-bridge.mjs';
import {sourceCandidateBinding} from './source-binding.mjs';
import {mathTechnicalGap} from './review-ledger.mjs';
import {replaceExact,locate} from './target.mjs';
import {changedManifest} from './build.mjs';
import {preparePackage} from './package.mjs';
import {humanEditView} from './human-edit-view.mjs';
import {completionDeliveryReceipt} from './rework-evidence.mjs';
import {createFragmentLedger,transitionFragment,evaluateFragmentRouting,fragmentAliasKey,sealRoutingRecord,routingHash,textSha256,compareInitialReading} from './fragment-human-routing.mjs';
import {resolveInitialFragment,mapFragmentToBundle,projectFragmentToBundle,bindAliasProof,resolveFragmentAliases} from './fragment-alias-adapter.mjs';

const files=root=>fs.existsSync(root)?fs.readdirSync(root).filter(n=>n.endsWith('.json')).map(n=>readJSON(path.join(root,n))):[];
const workflowId='guided-reconstruction-20260930';
const finalActions=new Set(['accept','edit']);
const pendingStates=new Set(['human_required','awaiting_human','human_decided_pending_mechanical_application','technical_gap']);
const sealedBody=x=>{const {sha256,...body}=x;check(routingHash(body)===sha256,'Fragment ledger changed',409,'HUMAN_ROUTING_INTEGRITY');return x;};
const without=(x,keys)=>Object.fromEntries(Object.entries(x).filter(([k])=>!keys.includes(k)));

// A crop produced by the disposition author's accepted render operation is
// packet material for that exact locator, not a new source-reading verdict.
export function retainedDispositionCrop(blind,r,d){
 const actor=d?.sourceActor,p=blind.store.config.papers[r.paperId];if(!actor||!d.payload?.locator)return null;
 const af=path.join(blind.store.root,'source-executors/assignments',id(actor.assignmentId)+'.json');if(!fs.existsSync(af))return null;
 const a=readJSON(af);check(a.id===actor.assignmentId&&a.paperId===r.paperId&&a.reportId===r.id,'Retained crop assignment differs',409,'HUMAN_SOURCE_MATERIAL_GAP');
 const attempt=a.attempts.find(t=>t.id===actor.attemptId);check(attempt,'Retained crop attempt is missing',409,'HUMAN_SOURCE_MATERIAL_GAP');
 const root=blind.store.config.root,relative=f=>path.relative(root,f).replaceAll('\\','/'),run=safePath(root,relative(attempt.runRoot)),dir=path.join(run,'operations');if(!fs.existsSync(dir))return null;
 const geometry=loc=>loc&&{page:loc.page,bbox:loc.bbox},target=hashObject(geometry(d.payload.locator));
 for(const name of fs.readdirSync(dir).sort()){
  const file=path.join(dir,name,'operation.json');if(!fs.existsSync(file))continue;const op=readJSON(safePath(root,relative(file)));
  if(op.action!=='render'||op.status!=='accepted'||hashObject(geometry(op.payload?.locator))!==target)continue;
  check(op.id===name&&op.digest===hashObject({action:op.action,payload:op.payload})&&op.sourceActor?.workerId===actor.workerId&&hashObject(op.sourceActor)===hashObject(actor)&&hashObject(op.acceptedBy)===hashObject(actor)&&sourceActorValid(blind.store.root,r.paperId,p.owner,actor),'Retained render actor or request changed',409,'HUMAN_SOURCE_MATERIAL_GAP');
  const packetFile=safePath(root,relative(path.join(run,'packet.json'))),job=readJSON(safePath(root,relative(path.join(run,'job.json')))),packet=readJSON(packetFile);
  check(job.assignmentId===a.id&&job.attemptId===attempt.id&&job.paperId===r.paperId&&job.packetSha256===hashFile(packetFile)&&packet.assignmentId===a.id&&packet.reportId===r.id&&packet.paperId===r.paperId&&packet.source.sha256===p.source.sha256&&(packet.mapping?.sha256||null)===(p.mapping?.sha256||null),'Retained render launch/source seal changed',409,'HUMAN_SOURCE_MATERIAL_GAP');
  const rendered=op.result?.render?.pages,crop=op.result?.files?.[0]?.cropFile;
  check(op.result?.sourceSha256===p.source.sha256&&hashObject(geometry(op.result.locator))===target&&rendered?.length===1&&hashObject(geometry(rendered[0]))===target&&op.result.files?.length===1&&crop,'Retained render geometry changed',409,'HUMAN_SOURCE_MATERIAL_GAP');
  const cropFile=safePath(root,relative(crop.path)),expected=path.join(dir,name,'original',rendered[0].cropFile);
  check(path.resolve(cropFile)===path.resolve(expected)&&hashFile(cropFile)===crop.sha256,'Retained source crop bytes changed',409,'HUMAN_SOURCE_MATERIAL_GAP');verifyAuthority(p);
  return {id:relative(cropFile),sha256:crop.sha256,renderOperation:{path:relative(file),sha256:hashFile(file)},launchPacketSha256:job.packetSha256,dispositionSha256:d.bodySha256};
 }
 return null;
}

// This adapter authenticates stored business receipts. It never reads source
// pixels or assigns scientific polarity from a reviewer's prose.
export class HumanRouting {
 constructor(q,settings,{resolver=resolveInitialFragment,mapper=mapFragmentToBundle,packageBuilder=preparePackage}={}){
  this.q=q;this.blind=q.blind;this.store=q.store;this.settings=settings;this.enabled=!!settings?.enabled;this.resolver=resolver;this.mapper=mapper;this.packageBuilder=packageBuilder;
  this.root=path.join(this.store.root,'fragment-human');
  if(!this.enabled)return;
  check(settings.authority&&hashFile(settings.authority.path)===settings.authority.sha256,'Mandatory fragment human authority changed',409,'HUMAN_AUTHORITY_CHANGED');
  const a=readJSON(settings.authority.path);check(a.triggers?.sourceReadingAgreesWithInitialDraft&&a.triggers?.distinctNegativeBlindDecisionsOnSameFragment===2&&a.decisionLock?.automaticReopeningForNewEvidenceAllowed===false,'Exact user routing authority required',409,'HUMAN_AUTHORITY_CHANGED');
  for(const d of ['states','versions','reports','packets','gaps','confirmed','source-comparisons'])fs.mkdirSync(path.join(this.root,d),{recursive:true});
 }
 stateFile(key){return path.join(this.root,'states',id(key)+'.json');}
 beginEvaluation(){if(!this.evaluation)this.evaluation={depth:0,routes:new Map(),restrictions:new Map(),reconciled:new Set()};this.evaluation.depth++;}
 endEvaluation(){if(this.evaluation&&!--this.evaluation.depth)this.evaluation=null;}
 invalidateEvaluation(){this.evaluation?.routes.clear();this.evaluation?.restrictions.clear();this.evaluation?.reconciled.clear();}
 aliasResult(kind,identity){
  const row=this.preparedAliases?.get(hashObject({kind,identity}));if(row){if(!row.ok)throw Object.assign(Error(row.error.code),row.error);return structuredClone(row.result);}
  return (kind==='resolve'?this.resolver:this.mapper)(this.q,identity);
 }
 prepareAliases(reports){
  if(this.resolver!==resolveInitialFragment||this.mapper!==mapFragmentToBundle)return null;
  const requests=new Map(),add=(kind,identity)=>requests.set(hashObject({kind,identity}),{kind,identity});
  for(const r of reports){if(this.scope(r.paperId).published)continue;add('resolve',{paperId:r.paperId,bundleId:r.bundleId,nodeId:r.nodeId});
   const variants=[...(r.ownerDispositionHistory||[]).map(d=>d.payload?.bundleId),r.ownerDisposition?.payload?.bundleId,r.sourceObservation?.bundleId,...(r.reviews||[]).map(v=>v.bundleId)].filter(Boolean);
   for(const bundleId of variants){const b=this.blind.bundle(bundleId),n=b.nodes.find(n=>n.semanticId===r.semanticId);if(n)add('resolve',{paperId:r.paperId,bundleId,nodeId:n.nodeId});}
  }
  const entries=[...requests],rows=resolveFragmentAliases(this.q,entries.map(([,r])=>r));return new Map(entries.map(([key],i)=>[key,rows[i]]));
 }
 states(paperId){return files(path.join(this.root,'states')).filter(s=>!paperId||s.paperId===paperId).map(sealedBody);}
 scope(paperId){
  const list=this.q.paperIds?.()||this.q.settings.paperGroups.flat(),f=path.join(this.store.config.project,'paper_library/index.json');let published=false;
  if(fs.existsSync(f)){const row=readJSON(f).papers.find(p=>p.paperId===paperId);published=!!row?.currentEdition&&!!row.editionRecord&&row.acceptanceState!=='revoked_pending_blind';}
  return {paperId,workflowId,enrolled:list.includes(paperId),completed:published,published};
 }
 event(type,body,{receiptId,receiptSha256,role,actorId,businessDecisionId}){
  const receipt=sealRoutingRecord({status:'accepted',eventType:type,payloadSha256:routingHash(body),actorRole:role,actorId,originalReceipt:{id:receiptId,sha256:receiptSha256},...(businessDecisionId?{businessDecisionId}:{})});
  return {id:type+'-'+hashObject({receiptId,receiptSha256,body}).slice(0,40),type,body,receipt};
 }
 saveInitial(state){const f=this.stateFile(state.stableFragmentId);if(fs.existsSync(f))return sealedBody(readJSON(f));immutableWrite(f,JSON.stringify(state,null,2)+'\n');return state;}
 apply(state,event){
  const release=acquireLock(this.stateFile(state.stableFragmentId)+'.lock');
  try{const current=sealedBody(readJSON(this.stateFile(state.stableFragmentId))),result=transitionFragment(current,event,{scope:this.scope(state.paperId)});
   check(result.expectedPreviousSha256===current.sha256,'Fragment state changed',409,'HUMAN_ROUTING_CONFLICT');
   if(!result.duplicate){immutableWrite(path.join(this.root,'versions',current.stableFragmentId,result.state.sha256+'.json'),JSON.stringify(result.state,null,2)+'\n');writeJSON(this.stateFile(current.stableFragmentId),result.state);this.invalidateEvaluation();}return result.state;
  }finally{release();}
 }
 bind(paperId,bundleId,nodeId){
  const resolved=this.aliasResult('resolve',{paperId,bundleId,nodeId}),scope=this.scope(paperId);
  let state=this.saveInitial(createFragmentLedger({scope,freezeHistory:resolved.freezeHistory,initialFragment:resolved.initialFragment,initialDocumentText:resolved.initialBundle.public.document.text}));
  const to=resolved.currentFragment,key=fragmentAliasKey(to);
  if(!state.aliases.some(a=>a.key===key)){
   const raw=resolved.aliasProof.record||resolved.aliasProof,proof=raw.kind==='fragment_alias_mapping'?bindAliasProof(resolved,{scope,stableFragmentId:state.stableFragmentId}):sealRoutingRecord({...raw,fromKey:state.initial.fragmentKey,toKey:key,candidateKeys:[key],candidateStableFragmentIds:[state.stableFragmentId]});
   const body={fromKey:state.initial.fragmentKey,to,makeCurrent:false,aliasProof:proof};state=this.apply(state,this.event('alias',body,{receiptId:proof.record.originalEvidence.id,receiptSha256:proof.record.originalEvidence.sha256,role:'program',actorId:'verified_fragment_lineage'}));
  }
  return {state,resolved,key};
 }
 selectCurrent(binding){
  let {state,resolved,key}=binding;if(state.currentFragmentKey===key)return state;
  const raw=resolved.aliasProof?.record||resolved.aliasProof||{kind:'mechanical_edit_lineage',beforeInputSha256:state.initial.fragment.inputSha256,afterInputSha256:resolved.currentFragment.inputSha256,reverseMatchesBefore:true,originalEvidence:state.initial.freeze.receipt};
  const proof=raw.kind==='fragment_alias_mapping'?bindAliasProof(resolved,{scope:this.scope(state.paperId),stableFragmentId:state.stableFragmentId}):sealRoutingRecord({...raw,fromKey:state.initial.fragmentKey,toKey:key,candidateKeys:[key],candidateStableFragmentIds:[state.stableFragmentId]});
  return this.apply(state,this.event('alias',{fromKey:state.initial.fragmentKey,to:resolved.currentFragment,makeCurrent:true,aliasProof:proof},{receiptId:'current-'+proof.record.originalEvidence.id,receiptSha256:proof.record.originalEvidence.sha256,role:'program',actorId:'verified_current_human_target'}));
 }
 rememberReport(r,binding){
  const record={schemaVersion:1,reportId:r.id,paperId:r.paperId,reportSha256:hashObject(r),stableFragmentId:binding.state.stableFragmentId,fragmentKey:binding.key,bundleId:r.bundleId,nodeId:r.nodeId,authoritySha256:this.settings.authority.sha256};
  writeJSON(path.join(this.root,'reports',r.id+'.json'),record);return record;
 }
 addSource(state,r){
  // Every registered faithful disposition remains an event after later repairs.
  // Uncertain transcription already has its own human route and is never
  // relabeled a verified reading that agrees with the initial manuscript.
  const history=[...(r.ownerDispositionHistory||[]),r.ownerDisposition].filter(d=>d?.payload?.disposition==='faithful_source');
  for(const d of history)state=this.addSourceReceipt(state,r,d,null);
  if(r.sourceObservation?.reading==='faithful_source_anomaly')state=this.addSourceReceipt(state,r,null,r.sourceObservation);
  return state;
 }
 transcriptionCorrectionProof(state,reading){
  if(compareInitialReading(state.initial.fragment.tex,reading.currentFragment.tex).method!=='not_established')return null;
  const p=this.store.config.papers[state.paperId],proofs=[];
  for(const report of this.blind.all('reports').filter(r=>r.paperId===state.paperId))for(const ret of [report,...(report.ownerReturnHistory||[])]){
   if(!ret.ownerReceipt||!ret.returnedBundleId)continue;
   const ds=[...(report.ownerDispositionHistory||[]),report.ownerDisposition].filter(d=>d?.payload?.disposition==='repair'&&d.payload.repairKind==='transcription_correction'&&d.payload.bundleId===(ret.reworkBaseBundleId||ret.bundleId));
   for(const d of ds)try{
    const body=d.payload,prior=this.blind.bundle(body.bundleId),next=this.blind.bundle(ret.returnedBundleId),old=prior.nodes.find(n=>n.semanticId===ret.semanticId),node=next.nodes.find(n=>n.semanticId===ret.semanticId);
    if(!old||!node||old.quote!==state.initial.fragment.tex||node.quote!==reading.currentFragment.tex||old.quote===node.quote)continue;
    check(d.bodySha256===hashObject(body)&&body.id===report.id&&body.documentSha256===prior.public.document.sha256&&body.evidence?.reviewedBy===d.by&&body.evidence.sourceSha256===p.source.sha256&&body.evidence.mappingSha256===(p.mapping?.sha256||null),'Retained source correction changed',409,'HUMAN_SOURCE_CHANGE_GAP');
    check(d.sourceActor?sourceActorValid(this.store.root,state.paperId,p.owner,d.sourceActor)&&d.by===d.sourceActor.threadId:d.by===p.owner,'Retained source correction actor changed',409,'HUMAN_SOURCE_CHANGE_GAP');
    check(ret.screening?.reworkKind==='transcription_correction'&&hashObject(body.affectedSemanticIds)===hashObject(ret.screening.affectedSemanticIds),'Retained source correction scope changed',409,'HUMAN_SOURCE_CHANGE_GAP');
    const before=this.resolver(this.q,{paperId:state.paperId,bundleId:prior.id,nodeId:old.nodeId}),after=this.resolver(this.q,{paperId:state.paperId,bundleId:next.id,nodeId:node.nodeId});
    check([before,after].every(x=>x.initialBundle.id===state.initial.fragment.bundleId&&x.initialNode.nodeId===state.initial.fragment.nodeId),'Retained correction names another initial fragment',409,'HUMAN_SOURCE_CHANGE_GAP');
    const delivery=completionDeliveryReceipt(this.blind,ret,next);
    proofs.push(sealRoutingRecord({kind:'verified_source_transcription_correction',paperId:state.paperId,sourceSha256:p.source.sha256,mappingSha256:p.mapping?.sha256||null,initialFragmentKey:state.initial.fragmentKey,initialTexSha256:state.initial.fragment.texSha256,readingTexSha256:reading.currentFragment.texSha256,reportId:report.id,dispositionSha256:d.bodySha256,ownerReceiptSha256:hashObject(ret.ownerReceipt),deliverySha256:delivery.sha256,beforeAliasSha256:before.aliasProof.sha256,afterAliasSha256:after.aliasProof.sha256,readingAliasSha256:reading.aliasProof.sha256,claim:'Reuse the source owner\'s explicit proved transcription-correction disposition and exact built return. The program makes no new source or scientific judgment.'}));
   }catch{}
  }
  return proofs.sort((a,b)=>a.sha256.localeCompare(b.sha256))[0]||null;
 }
 addSourceReceipt(state,r,d,s){
  const p=this.store.config.papers[r.paperId],disposition='faithful_source';
  const payload=d?.payload,evidence=s?.evidence||payload.evidence,bundleId=s?.bundleId||payload.bundleId,b=this.blind.bundle(bundleId),n=b.nodes.find(x=>x.semanticId===r.semanticId);
  this.blind.viewBundle(b.id);
  if(s)check(s.bodySha256===hashObject(without(s,['bodySha256','candidateBinding','at','scope']))&&s.documentSha256===b.public.document.sha256&&(!s.id||s.id===r.id),'Stored source observation digest/document differs',409,'HUMAN_SOURCE_EVIDENCE_GAP');
  if(payload)check(payload.documentSha256===b.public.document.sha256,'Stored source disposition document differs',409,'HUMAN_SOURCE_EVIDENCE_GAP');
  check(n&&(!d||d.bodySha256===hashObject(payload))&&evidence.sourceSha256===p.source.sha256&&evidence.mappingSha256===(p.mapping?.sha256||null),'Stored source disposition changed',409,'HUMAN_SOURCE_EVIDENCE_GAP');
  const owned=d?.sourceActor?sourceActorValid(this.store.root,r.paperId,p.owner,d.sourceActor)&&d.by===d.sourceActor.threadId:d?.by===p.owner;
  const observationActor=s?.evidence?.sourceActor,observed=observationActor?sourceActorValid(this.store.root,r.paperId,p.owner,observationActor)&&evidence.reviewedBy===observationActor.threadId:evidence.reviewedBy===p.owner||evidence.reviewedBy==='authorized_source_bridge';
  check(owned||s&&observed,'Source disposition lacks its actual actor',409,'HUMAN_SOURCE_EVIDENCE_GAP');
  const binding=this.bind(r.paperId,b.id,n.nodeId);check(binding.state.stableFragmentId===state.stableFragmentId,'Source disposition maps to a different fragment',409,'HUMAN_FRAGMENT_ALIAS_GAP');state=sealedBody(readJSON(this.stateFile(state.stableFragmentId)));
  let crop=null;if(s?.evidence?.cropRelative){const f=safePath(this.store.config.root,s.evidence.cropRelative);check(hashFile(f)===s.evidence.cropSha256,'Source crop changed',409,'HUMAN_SOURCE_EVIDENCE_GAP');crop={id:s.evidence.cropRelative,sha256:s.evidence.cropSha256};}else if(d&&!r.sourceObservation)crop=retainedDispositionCrop(this.blind,r,d);
  const body={fragmentKey:binding.key,verifiedReading:true,sourceSha256:p.source.sha256,mappingSha256:p.mapping?.sha256||null,readingTex:n.quote,readingTexSha256:sha(n.quote),disposition,locator:s?.locator||payload.locator,...(crop?{crop}:{})};
  const original=s||d,receiptSha256=hashObject(original);state=this.apply(state,this.event('source_reading',body,{receiptId:'source-'+r.id+'-'+receiptSha256.slice(0,16),receiptSha256,role:'source',actorId:d?.by||evidence.reviewedBy}));
  const proof=this.transcriptionCorrectionProof(state,binding.resolved),prior=state.events.filter(e=>e.type==='source_reading_change_evidence'&&e.body.fragmentKey===binding.key&&e.body.readingTexSha256===sha(n.quote));
  check(proof||!prior.length,'Previously verified transcription-correction evidence is no longer valid',409,'HUMAN_SOURCE_CHANGE_GAP');
  if(proof){const body={fragmentKey:binding.key,readingTexSha256:sha(n.quote),proof};state=this.apply(state,this.event('source_reading_change_evidence',body,{receiptId:'source-correction-'+proof.sha256,receiptSha256:proof.sha256,role:'program',actorId:'verified_existing_transcription_correction'}));}
  return state;
 }
 addBlind(state,r,fragmentKey){
  const add=(body,original,actorId,key)=>{const receiptSha256=hashObject(original),businessDecisionId=key||'blind-'+r.id+'-'+receiptSha256;state=this.apply(state,this.event('blind_decision',{fragmentKey,reportId:r.id,businessDecisionId,opinion:body,...(r.duplicateOf?{duplicateOf:'report-'+r.duplicateOf+':initial'}:{})},{receiptId:businessDecisionId,receiptSha256,role:'blind',actorId,businessDecisionId}));};
  if(r.lane==='completion'){
   // This one historical finding's negative polarity was explicitly identified
   // in the user-authorized migration evidence; arbitrary legacy prose is not.
   const explicit=r.businessVerdict==='negative'||(r.id==='bed75f7d793d9d6509e0eae0'&&r.paperId==='r0176'&&r.classification==='bibliographic_structure_candidate');
   if(explicit)add({kind:'initial_business_finding',verdict:'negative'},Object.fromEntries(['id','bundleId','nodeId','lane','quote','question','evidence','conditions','closure','dispute','citations','focusQuote','classification','createdAt','businessVerdict'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]])),r.submittedBy?.threadId||'historical_blind_report','report-'+r.id+':initial');
  }
  for(const m of [...(r.previousMathResults||[]),r.mathResult].filter(Boolean)){
   if(m.outcome!=='contradiction')continue;
   const t=this.blind.read('checks',m.toolReceiptId);check(t.reportId===r.id&&t.success&&t.executionCompleted!==false&&t.encodingSha256===m.encodingSha256&&!mathTechnicalGap(this.blind,{...r,mathResult:m})&&(t.task?.operation!=='research'||t.public?.evidence?.conclusion==='contradiction'),'Negative mathematical receipt is not an actual conclusive completed check',409,'HUMAN_NEGATIVE_EVIDENCE_GAP');
   const toolReceipt=sealRoutingRecord({status:'completed',success:true,reportId:r.id,encodingSha256:m.encodingSha256,outcome:'contradiction',actualReceiptSha256:hashObject(t)});
   add({kind:'mathematical_review',outcome:'contradiction',encodingSha256:m.encodingSha256,toolReceipt},m,m.reviewer||'historical_blind_reviewer','math-'+r.id+'-'+m.toolReceiptId);
  }
  for(const v of r.reviews||[]){
   // Positive local reviews retain their exact original receipts. They add no
   // negative escalation event and make no claim about an enclosing paragraph.
   if(v.closed===true||v.failureKind==='technical_gap')continue;
   const b=this.blind.bundle(v.bundleId),n=b.nodes.find(n=>n.semanticId===r.semanticId);check(n,'Review return fragment missing',409,'HUMAN_FRAGMENT_ALIAS_GAP');const binding=this.bind(r.paperId,b.id,n.nodeId);check(binding.state.stableFragmentId===state.stableFragmentId,'Completion review maps to another fragment',409,'HUMAN_FRAGMENT_ALIAS_GAP');state=sealedBody(readJSON(this.stateFile(state.stableFragmentId)));
   const body={kind:'completion_review',closed:v.closed,...(v.failureKind?{failureKind:v.failureKind}:{})},businessDecisionId='completion-'+r.id+'-'+hashObject(without(v,['at']));
   state=this.apply(state,this.event('blind_decision',{fragmentKey:binding.key,reportId:r.id,businessDecisionId,opinion:body},{receiptId:businessDecisionId,receiptSha256:hashObject(v),role:'blind',actorId:v.reviewer||'historical_blind_reviewer',businessDecisionId}));
  }
  return state;
 }
 initialComparisonScope(r){
  const route=this.reportRoute(r);if(route?.state!=='technical_gap'||!route.proof?.gaps?.length||route.proof.gaps.some(g=>g.code!=='SOURCE_INITIAL_AGREEMENT_NOT_ESTABLISHED'))return null;
  check(!this.nodeRoute(r.bundleId,r.nodeId,r.focusQuote||r.quote,{finalOnly:true})?.lock,'A final human reading cannot be compared again',409,'HUMAN_FRAGMENT_LOCKED');
  const state=sealedBody(readJSON(this.stateFile(route.stableFragmentId))),sources=state.events.filter(e=>e.epoch===state.epoch&&e.type==='source_reading'&&e.body.crop&&e.body.locator);
  const readings=[...new Set(sources.map(e=>e.body.fragmentKey+':'+e.body.readingTexSha256))];check(readings.length===1,'Comparison requires one exact existing source reading',409,'SOURCE_COMPARISON_SCOPE');const source=sources.at(-1),f=state.aliases.find(a=>a.key===source.body.fragmentKey)?.fragment;
  check(f&&state.events.some(e=>e.id===route.proof.gaps[0].eventId),'Existing source reading is not the remaining comparison gap',409,'SOURCE_COMPARISON_SCOPE');
  const cropPath=safePath(this.store.config.root,source.body.crop.id);check(hashFile(cropPath)===source.body.crop.sha256,'Existing source crop changed',409,'SOURCE_COMPARISON_SCOPE');
  const scope={reportId:r.id,paperId:r.paperId,stableFragmentId:state.stableFragmentId,initialFragmentKey:state.initial.fragmentKey,initialTexSha256:state.initial.fragment.texSha256,fragmentKey:source.body.fragmentKey,readingTexSha256:source.body.readingTexSha256,sourceSha256:f.sourceSha256,mappingSha256:f.mappingSha256,sourceReceiptSha256:source.receipt.record.originalReceipt.sha256,crop:source.body.crop,locator:source.body.locator};
  return {scope,scopeSha256:hashObject(scope),initialTex:state.initial.fragment.tex,readingTex:f.tex,cropPath,sourceReceipt:source.receipt.record.originalReceipt,claim:'The source worker compares the two exact readings against existing source evidence. No mathematical judgment, manuscript edit or paper approval.'};
 }
 comparisonRecord(scopeSha256){const file=path.join(this.root,'source-comparisons',id(scopeSha256)+'.json');if(!fs.existsSync(file))return null;const r=readJSON(file),p=this.store.config.papers[r.scope?.paperId];check(r.scopeSha256===scopeSha256&&hashObject(r.scope)===scopeSha256&&r.bodySha256===hashObject(without(r,['at','bodySha256']))&&p&&sourceActorValid(this.store.root,r.scope.paperId,p.owner,r.sourceActor)&&r.reviewedBy===r.sourceActor.threadId,'Source comparison receipt changed',409,'SOURCE_COMPARISON_RECEIPT');return {file,sha256:hashFile(file),record:r};}
 recordInitialComparison(reportId,body,actor){
  const report=this.blind.report(reportId),p=this.store.config.papers[report.paperId];check(actor?.paperId===report.paperId&&sourceActorValid(this.store.root,report.paperId,p.owner,actor)&&body.reviewedBy===actor.threadId&&typeof body.agreesWithInitialDraft==='boolean'&&typeof body.note==='string'&&body.note.length>=40,'Actual source actor and explicit bounded comparison required',422,'SOURCE_COMPARISON_FIELDS');
  const old=this.comparisonRecord(body.scopeSha256);if(old){check(old.record.sourceActor.assignmentId===actor.assignmentId&&old.record.agreesWithInitialDraft===body.agreesWithInitialDraft&&old.record.note===body.note,'Source comparison cannot change under an accepted identity',409,'SOURCE_COMPARISON_CONFLICT');return old;}
  const expected=this.initialComparisonScope(report);check(expected&&expected.scopeSha256===body.scopeSha256,'Initial/source comparison scope is stale or protected',409,'SOURCE_COMPARISON_SCOPE');
  const core={schemaVersion:1,scope:expected.scope,scopeSha256:expected.scopeSha256,agreesWithInitialDraft:body.agreesWithInitialDraft,note:body.note,reviewedBy:body.reviewedBy,sourceActor:actor},record={...core,at:now(),bodySha256:hashObject(core)},file=path.join(this.root,'source-comparisons',expected.scopeSha256+'.json');
  const state=sealedBody(readJSON(this.stateFile(expected.scope.stableFragmentId))),event=this.comparisonEvent(record);transitionFragment(state,event,{scope:this.scope(report.paperId)});
  immutableWrite(file,JSON.stringify(record,null,2)+'\n');this.apply(state,event);this.q.kick();return this.comparisonRecord(expected.scopeSha256);
 }
 comparisonEvent(r){const body={...r.scope,agreesWithInitialDraft:r.agreesWithInitialDraft,note:r.note,comparisonReceiptSha256:hashObject(r)};return this.event('source_initial_comparison',body,{receiptId:'source-initial-comparison-'+r.scopeSha256,receiptSha256:hashObject(r),role:'source',actorId:r.reviewedBy});}
 addSourceComparisons(state,r){
  const events=files(path.join(this.root,'source-comparisons')).filter(x=>x.scope?.stableFragmentId===state.stableFragmentId).map(row=>this.comparisonEvent(this.comparisonRecord(row.scopeSha256).record));
  for(const old of state.events.filter(e=>e.type==='source_initial_comparison'))check(events.some(e=>e.id===old.id&&hashObject(e.body)===hashObject(old.body)&&hashObject(e.receipt)===hashObject(old.receipt)),'Accepted source comparison receipt is missing or changed',409,'SOURCE_COMPARISON_RECEIPT');
  for(const event of events){if(state.humanLock){check(state.events.some(e=>e.id===event.id),'A later comparison cannot enter a final human scope',409,'HUMAN_FRAGMENT_LOCKED');continue;}state=this.apply(state,event);}return state;
 }
 applyCases(state,r){
  const cases=this.reconcileCases?.get(r.paperId)||this.store.list().filter(c=>c.paperId===r.paperId).map(c=>({request:this.store.request(c.id),state:this.store.state(c.id)}));
  for(const item of cases){const {request,state:s}=item,origin=request.spec.fragmentHumanOrigin||request.spec.ownerSourceOrigin||request.spec.blindOrigin;
   if(!finalActions.has(s.decision?.action)||s.supersededBy||!(origin?.stableFragmentId===state.stableFragmentId||origin?.reportId===r.id))continue;
   check(s.decision.by==='local_user'||this.store.fixture&&s.decision.by==='fixture_test_decision','A stored human decision needs its actual human actor',409,'HUMAN_DECISION_EVIDENCE_GAP');
   const bundleId=origin.bundleId||r.bundleId,b=this.blind.bundle(bundleId),n=b.nodes.find(n=>n.semanticId===r.semanticId);check(n,'User-decision fragment is missing',409,'HUMAN_DECISION_EVIDENCE_GAP');
   const binding=this.bind(r.paperId,b.id,n.nodeId);state=binding.state.humanLock?binding.state:this.selectCurrent(binding);
   check(binding.state.stableFragmentId===state.stableFragmentId&&request.spec.target.oldText===n.target.oldText,'User-decision target differs from fragment',409,'HUMAN_DECISION_EVIDENCE_GAP');
   const decided=s.decision.action==='accept'?n.quote:humanEditView(this.store,request,s.decision).tex;
   const rawDecision=s.decision.action==='accept'?n.target.oldText:s.decision.tex;
   state=this.apply(state,this.event('human_decision',{fragmentKey:binding.key,decisionId:s.decision.id,action:s.decision.action,decidedTex:decided,decidedTexSha256:sha(decided),...(binding.resolved.currentFragment.sourceTexSha256?{decidedSourceTex:rawDecision,decidedSourceTexSha256:sha(rawDecision)}:{}),finalForFragment:true},{receiptId:s.decision.id,receiptSha256:hashObject(s.decision),role:'human',actorId:s.decision.by}));
   if(s.decision.action==='edit'&&s.status==='verified'){
    const pack=safePath(this.store.root,'results/'+id(s.verification.packageId)),receipt=readJSON(path.join(pack,'receipt.json'));
    check(receipt.success&&receipt.decisionId===s.decision.id&&receipt.requestDigest===request.intentDigest&&receipt.inputSha256===s.verification.inputSha256,'Saved human edit is not mechanically verified',409,'HUMAN_APPLICATION_GAP');
    const original=fs.readFileSync(safePath(path.join(this.store.caseRoot(request.id),'package/inputs'),request.spec.target.file),'utf8'),expected=replaceExact(original,request.spec.target,s.decision.tex).text,expectedManifest=changedManifest(request.manifest,request.spec.target.file,sha(expected),Buffer.byteLength(expected));
    check(receipt.pdfSha256===s.verification.pdfSha256&&receipt.texSha256===s.verification.texSha256&&hashFile(path.join(pack,'result.pdf'))===receipt.pdfSha256&&hashFile(path.join(pack,'result.tex'))===receipt.texSha256&&hashFile(path.join(pack,'target.tex'))===sha(expected)&&receipt.inputSha256===expectedManifest.sha256,'Mechanically verified human result files changed',409,'HUMAN_APPLICATION_GAP');
    const bundles=this.blind.all('bundles').filter(b=>b.paperId===r.paperId&&b.manifest.sha256===receipt.inputSha256);check(bundles.length,'Applied user edit requires its verified frozen return',409,'HUMAN_APPLICATION_GAP');
    const mapped=this.aliasResult('map',{initialBundleId:state.initial.fragment.bundleId,initialNodeId:state.initial.fragment.nodeId,targetBundleId:bundles[0].id});const current=this.bind(r.paperId,mapped.currentBundle.id,mapped.currentNode.nodeId);state=sealedBody(readJSON(this.stateFile(state.stableFragmentId)));
    state=this.apply(state,this.event('mechanical_application',{fragmentKey:current.key,decisionId:s.decision.id,appliedTextSha256:sha(decided),inputSha256:receipt.inputSha256,buildSuccess:true,buildReceiptSha256:hashFile(path.join(pack,'receipt.json'))},{receiptId:s.verification.packageId,receiptSha256:hashFile(path.join(pack,'receipt.json')),role:'program',actorId:'exact_saved_human_edit_verifier'}));
   }
  }
  return state;
 }
 reconcileReport(r){
  if(!this.enabled)return null;const scope=this.scope(r.paperId);if(!scope.enrolled||scope.published)return {state:'out_of_scope_preserved',humanRequired:false,scope};
  try{
   const binding=this.bind(r.paperId,r.bundleId,r.nodeId);this.rememberReport(r,binding);let state=this.applyCases(binding.state,r);
   if(!state.humanLock)state=this.addSource(state,r);state=this.addSourceComparisons(state,r);
   if(!state.humanLock){state=this.addBlind(state,r,binding.key);state=this.applyCases(state,r);}
   const gap=path.join(this.root,'gaps',r.id+'.json');if(fs.existsSync(gap)){const old=readJSON(gap);if(!old.resolvedAt){old.resolvedAt=now();old.resolvedByStateSha256=state.sha256;writeJSON(gap,old);}}
   return evaluateFragmentRouting(state,scope);
  }catch(e){const gap=path.join(this.root,'gaps',r.id+'.json'),old=fs.existsSync(gap)?readJSON(gap):null,body={reportId:r.id,paperId:r.paperId,state:'technical_gap',code:e.code||'HUMAN_ROUTING_TECHNICAL_GAP',message:e.message,...(e.details?{details:e.details}:{}),paperApproval:false},same=old&&!old.resolvedAt&&hashObject(without(old,['at','firstSeenAt','lastChangedAt']))===hashObject(body);if(same)return old;const record={...body,at:old&&!old.resolvedAt?old.at:now(),firstSeenAt:old?.firstSeenAt||old?.at||now(),lastChangedAt:now()};writeJSON(gap,record);return record;}
 }
 reconcile({paperId=null,createJobs=true}={}){
  if(!this.enabled||this.reconciling)return;this.reconciling=true;
  this.invalidateEvaluation();
  const previous=this.preparedAliases,previousCases=this.reconcileCases;
  try{const reports=this.blind.all('reports').filter(r=>!paperId||r.paperId===paperId);this.reconcileCases=new Map([...new Set(reports.map(r=>r.paperId))].map(id=>[id,[]]));for(const c of this.store.list())if(this.reconcileCases.has(c.paperId))this.reconcileCases.get(c.paperId).push({request:this.store.request(c.id),state:this.store.state(c.id)});this.preparedAliases=this.prepareAliases(reports);this.seedConfirmedReadings(paperId);for(const r of reports)this.reconcileReport(r);
   // A failed exact alias was already checked in this synchronous plan.
   // Preserve that technical gap instead of re-running the whole graph for
   // every subsequent scheduling predicate. A mutation or new tick clears it.
   if(this.evaluation)for(const r of reports)this.evaluation.reconciled.add(hashObject(r));
   for(const state of createJobs?this.states(paperId):[]){const route=evaluateFragmentRouting(state,this.scope(state.paperId));if(route.state==='technical_gap'&&route.proof.gaps.length&&route.proof.gaps.every(g=>g.code==='SOURCE_INITIAL_AGREEMENT_NOT_ESTABLISHED')){
    const link=files(path.join(this.root,'reports')).find(r=>r.stableFragmentId===state.stableFragmentId);if(link){const comparison=this.initialComparisonScope(this.blind.report(link.reportId));if(comparison)this.q.create('source_comparison',this.q.owner(state.paperId).owner,{paperId:state.paperId,reportId:link.reportId,sourceComparisonScopeSha256:comparison.scopeSha256});}
   }if(route.state==='human_required'){
    const links=files(path.join(this.root,'reports')).filter(r=>r.stableFragmentId===state.stableFragmentId),report=links.map(x=>this.blind.report(x.reportId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];if(!report)continue;
    this.q.create('human_packet',this.q.owner(state.paperId).owner,{paperId:state.paperId,reportId:report.id,stableFragmentId:state.stableFragmentId,humanEpoch:state.epoch,packetOnly:true});
   }}
  }finally{this.preparedAliases=previous;this.reconcileCases=previousCases;this.reconciling=false;this.q.blindExecutors?.math?.requests?.kick();}
 }
 seedConfirmedReadings(onlyPaper=null){
  for(const paperId of (this.q.paperIds?.()||this.q.settings.paperGroups.flat()).filter(p=>!onlyPaper||p===onlyPaper)){
   if(this.scope(paperId).published)continue;const p=this.store.config.papers[paperId],file=path.join(p.root,'outputs/confidence-events.json');if(!fs.existsSync(file))continue;
   const current=inputManifest(path.join(p.root,'outputs'),p.main).sha256,bundles=this.blind.all('bundles').filter(b=>b.paperId===paperId).sort((a,b)=>(b.manifest.sha256===current)-(a.manifest.sha256===current)||a.createdAt.localeCompare(b.createdAt));
   for(const e of readJSON(file).events||[]){if(e.state!=='resolved'||e.resolution?.by!=='user'||e.sourceSha256!==p.source.sha256||typeof e.candidate!=='string')continue;
    const key='confirmed-'+hashObject({paperId,eventId:e.id,sourceSha256:e.sourceSha256,candidate:e.candidate}),saved=path.join(this.root,'confirmed',key+'.json');if(fs.existsSync(saved)){check(readJSON(saved).eventSha256===hashObject(e),'Confirmed user source decision changed',409,'HUMAN_DECISION_EVIDENCE_GAP');continue;}
    let matched=false;for(const b of bundles){const nodes=b.public.nodes.filter(n=>n.quote.includes(e.candidate));if(nodes.length!==1)continue;
     try{const resolved=this.aliasResult('resolve',{paperId,bundleId:b.id,nodeId:nodes[0].nodeId});
      immutableWrite(saved,JSON.stringify({schemaVersion:1,id:key,paperId,decisionId:e.id,eventSha256:hashObject(e),sourceSha256:p.source.sha256,initialBundleId:resolved.initialBundle.id,initialNodeId:resolved.initialNode.nodeId,parentAliasProof:resolved.aliasProof,protectedQuote:e.candidate,protectedQuoteSha256:sha(e.candidate),scope:'Only the exact user-confirmed substring, never its whole containing paragraph.',at:now()},null,2)+'\n');matched=true;break;
     }catch{}
    }
    if(!matched)writeJSON(path.join(this.root,'gaps','confirmed-'+id(paperId)+'-'+hashObject(e.id).slice(0,16)+'.json'),{paperId,reportId:'confirmed-'+e.id,state:'technical_gap',code:'HUMAN_CONFIRMED_READING_BINDING_GAP',at:now()});
   }
  }
 }
 reportRoute(r){
  if(!this.evaluation)return this.reportRouteFresh(r);
  const key=hashObject(r),cached=this.evaluation.routes.get(key);if(cached)return structuredClone(cached);
  const result=this.reportRouteFresh(r);if(result)this.evaluation.routes.set(key,structuredClone(result));return result;
 }
 reportRouteFresh(r){
  if(!this.enabled)return null;const scope=this.scope(r.paperId);if(!scope.enrolled||scope.published)return {state:'out_of_scope_preserved',humanRequired:false};
  const f=path.join(this.root,'reports',r.id+'.json'),gap=path.join(this.root,'gaps',r.id+'.json');
  if(this.evaluation?.reconciled.has(hashObject(r))&&fs.existsSync(gap)&&!readJSON(gap).resolvedAt)return readJSON(gap);
  if(!fs.existsSync(f))return this.reconcileReport(r);const link=readJSON(f);if(link.reportSha256!==hashObject(r))return this.reconcileReport(r);
  if(fs.existsSync(gap)&&!readJSON(gap).resolvedAt)return readJSON(gap);
  const state=sealedBody(readJSON(this.stateFile(link.stableFragmentId)));return evaluateFragmentRouting(state,scope);
 }
 blocksReport(r){const route=this.reportRoute(r);return !!route&&(pendingStates.has(route.state)||route.state==='human_decided')||!!this.nodeRoute(r.bundleId,r.nodeId,r.focusQuote||r.quote,{finalOnly:true})?.lock;}
 assertReportAction(r,action){const route=this.reportRoute(r),narrow=this.nodeRoute(r.bundleId,r.nodeId,r.focusQuote||r.quote);check(!narrow?.lock&&(!route||!pendingStates.has(route.state)&&route.state!=='human_decided'),'This fragment is awaiting or governed by a final human decision',409,route?.lock||narrow?.lock?'HUMAN_FRAGMENT_LOCKED':'HUMAN_REQUIRED');return true;}
 nodeRoute(bundleId,nodeId,focusQuote=null,{finalOnly=false}={}){
  if(!this.enabled)return null;const b=this.blind.bundle(bundleId),scope=this.scope(b.paperId);if(!scope.enrolled||scope.published)return null;
  const known=this.restrictions(bundleId,{finalOnly}).find(x=>x.nodeId===nodeId&&(x.wholeNode!==false||focusQuote===null||focusQuote.includes(x.protectedQuote)||x.protectedQuote.includes(focusQuote)));return known?.route||null;
 }
 assertNodeAction(bundleId,nodeId,action,focusQuote=null){const route=this.nodeRoute(bundleId,nodeId,focusQuote);check(!route||!pendingStates.has(route.state)&&route.state!=='human_decided','Fragment is outside the remaining blind/source scope',409,route?.lock?'HUMAN_FRAGMENT_LOCKED':'HUMAN_REQUIRED');}
 gate(paperId){
  if(!this.enabled||this.scope(paperId).published)return {gaps:[],humanDecided:[],pending:[]};
  this.reconcile({paperId,createJobs:false});
  return this.status(paperId);
 }
 statusMany(paperIds){
  const snapshot=this.enabled?{states:files(path.join(this.root,'states')),errors:files(path.join(this.root,'gaps'))}:null;
  return paperIds.map(paperId=>({paperId,...this.status(paperId,snapshot)}));
 }
 status(paperId,snapshot=null){
  if(!this.enabled)return {gaps:[],humanDecided:[],pending:[]};const scope=this.scope(paperId);
  if(scope.published)return {gaps:[],humanDecided:[],pending:[]};
  const states=snapshot?snapshot.states.filter(s=>s.paperId===paperId).map(sealedBody):this.states(paperId),routes=states.map(s=>evaluateFragmentRouting(s,scope)),errors=(snapshot?.errors||files(path.join(this.root,'gaps'))).filter(x=>x.paperId===paperId&&!x.resolvedAt),pending=routes.filter(r=>pendingStates.has(r.state));
  return {gaps:[...pending.map(r=>'Fragment human workflow incomplete: '+r.stableFragmentId+' ('+r.state+')'),...errors.map(e=>'Fragment evidence recovery required: '+e.reportId+' '+e.code)],humanDecided:routes.filter(r=>r.state==='human_decided').map(r=>({stableFragmentId:r.stableFragmentId,decisionId:r.lock.decisionId,closureBasis:'human_decided',mathematicalPass:false})),pending};
 }
 restrictions(bundleId,{historicalProof=null,finalOnly=false}={}){
  if(!this.evaluation)return this.restrictionsFresh(bundleId,{historicalProof,finalOnly});
  const key=hashObject({bundleId,historicalProof,finalOnly}),cached=this.evaluation.restrictions.get(key);if(cached)return structuredClone(cached);
  const result=this.restrictionsFresh(bundleId,{historicalProof,finalOnly});this.evaluation.restrictions.set(key,structuredClone(result));return result;
 }
 restrictionsFresh(bundleId,{historicalProof=null,finalOnly=false}={}){
  if(!this.enabled)return [];const b=this.blind.bundle(bundleId),p=this.store.config.papers[b.paperId],out=[];
  if(this.scope(b.paperId).published)return out;
  // A single historical fragment may project onto several current nodes.
  // Resolve its state once; each projected node remains individually bound.
  const historicalStates=historicalProof?[...new Map(historicalProof.filter(x=>x.kind==='fragment').map(x=>[x.stableFragmentId+':'+x.stateSha256,x])).values()]:null;
  const selected=historicalProof?historicalStates.map(x=>{
   const f=path.join(this.root,'versions',id(x.stableFragmentId),x.stateSha256+'.json'),s=fs.existsSync(f)?sealedBody(readJSON(f)):sealedBody(readJSON(this.stateFile(x.stableFragmentId)));check(s.sha256===x.stateSha256,'Historical human projection changed',409,'HUMAN_ROUTING_INTEGRITY');return s;
  }):this.states(b.paperId).filter(s=>{const route=evaluateFragmentRouting(s,this.scope(b.paperId));return finalOnly?!!route.lock:pendingStates.has(route.state)||route.state==='human_decided';});
  const confirmed=files(path.join(this.root,'confirmed')).filter(c=>c.paperId===b.paperId&&(!historicalProof||historicalProof.some(x=>x.kind==='confirmed_reading'&&x.stableFragmentId===c.id)));
  const identities=[...selected.map(s=>({initialBundleId:s.initial.fragment.bundleId,initialNodeId:s.initial.fragment.nodeId,targetBundleId:b.id})),...confirmed.map(c=>({initialBundleId:c.initialBundleId,initialNodeId:c.initialNodeId,targetBundleId:b.id}))];
  const native=this.mapper===mapFragmentToBundle,requests=identities.map((identity,i)=>({kind:i<selected.length?'project':'map',identity})),rows=native&&requests.length?resolveFragmentAliases(this.q,requests):null;
  const mappings=rows?new Map(requests.map((request,i)=>[request.kind+':'+hashObject(request.identity),rows[i]])):null;
  const mappedFragment=(identity,project=false)=>{const row=mappings?.get((project?'project':'map')+':'+hashObject(identity));if(!row)return this.mapper(this.q,identity);if(!row.ok)throw Object.assign(Error(row.error.code),row.error);return row.result;};
  for(const s of selected){const route=evaluateFragmentRouting(s,this.scope(b.paperId));if(!pendingStates.has(route.state)&&route.state!=='human_decided')continue;
   let mapped;try{mapped=mappedFragment({initialBundleId:s.initial.fragment.bundleId,initialNodeId:s.initial.fragment.nodeId,targetBundleId:b.id},true);}catch(e){
    // A partial completion bundle can omit unrelated locked fragments. A whole
    // assigned text must have a proven mapping before its review can continue.
    const whole=b.public.nodes.map(n=>n.quote).join('')===b.public.document.text||this.q.jobs().some(j=>['review','incremental_review','math_supplement'].includes(j.kind)&&j.bundleId===b.id);
    if(!whole&&(native?e.code==='ALIAS_PROJECTED_RANGE_OMITTED':!b.nodes.some(n=>n.quote.includes(s.initial.fragment.tex))))continue;throw e;
   }
   const nodes=mapped.currentNodes||[mapped.currentNode],raw=mapped.currentRawText??mapped.currentNode.target.oldText,quote=mapped.currentText??mapped.currentNode.quote;
   if(route.state==='human_decided')check(route.lock.decidedSourceTexSha256?sha(raw)===route.lock.decidedSourceTexSha256:sha(quote)===route.lock.decidedTexSha256,'Final human decision content changed in this candidate',409,'HUMAN_LOCK_CONTENT_CHANGED');
   for(const node of nodes){
    const prior=historicalProof?.find(x=>x.kind==='fragment'&&x.stableFragmentId===s.stableFragmentId&&x.nodeId===node.nodeId),v2=!historicalProof||prior?.projectionVersion===2,record=mapped.projectionProof?.record;
    // Full alias validation above remains mandatory. The coverage identity binds
    // exact source/target ranges and bytes, not mutable review-job status fields.
    const projection=record?(v2?{projectionVersion:2,projectionSha256:hashObject(Object.fromEntries(['schemaVersion','kind','paperId','initialBundleId','initialNodeId','targetBundleId','initialRawRange','currentRawRange','beforeInputSha256','afterInputSha256','currentRawTextSha256','currentTextSha256','nodes'].map(k=>[k,record[k]])))}:{projectionSha256:mapped.projectionProof.sha256}):{};
    out.push({kind:'fragment',stableFragmentId:s.stableFragmentId,stateSha256:s.sha256,nodeId:node.nodeId,...projection,state:route.state,decisionId:route.lock?.decisionId||null,closureBasis:route.state==='human_decided'?'human_decided':null,route});
   }
  }
  const confidence=path.join(p.root,'outputs/confidence-events.json');
  for(const c of confirmed){
   const e=fs.existsSync(confidence)?readJSON(confidence).events.find(e=>e.id===c.decisionId):null;check(e&&hashObject(e)===c.eventSha256,'Historical confirmed reading changed',409,'HUMAN_ROUTING_INTEGRITY');
   let mapped;try{mapped=mappedFragment({initialBundleId:c.initialBundleId,initialNodeId:c.initialNodeId,targetBundleId:b.id});}catch(e){
    const whole=b.public.nodes.map(n=>n.quote).join('')===b.public.document.text||this.q.jobs().some(j=>['review','incremental_review','math_supplement'].includes(j.kind)&&j.bundleId===b.id);
    if(!whole&&!b.nodes.some(n=>n.quote.includes(c.protectedQuote)))continue;throw e;
   }
   const node=mapped.currentNode,start=node.quote.indexOf(c.protectedQuote);
   check(start>=0&&start===node.quote.lastIndexOf(c.protectedQuote),'The exact user-confirmed substring changed or is ambiguous',409,'HUMAN_LOCK_CONTENT_CHANGED');
   const original={kind:'confirmed_reading',stableFragmentId:c.id,nodeId:node.nodeId,wholeNode:node.quote===c.protectedQuote,start,end:start+c.protectedQuote.length,stateSha256:c.eventSha256,decisionId:c.decisionId,closureBasis:'human_decided',state:'human_decided',eventSha256:c.eventSha256,protectedQuoteSha256:c.protectedQuoteSha256};
   if(historicalProof&&!historicalProof.some(x=>x.kind==='confirmed_reading'&&x.stableFragmentId===c.id))continue;
   out.push({...original,protectedQuote:c.protectedQuote,route:{stableFragmentId:c.id,state:'human_decided',wholeNode:original.wholeNode,closureBasis:'human_decided',lock:{decisionId:c.decisionId},mathematicalPass:false}});
  }
  return out;
 }
 publicRestriction(x){return without(x,['route','protectedQuote']);}
 assertNewCase(request,packageRoot){
  if(!this.enabled)return;
  const o=request.spec.fragmentHumanOrigin||request.spec.ownerSourceOrigin||request.spec.blindOrigin;
  if(!request.spec.fragmentHumanOrigin){
   const bundles=this.blind.all('bundles').filter(b=>b.paperId===request.spec.paperId&&b.manifest.sha256===request.manifest.sha256).sort((a,b)=>b.nodes.length-a.nodes.length);
   if(bundles.length){check(packageRoot,'Exact sealed package input is required',409,'HUMAN_PACKET_BINDING');const text=fs.readFileSync(safePath(packageRoot,'inputs/'+request.spec.target.file),'utf8'),range=locate(text,request.spec.target);this.assertPatch(request.spec.paperId,bundles[0].id,text,[range]);}
   else check(!this.states(request.spec.paperId).length&&!files(path.join(this.root,'confirmed')).some(c=>c.paperId===request.spec.paperId),'Cannot exclude a decided fragment without a frozen package binding',409,'HUMAN_PACKET_BINDING');
  }
  if(o?.bundleId){const b=this.blind.bundle(o.bundleId),n=b.nodes.find(n=>n.nodeId===o.nodeId||n.semanticId===o.semanticId)||b.nodes.find(n=>n.target?.oldSha256===request.spec.target.oldSha256);check(n,'Human request target lacks exact frozen identity',409,'HUMAN_PACKET_BINDING');
   const route=this.nodeRoute(b.id,n.nodeId,request.spec.target.oldText);
   check(!route?.lock,'A final human decision cannot create another case in this workflow',409,'HUMAN_FRAGMENT_LOCKED');
   if(request.spec.fragmentHumanOrigin)check(route?.stableFragmentId===o.stableFragmentId&&route.state==='human_required','A required fragment packet must match its pending trigger',409,'HUMAN_PACKET_SCOPE');
   return;
  }
  const bundles=this.blind.all('bundles').filter(b=>b.paperId===request.spec.paperId&&b.manifest.sha256===request.manifest.sha256);
  for(const b of bundles){const n=b.nodes.find(n=>n.target?.oldSha256===request.spec.target.oldSha256);if(n){const route=this.nodeRoute(b.id,n.nodeId,request.spec.target.oldText);check(!route?.lock,'A final human decision cannot be bypassed by a new case category',409,'HUMAN_FRAGMENT_LOCKED');}}
 }
 assertPatch(paperId,bundleId,text,edits,{decisionId=null}={}){
  if(!this.enabled)return true;const b=this.blind.bundle(bundleId);check(b.paperId===paperId,'Patch paper differs',409,'HUMAN_PATCH_SCOPE');
  for(const r of this.restrictions(bundleId)){
   if(decisionId&&r.decisionId===decisionId)continue;
   const node=b.nodes.find(n=>n.nodeId===r.nodeId);check(node?.target,'Protected fragment has no exact edit target',409,'HUMAN_PATCH_SCOPE');
   const range=locate(text,node.target);let start=range.start,end=range.end;
   if(r.wholeNode===false){const offset=node.target.oldText.indexOf(r.protectedQuote);check(offset>=0&&offset===node.target.oldText.lastIndexOf(r.protectedQuote),'Protected substring cannot be uniquely located in raw target',409,'HUMAN_PATCH_SCOPE');start+=offset;end=start+r.protectedQuote.length;}
   check(!edits.some(e=>e.start<end&&e.end>start||e.start===e.end&&e.start>start&&e.start<end),'Registered edit intersects a fragment awaiting or governed by human decision',409,'HUMAN_FRAGMENT_LOCKED');
  }return true;
 }
 publicationLineage(paperId){
  if(!this.enabled)return null;const gate=this.gate(paperId);check(!gate.gaps.length,'Human workflow is incomplete',409,'HUMAN_REQUIRED');
  const records=[];for(const kind of ['states','confirmed','reports','packets'])for(const name of fs.readdirSync(path.join(this.root,kind)).filter(n=>n.endsWith('.json'))){const file=path.join(this.root,kind,name),r=readJSON(file);if(r.paperId===paperId||r.stableFragmentId&&this.states(paperId).some(s=>s.stableFragmentId===r.stableFragmentId))records.push({kind,path:file,sha256:hashFile(file),record:r});}
  return {authority:this.settings.authority,gate,records,closureBasis:'Actual saved human decisions; never mathematical passes.'};
 }
 inputView(input,cap){
  if(!this.enabled)return input;const bundleId=cap.bundleId||(cap.reportId?(cap.role==='completion_reviewer'?this.blind.report(cap.reportId).returnedBundleId:this.blind.report(cap.reportId).bundleId):null);if(!bundleId)return input;
  const restrictions=this.restrictions(bundleId);if(!restrictions.length)return input;
  const b=this.blind.viewBundle(bundleId),quotes=restrictions.map(x=>x.wholeNode===false?x.protectedQuote:b.nodes.find(n=>n.nodeId===x.nodeId)?.quote).filter(Boolean);
  for(const r of this.blind.all('reports').filter(r=>r.bundleId===bundleId&&restrictions.some(x=>x.nodeId===r.nodeId&&x.wholeNode!==false)))if(r.focusQuote)quotes.push(r.focusQuote);
  for(const x of restrictions.filter(x=>x.kind==='fragment')){const s=sealedBody(readJSON(this.stateFile(x.stableFragmentId)));quotes.push(s.initial.fragment.tex,...s.aliases.map(a=>a.fragment?.tex).filter(Boolean));}
  const replacements=new Map(quotes.map(q=>[q,'[Fragment withheld: mandatory human decision scope. Do not reread or recalculate.]']));
  const stableIds=new Set(restrictions.filter(x=>x.wholeNode!==false).map(x=>x.stableFragmentId));
  const reportIds=new Set([...files(path.join(this.root,'reports')).filter(x=>stableIds.has(x.stableFragmentId)).map(x=>x.reportId),...this.blind.all('reports').filter(r=>r.bundleId===bundleId&&restrictions.some(x=>x.wholeNode!==false&&x.nodeId===r.nodeId)).map(r=>r.id)]);
  const redact=x=>{if(typeof x==='string')return [...replacements].reduce((s,[q,m])=>s.replaceAll(q,m),x);if(Array.isArray(x))return x.map(redact);if(!x||typeof x!=='object')return x;
   if(reportIds.has(x.reportId)||reportIds.has(x.id)||x.nodeId&&restrictions.some(r=>r.wholeNode!==false&&r.nodeId===x.nodeId))return x.withheld===true?x:{id:x.id,nodeId:x.nodeId,reportId:x.reportId,status:x.status,withheld:true,recordSha256:hashObject(x),scope:'Required human decision scope. Retained evidence is preserved on the server; no rereading, new judgment or payload replay is authorized.'};
   return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,redact(v)]));};
  const value=redact(input);value.fragmentHumanScope={schemaVersion:1,excludedFromReview:restrictions.map(x=>this.publicRestriction(x)),scope:'These fragments are withheld from this reconstruction/blind review. A human_decided closure is not a mathematical pass. Submit only remaining work; the server binds human coverage from actual saved decisions.'};
  if(value.document?.text)value.document.viewSha256=sha(value.document.text);
  if(value.bundle?.document?.text)value.bundle.document.viewSha256=sha(value.bundle.document.text);
  for(const nodes of [value.nodes,value.bundle?.nodes].filter(Array.isArray))for(const n of nodes)if(typeof n.quote==='string')n.viewSha256=sha(n.quote);
  return value;
 }
 projectInventory(bundleId,body,spans,{historical=false,historicalProof=null,submitted=body}={}){
  const restrictions=historical?(historicalProof?this.restrictions(bundleId,{historicalProof}):[]):this.restrictions(bundleId),whole=restrictions.filter(x=>x.wholeNode!==false),partial=restrictions.filter(x=>x.wholeNode===false),ids=new Set(whole.map(x=>x.nodeId));
  if(!historical)check(!(submitted.items||[]).some(i=>ids.has(i.nodeId)||partial.some(x=>x.nodeId===i.nodeId&&(i.quote.includes(x.protectedQuote)||x.protectedQuote.includes(i.quote)))),'Do not newly check a human-restricted fragment',409,'HUMAN_FRAGMENT_LOCKED');
  if(!restrictions.length)return {body,proof:null};
  const closed=x=>x.state==='human_decided',rows=whole.map(x=>({nodeId:x.nodeId,disposition:closed(x)?'human_decided':'human_pending',reason:closed(x)?'Actual final human decision closes this fragment for the current workflow; no mathematical pass is inferred.':'This fragment is awaiting required human resolution and is excluded from further model reinspection.',itemIds:[],humanBinding:this.publicRestriction(x)}));
  const fragmentRows=spans.filter(s=>ids.has(s.nodeId)).map(s=>{const x=restrictions.find(x=>x.nodeId===s.nodeId);return {spanId:s.spanId,disposition:closed(x)?'human_decided':'human_pending',reason:rows.find(n=>n.nodeId===s.nodeId).reason,itemIds:[],humanBinding:this.publicRestriction(x)};});
  return {body:{...body,items:(body.items||[]).filter(x=>!ids.has(x.nodeId)),nodes:[...(body.nodes||[]).filter(x=>!ids.has(x.nodeId)),...rows],spans:[...(body.spans||[]).filter(x=>!spans.some(s=>s.spanId===x.spanId&&ids.has(s.nodeId))),...fragmentRows]},proof:restrictions.map(x=>this.publicRestriction(x))};
 }
 verifyHumanCoverage(receipt){
  if(!receipt.humanCoverage)return true;const current=this.restrictions(receipt.bundleId,{historicalProof:receipt.humanCoverage});
  check(hashObject(current.map(x=>this.publicRestriction(x)))===hashObject(receipt.humanCoverage),'Human coverage binding changed',409,'HUMAN_ROUTING_INTEGRITY');
  for(const x of current.filter(x=>x.wholeNode!==false)){const row=receipt.nodes.find(n=>n.nodeId===x.nodeId);check(row&&row.disposition===(x.state==='human_decided'?'human_decided':'human_pending')&&hashObject(row.humanBinding)===hashObject(this.publicRestriction(x)),'Human closure was mislabeled as checking',409,'HUMAN_ROUTING_INTEGRITY');}return true;
 }
 decisionRevision(paperId){return hashObject(this.states(paperId).map(s=>({id:s.stableFragmentId,epoch:s.epoch,decisionId:s.humanLock?.decisionId||null,applied:!!s.humanLock?.mechanicalApplication})));}
 packetRecord(stableFragmentId){const f=path.join(this.root,'packets',id(stableFragmentId)+'.json');return fs.existsSync(f)?readJSON(f):null;}
 async assemble(reportId,options={}){
  try{return await this.assemblePacket(reportId,options);}catch(e){
   const r=this.blind.report(reportId),linkFile=path.join(this.root,'reports',r.id+'.json'),link=fs.existsSync(linkFile)?readJSON(linkFile):null;
   const record=link?this.packetRecord(link.stableFragmentId)||{stableFragmentId:link.stableFragmentId,reportId}:null;
   if(record){record.technicalFailure={at:now(),code:e.code||'HUMAN_PACKET_BUILD_FAILED',message:e.message};writeJSON(path.join(this.root,'packets',record.stableFragmentId+'.json'),record);}throw e;
  }
 }
 async assemblePacket(reportId,{authority,locator}={}){
  const r=this.blind.report(reportId);this.reconcile({paperId:r.paperId});const link=readJSON(path.join(this.root,'reports',r.id+'.json'));let state=sealedBody(readJSON(this.stateFile(link.stableFragmentId))),route=evaluateFragmentRouting(state,this.scope(r.paperId));
  if(state.humanCase)return {id:r.id,status:'awaiting_human',caseId:state.humanCase.caseId,stableFragmentId:state.stableFragmentId,reused:true};
  check(route.state==='human_required'&&!state.humanLock,'Only an already triggered fragment may be assembled',409,'HUMAN_PACKET_SCOPE');authority?.assert();
  const p=this.store.config.papers[r.paperId];check(authority?.actor&&sourceActorValid(this.store.root,r.paperId,p.owner,authority.actor),'Registered source packet assembler required',403,'WRITER_FENCED');verifyAuthority(p);
  const current=inputManifest(path.join(p.root,'outputs'),p.main),bundles=this.blind.all('bundles').filter(b=>b.paperId===r.paperId&&b.manifest.sha256===current.sha256);
  const map=b=>this.mapper(this.q,{initialBundleId:state.initial.fragment.bundleId,initialNodeId:state.initial.fragment.nodeId,targetBundleId:b.id});
  let mapped;for(const b of bundles)try{mapped=map(b);break;}catch{}
  // A returned repair may freeze only its own node. Materialize the current
  // whole text under the existing source registration; this adds no review,
  // source reading, build receipt or initial-submission history.
  if(!mapped){authority.assert();const whole=this.blind.freeze(r.paperId,{wholeDocument:true});check(whole.manifest.sha256===current.sha256&&inputManifest(path.join(p.root,'outputs'),p.main).sha256===current.sha256,'Current packet input changed',409,'VERSION_CONFLICT');try{mapped=map(whole);}catch{}
   if(!mapped&&this.mapper===mapFragmentToBundle){try{
    const projection=projectFragmentToBundle(this.q,{initialBundleId:state.initial.fragment.bundleId,initialNodeId:state.initial.fragment.nodeId,targetBundleId:whole.id});authority.assert();
    const bounded=this.blind.freeze(r.paperId,{nodes:[{semanticId:projection.initialNode.semanticId,kind:projection.initialNode.kind,target:projection.target}]});check(bounded.manifest.sha256===current.sha256&&inputManifest(path.join(p.root,'outputs'),p.main).sha256===current.sha256,'Current packet input changed',409,'VERSION_CONFLICT');mapped=map(bounded);
   }catch{}}
  }
  check(mapped,'Current human target is not uniquely bound',409,'HUMAN_FRAGMENT_ALIAS_GAP');
  const {currentBundle:b,currentNode:n}=mapped,candidateBinding=sourceCandidateBinding(this.blind,b,n),related=files(path.join(this.root,'reports')).filter(x=>x.stableFragmentId===state.stableFragmentId).map(x=>this.blind.report(x.reportId));
  const source=related.map(x=>x.sourceObservation||x.ownerDisposition?.payload).find(x=>x?.locator),loc=source?.locator||n.locator||locator;check(loc,'Source locator missing; assemble the evidence packet without another scientific/source verdict',409,'HUMAN_PACKET_LOCATOR_GAP');
  const initialRaw=mapped.initialNode.target.oldText,currentRaw=n.target.oldText,readings=[...new Set([initialRaw,currentRaw])];
  const packetProof={schemaVersion:1,stableFragmentId:state.stableFragmentId,epoch:state.epoch,triggerProof:route.proof,initialTex:initialRaw,currentTex:currentRaw,sourceDisposition:related.map(x=>({reportId:x.id,disposition:x.ownerDisposition?.payload||null,observation:x.sourceObservation||null})),blindFindings:related.map(x=>({reportId:x.id,question:x.question,conditions:x.conditions,evidence:x.evidence,mathResult:x.mathResult||null,reviews:x.reviews||[]})),specificDecision:'请裁决此片段最终采用的 LaTeX：可保留当前内容，或直接编辑为你确认的内容。裁决后，本轮重建与盲审不再重查此片段。',firstDraft:state.initial};
  const packetFile=path.join(this.root,'packets',state.stableFragmentId+'-proof-'+route.proof.sha256+'.json');immutableWrite(packetFile,JSON.stringify(packetProof,null,2)+'\n');
  const spec={schemaVersion:1,paperId:r.paperId,owner:p.owner,issueId:route.caseKey,revision:1,kind:n.kind,fixture:this.store.fixture,category:'mandatory_fragment_human',reason:'mandatory_fragment_trigger',boundedCheck:'Program-bound existing source and blind receipts satisfy the user-defined fragment escalation rule; this assembly performs no additional source or scientific decision.',question:packetProof.specificDecision,readings,locator:loc,target:n.target,...ownerEngine(this.store.root,p),fragmentHumanOrigin:{stableFragmentId:state.stableFragmentId,epoch:state.epoch,caseKey:route.caseKey,reportId:r.id,bundleId:b.id,nodeId:n.nodeId,triggerProofSha256:route.proof.sha256,packetProofPath:packetFile,packetProofSha256:hashFile(packetFile),sourceActor:authority.actor,candidateBinding}};
  let record=this.packetRecord(state.stableFragmentId);if(record?.packageId&&record.triggerProofSha256!==route.proof.sha256)check(false,'Existing packet trigger changed; preserve and diagnose its delivery before replacement',409,'HUMAN_PACKET_DELIVERY_UNKNOWN');
  if(!record?.packageId){const built=await this.packageBuilder(this.store.config,this.store.root,spec,{fixture:this.store.fixture,authority});record={stableFragmentId:state.stableFragmentId,reportId:r.id,packageId:built.packageId,triggerProofSha256:route.proof.sha256,sourceActor:authority.actor,createdAt:now()};writeJSON(path.join(this.root,'packets',state.stableFragmentId+'.json'),record);}
  authority.assert();const submitted=this.store.submit(record.packageId,r.paperId),request=this.store.request(submitted.id),packetRoot=path.join(this.store.caseRoot(submitted.id),'package');
  const crop=request.artifacts.originalCrop||request.artifacts.sourceCrop||Object.entries(request.artifacts).find(([k])=>/source.*crop|original.*crop/i.test(k))?.[1];check(crop,'Delivered human packet lacks a source crop',409,'HUMAN_PACKET_CROP_GAP');
  const packet={source_locator_and_readable_crop:{sha256:hashFile(safePath(packetRoot,crop))},initial_tex:{sha256:sha(initialRaw)},current_tex:{sha256:sha(currentRaw)},source_disposition_if_available:{sha256:hashObject(packetProof.sourceDisposition)},triggering_blind_findings:{sha256:hashObject(packetProof.blindFindings)},specific_user_decision_requested:{sha256:sha(spec.question)}};
  state=this.apply(state,this.event('human_case_delivered',{caseKey:route.caseKey,caseId:submitted.id,triggerProofSha256:route.proof.sha256,deliveryStatus:'accepted',packet},{receiptId:submitted.id,receiptSha256:hashObject(request),role:'program',actorId:'verified_human_case_ingest'}));
  record.caseId=submitted.id;record.deliveredAt=now();delete record.technicalFailure;writeJSON(path.join(this.root,'packets',state.stableFragmentId+'.json'),record);this.q.kick();return {id:r.id,status:'awaiting_human',caseId:submitted.id,stableFragmentId:state.stableFragmentId};
 }
}
