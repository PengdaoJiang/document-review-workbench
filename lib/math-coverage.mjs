import fs from 'node:fs';
import path from 'node:path';
import {check,hashObject,hashFile,writeJSON,readJSON,now,id} from './io.mjs';
import {inputManifest} from './inputs.mjs';
import {neutralField,roleField,mathTechnicalGap} from './review-ledger.mjs';
import {humanOnlyReadingClosure,readingCoverageStatus} from './reading-continuity.mjs';
import {frozenMathBinding,actualRecoveryCandidates,validateActualRecovery,verifyActualRecoveries} from './math-history-binding.mjs';
import {continuityPlan,reviewContinuityInput,expandDelta,verifyDeltaReceipt} from './math-continuity.mjs';

// Lexical locators only, never a formula parser or a claim of mathematical truth.
export function mathematicalSpans(nodes){
  const out=[];
  const re=/\\begin\{(equation\*?|align\*?|alignat\*?|gather\*?|multline\*?|eqnarray\*?|displaymath|math)\}[\s\S]*?\\end\{\1\}|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|(?<!\\)\$(?!\$)[\s\S]*?(?<!\\)\$/g;
  for(const n of nodes)for(const m of n.quote.matchAll(re))out.push({spanId:hashObject({nodeId:n.nodeId,start:m.index,quote:m[0]}).slice(0,24),nodeId:n.nodeId,start:m.index,end:m.index+m[0].length,quote:m[0]});
  return out;
}

