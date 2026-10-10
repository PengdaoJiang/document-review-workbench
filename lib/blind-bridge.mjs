import path from 'node:path';
import fs from 'node:fs';
import {check,hashObject,hashFile,writeJSON,readJSON,now,safePath,acquireLock} from './io.mjs';
import {inputManifest,snapshotInputs,verifyAuthority} from './inputs.mjs';
import {preparePackage} from './package.mjs';
import {compile,renderSource,renderCandidate} from './build.mjs';
import {locate} from './target.mjs';
import {sourceCandidateBinding} from './source-binding.mjs';
import {verifyReworkReceipt} from './rework-evidence.mjs';
import {sourceActorValid} from './source-actor.mjs';
export {verifyReworkReceipt} from './rework-evidence.mjs';

export function ownerEngine(dataRoot,paper){
  if(paper.engine)return {engine:paper.engine};const dir=path.join(dataRoot,'production-review/freezes');
  const records=fs.existsSync(dir)?fs.readdirSync(dir).filter(x=>x.endsWith('.json')).map(f=>readJSON(path.join(dir,f))).filter(f=>f.paperId===paper.paperId&&f.owner===paper.owner).sort((a,b)=>b.at.localeCompare(a.at)):[];
  check(records.length&&['pdflatex','xelatex','tectonic'].includes(records[0].engine),'No owner-verified engine receipt',409,'ENGINE_EVIDENCE_REQUIRED');
  return {engine:records[0].engine,engineEvidence:'Existing owner freeze '+records[0].id+': '+records[0].note};
}

