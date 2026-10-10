import fs from 'node:fs';
import path from 'node:path';
import {check,hashObject,readJSON,safePath,sha} from './io.mjs';
import {inputManifest,verifyManifest} from './inputs.mjs';
import {locate} from './target.mjs';
import {verifyReworkReceipt} from './rework-evidence.mjs';
export {verifyOwnerEditScope} from './rework-evidence.mjs';

// A local source reading may survive unrelated, receipted owner repairs. It
// never rebases the frozen document, mathematical encoding or tool verdict.
export function sourceCandidateBinding(blind,bundle,node){
  return candidateBinding(blind,bundle,node);
}

// Mathematical reuse is bound to the immutable assignment, not to a newer
// working manuscript. The live source-reading entrypoint above is unchanged.
export function frozenCandidateBinding(blind,bundle,node,target){
  return candidateBinding(blind,bundle,node,target);
}

function reverseOwnerRanges(text,pairs,expandNested=false){
  const unique=(context)=>context&&text.indexOf(context)===text.lastIndexOf(context)?text.indexOf(context):-1;
  const edits=pairs.map(n=>{
    const found=locate(text,n.next.target);let range=found;
    if(expandNested){
      const before=n.old.target.before?unique(n.old.target.before):0,after=n.old.target.after?unique(n.old.target.after):text.length,start=before+n.old.target.before.length;
      check(before>=0&&after>=start&&start<=found.start&&found.end<=after,'Nested owner return has no unique unchanged outer context',409,'VERSION_CONFLICT');range={start,end:after};
    }
    return {...range,replacement:n.old.target.oldText};
  }).sort((a,b)=>b.start-a.start);
  check(edits.every((e,i)=>i===0||e.end<=edits[i-1].start),'Overlapping owner repairs');
  let reversed=text;for(const e of edits)reversed=reversed.slice(0,e.start)+e.replacement+reversed.slice(e.end);
  for(const n of pairs)locate(reversed,n.old.target);return reversed;
}

