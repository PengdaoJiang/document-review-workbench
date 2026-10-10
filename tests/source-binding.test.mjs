import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from '../setup.mjs';
import {BlindStore} from '../lib/blind-store.mjs';
import {sourceCandidateBinding,frozenCandidateBinding} from '../lib/source-binding.mjs';
import {recordSourceObservation} from '../lib/blind-bridge.mjs';
import {snapshotInputs} from '../lib/inputs.mjs';
import {hashFile,hashObject,readJSON,sha,writeJSON} from '../lib/io.mjs';

const run=path.join(ROOT,'tests/runs/source-binding-'+Date.now());
function fixture(name,{wideFirst=false}={}){
  const root=path.join(run,name),paperRoot=path.join(root,'paper'),outputs=path.join(paperRoot,'outputs');fs.mkdirSync(outputs,{recursive:true});
  const file=path.join(outputs,'main.tex'),quotes={focus:'SNR is 0 dB here; caption says 10 dB.',first:'First sentence has a comma,',second:'Second sentence repeats repeats a word.'};
  fs.writeFileSync(file,'\\documentclass{article}\n\\begin{document}\n'+Object.entries(quotes).map(([key,q])=>('Context before '+key+'. ').repeat(8)+'\n'+q+'\n'+('Context after '+key+'. ').repeat(8)).join('\n\n')+'\n\\end{document}');
  fs.writeFileSync(path.join(root,'original.txt'),'Synthetic source; this fixture does not inspect real paper content.');fs.writeFileSync(path.join(root,'mapping.json'),'{}');fs.writeFileSync(path.join(root,'crop.png'),'Synthetic crop only.');
  const paper={paperId:'p',owner:'fixture',root:paperRoot,main:'main.tex',source:{path:path.join(root,'original.txt'),sha256:hashFile(path.join(root,'original.txt')),pages:1},mapping:{path:path.join(root,'mapping.json'),sha256:hashFile(path.join(root,'mapping.json'))}};
  const store={root,fixture:true,config:{root:ROOT,papers:{p:paper}}},blind=new BlindStore(store,{leaseRoot:path.join(root,'lease')});
  const node=(semanticId,quote)=>{const text=fs.readFileSync(file,'utf8'),at=text.indexOf(quote);assert.ok(at>=0);return {semanticId,target:{file:'main.tex',anchorId:semanticId,oldText:quote,oldSha256:sha(quote),before:text.slice(at-48,at),after:text.slice(at+quote.length,at+quote.length+48)}};};
  const initialNodes=Object.entries(quotes).map(([id,q])=>node(id,q));if(wideFirst){const target=initialNodes.find(n=>n.semanticId==='first').target,text=fs.readFileSync(file,'utf8');target.oldText=text.slice(0,text.indexOf(quotes.first)+quotes.first.length);target.oldSha256=sha(target.oldText);target.before='';}
  const bundle=blind.freeze('p',{nodes:initialNodes});const cap=blind.capability(blind.issueCapability('reporter',{bundleId:bundle.id}).capability);
  const report=(id,lane='completion')=>{const n=bundle.nodes.find(n=>n.semanticId===id);return blind.submit(cap,{bundleId:bundle.id,documentSha256:bundle.public.document.sha256,nodeId:n.nodeId,quote:n.quote,lane,question:'Inspect this synthetic construction concern.',conditions:'Only this synthetic quoted text.',evidence:'The quoted node is the bounded fixture.',closure:'Close only this local synthetic concern.',dispute:'fixture-'+id,citations:[n.quote]});};
  const focus=report('focus','math'),repairs={first:report('first'),second:report('second')};
  function repair(id,replacement,{extraEdit,others={},narrowReturn}={}){
    const reportId=repairs[id].id,changes={[id]:replacement,...others},affectedSemanticIds=Object.keys(changes),group=affectedSemanticIds.length>1;
    if(group){const report=blind.report(reportId);report.status='source_triage';blind.save('reports',report);const saved=blind.bundle(bundle.id);saved.nodes.find(n=>n.semanticId===id).locatorEvidence={sourceSha256:paper.source.sha256,mappingSha256:paper.mapping.sha256};blind.save('bundles',saved);}
    blind.screen(reportId,{action:'owner_rework',reason:'Synthetic source-verified punctuation or duplicate repair only.',...(group?{affectedSemanticIds,completionScope:{question:'Restore two scoped synthetic fragments.',conditions:'Do not edit the focus paragraph.',closure:'Both assigned replacements are present.'}}:{})});blind.receiveRework('p',reportId);
    let text=fs.readFileSync(file,'utf8');for(const [key,value] of Object.entries(changes))text=text.replace(quotes[key],value);if(extraEdit)text=extraEdit(text);fs.writeFileSync(file,text);
    const revised=blind.freeze('p',{nodes:Object.entries(changes).map(([key,value])=>node(key,key===id&&narrowReturn?narrowReturn:value))}),buildRoot=path.join(blind.root,'rework-builds',revised.id);snapshotInputs(outputs,path.join(buildRoot,'inputs'),revised.manifest);
    fs.writeFileSync(path.join(buildRoot,'fixture.pdf'),'Synthetic PDF receipt fixture '+revised.id);const pdfRelative='blind/rework-builds/'+revised.id+'/fixture.pdf',pdfSha256=hashFile(path.join(root,pdfRelative));
    const comparisonRelative='blind/rework-builds/'+revised.id+'/comparison.json';writeJSON(path.join(root,comparisonRelative),{bundleId:revised.id,inputSha256:revised.manifest.sha256,pdfSha256,sourceSha256:paper.source.sha256,artifactHashes:{},...(group?{primarySemanticId:id,affectedSemanticIds,additional:affectedSemanticIds.slice(1).map(semanticId=>({semanticId}))}:{})});
    const receipt={success:true,bundleId:revised.id,inputSha256:revised.manifest.sha256,pdfRelative,pdfSha256,comparisonRelative,comparisonSha256:hashFile(path.join(root,comparisonRelative)),reviewedBy:paper.owner,...(group?{affectedSemanticIds}:{})};blind.returnRework('p',reportId,revised.id,receipt);return {revised,buildRoot,receipt};
  }
  const binding=()=>sourceCandidateBinding(blind,bundle,bundle.nodes.find(n=>n.semanticId==='focus'));
  const observation={bundleId:bundle.id,documentSha256:bundle.public.document.sha256,reading:'faithful_source_anomaly',note:'Synthetic local source observation only; no scientific verdict or actual source inspection is asserted.',locator:{page:1,bbox:[1,1,20,20],label:'Synthetic source'},evidence:{sourceSha256:paper.source.sha256,mappingSha256:paper.mapping.sha256,reviewedBy:'authorized_source_bridge',reference:'Synthetic source fixture only, not actual paper evidence.',cropRelative:path.relative(ROOT,path.join(root,'crop.png')).replaceAll('\\','/'),cropSha256:hashFile(path.join(root,'crop.png'))}};
  return {root,outputs,file,blind,bundle,focus,repairs,repair,binding,observation};
}

