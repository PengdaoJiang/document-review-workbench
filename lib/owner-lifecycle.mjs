import {verifyHumanHandoff} from './human-handoff.mjs';
import fs from 'node:fs';import path from 'node:path';
import {check,readJSON,writeJSON,hashFile,hashObject,now,id} from './io.mjs';
import {inputManifest,verifyManifest} from './inputs.mjs';import {verifyOwnerEditScope} from './source-binding.mjs';import {verifyReworkReceipt} from './rework-evidence.mjs';
import {faithfulDispositionValid,mathTechnicalGap} from './review-ledger.mjs';
import {readingCoverageStatus,humanOnlyReadingClosure} from './reading-continuity.mjs';

const done=new Set(['completed','cancelled']),closed=new Set(['closed_completion','closed_ruling','checked_no_contradiction','rejected','duplicate']);
const sameRoot=(a,b)=>{const x=path.resolve(a).toLowerCase(),y=path.resolve(b).toLowerCase();return x===y||x.startsWith(y+path.sep)||y.startsWith(x+path.sep);};
export class OwnerLifecycle {
 constructor(q,settings){this.q=q;this.blind=q.blind;this.store=q.store;this.settings=settings;this.enabled=!!settings;
  if(!this.enabled)return;check(hashFile(settings.path)===settings.sha256,'Owner registry authorization changed',409);this.registry=readJSON(settings.path);
  check(this.registry.schemaVersion===1&&this.registry.papers,'Owner registry schema required');this.root=path.join(q.root,'owners');for(const d of ['releases','archives','rotations'])fs.mkdirSync(path.join(this.root,d),{recursive:true});
 }
 registrations(){return this.enabled?Object.values(this.registry.papers):[];}
 registration(paperId){const r=this.registry.papers[paperId];check(r,'Paper has no registered owner',409,'OWNER_UNREGISTERED');return r;}
 releases(){return fs.readdirSync(path.join(this.root,'releases')).filter(f=>f.endsWith('.json')).map(f=>readJSON(path.join(this.root,'releases',f)));}
 rotations(){return fs.readdirSync(path.join(this.root,'rotations')).filter(f=>f.endsWith('.json')).map(f=>readJSON(path.join(this.root,'rotations',f)));}
 released(paperId){return this.releases().find(r=>r.paperId===paperId);}
 assertOpen(paperId){if(this.enabled)check(!this.released(paperId),'This paper version has been signed off and released; late input cannot reopen it',409,'OWNER_RELEASED');}
 current(r){
  if(r.mode==='accepted_maintenance'){check(hashFile(r.edition.path)===r.edition.sha256,'Accepted edition metadata changed',409);const e=readJSON(r.edition.path),dir=path.dirname(r.edition.path);for(const f of [e.files.latex,e.files.pdf,e.files.mapping,...(e.files.assets||[])])check(hashFile(path.join(dir,f.path))===f.sha256,'Accepted edition bytes changed',409);return {kind:'accepted_edition',version:e.version,inputSha256:e.files.latex.sha256,pdfSha256:e.files.pdf.sha256,editionSha256:r.edition.sha256};}
  const p=this.store.config.papers[r.paperId];check(p?.owner===r.owner&&path.resolve(p.root)===path.resolve(r.writeRoot),'Current writer registry differs',409,'OWNER_CHANGED');check(hashFile(p.source.path)===p.source.sha256&&(!p.mapping||hashFile(p.mapping.path)===p.mapping.sha256),'Source authority changed before release',409,'AUTHORITY_CHANGED');const m=inputManifest(path.join(p.root,'outputs'),p.main);return {kind:'candidate',inputSha256:m.sha256};
 }
 activity(paperIds){const ids=new Set(paperIds),reportIds=new Set(this.blind.all('reports').filter(r=>ids.has(r.paperId)).map(r=>r.id));const jobs=this.q.jobs(),owned=jobs.filter(j=>ids.has(j.paperId)||reportIds.has(j.reportId)),keys=new Set(owned.map(j=>j.id));
  const pending=jobs.filter(j=>(keys.has(j.id)||keys.has(j.targetJobId)||keys.has(j.assignmentId))&&!done.has(j.status));
  const notices=(this.q.notifications.jobs?.()||[]).filter(j=>(ids.has(j.paperId)||reportIds.has(j.reworkId))&&!['owner_received','completed','cancelled','verified'].includes(j.status));
  const dir=path.join(this.blind.root,'tool-requests'),requests=fs.existsSync(dir)?fs.readdirSync(dir).filter(x=>x.endsWith('.json')).map(x=>readJSON(path.join(dir,x))).filter(x=>reportIds.has(x.reportId)&&['queued','running','recovery_required','resource_blocked'].includes(x.status)):[];
  const tools=this.blind.all('checks').filter(x=>reportIds.has(x.reportId)&&!x.finishedAt);
  const executions=[],registrations=[],operations=[];
  for(const [name,pool] of [['source',this.q.sources],['blind',this.q.blindExecutors]])if(pool?.enabled){
   for(const a of pool.assignments().filter(a=>ids.has(a.paperId))){if(a.status!=='delivered'&&!(a.status==='human_handoff'&&verifyHumanHandoff(this.q,a)))executions.push({pool:name,id:a.id,status:a.status});
    const roots=name==='blind'?[path.join(pool.root,'operations',a.id)]:a.attempts.map(t=>path.join(t.runRoot,'operations'));
    for(const root of roots)if(fs.existsSync(root))for(const name of fs.readdirSync(root)){const file=name.endsWith('.json')?path.join(root,name):path.join(root,name,'operation.json');if(fs.existsSync(file)){const op=readJSON(file);if(op.status==='started')operations.push({assignmentId:a.id,id:op.id,status:op.status});}}
   }
   for(const paperId of ids){const holder=pool.registry.read(paperId).holder;if(holder)registrations.push({pool:name,paperId,assignmentId:holder.assignmentId,attemptId:holder.attemptId});}
  }
  return {jobs:pending.map(j=>({id:j.id,status:j.status})),notifications:notices.map(j=>({id:j.id,status:j.status})),requests:requests.map(j=>({id:j.id,status:j.status})),tools:tools.map(j=>j.id),executions,registrations,operations};
 }
 reviewLineage(paperId,version){
  const bundles=this.blind.all('bundles').filter(b=>b.paperId===paperId),coverage=this.q.all('coverage').filter(c=>bundles.some(b=>b.id===c.bundleId));
  const attempts=[];for(const c of coverage){const base=bundles.find(b=>b.id===c.bundleId);if(c.documentSha256!==base.public.document.sha256||c.nodes.length!==base.public.nodes.length||new Set(c.nodes.map(n=>n.nodeId)).size!==base.public.nodes.length||c.nodes.some(n=>!base.nodes.some(b=>b.nodeId===n.nodeId)))continue;
   let cursor=version.inputSha256;const edges=[],seen=new Set();
   try{const reading=readingCoverageStatus(this.q,c);if(!reading.complete)continue;while(cursor!==base.manifest.sha256){check(!seen.has(cursor)&&seen.size<32,'No finite complete review lineage');seen.add(cursor);let edge;
     for(const r of this.blind.all('reports').filter(r=>r.paperId===paperId&&r.returnedBundleId&&['closed_completion','closed_source_correction','closed_ruling'].includes(r.status))){const b=bundles.find(b=>b.id===r.returnedBundleId);if(!b||b.manifest.sha256!==cursor)continue;verifyReworkReceipt(this.blind,b,r.ownerReceipt);const scope=verifyOwnerEditScope(this.blind,r,b);if(r.status==='closed_completion')check(r.reviews?.some(v=>v.closed&&v.bundleId===b.id),'Current construction review missing');if(r.status==='closed_ruling')check(this.blind.all('rulings').some(x=>x.id===r.rulingId&&x.closed&&x.verifiedEdit),'Applied human edit verification missing');edge={reportId:r.id,...scope};break;}
     check(edge,'Current inputs do not have a verified reviewed repair chain');edges.push(edge);cursor=edge.beforeInputSha256;
   }
   return {coverageId:c.id,baseBundleId:base.id,baseInputSha256:base.manifest.sha256,currentInputSha256:version.inputSha256,repairs:edges.reverse(),unexamined:0,read:reading.read,readWithHumanExclusions:reading.readWithHumanExclusions,humanDecided:reading.humanDecidedNodeIds.length,humanReading:reading.humanReading};
   }catch(e){attempts.push(e.message);}
  }
  for(const b of bundles.filter(b=>b.manifest.sha256===version.inputSha256))try{const human=humanOnlyReadingClosure(this.q,b.id);if(human)return human;}catch(e){attempts.push(e.message);}
  return {gap:'No complete current-version coverage and repair lineage',attempts};
 }
 gate(paperId){const r=this.registration(paperId),version=this.current(r),gaps=[];if(r.firstExitHold)gaps.push('First exit remains held for the coordinating owner; registration alone does not archive this chat');
  const human=this.q.humanRouting?.gate(paperId);if(human)gaps.push(...human.gaps);
  const lineage=r.mode==='accepted_maintenance'?{gap:'Accepted edition registration is not a new blind-review or mathematical signoff'}:this.reviewLineage(paperId,version);if(lineage.gap)gaps.push(lineage.gap);
  const reports=this.blind.all('reports').filter(x=>x.paperId===paperId),rulings=this.blind.all('rulings');for(const report of reports){
   if(this.q.humanRouting?.reportRoute(report)?.state==='human_decided')continue;
   if(report.status==='duplicate'){const original=reports.find(x=>x.id===report.duplicateOf);if(!original||(!closed.has(original.status)&&!(original.status==='source_anomaly_preserved'&&faithfulDispositionValid(this.blind,original)))||original.status==='duplicate')gaps.push('Duplicate has no closed original: '+report.id);}
   else if(!closed.has(report.status)&&!(report.status==='source_anomaly_preserved'&&faithfulDispositionValid(this.blind,report)))gaps.push('Unresolved '+report.status+': '+report.id);
   if(report.status==='closed_ruling'&&!rulings.some(x=>x.id===report.rulingId&&x.closed&&(x.decision.action==='accept'||x.verifiedEdit)))gaps.push('Human ruling is not effectively applied: '+report.id);
   if(mathTechnicalGap(this.blind,report))gaps.push('Mathematical technical evidence remains unresolved: '+report.id);
   else if(report.mathResult?.outcome==='unknown'&&report.status!=='closed_ruling'&&!faithfulDispositionValid(this.blind,report))gaps.push('Mathematical limitation lacks an applicable source disposition: '+report.id);
  }
  for(const item of this.store.list?.()||[])if(item.paperId===paperId){const s=this.store.state(item.id);if(!(s.decision?.action==='accept'||(s.decision?.action==='edit'&&s.status==='verified')||s.supersededBy))gaps.push('Open human case: '+item.id);}
  if(r.mode!=='accepted_maintenance')gaps.push(...(this.q.mathCoverage?.gaps(paperId,version.inputSha256)||[]));
  if(this.blind.discovery.all().some(d=>d.paperId===paperId&&!this.blind.discovery.accepted(d)))gaps.push('Unaccepted discovery remains; reading coverage cannot discharge it');
  const activity=this.activity([paperId]);if(Object.values(activity).some(x=>x.length))gaps.push('In-flight, missing or unknown delivery/return/tool work remains');
  return {paperId,owner:r.owner,version,versionId:hashObject(version),ready:gaps.length===0,gaps:[...new Set(gaps)],lineage,activity,...(human?{fragmentHuman:human}:{}),scope:'Local paper/version review signoff only; no source science validation, approved-library promotion or corpus completion'};
 }
 release(paperId,versionId){const old=this.released(paperId);if(old){check(old.versionId===versionId,'Released version differs',409);return old;}const gate=this.gate(paperId);check(gate.ready&&gate.versionId===versionId,'Current paper version is not eligible for owner release: '+gate.gaps.join('; '),409,'SIGNOFF_GAP');const receipt={...gate,id:hashObject({paperId,versionId}).slice(0,24),releasedAt:now(),mode:this.q.settings?.completionPublication?.enabled?'user_authorized_workflow_release':'archive_after_all_owned_papers',registrySha256:this.settings.sha256};writeJSON(path.join(this.root,'releases',receipt.id+'.json'),receipt);return receipt;}
 archiveGate(owner){const papers=this.registrations().filter(r=>r.owner===owner);check(papers.length,'Registered owner required');const released=papers.map(p=>this.released(p.paperId)),activity=this.activity(papers.map(p=>p.paperId)),pendingRotations=this.rotations().filter(r=>r.owner===owner&&r.status==='registered_pending_activation');return {owner,paperIds:papers.map(p=>p.paperId),ready:!pendingRotations.length&&released.every(Boolean)&&papers.every((p,i)=>hashObject(this.current(p))===released[i].versionId)&&Object.values(activity).every(x=>!x.length),released:released.filter(Boolean).map(r=>r.id),activity,pendingRotations:pendingRotations.map(r=>r.paperId)};}
 async archive(owner){const gate=this.archiveGate(owner);check(gate.ready,'All papers of this owner must be released with no in-flight assignments',409,'OWNER_STILL_ACTIVE');const file=path.join(this.root,'archives',id(owner)+'.json');if(fs.existsSync(file)){const old=readJSON(file);check(old.status==='archived','Archive delivery needs explicit reconciliation; never resend automatically',409);return old;}const client=await this.q.notifications.adapter(),state=await this.q.recipientState(client,owner);check(state&&['idle','notLoaded'].includes(state.thread.status?.type)&&state.latestTurn?.status!=='inProgress','Owner is still active',409);
  check(this.archiveGate(owner).ready,'Owner version or activity changed before archive',409);const record={...gate,status:'sending',at:now()};writeJSON(file,record);try{record.receipt=await client.call('set_thread_archived',{threadId:owner,archived:true});record.status='archived';}catch(e){record.status='delivery_unknown';record.problem=e.message;}writeJSON(file,record);return record;
 }
 rotate(owner,pendingId){const file=path.join(this.root,'rotations',id(pendingId)+'.json');if(fs.existsSync(file)){const old=readJSON(file);check(old.owner===owner,'Pending paper already has another writer',409);return old;}const gate=this.archiveGate(owner);check(gate.ready,'Old owner papers and assignments must all close before rotation',409);const next=this.registry.authorizedPending?.find(p=>p.paperId===pendingId);check(next&&hashFile(next.authorization.path)===next.authorization.sha256,'Only an explicitly preauthorized pending paper may be rotated',409);check(!this.registry.papers[pendingId]&&[...this.registrations(),...this.rotations()].every(p=>!sameRoot(p.writeRoot,next.writeRoot)),'New paper requires a disjoint directory and unique writer',409);const record={...next,owner,status:'registered_pending_activation',previousPaperReleases:gate.released,at:now(),scope:'No automatic review, content move or batch expansion; activation remains within the recorded pending-paper authorization'};writeJSON(file,record);return record;}
 summary(){return {enabled:this.enabled,papers:this.registrations().map(r=>({paperId:r.paperId,owner:r.owner,mode:r.mode,writeRoot:r.writeRoot,firstExitHold:!!r.firstExitHold,released:this.released(r.paperId)||null})),scope:'Owner registration is independent of batch membership and accepted-library promotion.'};}
}
