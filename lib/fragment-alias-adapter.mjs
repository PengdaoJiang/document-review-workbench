// Read-only identity adapter. JSON/TeX plus byte hashes of explicitly bound
// user-application result.pdf only; never reads source PDFs or image pixels.
import fs from 'node:fs';
import path from 'node:path';
import {walkRangeLineage} from './range-lineage.mjs';
import {routingHash as hash, textSha256 as sha, sealRoutingRecord as seal,
 fragmentAliasKey, createFragmentLedger} from './fragment-human-routing.mjs';

const clone=x=>structuredClone(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const check=(ok,code,details)=>{if(!ok)throw Object.assign(new Error(code),{code,technicalGap:true,...(details?{details}:{} )});};
const one=(xs,code)=>{check(xs.length===1,code,{candidateCount:xs.length});return xs[0];};
const ref=(kind,value)=>({id:kind+':'+value.id,sha256:hash(value)});
const inside=(root,file)=>{const r=path.relative(root,file);return r!== '..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
function evidenceFile(root,relative,audit=null,{resultPdf=false}={}){
 check(typeof root==='string'&&typeof relative==='string'&&relative.length<600&&!/[\\:\x00-\x1f]/.test(relative)&&!path.isAbsolute(relative)&&relative.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!/[. ]$/.test(x)),'ALIAS_PATH_ESCAPE');
 check(resultPdf?/^results\/[a-zA-Z0-9_-]+\/result\.pdf$/.test(relative):/\.(json|tex)$/i.test(relative),'ALIAS_TEXT_ONLY');
 const base=path.resolve(root);let p=base;
 while(true){check(!fs.lstatSync(p).isSymbolicLink(),'ALIAS_PATH_LINK');const parent=path.dirname(p);if(parent===p)break;p=parent;}
 p=base;for(const part of relative.split('/')){p=path.join(p,part);check(!fs.lstatSync(p).isSymbolicLink(),'ALIAS_PATH_LINK');check(inside(fs.realpathSync(base),fs.realpathSync(p)),'ALIAS_PATH_ESCAPE');}
 const data=fs.readFileSync(p),sha256=sha(data);
 if(audit){const key=path.resolve(root)+'\n'+relative,old=audit.get(key);check(!old||old.sha256===sha256,'ALIAS_CONTEXT_INPUT_CHANGED');audit.set(key,{root,relative,sha256,resultPdf});}
 return {text:resultPdf?null:data.toString('utf8'),sha256,relative};
}
const textFile=(root,relative,audit)=>evidenceFile(root,relative,audit);
const machineId=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]+$/.test(x);
function caseNames(root){
 const base=path.resolve(root);let at=base;while(true){check(!fs.lstatSync(at).isSymbolicLink(),'ALIAS_PATH_LINK');const parent=path.dirname(at);if(parent===at)break;at=parent;}
 const dir=path.join(base,'cases');if(!fs.existsSync(dir))return [];
 check(!fs.lstatSync(dir).isSymbolicLink(),'ALIAS_PATH_LINK');
 return fs.readdirSync(dir).filter(x=>!x.startsWith('.')).sort();
}
const parse=x=>JSON.parse(x.text.replace(/^\uFEFF/,''));
function sourceAssignments(q){
 const dir=path.join(q.store.root,'source-executors/assignments');if(!fs.existsSync(dir))return [];
 check(!fs.lstatSync(dir).isSymbolicLink(),'ALIAS_PATH_LINK');return fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>{const a=parse(textFile(q.store.root,'source-executors/assignments/'+n));check(machineId(a.id)&&a.id+'.json'===n,'ALIAS_PATCH_ASSIGNMENT_ID');return a;});
}
function locate(text,t){
 check(t&&typeof t.oldText==='string'&&t.oldText.length>0&&sha(t.oldText)===t.oldSha256&&typeof t.before==='string'&&typeof t.after==='string'&&t.before.length+t.after.length>=24,'ALIAS_TARGET_INVALID');
 const needle=t.before+t.oldText+t.after,start=text.indexOf(needle);
 check(start>=0&&start===text.lastIndexOf(needle),'ALIAS_TARGET_NOT_UNIQUE');
 return {start:start+t.before.length,end:start+t.before.length+t.oldText.length};
}
const targetIdentity=t=>hash({file:t.file,oldText:t.oldText,oldSha256:t.oldSha256,before:t.before,after:t.after});
const mainEntry=(b,p)=>one(b.manifest.files.filter(x=>x.file===p.main),'ALIAS_MAIN_MANIFEST');
function bundleOK(b,p,paperId){
 check(b&&b.paperId===paperId&&b.owner===p.owner&&Array.isArray(b.manifest?.files)&&hash(b.manifest.files)===b.manifest.sha256,'ALIAS_MANIFEST_INVALID');
 check(Array.isArray(b.nodes)&&b.nodes.length>0&&new Set(b.nodes.map(n=>n.nodeId)).size===b.nodes.length,'ALIAS_NODE_IDENTITY_INVALID');
 check(hash(b.public)===b.publicDigest&&b.public.bundleId===b.id&&sha(b.public.document?.text||'')===b.public.document?.sha256,'ALIAS_PUBLIC_HASH');
 check(hash({paperId,inputsSha256:b.manifest.sha256,nodes:b.nodes.map(n=>({semanticId:n.semanticId,contentSha256:n.contentSha256,target:n.target}))}).slice(0,24)===b.id,'ALIAS_BUNDLE_IDENTITY');
 for(const n of b.nodes){const pub=one(b.public.nodes.filter(x=>x.nodeId===n.nodeId),'ALIAS_PUBLIC_NODE');check(n.target?.file===p.main&&n.contentSha256===sha(n.quote)&&pub.contentSha256===n.contentSha256&&pub.quote===n.quote,'ALIAS_NODE_HASH');}
 mainEntry(b,p);return b;
}
const wholeCache=new WeakMap();
function wholeRaw(b,p){
 if(wholeCache.has(b))return wholeCache.get(b);
 const raw=b.nodes.map(n=>n.target.oldText).join(''),entry=mainEntry(b,p);
 if(sha(raw)!==entry.sha256||Buffer.byteLength(raw)!==entry.size||b.nodes.map(n=>n.quote).join('')!==b.public.document.text){wholeCache.set(b,null);return null;}
 let cursor=0;for(const n of b.nodes){const range=locate(raw,n.target);if(range.start!==cursor){wholeCache.set(b,null);return null;}cursor=range.end;}
 wholeCache.set(b,raw);return raw;
}
const synchronousContexts=new WeakMap();
function open(q,paperId){
 const batch=synchronousContexts.get(q);if(batch){batch.used.add(paperId);if(batch.contexts.has(paperId))return batch.contexts.get(paperId);}
 check(q?.blind&&q.store?.config?.papers?.[paperId]&&typeof q.jobs==='function'&&typeof q.all==='function','ALIAS_READER_REQUIRED');
 const p=clone(q.store.config.papers[paperId]);check(digest(p.source?.sha256)&&(!p.mapping||digest(p.mapping.sha256)),'ALIAS_SOURCE_SEAL_REQUIRED');
 const bundles=q.blind.all('bundles').filter(b=>b.paperId===paperId).map(b=>bundleOK(clone(b),p,paperId));
 const byId=new Map(bundles.map(b=>[b.id,b]));check(byId.size===bundles.length,'ALIAS_BUNDLE_DUPLICATE');
 const reports=q.blind.all('reports').filter(r=>r.paperId===paperId).map(clone),returns=reports.flatMap(r=>[r,...(r.ownerReturnHistory||[])]).filter(r=>r.ownerReceipt&&r.returnedBundleId).map(clone);
 const textCache=new Map(),rangeCache=new Map(),targetCache=new Map(),fragmentCache=new Map(),bundleReceiptCache=new Map(),receipts=[];
 function raw(b){
  if(textCache.has(b.manifest.sha256))return textCache.get(b.manifest.sha256);
  const whole=bundles.filter(x=>x.manifest.sha256===b.manifest.sha256).map(x=>wholeRaw(x,p)).filter(x=>x!==null);
  let value=whole[0];check(whole.every(x=>x===value),'ALIAS_SNAPSHOT_AMBIGUOUS');
  if(value===undefined){
   const rs=returns.filter(r=>byId.get(r.returnedBundleId)?.manifest.sha256===b.manifest.sha256);check(rs.length,'ALIAS_TEX_SNAPSHOT_MISSING');
   const values=rs.map(r=>textFile(q.blind.root,'rework-builds/'+r.returnedBundleId+'/inputs/'+p.main,batch?.files));
   check(values.every(x=>x.sha256===mainEntry(b,p).sha256&&Buffer.byteLength(x.text)===mainEntry(b,p).size),'ALIAS_TEX_SNAPSHOT_HASH');
   value=values[0].text;check(values.every(x=>x.text===value),'ALIAS_SNAPSHOT_AMBIGUOUS');
   receipts.push(...values.map(x=>({id:x.relative,sha256:x.sha256})));
  }
  textCache.set(b.manifest.sha256,value);return value;
 }
 function fragment(b,n){
  const key=b.id+':'+n.nodeId;if(fragmentCache.has(key))return fragmentCache.get(key);
  const rawRange=locate(raw(b),n.target),doc=b.public.document.text;
  let start;
  if(wholeRaw(b,p)!==null){start=0;for(const x of b.nodes){if(x.nodeId===(n.initialComposite?.nodeIds[0]||n.nodeId))break;start+=x.quote.length;}}
  else{start=doc.indexOf(n.quote);check(start>=0&&doc.lastIndexOf(n.quote)===start,'ALIAS_NEUTRAL_RANGE_AMBIGUOUS');}
  check(doc.slice(start,start+n.quote.length)===n.quote,'ALIAS_NEUTRAL_RANGE');
  const result={fragment:{paperId,sourceSha256:p.source.sha256,mappingSha256:p.mapping?.sha256||null,bundleId:b.id,documentSha256:b.public.document.sha256,inputSha256:b.manifest.sha256,file:n.target.file,semanticId:n.semanticId,nodeId:n.nodeId,tex:n.quote,texSha256:n.contentSha256,sourceTexSha256:sha(n.target.oldText),start,end:start+n.quote.length,positionUnit:'utf16'},rawRange};
  fragmentCache.set(key,result);return result;
 }
 function nodesAtRange(b,range){
  if(!rangeCache.has(b.id)){
   const rows=new Map(),text=raw(b);for(const n of b.nodes){try{const key=hash(locate(text,n.target));rows.set(key,[...(rows.get(key)||[]),n]);}catch{}}
   rangeCache.set(b.id,rows);
  }
  return rangeCache.get(b.id).get(hash(range))||[];
 }
 function rememberRaw(b,text){
  const f=mainEntry(b,p);check(sha(text)===f.sha256&&Buffer.byteLength(text)===f.size,'ALIAS_REVERSE_TEXT_HASH');
  if(textCache.has(b.manifest.sha256))check(textCache.get(b.manifest.sha256)===text,'ALIAS_REVERSE_TEXT_HASH');
  textCache.set(b.manifest.sha256,text);
 }
 function nodesForExactTarget(b,target){
  if(!targetCache.has(b.id)){const rows=new Map();for(const n of b.nodes){const key=targetIdentity(n.target);rows.set(key,[...(rows.get(key)||[]),n]);}targetCache.set(b.id,rows);}
  return targetCache.get(b.id).get(targetIdentity(target))||[];
 }
 const bundleReceipt=b=>{if(!bundleReceiptCache.has(b.id))bundleReceiptCache.set(b.id,ref('bundle',b));return bundleReceiptCache.get(b.id);};
 const context={q,p,paperId,bundles,byId,reports,returns,raw,fragment,receipts,nodesAtRange,rememberRaw,nodesForExactTarget,bundleReceipt,readAudit:batch?.files,assignments:(batch?.assignments||sourceAssignments(q)).filter(a=>a.paperId===paperId),caseIds:(batch?.caseIds||caseNames(q.store.root)).filter(x=>x.startsWith(paperId+'-'))};
 batch?.contexts.set(paperId,context);return context;
}
function history(ctx){
 if(ctx.historyResult)return ctx.historyResult;
 const {q,p,paperId,byId}=ctx,allJobs=clone(q.jobs().filter(j=>j.paperId===paperId&&j.kind==='review'));
 check(allJobs.length,'INITIAL_REVIEW_JOB_MISSING');
 const rows=[],jobs=[];
 for(const j of allJobs){
  const at=j.sentAt||j.receivedAt||j.acknowledgedAt;
  if(!at){check(['queued','cancelled'].includes(j.status)&&!j.attempts&&!j.transportReceipt,'INITIAL_SUBMISSION_HISTORY_GAP',{assignmentId:j.id});continue;}
  check(Number.isFinite(Date.parse(at)),'INITIAL_SUBMISSION_TIMESTAMP');
  const b=byId.get(j.bundleId);check(b&&wholeRaw(b,p)!==null,'INITIAL_WHOLE_FREEZE_UNPROVEN',{assignmentId:j.id});
  const f=one(q.all('freezes').filter(f=>f.paperId===paperId&&f.bundleId===b.id),'INITIAL_FREEZE_RECEIPT_MISSING');
  check(f.inputsSha256===b.manifest.sha256&&f.documentSha256===b.public.document.sha256&&f.owner===p.owner&&Number.isFinite(Date.parse(f.at))&&Date.parse(f.at)<=Date.parse(at),'INITIAL_FREEZE_BINDING');
  jobs.push(ref('review-job',j));
  rows.push({id:f.id,bundleId:b.id,documentSha256:b.public.document.sha256,inputSha256:b.manifest.sha256,sourceSha256:p.source.sha256,mappingSha256:p.mapping?.sha256||null,wholeDocument:true,submittedToBlind:true,submittedAt:at,firstReviewAssignmentId:j.id,receipt:ref('freeze',f),jobReceipt:ref('review-job',j)});
 }
 check(rows.length,'INITIAL_WHOLE_FREEZE_MISSING');rows.sort((a,b)=>Date.parse(a.submittedAt)-Date.parse(b.submittedAt));
 const first=rows[0];check(rows.filter(r=>r.submittedAt===first.submittedAt).every(r=>r.bundleId===first.bundleId&&r.id===first.id),'INITIAL_FIRST_FREEZE_AMBIGUOUS');
 return ctx.historyResult={first,freezeHistory:seal({complete:true,paperId,freezes:rows,reviewJobSetSha256:hash(allJobs.map(j=>({id:j.id,sha256:hash(j)})).sort((a,b)=>a.id.localeCompare(b.id))),reviewJobReceipts:jobs,method:'All recorded review jobs, actual submission timestamps, matching whole frozen input and full node reconstruction.'})};
}
function actorReceipt(ctx,receipt){
 const {p,q,paperId}=ctx;
 if(!receipt.sourceActor){check(receipt.reviewedBy===p.owner,'ALIAS_OWNER_RECEIPT_ACTOR');return;}
 const a=receipt.sourceActor;
 check(a.paperId===paperId&&a.historicalOwner===p.owner&&a.threadId===receipt.reviewedBy&&a.threadId!==p.owner&&a.proofRelative==='source-executors/actors/'+a.workerId+'.json','ALIAS_OWNER_RECEIPT_ACTOR');
 const proof=textFile(q.store.root,a.proofRelative,ctx.readAudit);check(proof.sha256===a.proofSha256&&hash(parse(proof))===hash(Object.fromEntries(Object.entries(a).filter(([k])=>!['proofRelative','proofSha256'].includes(k)))),'ALIAS_ACTOR_PROOF');
}
function humanEdges(ctx){
 const result=[],gaps=[],{q,p,paperId,bundles}=ctx;
 for(const key of ctx.caseIds){
  try{
   check(machineId(key),'ALIAS_HUMAN_CASE_ID');const base='cases/'+key+'/',pack=base+'package/';
   const rf=textFile(q.store.root,pack+'request.json',ctx.readAudit),sf=textFile(q.store.root,base+'state.json',ctx.readAudit),r=parse(rf),s=parse(sf),d=s.decision;
   check(r.spec?.paperId===paperId&&r.id===key,'ALIAS_HUMAN_CASE_BINDING');
   // Non-applied decisions and technical failures are never mechanical edges.
   if(s.status!=='verified'||d?.action!=='edit')continue;
   const fixture=q.store.fixture===true;
   check(r.fixture===fixture&&r.spec.fixture===fixture&&r.spec.owner===p.owner&&r.main===p.main,'ALIAS_HUMAN_CASE_BINDING');
   check(machineId(d.id)&&d.scope==='this_passage_only'&&(d.by==='local_user'||fixture&&d.by==='fixture_test_decision')&&typeof d.tex==='string'&&sha(d.tex)===d.texSha256&&d.requestDigest===r.intentDigest&&Number.isFinite(Date.parse(d.savedAt))&&Number.isFinite(Date.parse(s.ownerReceivedAt)),'ALIAS_HUMAN_DECISION_BINDING');
   check(r.intentDigest===hash(r.intent)&&hash(r.intent.spec)===hash(r.spec)&&hash(r.intent.version)===hash(r.version)&&r.intent.engine===r.engine&&r.intent.sourceSha256===p.source.sha256&&r.intent.mappingSha256===(p.mapping?.sha256||null)&&r.source?.sha256===p.source.sha256&&r.source.mappingSha256===(p.mapping?.sha256||null),'ALIAS_HUMAN_REQUEST_DIGEST');
   check(Array.isArray(r.manifest?.files)&&new Set(r.manifest.files.map(f=>f.file)).size===r.manifest.files.length&&r.manifest.files.every(f=>digest(f.sha256)&&Number.isInteger(f.size)&&f.size>=0)&&hash(r.manifest.files)===r.manifest.sha256&&r.version.inputsSha256===r.manifest.sha256,'ALIAS_HUMAN_MANIFEST');
   const parents=bundles.filter(b=>b.manifest.sha256===r.manifest.sha256);check(parents.length&&parents.every(b=>hash(b.manifest)===hash(r.manifest)),'ALIAS_HUMAN_PARENT_MISSING');
   const origin=r.spec.fragmentHumanOrigin||r.spec.ownerSourceOrigin||r.spec.blindOrigin;
   if(origin?.bundleId)check(parents.some(b=>b.id===origin.bundleId),'ALIAS_HUMAN_ORIGIN');
   const packageSealFile=textFile(q.store.root,pack+'seal.json',ctx.readAudit),packageSeal=parse(packageSealFile);
   check(Array.isArray(packageSeal.files)&&new Set(packageSeal.files.map(f=>f.file)).size===packageSeal.files.length&&hash(packageSeal.files)===packageSeal.sha256,'ALIAS_HUMAN_PACKAGE_SEAL');
   const sealed=(name,file)=>check(one(packageSeal.files.filter(f=>f.file===name),'ALIAS_HUMAN_PACKAGE_SEAL').sha256===file.sha256,'ALIAS_HUMAN_PACKAGE_SEAL');
   sealed('request.json',rf);
   const target=r.spec.target,entry=one(r.manifest.files.filter(f=>f.file===target?.file),'ALIAS_HUMAN_TARGET'),oldFile=textFile(q.store.root,pack+'inputs/'+target.file,ctx.readAudit);
   sealed('inputs/'+target.file,oldFile);check(oldFile.sha256===entry.sha256&&Buffer.byteLength(oldFile.text)===entry.size,'ALIAS_HUMAN_INPUT_HASH');
   const range=locate(oldFile.text,target),afterText=oldFile.text.slice(0,range.start)+d.tex+oldFile.text.slice(range.end),afterTargetHash=sha(afterText);
   const afterManifest={files:r.manifest.files.map(f=>f.file===target.file?{...f,sha256:afterTargetHash,size:Buffer.byteLength(afterText)}:f)};afterManifest.sha256=hash(afterManifest.files);
   const mainBefore=target.file===p.main?oldFile:textFile(q.store.root,pack+'inputs/'+p.main,ctx.readAudit),main=one(r.manifest.files.filter(f=>f.file===p.main),'ALIAS_HUMAN_MANIFEST');
   sealed('inputs/'+p.main,mainBefore);check(mainBefore.sha256===main.sha256&&mainBefore.sha256===r.version.texSha256&&Buffer.byteLength(mainBefore.text)===main.size,'ALIAS_HUMAN_INPUT_HASH');
   const v=s.verification;check(v&&machineId(v.packageId)&&v.inputSha256===afterManifest.sha256,'ALIAS_HUMAN_VERIFICATION_BINDING');
   const dest='results/'+v.packageId+'/',bf=textFile(q.store.root,dest+'receipt.json',ctx.readAudit),build=parse(bf),tf=textFile(q.store.root,dest+'target.tex',ctx.readAudit),mf=textFile(q.store.root,dest+'result.tex',ctx.readAudit),pdf=evidenceFile(q.store.root,dest+'result.pdf',ctx.readAudit,{resultPdf:true});
   const expectedMain=target.file===p.main?afterText:mainBefore.text;
   check(build.success===true&&build.decisionId===d.id&&build.requestDigest===r.intentDigest&&build.pdf==='result.pdf'&&build.inputSha256===v.inputSha256&&hash(build.manifest)===hash(afterManifest)&&build.texSha256===v.texSha256&&build.pdfSha256===v.pdfSha256&&build.targetSha256===v.targetSha256&&build.targetSha256===afterTargetHash,'ALIAS_HUMAN_RESULT_BINDING');
   check(tf.text===afterText&&tf.sha256===afterTargetHash&&mf.text===expectedMain&&mf.sha256===v.texSha256&&pdf.sha256===v.pdfSha256,'ALIAS_HUMAN_RESULT_HASH');
   // The journal only supplies the exact report body and actor. Acceptance is
   // independently proven by Store.operations, written AFTER Store validators.
   const jf=textFile(p.root,'work/review-desk/'+sha(key+'\n'+d.id).slice(0,16)+'/journal.json',ctx.readAudit),j=parse(jf),actor=j.sourceActor,report=j.finalReport;
   check(j.id===key&&j.decisionId===d.id&&j.owner===p.owner&&j.fixture===fixture&&j.target===target.file&&j.beforeSha256===oldFile.sha256&&j.afterSha256===afterTargetHash&&hash(j.manifestBefore)===hash(r.manifest)&&hash(j.manifestAfter)===hash(afterManifest)&&hash(j.changedRange)===hash(range),'ALIAS_HUMAN_JOURNAL_BINDING');
   check(actor&&typeof actor.writeRoot==='string'&&path.resolve(actor.writeRoot)===path.resolve(p.root),'ALIAS_HUMAN_ACTOR_REQUIRED');actorReceipt(ctx,{sourceActor:actor,reviewedBy:actor.threadId});
   check(report?.status==='verified'&&machineId(report.operationId)&&hash(report.result)===hash(v)&&report.id===undefined&&report.decisionId===undefined&&report.sourceActor===undefined,'ALIAS_HUMAN_REPORT_BINDING');
   const acceptedBody={id:key,decisionId:d.id,...report,sourceActor:actor};
   check(s.operations?.[report.operationId]===hash(acceptedBody)&&s.events?.some(e=>e.type==='verified')&&s.events?.some(e=>e.type==='decision_saved'&&e.decisionId===d.id),'ALIAS_HUMAN_STORE_ACCEPTANCE');
   const nexts=bundles.filter(b=>b.manifest.sha256===afterManifest.sha256&&wholeRaw(b,p)!==null);
   const freezes=clone(q.all('freezes')).filter(f=>f.paperId===paperId&&f.owner===p.owner&&nexts.some(b=>b.id===f.bundleId&&f.inputsSha256===b.manifest.sha256&&f.documentSha256===b.public.document.sha256)&&Number.isFinite(Date.parse(f.at)));
   check(freezes.length,'ALIAS_HUMAN_RETURN_FREEZE_MISSING');
   check(nexts.every(b=>wholeRaw(b,p)===expectedMain&&hash(b.manifest)===hash(afterManifest)),'ALIAS_HUMAN_RETURN_INPUT_HASH');
   const reversed=tf.text.slice(0,range.start)+target.oldText+tf.text.slice(range.start+d.tex.length),reverseFiles=afterManifest.files.map(f=>f.file===target.file?{...f,sha256:sha(reversed),size:Buffer.byteLength(reversed)}:f);
   check(reversed===oldFile.text&&hash(reverseFiles)===r.manifest.sha256,'ALIAS_HUMAN_REVERSE_HASH');
   for(const b of parents)ctx.rememberRaw(b,mainBefore.text);
   // A no-op edit is a same-manifest identity; avoid creating graph cycles.
   if(afterManifest.sha256===r.manifest.sha256)continue;
   const spans=target.file===p.main?[{beforeStart:range.start,beforeEnd:range.end,afterStart:range.start,afterEnd:range.start+d.tex.length}]:[];
   result.push({beforeInputSha256:r.manifest.sha256,afterInputSha256:afterManifest.sha256,spans,proof:seal({kind:'verified_human_exact_application',paperId,caseId:key,decisionId:d.id,requestDigest:r.intentDigest,beforeInputSha256:r.manifest.sha256,afterInputSha256:afterManifest.sha256,reversedInputSha256:hash(reverseFiles),reverseMatchesBefore:true,targetFile:target.file,spans,decisionReceipt:{id:d.id,sha256:hash(d)},requestReceipt:{id:rf.relative,sha256:rf.sha256},stateReceipt:{id:sf.relative,sha256:sf.sha256},packageSealReceipt:{id:packageSealFile.relative,sha256:packageSealFile.sha256},journalReceipt:{id:jf.relative,sha256:jf.sha256},acceptedStoreOperation:{id:report.operationId,sha256:hash(acceptedBody)},sourceActorReceipt:{id:actor.proofRelative,sha256:actor.proofSha256},resultReceipt:{id:bf.relative,sha256:bf.sha256},resultFiles:[tf,mf,pdf].map(f=>({id:f.relative,sha256:f.sha256})),freezeReceipts:freezes.map(f=>ref('freeze',f)),resultArtifactBytesRevalidated:true,sourceArtifactBytesRevalidated:false,claim:'Actual Store-accepted saved human edit, exact replacement and complete reverse manifest; result PDF bytes only, no source inspection, scientific judgment, fresh compile or publication approval.'})});
  }catch(e){gaps.push({caseId:key,code:e.code||'ALIAS_EVIDENCE_READ_GAP',...(e.details?{details:e.details}:{})});}
 }
 return {edges:result,gaps};
}
function sourcePatchEdges(ctx){
 const result=[],gaps=[],{q,p,paperId}=ctx,desk=q.store.config.root;
 for(const a of ctx.assignments)for(const attempt of a.attempts||[]){
  const expected=path.resolve(desk,'work/source',hash(path.resolve(q.store.root)).slice(0,10),String(attempt.id).slice(8,20));
  if(!attempt.runRoot||path.resolve(attempt.runRoot)!==expected){gaps.push({assignmentId:a.id,code:'ALIAS_PATCH_RUN_ROOT'});continue;}
  const relative=path.relative(desk,expected).replaceAll('\\','/'),opRoot=path.join(expected,'operations');if(!fs.existsSync(opRoot))continue;
  for(const name of fs.readdirSync(opRoot)){
   if(!machineId(name)||!fs.existsSync(path.join(opRoot,name,'patch.json')))continue;
   try{
    const base=relative+'/operations/'+name+'/',of=textFile(desk,base+'operation.json',ctx.readAudit),op=parse(of);if(op.status!=='accepted'||op.action!=='patch')continue;
    const jf=textFile(desk,base+'patch.json',ctx.readAudit),j=parse(jf),bf=textFile(desk,base+'before.tex',ctx.readAudit),af=textFile(desk,base+'after.tex',ctx.readAudit);
    check(op.id===name&&op.digest===hash({action:op.action,payload:op.payload})&&op.sourceActor?.assignmentId===a.id&&op.sourceActor?.paperId===paperId&&a.attempts.some(t=>t.id===op.sourceActor.attemptId),'ALIAS_PATCH_OPERATION_BINDING');
    for(const actor of [j.sourceActor,op.sourceActor,op.acceptedBy||op.sourceActor]){check(actor?.assignmentId===a.id&&actor.paperId===paperId&&a.attempts.some(t=>t.id===actor.attemptId),'ALIAS_PATCH_ACTOR_BINDING');actorReceipt(ctx,{reviewedBy:actor.threadId,sourceActor:actor});}
    check(j.sourceActor.attemptId===attempt.id&&j.reportId===a.reportId&&(!op.payload.id||op.payload.id===a.reportId)&&op.payload.expectedInputSha256===j.before.sha256,'ALIAS_PATCH_JOURNAL_BINDING');
    check(op.result?.applied===true&&op.result.beforeInputSha256===j.before.sha256&&op.result.inputSha256===j.after.sha256&&hash(op.result.nodes)===hash(j.nodes)&&path.resolve(op.result.journal)===path.join(expected,'operations',name,'patch.json'),'ALIAS_PATCH_ACCEPTED_RESULT');
    const parents=ctx.bundles.filter(b=>b.manifest.sha256===j.before.sha256),nexts=ctx.bundles.filter(b=>b.manifest.sha256===j.after.sha256);check(parents.length&&nexts.length&&hash(j.before.files)===j.before.sha256&&hash(j.after.files)===j.after.sha256,'ALIAS_PATCH_MANIFEST_BINDING');
    for(const [bs,m,f] of [[parents,j.before,bf],[nexts,j.after,af]])for(const b of bs){check(hash(b.manifest)===hash(m),'ALIAS_PATCH_MANIFEST_BINDING');ctx.rememberRaw(b,f.text);}
    check(hash(j.before.files.filter(f=>f.file!==p.main))===hash(j.after.files.filter(f=>f.file!==p.main))&&j.before.sha256!==j.after.sha256,'ALIAS_PATCH_DEPENDENCIES_CHANGED');
    const report=ctx.reports.find(r=>r.id===a.reportId),options=[];check(report,'ALIAS_PATCH_REPORT_MISSING');
    for(const d of [...(report.ownerDispositionHistory||[]),report.ownerDisposition].filter(d=>d?.payload?.disposition==='repair')){
     try{
      const body=d.payload,prior=ctx.byId.get(body.bundleId),ids=body.affectedSemanticIds;
      check(d.bodySha256===hash(body)&&body.id===report.id&&prior&&body.documentSha256===prior.public.document.sha256&&body.evidence?.reviewedBy===d.by&&body.evidence.sourceSha256===p.source.sha256&&body.evidence.mappingSha256===(p.mapping?.sha256||null),'ALIAS_PATCH_REGISTERED_DISPOSITION');actorReceipt(ctx,{reviewedBy:d.by,...(d.sourceActor?{sourceActor:d.sourceActor}:{})});
      check(Number.isFinite(Date.parse(d.at))&&Number.isFinite(Date.parse(op.acceptedAt))&&Date.parse(d.at)<=Date.parse(op.acceptedAt)&&Array.isArray(ids)&&ids.length>0&&ids.length<=8&&new Set(ids).size===ids.length&&ids[0]===report.semanticId&&hash(ids)===hash(j.nodes.map(n=>n.semanticId))&&op.payload.edits.length===ids.length&&new Set(op.payload.edits.map(e=>e.semanticId)).size===ids.length,'ALIAS_PATCH_REGISTERED_SCOPE');
      const edits=ids.map(id=>{const target=body.repairSpan&&id===report.semanticId?body.repairSpan:one(prior.nodes.filter(n=>n.semanticId===id),'ALIAS_PATCH_OLD_NODE').target,next=one(j.nodes.filter(n=>n.semanticId===id),'ALIAS_PATCH_NEW_NODE'),change=one(op.payload.edits.filter(e=>e.semanticId===id),'ALIAS_PATCH_PAYLOAD_EDIT');check(target.file===p.main&&next.target.file===p.main&&change.text===next.target.oldText,'ALIAS_PATCH_PAYLOAD_EDIT');return {old:locate(bf.text,target),next:locate(af.text,next.target),replacement:change.text};}).sort((a,b)=>a.old.start-b.old.start);
      check(edits.every((e,i)=>!i||edits[i-1].old.end<=e.old.start),'ALIAS_PATCH_OVERLAP');let actual=bf.text;for(const e of edits.toReversed())actual=actual.slice(0,e.old.start)+e.replacement+actual.slice(e.old.end);check(actual===af.text,'ALIAS_PATCH_EXACT_TRANSFORM');
      let delta=0;for(const e of edits){check(e.next.start===e.old.start+delta&&e.next.end-e.next.start===e.replacement.length,'ALIAS_PATCH_RANGE');delta+=e.replacement.length-(e.old.end-e.old.start);}
      const spans=edits.map(e=>({beforeStart:e.old.start,beforeEnd:e.old.end,afterStart:e.next.start,afterEnd:e.next.end,declaredAfterRange:e.next}));options.push({spans,dispositionSha256:hash(d)});
     }catch{}
    }
    const unique=[...new Map(options.map(x=>[hash(x.spans),x])).values()];check(unique.length===1,'ALIAS_PATCH_REGISTERED_SCOPE_UNRESOLVED');
    const {spans,dispositionSha256}=unique[0];result.push({beforeInputSha256:j.before.sha256,afterInputSha256:j.after.sha256,spans,proof:seal({kind:'verified_accepted_source_patch',paperId,reportId:report.id,assignmentId:a.id,beforeInputSha256:j.before.sha256,afterInputSha256:j.after.sha256,reverseMatchesBefore:true,spans,operation:{id:of.relative,sha256:of.sha256},journal:{id:jf.relative,sha256:jf.sha256},beforeTex:{id:bf.relative,sha256:bf.sha256},afterTex:{id:af.relative,sha256:af.sha256},dispositionSha256,claim:'Accepted fenced exact text patch identity only. Repair build, comparison, return and paper completion remain separate and may still be unfinished.'})});
   }catch(e){gaps.push({assignmentId:a.id,operationId:name,code:e.code||'ALIAS_EVIDENCE_READ_GAP',kind:'accepted_source_patch'});}
  }
 }
 return {edges:result,gaps};
}
function dispositionEdges(ctx){
 const result=[],gaps=[],{p,paperId,byId,raw}=ctx;
 // Two accepted registered repair spans can prove an intermediate transition
 // even when another repair preceded its build. This creates no return receipt.
 for(const report of ctx.reports){
  const ds=[...(report.ownerDispositionHistory||[]),report.ownerDisposition].filter(Boolean);
  for(let i=1;i<ds.length;i++){
   const before=ds[i-1],after=ds[i],a=before.payload,b=after.payload;
   if(a?.disposition!=='repair'||b?.disposition!=='repair'||!a.repairSpan||!b.repairSpan||a.bundleId===b.bundleId)continue;
   try{
    const prior=byId.get(a.bundleId),next=byId.get(b.bundleId);check(prior&&next,'ALIAS_DISPOSITION_BUNDLE_MISSING');
    for(const [d,payload,bundle] of [[before,a,prior],[after,b,next]]){
     check(d.bodySha256===hash(payload)&&payload.id===report.id&&payload.documentSha256===bundle.public.document.sha256,'ALIAS_DISPOSITION_BINDING');
     check(payload.evidence?.reviewedBy===d.by&&payload.evidence.sourceSha256===p.source.sha256&&payload.evidence.mappingSha256===(p.mapping?.sha256||null),'ALIAS_DISPOSITION_SOURCE_BINDING');
     actorReceipt(ctx,{reviewedBy:d.by,...(d.sourceActor?{sourceActor:d.sourceActor}:{})});
     check(Number.isFinite(Date.parse(d.at))&&Number.isFinite(Date.parse(bundle.createdAt))&&Date.parse(bundle.createdAt)<=Date.parse(d.at),'ALIAS_DISPOSITION_TIMESTAMP');
     check(hash(payload.affectedSemanticIds)===hash([report.semanticId])&&payload.repairSpan.file===p.main&&bundle.nodes.some(n=>n.semanticId===report.semanticId),'ALIAS_DISPOSITION_SCOPE');
    }
    check(Date.parse(before.at)<Date.parse(next.createdAt)&&Date.parse(before.at)<Date.parse(after.at),'ALIAS_DISPOSITION_ORDER');
    const oldText=raw(prior),newText=raw(next),oldRange=locate(oldText,a.repairSpan),newRange=locate(newText,b.repairSpan);
    const reversed=newText.slice(0,newRange.start)+a.repairSpan.oldText+newText.slice(newRange.end);
    check(reversed===oldText&&oldRange.start===newRange.start&&oldText!==newText,'ALIAS_DISPOSITION_REVERSE_MISMATCH');
    const reversedFiles=next.manifest.files.map(f=>f.file===p.main?{...f,sha256:sha(reversed),size:Buffer.byteLength(reversed)}:f);
    check(hash(reversedFiles)===prior.manifest.sha256,'ALIAS_DISPOSITION_DEPENDENCIES_CHANGED');
    const spans=[{beforeStart:oldRange.start,beforeEnd:oldRange.end,afterStart:newRange.start,afterEnd:newRange.end,declaredAfterRange:newRange}],proof=seal({kind:'verified_registered_disposition_transition',paperId,reportId:report.id,beforeInputSha256:prior.manifest.sha256,afterInputSha256:next.manifest.sha256,reverseMatchesBefore:true,spans,beforeDisposition:ref('registered-disposition',{...before,id:report.id+':'+i}),afterDisposition:ref('registered-disposition',{...after,id:report.id+':'+(i+1)}),beforeBundle:ctx.bundleReceipt(prior),afterBundle:ctx.bundleReceipt(next),claim:'Exact registered text transition only. No missing build, return, source judgment or business success is inferred.'});
    result.push({beforeInputSha256:prior.manifest.sha256,afterInputSha256:next.manifest.sha256,spans,proof});
   }catch(e){gaps.push({reportId:report.id,code:e.code||'ALIAS_EVIDENCE_READ_GAP',kind:'registered_disposition_transition'});}
  }
 }
 return {edges:result,gaps};
}
function lineEndingEdges(ctx){
 const seen=new Set(),versions=ctx.bundles.toSorted((a,b)=>a.createdAt.localeCompare(b.createdAt)).filter(b=>{if(seen.has(b.manifest.sha256))return false;seen.add(b.manifest.sha256);return true;}),result=[];
 for(let i=1;i<versions.length;i++){
  const before=versions[i-1],after=versions[i];let oldText,newText;
  try{oldText=ctx.raw(before);newText=ctx.raw(after);}catch{continue;}
  if(!Number.isFinite(Date.parse(before.createdAt))||Date.parse(before.createdAt)>=Date.parse(after.createdAt)||oldText===newText||oldText.replace(/\r\n/g,'\n')!==newText.replace(/\r\n/g,'\n'))continue;
  const files=after.manifest.files.map(f=>f.file===ctx.p.main?{...f,sha256:sha(oldText),size:Buffer.byteLength(oldText)}:f);if(hash(files)!==before.manifest.sha256)continue;
  const spans=[];let a=0,b=0;while(a<oldText.length||b<newText.length){if(oldText[a]===newText[b]){a++;b++;continue;}const remove=oldText[a]==='\r'&&oldText[a+1]==='\n'&&newText[b]==='\n',add=newText[b]==='\r'&&newText[b+1]==='\n'&&oldText[a]==='\n';check(remove||add,'ALIAS_LINE_ENDING_TRANSFORM');spans.push({beforeStart:a,beforeEnd:a+(remove?1:0),afterStart:b,afterEnd:b+(add?1:0)});if(remove)a++;else b++;}
  result.push({beforeInputSha256:before.manifest.sha256,afterInputSha256:after.manifest.sha256,spans,proof:seal({kind:'verified_line_endings_only',paperId:ctx.paperId,beforeInputSha256:before.manifest.sha256,afterInputSha256:after.manifest.sha256,reverseMatchesBefore:true,beforeBundle:ctx.bundleReceipt(before),afterBundle:ctx.bundleReceipt(after),beforeMainSha256:sha(oldText),afterMainSha256:sha(newText),spans,claim:'Byte-proven CRLF/LF representation change only; no content, build or review claim.'})});
 }
 return result;
}
function edges(ctx){
 if(ctx.edgeGraph)return ctx.edgeGraph;
 const result=[],gaps=[],{p,q,byId,bundles,raw}=ctx;
 const patches=sourcePatchEdges(ctx);result.push(...patches.edges);gaps.push(...patches.gaps);
 for(const report of ctx.returns){
  try{
   const prior=byId.get(report.reworkBaseBundleId||report.bundleId),next=byId.get(report.returnedBundleId),receipt=report.ownerReceipt;
   check(prior&&next&&receipt.success===true&&receipt.bundleId===next.id&&receipt.inputSha256===next.manifest.sha256,'ALIAS_OWNER_RECEIPT_BINDING');actorReceipt(ctx,receipt);
   const cf=textFile(q.store.root,receipt.comparisonRelative,ctx.readAudit);check(cf.sha256===receipt.comparisonSha256,'ALIAS_COMPARISON_HASH');const comparison=parse(cf);
   check(comparison.bundleId===next.id&&comparison.inputSha256===next.manifest.sha256&&comparison.pdfSha256===receipt.pdfSha256&&comparison.sourceSha256===p.source.sha256,'ALIAS_COMPARISON_BINDING');
   const ids=report.screening?.affectedSemanticIds||[report.semanticId];check(Array.isArray(ids)&&ids.length>0&&new Set(ids).size===ids.length,'ALIAS_DECLARED_SCOPE');
   if(receipt.affectedSemanticIds)check(hash(ids)===hash(receipt.affectedSemanticIds)&&hash(ids)===hash(comparison.affectedSemanticIds),'ALIAS_DECLARED_SCOPE');
   const pairs=ids.map(id=>({old:report.screening?.repairSpan&&id===report.semanticId?report.screening.repairSpan:one(prior.nodes.filter(n=>n.semanticId===id),'ALIAS_DECLARED_OLD_NODE').target,next:one(next.nodes.filter(n=>n.semanticId===id),'ALIAS_DECLARED_NEW_NODE').target}));
   check(pairs.every(x=>x.old?.file===p.main&&x.next?.file===p.main),'ALIAS_DECLARED_FILE');
   const after=raw(next),possible=[],attempts=[];
   for(const nested of [false,true]){
    let reversedInputSha256=null;
    try{
     const edits=pairs.map(pair=>{const exact=locate(after,pair.next);let range=exact;
      if(nested){const before=pair.old.before?after.indexOf(pair.old.before):0,tail=pair.old.after?after.indexOf(pair.old.after):after.length;check(before>=0&&tail>=0&&(!pair.old.before||before===after.lastIndexOf(pair.old.before))&&(!pair.old.after||tail===after.lastIndexOf(pair.old.after)),'ALIAS_OUTER_CONTEXT');range={start:before+pair.old.before.length,end:tail};check(range.start<=exact.start&&range.end>=exact.end,'ALIAS_OUTER_CONTEXT');}
      return {afterStart:range.start,afterEnd:range.end,replacement:pair.old.oldText,declaredAfterRange:exact,old:pair.old};
     }).sort((a,b)=>a.afterStart-b.afterStart);
     check(edits.every((e,i)=>!i||edits[i-1].afterEnd<=e.afterStart),'ALIAS_OVERLAPPING_EDITS');
     let before=after;for(const e of edits.toReversed())before=before.slice(0,e.afterStart)+e.replacement+before.slice(e.afterEnd);
     let delta=0;for(const e of edits){const r=locate(before,e.old);e.beforeStart=e.afterStart+delta;e.beforeEnd=e.beforeStart+e.replacement.length;check(r.start===e.beforeStart&&r.end===e.beforeEnd,'ALIAS_REVERSE_RANGE');delta+=e.replacement.length-(e.afterEnd-e.afterStart);}
     const files=next.manifest.files.map(f=>f.file===p.main?{...f,sha256:sha(before),size:Buffer.byteLength(before)}:f),beforeHash=hash(files);reversedInputSha256=beforeHash;
     const parents=bundles.filter(b=>b.manifest.sha256===beforeHash);check(parents.length&&beforeHash!==next.manifest.sha256,'ALIAS_REVERSE_PARENT_MISSING');
     // The complete reconstructed file is itself authenticated by each
     // parent's frozen manifest; a second retained raw snapshot is not needed.
     for(const b of parents)ctx.rememberRaw(b,before);
     const actual={beforeInputSha256:beforeHash,afterInputSha256:next.manifest.sha256,reversedInputSha256:beforeHash,reverseMatchesBefore:true,registeredScopeSha256:hash({ids,pairs}),declaredFragmentCount:ids.length,scope:report.screening?.repairSpan?'explicit_contiguous_repair_span':'declared_fragments'};
     // Full modern receipts constrain the exact declared pre-edit input. Legacy
     // partial scopes bind only the properties they actually recorded.
     for(const key of ['beforeInputSha256','afterInputSha256','reversedInputSha256','registeredScopeSha256','scope'])if(report.editScopeReceipt?.[key]!==undefined)check(report.editScopeReceipt[key]===actual[key],'ALIAS_REGISTERED_SCOPE_CHANGED');
     if(report.editScopeReceipt?.reverseMatchesBefore===true)check(!nested,'ALIAS_REGISTERED_SCOPE_CHANGED');
     const spans=edits.map(({beforeStart,beforeEnd,afterStart,afterEnd,declaredAfterRange})=>({beforeStart,beforeEnd,afterStart,afterEnd,declaredAfterRange}));
     possible.push({beforeInputSha256:beforeHash,afterInputSha256:next.manifest.sha256,spans,proof:seal({kind:'verified_owner_return_reverse_scope',paperId:ctx.paperId,reportId:report.id,priorBundleId:prior.id,returnedBundleId:next.id,...actual,reverseScope:nested?'prior_outer_context_containing_returned_fragment':'declared_returned_fragment',spans,reportReceipt:ref('owner-return-record',report),ownerReceipt:{id:report.id+':'+next.id,sha256:hash(receipt)},comparisonReceipt:{id:cf.relative,sha256:cf.sha256},beforeMainSha256:sha(before),afterMainSha256:sha(after),declaredPreEditInputSha256:report.screening?.candidateBinding?.currentInputSha256||prior.manifest.sha256,artifactBytesRevalidated:false,claim:'JSON/TeX identity and exact reverse edit scope only; no source pixel, PDF, build, fidelity, scientific or publication certification.'})});
    }catch(e){if(!e.technicalGap)throw e;attempts.push({nested,code:e.code,reversedInputSha256});}
   }
   const distinct=[...new Map(possible.map(e=>[hash({before:e.beforeInputSha256,spans:e.spans}),e])).values()];check(distinct.length===1,'ALIAS_REVERSE_SCOPE_UNRESOLVED',{candidateCount:distinct.length,attempts});result.push(distinct[0]);
  }catch(e){gaps.push({reportId:report.id,returnedBundleId:report.returnedBundleId,code:e.code||'ALIAS_EVIDENCE_READ_GAP',...(e.details?{details:e.details}:{})});}
 }
 const human=humanEdges(ctx);result.push(...human.edges);gaps.push(...human.gaps);
 const registered=dispositionEdges(ctx);result.push(...registered.edges,...lineEndingEdges(ctx));gaps.push(...registered.gaps);
 return ctx.edgeGraph={edges:[...new Map(result.map(e=>[e.proof.sha256,e])).values()],gaps};
}
function carry(range,edge,ctx){
 let shiftStart=0,shiftEnd=0;
 for(const e of edge.spans){
  const delta=(e.afterEnd-e.afterStart)-(e.beforeEnd-e.beforeStart);
  if(range.end<=e.beforeStart)continue;
  if(range.start>=e.beforeEnd){shiftStart+=delta;shiftEnd+=delta;continue;}
  if(ctx&&range.start>=e.beforeStart&&range.end<=e.beforeEnd&&(range.start!==e.beforeStart||range.end!==e.beforeEnd)){
   const before=ctx.bundles.find(b=>b.manifest.sha256===edge.beforeInputSha256),after=ctx.bundles.find(b=>b.manifest.sha256===edge.afterInputSha256),old=ctx.raw(before),next=ctx.raw(after),text=old.slice(range.start,range.end),at=next.indexOf(text);
   check(text.length>0&&old.indexOf(text)===range.start&&old.lastIndexOf(text)===range.start&&at>=e.afterStart&&at+text.length<=e.afterEnd&&next.lastIndexOf(text)===at,'ALIAS_FRAGMENT_PARTIAL_EDIT');
   // Preserve the whole exact fragment when a registered broader repair moves
   // it. Changed, duplicated, narrowed or guessed subfragments remain blocked.
   return {start:at,end:at+text.length};
  }
  check(range.start<=e.beforeStart&&range.end>=e.beforeEnd,'ALIAS_FRAGMENT_PARTIAL_EDIT');
  // An old registered outer target cannot be silently narrowed to a returned
  // inner target. Keep the complete transformed interval for final uniqueness.
  shiftEnd+=delta;
 }
 return {start:range.start+shiftStart,end:range.end+shiftEnd};
}
function preciseCompositeCarry(range,edge,ctx){
 try{return carry(range,edge,ctx);}catch(error){
  if(error.code!=='ALIAS_FRAGMENT_PARTIAL_EDIT')throw error;
  const before=ctx.raw(ctx.bundles.find(b=>b.manifest.sha256===edge.beforeInputSha256)),after=ctx.raw(ctx.bundles.find(b=>b.manifest.sha256===edge.afterInputSha256));
  const spans=edge.spans.map(e=>{const old=before.slice(e.beforeStart,e.beforeEnd),next=after.slice(e.afterStart,e.afterEnd);let prefix=0,suffix=0;while(prefix<Math.min(old.length,next.length)&&old[prefix]===next[prefix])prefix++;while(suffix<Math.min(old.length,next.length)-prefix&&old.at(-1-suffix)===next.at(-1-suffix))suffix++;return {...e,beforeStart:e.beforeStart+prefix,beforeEnd:e.beforeEnd-suffix,afterStart:e.afterStart+prefix,afterEnd:e.afterEnd-suffix};});
  return carry(range,{...edge,spans},ctx);
 }
}
function compositeInitialNode(ctx,b,range){
 const raw=ctx.raw(b),rows=b.nodes.map(n=>({n,...locate(raw,n.target)})).filter(n=>n.start<range.end&&n.end>range.start).sort((a,b)=>a.start-b.start);
 check(rows.length>1&&rows[0].start===range.start&&rows.at(-1).end===range.end&&rows.every((n,i)=>!i||rows[i-1].end===n.start),'ALIAS_INITIAL_COMPOSITE_COVERAGE');
 const first=b.nodes.findIndex(n=>n.nodeId===rows[0].n.nodeId);check(rows.every((r,i)=>b.nodes[first+i]?.nodeId===r.n.nodeId),'ALIAS_INITIAL_COMPOSITE_ORDER');
 const oldText=raw.slice(range.start,range.end),quote=rows.map(r=>r.n.quote).join('');check(rows.map(r=>r.n.target.oldText).join('')===oldText,'ALIAS_INITIAL_COMPOSITE_BYTES');
 const nodeId='joined-'+rows[0].n.nodeId+'-'+rows.at(-1).n.nodeId;
 return {nodeId,semanticId:nodeId,kind:'paragraph',quote,contentSha256:sha(quote),target:{file:ctx.p.main,anchorId:nodeId,oldText,oldSha256:sha(oldText),before:raw.slice(Math.max(0,range.start-120),range.start),after:raw.slice(range.end,range.end+120)},initialComposite:{kind:'complete_contiguous_initial_nodes',nodeIds:rows.map(r=>r.n.nodeId),rawRange:range,nodeHashes:rows.map(r=>hash(r.n))}};
}
function initialNode(ctx,b,nodeId){
 const existing=b.nodes.filter(n=>n.nodeId===nodeId);if(existing.length)return one(existing,'ALIAS_INITIAL_NODE_MISSING');
 const match=/^joined-([a-f0-9]{20})-([a-f0-9]{20})$/.exec(nodeId);check(match,'ALIAS_INITIAL_NODE_MISSING');const first=b.nodes.find(n=>n.nodeId===match[1]),last=b.nodes.find(n=>n.nodeId===match[2]);check(first&&last,'ALIAS_INITIAL_NODE_MISSING');const raw=ctx.raw(b),node=compositeInitialNode(ctx,b,{start:locate(raw,first.target).start,end:locate(raw,last.target).end});check(node.nodeId===nodeId,'ALIAS_INITIAL_COMPOSITE_ID');return node;
}
function reverseComposite(ctx,initial,target,node){
 const graph=edges(ctx),reverse=graph.edges.map(e=>({beforeInputSha256:e.afterInputSha256,afterInputSha256:e.beforeInputSha256,spans:e.spans.map(s=>({beforeStart:s.afterStart,beforeEnd:s.afterEnd,afterStart:s.beforeStart,afterEnd:s.beforeEnd}))})),{answers}=walkRangeLineage({startInput:target.manifest.sha256,endInput:initial.manifest.sha256,startRange:ctx.fragment(target,node).rawRange,edges:reverse,transform:(range,edge)=>preciseCompositeCarry(range,edge,ctx)});
 const ranges=[...new Map(answers.map(x=>[hash(x.range),x.range])).values()];check(ranges.length===1,'ALIAS_INITIAL_COMPOSITE_UNRESOLVED');return compositeInitialNode(ctx,initial,ranges[0]);
}
function mapped(ctx,initial,target,node,{rangeOnly=false}={}){
 const start=ctx.fragment(initial,node),endHash=target.manifest.sha256;
 if(initial.manifest.sha256===endHash){
  if(rangeOnly)return {range:start.rawRange,paths:[[]],gaps:[],mode:'same_manifest_exact_range'};
  if(node.initialComposite&&initial.id===target.id)return {node,range:start.rawRange,paths:[[]],gaps:[],mode:'same_manifest_complete_initial_composite'};
  const matches=ctx.nodesForExactTarget(target,node.target);
  const selected=one(matches,'ALIAS_EXACT_CONTEXT_AMBIGUOUS');ctx.fragment(target,selected);
  return {node:selected,range:start.rawRange,paths:[[]],gaps:[],mode:'same_manifest_exact_target_context'};
 }
 const graph=edges(ctx),{answers,gaps:dead}=walkRangeLineage({startInput:initial.manifest.sha256,endInput:endHash,startRange:start.rawRange,edges:graph.edges,transform:(range,edge)=>(node.initialComposite?preciseCompositeCarry:carry)(range,edge,ctx)});
 check(answers.length,'ALIAS_LINEAGE_UNRESOLVED',{evidenceGaps:graph.gaps,mappingGaps:[...new Set(dead)],fromInputSha256:initial.manifest.sha256,toInputSha256:endHash});
 const ranges=[...new Map(answers.map(x=>[hash(x.range),x.range])).values()];check(ranges.length===1,'ALIAS_LINEAGE_AMBIGUOUS');
 if(rangeOnly)return {range:ranges[0],paths:answers.map(a=>a.path),gaps:graph.gaps,mode:'verified_mechanical_range_lineage'};
 const matches=ctx.nodesAtRange(target,ranges[0]);
 const selected=one(matches,'ALIAS_TARGET_RANGE_UNRESOLVED');ctx.fragment(target,selected);
 return {node:selected,range:ranges[0],paths:answers.map(a=>a.path),gaps:graph.gaps,mode:answers.some(a=>a.path.some(e=>e.proof.record.kind==='verified_human_exact_application'))?'verified_mechanical_edit_lineage':'verified_owner_return_reverse_lineage'};
}
function output(ctx,h,initial,target,initialNode,m){
 const initialFragment=ctx.fragment(initial,initialNode).fragment,currentFragment=ctx.fragment(target,m.node).fragment;
 const evidence=seal({schemaVersion:1,kind:'fragment_alias_mapping',paperId:ctx.paperId,mode:m.mode,initialBundleId:initial.id,currentBundleId:target.id,initialNodeId:initialNode.nodeId,currentNodeId:m.node.nodeId,fromKey:fragmentAliasKey(initialFragment),toKey:fragmentAliasKey(currentFragment),beforeInputSha256:initial.manifest.sha256,afterInputSha256:target.manifest.sha256,initialTargetContextSha256:hash(initialNode.target),currentTargetContextSha256:hash(m.node.target),initialRawRange:ctx.fragment(initial,initialNode).rawRange,...(initialNode.initialComposite?{initialComposite:initialNode.initialComposite}:{}),currentRawRange:m.range,reverseMatchesBefore:true,candidateNodeIds:[m.node.nodeId],lineages:m.paths.map(p=>p.map(e=>e.proof)),freezeHistorySha256:h.freezeHistory.sha256,initialBundleReceipt:ctx.bundleReceipt(initial),currentBundleReceipt:ctx.bundleReceipt(target),unusedEvidenceGaps:m.gaps,artifactBytesRevalidated:false});
 return clone({initialBundle:initial,initialNode,currentBundle:target,currentNode:m.node,freezeHistory:h.freezeHistory,initialFragment,currentFragment,initialDocumentText:initial.public.document.text,aliasProof:evidence,sourceSeal:{sourceSha256:ctx.p.source.sha256,mappingSha256:ctx.p.mapping?.sha256||null},sealedReceipts:{freezeHistory:h.freezeHistory,alias:evidence},claim:'Initial whole-review identity and unique exact text-range alias only; no business decision, mathematical equivalence, artifact/build certification or routing transition.'});
}
function mapToBundle(q,{initialBundleId,initialNodeId,targetBundleId}){
 const b=q.blind.bundle(initialBundleId),ctx=open(q,b.paperId),h=history(ctx),initial=ctx.byId.get(initialBundleId),target=ctx.byId.get(targetBundleId);
 check(initial?.id===h.first.bundleId,'INITIAL_FRAGMENT_NOT_FIRST_DRAFT');check(target,'ALIAS_TARGET_BUNDLE_MISSING');
 const node=initialNode(ctx,initial,initialNodeId);
 return output(ctx,h,initial,target,node,mapped(ctx,initial,target,node));
}
function projectToBundle(q,{initialBundleId,initialNodeId,targetBundleId}){
 const b=q.blind.bundle(initialBundleId),ctx=open(q,b.paperId),h=history(ctx),initial=ctx.byId.get(initialBundleId),target=ctx.byId.get(targetBundleId);
 check(initial?.id===h.first.bundleId,'INITIAL_FRAGMENT_NOT_FIRST_DRAFT');check(target,'ALIAS_TARGET_BUNDLE_MISSING');const node=initialNode(ctx,initial,initialNodeId),m=mapped(ctx,initial,target,node,{rangeOnly:true}),text=ctx.raw(target);
 const matches=target.nodes.map(n=>({node:n,...locate(text,n.target)})).filter(n=>n.start<m.range.end&&n.end>m.range.start).sort((a,b)=>a.start-b.start);
 check(matches.length>0,'ALIAS_PROJECTED_RANGE_OMITTED');
 check(matches[0].start===m.range.start&&matches.at(-1).end===m.range.end&&matches.every((n,i)=>!i||matches[i-1].end===n.start),'ALIAS_PROJECTED_NODE_COVERAGE');
 const currentNodes=matches.map(x=>x.node),currentRawText=text.slice(m.range.start,m.range.end),currentText=currentNodes.map(n=>n.quote).join('');check(currentNodes.map(n=>n.target.oldText).join('')===currentRawText,'ALIAS_PROJECTED_RANGE_CHANGED');
 for(const n of currentNodes)ctx.fragment(target,n);
 const proof=seal({schemaVersion:1,kind:'exact_fragment_node_projection',paperId:ctx.paperId,initialBundleId,initialNodeId,targetBundleId,initialRawRange:ctx.fragment(initial,node).rawRange,currentRawRange:m.range,beforeInputSha256:initial.manifest.sha256,afterInputSha256:target.manifest.sha256,currentRawTextSha256:sha(currentRawText),currentTextSha256:sha(currentText),nodes:matches.map(n=>({nodeId:n.node.nodeId,targetSha256:hash(n.node.target),start:n.start,end:n.end})),lineages:m.paths.map(p=>p.map(e=>e.proof)),initialBundleReceipt:ctx.bundleReceipt(initial),targetBundleReceipt:ctx.bundleReceipt(target),freezeHistorySha256:h.freezeHistory.sha256,claim:'Exact existing-node coverage of one proven transformed range; no widening, narrowing, source judgment, new human decision or mathematical credit.'});
 return clone({initialBundle:initial,initialNode:node,currentBundle:target,currentNodes,currentRawText,currentText,currentRawRange:m.range,target:{file:ctx.p.main,anchorId:'projected-'+initialNodeId,oldText:currentRawText,oldSha256:sha(currentRawText),before:text.slice(Math.max(0,m.range.start-120),m.range.start),after:text.slice(m.range.end,m.range.end+120)},projectionProof:proof});
}
function resolveInitial(q,{paperId,bundleId,nodeId}){
 const ctx=open(q,paperId),h=history(ctx),initial=ctx.byId.get(h.first.bundleId),target=ctx.byId.get(bundleId);check(target,'ALIAS_TARGET_BUNDLE_MISSING');
 one(target.nodes.filter(n=>n.nodeId===nodeId),'ALIAS_CURRENT_NODE_MISSING');
 const candidates=[],gaps=[];
 // Nothing about ordinal IDs selects a candidate. Every initial exact range
 // is tested through the independently verified edit graph.
 for(const n of initial.nodes){try{const m=mapped(ctx,initial,target,n);if(m.node.nodeId===nodeId)candidates.push({n,m});}catch(e){if(!e.technicalGap)throw e;gaps.push(e.code);}}
 if(candidates.length===0)try{const n=reverseComposite(ctx,initial,target,target.nodes.find(n=>n.nodeId===nodeId)),m=mapped(ctx,initial,target,n);check(m.node.nodeId===nodeId,'ALIAS_INITIAL_COMPOSITE_ROUNDTRIP');candidates.push({n,m});}catch(e){if(!e.technicalGap)throw e;gaps.push(e.code);}
 check(candidates.length===1,'ALIAS_INITIAL_FRAGMENT_UNRESOLVED',{candidateCount:candidates.length,gaps:[...new Set(gaps)],evidenceGaps:ctx.edgeGraph?.gaps||[],...(ctx.edgeGraph?{verifiedEdges:ctx.edgeGraph.edges.map(e=>({reportId:e.proof.record.reportId,fromInputSha256:e.beforeInputSha256,toInputSha256:e.afterInputSha256}))}:{})});
 return output(ctx,h,initial,target,candidates[0].n,candidates[0].m);
}
function bindProof(result,{scope,stableFragmentId}){
 const p=result.aliasProof;check(p?.sha256===hash(p.record)&&p.record.fromKey===fragmentAliasKey(result.initialFragment)&&p.record.toKey===fragmentAliasKey(result.currentFragment)&&p.record.freezeHistorySha256===result.freezeHistory.sha256,'ALIAS_RESULT_HASH');
 const ledger=createFragmentLedger({scope,freezeHistory:result.freezeHistory,initialFragment:result.initialFragment,initialDocumentText:result.initialDocumentText});
 check(ledger.stableFragmentId===stableFragmentId,'ALIAS_STABLE_IDENTITY');
 return seal({kind:'mechanical_edit_lineage',fromKey:p.record.fromKey,toKey:p.record.toKey,candidateKeys:[p.record.toKey],candidateStableFragmentIds:[stableFragmentId],beforeInputSha256:result.initialFragment.inputSha256,afterInputSha256:result.currentFragment.inputSha256,reverseMatchesBefore:true,originalEvidence:{id:'fragment-alias:'+p.sha256,sha256:p.sha256},method:p.record.mode});
}
function technical(operation){try{return operation();}catch(e){if(e.technicalGap)throw e;check(false,'ALIAS_EVIDENCE_READ_GAP',{causeCode:e.code||e.name||'unknown'});}}
export const resolveInitialFragment=(q,identity)=>technical(()=>resolveInitial(q,identity));
// Supply authenticated text for the source role to locate a missing passage.
// This does not infer a correspondence, install an alias or inspect source pixels.
export const initialCorrespondenceContext=(q,{paperId,bundleId,nodeId})=>technical(()=>{
 const ctx=open(q,paperId),h=history(ctx),initial=ctx.byId.get(h.first.bundleId),current=ctx.byId.get(bundleId);check(current,'ALIAS_TARGET_BUNDLE_MISSING');const node=one(current.nodes.filter(n=>n.nodeId===nodeId),'ALIAS_CURRENT_NODE_MISSING');
 const initialRaw=ctx.raw(initial),currentRaw=ctx.raw(current),currentRange=locate(currentRaw,node.target);let neutralStart=0;
 const initialNodes=initial.nodes.map(n=>{const rawRange=locate(initialRaw,n.target),row={nodeId:n.nodeId,semanticId:n.semanticId,rawRange,neutralRange:{start:neutralStart,end:neutralStart+n.quote.length},raw:n.target.oldText,tex:n.quote};neutralStart+=n.quote.length;return row;});
 return {paperId,sourceSeal:{sourceSha256:ctx.p.source.sha256,mappingSha256:ctx.p.mapping?.sha256||null},initialBundleId:initial.id,initialInputSha256:initial.manifest.sha256,initialDocumentSha256:initial.public.document.sha256,initialRaw,initialText:initial.public.document.text,initialNodes,currentBundleId:current.id,currentInputSha256:current.manifest.sha256,currentNode:clone(node),currentRawRange:currentRange,freezeHistory:h.freezeHistory,initialBundleReceipt:ctx.bundleReceipt(initial),currentBundleReceipt:ctx.bundleReceipt(current),scope:'Authenticated frozen text and first-review identity only. A source role must supply the missing exact same-passage correspondence; no inferred mapping or scientific judgment.'};
});
export const mapFragmentToBundle=(q,identity)=>technical(()=>mapToBundle(q,identity));
export const projectFragmentToBundle=(q,identity)=>technical(()=>projectToBundle(q,identity));
export const bindAliasProof=(result,identity)=>technical(()=>bindProof(result,identity));

