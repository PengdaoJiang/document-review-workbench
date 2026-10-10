import fs from 'node:fs';
import path from 'node:path';
import {check,id,sha,hashObject,hashFile,readJSON,writeJSON,immutableWrite,now,token,safePath,uid,acquireLock} from './io.mjs';
import {inputManifest,verifyAuthority} from './inputs.mjs';
import {exportBlindText,bindNodes,completionClues,forbiddenLocation,wholeDocumentNodes} from './blind-input.mjs';
import {validateResearch,validateResearchBindings} from './research-math.mjs';
import {sourceCandidateBinding,verifyOwnerEditScope} from './source-binding.mjs';
import {completionDeliveryReceipt} from './rework-evidence.mjs';
import {DiscoveryLedger,neutralField,roleField} from './review-ledger.mjs';

const terminal=new Set(['closed_completion','closed_ruling','duplicate','rejected','checked_no_contradiction','unknown','encoding_error','source_anomaly_preserved']);
const cleanString=(s,n=8000)=>{check(typeof s==='string'&&s.trim()&&s.length<=n&&!forbiddenLocation(s),'Bounded neutral text required');return s;};
export class BlindStore {
  constructor(store,{leaseRoot}={}){this.store=store;this.root=path.join(store.root,'blind');this.leaseRoot=leaseRoot||readJSON(path.join(store.config.root,'math-config.json')).stateRoot;fs.mkdirSync(this.leaseRoot,{recursive:true});for(const d of ['bundles','reports','capabilities','rulings','checks'])fs.mkdirSync(path.join(this.root,d),{recursive:true});this.discovery=new DiscoveryLedger(this);this.reconcileRulings();}
  read(type,key){return readJSON(safePath(this.root,type+'/'+id(key)+'.json'));}
  save(type,x){writeJSON(path.join(this.root,type,id(x.id)+'.json'),x);return x;}
  all(type){return fs.readdirSync(path.join(this.root,type)).filter(f=>f.endsWith('.json')).map(f=>readJSON(path.join(this.root,type,f)));}
  bundle(key){return this.read('bundles',key);}
  report(key){return this.read('reports',key);}
  viewBundle(key){const b=this.bundle(key);check(hashObject(b.public)===b.publicDigest,'Frozen text changed',409,'BLIND_INTEGRITY');return b.public;}
  freeze(paperId,spec){
    this.assertPaperOpen?.(paperId);
    const paper=this.store.config.papers[paperId];check(paper,'Unknown paper');const outputs=path.join(paper.root,'outputs'),manifest=inputManifest(outputs,paper.main);
    const exported=exportBlindText(outputs,paper.main,manifest),nodes=bindNodes(outputs,spec.wholeDocument?wholeDocumentNodes(outputs,paper.main,exported):spec.nodes,exported);
    const identity={paperId,inputsSha256:manifest.sha256,nodes:nodes.map(n=>({semanticId:n.semanticId,contentSha256:n.contentSha256,target:n.target}))};const key=hashObject(identity).slice(0,24);
    if(fs.existsSync(path.join(this.root,'bundles',key+'.json')))return this.bundle(key);
    const pub={bundleId:key,fixture:this.store.fixture,document:{name:'manuscript.tex',text:exported.tex,sha256:exported.texSha256},nodes:nodes.map(n=>({nodeId:n.nodeId,quote:n.quote,contentSha256:n.contentSha256,kind:n.kind})),limitations:exported.limitations,clues:completionClues(exported.tex)};
    const b={id:key,paperId,owner:paper.owner,createdAt:now(),manifest,nodes,public:pub,publicDigest:hashObject(pub)};return this.save('bundles',b);
  }
  issueCapability(role,scope){
    check(['reporter','checker','reviewer_math','completion_reviewer'].includes(role),'Unknown role');
    if(role==='reporter')this.bundle(scope.bundleId);else this.report(scope.reportId);
    const report=role==='completion_reviewer'?this.report(scope.reportId):null;if(report)scope={...scope,returnedBundleId:report.returnedBundleId,completionRecoveryRevision:report.completionRecovery?.revision||0};
    const secret=token(),cap={id:sha(secret),role,...scope,createdAt:now(),expiresAt:Date.now()+8*3600000};this.save('capabilities',cap);return {capability:secret,role,scope,expiresAt:cap.expiresAt};
  }
  capability(secret){check(typeof secret==='string'&&/^[a-f0-9]{64}$/.test(secret),'Role access rejected',403,'ROLE_DENIED');let cap;try{cap=this.read('capabilities',sha(secret));}catch{check(false,'Role access rejected',403,'ROLE_DENIED');}check(cap.expiresAt>Date.now()&&!cap.revoked,'Role access expired',403,'ROLE_DENIED');this.assertCapability?.(cap);return cap;}
  publicReport(r){return {id:r.id,status:r.status,lane:r.lane,nodeId:r.nodeId,quote:r.quote,focusQuote:r.focusQuote||null,question:r.question,conditions:r.conditions,evidence:r.evidence,closure:r.closure,classification:r.classification,reason:r.publicReason||null,platformDiagnostic:r.platformDiagnostic||null};}
  roleInput(cap){
    if(cap.role==='reporter')return this.viewBundle(cap.bundleId);
    const r=this.report(cap.reportId);const bundle=cap.role==='completion_reviewer'?r.returnedBundleId:r.bundleId;check(bundle,'No affected revision is ready',409);
    if(cap.role==='completion_reviewer'&&cap.returnedBundleId)check(cap.returnedBundleId===bundle&&(cap.completionRecoveryRevision||0)===(r.completionRecovery?.revision||0),'Completion assignment has been superseded',409);
    let deliveryReceipt;if(cap.role==='completion_reviewer'&&this.workflowVersion===3){try{deliveryReceipt=completionDeliveryReceipt(this,r,this.bundle(bundle));}catch(e){deliveryReceipt={verified:false,code:'DELIVERY_EVIDENCE_GAP',scope:'Current build/comparison or registered edit-scope evidence is missing or fails its technical binding. Report a technical_gap; do not infer an unfinished TeX edit or read private files.'};}}
    return {bundle:this.viewBundle(bundle),report:this.publicReport(r),...(deliveryReceipt?{deliveryReceipt}:{}),...(cap.role==='completion_reviewer'&&r.completionRecovery?{completionRecovery:{revision:r.completionRecovery.revision,bundleId:r.completionRecovery.bundleId,deliveryReceiptSha256:r.completionRecovery.deliveryReceiptSha256,scope:r.completionRecovery.scope}}:{}),...(cap.role==='completion_reviewer'&&r.screening?.completionScope?{completionScope:r.screening.completionScope}:{}),...(cap.role==='reviewer_math'&&r.auditedRecovery?{auditedRecovery:{encoding:r.encoding,tool:{engine:'wolfram',encodingSha256:r.encoding.sha256,task:r.encoding.task},attempt:r.auditedRecovery.attempt,scope:'Use this exact audited payload once after the platform repair. No new encoding or assumptions.'}}:{})};
  }
  submit(cap,body){
    this.assertPaperOpen?.(this.bundle(cap.bundleId).paperId);
    check(cap.role==='reporter','Reporter capability required',403);const b=this.bundle(cap.bundleId),pub=this.viewBundle(b.id);
    roleField(body.bundleId===b.id&&body.documentSha256===pub.document.sha256,'bundleId/documentSha256','assigned_frozen_version');
    const n=b.nodes.find(n=>n.nodeId===body.nodeId);roleField(n&&body.quote===n.quote,'nodeId/quote','exact_assigned_node');
    roleField(['completion','math'].includes(body.lane),'lane','completion_or_math');
    const question=neutralField(body.question,'question'),evidence=neutralField(body.evidence,'evidence'),conditions=neutralField(body.conditions,'conditions'),closure=neutralField(body.closure,'closure');
    roleField(Array.isArray(body.citations)&&body.citations.length>0&&body.citations.every(q=>typeof q==='string'&&q.length>2&&pub.document.text.includes(q)),'citations','verbatim_frozen_definitions');
    const dispute=neutralField(body.dispute,'dispute',2000);
    if(body.focusQuote!==undefined)roleField(typeof body.focusQuote==='string'&&body.focusQuote.length>3&&n.quote.includes(body.focusQuote),'focusQuote','exact_substring_of_node');
    const identity={bundleId:b.id,nodeId:n.nodeId,lane:body.lane,question,evidence,conditions,closure,dispute,citations:body.citations,...(body.focusQuote!==undefined?{focusQuote:body.focusQuote}:{}),...(body.businessVerdict!==undefined?{businessVerdict:body.businessVerdict}:{})};const key=hashObject(identity).slice(0,24);
    if(fs.existsSync(path.join(this.root,'reports',key+'.json')))return this.publicReport(this.report(key));
    this.humanRouting?.assertNodeAction(b.id,n.nodeId,'new_blind_report',body.focusQuote||body.quote);
    if(this.humanRouting?.enabled&&body.lane==='completion')roleField(['negative','question','technical_gap'].includes(body.businessVerdict),'businessVerdict','explicit_business_opinion');
    if(body.businessVerdict!==undefined)roleField(['negative','question','technical_gap'].includes(body.businessVerdict),'businessVerdict','explicit_business_opinion');
    let r={id:key,...identity,paperId:b.paperId,semanticId:n.semanticId,quote:n.quote,contentSha256:n.contentSha256,createdAt:now(),status:body.lane==='math'?'math_queued':'supervision_triage',classification:body.classification||'clue',...(body.businessVerdict?{businessVerdict:body.businessVerdict}:{}),submittedBy:{capabilityId:cap.id,assignmentId:cap.assignmentId,roleId:cap.roleId},attempts:0,events:[{at:now(),type:'reported'}]};
    // Conservative per-fragment quarantine also catches paraphrased disputes and
    // different issue IDs. Same source-confirmed content cannot be rechallenged.
    const ruling=this.matchRuling(r);r.priorRulings=this.all('rulings').filter(x=>x.paperId===r.paperId&&x.semanticId===r.semanticId&&x.closed&&x.acceptedContentSha256!==r.contentSha256).map(x=>({id:x.id,reuse:'not_reused_target_content_changed',oldDecisionPreserved:true}));
    // Node/focus equality is not proposition equality. Only unchanged complete
    // concern content may be linked across bundles; exact retries use the ID above.
    const concern=p=>hashObject(Object.fromEntries(['lane','question','evidence','conditions','closure','dispute','citations','focusQuote','businessVerdict'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]])));
    const prior=this.all('reports').find(p=>p.paperId===r.paperId&&p.semanticId===r.semanticId&&p.contentSha256===r.contentSha256&&concern(p)===concern(r)&&!['duplicate','rejected','encoding_error'].includes(p.status));
    if(ruling){r.status='closed_ruling';r.rulingId=ruling.id;r.publicReason='This local transcription dispute is already closed; scientific validity is not implied.';}
    else if(prior){r.status='duplicate';r.duplicateOf=prior.id;r.publicReason='This unchanged complete concern is already in the review chain.';}
    else if(r.lane==='completion'&&r.classification==='explicit_placeholder'&&/^\s*(?:\\textbf\{)?(?:TODO|TBD|FIXME)\s*:/i.test(r.quote)){r.status='owner_rework';r.attempts=1;}
    this.save('reports',r);this.humanRouting?.reconcileReport(r);return this.publicReport(r);
  }
  screen(key,{action,reason,completionScope,affectedSemanticIds,reworkKind='construction',repairSpan}){
    const r=this.report(key);this.humanRouting?.assertReportAction(r,'source_repair');check(['supervision_triage','source_triage'].includes(r.status),'Only engineering clues or returned source locations require screening',409);cleanString(reason);check(['owner_rework','rejected'].includes(action),'Unknown screening action');
    check(['construction','transcription_correction'].includes(reworkKind),'Explicit construction or source correction route required');if(reworkKind==='transcription_correction')check(r.status==='source_triage','A source correction needs an original-source check',409);
    if(repairSpan){const b=this.bundle(r.reworkBaseBundleId||r.bundleId),n=b.nodes.find(n=>n.semanticId===r.semanticId);check(r.status==='source_triage'&&affectedSemanticIds?.length===1&&repairSpan.file===n.target.file&&typeof repairSpan.oldText==='string'&&repairSpan.oldText.length<=32768&&repairSpan.oldText.includes(n.target.oldText),'One bounded exact repair span covering the reported fragment required');sourceCandidateBinding(this,b,{...n,target:repairSpan});}
    if(completionScope!==undefined){check(action==='owner_rework'&&completionScope&&Object.keys(completionScope).length===3&&['question','conditions','closure'].every(k=>Object.hasOwn(completionScope,k)),'Bounded construction-only recheck scope required');for(const k of ['question','conditions','closure'])cleanString(completionScope[k]);}
    if(affectedSemanticIds!==undefined){check(r.status==='source_triage'&&completionScope&&Array.isArray(affectedSemanticIds)&&affectedSemanticIds.length>0&&affectedSemanticIds.length<=8&&new Set(affectedSemanticIds).size===affectedSemanticIds.length&&affectedSemanticIds[0]===r.semanticId,'Source-screened bounded fragment set required');const b=this.bundle(r.reworkBaseBundleId||r.bundleId);for(const id of affectedSemanticIds){const node=b.nodes.find(n=>n.semanticId===id);check(node,'Affected fragment is not in the frozen input');sourceCandidateBinding(this,b,node);}}
    let candidateBinding;
    if(r.status==='source_triage'){const b=this.bundle(r.reworkBaseBundleId||r.bundleId),p=this.store.config.papers[r.paperId],n=b.nodes.find(n=>n.semanticId===r.semanticId);verifyAuthority(p);check(n.locatorEvidence?.sourceSha256===p.source.sha256&&n.locatorEvidence?.mappingSha256===(p.mapping?.sha256||null),'Located source changed before screening',409,'VERSION_CONFLICT');candidateBinding=sourceCandidateBinding(this,b,n);}
    r.status=action;r.attempts=action==='owner_rework'?1:0;r.screening={at:now(),reason,reworkKind,...(repairSpan?{repairSpan}:{}),...(candidateBinding?{candidateBinding}:{}),...(completionScope?{completionScope}: {}),...(affectedSemanticIds?{affectedSemanticIds}: {})};r.events.push({at:now(),type:action});return this.save('reports',r);
  }
  claimMath(){
    this.expireClaims();const running=this.all('reports').find(r=>r.status==='math_checking');check(!running,'One mathematics checker is already active',409,'MATH_BUSY');
    const r=this.all('reports').filter(r=>r.status==='math_queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];if(!r)return {empty:true};
    const release=acquireLock(path.join(this.leaseRoot,'review-desk-dispatch.lock'));try{const location=path.join(this.leaseRoot,'review-desk-checker-lease.json'),lease=fs.existsSync(location)?readJSON(location):null;check(!lease||lease.expiresAt<Date.now(),'One machine-wide checker lease is active',409,'MATH_BUSY');check(!fs.existsSync(path.join(this.leaseRoot,'review-desk-math-owner.lock')),'An active tool must finish before a new checker is admitted',409,'MATH_BUSY');
      r.status='math_checking';r.checkAttempt=(r.checkAttempt||0)+1;r.claim={id:uid(),expiresAt:Date.now()+30*60000};writeJSON(location,{claimId:r.claim.id,pool:path.resolve(this.store.root),reportId:r.id,expiresAt:r.claim.expiresAt,serverPid:process.pid});r.events.push({at:now(),type:'math_claimed'});this.save('reports',r);return {report:this.publicReport(r),...this.issueCapability('checker',{reportId:r.id,claimId:r.claim.id})};
    }finally{release();}
  }
  claimReviewerMath(key,roleId){const r=this.report(key);this.humanRouting?.assertReportAction(r,'math_admission');check(r.status==='math_queued'&&typeof roleId==='string','Original reviewer mathematical assignment required',409);r.status='math_checking';r.checkAttempt=(r.checkAttempt||0)+1;r.claim={id:uid(),expiresAt:Date.now()+2*3600000,roleId,kind:'reviewer_context',holdsWolframRegistration:false};r.events.push({at:now(),type:'original_reviewer_math_assigned',roleId});this.save('reports',r);return {report:this.publicReport(r),...this.issueCapability('reviewer_math',{reportId:r.id,claimId:r.claim.id,roleId})};}
  releaseClaim(r){const location=path.join(this.leaseRoot,'review-desk-checker-lease.json');if(fs.existsSync(location)&&readJSON(location).claimId===r.claim?.id)fs.unlinkSync(location);}
  expireClaims(){for(const r of this.all('reports'))if(r.status==='math_checking'&&r.claim.expiresAt<Date.now()&&!this.claimManaged?.(r)){r.status=r.claim.kind==='reviewer_context'?'math_resource_blocked':'unknown';r.publicReason='Mathematical role capability expired without a conclusion; technical receipt recovery is required. This says nothing about the mathematical conditions or Wolfram registration.';r.events.push({at:now(),type:'checker_timeout'});this.save('reports',r);this.releaseClaim(r);}}
  checker(cap){check(['checker','reviewer_math'].includes(cap.role),'Mathematical reviewer capability required',403);const r=this.report(cap.reportId);this.humanRouting?.assertReportAction(r,'mathematical_check');check(r.status==='math_checking'&&cap.claimId===r.claim.id&&r.claim.expiresAt>Date.now(),'Mathematical assignment is no longer active',409);return r;}
  recordEncoding(cap,body){const r=this.checker(cap);check(body.documentSha256===this.viewBundle(r.bundleId).document.sha256,'Encoding input version differs',409);check(body.faithful===true,'Incorrect encoding must be returned, not executed');
    if(r.auditedRecovery){check(hashObject(body)===r.auditedRecovery.encodingSha256,'Audited technical recovery cannot alter the encoding',409);return {encodingSha256:r.encoding.sha256};}
    for(const k of ['mapping','domains','quantifiers','bounds','precision','assumptions'])cleanString(body[k]);
    check(body.assumptions==='only_written_conditions','Unstated assumptions are not admitted');check(Array.isArray(body.citations)&&body.citations.length&&body.citations.every(q=>this.viewBundle(r.bundleId).document.text.includes(q)),'Encoding citations must be verbatim');
    check(body.task&&typeof body.task==='object','Exact tool expression required in encoding audit');if(body.task.operation==='research'){try{validateResearch(body.task);validateResearchBindings(body.task,body.researchBindings,body.citations);if(!this.store.fixture)check(!body.researchBindings.some(x=>x.basis==='fixture_mutation'),'Fixture hypotheses cannot enter production research',422,'ENCODING_ERROR');}catch(e){writeJSON(path.join(this.root,'encoding-rejections',uid()+'.json'),{reportId:r.id,at:now(),code:e.code||'ENCODING_ERROR',body,reviewer:cap.id});throw e;}}if(r.encoding?.reviewer===cap.id&&r.encoding.sha256===hashObject(body))return {encodingSha256:r.encoding.sha256};r.encoding={...body,sha256:hashObject(body),reviewer:cap.id,at:now()};r.encodings=[...(r.encodings||[]),r.encoding];this.save('reports',r);return {encodingSha256:r.encoding.sha256};
  }
  finishMath(cap,body){
    check(['checker','reviewer_math'].includes(cap.role),'Mathematical reviewer capability required',403);const previous=this.report(cap.reportId);
    if(previous.mathResult?.reviewer===cap.id||this.sameAttemptBusiness(previous.mathResult?.reviewer,cap)){const {at,reviewer,...oldBody}=previous.mathResult;check(hashObject(oldBody)===hashObject(body),'Completed mathematical receipt differs',409);return this.publicReport(previous);}
    const r=this.checker(cap);check(['contradiction','checked_no_contradiction','unknown','encoding_error'].includes(body.outcome),'Unknown mathematics outcome');cleanString(body.explanation);
    if(['contradiction','checked_no_contradiction'].includes(body.outcome)){check(r.encoding&&body.encodingSha256===r.encoding.sha256,'Audited encoding required');const t=this.read('checks',body.toolReceiptId);check(t.reportId===r.id&&t.encodingSha256===r.encoding.sha256&&t.success,'Matching completed tool evidence required');if(t.task.operation==='research')check(t.public.evidence.conclusion===body.outcome,'Conclusion exceeds the actual evidence role',409);r.toolReceiptId=t.id;}
    const checkFile=body.toolReceiptId?path.join(this.root,'checks',id(body.toolReceiptId)+'.json'):null,tool=checkFile&&fs.existsSync(checkFile)?readJSON(checkFile):null,resourceRequest=body.toolReceiptId?path.join(this.root,'tool-requests',id(body.toolReceiptId)+'.json'):null;
    const resourceRecord=resourceRequest&&fs.existsSync(resourceRequest)?readJSON(resourceRequest):null,resourceAssessments=['resource_blocked','resource_or_dependency_gap','resource_timeout','runtime_failure','output_bound'];
    const resourceBlocked=body.outcome==='unknown'&&(resourceAssessments.includes(tool?.public?.evidence?.assessment)||(resourceRecord&&(['resource_blocked','recovery_required'].includes(resourceRecord.status)||resourceAssessments.includes(resourceRecord.result?.evidence?.assessment))));
    if(tool)check(tool.reportId===r.id&&tool.encodingSha256===r.encoding?.sha256,'Result receipt must belong to this report and encoding',409,'ENCODING_ERROR');
    if(r.mathRecoveryPending&&tool&&tool.executionCompleted!==false&&!resourceBlocked&&body.outcome!=='encoding_error'&&tool.public?.evidence?.assessment!=='encoding_error')delete r.mathRecoveryPending;
    r.mathResult={...body,at:now(),reviewer:cap.id};r.status=resourceBlocked?'math_resource_blocked':r.sourceObservation?'source_anomaly_preserved':body.outcome==='contradiction'?'bridge_pending':body.outcome;r.publicReason=body.explanation;r.events.push({at:now(),type:r.status});this.save('reports',r);this.releaseClaim(r);return this.publicReport(r);
  }
  receiveRework(paperId,key){const r=this.report(key);this.humanRouting?.assertReportAction(r,'source_reinspection');check(r.paperId===paperId&&(r.status==='owner_rework'||(r.receivedAt&&['completion_recheck','closed_completion','closed_source_correction'].includes(r.status))),'No matching owner rework',409);if(!r.receivedAt){r.receivedAt=now();r.events.push({at:now(),type:'owner_received'});this.save('reports',r);}return r;}
  returnRework(paperId,key,bundleId,receipt){
    this.assertPaperOpen?.(paperId);
    const r=this.report(key),b=this.bundle(bundleId);check(r.paperId===paperId,'Owner differs',403);if(r.returnedBundleId===bundleId&&['completion_recheck','closed_completion','closed_source_correction'].includes(r.status)){check(hashObject(r.ownerReceipt)===hashObject(receipt),'Repeated receipt differs',409);return r;}this.humanRouting?.assertReportAction(r,'source_return');check(r.status==='owner_rework'&&r.receivedAt,'Owner must receive this rework',409);const n=b.nodes.find(n=>n.semanticId===r.semanticId);
    const registeredBase=r.ownerDisposition?.payload.disposition==='repair'&&r.reworkBaseBundleId?this.bundle(r.reworkBaseBundleId):null,baseNode=registeredBase?.nodes.find(x=>x.semanticId===r.semanticId);
    check(!registeredBase||registeredBase.paperId===paperId&&registeredBase.owner===b.owner&&baseNode,'Registered repair base identity required',409,'REPAIR_BASE_IDENTITY');
    check(b.paperId===paperId&&n&&n.contentSha256!==(baseNode?.contentSha256||r.contentSha256),'Revised affected fragment required');check(receipt.success&&receipt.inputSha256===b.manifest.sha256&&receipt.comparisonSha256&&receipt.pdfSha256,'Fresh revision/build/comparison receipt required');
    if(r.screening?.affectedSemanticIds)check(hashObject(receipt.affectedSemanticIds)===hashObject(r.screening.affectedSemanticIds)&&r.screening.affectedSemanticIds.every(id=>b.nodes.some(n=>n.semanticId===id)),'Every screened fragment requires a returned build and comparison',409);
    if(r.ownerDisposition?.payload.disposition==='repair'||r.screening?.repairSpan)r.editScopeReceipt=verifyOwnerEditScope(this,r,b);
    r.returnedBundleId=b.id;r.ownerReceipt=receipt;r.status=r.screening?.reworkKind==='transcription_correction'&&this.workflowVersion!==3?'closed_source_correction':'completion_recheck';r.events.push({at:now(),type:r.status,scope:'Declared local source correction or construction only; no new mathematical verdict or paper approval'});return this.save('reports',r);
  }
  sameAttemptBusiness(oldId,cap){if(!oldId||!cap.cliActor)return false;const old=this.read('capabilities',oldId);return ['role','reportId','claimId','returnedBundleId','completionRecoveryRevision'].every(k=>old[k]===cap[k])&&(old.assignmentId===cap.assignmentId||(!old.assignmentId&&old.roleId===cap.roleId&&!!cap.claimId));}
  completionReview(cap,body){check(cap.role==='completion_reviewer','Completion reviewer capability required',403);const r=this.report(cap.reportId);if(r.reviews?.at(-1)?.reviewer===cap.id||this.sameAttemptBusiness(r.reviews?.at(-1)?.reviewer,cap)){const {at,reviewer,...oldBody}=r.reviews.at(-1);check(hashObject(oldBody)===hashObject(body),'Completed review receipt differs',409);return this.publicReport(r);}this.humanRouting?.assertReportAction(r,'completion_recheck');check(r.status==='completion_recheck'&&body.bundleId===r.returnedBundleId,'Affected revision differs',409);cleanString(body.explanation);check(typeof body.closed==='boolean','Explicit local closure required');
    if(cap.returnedBundleId)check(cap.returnedBundleId===r.returnedBundleId&&(cap.completionRecoveryRevision||0)===(r.completionRecovery?.revision||0),'Completion assignment has been superseded',409);
    if(this.workflowVersion===3&&(body.closed||body.deliveryReceiptSha256!==undefined)){const delivery=completionDeliveryReceipt(this,r,this.bundle(r.returnedBundleId));if(body.deliveryReceiptSha256!==undefined)check(body.deliveryReceiptSha256===delivery.sha256,'Delivery evidence changed. Refresh input for this same assignment, then submit its current proof; no review has been recorded.',409,'DELIVERY_EVIDENCE_CHANGED');}
    if(!body.closed&&body.failureKind!==undefined)check(['construction_incomplete','transcription_uncertain','scientific_dispute','technical_gap'].includes(body.failureKind),'Name the unresolved issue type');
    if(!body.closed&&body.failureKind==='construction_incomplete')check(Array.isArray(body.remaining)&&body.remaining.length>0&&body.remaining.length<=8&&body.remaining.every(x=>typeof x==='string'&&x.length>=10&&x.length<=2000),'Identify the concrete unfinished fragments');
    r.reviews=[...(r.reviews||[]),{...body,at:now(),reviewer:cap.id}];
    // Only demonstrated unfinished construction can trigger another owner edit.
    // A missing legacy classification or a scientific objection never does.
    r.status=body.closed?'closed_completion':body.failureKind==='construction_incomplete'&&r.attempts<2?'owner_rework':'owner_escalation';
    if(r.status==='owner_rework'){r.attempts++;delete r.receivedAt;}r.events.push({at:now(),type:r.status,failureKind:body.failureKind||null});this.save('reports',r);this.humanRouting?.reconcileReport(r);return this.publicReport(r);
  }
  matchRuling(r){return this.all('rulings').find(x=>x.paperId===r.paperId&&x.semanticId===r.semanticId&&x.acceptedContentSha256===r.contentSha256&&x.sourceSha256===this.store.config.papers[r.paperId].source.sha256&&x.scope==='local_transcription'&&x.closed);}
  reconcileRulings(){
    for(const r of this.all('reports'))if(r.caseId){let s;try{s=this.store.state(r.caseId);}catch{continue;}if(!s.decision)continue;const req=this.store.request(r.caseId),d=s.decision;const key=sha(r.caseId+'\n'+d.id).slice(0,24),old=this.all('rulings').find(x=>x.id===key);
      const verifiedEdit=d.action==='edit'&&s.status==='verified';const closed=d.action==='accept'||verifiedEdit;
      const value={id:key,paperId:r.paperId,semanticId:r.semanticId,dispute:r.dispute,sourceSha256:req.source.sha256,locator:req.spec.locator,originalContentSha256:r.contentSha256,acceptedContentSha256:sha(d.action==='accept'?req.spec.target?.oldText||r.quote:d.tex),closed,scope:'local_transcription',scientificValidity:'not_adjudicated',fixture:this.store.fixture,decision:d,caseId:r.caseId,at:old?.at||now(),verifiedEdit};
      if(!old||hashObject(old)!==hashObject(value))this.save('rulings',value);
      const next=closed?'closed_ruling':d.action==='return'?'needs_source_evidence':'awaiting_owner_edit';if(r.status!==next){r.status=next;r.rulingId=key;r.events.push({at:now(),type:next});this.save('reports',r);}
    }
  }
  summary(){const reports=this.all('reports'),checks=this.all('checks');return {reports:reports.map(r=>({...r,toolEvidence:checks.filter(c=>c.reportId===r.id).map(c=>c.public)})),rulings:this.all('rulings'),counts:Object.fromEntries(['math_queued','math_checking','owner_rework','completion_recheck','bridge_pending','awaiting_human','closed_ruling','closed_completion','checked_no_contradiction','unknown','encoding_error','needs_source_evidence','owner_escalation'].map(s=>[s,reports.filter(r=>r.status===s).length])),roles:{permanentReporters:0,permanentCheckers:0,automaticModelPolling:false},limits:['TeX-only inspection cannot prove complete source coverage.','Role endpoints enforce allowlists; full-access agents are not OS-sandboxed.']};}
}