const finalStatuses=new Set(['checked','unknown','unsupported','condition_gap']);
const changedVersionGap='The paper input changed; this inventory cannot cover the new version';
export function sameCitationOccurrences(before,after,citations){
  for(const quote of new Set(citations)){
    let start=0,count=0;
    while((start=before.indexOf(quote,start))!==-1){
      const context=before.slice(Math.max(0,start-64),Math.min(before.length,start+quote.length+64));
      if(!after.includes(context))return false;start+=quote.length;if(++count>10000)return false;
    }
    if(!count)return false;
  }return true;
}
export class MathCoverage {
  constructor(q){this.q=q;this.blind=q.blind;this.root=path.join(q.root,'math-coverage');fs.mkdirSync(this.root,{recursive:true});}
  get enabled(){return this.q.v3&&this.q.settings.exhaustiveReview?.enabled===true;}
  all(){return fs.readdirSync(this.root).filter(f=>f.endsWith('.json')).map(f=>readJSON(path.join(this.root,f)));}
  latest(paperId){return this.all().filter(x=>x.paperId===paperId).sort((a,b)=>b.at.localeCompare(a.at)||b.revision-a.revision)[0];}
  current(paperId){const p=this.q.store.config.papers[paperId];return inputManifest(path.join(p.root,'outputs'),p.main).sha256;}
  humanClosure(paperId,current=this.current(paperId)){if(!this.q.humanRouting?.enabled)return null;for(const b of this.blind.all('bundles').filter(b=>b.paperId===paperId&&b.manifest.sha256===current)){const h=humanOnlyReadingClosure(this.q,b.id);if(h)return {...h,inventoryId:null,checked:0,mathematicalPass:false};}return null;}
  snapshotComplete(x){try{if(x)verifyActualRecoveries(this.q,x);if(x?.retainedCoverage)verifyDeltaReceipt(this.q,x);if(x?.humanCoverage)this.q.humanRouting?.verifyHumanCoverage(x);return !!x&&x.final===true&&Array.isArray(x.gaps)&&x.gaps.every(g=>g===changedVersionGap);}catch{return false;}}
  pendingHumanDelivery(x){
    try{
      if(x?.final!==true||!x.humanCoverage||typeof x.humanStateRevision!=='string'||!Array.isArray(x.gaps))return null;
      verifyActualRecoveries(this.q,x);if(x.retainedCoverage)verifyDeltaReceipt(this.q,x);check(this.q.humanRouting?.enabled,'Human routing is required');this.q.humanRouting.verifyHumanCoverage(x);
      const nodes=x.nodes.filter(n=>n.disposition==='human_pending').map(n=>n.nodeId);if(!nodes.length)return null;
      const allowed=new Set(nodes.map(id=>'Required human decision remains pending: '+id));
      if(!nodes.every(id=>x.gaps.includes('Required human decision remains pending: '+id))||x.gaps.some(g=>g!==changedVersionGap&&!allowed.has(g)))return null;
      return {nodeIds:nodes,humanStateRevision:x.humanStateRevision,scope:'Actual unexcluded inventory delivered; required human decisions and current-version paper completion remain pending.',paperApproval:false};
    }catch{return null;}
  }
  reviewWorkDelivered(x){return this.snapshotComplete(x)||!!this.pendingHumanDelivery(x);}
  settleSupersededSnapshot(j,x){
    if(!['review','math_supplement','incremental_review'].includes(j.kind)||!this.snapshotComplete(x)||!x.gaps.includes(changedVersionGap))return false;
    const b=this.blind.bundle(j.bundleId),current=this.current(j.paperId);
    if(x.assignmentId!==j.id||x.bundleId!==b.id||x.inputSha256!==b.manifest.sha256||x.documentSha256!==b.public.document.sha256||current===x.inputSha256)return false;
    // Delivery of a complete assigned snapshot releases the role for the owner's
    // pending return. It never supplies coverage for the changed live manuscript.
    j.events??=[];j.events.push({at:now(),type:'assigned_snapshot_delivery_reconciled',inventoryId:x.id,previousStatus:j.status,...(j.problem?{previousProblem:j.problem}:{})});
    j.status='completed';j.result='assigned_snapshot_delivered_current_version_pending';delete j.problem;
    j.versionContinuation={at:now(),inventoryId:x.id,inventorySha256:hashFile(path.join(this.root,x.id+'.json')),assignedInputSha256:x.inputSha256,currentInputSha256:current,responsibleRoleId:j.roleId,responsibleThreadId:j.recipient,currentVersionCovered:false,nextStep:'Original reviewer checks queued owner returns, then the scheduler delivers the updated version for mathematical coverage.'};
    this.q.save(j);return true;
  }
  reconcileAssignments({paperId=null}={}){
    if(!this.enabled)return;
    for(const j of this.q.jobs().filter(j=>(!paperId||j.paperId===paperId)&&['review','math_supplement','incremental_review'].includes(j.kind)&&['received','review_incomplete','receipt_missing'].includes(j.status))){
      const x=this.all().filter(x=>x.assignmentId===j.id).sort((a,b)=>b.revision-a.revision)[0];
      if(x)this.settleSupersededSnapshot(j,x);
    }
  }
  next(role,index,papers=this.q.settings.paperGroups[index]){
    if(!this.enabled)return null;
    for(const paperId of papers){
      if(this.humanClosure(paperId))continue;
      if(this.q.settings.additionalReview?.paperIds.includes(paperId)&&!this.q.jobs().some(j=>j.kind==='review'&&j.paperId===paperId))continue;
      const previous=this.latest(paperId),current=this.current(paperId),humanRevision=this.q.humanRouting?.enabled?this.q.humanRouting.decisionRevision(paperId):null;
      if(previous?.inputSha256===current&&this.snapshotComplete(previous))continue;
      if(previous?.inputSha256===current&&this.pendingHumanDelivery(previous)&&previous.humanStateRevision===humanRevision)continue;
      if(this.q.jobs().some(j=>['math_supplement','incremental_review'].includes(j.kind)&&j.paperId===paperId&&j.inputSha256===current&&(j.humanRevision||null)===humanRevision))continue;
      // An owner in the middle of an edit retains the sole writer. Wait for its
      // existing return, then freeze this delivered revision without editing it.
      const reports=this.blind.all('reports').filter(r=>r.paperId===paperId);
      if(reports.some(r=>!this.q.humanRouting?.blocksReport(r)&&['owner_rework','awaiting_owner_edit','completion_recheck'].includes(r.status)))continue;
      const delivered=this.blind.all('bundles').some(b=>b.paperId===paperId&&b.manifest.sha256===current&&
        (this.q.all('freezes').some(f=>f.bundleId===b.id)||reports.some(r=>r.returnedBundleId===b.id&&r.ownerReceipt&&['closed_completion','closed_ruling','closed_source_correction'].includes(r.status))));
      if(!delivered)continue;
      const b=this.blind.freeze(paperId,{wholeDocument:true});check(b.manifest.sha256===current&&this.current(paperId)===current,'Delivered input changed while scheduling',409,'VERSION_CONFLICT');
      const j=this.q.create(previous?'incremental_review':'math_supplement',role.threadId,{roleId:role.roleId,paperId,bundleId:b.id,inputSha256:current,coverageRevision:this.q.settings.exhaustiveReview.revision,groupPapers:papers,...(humanRevision?{humanRevision}:{}),...(previous?{baselineInventoryId:previous.id,baselineInventorySha256:hashFile(path.join(this.root,previous.id+'.json'))}:{})});
      if(previous)continuityPlan(this.q,j);
      this.q.materialize(j,this.blind.issueCapability('reporter',{bundleId:b.id,assignmentId:j.id,roleId:role.roleId}));return j;
    }
    return null;
  }
  input(cap){
    const b=this.blind.bundle(cap.bundleId),job=this.q.get(cap.assignmentId),current=this.current(b.paperId);
    const continuity=reviewContinuityInput(this.q,cap);
    return {...this.blind.viewBundle(b.id),...(continuity?{reviewContinuity:continuity}:{}),assignment:{id:job.id,kind:job.kind,groupPapers:job.groupPapers||[b.paperId]},
      version:{assignedInputSha256:b.manifest.sha256,currentInputSha256:current,isCurrent:b.manifest.sha256===current,scope:'This assignment input is immutable. Submit its actual inventory; a complete old snapshot is retained while updated-version coverage remains pending. The scheduler delivers owner returns and the subsequent version separately.'},
      delivery:this.blind.discovery.forCap(cap).map(x=>({...this.blind.discovery.public(x),payload:x.payload})),
      inventory:this.latest(b.paperId)||null,mathematicalSpans:mathematicalSpans(b.public.nodes),
      existingReading:this.q.all('coverage').filter(c=>c.assignmentId===job.id&&c.bundleId===b.id).map(c=>({id:c.id,assignmentId:c.assignmentId,bundleId:c.bundleId,documentSha256:c.documentSha256,sha256:hashFile(path.join(this.q.root,'coverage',c.id+'.json')),status:readingCoverageStatus(this.q,c),scope:'This accepted reading receipt is immutable and reused. Do not resubmit it with human-excluded nodes removed; human states are projected separately.'})),
      existingEvidence:this.blind.all('reports').filter(r=>r.paperId===b.paperId).map(r=>({report:this.blind.publicReport(r),bundleId:r.bundleId,documentSha256:this.blind.viewBundle(r.bundleId).document.sha256,citations:r.citations,encoding:r.encoding,mathResult:r.mathResult,tool:r.mathResult?.toolReceiptId?this.blind.all('checks').find(x=>x.id===r.mathResult.toolReceiptId)?.public:null,inventoryBinding:this.reportBinding(r,b),technicalGap:mathTechnicalGap(this.blind,r),sourceReadingClosed:!!r.sourceObservation||r.status==='closed_ruling',scope:'Prior mathematical evidence only. A closed source reading is not a mathematical pass; never reopen it for the same reason.'})),
      requirements:{discoveryReconciliation:true,mathematicalCoverage:this.enabled,perPaperCheckLimit:null,scope:'All applicable TeX equations, derivations, stated conditions and numerical relations; source pixels and full algorithm reproduction are outside this assignment.'}};
  }
  reportBinding(r,b){
    const original=this.blind.bundle(r.bundleId),citations=[...new Set([...(r.citations||[]),...(r.encoding?.citations||[])])],focusQuote=r.focusQuote||r.quote;
    let assignedNodeIds=b.nodes.filter(n=>n.semanticId===r.semanticId&&n.quote.includes(focusQuote)).map(n=>n.nodeId),exactFrozenBinding=null;
    try{exactFrozenBinding=frozenMathBinding(this.q,original,original.nodes.find(n=>n.nodeId===r.nodeId),b);assignedNodeIds=[exactFrozenBinding.targetNodeId];}catch{}
    const binding={reportId:r.id,originalBundleId:r.bundleId,originalDocumentSha256:original.public.document.sha256,assignedBundleId:b.id,assignedDocumentSha256:b.public.document.sha256,claim:r.question,conditions:r.conditions,requiredQuote:focusQuote,originalQuoteSha256:hashObject(r.quote),citationsSha256:hashObject(citations),assignedNodeIds,...(exactFrozenBinding?{exactFrozenBinding}:{}),actualRecoveryCandidates:actualRecoveryCandidates(this.q,r,b),requiredQuotePresent:b.public.nodes.some(n=>n.quote.includes(focusQuote)),allOriginalQuotesPresent:[r.quote,...citations].every(q=>b.public.document.text.includes(q)),citationContextsUnchanged:sameCitationOccurrences(original.public.document.text,b.public.document.text,citations)};
    return {...binding,sha256:hashObject(binding),scope:'Exact interface binding only. Reassessment records new assigned-version reasoning; it does not reuse or erase a historical tool result.'};
  }
  submit(cap,body){
    this.q.humanRouting?.beginEvaluation?.();try{
    check(this.enabled&&cap.role==='reporter','Original reviewer mathematical inventory required',403,'ROLE_DENIED');
    const j=this.q.get(cap.assignmentId),b=this.blind.bundle(cap.bundleId),submittedDelta=body;
    const committed=this.all().find(x=>x.assignmentId===j.id&&x.revision===body.revision);
    if(committed){check(committed.bodySha256===hashObject(body),'Inventory revision is immutable; submit the next revision',409,'INVENTORY_CONFLICT');verifyActualRecoveries(this.q,committed);verifyDeltaReceipt(this.q,committed);return this.receipt(committed);}
    if(j.kind==='incremental_review')roleField(!!body.continuity,'continuity','incremental_scope_and_actual_impact_receipt_required');
    const expanded=expandDelta(this.q,cap,body);body=expanded.body;const inheritedIds=new Set(expanded.proof?.retainedItems.map(x=>x.itemId)||[]);
    roleField(body.assignmentId===j.id&&body.bundleId===b.id&&body.documentSha256===b.public.document.sha256,'assignmentId/bundleId/documentSha256','exact_assigned_revision');
    roleField(Number.isInteger(body.revision)&&body.revision>=1,'revision','positive_integer');
    roleField(Array.isArray(body.nodes)&&Array.isArray(body.items),'nodes/items','arrays');
    neutralField(body.summary,'summary',12000);
    const previous=this.all().filter(x=>x.assignmentId===j.id),same=previous.find(x=>x.revision===body.revision),digest=hashObject(submittedDelta);
    if(same){check(same.bodySha256===digest,'Inventory revision is immutable; submit the next revision',409,'INVENTORY_CONFLICT');return this.receipt(same);}
    check(body.revision===(Math.max(0,...previous.map(x=>x.revision))+1),'Next inventory revision required',409,'INVENTORY_CONFLICT');
    const itemIds=new Set(),nodeIds=new Set(),gaps=[],referencedReports=new Set(),reuseBindings=[],reassessmentBindings=[],technicalRecoveryBindings=[];
    for(const item of body.items){
      id(item.id);roleField(!itemIds.has(item.id),'items.id','unique');itemIds.add(item.id);
      if(inheritedIds.has(item.id)){for(const key of item.reportIds||[])referencedReports.add(key);continue;}
      const node=b.public.nodes.find(n=>n.nodeId===item.nodeId);
      roleField(node&&typeof item.quote==='string'&&item.quote.length>0&&node.quote.includes(item.quote),'items.quote','verbatim_assigned_fragment');
      roleField(['equation','derivation','condition','numerical_relation'].includes(item.kind),'items.kind','mathematical_category');
      neutralField(item.conditions,'items.conditions');neutralField(item.evidence,'items.evidence');
      roleField(['planned','technical_gap',...finalStatuses].includes(item.status),'items.status','explicit_check_or_limitation');
      if(!finalStatuses.has(item.status))gaps.push('Unfinished item '+item.id+': '+item.status);
      const refs=item.reportIds||[];roleField(Array.isArray(refs),'items.reportIds','array');
      for(const key of refs){
        const r=this.blind.report(key);referencedReports.add(key);roleField(r.paperId===b.paperId,'items.reportIds','same_paper');
        roleField(item.claim===r.question&&item.conditions===r.conditions,'items.claim/conditions','exact_report_proposition_and_conditions');
        const original=this.blind.bundle(r.bundleId),originalNode=original.nodes.find(n=>n.nodeId===r.nodeId);
        roleField(node.quote.includes(r.focusQuote||r.quote)&&item.quote===(r.focusQuote||r.quote),'items.quote','exact_report_focus_or_full_report_node');
        if(r.bundleId===b.id)roleField(item.nodeId===r.nodeId,'items.nodeId','evidence_belongs_to_this_node');
        if(item.method==='reuse'){
          roleField(item.conditions===r.conditions&&[r.quote,...r.citations,...(r.encoding?.citations||[])].every(q=>b.public.document.text.includes(q)),'items.reuse','unchanged_quote_conditions_and_all_cited_dependencies');
          roleField(sameCitationOccurrences(original.public.document.text,b.public.document.text,[...r.citations,...(r.encoding?.citations||[])]),'items.reuse','every_original_citation_occurrence_and_context_unchanged');
          const binding=frozenMathBinding(this.q,original,originalNode,b);roleField(binding.targetNodeId===item.nodeId,'items.nodeId','exact_mapped_frozen_evidence_node');reuseBindings.push({reportId:r.id,binding});
        }else roleField(r.bundleId===b.id||['planned','technical_gap'].includes(item.status),'items.reportIds','current_version_or_explicit_reuse');
        if(mathTechnicalGap(this.blind,r))gaps.push('Technical evidence unresolved: '+key);
        if(item.status==='checked')roleField(['contradiction','checked_no_contradiction'].includes(r.mathResult?.outcome),'items.status','checked_requires_conclusive_evidence');
        if(!r.mathResult&&r.lane==='math'&&!['closed_ruling','duplicate'].includes(r.status))gaps.push('Mathematical report has no result: '+key);
      }
      if(item.status!=='planned')roleField(['reasoning','tool','reuse'].includes(item.method),'items.method','reasoning_tool_or_reuse');
      if(item.method==='tool'||item.method==='reuse')roleField(refs.length>0,'items.reportIds','evidence_reference_required');
      if(item.status==='checked'&&item.method==='reasoning')roleField(item.evidence.length>=40,'items.evidence','actual_bounded_reasoning_required');
    }
    // Historical dependencies may change while the concern remains applicable.
    // Link an explicit new review to that identity instead of silently reusing
    // its old tool result or requiring the reviewer to pretend it disappeared.
    const reassessed=new Set();roleField(body.reassessments===undefined||Array.isArray(body.reassessments),'reassessments','array');
    for(const entry of body.reassessments||[]){
      const r=this.blind.report(entry.reportId),binding=this.reportBinding(r,b);
      roleField(!reassessed.has(r.id)&&!referencedReports.has(r.id)&&r.paperId===b.paperId&&r.bundleId!==b.id,'reassessments.reportId','unique_historical_same_paper_report');
      roleField(entry.bindingSha256===binding.sha256&&entry.claim===r.question&&entry.conditions===r.conditions,'reassessments.bindingSha256/claim/conditions','exact_exposed_historical_concern');
      roleField(!binding.allOriginalQuotesPresent||!binding.citationContextsUnchanged,'reassessments','changed_historical_text_or_dependency_context');
      roleField(!mathTechnicalGap(this.blind,r)&&!['math_queued','math_checking','math_resource_blocked','encoding_error'].includes(r.status)&&!!r.mathResult,'reassessments.reportId','technical_or_unfinished_report_requires_actual_recovery');
      roleField(Array.isArray(entry.itemIds)&&entry.itemIds.length>0&&new Set(entry.itemIds).size===entry.itemIds.length,'reassessments.itemIds','distinct_current_review_items');
      const items=entry.itemIds.map(key=>body.items.find(x=>x.id===key));
      roleField(items.every(x=>x&&finalStatuses.has(x.status)&&['reasoning','tool'].includes(x.method))&&items.some(x=>binding.assignedNodeIds.includes(x.nodeId)),'reassessments.itemIds','fresh_assigned_review_in_corresponding_node');
      neutralField(entry.reason,'reassessments.reason');roleField(entry.reason.length>=40,'reassessments.reason','explain_changed_context_and_current_assessment');
      reassessed.add(r.id);referencedReports.add(r.id);reassessmentBindings.push({reportId:r.id,binding,itemIds:entry.itemIds,reason:entry.reason,historicalResultReused:false});
    }
    const recovered=new Set();roleField(body.technicalRecoveries===undefined||Array.isArray(body.technicalRecoveries),'technicalRecoveries','array');
    const recoveryEntries=[...(body.technicalRecoveries||[])];
    if(expanded.proof){
      const base=readJSON(path.join(this.root,expanded.proof.baseInventoryId+'.json'));verifyActualRecoveries(this.q,base);
      for(const prior of base.technicalRecoveryBindings||[]){
        if(recoveryEntries.some(x=>x.reportId===prior.reportId)||!prior.itemIds.every(id=>inheritedIds.has(id)))continue;
        const r=this.blind.report(prior.reportId),binding=this.reportBinding(r,b),candidate=binding.actualRecoveryCandidates.find(x=>x.reportId===prior.recoveryReportId);
        if(candidate)recoveryEntries.push({reportId:r.id,bindingSha256:binding.sha256,claim:r.question,conditions:r.conditions,recoveryReportId:candidate.reportId,recoveryReportEvidenceSha256:candidate.reportEvidenceSha256,toolReceiptId:candidate.toolReceiptId,toolReceiptSha256:candidate.toolReceiptSha256,itemIds:prior.itemIds,reason:prior.reason});
      }
    }
    for(const entry of recoveryEntries){
      const r=this.blind.report(entry.reportId);roleField(!recovered.has(r.id)&&!referencedReports.has(r.id)&&r.paperId===b.paperId,'technicalRecoveries.reportId','unique_unreferenced_same_paper_failure');
      const proof=validateActualRecovery(this.q,r,b,entry,body.items,this.reportBinding(r,b));technicalRecoveryBindings.push(proof);recovered.add(r.id);referencedReports.add(r.id);
    }
    for(const node of body.nodes){
      roleField(b.public.nodes.some(n=>n.nodeId===node.nodeId)&&!nodeIds.has(node.nodeId),'nodes.nodeId','unique_assigned_node');nodeIds.add(node.nodeId);
      roleField(['applicable','not_applicable','unexamined','human_decided','human_pending'].includes(node.disposition),'nodes.disposition','explicit_applicability');neutralField(node.reason,'nodes.reason',2000);
      if(node.disposition.startsWith('human_'))roleField(expanded.humanCoverage?.some(x=>x.nodeId===node.nodeId&&hashObject(x)===hashObject(node.humanBinding)),'nodes.humanBinding','server_bound_actual_human_scope');
      roleField(Array.isArray(node.itemIds)&&node.itemIds.every(k=>body.items.some(i=>i.id===k&&i.nodeId===node.nodeId)),'nodes.itemIds','items_in_this_node');
      if(node.disposition==='applicable'&&!node.itemIds.length)gaps.push('Applicable node has no checks: '+node.nodeId);
      if(node.disposition==='unexamined')gaps.push('Unexamined node: '+node.nodeId);
      if(node.disposition==='human_pending')gaps.push('Required human decision remains pending: '+node.nodeId);
    }
    if(nodeIds.size!==b.public.nodes.length)gaps.push('Mathematical applicability inventory does not cover every indexed node');
    for(const item of body.items)if(!body.nodes.some(n=>n.nodeId===item.nodeId&&n.disposition==='applicable'&&n.itemIds.includes(item.id)))gaps.push('Unmapped mathematical item: '+item.id);
    const spans=mathematicalSpans(b.public.nodes),decisions=body.spans||[];
    roleField(Array.isArray(decisions)&&new Set(decisions.map(x=>x.spanId)).size===decisions.length,'spans','distinct_mathematical_fragment_decisions');
    for(const d of decisions){const s=spans.find(x=>x.spanId===d.spanId);roleField(s,'spans.spanId','assigned_lexical_math_fragment');neutralField(d.reason,'spans.reason',2000);
      roleField(['covered','not_applicable','unexamined','human_decided','human_pending'].includes(d.disposition),'spans.disposition','covered_not_applicable_or_unexamined');
      if(d.disposition.startsWith('human_'))roleField(expanded.humanCoverage?.some(x=>x.nodeId===s.nodeId&&hashObject(x)===hashObject(d.humanBinding)),'spans.humanBinding','server_bound_actual_human_scope');
      if(d.disposition==='covered')roleField(Array.isArray(d.itemIds)&&d.itemIds.length&&d.itemIds.every(k=>body.items.some(i=>i.id===k&&i.nodeId===s.nodeId&&(i.quote.includes(s.quote)||s.quote.includes(i.quote)))),'spans.itemIds','explicit_check_covers_this_mathematical_fragment');
      if(d.disposition==='unexamined')gaps.push('Unexamined mathematical fragment: '+s.spanId);
    }
    if(decisions.length!==spans.length)gaps.push('Visible mathematical fragments remain unmapped');
    for(const r of this.blind.all('reports').filter(r=>r.paperId===b.paperId&&r.lane==='math')){
      if(this.q.humanRouting?.blocksReport?.(r)||this.q.humanRouting?.reportRoute(r)?.state==='human_decided')continue;
      if(['math_queued','math_checking','math_resource_blocked','encoding_error'].includes(r.status))gaps.push('Outstanding mathematical report: '+r.id);
      if(!['duplicate','closed_ruling','rejected'].includes(r.status)&&!referencedReports.has(r.id)){
        const excluded=(body.excludedReports||[]).find(x=>x.reportId===r.id);
        if(!excluded||b.public.document.text.includes(r.quote))gaps.push('Applicable existing mathematical report is absent from inventory: '+r.id);
        else neutralField(excluded.reason,'excludedReports.reason');
      }
    }
    try{this.blind.discovery.verifyDelivery(cap,body.delivery);}catch{gaps.push('Discoveries have not all been durably accepted and reconciled');}
    if(this.blind.discovery.all().some(d=>d.paperId===b.paperId&&!this.blind.discovery.accepted(d)))gaps.push('Earlier discovery delivery remains unresolved');
    if(this.blind.all('reports').some(r=>r.paperId===b.paperId&&mathTechnicalGap(this.blind,r)&&!recovered.has(r.id)&&!this.q.humanRouting?.blocksReport?.(r)&&this.q.humanRouting?.reportRoute(r)?.state!=='human_decided'))gaps.push('Earlier mathematical technical failure remains unresolved');
    if(this.current(b.paperId)!==b.manifest.sha256)gaps.push(changedVersionGap);
    const x={...body,id:hashObject({assignmentId:j.id,revision:body.revision,digest}).slice(0,24),paperId:b.paperId,inputSha256:b.manifest.sha256,roleId:cap.roleId,threadId:cap.cliActor?this.q.blindExecutors.actor(cap).threadId:j.recipient,...(cap.cliActor?{workerActor:this.q.blindExecutors.actor(cap)}:{}),bodySha256:digest,...(expanded.proof?{retainedCoverage:expanded.proof,submittedDelta}:{}),...(expanded.humanCoverage?{humanCoverage:expanded.humanCoverage,submittedDelta}:{}),at:now(),complete:body.final===true&&gaps.length===0,gaps:[...new Set(gaps)],reuseBindings,reassessmentBindings,technicalRecoveryBindings,scope:'Reconstruction mathematical review coverage; human_decided is workflow closure only, never a mathematical pass.'};
    if(expanded.humanCoverage)x.humanStateRevision=this.q.humanRouting.decisionRevision(b.paperId);
    writeJSON(path.join(this.root,x.id+'.json'),x);j.inventoryId=x.id;j.inventoryAt=x.at;
    if(x.complete){j.status='completed';j.result='mathematical_review_recorded';}else if(this.pendingHumanDelivery(x)){j.status='completed';j.result='unexcluded_review_delivered_human_pending';j.humanContinuation={inventoryId:x.id,inventorySha256:hashFile(path.join(this.root,x.id+'.json')),inputSha256:x.inputSha256,humanStateRevision:x.humanStateRevision,paperApproval:false};}else if(!this.settleSupersededSnapshot(j,x)&&body.final)j.status='review_incomplete';
    this.q.save(j);this.q.kick();return this.receipt(x);
    }finally{this.q.humanRouting?.endEvaluation?.();}
  }
  receipt(x){return {id:x.id,assignmentId:x.assignmentId,revision:x.revision,complete:x.complete,snapshotComplete:this.snapshotComplete(x),reviewWorkDelivered:this.reviewWorkDelivered(x),humanPending:this.pendingHumanDelivery(x)?.nodeIds.length||0,currentVersionAtSubmission:!x.gaps.includes(changedVersionGap),gaps:x.gaps,checked:x.items.filter(i=>i.status==='checked').length,limited:x.items.filter(i=>['unknown','unsupported','condition_gap'].includes(i.status)).length,retainedChecks:x.retainedCoverage?.retainedItems.length||0,actualDeltaChecks:x.items.filter(i=>i.status==='checked'&&!x.retainedCoverage?.retainedItems.some(r=>r.itemId===i.id)).length};}
  gaps(paperId,current){
    if(!this.enabled)return [];
    const x=this.latest(paperId),gaps=[];
    if((!x||x.inputSha256!==current||!this.snapshotComplete(x))&&!this.humanClosure(paperId,current))gaps.push('Current-version exhaustive mathematical review is incomplete');
    const pending=this.blind.discovery.all().filter(d=>d.paperId===paperId&&!this.blind.discovery.accepted(d));
    if(pending.length)gaps.push('Discovery delivery unresolved: '+pending.map(x=>x.id).join(', '));
    return gaps;
  }
  summary(){const inventories=this.all().sort((a,b)=>b.at.localeCompare(a.at)||b.revision-a.revision),discoveries=this.blind.discovery.all();return {enabled:this.enabled,papers:(this.q.paperIds?.()||this.q.settings.paperGroups.flat()).map(paperId=>{
    const latest=inventories.find(x=>x.paperId===paperId),current=this.current(paperId),humanClosure=this.humanClosure(paperId,current),gaps=[];
    if(this.enabled){if((!latest||latest.inputSha256!==current||!this.snapshotComplete(latest))&&!humanClosure)gaps.push('Current-version exhaustive mathematical review is incomplete');const pending=discoveries.filter(d=>d.paperId===paperId&&!this.blind.discovery.accepted(d));if(pending.length)gaps.push('Discovery delivery unresolved: '+pending.map(x=>x.id).join(', '));}
    return {...(latest?this.receipt(latest):{checked:0,limited:0}),paperId,currentInputSha256:current,inventoryId:latest?.id||null,...(humanClosure?{humanClosure}:{}),status:humanClosure?'human_decided':latest?.inputSha256!==current?'unexamined':this.snapshotComplete(latest)?'reviewed':'incomplete',gaps,
      outstandingItems:latest?.items.filter(i=>!finalStatuses.has(i.status)).length||0,unexaminedFragments:latest?.spans?.filter(s=>s.disposition==='unexamined').length||0,detailGaps:latest?.gaps||[]};
  })};}
}
