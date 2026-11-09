// Supervisor-only immutable source enrollment. Call mutations only under the
// existing coverage writer lock. No process control, execution or scientific credit.
import fs from 'node:fs';
import path from 'node:path';
import {canonical, hash, fileRef, checkRef, readBoundText} from './coverage-core.mjs';
import {safeWithin} from '../../coverage-context.mjs';
import {validateSourceBinding, resolveSourceView} from './source-binding.mjs';
import {writeOnceOrMatch} from '../../repair-flow.mjs';

const base='research_followup/network3_campaign';
const releaseBase=base+'/architecture/source-supplement-20261029';
const protocolBase=base+'/protocols/source-binding-v1';
const protocol='source-supplement-v1';
const insist=(ok,message)=>{if(!ok)throw Error('Source admission: '+message);};
const text=value=>typeof value==='string'&&value.trim().length>0;
const same=(a,b)=>canonical(a)===canonical(b);
const key=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
const sameRef=(root,a,b)=>a&&b&&key(path.resolve(root,a.path))===key(path.resolve(root,b.path))&&a.sha256===b.sha256;
const read=filename=>JSON.parse(fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,''));
const bound=(root,ref)=>JSON.parse(readBoundText(root,ref).replace(/^\uFEFF/,''));
const unique=refs=>[...new Map(refs.filter(Boolean).map(ref=>[key(ref.path)+':'+ref.sha256,ref])).values()];
const sourceIdentityRefs=view=>[view.baseScan,view.binding.index,view.binding.record,view.binding.includingResource,view.binding.supplement];
const names=['coverage.mjs','coverage-guard.mjs','coverage-recovery.mjs','source-admission.mjs','source-binding.mjs','coverage-core.mjs','coverage-scope.mjs','coverage-context.mjs','coverage-reader.mjs','coverage-authoring.mjs','coverage-kit.mjs','coverage-batch.mjs','coverage-review-parts.mjs'];
function shape(value,fields,label){insist(value&&typeof value==='object'&&!Array.isArray(value)&&same(Object.keys(value).sort(),fields.slice().sort()),label+' has missing or unknown fields');}
function refShape(ref){shape(ref,['path','sha256'],'Reference');insist(text(ref.path)&&/^[a-f0-9]{64}$/.test(ref.sha256),'Invalid reference');}
function scoped(root,ref,directory,exact=null){refShape(ref);const target=safeWithin(safeWithin(root,directory),path.resolve(root,ref.path));if(exact)insist(key(target)===key(path.resolve(root,exact)),'Reference is not the exact required path');return checkRef(root,ref);}
function freeze(root,name,value){writeOnceOrMatch(safeWithin(root,name),canonical(value));return fileRef(root,name);}
function releaseFor(root,ref){
  scoped(root,ref,releaseBase,releaseBase+'/release-manifest.json');
  const release=bound(root,ref);
  insist(release.schemaVersion===1&&release.releaseId==='source-supplement-20261029'&&release.protocol===protocol,'Unknown source release');
  insist(Array.isArray(release.modules)&&release.modules.length===names.length&&new Set(release.modules.map(row=>row.name)).size===names.length,'Incomplete source release module set');
  const refs=[ref];
  for(const name of names){
    const row=release.modules.find(row=>row.name===name);insist(row,'Missing source release module '+name);
    shape(row,['name','installed','frozen'],'Release module');
    scoped(root,row.installed,protocolBase,protocolBase+'/'+name);
    scoped(root,row.frozen,releaseBase+'/release',releaseBase+'/release/'+name);
    insist(row.installed.sha256===row.frozen.sha256,'Source installed/released bytes differ');refs.push(row.installed,row.frozen);
  }
  shape(release.repairScope,['paperId','iteration','baseScan','sourceBindingSha256'],'Repair scope');
  insist(release.repairScope.iteration===1&&text(release.repairScope.paperId)&&/^[a-f0-9]{64}$/.test(release.repairScope.sourceBindingSha256),'Invalid source repair grant');
  return {release,refs};
}
export const sourcePhase=value=>typeof value==='string'&&['ready','working','awaiting_review','reviewing','review_received','assessed','complete'].some(phase=>value==='source_'+phase);

