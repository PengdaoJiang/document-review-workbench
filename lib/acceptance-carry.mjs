import fs from 'node:fs';
import path from 'node:path';
import {check,hashObject,hashFile,readJSON,immutableWrite,safePath,sha,now} from './io.mjs';
import {inputManifest,verifyAuthority,verifyManifest} from './inputs.mjs';
import {validateDecisionFragment,locate} from './target.mjs';
import {sourceCandidateBinding} from './source-binding.mjs';

const conflict='Canonical version changed after the request was submitted';
const requireMatch=(ok,message)=>check(ok,message,409,'ACCEPTANCE_CARRY_MISMATCH');
function exactDecision(r,s,owner,decisionId){
  requireMatch(r.spec.owner===owner&&s.decision?.id===decisionId&&!s.supersededBy&&!!s.ownerReceivedAt,'Acceptance owner, receipt or decision differs');
  requireMatch(r.spec.category==='mandatory_fragment_human'&&s.decision.action==='accept'&&s.decision.scope==='this_passage_only','Only an unchanged mandatory fragment acceptance can carry');
  validateDecisionFragment(r,s.decision);
}

// Read a server-created immutable base. Neither callers nor worker payloads may
// supply a replacement manifest, text, decision, or lineage proof.
export function readAcceptanceBase(dataRoot,r,d,reference){
  requireMatch(reference?.kind==='unchanged_accept_after_owner_return','Unknown acceptance base');
  const file=safePath(dataRoot,reference.evidence);
  requireMatch(hashFile(file)===reference.evidenceSha256,'Acceptance base evidence changed');
  const e=readJSON(file);
  requireMatch(e.kind===reference.kind&&e.requestId===r.id&&e.requestDigest===r.intentDigest&&e.decisionId===d.id&&e.decisionSha256===hashObject(d),'Acceptance base identity changed');
  requireMatch(e.requestSha256===hashFile(safePath(dataRoot,'cases/'+r.id+'/package/request.json')),'Acceptance request changed');
  requireMatch(e.manifest.sha256===hashObject(e.manifest.files)&&e.binding.inputSha256===r.manifest.sha256&&e.binding.currentInputSha256===e.manifest.sha256&&e.binding.mode==='unchanged_fragment_after_owner_rework'&&e.binding.ownerReturns.length>0,'Acceptance lineage or manifest differs');
  requireMatch(e.targetSha256===sha(e.targetText)&&e.manifest.files.find(f=>f.file===r.spec.target.file)?.sha256===e.targetSha256,'Acceptance target bytes changed');
  requireMatch(hashObject(e.manifest.files.filter(f=>f.file!==r.spec.target.file))===hashObject(r.manifest.files.filter(f=>f.file!==r.spec.target.file)),'Acceptance dependencies changed');
  validateDecisionFragment(r,d);locate(e.targetText,r.spec.target);
  verifyManifest(safePath(dataRoot,'cases/'+r.id+'/package/inputs'),r.manifest);
  return e;
}

// Called only through the fenced source adapter while the paper owner lock is
// held. Preserve the failed state and bind a no-op acceptance to a proved newer
// input. This does not authorize an edit or a new source/mathematical judgment.
export function bindUnchangedAcceptance(store,blind,key,owner,decisionId){
  const r=store.request(key),s=store.state(key),p=store.config.papers[r.spec.paperId];
  exactDecision(r,s,owner,decisionId);requireMatch(p.owner===owner,'Registered owner differs');verifyAuthority(p);
  const outputs=safePath(p.root,'outputs'),current=inputManifest(outputs,r.main),target=safePath(outputs,r.spec.target.file),pdf=safePath(outputs,r.main.replace(/\.tex$/,'.pdf'));
  if(s.applicationBase){
    const e=readAcceptanceBase(store.root,r,s.decision,s.applicationBase);
    requireMatch(s.status==='faithful_confirmed'&&!s.application&&!s.verification&&current.sha256===e.manifest.sha256&&hashFile(pdf)===e.pdfSha256,'Acceptance base no longer matches the unapplied current version');
    return s;
  }
  requireMatch((s.status==='faithful_confirmed'||s.status==='conflict'&&s.problem===conflict)&&!s.application&&!s.verification&&!s.operations[s.decision.id+'-applied'],'Acceptance already applied or conflict is unrelated');
  const journal=path.join(p.root,'work/review-desk',sha(key+'\n'+s.decision.id).slice(0,16),'journal.json');
  requireMatch(!fs.existsSync(journal),'An existing application journal requires its own recovery');
  const pack=safePath(store.root,'cases/'+key+'/package'),seal=readJSON(safePath(pack,'seal.json'));
  requireMatch(seal.files.find(f=>f.file==='request.json')?.sha256===hashFile(safePath(pack,'request.json')),'Sealed acceptance request differs');
  verifyManifest(safePath(pack,'inputs'),r.manifest);
  const origin=r.spec.fragmentHumanOrigin,b=origin&&blind.bundle(origin.bundleId),n=b?.nodes.find(n=>n.nodeId===origin.nodeId);
  requireMatch(b?.paperId===r.spec.paperId&&b.manifest.sha256===r.manifest.sha256&&n&&hashObject(n.target)===hashObject(r.spec.target),'Acceptance is not bound to its exact frozen fragment');
  const binding=sourceCandidateBinding(blind,b,n);
  requireMatch(binding.mode==='unchanged_fragment_after_owner_rework'&&binding.ownerReturns.length>0&&binding.currentInputSha256===current.sha256,'Acceptance requires an actual bounded owner-return lineage');
  const targetText=fs.readFileSync(target,'utf8');locate(targetText,r.spec.target);
  requireMatch(inputManifest(outputs,r.main).sha256===current.sha256,'Current inputs changed during acceptance binding');
  const evidence={schemaVersion:1,kind:'unchanged_accept_after_owner_return',requestId:key,requestDigest:r.intentDigest,requestSha256:hashFile(safePath(pack,'request.json')),decisionId:s.decision.id,decisionSha256:hashObject(s.decision),stateBefore:s,manifest:current,targetText,targetSha256:sha(targetText),pdfSha256:hashFile(pdf),binding,paperApproval:false};
  const relative='application-recoveries/'+sha(key+'\n'+s.decision.id+'\n'+current.sha256).slice(0,32)+'-carry.json',file=safePath(store.root,relative,false);
  immutableWrite(file,JSON.stringify(evidence,null,2)+'\n');
  s.applicationBase={kind:evidence.kind,evidence:relative,evidenceSha256:hashFile(file)};
  s.status='faithful_confirmed';delete s.problem;
  s.events.push({at:now(),type:'unchanged_accept_base_bound',decisionId:s.decision.id,...s.applicationBase,paperApproval:false});
  return store.save(key,s);
}