test('unchanged source fragment remains bound to the original frozen document',()=>{const f=fixture('unchanged'),b=f.binding();assert.equal(b.mode,'frozen_document');assert.equal(b.inputSha256,b.currentInputSha256);assert.deepEqual(b.ownerReturns,[]);});

test('an unrelated live edit or unreceipted freeze cannot bypass the source version gate',()=>{const f=fixture('unreceipted');fs.appendFileSync(f.file,'\nAn unreceipted edit.');f.blind.freeze('p',{wholeDocument:true});assert.throws(f.binding,e=>e.code==='VERSION_CONFLICT');});

test('same frozen mathematical inputs remain usable after a live edit without passing the live source gate',()=>{
 const f=fixture('frozen-identical'),node=f.bundle.nodes.find(n=>n.semanticId==='focus');fs.writeFileSync(f.file,fs.readFileSync(f.file,'utf8').replace('SNR is 0 dB','SNR is 1 dB'));
 const bound=frozenCandidateBinding(f.blind,f.bundle,node,f.bundle);assert.equal(bound.mode,'same_frozen_input');assert.equal(bound.targetBundleId,f.bundle.id);assert.equal(bound.currentInputSha256,f.bundle.manifest.sha256);assert.throws(f.binding,e=>e.code==='VERSION_CONFLICT');
});