export function adoptSource({root,state,paper,request,operationId}){
  shape(request,['schemaVersion','expectedRevision','paperId','iteration','agent','supervisor','reason','scan','order','guardEnrollment','sourceBinding','releaseManifest','ownerCheckpoint'],'Source-adopt request');
  insist(request.schemaVersion===1&&request.expectedRevision===state.revision,'Invalid source-adopt revision/schema');
  const authority=bound(root,state.authority);
  insist(request.supervisor===(authority.supervisorThreadId??authority.supervisor?.threadId)&&text(request.reason),'Only the bound scientific supervisor may adopt');
  insist(!paper.sourceEnrollment&&paper.phase==='working'&&paper.iteration===1&&request.iteration===1&&paper.paperId===request.paperId,'Adoption requires the original c001 working branch');
  insist(paper.owner?.role==='worker'&&paper.owner.agent===request.agent&&(paper.workerHistory??[]).includes(request.agent),'Adoption must preserve the registered original worker');
  insist(!paper.latest&&!paper.staged&&Array.isArray(paper.history)&&paper.history.length===0,'Adoption cannot migrate staged or historical coverage');
  insist(sameRef(root,request.scan,paper.scan)&&sameRef(root,request.order,paper.order)&&paper.guardEnrollment&&same(request.guardEnrollment,paper.guardEnrollment),'Adoption changed original scan/order/guard enrollment');
  const originalGuard=bound(root,paper.guardEnrollment.profile);
  insist(state.guardPolicy&&sameRef(root,originalGuard.policy,state.guardPolicy),'Adoption must retain the active original guard policy');
  const workRoot='research_followup/reproduction_clean/coverage_work/'+paper.paperId+'/c001';
  insist(key(safeWithin(root,paper.workRoot))===key(path.resolve(root,workRoot)),'Adoption private root differs from original version');
  scoped(root,request.ownerCheckpoint,workRoot,workRoot+'/source-adoption-checkpoint.json');
  const checkpoint=bound(root,request.ownerCheckpoint);
  shape(checkpoint,['schemaVersion','status','paperId','revision','agent','role','scan','order','guardEnrollment','noActiveCalculation','noConcurrentReadWrite','preservedDrafts','checkpointedAt'],'Original actor safe checkpoint');
  insist(checkpoint.schemaVersion===1&&checkpoint.status==='source_adoption_safe_checkpoint'&&checkpoint.paperId===paper.paperId&&checkpoint.revision===1&&checkpoint.agent===paper.owner.agent&&checkpoint.role==='worker','Original actor checkpoint identity mismatch');
  insist(checkpoint.noActiveCalculation===true&&checkpoint.noConcurrentReadWrite===true&&text(checkpoint.checkpointedAt)&&Number.isFinite(Date.parse(checkpoint.checkpointedAt)),'Original actor is not at a confirmed no-calculation/no-read-write safe checkpoint');
  insist(sameRef(root,checkpoint.scan,paper.scan)&&sameRef(root,checkpoint.order,paper.order)&&same(checkpoint.guardEnrollment,paper.guardEnrollment),'Checkpoint changed original input/order');
  insist(Array.isArray(checkpoint.preservedDrafts),'Checkpoint must explicitly preserve existing draft refs');
  for(const ref of checkpoint.preservedDrafts)scoped(root,ref,workRoot);
  // Only neutral architecture declarations or supervisor requests can propose a binding.
  refShape(request.sourceBinding);
  const bindingPath=path.resolve(root,request.sourceBinding.path), inRoot=directory=>{try{safeWithin(safeWithin(root,directory),bindingPath);return true;}catch{return false;}};
  insist(inRoot(releaseBase)||inRoot(base+'/coverage/requests'),'Proposed binding is outside authorized public admission roots');
  const binding=bound(root,request.sourceBinding),scan=bound(root,paper.scan);
  const verified=validateSourceBinding({root,scan,binding,reference:request.sourceBinding});
  const {release,refs:releaseRefs}=releaseFor(root,request.releaseManifest),scope=release.repairScope;
  insist(scope.paperId===paper.paperId&&sameRef(root,scope.baseScan,paper.scan)&&scope.sourceBindingSha256===hash(canonical(binding)),'Proposed binding is outside exact release repair scope');
  const directory=base+'/coverage/'+paper.paperId+'/c001';
  for(const name of ['candidate.json','review.json','decision.json'])insist(!fs.existsSync(safeWithin(root,directory+'/'+name)),'Adoption cannot bypass an existing frozen delivery');
  const refs=unique([state.authority,request.ownerCheckpoint,request.sourceBinding,...sourceIdentityRefs(verified),paper.scan,paper.order,paper.guardEnrollment.profile,paper.guardEnrollment.instructions,...checkpoint.preservedDrafts,...releaseRefs]);
  let committed=[];
  const recheck=()=>{verified.recheck();for(const ref of refs)checkRef(root,ref);};
  return {recheck,references:()=>unique([...refs,...committed]),commit(){
    recheck();
    const sourceBinding=freeze(root,directory+'/source-binding.json',binding);
    const profile=freeze(root,directory+'/source-enrollment.json',{schemaVersion:1,protocol,paperId:paper.paperId,iteration:1,operationId,adoptedAtRevision:state.revision+1,supervisor:request.supervisor,reason:request.reason,originalOwner:paper.owner,scan:paper.scan,order:paper.order,guardEnrollment:paper.guardEnrollment,workRoot:paper.workRoot,ownerCheckpoint:request.ownerCheckpoint,preservedDrafts:checkpoint.preservedDrafts,sourceBinding,releaseManifest:request.releaseManifest});
    const orderPath=directory+'/source-supplement.md';
    writeOnceOrMatch(safeWithin(root,orderPath),'# Exact source supplement\n\nPaper '+paper.paperId+'/c001; original actor, order, scan and drafts are preserved.\n\nSource binding: '+canonical(sourceBinding)+'\nRelease: '+canonical(request.releaseManifest)+'\n\nPreserve every original checkpoint draft reference as immutable: '+canonical(checkpoint.preservedDrafts)+'. Never overwrite legacy candidate.json, source-scope.json, review.json, scope-review.json or terminal.json. Worker outputs candidate-source-v2.json and source-scope-v2.json; reviewer outputs review-source-v2.json and scope-review-v2.json; finished original or successor actors use terminal-source-v2.json. Read the exact additional inert source listing through research_followup/network3_campaign/protocols/source-binding-v1/coverage-reader.mjs before continuing. Use coverage-kit.mjs, coverage-authoring.mjs, coverage-review-parts.mjs and coverage-batch.mjs in that same parallel directory. Do not execute it merely to inspect it. Candidate, review, decision, source-scope and scope-review require schemaVersion 2 and this exact sourceBinding. scanSha256 remains the original base scan hash. Use only the parallel source-binding-v1 CLI. This transport repair grants no scientific acceptance and does not replace independent inventory/evidence review.\n');
    const supplementOrder=fileRef(root,orderPath);committed=[sourceBinding,profile,supplementOrder];
    return {protocol,profile,sourceBinding,releaseManifest:request.releaseManifest,supplementOrder};
  }};
}

