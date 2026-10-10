// Pure routing/lock algebra. No filesystem, networking, model, image or queue
// access. The caller must authenticate original receipts and atomically persist
// the returned state using expectedPreviousSha256. Hashes prove exact binding,
// not that a supplied receipt came from a real actor or that science is true.
import crypto from 'node:crypto';

const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const clone=x=>structuredClone(x);
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':object(x)?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
export const textSha256=x=>crypto.createHash('sha256').update(x).digest('hex');
export const routingHash=x=>textSha256(canonical(x));
const check=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code,technicalGap:true});};
const str=x=>typeof x==='string'&&x.length>0;
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const sealRoutingRecord=record=>({record:clone(record),sha256:routingHash(record)});
function unseal(proof,code='ROUTING_PROOF_INVALID'){
 check(object(proof)&&object(proof.record)&&hash(proof.sha256)&&routingHash(proof.record)===proof.sha256,code);return proof.record;
}
function scopeOK(scope,paperId,workflowId){
 check(object(scope)&&scope.paperId===paperId&&scope.workflowId===workflowId&&['enrolled','completed','published'].every(k=>typeof scope[k]==='boolean'),'ROUTING_SCOPE_REQUIRED');
 return scope.enrolled&&!scope.completed&&!scope.published;
}
function checkFragment(f){
 check(object(f)&&['paperId','sourceSha256','bundleId','documentSha256','inputSha256','file','semanticId','nodeId','tex','texSha256'].every(k=>typeof f[k]==='string'),'FRAGMENT_FIELDS_REQUIRED');
 check([f.sourceSha256,f.documentSha256,f.inputSha256,f.texSha256].every(hash)&&textSha256(f.tex)===f.texSha256,'FRAGMENT_HASH');
 check(f.mappingSha256===null||hash(f.mappingSha256),'FRAGMENT_SOURCE_SEAL');
 check(f.sourceTexSha256===undefined||hash(f.sourceTexSha256),'FRAGMENT_SOURCE_TEXT_HASH');
 check(f.positionUnit==='utf16'&&Number.isInteger(f.start)&&Number.isInteger(f.end)&&f.start>=0&&f.end>f.start&&f.end-f.start===f.tex.length,'FRAGMENT_EXACT_RANGE_REQUIRED');
}
const matchesHumanLock=(fragment,lock)=>lock.decidedSourceTexSha256?fragment.sourceTexSha256===lock.decidedSourceTexSha256:fragment.texSha256===lock.decidedTexSha256;
export function fragmentAliasKey(fragment){checkFragment(fragment);return routingHash(fragment);}
function sealState(s){const body=clone(s);delete body.sha256;return {...body,sha256:routingHash(body)};}
function stateOK(s){check(object(s)&&s.schemaVersion===1,'FRAGMENT_STATE_INVALID');const body={...s};delete body.sha256;check(routingHash(body)===s.sha256,'FRAGMENT_STATE_HASH');}
function acceptedEvent(event,role){
 check(object(event)&&str(event.id)&&str(event.type)&&object(event.body),'ROUTING_EVENT_REQUIRED');
 const receipt=unseal(event.receipt);
 check(receipt.status==='accepted'&&receipt.eventType===event.type&&receipt.payloadSha256===routingHash(event.body)&&receipt.actorRole===role&&str(receipt.actorId)&&object(receipt.originalReceipt)&&str(receipt.originalReceipt.id)&&hash(receipt.originalReceipt.sha256),'ROUTING_ACCEPTED_RECEIPT_REQUIRED');
 return receipt;
}