test('reuse follows the assigned frozen owner-return lineage even while the live focus changes',()=>{
 const f=fixture('frozen-return'),returned=f.repair('first','First sentence has a comma.'),assigned=f.blind.freeze('p',{wholeDocument:true}),node=f.bundle.nodes.find(n=>n.semanticId==='focus');
 fs.writeFileSync(f.file,fs.readFileSync(f.file,'utf8').replace('SNR is 0 dB','SNR is 1 dB'));const bound=frozenCandidateBinding(f.blind,f.bundle,node,assigned);
 assert.equal(bound.targetBundleId,assigned.id);assert.equal(bound.currentInputSha256,assigned.manifest.sha256);assert.equal(bound.ownerReturns.length,1);assert.equal(bound.ownerReturns[0].returnedBundleId,returned.revised.id);assert.throws(f.binding,e=>e.code==='VERSION_CONFLICT');
});

test('an unreceipted assigned version cannot borrow old mathematical evidence',()=>{
 const f=fixture('frozen-unreceipted');fs.appendFileSync(f.file,'\nAn unreceipted change.');const assigned=f.blind.freeze('p',{wholeDocument:true});assert.throws(()=>frozenCandidateBinding(f.blind,f.bundle,f.bundle.nodes[0],assigned),e=>e.code==='VERSION_CONFLICT');
});

for(const what of ['snapshot','pdf','comparison'])test('tampered assigned '+what+' cannot support frozen mathematical reuse',()=>{
 const f=fixture('frozen-tamper-'+what),returned=f.repair('first','First sentence has a comma.'),assigned=f.blind.freeze('p',{wholeDocument:true}),file=what==='snapshot'?path.join(returned.buildRoot,'inputs/main.tex'):path.join(f.root,what==='pdf'?returned.receipt.pdfRelative:returned.receipt.comparisonRelative);fs.appendFileSync(file,'tampered');assert.throws(()=>frozenCandidateBinding(f.blind,f.bundle,f.bundle.nodes[0],assigned));
});

test('a changed target context in the assigned owner return still rejects mathematical reuse',()=>{
 const f=fixture('frozen-changed-context');f.repair('first','First sentence has a comma.',{extraEdit:s=>s.replace('Context before focus. \n','Changed focus context. \n')});const assigned=f.blind.freeze('p',{wholeDocument:true});assert.throws(()=>frozenCandidateBinding(f.blind,f.bundle,f.bundle.nodes[0],assigned),e=>e.code==='VERSION_CONFLICT');
});

test('a narrow historical return reconstructs the prior whole fragment and exact complete input',()=>{
 const f=fixture('frozen-narrow-return'),returned=f.repair('first','First sentence has a comma.',{narrowReturn:'comma.'}),assigned=f.blind.freeze('p',{wholeDocument:true});fs.appendFileSync(f.file,'\nLater live work.');const bound=frozenCandidateBinding(f.blind,f.bundle,f.bundle.nodes[0],assigned);assert.equal(bound.ownerReturns.length,1);assert.equal(bound.ownerReturns[0].reverseScope,'prior_outer_context_containing_returned_fragment');assert.equal(bound.ownerReturns[0].fromInputSha256,f.bundle.manifest.sha256);assert.equal(bound.ownerReturns[0].toInputSha256,returned.revised.manifest.sha256);assert.throws(f.binding,e=>e.code==='VERSION_CONFLICT');
});

test('expanding a narrow return cannot admit an extra edit outside the prior fragment',()=>{
 const f=fixture('frozen-narrow-extra');f.repair('first','First sentence has a comma.',{narrowReturn:'comma.',extraEdit:s=>s.replace('\\documentclass{article}','\\documentclass{book}')});const assigned=f.blind.freeze('p',{wholeDocument:true});assert.throws(()=>frozenCandidateBinding(f.blind,f.bundle,f.bundle.nodes[0],assigned),e=>e.code==='VERSION_CONFLICT');
});

test('a narrow return inside a file-leading prior range uses the file boundary and retains the exact parent hash',()=>{
 const f=fixture('frozen-prefix-return',{wideFirst:true});f.repair('first','First sentence has a comma.',{narrowReturn:'comma.'});const assigned=f.blind.freeze('p',{wholeDocument:true});fs.appendFileSync(f.file,'\nUnrelated later work.');const bound=frozenCandidateBinding(f.blind,f.bundle,f.bundle.nodes[0],assigned);assert.equal(bound.ownerReturns[0].reverseScope,'prior_outer_context_containing_returned_fragment');assert.equal(bound.ownerReturns[0].fromInputSha256,f.bundle.manifest.sha256);
});