export function sourceAdmissionReferences(root,paper){
  insist(paper?.sourceEnrollment&&sourcePhase(paper.phase),'Expected an enrolled source_* branch; use unchanged v1 CLI for other papers');
  const enrollment=paper.sourceEnrollment;
  shape(enrollment,['protocol','profile','sourceBinding','releaseManifest','supplementOrder'],'Source enrollment');
  insist(enrollment.protocol===protocol,'Unknown source enrollment protocol');
  const directory=base+'/coverage/'+paper.paperId+'/c001';
  scoped(root,enrollment.profile,directory,directory+'/source-enrollment.json');
  scoped(root,enrollment.sourceBinding,directory,directory+'/source-binding.json');
  scoped(root,enrollment.supplementOrder,directory,directory+'/source-supplement.md');
  const profile=bound(root,enrollment.profile),{release,refs:releaseRefs}=releaseFor(root,enrollment.releaseManifest);
  insist(profile.schemaVersion===1&&profile.protocol===protocol&&profile.paperId===paper.paperId&&profile.iteration===1&&sameRef(root,profile.scan,paper.scan)&&sameRef(root,profile.sourceBinding,enrollment.sourceBinding)&&sameRef(root,profile.releaseManifest,enrollment.releaseManifest),'Source enrollment immutable identity mismatch');
  insist(release.repairScope.paperId===paper.paperId&&sameRef(root,release.repairScope.baseScan,paper.scan)&&release.repairScope.sourceBindingSha256===enrollment.sourceBinding.sha256,'Enrolled binding differs from exact release scope');
  if(paper.iteration===1)insist(sameRef(root,profile.order,paper.order)&&same(profile.guardEnrollment,paper.guardEnrollment),'Original adopted order/guard enrollment changed');
  insist((paper.workerHistory??[]).includes(profile.originalOwner.agent),'Original adopted actor was removed');
  if(paper.phase==='source_working')insist(paper.owner?.role==='worker'&&(paper.workerHistory??[]).includes(paper.owner.agent),'Current worker lacks explicit original or successor registration');
  const view=resolveSourceView({root,scan:bound(root,paper.scan),sourceBinding:enrollment.sourceBinding});
  const refs=unique([enrollment.profile,enrollment.sourceBinding,enrollment.supplementOrder,...sourceIdentityRefs(view),...releaseRefs,profile.ownerCheckpoint,...profile.preservedDrafts,profile.scan,profile.order,profile.guardEnrollment.profile,profile.guardEnrollment.instructions,...view.resources.map(resource=>({path:resource.path,sha256:resource.sha256}))]);
  for(const ref of refs)checkRef(root,ref);view.recheck();return refs;
}

