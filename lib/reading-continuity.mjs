import path from 'node:path';
import {check,id,readJSON,writeJSON,hashObject,hashFile,sha,now} from './io.mjs';
import {verifyReworkReceipt} from './rework-evidence.mjs';
import {verifyOwnerEditScope} from './source-binding.mjs';

const file=(q,key)=>path.join(q.root,'coverage',id(key)+'.json');

// Reading and human closure are separate evidence roles. Only these two states
// represent actual reading by the receipt actor (or its immutable base actor).
export const isReadingRow=n=>['read','read_with_human_exclusions'].includes(n.status);
const publicScope=(q,x)=>q.humanRouting.publicRestriction?q.humanRouting.publicRestriction(x):Object.fromEntries(Object.entries(x).filter(([k])=>!['route','protectedQuote'].includes(k)));
const sortedScope=xs=>[...xs].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const scopes=(q,bundleId,options)=>q.humanRouting?.restrictions(bundleId,options)||[];
const wholeFor=(xs,nodeId)=>xs.filter(x=>x.nodeId===nodeId&&x.wholeNode!==false);
const closed=xs=>xs.length>0&&xs.every(x=>x.state==='human_decided'&&x.decisionId);
const rowScope=(xs,nodeId)=>sortedScope(xs.filter(x=>x.nodeId===nodeId));

export function projectReadingRows(q,bundleId,submitted,expectedNodeIds){
 check(Array.isArray(submitted)&&new Set(submitted.map(n=>n.nodeId)).size===submitted.length&&submitted.every(n=>expectedNodeIds.includes(n.nodeId)),'Reading contribution has duplicate or out-of-scope nodes',409,'READING_SCOPE_INVALID');
 const restrictions=scopes(q,bundleId).filter(x=>expectedNodeIds.includes(x.nodeId)),proof=sortedScope(restrictions.map(x=>publicScope(q,x))),nodes=[];
 for(const nodeId of expectedNodeIds){const n=submitted.find(x=>x.nodeId===nodeId),whole=wholeFor(proof,nodeId),partial=proof.filter(x=>x.nodeId===nodeId&&x.wholeNode===false);
  check(!n?.humanBindings&&!n?.humanExclusions,'Human reading bindings are server-generated',409,'READING_SCOPE_INVALID');
  if(whole.length){check(!n||n.status==='unexamined','A human-restricted node cannot be newly read',409,'HUMAN_FRAGMENT_LOCKED');nodes.push({nodeId,status:closed(whole)?'human_decided':'human_pending',note:'Program-bound human scope; no new reading or mathematical pass is asserted.',humanBindings:rowScope(proof,nodeId)});continue;}
  check(n&&['read','unexamined',...(partial.length?['read_with_human_exclusions']:[])].includes(n.status)&&typeof n.note==='string'&&n.note.length>=5&&n.note.length<=2000,'Reading needs an honest status and bounded note',409,'DELIVERY_INCOMPLETE');
  check(!partial.length||n.status!=='read','Read only the remainder outside the exact human exclusions',409,'HUMAN_FRAGMENT_LOCKED');
  nodes.push(n.status==='read_with_human_exclusions'?{...n,humanExclusions:partial}:n);
 }
 return {nodes,...(proof.length?{humanReading:proof}:{})};
}
function verifyHumanReading(q,receipt){
 const modern=receipt.nodes.filter(n=>['human_decided','human_pending','read_with_human_exclusions'].includes(n.status));
 if(!receipt.humanReading){check(!modern.length,'Human reading evidence is missing',409,'READING_SCOPE_INVALID');return;}
 check(q.humanRouting&&Array.isArray(receipt.humanReading),'Actual human routing is required',409,'READING_SCOPE_INVALID');
 const actual=sortedScope(scopes(q,receipt.bundleId,{historicalProof:receipt.humanReading}).map(x=>publicScope(q,x)));
 check(hashObject(actual)===hashObject(receipt.humanReading),'Human reading binding changed',409,'READING_SCOPE_INVALID');
 for(const n of modern){const relevant=rowScope(actual,n.nodeId),whole=wholeFor(relevant,n.nodeId);
  if(n.status==='read_with_human_exclusions')check(!whole.length&&relevant.length>0&&hashObject(n.humanExclusions)===hashObject(relevant),'Partial reading exclusion differs',409,'READING_SCOPE_INVALID');
  else check(whole.length&&n.status===(closed(whole)?'human_decided':'human_pending')&&hashObject(n.humanBindings)===hashObject(relevant),'Whole human closure differs',409,'READING_SCOPE_INVALID');
 }
 // Inherited rows carry the base receipt proof and must not be re-authored.
 for(const x of actual)check(receipt.nodes.some(n=>n.nodeId===x.nodeId&&n.status!=='read'),'Human closure was mislabeled as reading',409,'READING_SCOPE_INVALID');
}
export function readingCoverageStatus(q,receipt){
 verifyReadingReceipt(q,receipt);const b=q.blind.bundle(receipt.bundleId),nodes=receipt.nodes,current=scopes(q,receipt.bundleId);
 check(receipt.documentSha256===b.public.document.sha256&&nodes.length===b.public.nodes.length&&new Set(nodes.map(n=>n.nodeId)).size===nodes.length&&nodes.every(n=>b.public.nodes.some(x=>x.nodeId===n.nodeId)),'Reading coverage snapshot differs',409,'READING_LINEAGE_INVALID');
 const requiredNodeIds=[],pendingHumanNodeIds=[],humanDecidedNodeIds=[];
 for(const n of nodes){const whole=wholeFor(current,n.nodeId);if(whole.length){(closed(whole)?humanDecidedNodeIds:pendingHumanNodeIds).push(n.nodeId);continue;}if(n.status==='read_with_human_exclusions')check(n.humanExclusions.every(x=>current.some(y=>hashObject(publicScope(q,y))===hashObject(x))),'A prior excluded reading scope changed; explicit reading recovery is required',409,'READING_SCOPE_INVALID');if(!isReadingRow(n))requiredNodeIds.push(n.nodeId);}
 return {complete:requiredNodeIds.length===0&&pendingHumanNodeIds.length===0,requiredNodeIds,pendingHumanNodeIds,humanDecidedNodeIds,read:nodes.filter(n=>n.status==='read').length,readWithHumanExclusions:nodes.filter(n=>n.status==='read_with_human_exclusions').length,unexamined:requiredNodeIds.length,humanReading:sortedScope(current.map(x=>publicScope(q,x)))};
}
export function readingResult(q,receipt){const x=readingCoverageStatus(q,receipt);return {id:receipt.id,assignmentId:receipt.assignmentId,read:x.read,readWithHumanExclusions:x.readWithHumanExclusions,unexamined:x.unexamined,humanDecided:x.humanDecidedNodeIds.length,humanPending:x.pendingHumanNodeIds.length,readingComplete:x.complete,scope:receipt.scope};}
export function humanOnlyReadingClosure(q,bundleId){
 const b=q.blind.bundle(bundleId),current=scopes(q,bundleId);
 const main=q.store.config.papers[b.paperId]?.main,entry=b.manifest.files.find(f=>f.file===main),raw=b.nodes.map(n=>n.target?.oldText||'').join('');
 if(!entry||b.nodes.some(n=>n.target?.file!==main)||sha(raw)!==entry.sha256||Buffer.byteLength(raw)!==entry.size||b.public.nodes.map(n=>n.quote).join('')!==b.public.document.text)return null;
 if(!b.public.nodes.length||!b.public.nodes.every(n=>closed(wholeFor(current,n.nodeId))))return null;
 return {coverageId:null,baseBundleId:b.id,baseInputSha256:b.manifest.sha256,currentInputSha256:b.manifest.sha256,repairs:[],closureBasis:'human_decided',read:0,readWithHumanExclusions:0,unexamined:0,humanDecided:b.public.nodes.length,humanReading:sortedScope(current.map(x=>publicScope(q,x)))};
}