// A coherent read-only synchronous batch, never a cache across plan ticks.
// Every actually read JSON/TeX file is re-opened and hashed before returning.
function capture(q){return clone({config:q.store.config,root:q.store.root,fixture:q.store.fixture===true,caseIds:caseNames(q.store.root),sourceAssignments:sourceAssignments(q),blindRoot:q.blind.root,bundles:q.blind.all('bundles'),reports:q.blind.all('reports'),jobs:q.jobs(),freezes:q.all('freezes')});}
function projection(snapshot,used){const ordered=xs=>xs.toSorted((a,b)=>String(a.id).localeCompare(String(b.id)));return {papers:Object.fromEntries([...used].sort().map(id=>[id,snapshot.config.papers[id]])),root:snapshot.root,fixture:snapshot.fixture,caseIds:snapshot.caseIds,sourceAssignments:ordered(snapshot.sourceAssignments.filter(a=>used.has(a.paperId)).map(a=>({id:a.id,paperId:a.paperId,reportId:a.reportId,attempts:(a.attempts||[]).map(t=>({id:t.id,runRoot:t.runRoot}))}))),blindRoot:snapshot.blindRoot,bundles:ordered(snapshot.bundles.filter(x=>used.has(x.paperId))),reports:ordered(snapshot.reports.filter(x=>used.has(x.paperId))),reviewJobs:ordered(snapshot.jobs.filter(x=>used.has(x.paperId)&&x.kind==='review')),freezes:ordered(snapshot.freezes.filter(x=>used.has(x.paperId)))};}
export const withFragmentAliasContext=(q,callback)=>technical(()=>{
 check(typeof callback==='function','ALIAS_CONTEXT_CALLBACK_REQUIRED');const initial=capture(q),state={active:true,used:new Set(),contexts:new Map(),files:new Map(),assignments:initial.sourceAssignments,caseIds:initial.caseIds};
 const local={store:{root:initial.root,config:initial.config,fixture:initial.fixture},blind:{root:initial.blindRoot,all:type=>type==='bundles'?initial.bundles:initial.reports,bundle:id=>initial.bundles.find(b=>b.id===id)},jobs:()=>initial.jobs,all:type=>type==='freezes'?initial.freezes:initial.jobs};
 synchronousContexts.set(local,state);
 const guarded=fn=>identity=>{check(state.active,'ALIAS_CONTEXT_CLOSED');return fn(local,identity);};
 try{
  const value=callback({resolveInitialFragment:guarded(resolveInitialFragment),mapFragmentToBundle:guarded(mapFragmentToBundle),projectFragmentToBundle:guarded(projectFragmentToBundle)});
  check(!value||typeof value.then!=='function','ALIAS_CONTEXT_ASYNC_FORBIDDEN');
  const final=capture(q);check(hash(projection(initial,state.used))===hash(projection(final,state.used)),'ALIAS_CONTEXT_RECORDS_CHANGED');
  for(const entry of state.files.values())check(evidenceFile(entry.root,entry.relative,null,{resultPdf:entry.resultPdf}).sha256===entry.sha256,'ALIAS_CONTEXT_INPUT_CHANGED');
  return value;
 }finally{state.active=false;synchronousContexts.delete(local);}
});
export const resolveFragmentAliases=(q,requests)=>withFragmentAliasContext(q,api=>{
 check(Array.isArray(requests),'ALIAS_CONTEXT_REQUESTS_REQUIRED');return requests.map((request,index)=>{
  check(request&&['resolve','map','project'].includes(request.kind),'ALIAS_CONTEXT_REQUEST_KIND');
  try{return {index,kind:request.kind,ok:true,result:(request.kind==='resolve'?api.resolveInitialFragment:request.kind==='project'?api.projectFragmentToBundle:api.mapFragmentToBundle)(request.identity)};}
  catch(e){if(!e.technicalGap)throw e;return {index,kind:request.kind,ok:false,error:{code:e.code,technicalGap:true,details:e.details||null}};}
 });
});
