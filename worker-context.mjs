// CLI presentation only. Server input, stable business identities, operation
// payloads and persisted receipts remain unchanged. This module is standalone so
// the blind workspace receives no server-side or source-access dependencies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CONTEXT_FORMAT='worker-context-v1';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const json=x=>JSON.stringify(x,null,2)+'\n';
const digest=x=>sha(JSON.stringify(x));
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const required=(ok,code='CONTEXT_INPUT_INVALID')=>{if(!ok)throw Object.assign(new Error(code),{code});};
const at=(value,parts)=>parts.reduce((x,k)=>{required(x!==null&&typeof x==='object'&&Object.hasOwn(x,k),'CONTEXT_FIELD_MISSING');return x[k];},value);
const continuityPaths=(value,role)=>[
 ...(Object.hasOwn(value,'reviewContinuity')?[['reviewContinuity']]:[]),
 ...(role==='source'&&object(value.packet)&&Object.hasOwn(value.packet,'reviewContinuity')?[['packet','reviewContinuity']]:[])
];
export const reviewContinuityGuidance='When the supplied reviewContinuity record identifies incremental review, retain its explicitly valid passed checks and review only cumulative changes, affected conclusions and unresolved work. Fetch full definitions/context as needed; contextual reading does not authorize rechecking unrelated retained passes. Preserve applicable decisions and exact evidence references. A new attempt, whole-file hash, numbering or presentation alone cannot reset review. Do not convert unresolved, unexamined, unsupported or technical failures into passes. If impact cannot be bounded, preserve the concrete dependency gap. This view does not judge dependencies, merge coverage, create new check receipts or certify completion; the business workflow supplies and validates those records.';

function validateBundle(b,humanScope=null){
 required(object(b)&&typeof b.bundleId==='string'&&object(b.document)&&Array.isArray(b.nodes));
 const projected=object(humanScope)&&humanScope.schemaVersion===1&&Array.isArray(humanScope.excludedFromReview)&&humanScope.excludedFromReview.length>0;
 required(typeof b.document.text==='string'&&/^[a-f0-9]{64}$/.test(b.document.sha256||'')&&sha(b.document.text)===(projected?b.document.viewSha256:b.document.sha256),'CONTEXT_DOCUMENT_HASH');
 for(const n of b.nodes){
  const scope=projected&&humanScope.excludedFromReview.find(x=>x.nodeId===n.nodeId);
  if(n.withheld===true){required(scope&&scope.wholeNode!==false&&typeof n.nodeId==='string'&&/^[a-f0-9]{64}$/.test(n.recordSha256||'')&&!Object.hasOwn(n,'quote'),'CONTEXT_HUMAN_SCOPE');continue;}
  required(typeof n.nodeId==='string'&&typeof n.quote==='string'&&/^[a-f0-9]{64}$/.test(n.contentSha256||'')&&sha(n.quote)===(projected?n.viewSha256:n.contentSha256),'CONTEXT_NODE_HASH');
 }
}

function validateInput(value,role){
 required(object(value)&&!Object.hasOwn(value,'context')&&['source','blind'].includes(role));
 for(const parts of continuityPaths(value,role)){const record=at(value,parts);required(record===null||object(record),'CONTEXT_CONTINUITY_INVALID');}
 if(role==='blind'){
  validateBundle(value.bundle||value,value.fragmentHumanScope);
  required(object(value.execution)&&typeof value.execution.assignmentId==='string'&&typeof value.execution.attemptId==='string');
  required(object(value.recovery)&&Array.isArray(value.recovery.operations)&&Array.isArray(value.recovery.retained));
 }else{
  const p=value.packet;
  required(object(value.assignment)&&object(value.actor)&&object(p));
  required(value.assignment.id===p.assignmentId&&value.actor.assignmentId===p.assignmentId&&value.actor.paperId===p.paperId,'CONTEXT_IDENTITY');
  required(typeof value.actor.attemptId==='string'&&typeof value.actor.threadId==='string');
  required(value.assignment.paperId===p.paperId&&value.assignment.activeAttemptId===value.actor.attemptId,'CONTEXT_IDENTITY');
  required(object(p.manifest)&&/^[a-f0-9]{64}$/.test(p.manifest.sha256||'')&&object(p.source)&&/^[a-f0-9]{64}$/.test(p.source.sha256||''));
  for(const key of ['report','decision','confirmedReadings','applicableRulings','dispositionBindings','bundles'])required(Object.hasOwn(p,key),'CONTEXT_FIELD_MISSING');
  required(Array.isArray(p.bundles)&&Array.isArray(p.applicableRulings)&&Array.isArray(p.dispositionBindings));
  for(const b of p.bundles){
   validateBundle(b.public);required(b.id===b.public.bundleId&&Array.isArray(b.nodes),'CONTEXT_FIELD_MISSING');
   for(const n of b.nodes)required(typeof n.semanticId==='string'&&typeof n.quote==='string'&&object(n.target)&&typeof n.target.oldText==='string','CONTEXT_FIELD_MISSING');
  }
 }
}