// Receives the complete, authenticated freeze/submission history projection.
// Order is first *submitted whole-document freeze*, never the newest candidate.
export function createFragmentLedger({scope,freezeHistory,initialFragment,initialDocumentText}){
 check(object(scope)&&str(scope.paperId)&&str(scope.workflowId),'ROUTING_SCOPE_REQUIRED');scopeOK(scope,scope.paperId,scope.workflowId);
 const history=unseal(freezeHistory,'INITIAL_HISTORY_PROOF_REQUIRED');
 check(history.complete===true&&history.paperId===scope.paperId&&Array.isArray(history.freezes),'INITIAL_HISTORY_INCOMPLETE');
 const candidates=history.freezes.filter(f=>f.wholeDocument===true&&f.submittedToBlind===true);
 check(candidates.length>0,'INITIAL_WHOLE_FREEZE_MISSING');
 for(const f of candidates)check(str(f.id)&&str(f.bundleId)&&str(f.firstReviewAssignmentId)&&Number.isFinite(Date.parse(f.submittedAt))&&[f.documentSha256,f.inputSha256,f.sourceSha256].every(hash)&&object(f.receipt)&&str(f.receipt.id)&&hash(f.receipt.sha256),'INITIAL_FREEZE_BINDING_REQUIRED');
 candidates.sort((a,b)=>Date.parse(a.submittedAt)-Date.parse(b.submittedAt));const first=candidates[0];
 check(candidates.filter(f=>Date.parse(f.submittedAt)===Date.parse(first.submittedAt)).every(f=>f.id===first.id&&f.bundleId===first.bundleId&&f.documentSha256===first.documentSha256),'INITIAL_FIRST_FREEZE_AMBIGUOUS');
 checkFragment(initialFragment);const f=initialFragment;
 check(f.paperId===scope.paperId&&f.bundleId===first.bundleId&&f.documentSha256===first.documentSha256&&f.inputSha256===first.inputSha256&&f.sourceSha256===first.sourceSha256&&f.mappingSha256===first.mappingSha256,'INITIAL_FRAGMENT_NOT_FIRST_DRAFT');
 check(typeof initialDocumentText==='string'&&textSha256(initialDocumentText)===first.documentSha256&&initialDocumentText.slice(f.start,f.end)===f.tex,'INITIAL_FRAGMENT_RANGE_MISMATCH');
 const key=fragmentAliasKey(f),stableFragmentId='fragment-'+routingHash({workflowId:scope.workflowId,paperId:scope.paperId,sourceSha256:f.sourceSha256,mappingSha256:f.mappingSha256,firstFreezeId:first.id,firstBundleId:first.bundleId,range:{file:f.file,start:f.start,end:f.end,positionUnit:f.positionUnit,texSha256:f.texSha256}});
 return sealState({schemaVersion:1,workflowId:scope.workflowId,paperId:scope.paperId,stableFragmentId,epoch:0,initial:{freeze:clone(first),fragment:clone(f),fragmentKey:key,historySha256:freezeHistory.sha256},aliases:[{key,fragment:clone(f),proof:{kind:'initial_exact_range',historySha256:freezeHistory.sha256}}],currentFragmentKey:key,events:[],humanLock:null,lockHistory:[],humanCase:null,caseHistory:[]});
}

export function resolveFragmentAlias(state,fragment){
 stateOK(state);checkFragment(fragment);
 const key=fragmentAliasKey(fragment),matches=state.aliases.filter(a=>a.key===key);
 check(matches.length===1,'FRAGMENT_ALIAS_UNRESOLVED');return {stableFragmentId:state.stableFragmentId,fragmentKey:key,fragment:clone(matches[0].fragment)};
}
export function resolveFragmentAcrossLedgers(states,fragment){
 check(Array.isArray(states),'FRAGMENT_REGISTRY_REQUIRED');const key=fragmentAliasKey(fragment),matches=[];
 for(const state of states){stateOK(state);if(state.aliases.some(a=>a.key===key))matches.push(state);}
 check(matches.length===1,matches.length?'FRAGMENT_ALIAS_AMBIGUOUS':'FRAGMENT_ALIAS_UNRESOLVED');
 return resolveFragmentAlias(matches[0],fragment);
}
function known(state,key){check(str(key)&&state.aliases.filter(a=>a.key===key).length===1,'FRAGMENT_ALIAS_UNRESOLVED');return state.aliases.find(a=>a.key===key).fragment;}
function current(state){return known(state,state.currentFragmentKey);}

