import fs from 'node:fs';
import path from 'node:path';
import {check,hashFile,hashObject,readJSON,safePath,sha} from './io.mjs';
import {verifyManifest} from './inputs.mjs';
import {locate} from './target.mjs';
import {sourceActorValid} from './source-actor.mjs';

export function verifyOwnerEditScope(blind,report,revised){
 const prior=blind.bundle(report.reworkBaseBundleId||report.bundleId),p=blind.store.config.papers[report.paperId],expected=report.screening?.candidateBinding?.currentInputSha256||prior.manifest.sha256,parent=blind.all('bundles').find(b=>b.paperId===report.paperId&&b.owner===p.owner&&b.manifest.sha256===expected);check(parent&&hashObject(parent.manifest.files)===expected,'Registered pre-edit input version is missing or changed',409,'VERSION_CONFLICT');
 const ids=report.screening?.affectedSemanticIds||[report.semanticId],pairs=ids.map(id=>({old:report.screening?.repairSpan&&id===report.semanticId?report.screening.repairSpan:prior.nodes.find(n=>n.semanticId===id)?.target,next:revised.nodes.find(n=>n.semanticId===id)?.target}));check(pairs.every(n=>n.old?.file===p.main&&n.next?.file===p.main),'Declared text repair scope changed',409,'VERSION_CONFLICT');
 const inputs=safePath(blind.root,'rework-builds/'+revised.id+'/inputs');verifyManifest(inputs,revised.manifest);let text=fs.readFileSync(safePath(inputs,p.main),'utf8');const edits=pairs.map(n=>({...locate(text,n.next),replacement:n.old.oldText})).sort((a,b)=>b.start-a.start);check(edits.every((e,i)=>!i||e.end<=edits[i-1].start),'Declared repairs overlap',409,'VERSION_CONFLICT');for(const e of edits)text=text.slice(0,e.start)+e.replacement+text.slice(e.end);for(const n of pairs)locate(text,n.old);
 const files=revised.manifest.files.map(f=>f.file===p.main?{...f,sha256:sha(text),size:Buffer.byteLength(text,'utf8')}:f),reversedInputSha256=hashObject(files);check(reversedInputSha256===expected,'Owner edit exceeded its registered exact text fragments or repair span',409,'VERSION_CONFLICT');
 return {beforeInputSha256:expected,afterInputSha256:revised.manifest.sha256,reversedInputSha256,reverseMatchesBefore:true,registeredScopeSha256:hashObject({ids,pairs}),declaredFragmentCount:ids.length,scope:report.screening?.repairSpan?'explicit_contiguous_repair_span':'declared_fragments'};
}

export function verifyReworkReceipt(blind,bundle,receipt){
  const root=blind.store.root;check(receipt.bundleId===bundle.id&&receipt.inputSha256===bundle.manifest.sha256&&(receipt.sourceActor?sourceActorValid(root,bundle.paperId,bundle.owner,receipt.sourceActor)&&receipt.reviewedBy===receipt.sourceActor.threadId:receipt.reviewedBy===bundle.owner),'Owner receipt differs');
  check(hashFile(safePath(root,receipt.pdfRelative))===receipt.pdfSha256&&hashFile(safePath(root,receipt.comparisonRelative))===receipt.comparisonSha256,'Rework artifacts changed',409);
  const comparison=readJSON(safePath(root,receipt.comparisonRelative));check(comparison.bundleId===bundle.id&&comparison.inputSha256===bundle.manifest.sha256&&comparison.pdfSha256===receipt.pdfSha256,'Comparison input differs');
  if(receipt.affectedSemanticIds)check(hashObject(receipt.affectedSemanticIds)===hashObject(comparison.affectedSemanticIds)&&Array.isArray(comparison.additional)&&hashObject([comparison.primarySemanticId,...comparison.additional.map(n=>n.semanticId)])===hashObject(receipt.affectedSemanticIds),'Comparison fragment coverage differs',409);
  for(const [rel,hash] of Object.entries(comparison.artifactHashes))check(hashFile(safePath(path.dirname(safePath(root,receipt.comparisonRelative)),rel))===hash,'Comparison render changed',409);
}