function candidateBinding(blind,bundle,node,target=null){
  const paper=blind.store.config.papers[bundle.paperId];let outputs=path.join(paper.root,'outputs');
  check(node?.target&&bundle.owner===paper.owner,'Source target owner differs',409,'VERSION_CONFLICT');
  blind.viewBundle(bundle.id);
  check(hashObject(bundle.manifest.files)===bundle.manifest.sha256,'Frozen manifest changed',409,'VERSION_CONFLICT');
  if(target){
    check(target.paperId===bundle.paperId&&target.owner===paper.owner,'Frozen reuse owner or paper differs',409,'VERSION_CONFLICT');blind.viewBundle(target.id);
    check(hashObject(target.manifest.files)===target.manifest.sha256,'Assigned manifest changed',409,'VERSION_CONFLICT');
    if(target.manifest.sha256===bundle.manifest.sha256)return {mode:'same_frozen_input',bundleId:bundle.id,targetBundleId:target.id,documentSha256:bundle.public.document.sha256,inputSha256:bundle.manifest.sha256,currentInputSha256:target.manifest.sha256,targetSha256:node.target.oldSha256,contextSha256:sha(node.target.before+node.target.oldText+node.target.after),ownerReturns:[],scope:'Mathematical evidence remains on these identical frozen inputs; no live manuscript or source ruling is covered.'};
    const returns=blind.all('reports').flatMap(r=>[r,...(r.ownerReturnHistory||[])]).filter(r=>r.paperId===bundle.paperId&&r.ownerReceipt&&r.returnedBundleId);
    const delivered=returns.map(r=>({report:r,bundle:blind.bundle(r.returnedBundleId)})).find(x=>x.bundle.owner===paper.owner&&x.bundle.manifest.sha256===target.manifest.sha256);
    check(delivered,'Assigned reuse target requires a receipted frozen owner return',409,'VERSION_CONFLICT');
    verifyReworkReceipt(blind,delivered.bundle,delivered.report.ownerReceipt);
    outputs=safePath(blind.root,'rework-builds/'+delivered.bundle.id+'/inputs');verifyManifest(outputs,target.manifest);
  }
  const current=inputManifest(outputs,paper.main),file=node.target.file;
  if(target)check(current.sha256===target.manifest.sha256,'Assigned snapshot differs from its owner return',409,'VERSION_CONFLICT');
  const exactTarget=text=>{try{locate(text,node.target);}catch{check(false,'Source target or its exact context changed',409,'VERSION_CONFLICT');}};
  exactTarget(fs.readFileSync(safePath(outputs,file),'utf8'));
  const binding={mode:'frozen_document',bundleId:bundle.id,...(target?{targetBundleId:target.id}:{}),documentSha256:bundle.public.document.sha256,inputSha256:bundle.manifest.sha256,currentInputSha256:current.sha256,targetSha256:node.target.oldSha256,contextSha256:sha(node.target.before+node.target.oldText+node.target.after),ownerReturns:[],scope:target?'Only this unchanged fragment and verified repair lineage between frozen inputs; the newer live manuscript and source rulings are not covered.':'Only this unchanged local TeX fragment and context; frozen mathematical evidence is not rebased.'};
  const finish=()=>{check(inputManifest(outputs,paper.main).sha256===current.sha256,'Candidate changed during source validation',409,'VERSION_CONFLICT');return binding;};
  if(current.sha256===bundle.manifest.sha256)return finish();
  check(file===paper.main&&hashObject(current.files.filter(f=>f.file!==file))===hashObject(bundle.manifest.files.filter(f=>f.file!==file)),'Source check requires unchanged dependencies and assets',409,'VERSION_CONFLICT');
  const bundles=blind.all('bundles').filter(b=>b.paperId===bundle.paperId&&b.owner===paper.owner);
  const returns=blind.all('reports').flatMap(r=>[r,...(r.ownerReturnHistory||[])]).filter(r=>r.paperId===bundle.paperId&&r.ownerReceipt&&r.returnedBundleId);
  let cursor=current.sha256;const seen=new Set();
  while(cursor!==bundle.manifest.sha256){
    check(!seen.has(cursor)&&seen.size<32,'Owner repair lineage is cyclic or too long',409,'VERSION_CONFLICT');seen.add(cursor);
    const candidates=returns.filter(r=>bundles.some(b=>b.id===r.returnedBundleId&&b.manifest.sha256===cursor));
    let edge;
    for(const report of candidates){
      const revised=bundles.find(b=>b.id===report.returnedBundleId),prior=blind.bundle(report.reworkBaseBundleId||report.bundleId);
      const affected=report.screening?.affectedSemanticIds||[report.semanticId];
      const pairs=affected.map(id=>({old:report.screening?.repairSpan&&id===report.semanticId?{target:report.screening.repairSpan}:prior.nodes.find(n=>n.semanticId===id),next:revised.nodes.find(n=>n.semanticId===id)}));
      if(pairs.some(n=>n.old?.target.file!==file||n.next?.target.file!==file))continue;
      verifyReworkReceipt(blind,revised,report.ownerReceipt);
      const comparison=readJSON(safePath(blind.store.root,report.ownerReceipt.comparisonRelative));
      check(comparison.sourceSha256===paper.source.sha256,'Owner comparison source changed',409,'VERSION_CONFLICT');
      const inputs=safePath(blind.root,'rework-builds/'+revised.id+'/inputs');verifyManifest(inputs,revised.manifest);
      const text=fs.readFileSync(safePath(inputs,file),'utf8');exactTarget(text);
      for(const expandNested of [false,true]){
        let reversed;try{reversed=reverseOwnerRanges(text,pairs,expandNested);exactTarget(reversed);}catch{continue;}
        const parentFiles=revised.manifest.files.map(f=>f.file===file?{...f,sha256:sha(reversed),size:Buffer.byteLength(reversed,'utf8')}:f),parentSha=hashObject(parentFiles);
        const parent=bundles.find(b=>b.manifest.sha256===parentSha&&hashObject(b.manifest.files)===parentSha);
        if(!parent||parentSha===cursor)continue;
        edge={reportId:report.id,returnedBundleId:revised.id,receiptSha256:hashObject(report.ownerReceipt),fromInputSha256:parentSha,toInputSha256:cursor,reverseScope:expandNested?'prior_outer_context_containing_returned_fragment':'declared_returned_fragment'};break;
      }
      if(edge)break;
    }
    check(edge,'Candidate changed without a complete bounded owner-return lineage',409,'VERSION_CONFLICT');
    binding.ownerReturns.push(edge);cursor=edge.fromInputSha256;
  }
  binding.mode='unchanged_fragment_after_owner_rework';binding.ownerReturns.reverse();return finish();
}