export function registerLocator(blind,paperId,bundleId,nodeId,locator,evidence,{bridge=false,sourceActor}={}){
  blind.humanRouting?.assertNodeAction(bundleId,nodeId,'source_locator');
  const b=blind.bundle(bundleId),p=blind.store.config.papers[paperId],n=b.nodes.find(n=>n.nodeId===nodeId);check(b.paperId===paperId&&n,'Private node differs');verifyAuthority(p);
  const actor=sourceActor||evidence?.sourceActor;
  check(evidence?.sourceSha256===p.source.sha256&&evidence?.mappingSha256===(p.mapping?.sha256||null)&&typeof evidence.reference==='string'&&evidence.reference.length>10&&(actor?sourceActorValid(blind.store.root,paperId,p.owner,actor)&&evidence.reviewedBy===actor.threadId:evidence.reviewedBy===p.owner||(bridge&&evidence.reviewedBy==='authorized_source_bridge')),'Reviewed source mapping evidence required');
  check(locator?.page>=1&&locator.page<=p.source.pages&&Array.isArray(locator.bbox)&&locator.bbox.length===4&&locator.bbox.every(Number.isFinite),'Bounded original locator required');
  n.locator=locator;n.locatorEvidence={...evidence,...(actor?{sourceActor:actor}:{})};blind.save('bundles',b);return {registered:true};
}
export function recordSourceObservation(blind,key,body){
  const r=blind.report(key),p=blind.store.config.papers[r.paperId];blind.humanRouting?.assertReportAction(r,'source_observation');check(body.bundleId===r.bundleId||body.bundleId===r.ownerDisposition?.payload.bundleId,'Source observation differs from the registered owner input',409);const b=blind.bundle(body.bundleId),node=b.nodes.find(n=>n.semanticId===r.semanticId);check(b.owner===p.owner&&b.paperId===r.paperId&&node,'Source observation owner or target differs',409);
  check(!r.caseId&&!blind.matchRuling(r),'Existing human decisions and cases cannot be replaced by a source note',409);
  check(['supervision_triage','source_triage','bridge_pending','unknown','encoding_error','math_queued','math_checking','source_anomaly_preserved','owner_rework','owner_escalation','owner_technical_blocked'].includes(r.status),'This report is not awaiting source triage',409);
  check(body.bundleId===b.id&&body.documentSha256===b.public.document.sha256&&body.reading==='faithful_source_anomaly','Exact frozen candidate and clearly read original required',409);
  check(typeof body.note==='string'&&body.note.length>=40&&body.note.length<=8000,'Describe the exact visible source reading and its limited scope');
  check(/\.(png|jpe?g)$/i.test(body.evidence?.cropRelative||''),'Readable local image evidence required');const crop=safePath(blind.store.config.root,body.evidence.cropRelative);
  check(hashFile(crop)===body.evidence.cropSha256,'Source crop evidence changed',409,'EVIDENCE_CHANGED');verifyAuthority(p);
  if(r.sourceObservation){check(r.sourceObservation.bodySha256===hashObject(body),'Recorded source observation is immutable',409);return {id:r.id,status:r.status,scope:r.sourceObservation.scope};}
  const candidateBinding=sourceCandidateBinding(blind,b,node);
  registerLocator(blind,r.paperId,b.id,node.nodeId,body.locator,body.evidence,{bridge:true});
  r.sourceObservation={...body,bodySha256:hashObject(body),candidateBinding,at:now(),scope:'Verbatim original reading preserved; source-check pointer only, not a scientific error verdict, human ruling or paper approval'};
  if(!['math_queued','math_checking'].includes(r.status))r.status='source_anomaly_preserved';r.events.push({at:now(),type:'source_reading_preserved'});blind.save('reports',r);blind.humanRouting?.reconcileReport(r);return {id:r.id,status:r.status,scope:r.sourceObservation.scope};
}
export async function bridgeReport(blind,key,{supplement=false,sourceQuestion}={}){
  const r=blind.report(key);blind.humanRouting?.assertReportAction(r,'source_bridge');if(r.caseId&&!supplement)return {caseId:r.caseId,duplicate:true};check(['bridge_pending','source_triage'].includes(r.status)||(supplement&&r.status==='needs_source_evidence'&&blind.store.state(r.caseId).decision?.action==='return'),'Only screened source questions or requested source supplements reach source bridge',409);
  if(!blind.store.fixture)check(['unreadable','conflicting_readings','repeated_correction_failure'].includes(sourceQuestion?.reason)&&typeof sourceQuestion.explanation==='string'&&sourceQuestion.explanation.length>=40,'Human adjudication requires a genuine unresolved transcription question; clearly read source anomalies are preserved',409,'TRANSCRIPTION_QUESTION_REQUIRED');
  const b=blind.bundle(r.bundleId),p=blind.store.config.papers[r.paperId],n=b.nodes.find(n=>n.semanticId===r.semanticId);verifyAuthority(p);
  check(n?.locator&&n.locatorEvidence?.sourceSha256===p.source.sha256&&n.locatorEvidence?.mappingSha256===(p.mapping?.sha256||null)&&[p.owner,'authorized_source_bridge'].includes(n.locatorEvidence?.reviewedBy),'Source location is not verified; ask the existing owner to locate this node',409,'OWNER_LOCATION_REQUIRED');
  check(inputManifest(path.join(p.root,'outputs'),p.main).sha256===b.manifest.sha256,'Frozen inputs changed; bridge cannot attach new content silently',409,'VERSION_CONFLICT');
  const ruling=blind.matchRuling(r);if(ruling){r.status='closed_ruling';r.rulingId=ruling.id;blind.save('reports',r);return {closedByRuling:true};}
  const spec={schemaVersion:1,paperId:r.paperId,owner:p.owner,issueId:'blind-'+r.id,revision:1,kind:n.kind,fixture:blind.store.fixture,category:'blind_source_fidelity',reason:'blind_source_fidelity',boundedCheck:sourceQuestion?.explanation||'Owner-reviewed source locator, sealed original and exclusions, actual local compilation with separate original and candidate crops.',sourceQuestion,question:'此处是否忠实重建原文？',readings:['对照原文，确认当前片段忠实','依原文修改后预览并提交','原图不足时补充取证'],locator:n.locator,target:n.target,engine:p.engine,blindOrigin:{reportId:r.id,bundleId:b.id,semanticId:r.semanticId,contentSha256:r.contentSha256,dispute:r.dispute,question:r.question,conditions:r.conditions,evidence:r.evidence,encoding:r.encoding,mathResult:r.mathResult,tool:r.toolReceiptId?blind.read('checks',r.toolReceiptId).public:null,limits:'工具证据针对编码的局部命题；用户只裁定原文一致性，不担保科学正确。'}};
  if(supplement){spec.revision=blind.store.request(r.caseId).spec.revision+1;spec.supersedes=r.caseId;}
  Object.assign(spec,ownerEngine(blind.store.root,p));
  const pack=await preparePackage(blind.store.config,blind.store.root,spec,{fixture:blind.store.fixture});const submitted=blind.store.submit(pack.packageId,r.paperId);if(supplement)r.caseHistory=[...(r.caseHistory||[]),r.caseId];r.caseId=submitted.id;r.status='awaiting_human';r.events.push({at:now(),type:'source_bridge_ready',caseId:r.caseId});blind.save('reports',r);return {caseId:r.caseId};
}
// Invoked by the existing owner CLI only, after the owner has edited its files.
// This routine reads canonical inputs and builds a separate comparison package.
export async function reworkReceipt(config,dataRoot,paper,bundle,node,affectedNodes=[node],authority){
  paper={...paper,...ownerEngine(dataRoot,paper)};
  const release=acquireLock(path.join(paper.root,'work/review-desk/owner.lock'));try{
  const outputs=path.join(paper.root,'outputs');check(inputManifest(outputs,paper.main).sha256===bundle.manifest.sha256,'Owner return inputs changed',409);
  const root=path.join(dataRoot,'blind','rework-builds',bundle.id);fs.mkdirSync(root,{recursive:true});
  authority?.trackRoot?.(root);
  const affectedSemanticIds=affectedNodes.map(n=>n.semanticId);check(affectedNodes.length>0&&affectedNodes.length<=8&&new Set(affectedSemanticIds).size===affectedSemanticIds.length&&affectedSemanticIds[0]===node.semanticId,'Bounded affected fragment set required');
  const cached=path.join(root,'owner-receipt.json');if(fs.existsSync(cached)){const receipt=readJSON(cached);verifyReworkReceipt({store:{root:dataRoot}},bundle,receipt);check(affectedNodes.length===1||hashObject(receipt.affectedSemanticIds)===hashObject(affectedSemanticIds),'Cached comparison has another fragment scope',409);check(hashFile(path.join(outputs,paper.main.replace(/\.tex$/,'.pdf')))===receipt.pdfSha256,'Published owner PDF changed',409);return receipt;}
  const inputs=path.join(root,'inputs');snapshotInputs(outputs,inputs,bundle.manifest);
  authority?.assert();const publish={outputs,pdf:path.join(outputs,paper.main.replace(/\.tex$/,'.pdf'))};
  const build=await compile(config,paper,{inputs,build:path.join(root,'build'),main:paper.main,manifest:bundle.manifest,engine:paper.engine,...(!authority?{publish,receipt:true}:{})});
  if(authority){authority.assert();check(inputManifest(outputs,paper.main).sha256===bundle.manifest.sha256,'Inputs changed before fenced PDF publish',409,'VERSION_CONFLICT');const temp=publish.pdf+'.review-desk.tmp';fs.copyFileSync(build.pdf,temp);fs.renameSync(temp,publish.pdf);}
  const text=fs.readFileSync(safePath(inputs,node.target.file),'utf8'),at=locate(text,node.target);
  const candidate=await renderCandidate(config,{pdf:build.pdf,out:path.join(root,'candidate'),targetFile:path.join(inputs,node.target.file),text,start:at.start,end:at.end});
  check(node.locator,'Owner must locate the repaired source passage');verifyAuthority(paper);
  const original=await renderSource(config,paper,node.locator,paper.source.path,path.join(root,'original'));
  const comparison={bundleId:bundle.id,inputSha256:bundle.manifest.sha256,pdfSha256:build.pdfSha256,sourceSha256:paper.source.sha256,locator:node.locator,candidate,original,artifactHashes:{}};
  for(const pg of candidate.pages)for(const k of ['cropFile','contextFile','pageFile'])comparison.artifactHashes['candidate/'+pg[k]]=hashFile(path.join(root,'candidate',pg[k]));
  for(const pg of original.pages)for(const k of ['cropFile','contextFile','pageFile'])comparison.artifactHashes['original/'+pg[k]]=hashFile(path.join(root,'original',pg[k]));
  comparison.primarySemanticId=node.semanticId;comparison.affectedSemanticIds=affectedSemanticIds;comparison.additional=[];
  for(const extra of affectedNodes.filter(n=>n.semanticId!==node.semanticId)){
    const index=comparison.additional.length+1,candidateDir='candidate-'+index,originalDir='original-'+index;
    const extraText=fs.readFileSync(safePath(inputs,extra.target.file),'utf8'),at=locate(extraText,extra.target);check(extra.locator,'Every repaired fragment requires an original locator');
    const candidate=await renderCandidate(config,{pdf:build.pdf,out:path.join(root,candidateDir),targetFile:path.join(inputs,extra.target.file),text:extraText,start:at.start,end:at.end});
    const original=await renderSource(config,paper,extra.locator,paper.source.path,path.join(root,originalDir));
    for(const [dir,render] of [[candidateDir,candidate],[originalDir,original]])for(const pg of render.pages)for(const k of ['cropFile','contextFile','pageFile'])if(pg[k])comparison.artifactHashes[dir+'/'+pg[k]]=hashFile(path.join(root,dir,pg[k]));
    comparison.additional.push({semanticId:extra.semanticId,locator:extra.locator,candidateDir,originalDir,candidate,original});
  }
  writeJSON(path.join(root,'comparison.json'),comparison);
  check(inputManifest(outputs,paper.main).sha256===bundle.manifest.sha256,'Owner source changed during build',409);
  authority?.assert();const result={success:true,bundleId:bundle.id,inputSha256:bundle.manifest.sha256,pdfSha256:build.pdfSha256,pdfRelative:'blind/rework-builds/'+bundle.id+'/build/'+path.basename(build.pdf),comparisonSha256:hashFile(path.join(root,'comparison.json')),comparisonRelative:'blind/rework-builds/'+bundle.id+'/comparison.json',affectedSemanticIds,scope:'affected construction issue only',reviewedBy:authority?.actor.threadId||paper.owner,...(authority?{sourceActor:authority.actor}:{})};writeJSON(cached,result);return result;
  }finally{release();}
}