// Narrow lexical formatting comparison only. Explicit standalone math wrappers
// allow whitespace/layout-token changes; no algebra, macro expansion, prose
// equivalence, or unsupported TeX constructs are inferred.
function mathTokens(text){
 const s=text.replace(/\r\n?/g,'\n').trim();let body;
 for(const [open,close] of [['\\[','\\]'],['\\(','\\)'],['$$','$$'],['$','$']])if(s.startsWith(open)&&s.endsWith(close)){body=s.slice(open.length,-close.length);break;}
 if(body===undefined||/[$%#&]|\\(?:text\w*|mbox|hbox|vbox|verb\*?|catcode|def|newcommand|let|input|include|begin|end|csname)\b/.test(body))return null;
 const tokens=body.match(/\\[A-Za-z]+|\\[^A-Za-z]|[^\s]/g)||[];
 const words=new Set('frac dfrac tfrac sqrt sum prod int iint lim alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega sin cos tan cot exp log ln min max inf sup overline underline hat bar vec mathrm mathbf mathcal mathbb left right cdot times pm mp le ge leq geq neq approx equiv in notin subset subseteq cup cap infty partial nabla quad qquad'.split(' '));
 if(tokens.some(t=>/^\\[A-Za-z]+$/.test(t)&&!words.has(t.slice(1))))return null;
 return tokens.filter(t=>!['\\,','\\!','\\;','\\:','\\quad','\\qquad'].includes(t));
}
export function compareInitialReading(initialTex,readingTex){
 check(typeof initialTex==='string'&&typeof readingTex==='string','SOURCE_READING_TEXT_REQUIRED');
 if(initialTex===readingTex)return {agrees:true,method:'exact_bytes'};
 if(initialTex.replace(/\r\n?/g,'\n')===readingTex.replace(/\r\n?/g,'\n'))return {agrees:true,method:'line_endings_only'};
 const a=mathTokens(initialTex),b=mathTokens(readingTex);
 if(a&&b&&routingHash(a)===routingHash(b))return {agrees:true,method:'standalone_math_lexical_formatting'};
 if(a&&b)return {agrees:false,method:'different_lexical_reading'};
 return {agrees:false,method:'not_established',scope:'No scientific equivalence or broader formatting judgment inferred.'};
}

function sourceObservation(state,event){
 acceptedEvent(event,'source');const b=event.body,f=known(state,b.fragmentKey);
 check(b.verifiedReading===true&&b.sourceSha256===f.sourceSha256&&b.mappingSha256===f.mappingSha256&&typeof b.readingTex==='string'&&b.readingTexSha256===textSha256(b.readingTex),'SOURCE_READING_BINDING_REQUIRED');
 check(['faithful_source','repair','transcription_uncertain'].includes(b.disposition),'SOURCE_BUSINESS_DISPOSITION_REQUIRED');
 const packetGaps=[];
 if(!(object(b.locator)&&Number.isInteger(b.locator.page)&&b.locator.page>0&&Array.isArray(b.locator.bbox)&&b.locator.bbox.length===4&&b.locator.bbox.every(Number.isFinite)))packetGaps.push('SOURCE_LOCATOR_REQUIRED_FOR_DELIVERY');
 if(!(object(b.crop)&&str(b.crop.id)&&hash(b.crop.sha256)))packetGaps.push('SOURCE_CROP_REQUIRED_FOR_DELIVERY');
 let comparison=compareInitialReading(state.initial.fragment.tex,b.readingTex);
 if(!comparison.agrees&&b.formattingAgreement){
  const proof=unseal(b.formattingAgreement,'FORMATTING_AGREEMENT_PROOF');
  check(proof.kind==='verified_source_formatting_only'&&proof.initialTexSha256===state.initial.fragment.texSha256&&proof.readingTexSha256===b.readingTexSha256&&proof.sourceReceiptSha256===event.receipt.record.originalReceipt.sha256&&proof.scientificEquivalenceClaimed===false,'FORMATTING_AGREEMENT_PROOF');
  comparison={agrees:true,method:'existing_verified_source_formatting_receipt'};
 }
 return {comparison,packetGaps,immediateUncertainty:b.disposition==='transcription_uncertain'};
}

function classifyBlindDecision(state,event){
 const receipt=acceptedEvent(event,'blind'),b=event.body;known(state,b.fragmentKey);
 check(str(b.businessDecisionId)&&str(b.reportId)&&object(b.opinion)&&receipt.businessDecisionId===b.businessDecisionId,'BLIND_BUSINESS_IDENTITY_REQUIRED');
 if(b.duplicateOf!==undefined)check(str(b.duplicateOf)&&b.duplicateOf!==b.businessDecisionId,'BLIND_DUPLICATE_IDENTITY_INVALID');
 let negative=false,classification='not_negative';
 if(b.opinion.kind==='completion_review'){
  check(typeof b.opinion.closed==='boolean','BLIND_EXPLICIT_OUTCOME_REQUIRED');
  if(b.opinion.closed===false){
   if(['construction_incomplete','transcription_uncertain','scientific_dispute'].includes(b.opinion.failureKind)){negative=true;classification=b.opinion.failureKind;}
   else if(b.opinion.failureKind==='technical_gap')classification='technical_gap';
   else classification='legacy_unclassified_gap';
  }
 }else if(b.opinion.kind==='mathematical_review'){
  check(['contradiction','checked_no_contradiction','unknown','unsupported','encoding_error','technical_gap','condition_gap'].includes(b.opinion.outcome),'BLIND_EXPLICIT_OUTCOME_REQUIRED');
  if(b.opinion.outcome==='contradiction'){
   const tool=unseal(b.opinion.toolReceipt,'NEGATIVE_TOOL_PROOF_REQUIRED');
   check(tool.status==='completed'&&tool.success===true&&tool.reportId===b.reportId&&tool.encodingSha256===b.opinion.encodingSha256&&tool.outcome==='contradiction','NEGATIVE_TOOL_PROOF_REQUIRED');negative=true;classification='contradiction';
  }else classification=b.opinion.outcome;
 }else if(b.opinion.kind==='initial_business_finding'){
  if(b.opinion.verdict===undefined)classification='legacy_unclassified_gap';
  else {check(['negative','positive','unresolved','technical_gap'].includes(b.opinion.verdict),'BLIND_EXPLICIT_OUTCOME_REQUIRED');negative=b.opinion.verdict==='negative';classification=b.opinion.verdict;}
 }else check(false,'BLIND_EXPLICIT_BUSINESS_KIND_REQUIRED');
 return {negative,classification,businessDecisionId:b.businessDecisionId,duplicateOf:b.duplicateOf||null,reportId:b.reportId,receiptSha256:receipt.originalReceipt.sha256};
}

function sourceReadingChange(state,event){
 acceptedEvent(event,'program');const b=event.body,f=known(state,b.fragmentKey),p=unseal(b.proof,'SOURCE_READING_CHANGE_PROOF');
 check(p.kind==='verified_source_transcription_correction'&&p.paperId===state.paperId&&p.sourceSha256===f.sourceSha256&&p.mappingSha256===f.mappingSha256&&p.initialFragmentKey===state.initial.fragmentKey&&p.initialTexSha256===state.initial.fragment.texSha256&&p.readingTexSha256===b.readingTexSha256&&p.readingTexSha256===f.texSha256&&p.initialTexSha256!==p.readingTexSha256&&str(p.reportId)&&['dispositionSha256','ownerReceiptSha256','deliverySha256','beforeAliasSha256','afterAliasSha256','readingAliasSha256'].every(k=>hash(p[k])),'SOURCE_READING_CHANGE_PROOF');
 check(state.events.some(e=>e.type==='source_reading'&&e.body.fragmentKey===b.fragmentKey&&e.body.readingTexSha256===b.readingTexSha256),'SOURCE_READING_CHANGE_RECEIPT_REQUIRED');
 return b.fragmentKey+':'+b.readingTexSha256;
}
function sourceInitialComparison(state,event){
 acceptedEvent(event,'source');const b=event.body,f=known(state,b.fragmentKey);
 check(b.initialFragmentKey===state.initial.fragmentKey&&b.initialTexSha256===state.initial.fragment.texSha256&&b.readingTexSha256===f.texSha256&&b.sourceSha256===f.sourceSha256&&b.mappingSha256===f.mappingSha256&&typeof b.agreesWithInitialDraft==='boolean'&&str(b.note)&&str(b.reportId)&&hash(b.comparisonReceiptSha256),'SOURCE_INITIAL_COMPARISON_BINDING');
 check(state.events.some(e=>e.type==='source_reading'&&e.body.fragmentKey===b.fragmentKey&&e.body.readingTexSha256===b.readingTexSha256&&e.receipt.record.originalReceipt.sha256===b.sourceReceiptSha256&&e.body.crop&&e.body.locator),'SOURCE_INITIAL_COMPARISON_SOURCE_REQUIRED');
 const lexical=compareInitialReading(state.initial.fragment.tex,f.tex);check(lexical.method==='not_established'||lexical.agrees===b.agreesWithInitialDraft,'SOURCE_INITIAL_COMPARISON_CONFLICT');
 return {key:b.fragmentKey+':'+b.readingTexSha256,agrees:b.agreesWithInitialDraft,eventId:event.id,receiptSha256:event.receipt.sha256};
}
function triggerProof(state){
 const evidence=[],negative=new Map(),receipts=new Map(),gaps=[];
 const active=state.events.filter(e=>e.epoch===state.epoch),changes=new Set(active.filter(e=>e.type==='source_reading_change_evidence').map(e=>sourceReadingChange(state,e))),sources=active.filter(e=>e.type==='source_reading').map(e=>({event:e,key:e.body.fragmentKey+':'+e.body.readingTexSha256,materialKey:e.body.sourceSha256+':'+e.body.mappingSha256+':'+e.body.readingTexSha256,observation:sourceObservation(state,e)}));
 const comparisons=new Map();for(const e of active.filter(e=>e.type==='source_initial_comparison')){const c=sourceInitialComparison(state,e),old=comparisons.get(c.key);if(old&&old.agrees!==c.agrees){old.conflict=true;gaps.push({code:'SOURCE_INITIAL_COMPARISON_CONFLICT',eventId:e.id});}else if(!old)comparisons.set(c.key,c);}
 for(const e of state.events.filter(e=>e.epoch===state.epoch)){
  if(e.type==='source_reading'){
   const key=e.body.fragmentKey+':'+e.body.readingTexSha256,r=sourceObservation(state,e);if(r.comparison.agrees)evidence.push({trigger:'source_agrees_initial',eventId:e.id,receiptSha256:e.receipt.sha256,comparison:r.comparison});
   else if(r.comparison.method==='not_established'&&!changes.has(key)){const c=comparisons.get(key);if(c&&!c.conflict){if(c.agrees)evidence.push({trigger:'source_agrees_initial',eventId:c.eventId,receiptSha256:c.receiptSha256,comparison:{agrees:true,method:'actual_source_worker_comparison'}});}else gaps.push({code:'SOURCE_INITIAL_AGREEMENT_NOT_ESTABLISHED',eventId:e.id});}
   // A later authenticated crop/locator for the same exact reading satisfies
   // the earlier disposition's missing packet material without rewriting it.
   // All events already name proved aliases of this one stable fragment. An
   // unchanged exact reading may retain its actual source crop across aliases.
   for(const code of r.packetGaps)if(sources.filter(x=>x.materialKey===e.body.sourceSha256+':'+e.body.mappingSha256+':'+e.body.readingTexSha256).every(x=>x.observation.packetGaps.includes(code)))gaps.push({code,eventId:e.id});
   if(r.immediateUncertainty)evidence.push({trigger:'source_uncertainty',eventId:e.id,receiptSha256:e.receipt.sha256});
  }
  if(e.type==='blind_decision'){
   const d=classifyBlindDecision(state,e);
   if(d.classification==='legacy_unclassified_gap')gaps.push({code:'BLIND_NEGATIVE_CLASSIFICATION_MISSING',eventId:e.id});
   const prior=negative.get(d.businessDecisionId),businessHash=routingHash({reportId:e.body.reportId,fragmentKey:e.body.fragmentKey,opinion:e.body.opinion,duplicateOf:e.body.duplicateOf||null});
   if(prior&&prior.businessHash!==businessHash){prior.conflict=true;gaps.push({code:'BLIND_BUSINESS_IDENTITY_CONFLICT',eventId:e.id});}
   else if(!prior)negative.set(d.businessDecisionId,{...d,eventIds:[e.id],businessHash});else prior.eventIds.push(e.id);
  }
 }
 const counted=[];
 for(const d of negative.values()){
  if(!d.negative||d.conflict)continue;
  if(d.duplicateOf){if(!negative.has(d.duplicateOf))gaps.push({code:'BLIND_DUPLICATE_ORIGIN_MISSING',businessDecisionId:d.businessDecisionId});continue;}
  if(receipts.has(d.receiptSha256))continue;receipts.set(d.receiptSha256,d.businessDecisionId);counted.push(d);
 }
 counted.sort((a,b)=>a.businessDecisionId.localeCompare(b.businessDecisionId));
 if(counted.length>=2)evidence.push({trigger:'two_distinct_negative_business_decisions',businessDecisionIds:counted.map(d=>d.businessDecisionId),receiptSha256s:counted.map(d=>d.receiptSha256)});
 const proof={stableFragmentId:state.stableFragmentId,workflowId:state.workflowId,paperId:state.paperId,epoch:state.epoch,initialFreezeId:state.initial.freeze.id,initialFragmentKey:state.initial.fragmentKey,evidence,negativeDecisionCount:counted.length,negativeDecisions:counted,gaps};
 return {...proof,sha256:routingHash(proof)};
}

export function evaluateFragmentRouting(state,scope){
 stateOK(state);const active=scopeOK(scope,state.paperId,state.workflowId),base={stableFragmentId:state.stableFragmentId,workflowId:state.workflowId,epoch:state.epoch,mathematicalPass:false,scientificCorrectnessCertified:false,paperApproval:false};
 if(!active)return {...base,state:'out_of_scope_preserved',humanRequired:false,mayCreateHumanCase:false,localCompletionClaim:false,reason:scope.published?'published':scope.completed?'completed':'not_enrolled'};
 if(state.humanLock){
  const exact=matchesHumanLock(current(state),state.humanLock),ready=state.humanLock.action==='accept'?exact:exact&&!!state.humanLock.mechanicalApplication;
  return {...base,state:ready?'human_decided':'human_decided_pending_mechanical_application',humanRequired:false,mayCreateHumanCase:false,localCompletionClaim:ready,closureBasis:ready?'human_decided':null,lock:clone(state.humanLock),forbidden:['source_reinspection','source_recognition','blind_review','mathematical_rechallenge','duplicate_human_case'],allowed:['apply_exact_user_edit','mechanically_verify_exact_application'],triggerEvaluationSkipped:'applicable_human_decision_takes_precedence'};
 }
 const proof=triggerProof(state),humanRequired=proof.evidence.length>0,caseKey='human-fragment-'+routingHash({workflowId:state.workflowId,stableFragmentId:state.stableFragmentId,epoch:state.epoch});
 if(state.humanCase)return {...base,state:'awaiting_human',humanRequired:true,mayCreateHumanCase:false,localCompletionClaim:false,caseKey,humanCase:clone(state.humanCase),proof};
 return {...base,state:humanRequired?'human_required':proof.gaps.length?'technical_gap':'continue_registered_work',humanRequired,mayCreateHumanCase:humanRequired,localCompletionClaim:false,caseKey,proof,packetRequirements:humanRequired?['source_locator_and_readable_crop','initial_tex','current_tex','source_disposition_if_available','triggering_blind_findings','specific_user_decision_requested']:[],multipleReadingsRequired:false};
}

export function transitionFragment(state,event,{scope}){
 stateOK(state);check(scopeOK(scope,state.paperId,state.workflowId),'FRAGMENT_SCOPE_CLOSED');
 check(object(event)&&str(event.id)&&str(event.type)&&object(event.body),'ROUTING_EVENT_REQUIRED');
 const expectedPreviousSha256=state.sha256,old=state.events.find(e=>e.id===event.id),eventHash=routingHash(event);
 if(old){check(old.eventSha256===eventHash,'ROUTING_EVENT_ID_CONFLICT');return {state:clone(state),duplicate:true,expectedPreviousSha256,routing:evaluateFragmentRouting(state,scope)};}
 const next=clone(state),b=event.body;
 if(event.type==='alias'){
  acceptedEvent(event,'program');const from=known(state,b.fromKey);checkFragment(b.to);
  check(b.to.paperId===state.paperId&&b.to.sourceSha256===state.initial.fragment.sourceSha256&&b.to.mappingSha256===state.initial.fragment.mappingSha256,'FRAGMENT_ALIAS_SOURCE_MISMATCH');
  const p=unseal(b.aliasProof,'FRAGMENT_ALIAS_PROOF_REQUIRED'),toKey=fragmentAliasKey(b.to);
  check(['mechanical_edit_lineage','unchanged_source_anchor'].includes(p.kind)&&p.fromKey===b.fromKey&&p.toKey===toKey&&Array.isArray(p.candidateKeys)&&p.candidateKeys.length===1&&p.candidateKeys[0]===toKey&&Array.isArray(p.candidateStableFragmentIds)&&p.candidateStableFragmentIds.length===1&&p.candidateStableFragmentIds[0]===state.stableFragmentId&&p.beforeInputSha256===from.inputSha256&&p.afterInputSha256===b.to.inputSha256&&object(p.originalEvidence)&&str(p.originalEvidence.id)&&hash(p.originalEvidence.sha256),'FRAGMENT_ALIAS_NOT_UNIQUE');
  if(p.kind==='mechanical_edit_lineage')check(p.reverseMatchesBefore===true,'FRAGMENT_ALIAS_PROOF_REQUIRED');
  if(p.kind==='unchanged_source_anchor')check(hash(p.sourceAnchorSha256)&&p.beforeSourceAnchorSha256===p.sourceAnchorSha256&&p.afterSourceAnchorSha256===p.sourceAnchorSha256,'FRAGMENT_ALIAS_PROOF_REQUIRED');
  if(state.humanLock)check(matchesHumanLock(b.to,state.humanLock),'HUMAN_LOCK_CONTENT_CHANGED');
  if(!next.aliases.some(a=>a.key===toKey))next.aliases.push({key:toKey,fragment:clone(b.to),proof:clone(b.aliasProof)});
  if(b.makeCurrent===true)next.currentFragmentKey=toKey;
 }else if(event.type==='source_reading'){
  check(!state.humanLock,'HUMAN_FRAGMENT_LOCKED');sourceObservation(state,event);
 }else if(event.type==='source_initial_comparison'){
  check(!state.humanLock,'HUMAN_FRAGMENT_LOCKED');sourceInitialComparison(state,event);
 }else if(event.type==='blind_decision'){
  check(!state.humanLock,'HUMAN_FRAGMENT_LOCKED');classifyBlindDecision(state,event);
 }else if(event.type==='human_case_delivered'){
  check(!state.humanLock,'HUMAN_FRAGMENT_LOCKED');acceptedEvent(event,'program');const route=evaluateFragmentRouting(state,scope);
  check(route.humanRequired&&b.caseKey===route.caseKey&&b.triggerProofSha256===(state.humanCase?.triggerProofSha256||route.proof.sha256)&&str(b.caseId),'HUMAN_CASE_TRIGGER_BINDING_REQUIRED');
  check(!state.humanCase||state.humanCase.caseId===b.caseId,'DUPLICATE_HUMAN_CASE');
  const requiredPacket=['source_locator_and_readable_crop','initial_tex','current_tex','triggering_blind_findings','specific_user_decision_requested'];
  if(state.events.some(e=>e.type==='source_reading'&&e.epoch===state.epoch))requiredPacket.push('source_disposition_if_available');
  check(b.deliveryStatus==='accepted'&&object(b.packet)&&requiredPacket.every(k=>object(b.packet[k])&&hash(b.packet[k].sha256)),'HUMAN_CASE_DELIVERY_REQUIRED');
  check(!state.humanCase||routingHash(state.humanCase.packet)===routingHash(b.packet),'HUMAN_CASE_RECEIPT_CONFLICT');
  next.humanCase=state.humanCase||{caseId:b.caseId,caseKey:b.caseKey,triggerProofSha256:b.triggerProofSha256,receipt:clone(event.receipt),packet:clone(b.packet)};
 }else if(event.type==='human_decision'){
  acceptedEvent(event,'human');known(state,b.fragmentKey);
  check(str(b.decisionId)&&['accept','edit'].includes(b.action)&&typeof b.decidedTex==='string'&&textSha256(b.decidedTex)===b.decidedTexSha256&&b.finalForFragment===true,'FINAL_HUMAN_DECISION_REQUIRED');
  check(b.decidedSourceTexSha256===undefined||typeof b.decidedSourceTex==='string'&&textSha256(b.decidedSourceTex)===b.decidedSourceTexSha256,'FINAL_HUMAN_DECISION_SOURCE_HASH');
  check(!state.humanLock||state.humanLock.decisionId===b.decisionId&&state.humanLock.action===b.action&&state.humanLock.decidedTexSha256===b.decidedTexSha256,'EXPLICIT_USER_REOPEN_REQUIRED');
  next.humanLock=state.humanLock||{id:'lock-'+routingHash({stableFragmentId:state.stableFragmentId,epoch:state.epoch,decisionId:b.decisionId}),decisionId:b.decisionId,action:b.action,decidedTex:b.decidedTex,decidedTexSha256:b.decidedTexSha256,scope:'current_reconstruction_blind_workflow',receipt:clone(event.receipt),mechanicalApplication:null,scientificCorrectnessCertified:false};
  if(b.decidedSourceTexSha256){check(!next.humanLock.decidedSourceTexSha256||next.humanLock.decidedSourceTexSha256===b.decidedSourceTexSha256,'EXPLICIT_USER_REOPEN_REQUIRED');next.humanLock.decidedSourceTexSha256=b.decidedSourceTexSha256;}
 }else if(event.type==='source_reading_change_evidence'){
  sourceReadingChange(state,event);
 }else if(event.type==='mechanical_application'){
  acceptedEvent(event,'program');check(state.humanLock,'HUMAN_LOCK_REQUIRED');const f=known(state,b.fragmentKey);
  check(b.decisionId===state.humanLock.decisionId&&b.appliedTextSha256===state.humanLock.decidedTexSha256&&matchesHumanLock(f,state.humanLock)&&f.inputSha256===b.inputSha256&&b.buildSuccess===true&&hash(b.buildReceiptSha256),'HUMAN_APPLICATION_BINDING_REQUIRED');
  next.currentFragmentKey=b.fragmentKey;next.humanLock.mechanicalApplication={body:clone(b),receipt:clone(event.receipt)};
 }else if(event.type==='explicit_user_reopen'){
  acceptedEvent(event,'human');check(state.humanLock&&b.authority==='explicit_direct_user'&&b.lockId===state.humanLock.id&&b.lockSha256===routingHash(state.humanLock)&&b.newEpoch===state.epoch+1&&str(b.reason),'EXPLICIT_USER_REOPEN_REQUIRED');
  next.lockHistory.push(clone(state.humanLock));next.humanLock=null;if(next.humanCase)next.caseHistory.push(clone(next.humanCase));next.humanCase=null;next.epoch++;
 }else check(false,'ROUTING_EVENT_TYPE_UNSUPPORTED');
 next.events.push({...clone(event),epoch:state.epoch,eventSha256:eventHash});const sealed=sealState(next);
 return {state:sealed,duplicate:false,expectedPreviousSha256,routing:evaluateFragmentRouting(sealed,scope)};
}

export function assertFragmentAction(state,scope,{action,proposedTexSha256}){
 stateOK(state);check(scopeOK(scope,state.paperId,state.workflowId),'FRAGMENT_SCOPE_CLOSED');
 if(!state.humanLock)return {allowed:true,scope:'No fragment lock; other workflow gates still apply.'};
 if(['apply_exact_user_edit','mechanically_verify_exact_application'].includes(action)){
  check(proposedTexSha256===state.humanLock.decidedTexSha256,'HUMAN_LOCK_CONTENT_CHANGED');return {allowed:true,decisionId:state.humanLock.decisionId,mathematicalReviewAllowed:false};
 }
 check(false,'HUMAN_FRAGMENT_LOCKED');
}