export function verifyReadingReceipt(q,receipt,seen=new Set()){
 check(Array.isArray(receipt.nodes),'Reading rows are required',409,'READING_LINEAGE_INVALID');
 if(!receipt.readingContinuation){verifyHumanReading(q,receipt);return true;}
 check(!seen.has(receipt.id)&&seen.size<32,'Reading receipt lineage is cyclic',409,'READING_LINEAGE_INVALID');seen.add(receipt.id);
 const c=receipt.readingContinuation,base=readJSON(file(q,c.baseCoverageId));
 check([1,2].includes(c.schemaVersion)&&hashFile(file(q,base.id))===c.baseCoverageSha256&&base.bundleId===receipt.bundleId&&base.documentSha256===receipt.documentSha256,'Reading base receipt changed',409,'READING_LINEAGE_INVALID');
 verifyReadingReceipt(q,base,seen);
 const inherited=base.nodes.filter(isReadingRow),added=receipt.nodes.filter(n=>!inherited.some(x=>x.nodeId===n.nodeId));
 check(hashObject(inherited)===c.inheritedNodesSha256&&hashObject(added)===c.supplementNodesSha256&&hashObject(c.supplementNodeIds)===hashObject(added.map(n=>n.nodeId)),'Reading contribution receipt changed',409,'READING_LINEAGE_INVALID');
 check(inherited.every(n=>hashObject(receipt.nodes.find(x=>x.nodeId===n.nodeId))===hashObject(n))&&added.every(n=>base.nodes.some(x=>x.nodeId===n.nodeId&&!isReadingRow(x)))&&added.every(n=>isReadingRow(n)||(c.schemaVersion===2&&['human_decided','human_pending'].includes(n.status))),'Inherited reading was replaced or supplemented outside scope',409,'READING_LINEAGE_INVALID');
 verifyHumanReading(q,{...receipt,nodes:added});
 check(receipt.nodes.length===base.nodes.length&&new Set(receipt.nodes.map(n=>n.nodeId)).size===base.nodes.length,'Reading coverage changed scope',409,'READING_LINEAGE_INVALID');return true;
}
export function readingVersionLineage(q,receipt,currentInputSha256){
 const base=q.blind.bundle(receipt.bundleId),bundles=q.blind.all('bundles'),edges=[],seen=new Set();
 check(receipt.documentSha256===base.public.document.sha256,'Reading snapshot differs',409,'READING_LINEAGE_INVALID');verifyReadingReceipt(q,receipt);
 let cursor=currentInputSha256;
 while(cursor!==base.manifest.sha256){
  check(!seen.has(cursor)&&seen.size<32,'No finite reading version lineage',409,'READING_LINEAGE_INVALID');seen.add(cursor);let edge;
  for(const r of q.blind.all('reports').filter(r=>r.paperId===base.paperId&&r.returnedBundleId&&['closed_completion','closed_source_correction','closed_ruling'].includes(r.status))){
   const b=bundles.find(b=>b.id===r.returnedBundleId);if(!b||b.manifest.sha256!==cursor)continue;verifyReworkReceipt(q.blind,b,r.ownerReceipt);const scope=verifyOwnerEditScope(q.blind,r,b);
   if(r.status==='closed_completion')check(r.reviews?.some(v=>v.closed&&v.bundleId===b.id),'Current construction review missing',409,'READING_LINEAGE_INVALID');
   if(r.status==='closed_ruling')check(q.blind.all('rulings').some(x=>x.id===r.rulingId&&x.closed&&x.verifiedEdit),'Applied human edit verification missing',409,'READING_LINEAGE_INVALID');
   edge={reportId:r.id,...scope};break;
  }
  check(edge,'Current inputs do not have a verified reviewed repair chain',409,'READING_LINEAGE_INVALID');edges.push(edge);cursor=edge.beforeInputSha256;
 }
 return {coverageId:receipt.id,baseBundleId:base.id,baseInputSha256:base.manifest.sha256,currentInputSha256,repairs:edges.reverse(),unexamined:receipt.nodes.filter(n=>n.status==='unexamined').length};
}
export function nextReadingSupplement(q,role,papers){
 for(const paperId of papers){
  const bundles=q.blind.all('bundles').filter(b=>b.paperId===paperId),coverage=q.all('coverage').filter(c=>bundles.some(b=>b.id===c.bundleId)).sort((a,b)=>b.at.localeCompare(a.at));
  const current=q.mathCoverage.current(paperId),reachable=coverage.filter(c=>{try{readingVersionLineage(q,c,current);return true;}catch{return false;}});
  if(!reachable.length||reachable.some(c=>readingCoverageStatus(q,c).complete))continue;
  const c=reachable[0],b=q.blind.bundle(c.bundleId),remaining=readingCoverageStatus(q,c).requiredNodeIds;
  if(!remaining.length||c.documentSha256!==b.public.document.sha256||c.nodes.length!==b.public.nodes.length||new Set(c.nodes.map(n=>n.nodeId)).size!==b.public.nodes.length)continue;
  if(q.jobs().some(j=>j.kind==='reading_supplement'&&j.baseCoverageId===c.id))continue;
  const j=q.create('reading_supplement',role.threadId,{roleId:role.roleId,paperId,bundleId:b.id,baseCoverageId:c.id,baseCoverageSha256:hashFile(file(q,c.id)),unreadNodeIds:remaining});
  q.materialize(j,q.blind.issueCapability('reporter',{bundleId:b.id,assignmentId:j.id,roleId:role.roleId}));return j;
 }
 return null;
}
export function readingSupplementInput(q,cap){
 const j=q.get(cap.assignmentId),b=q.blind.viewBundle(cap.bundleId),base=readJSON(file(q,j.baseCoverageId));
 check(j.kind==='reading_supplement'&&j.bundleId===b.bundleId&&base.bundleId===b.bundleId&&hashFile(file(q,base.id))===j.baseCoverageSha256,'Reading supplement base changed',409,'READING_LINEAGE_INVALID');verifyReadingReceipt(q,base);
 const required=readingCoverageStatus(q,base).requiredNodeIds;check(required.every(n=>j.unreadNodeIds.includes(n)),'Reading scope expanded after dispatch; replan explicitly',409,'READING_SCOPE_INVALID');
 return {...b,assignment:{id:j.id,kind:j.kind,groupPapers:[j.paperId]},reviewContinuity:{schemaVersion:1,mode:'remaining_reading',basis:{baselineCoverageId:base.id,baselineCoverageSha256:j.baseCoverageSha256,bundleId:b.bundleId,documentSha256:b.document.sha256},retainedChecks:{reading:base.nodes.filter(isReadingRow).map(n=>({nodeId:n.nodeId,coverageId:base.id,scope:'Original actor and original reading receipt retained; do not reread as a new check.'})),mathematical:[]},changedScope:[],affectedConclusions:[],unresolved:required.map(nodeId=>({nodeId,status:'unexamined',action:'Read only this remaining node outside its exact human exclusions and necessary definitions; deliver new discoveries.'})),applicableDecisions:[],dependencyGaps:[],scope:'Only the previously unread nodes. This receipt closes reading gaps on the assigned snapshot, not mathematical coverage. Current owner repairs keep their separate required return/recheck lineage.'},readingContinuation:{baseCoverageId:base.id,baseCoverageSha256:j.baseCoverageSha256,requiredNodeIds:required,humanExclusions:scopes(q,b.bundleId).map(x=>publicScope(q,x)),partialReadStatus:'read_with_human_exclusions'},requirements:{discoveryReconciliation:true,mathematicalCoverage:false}};
}
export function recordReadingSupplement(q,cap,body){
 const j=q.get(cap.assignmentId),b=q.blind.viewBundle(cap.bundleId),base=readJSON(file(q,j.baseCoverageId));
 check(j.kind==='reading_supplement'&&cap.role==='reporter'&&j.bundleId===b.bundleId&&cap.roleId===j.roleId&&body.assignmentId===j.id&&body.bundleId===b.bundleId&&body.documentSha256===b.document.sha256,'Reading supplement assignment differs',409,'READING_LINEAGE_INVALID');
 check(hashFile(file(q,base.id))===j.baseCoverageSha256&&base.bundleId===b.bundleId&&base.documentSha256===b.document.sha256,'Original reading receipt changed',409,'READING_LINEAGE_INVALID');verifyReadingReceipt(q,base);q.blind.discovery.verifyDelivery(cap,body.delivery);
 const key=hashObject({assignmentId:j.id,body}).slice(0,24),old=q.all('coverage').find(x=>x.assignmentId===j.id);check(!old||old.id===key,'Reading contribution is immutable',409,'READING_LINEAGE_INVALID');if(old)return readingResult(q,old);
 check(!body.humanReading&&!body.readingContinuation,'Reading proofs are server-generated',409,'READING_SCOPE_INVALID');
 const status=readingCoverageStatus(q,base),targets=base.nodes.filter(n=>!isReadingRow(n)).map(n=>n.nodeId);
 check(status.requiredNodeIds.every(n=>j.unreadNodeIds.includes(n)),'Reading scope expanded after dispatch; replan explicitly',409,'READING_SCOPE_INVALID');
 const projected=projectReadingRows(q,b.bundleId,body.nodes,targets);
 check(projected.nodes.every(n=>isReadingRow(n)||['human_decided','human_pending'].includes(n.status)),'Actually read every remaining node; technical gaps stay open',409,'DELIVERY_INCOMPLETE');
 check(typeof body.summary==='string'&&body.summary.length>=20&&body.summary.length<=12000,'Bounded reading summary required');
 const actor=cap.cliActor?q.blindExecutors.actor(cap):null,inherited=base.nodes.filter(isReadingRow),supplement=projected.nodes;
 const receipt={...body,id:key,...projected,nodes:base.nodes.map(n=>isReadingRow(n)?n:projected.nodes.find(x=>x.nodeId===n.nodeId)),roleId:cap.roleId,threadId:actor?.threadId||j.recipient,...(actor?{workerActor:actor}:{}),at:now(),readingContinuation:{schemaVersion:2,baseCoverageId:base.id,baseCoverageSha256:j.baseCoverageSha256,inheritedNodesSha256:hashObject(inherited),supplementNodesSha256:hashObject(supplement),supplementNodeIds:supplement.map(n=>n.nodeId),scope:'Current actor read only supplementNodeIds; inherited rows retain the original receipt and actor.'},scope:'Combined multi-actor TeX reading with immutable base provenance, not mathematics or paper approval'};
 {verifyReadingReceipt(q,receipt);writeJSON(file(q,receipt.id),receipt);j.coverageId=receipt.id;j.status='completed';j.result='remaining_reading_delivered';q.save(j);q.kick();}
 return {...readingResult(q,receipt),addedReadNodes:supplement.filter(isReadingRow).length,retainedReadNodes:inherited.length};
}