// Refuse linked/traversing snapshot locations. The only permitted resource is an
// immutable JSON snapshot generated under this particular session directory.
function snapshotPath(root,relative){
 required(/^context\/[a-f0-9]{64}\.json$/.test(relative||''),'CONTEXT_PATH');
 const base=path.resolve(root),dir=path.join(base,'context'),file=path.join(base,...relative.split('/'));
 for(let current=base;;current=path.dirname(current)){
  required(!fs.lstatSync(current).isSymbolicLink(),'CONTEXT_PATH');
  if(path.dirname(current)===current)break;
 }
 for(const current of [dir,file])if(fs.existsSync(current))required(!fs.lstatSync(current).isSymbolicLink(),'CONTEXT_PATH');
 return file;
}

export function compactWorkerInput(value,{root,role}){
 // Round-trip the same JSON boundary as the HTTP client before making a view.
 const original=JSON.parse(JSON.stringify(value));validateInput(original,role);
 const output=structuredClone(original),bytes=json(original),snapshotSha256=sha(bytes),relative='context/'+snapshotSha256+'.json';
 const snapshot=snapshotPath(root,relative);fs.mkdirSync(path.dirname(snapshot),{recursive:true});
 if(fs.existsSync(snapshot))required(sha(fs.readFileSync(snapshot))===snapshotSha256,'CONTEXT_SNAPSHOT_HASH');
 else fs.writeFileSync(snapshot,bytes,{flag:'wx'});
 const refs={};let count=0;
 const defer=(parts,{summary,mandatory=false}={})=>{
  const value=at(original,parts),parent=at(output,parts.slice(0,-1)),key=parts.at(-1),ref='r'+(++count);
  refs[ref]={path:parts,sha256:digest(value),bytes:Buffer.byteLength(JSON.stringify(value)),...(mandatory?{requiredBeforeCompletion:true}:{})};
  parent[key]={$contextRef:ref,...(summary===undefined?{}:{summary})};
 };
 const long=(parts)=>{const value=at(original,parts);if(typeof value==='string'&&Buffer.byteLength(value)>512)defer(parts);};
 if(role==='blind'){
  const base=original.bundle?['bundle']:[],bundle=at(original,base);
  for(let i=0;i<bundle.nodes.length;i++){
   const n=bundle.nodes[i];
   // Keep every whole-document character inline. Only exact duplicate quotes
   // become references; unusual non-substring quotes stay directly visible.
   if(typeof n.quote==='string'&&bundle.document.text.includes(n.quote))long([...base,'nodes',i,'quote']);
  }
  for(const key of ['inventory','mathInventory'])if(original[key]){
   const x=original[key];
   defer([key],{mandatory:true,summary:{id:x.id,assignmentId:x.assignmentId,bundleId:x.bundleId,revision:x.revision,complete:x.complete,gaps:x.gaps,nodeCount:x.nodes?.length,itemCount:x.items?.length,spanCount:x.spans?.length}});
  }
  if(Array.isArray(original.existingEvidence))for(let i=0;i<original.existingEvidence.length;i++){
   const e=original.existingEvidence[i],r=e.report||{};
   const {quote,focusQuote,...report}=r;
   defer(['existingEvidence',i],{mandatory:true,summary:{report,bundleId:e.bundleId,documentSha256:e.documentSha256,technicalGap:e.technicalGap,sourceReadingClosed:e.sourceReadingClosed,scope:e.scope}});
  }
 }else{
  const p=original.packet,active=new Set([p.report?.semanticId,...(p.report?.screening?.affectedSemanticIds||[]),...(p.report?.ownerDisposition?.payload?.affectedSemanticIds||[])].filter(Boolean));
  for(let i=0;i<p.bundles.length;i++){
   const b=p.bundles[i],base=['packet','bundles',i];
   defer([...base,'public','document','text']);
   for(let j=0;j<b.public.nodes.length;j++)long([...base,'public','nodes',j,'quote']);
   for(let j=0;j<(b.nodes||[]).length;j++)if(!active.has(b.nodes[j].semanticId)){
    if(Object.hasOwn(b.nodes[j],'quote'))long([...base,'nodes',j,'quote']);
    if(b.nodes[j].target&&Object.hasOwn(b.nodes[j].target,'oldText'))long([...base,'nodes',j,'target','oldText']);
   }
  }
 }
 output.context={format:CONTEXT_FORMAT,role,snapshot:{path:relative,sha256:snapshotSha256},refs,
  read:'node context-read.mjs input.json <ref-id> [--out=<local-file>]',
  full:'node context-read.mjs input.json --full [--out=<local-file>]',
  scope:'Presentation only. Resolve exact quotes before submitting payloads; a reference is never a quote. Read every requiredBeforeCompletion history record before inventory/signoff, reuse valid evidence, retain unknown deliveries and all applicable review scope. Full restores the exact original input. Never treat summaries as evidence or full coverage.'};
 const records=continuityPaths(original,role).map(parts=>({path:parts,sha256:digest(at(original,parts))}));
 if(records.length)output.context.reviewContinuity={records,read:'node context-read.mjs input.json --continuity',display:'The original reviewContinuity field stays fully visible and unchanged; missing fields are not empty sets and null is not a new initial-review instruction.',guidance:reviewContinuityGuidance};
 return output;
}

