import fs from 'node:fs';
import path from 'node:path';
import {check,id,relative,sha,hashFile,hashObject,readJSON,writeJSON,uid,safePath,listFiles,now} from './io.mjs';
import {inputManifest,snapshotInputs,verifyManifest,verifyAuthority,guardKnownDecisions} from './inputs.mjs';
import {locate} from './target.mjs';
import {compile,renderSource,renderCandidate} from './build.mjs';
import {sourceActorValid} from './source-actor.mjs';
import {evaluateFragmentRouting,routingHash} from './fragment-human-routing.mjs';

export function caseId(spec) {return id(spec.paperId+'-'+id(spec.issueId)+'-r'+spec.revision);}
export function validateSpec(config,spec,fixture) {
  check(spec.schemaVersion===1,'Unsupported request schema');const paper=config.papers[spec.paperId];check(paper,'Paper is not in this batch');
  check(spec.owner===paper.owner,'Only the registered owner can submit',403,'OWNER_MISMATCH');
  check(Number.isInteger(spec.revision)&&spec.revision>=1,'Positive request revision required');caseId(spec);
  check(['equation','paragraph','figure','table'].includes(spec.kind),'Unknown review item kind');
  check(typeof spec.question==='string'&&spec.question.length>=5&&spec.question.length<=4000,'One precise question is required');
  check(Array.isArray(spec.readings)&&spec.readings.length>=1&&spec.readings.length<=12&&spec.readings.every(x=>typeof x==='string'&&x.length<=(spec.category==='mandatory_fragment_human'?40000:4000)),'At least one recorded reading is required');
  check(spec.locator&&Number.isInteger(spec.locator.page)&&spec.locator.page>=1&&spec.locator.page<=paper.source.pages&&typeof spec.locator.label==='string','Exact original page and locator required');
  check(Array.isArray(spec.locator.bbox)&&spec.locator.bbox.length===4&&spec.locator.bbox.every(Number.isFinite),'Original crop rectangle required');
  check(!paper.boundaries.excludedOriginalPages.includes(spec.locator.page),'Original page is excluded');
  relative(spec.target.file);check(spec.target.file.endsWith('.tex'),'Editable target must be a TeX input');
  check(spec.fixture===fixture,'Fixture and production pools cannot be mixed',403,'POOL_MISMATCH');
  guardKnownDecisions(paper,spec,fixture);
  return paper;
}
export async function preparePackage(config,dataRoot,spec,{fixture=false,authority}={}) {
  const paper=validateSpec(config,spec,fixture);verifyAuthority(paper);
  const outputs=path.join(paper.root,'outputs'), manifest=inputManifest(outputs,paper.main);
  check(manifest.files.some(f=>f.file===spec.target.file),'Target is not a sealed compile input');
  const baseTex=fs.readFileSync(safePath(outputs,spec.target.file),'utf8'),at=locate(baseTex,spec.target);
  const engine=spec.engine||paper.engine;check(['tectonic','pdflatex','xelatex'].includes(engine),'Owner must supply the previously verified engine');
  check(!paper.engine||paper.engine===engine,'Do not change the previously verified engine');
  check(paper.engine||typeof spec.engineEvidence==='string'&&spec.engineEvidence.length>20,'Give the existing successful build evidence for this engine');
  const canonicalPdf=safePath(outputs,paper.main.replace(/\.tex$/,'.pdf'));
  const version={inputsSha256:manifest.sha256,texSha256:hashFile(safePath(outputs,paper.main)),pdfSha256:hashFile(canonicalPdf),candidateRevision:paper.candidateRevision};
  const intent={spec,version,sourceSha256:paper.source.sha256,mappingSha256:paper.mapping?.sha256||null,engine};
  const packageId=uid().replaceAll('-','').slice(0,16);const root=path.join(dataRoot,'staging',packageId);
  authority?.trackRoot?.(root);
  fs.mkdirSync(root,{recursive:true});const inputs=path.join(root,'inputs');snapshotInputs(outputs,inputs,manifest);
  const sourcePdf=path.join(root,'original.pdf');fs.copyFileSync(paper.source.path,sourcePdf);check(hashFile(sourcePdf)===paper.source.sha256,'Copied original seal mismatch');
  if(paper.mapping)fs.copyFileSync(paper.mapping.path,path.join(root,'exclusions.json'));
  // Existing candidate lineage is recorded; the preview gets its own real build.
  const basePdf=path.join(root,'submitted-candidate.pdf');fs.copyFileSync(canonicalPdf,basePdf);
  const built=await compile(config,paper,{inputs,build:path.join(root,'build'),main:paper.main,manifest,engine});
  const original=await renderSource(config,paper,spec.locator,sourcePdf,path.join(root,'original-view'));
  const candidate=await renderCandidate(config,{pdf:built.pdf,out:path.join(root,'candidate-view'),targetFile:path.join(inputs,spec.target.file),text:baseTex,start:at.start,end:at.end});
  check(inputManifest(outputs,paper.main).sha256===manifest.sha256&&hashFile(canonicalPdf)===version.pdfSha256,'Owner version changed while preparing request',409,'VERSION_CONFLICT');
  verifyAuthority(paper);
  const artifacts={originalCrop:'original-view/'+original.pages[0].cropFile,originalContext:'original-view/'+original.pages[0].contextFile,originalPage:'original-view/'+original.pages[0].pageFile,originalPdf:'original.pdf',submittedPdf:'submitted-candidate.pdf',candidatePdf:'build/'+path.basename(built.pdf),mainTex:'inputs/'+paper.main};
  candidate.pages.forEach((p,i)=>{artifacts['candidateCrop'+i]='candidate-view/'+p.cropFile;artifacts['candidateContext'+i]='candidate-view/'+p.contextFile;artifacts['candidatePage'+i]='candidate-view/'+p.pageFile;});
  const request={schemaVersion:1,id:caseId(spec),packageId,createdAt:now(),fixture,intent,intentDigest:hashObject(intent),spec,source:{sha256:paper.source.sha256,mappingSha256:paper.mapping?.sha256||null,geometry:original.pages[0],appliedExclusions:paper.boundaries.excludedRegions.filter(r=>r.originalPage===spec.locator.page)},version,main:paper.main,manifest,engine,baseBuild:{...built,pdf:path.relative(root,built.pdf).replaceAll('\\','/'),synctex:path.relative(root,built.synctex).replaceAll('\\','/')},candidateRender:candidate,artifacts};
  if(spec.category==='mandatory_fragment_human'){
    const origin=spec.fragmentHumanOrigin,proofFile=safePath(dataRoot,'fragment-human/packets/'+path.basename(origin.packetProofPath));
    check(path.resolve(proofFile)===path.resolve(origin.packetProofPath)&&hashFile(proofFile)===origin.packetProofSha256,'Human packet proof changed',409,'HUMAN_PACKET_BINDING');
    const proof=readJSON(proofFile);fs.copyFileSync(proofFile,path.join(root,'fragment-human-proof.json'));artifacts.fragmentHumanProof='fragment-human-proof.json';
    request.humanEscalation={stableFragmentId:proof.stableFragmentId,initialTex:proof.initialTex,currentTex:proof.currentTex,sourceDisposition:proof.sourceDisposition,blindFindings:proof.blindFindings,triggers:proof.triggerProof.evidence,question:proof.specificDecision,scope:'A required user decision for this fragment; no scientific correctness certification.'};
  }
  writeJSON(path.join(root,'request.json'),request);
  const files=listFiles(root).map(file=>({file,sha256:hashFile(safePath(root,file))}));writeJSON(path.join(root,'seal.json'),{files,sha256:hashObject(files)});
  return {packageId,id:request.id,intentDigest:request.intentDigest};
}
export function inspectPackage(config,dataRoot,packageId,fixture) {
  id(packageId);const root=safePath(dataRoot,'staging/'+packageId),request=readJSON(safePath(root,'request.json')),seal=readJSON(safePath(root,'seal.json'));
  const paper=validateSpec(config,request.spec,fixture);verifyAuthority(paper);
  if(request.spec.category==='mandatory_fragment_human'){
    const o=request.spec.fragmentHumanOrigin,state=readJSON(safePath(dataRoot,'fragment-human/states/'+id(o.stableFragmentId)+'.json')),{sha256,...body}=state;
    check(routingHash(body)===sha256&&!state.humanLock,'Fragment state changed or was already decided',409,'HUMAN_FRAGMENT_LOCKED');
    const route=evaluateFragmentRouting(state,{paperId:paper.paperId,workflowId:state.workflowId,enrolled:true,completed:false,published:false});
    const b=readJSON(safePath(dataRoot,'blind/bundles/'+id(o.bundleId)+'.json')),n=b.nodes.find(n=>n.nodeId===o.nodeId),proof=readJSON(safePath(root,'fragment-human-proof.json'));
    check(route.humanRequired&&route.caseKey===o.caseKey&&route.proof.sha256===o.triggerProofSha256&&state.epoch===o.epoch&&state.paperId===paper.paperId&&request.spec.issueId===o.caseKey,'Actual mandatory human trigger is missing',409,'HUMAN_PACKET_BINDING');
    check(sourceActorValid(dataRoot,paper.paperId,paper.owner,o.sourceActor)&&b.paperId===paper.paperId&&b.owner===paper.owner&&hashObject(b.public)===b.publicDigest&&n&&hashObject(n.target)===hashObject(request.spec.target)&&request.version.inputsSha256===b.manifest.sha256&&o.candidateBinding.currentInputSha256===b.manifest.sha256,'Registered packet actor or current version differs',409,'HUMAN_PACKET_BINDING');
    check(hashFile(safePath(root,'fragment-human-proof.json'))===o.packetProofSha256&&proof.stableFragmentId===state.stableFragmentId&&proof.triggerProof.sha256===o.triggerProofSha256&&hashObject(proof.firstDraft)===hashObject(state.initial)&&proof.currentTex===n.target.oldText&&request.humanEscalation?.initialTex===proof.initialTex&&request.humanEscalation?.currentTex===proof.currentTex,'Required first/current text and trigger evidence differ',409,'HUMAN_PACKET_BINDING');
  }
  if(request.spec.category==='owner_transcription_uncertainty'){
    const origin=request.spec.ownerSourceOrigin,r=readJSON(safePath(dataRoot,'blind/reports/'+id(origin.reportId)+'.json')),b=readJSON(safePath(dataRoot,'blind/bundles/'+id(origin.bundleId)+'.json')),n=b.nodes.find(n=>n.semanticId===origin.semanticId),d=r.ownerDisposition;
    const registered=d?.sourceActor?sourceActorValid(dataRoot,paper.paperId,paper.owner,d.sourceActor)&&d.by===d.sourceActor.threadId&&hashObject(origin.sourceActor)===hashObject(d.sourceActor):d?.by===paper.owner;
    check(r.paperId===request.spec.paperId&&['human_packet_pending','awaiting_human','needs_source_evidence'].includes(r.status)&&registered&&d.payload.disposition==='transcription_uncertain'&&d.bodySha256===origin.dispositionSha256&&hashObject(d.payload)===d.bodySha256&&origin.bundleId===d.payload.bundleId&&b.owner===paper.owner&&b.paperId===r.paperId&&origin.originalReportBundleId===r.bundleId&&origin.documentSha256===b.public.document.sha256&&n?.contentSha256===origin.contentSha256&&hashObject(request.spec.target)===hashObject(n.target)&&hashObject(request.spec.locator)===hashObject(d.payload.locator)&&hashObject(request.spec.sourceQuestion)===hashObject(d.payload.sourceQuestion)&&request.version.inputsSha256===origin.candidateBinding.currentInputSha256,'Registered source question or version binding differs',409,'OWNER_QUESTION_BINDING');
  }
  if(request.spec.category==='blind_source_fidelity'){
    const origin=request.spec.blindOrigin,r=readJSON(safePath(dataRoot,'blind/reports/'+id(origin.reportId)+'.json')),b=readJSON(safePath(dataRoot,'blind/bundles/'+id(r.bundleId)+'.json')),n=b.nodes.find(n=>n.semanticId===r.semanticId);
    check(r.paperId===request.spec.paperId&&['bridge_pending','awaiting_human','needs_source_evidence'].includes(r.status)&&r.mathResult?.outcome==='contradiction'&&origin.bundleId===r.bundleId&&origin.contentSha256===r.contentSha256&&hashObject(origin.mathResult)===hashObject(r.mathResult)&&hashObject(origin.encoding)===hashObject(r.encoding)&&hashObject(request.spec.target)===hashObject(n.target)&&hashObject(request.spec.locator)===hashObject(n.locator),'Blind origin is not a screened and source-mapped report',409,'BLIND_BINDING');
    const tool=readJSON(safePath(dataRoot,'blind/checks/'+id(r.toolReceiptId)+'.json'));check(tool.success&&tool.reportId===r.id&&tool.encodingSha256===r.encoding.sha256&&hashObject(origin.tool)===hashObject(tool.public),'Blind mathematical evidence differs',409,'BLIND_BINDING');
  }
  check(hashObject(request.intent.spec)===hashObject(request.spec)&&hashObject(request.intent.version)===hashObject(request.version)&&request.intent.engine===request.engine,'Request metadata differs from immutable intent',409,'REQUEST_CONFLICT');
  check(request.main===paper.main&&request.version.inputsSha256===request.manifest.sha256&&request.intent.sourceSha256===paper.source.sha256&&request.intent.mappingSha256===(paper.mapping?.sha256||null),'Request version binding differs',409);
  check(request.id===caseId(request.spec)&&request.packageId===packageId&&hashObject(request.intent)===request.intentDigest,'Request identity differs');
  check(hashObject(seal.files)===seal.sha256,'Package seal differs',409);
  check(listFiles(root).filter(f=>f!=='seal.json').length===seal.files.length,'Unexpected package files');
  for(const f of seal.files)check(hashFile(safePath(root,f.file))===f.sha256,'Package file changed: '+f.file,409);
  check(hashFile(safePath(root,'original.pdf'))===paper.source.sha256&&(paper.mapping?hashFile(safePath(root,'exclusions.json'))===paper.mapping.sha256:!fs.existsSync(path.join(root,'exclusions.json'))),'Authority snapshot differs',409);
  check(request.source.sha256===paper.source.sha256&&request.source.mappingSha256===(paper.mapping?.sha256||null),'Request authority differs');
  verifyManifest(safePath(root,'inputs'),request.manifest);
  check(request.baseBuild.success&&request.baseBuild.inputSha256===request.manifest.sha256&&hashFile(safePath(root,request.baseBuild.pdf))===request.baseBuild.pdfSha256,'Actual candidate build is unbound');
  check(hashFile(safePath(root,'submitted-candidate.pdf'))===request.version.pdfSha256,'Submitted PDF differs');
  for(const f of Object.values(request.artifacts))safePath(root,f);
  locate(fs.readFileSync(safePath(root,'inputs/'+request.spec.target.file),'utf8'),request.spec.target);
  return {root,request};
}