// The blind reviewer may verify delivery, but must not receive original pixels,
// source locators, private filenames, commands or an owner's fidelity verdict.
export function completionDeliveryReceipt(blind,report,bundle){
 const receipt=report.ownerReceipt;check(receipt&&report.returnedBundleId===bundle.id,'Current owner delivery required',409,'DELIVERY_EVIDENCE_GAP');verifyReworkReceipt(blind,bundle,receipt);
 const root=blind.store.root,paper=blind.store.config.papers[report.paperId],pdf=safePath(root,receipt.pdfRelative),buildPath=path.join(path.dirname(pdf),'receipt.json'),build=readJSON(buildPath),comparison=readJSON(safePath(root,receipt.comparisonRelative)),inputs=safePath(root,'blind/rework-builds/'+bundle.id+'/inputs');
 verifyManifest(inputs,bundle.manifest);check(build.success===true&&['pdflatex','xelatex','lualatex','tectonic'].includes(build.engine)&&build.inputSha256===bundle.manifest.sha256&&build.pdfSha256===receipt.pdfSha256&&path.resolve(build.pdf)===path.resolve(pdf)&&build.completedAt&&build.shellEscape===false,'Actual local compiler receipt does not bind this returned PDF and input',409,'DELIVERY_EVIDENCE_GAP');
 check(comparison.sourceSha256===paper.source.sha256,'Comparison authority differs',409,'DELIVERY_EVIDENCE_GAP');
 const ids=report.screening?.affectedSemanticIds||[report.semanticId],primary=bundle.nodes.find(n=>n.semanticId===report.semanticId),entries=[{semanticId:report.semanticId,locator:comparison.locator,candidate:comparison.candidate,original:comparison.original,candidateDir:'candidate',originalDir:'original'},...(comparison.additional||[])];
 check(primary&&hashObject(ids)===hashObject(entries.map(n=>n.semanticId)),'Every declared returned fragment needs a comparison',409,'DELIVERY_EVIDENCE_GAP');
 for(const entry of entries){const node=bundle.nodes.find(n=>n.semanticId===entry.semanticId);check(node?.locator&&hashObject(node.locator)===hashObject(entry.locator),'Comparison must use the owner-declared locator for this returned fragment',409,'DELIVERY_EVIDENCE_GAP');for(const [dir,render] of [[entry.candidateDir,entry.candidate],[entry.originalDir,entry.original]]){check(Array.isArray(render?.pages)&&render.pages.length,'Rendered comparison pages are missing',409,'DELIVERY_EVIDENCE_GAP');for(const page of render.pages)for(const key of ['cropFile','contextFile','pageFile'])check(typeof page[key]==='string'&&comparison.artifactHashes[dir+'/'+page[key]],'Required rendered page is not hash-bound',409,'DELIVERY_EVIDENCE_GAP');}}
 let editScope;
 if(report.editScopeReceipt||report.screening?.repairSpan||report.ownerDisposition?.payload.disposition==='repair'){
  const actual=verifyOwnerEditScope(blind,report,bundle);
  for(const key of ['beforeInputSha256','afterInputSha256','scope','reversedInputSha256','registeredScopeSha256'])if(report.editScopeReceipt?.[key]!==undefined)check(report.editScopeReceipt[key]===actual[key],'Registered edit-scope receipt differs from current reverse verification',409,'DELIVERY_EVIDENCE_GAP');
  editScope={verified:true,...actual,method:'Replace only declared returned ranges with registered prior text, then hash the complete input manifest.',claim:'The reversed input hash equals the registered pre-edit input hash. This proves the registered edit boundary; it does not prove that text inside the boundary is merely reordered, scientifically correct, or faithful to the source.'};
 }
 const value={schemaVersion:editScope?2:1,fixture:!!blind.store.fixture,verified:true,bundleId:bundle.id,documentSha256:bundle.public.document.sha256,inputSha256:bundle.manifest.sha256,build:{success:true,engine:build.engine,pdfSha256:receipt.pdfSha256,completedAt:build.completedAt,receiptSha256:hashFile(buildPath)},comparison:{generated:true,receiptSha256:receipt.comparisonSha256,declaredFragmentCount:ids.length,declaredLocatorsMatched:true,artifactCount:Object.keys(comparison.artifactHashes).length,artifactSetSha256:hashObject(comparison.artifactHashes)},...(editScope?{editScope}:{}),scope:'Program-verified existence and version binding of the successful build and rendered comparisons.'+(editScope?' The editScope field separately proves the declared reverse-replacement hash check.':'')+' This is not a visual source-fidelity judgment. The model checks only returned TeX completion within its role.'};return {...value,sha256:hashObject(value)};
}