export function readWorkerContext(input,{root,ref,full=false}){
 const c=input?.context;required(c?.format===CONTEXT_FORMAT&&object(c.snapshot)&&object(c.refs),'CONTEXT_FORMAT');
 const file=snapshotPath(root,c.snapshot.path),bytes=fs.readFileSync(file);
 required(sha(bytes)===c.snapshot.sha256&&path.basename(file)===c.snapshot.sha256+'.json','CONTEXT_SNAPSHOT_HASH');
 const original=JSON.parse(bytes.toString('utf8'));validateInput(original,c.role);
 if(ref==='--continuity'){
  const expected=continuityPaths(original,c.role),display=c.reviewContinuity;
  required(expected.length&&object(display)&&Array.isArray(display.records)&&display.records.length===expected.length,'CONTEXT_CONTINUITY_MISSING');
  return expected.map((parts,i)=>{
   const record=at(original,parts),binding=display.records[i];
   required(object(binding)&&JSON.stringify(binding.path)===JSON.stringify(parts)&&binding.sha256===digest(record)&&digest(at(input,parts))===binding.sha256,'CONTEXT_CONTINUITY_HASH');
   return {path:parts,record};
  });
 }
 if(full)return original;
 required(typeof ref==='string'&&Object.hasOwn(c.refs,ref),'CONTEXT_REF_MISSING');
 const entry=c.refs[ref];required(object(entry)&&Array.isArray(entry.path),'CONTEXT_REF_INVALID');
 const value=at(original,entry.path);
 required(digest(value)===entry.sha256&&Buffer.byteLength(JSON.stringify(value))===entry.bytes,'CONTEXT_VALUE_HASH');
 // Bind the requested reference back to the actual compact-view field.
 required(at(input,entry.path)?.$contextRef===ref,'CONTEXT_REF_INVALID');
 return value;
}
