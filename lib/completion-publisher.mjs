import fs from 'node:fs';
import path from 'node:path';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {check,readJSON,writeJSON,hashFile,hashObject,immutableWrite,now,inside} from './io.mjs';
import {inputManifest,snapshotInputs,verifyManifest,verifyAuthority} from './inputs.mjs';
import {ownerEngine} from './blind-bridge.mjs';
import {compile} from './build.mjs';
import {maintenancePaused} from './cli-pool-settings.mjs';
import {WorkflowPromotion} from '../paper_library/promotion.mjs';

export class CompletionPublisher {
 constructor(q,owners,settings,{auto=true,compiler=compile}={}){
  this.q=q;this.owners=owners;this.settings=settings;this.auto=auto;this.compiler=compiler;
  this.enabled=!!settings?.enabled;this.busy=false;this.stopped=false;
  this.root=path.join(q.store.root,'completion-publication');
  if(!this.enabled)return;
  this.prepareRoot=path.join(q.store.config.project,'review_desk/work/publication');
  this.authority=settings.authority;check(hashFile(this.authority.path)===this.authority.sha256,'Publication authority changed',409,'PROMOTION_AUTHORITY');
  const auth=readJSON(this.authority.path);this.paperIds=[...auth.existingBatchPaperIds,...auth.additionalReviewPaperIds];
  this.workflow=new WorkflowPromotion({projectRoot:q.store.config.project,journalRoot:path.join(this.root,'journals'),authority:this.authority,gate:id=>owners.gate(id),release:(id,version)=>owners.release(id,version),prepare:(id,gate)=>this.prepare(id,gate)});
 }
 statusFile(id){return path.join(this.root,'status',id+'.json');}
 summary(){return {enabled:this.enabled,busy:this.busy,automaticModelPolling:false,papers:this.enabled?this.paperIds.map(id=>fs.existsSync(this.statusFile(id))?readJSON(this.statusFile(id)):{paperId:id,status:'not_checked'}):[]};}
 lineage(paperId,gate){
  const b=this.q.blind,refs=[];
  const add=(kind,value)=>{const relative=kind+'/'+value.id+'.json';const root=['coverage','math-coverage'].includes(kind)?this.q.root:b.root;const file=path.join(root,relative);if(fs.existsSync(file))refs.push({kind,id:value.id,path:file,sha256:hashFile(file),record:value});};
  for(const c of this.q.all('coverage').filter(c=>b.bundle(c.bundleId).paperId===paperId))add('coverage',c);
  for(const x of this.q.mathCoverage.all().filter(x=>x.paperId===paperId))add('math-coverage',x);
  for(const kind of ['reports','rulings','checks'])for(const x of b.all(kind).filter(x=>x.paperId===paperId||x.reportId&&b.report(x.reportId).paperId===paperId))add(kind,x);
  const human=this.q.humanRouting?.publicationLineage(paperId);
  return {schemaVersion:1,paperId,versionId:gate.versionId,gate,records:refs,...(human?{fragmentHuman:human}:{}),claimBoundary:'Existing exact review and human-decision evidence. Tool agreement is not source science validation.'};
 }
 async prepare(paperId,gate){
  const p=this.q.store.config.papers[paperId];verifyAuthority(p);
  const manifest=inputManifest(path.join(p.root,'outputs'),p.main);
  check(manifest.sha256===gate.version.inputSha256,'Current candidate changed',409,'PROMOTION_INPUT_CHANGED');
  const root=inside(this.prepareRoot,path.join(this.prepareRoot,paperId,gate.versionId.slice(0,16))),saved=path.join(root,'prepared.json');
  if(fs.existsSync(saved)){const value=readJSON(saved);this.workflow.validatePrepared(value,gate);return value;}
  const inputs=path.join(root,'inputs');snapshotInputs(path.join(p.root,'outputs'),inputs,manifest);
  const {engine}=ownerEngine(this.q.store.root,p);
  const currentPdf=path.join(p.root,'outputs',p.main.replace(/\.tex$/,'.pdf')),prior=path.join(p.root,'outputs/build-receipt.json');
  let build=null,pdf=null;
  if(fs.existsSync(prior)){
   const r=readJSON(prior),files=r.inputs?.files?.map(f=>({file:(f.path||f.file||'').replace(/^outputs[\\/]/,''),sha256:f.sha256,size:f.size})).sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
   if(files&&hashObject(files)===manifest.sha256&&r.command?.exitCode===0&&r.output?.sha256===hashFile(currentPdf)&&r.log?.path&&hashFile(path.resolve(p.root,r.log.path))===r.log.sha256){
    pdf=path.join(root,'rendered.pdf');immutableWrite(pdf,fs.readFileSync(currentPdf));
    build={schemaVersion:1,success:true,inputSha256:manifest.sha256,pdfSha256:hashFile(pdf),engine,kind:'verified_existing_current_build',receipt:{path:prior,sha256:hashFile(prior)},originalReceipt:r,logSha256:r.log.sha256};
   }
  }
  if(!build){
   const buildRoot=path.join(root,'build'),receiptFile=path.join(buildRoot,'receipt.json');
   let r=fs.existsSync(receiptFile)?readJSON(receiptFile):null;
   if(!r?.success||r.inputSha256!==manifest.sha256||!fs.existsSync(r.pdf)||hashFile(r.pdf)!==r.pdfSha256)r=await this.compiler(this.q.store.config,p,{inputs,build:buildRoot,main:p.main,manifest,engine});
   check(r.success&&r.inputSha256===manifest.sha256&&hashFile(r.pdf)===r.pdfSha256,'Isolated unchanged-input build failed',409,'PROMOTION_BUILD_GAP');
   pdf=r.pdf;build={...r,kind:'isolated_exact_input_rebuild',receipt:{path:receiptFile,sha256:hashFile(receiptFile)},canonicalFilesChanged:false};
  }
  verifyManifest(inputs,manifest);
  check(inputManifest(path.join(p.root,'outputs'),p.main).sha256===manifest.sha256,'Candidate changed during publication preparation',409,'PROMOTION_INPUT_CHANGED');
  const originalMap=path.join(p.root,'outputs/source-map.json'),mapping=path.join(root,'source-map.json');
  check(fs.existsSync(originalMap),'Source mapping missing',409,'PROMOTION_MAPPING_GAP');immutableWrite(mapping,fs.readFileSync(originalMap));
  const value={paperId,inputsRoot:inputs,main:p.main,manifest,pdf,build,source:p.source,mapping,lineage:this.lineage(paperId,gate),extraFiles:[]};
  // Preserve useful comparison/layout records with their honest historical binding.
  const outputs=path.join(p.root,'outputs');
  const attachments=fs.readdirSync(outputs).filter(name=>['layout.json','confidence-events.json','review-notes.md','review-index.html'].includes(name)||/review-comparison\.pdf$/.test(name));
  for(const name of attachments){const f=path.join(outputs,name),target=path.join(root,'attachments',name);immutableWrite(target,fs.readFileSync(f));value.extraFiles.push({name,path:target});}
  const assets=path.join(outputs,'assets');if(fs.existsSync(assets))for(const name of fs.readdirSync(assets).filter(n=>/\.(vsdx|svg)$/i.test(n))){const target=path.join(root,'attachments','editable-'+name);immutableWrite(target,fs.readFileSync(path.join(assets,name)));value.extraFiles.push({name:'editable-'+name,path:target});}
  this.workflow.validatePrepared(value,gate);writeJSON(saved,value);return value;
 }
 async publish(paperId){
  check(this.enabled&&this.paperIds.includes(paperId),'Publication not enabled for this paper',403);
  // Hold both exact paper registries. No source writer or reviewer can be
  // admitted while the version is copied, released, and made the default.
  const pools=[this.q.sources,this.q.blindExecutors].filter(x=>x?.enabled);
  const guarded=async i=>i===pools.length?this.workflow.run(paperId):pools[i].registry.guard(paperId,state=>{check(!state.holder,'Paper execution still registered',409,'PAPER_WRITER_ACTIVE');return guarded(i+1);});
  return guarded(0);
 }
 async drain(){
  if(!this.enabled||this.busy||this.stopped||maintenancePaused(this.q.store.root))return;
  this.busy=true;this.pending=false;
  try{for(const paperId of this.paperIds){
   await yieldIO();await this.q.blindExecutors?.math?.registrationWindow?.wait();
   if(this.stopped||maintenancePaused(this.q.store.root))break;
   let state;
   try{const human=this.q.humanRouting?.status(paperId);
    // A retained blocker can only defer publication. An eligible candidate
    // always passes the complete fresh gate below and again inside publish.
    if(human?.gaps.length){state={paperId,status:'waiting_for_signoff',gaps:human.gaps,blockedBy:'fragment_human_workflow',fullGateDeferred:true};}
    else{const gate=this.owners.gate(paperId);
    if(!gate.ready)state={paperId,status:'waiting_for_signoff',versionId:gate.versionId,gaps:gate.gaps};
    else{const r=await this.publish(paperId);state={paperId,status:r.status,versionId:r.versionId,promotionId:r.id,edition:r.edition,mode:r.mode,certification:r.certification||null,completedAt:r.completedAt};}
    }
   }catch(e){state={paperId,status:'publication_gap',code:e.code||'PUBLICATION_FAILED',problem:e.message};}
   const file=this.statusFile(paperId),old=fs.existsSync(file)?readJSON(file):null;
   if(hashObject(state)!==hashObject(old?Object.fromEntries(Object.entries(old).filter(([k])=>k!=='at')):null))writeJSON(file,{...state,at:now()});
  }}finally{this.busy=false;if(this.pending)this.kick();}
 }
 kick(ms=100){if(!this.enabled||!this.auto||this.stopped)return;if(this.busy){this.pending=true;return;}clearTimeout(this.timer);this.timer=setTimeout(()=>this.drain(),ms);this.timer.unref();}
 stop(){this.stopped=true;clearTimeout(this.timer);}
}