test('a completed bounded owner repair preserves an exact pending fragment without rebasing math',()=>{
  const f=fixture('one-return'),r=f.blind.report(f.focus.id);r.status='unknown';r.mathResult={outcome:'unknown',explanation:'Fixture mathematical result still bound to the first document.'};f.blind.save('reports',r);const before=hashObject({encoding:r.encoding,mathResult:r.mathResult,bundleId:r.bundleId});
  const returned=f.repair('first','First sentence has a comma.');const b=f.binding();assert.equal(b.mode,'unchanged_fragment_after_owner_rework');assert.equal(b.ownerReturns.length,1);assert.equal(b.ownerReturns[0].returnedBundleId,returned.revised.id);
  assert.equal(recordSourceObservation(f.blind,r.id,f.observation).status,'source_anomaly_preserved');const after=f.blind.report(r.id);assert.equal(hashObject({encoding:after.encoding,mathResult:after.mathResult,bundleId:after.bundleId}),before);assert.equal(after.sourceObservation.candidateBinding.documentSha256,f.bundle.public.document.sha256);
  fs.appendFileSync(f.file,'\nLater live edit.');assert.equal(recordSourceObservation(f.blind,r.id,f.observation).status,'source_anomaly_preserved');assert.deepEqual(f.blind.report(r.id).sourceObservation,after.sourceObservation);
});

test('two independent repairs from the same frozen review have a verified cumulative lineage',()=>{const f=fixture('two-returns');f.repair('first','First sentence has a comma.');f.repair('second','Second sentence repeats a word.');const b=f.binding();assert.equal(b.ownerReturns.length,2);assert.equal(b.ownerReturns[0].fromInputSha256,f.bundle.manifest.sha256);assert.equal(b.ownerReturns[0].toInputSha256,b.ownerReturns[1].fromInputSha256);assert.equal(b.ownerReturns[1].toInputSha256,b.currentInputSha256);});

test('a bounded group repair requires all declared fragments and preserves unrelated source lineage',()=>{const f=fixture('group-return'),r=f.repair('first','First sentence has a comma.',{others:{second:'Second sentence repeats a word.'}});assert.equal(f.binding().ownerReturns.length,1);const file=path.join(f.root,r.receipt.comparisonRelative),comparison=readJSON(file);comparison.additional=[];writeJSON(file,comparison);r.receipt.comparisonSha256=hashFile(file);const report=f.blind.report(f.repairs.first.id);report.ownerReceipt=r.receipt;f.blind.save('reports',report);assert.throws(f.binding,/Comparison fragment coverage differs/);});

for(const [name,change] of [['target',s=>s.replace('SNR is 0 dB','SNR is 1 dB')],['context',s=>s.replace('Context before focus. \n','Changed focus context. \n')],['unrelated-extra',s=>s.replace('\\documentclass{article}','\\documentclass{book}')]])test('a receipted repair cannot smuggle changed '+name+' through local source reuse',()=>{const f=fixture('changed-'+name);f.repair('first','First sentence has a comma.',{extraEdit:change});assert.throws(f.binding,e=>e.code==='VERSION_CONFLICT');});

test('changed dependencies or assets block local source reuse',()=>{const f=fixture('dependency');f.repair('first','First sentence has a comma.');fs.writeFileSync(path.join(f.outputs,'added.tex'),'A changed dependency.');assert.throws(f.binding,e=>e.code==='VERSION_CONFLICT');});

for(const what of ['snapshot','pdf','comparison'])test('tampered owner '+what+' cannot supply source-reuse lineage',()=>{const f=fixture('tamper-'+what),r=f.repair('first','First sentence has a comma.');const file=what==='snapshot'?path.join(r.buildRoot,'inputs/main.tex'):path.join(f.root,what==='pdf'?r.receipt.pdfRelative:r.receipt.comparisonRelative);fs.appendFileSync(file,'tampered');assert.throws(f.binding);});