export function verifySourceSnapshot({root,paper,snapshot,candidate,review,decision}){
  sourceAdmissionReferences(root,paper);
  insist(snapshot.sourceEnrollment&&same(snapshot.sourceEnrollment,paper.sourceEnrollment)&&sameRef(root,snapshot.sourceBinding,paper.sourceEnrollment.sourceBinding),'Frozen snapshot lost exact source enrollment');
  insist(snapshot.guard?.enrollment?.profile&&snapshot.guard.enrollment.instructions&&snapshot.guard.contract&&snapshot.guard.scopeReview,'Frozen source snapshot lacks complete mandatory guard sidecars');
  const directory=base+'/coverage/'+paper.paperId+'/c'+String(snapshot.iteration).padStart(3,'0');
  scoped(root,snapshot.guard.enrollment.profile,directory,directory+'/guard-order.json');
  scoped(root,snapshot.guard.enrollment.instructions,directory,directory+'/guard-order.md');
  scoped(root,snapshot.guard.contract,directory,directory+'/source-scope-v2.json');
  scoped(root,snapshot.guard.scopeReview,directory,directory+'/scope-review-v2.json');
  const guard=bound(root,snapshot.guard.enrollment.profile);
  insist(guard.paperId===paper.paperId&&guard.iteration===snapshot.iteration&&sameRef(root,guard.scan,paper.scan),'Frozen source guard enrollment differs from snapshot iteration/source');
  for(const value of [candidate,review,decision])insist(value.schemaVersion===2&&sameRef(root,value.sourceBinding,snapshot.sourceBinding),'Frozen delivery source binding differs from enrolled source');
}
export function requireSourceBinding(root,paper,value){insist(value.schemaVersion===2&&sameRef(root,value.sourceBinding,paper.sourceEnrollment.sourceBinding),'Delivery schema/source binding differs from exact enrollment');}
export function sourceReadView(root,paper){sourceAdmissionReferences(root,paper);const scan=bound(root,paper.scan),sourceView=resolveSourceView({root,scan,sourceBinding:paper.sourceEnrollment.sourceBinding});return {scan,sourceView};}