test('construction scope reaches only the returned completion role, with no private source metadata',()=>{
  const f=fixture('completion-scope'),scope={question:'Restore the repeated caption descriptions.',conditions:'Keep the supplied literal parameter labels.',closure:'Each required caption phrase is present exactly once.'},id=f.repairs.first.id;
  assert.throws(()=>f.blind.screen(id,{action:'owner_rework',reason:'Bounded construction task.',completionScope:{...scope,closure:'Read E:/private/original.pdf'}}));
  f.blind.screen(id,{action:'owner_rework',reason:'Private engineering context stays outside role input.',completionScope:scope});const r=f.blind.report(id);r.returnedBundleId=f.bundle.id;r.status='completion_recheck';f.blind.save('reports',r);
  const cap=f.blind.capability(f.blind.issueCapability('completion_reviewer',{reportId:id}).capability),input=f.blind.roleInput(cap);assert.deepEqual(input.completionScope,scope);assert.doesNotMatch(JSON.stringify(input),/Private engineering context|locatorEvidence|candidateBinding/);
  const ordinary=f.blind.roleInput({role:'checker',reportId:id});assert.equal(ordinary.completionScope,undefined);assert.equal(ordinary.report.question,'Inspect this synthetic construction concern.');
});

for(const extra of [false,true])test('explicit pure relocation span '+(extra?'rejects an undeclared extra edit':'returns with a complete unchanged-fragment lineage'),()=>{
 const f=fixture('move-'+extra),r=f.blind.report(f.repairs.first.id),b=f.blind.bundle(f.bundle.id),n=b.nodes.find(n=>n.semanticId==='first'),p=f.blind.store.config.papers.p,text=fs.readFileSync(f.file,'utf8');
 const start=text.indexOf('Context before first.'),split=text.indexOf('Context before second.'),end=text.indexOf('\n\\end{document}'),a=text.slice(start,split),z=text.slice(split,end),oldSpan=text.slice(start,end),newSpan=z+'\n\n'+a.trimEnd();const target={file:'main.tex',anchorId:'relocation-span',oldText:oldSpan,oldSha256:sha(oldSpan),before:text.slice(start-48,start),after:text.slice(end,end+48)};
 n.locatorEvidence={sourceSha256:p.source.sha256,mappingSha256:p.mapping.sha256};f.blind.save('bundles',b);r.status='source_triage';f.blind.save('reports',r);f.blind.screen(r.id,{action:'owner_rework',reason:'Synthetic owner-declared pure relocation in one exact contiguous span.',affectedSemanticIds:['first'],repairSpan:target,completionScope:{question:'Move the second synthetic paragraph before the first.',conditions:'No text or dependencies outside this span may change.',closure:'Both original paragraphs occur once in the requested order.'}});f.blind.receiveRework('p',r.id);
 let next=text.slice(0,start)+newSpan+text.slice(end);if(extra)next=next.replace('\\documentclass{article}','\\documentclass{book}');fs.writeFileSync(f.file,next);const revised=f.blind.freeze('p',{nodes:[{semanticId:'first',target:{...target,oldText:newSpan,oldSha256:sha(newSpan)}}]}),dir=path.join(f.blind.root,'rework-builds',revised.id);snapshotInputs(f.outputs,path.join(dir,'inputs'),revised.manifest);fs.writeFileSync(path.join(dir,'fixture.pdf'),'Synthetic relocation PDF');const pdfRelative='blind/rework-builds/'+revised.id+'/fixture.pdf',pdfSha256=hashFile(path.join(f.root,pdfRelative)),comparisonRelative='blind/rework-builds/'+revised.id+'/comparison.json';writeJSON(path.join(f.root,comparisonRelative),{bundleId:revised.id,inputSha256:revised.manifest.sha256,pdfSha256,sourceSha256:p.source.sha256,artifactHashes:{},primarySemanticId:'first',affectedSemanticIds:['first'],additional:[]});const receipt={success:true,bundleId:revised.id,inputSha256:revised.manifest.sha256,pdfRelative,pdfSha256,comparisonRelative,comparisonSha256:hashFile(path.join(f.root,comparisonRelative)),reviewedBy:p.owner,affectedSemanticIds:['first']};
 if(extra)assert.throws(()=>f.blind.returnRework('p',r.id,revised.id,receipt),e=>e.code==='VERSION_CONFLICT');else{assert.equal(f.blind.returnRework('p',r.id,revised.id,receipt).status,'completion_recheck');assert.equal(f.binding().ownerReturns.length,1);}
});
