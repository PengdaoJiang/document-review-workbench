import fs from 'node:fs';
import path from 'node:path';
import {check,inside,readJSON,writeJSON,immutableWrite,hashFile,hashObject,now,acquireLock} from '../lib/io.mjs';
import {getApprovedEdition} from './library.mjs';

const pidPattern=/^(?:origin|r\d{4})$/;
const inputName=/\.(tex|cls|sty|clo|def|cfg|fd|bib|bbl|bst|png|jpe?g|pdf|eps|otf|ttf|pfb|tfm|map)$/i;
const ref=(file,relative)=>({path:relative,sha256:hashFile(file)});
export class WorkflowPromotion {
 constructor({projectRoot,journalRoot,authority,gate,release,prepare,fault=()=>{}}){
  this.projectRoot=path.resolve(projectRoot);this.library=path.join(this.projectRoot,'paper_library');
  this.journalRoot=path.resolve(journalRoot);this.authority=authority;this.gate=gate;this.release=release;this.prepare=prepare;this.fault=fault;
  inside(this.projectRoot,this.journalRoot);fs.mkdirSync(this.journalRoot,{recursive:true});
 }
 authorized(paperId){
  check(pidPattern.test(paperId)&&hashFile(this.authority.path)===this.authority.sha256,'Exact promotion authority required',409,'PROMOTION_AUTHORITY');
  const auth=readJSON(this.authority.path);check(auth.permissions?.automaticImmutableLibraryPromotion&&auth.permissions?.automaticCurrentVersionSignoffAndRelease&&[...auth.existingBatchPaperIds,...auth.additionalReviewPaperIds].includes(paperId),'Paper outside automatic promotion scope',403,'PROMOTION_SCOPE');return auth;
 }
 journal(key){return path.join(this.journalRoot,key+'.json');}
 save(j){j.updatedAt=now();writeJSON(this.journal(j.id),j);return j;}
 assertGate(paperId,versionId){const g=this.gate(paperId);check(g.ready&&g.versionId===versionId&&hashObject(g.version)===versionId,'Current version/activity signoff gate changed',409,'PROMOTION_SIGNOFF_GAP');return g;}
 validatePrepared(p,gate){
  check(p.paperId===gate.paperId&&p.manifest.sha256===gate.version.inputSha256&&hashObject(p.manifest.files)===p.manifest.sha256,'Prepared inputs differ from signed-off version',409,'PROMOTION_INPUT_CHANGED');
  for(const f of p.manifest.files){const file=inside(p.inputsRoot,path.join(p.inputsRoot,f.file));check(hashFile(file)===f.sha256&&fs.statSync(file).size===f.size,'Prepared dependency changed',409,'PROMOTION_INPUT_CHANGED');}
  check(p.manifest.files.some(f=>f.file===p.main)&&p.main.endsWith('.tex'),'Complete main TeX required',409,'PROMOTION_INPUT_CHANGED');
  check(p.build.success===true&&p.build.inputSha256===p.manifest.sha256&&hashFile(p.pdf)===p.build.pdfSha256,'Actual current input/PDF build receipt required',409,'PROMOTION_BUILD_GAP');
  check(hashFile(p.source.path)===p.source.sha256,'Original source seal changed',409,'PROMOTION_SOURCE_CHANGED');
  check(fs.statSync(p.mapping).isFile(),'Retained source mapping required',409,'PROMOTION_MAPPING_GAP');
 }
 sameAcceptedInputs(p,edition){
  if(!edition||edition.record.source.sha256!==p.source.sha256)return false;
  const inputs=[edition.latex,...edition.assets,...(edition.dependencies||[])].filter(f=>inputName.test(f.relative)&&(!f.relative.endsWith('.pdf')||f.relative.startsWith('assets/'))).map(f=>({file:f.relative,sha256:f.sha256,size:fs.statSync(f.path).size})).sort((a,b)=>a.file.localeCompare(b.file));
  return hashObject(inputs)===hashObject([...p.manifest.files].sort((a,b)=>a.file.localeCompare(b.file)));
 }
 async run(paperId){
  this.authorized(paperId);const first=this.gate(paperId);check(first.ready,'Paper is not ready: '+first.gaps.join('; '),409,'PROMOTION_SIGNOFF_GAP');
  const key=hashObject({paperId,versionId:first.versionId}).slice(0,32),file=this.journal(key);
  let j=fs.existsSync(file)?readJSON(file):{schemaVersion:1,id:key,paperId,versionId:first.versionId,status:'preparing',startedAt:now(),events:[],authority:this.authority};
  check(j.paperId===paperId&&j.versionId===first.versionId,'Promotion journal identity differs',409,'PROMOTION_CONFLICT');
  if(j.status==='complete'){
   const edition=getApprovedEdition(this.projectRoot,paperId,{version:j.edition});check(edition.recordSha256===j.editionSha256,'Completed edition changed',409,'PROMOTION_INTEGRITY');
   if(j.certification)check(hashFile(path.join(this.library,j.certification.path))===j.certification.sha256,'Completed certification changed',409,'PROMOTION_INTEGRITY');return {...j,reused:true};
  }
  this.save(j);
  try{
   const p=await this.prepare(paperId,first);this.validatePrepared(p,first);this.assertGate(paperId,j.versionId);
   fs.mkdirSync(this.library,{recursive:true});const unlock=acquireLock(path.join(this.library,'.promotion.lock'));
   try{
    this.authorized(paperId);const gate=this.assertGate(paperId,j.versionId);this.validatePrepared(p,gate);
    const indexFile=path.join(this.library,'index.json'),index=readJSON(indexFile),row=index.papers.find(x=>x.paperId===paperId);check(row,'Library identity missing',409,'PROMOTION_SCOPE');
    const current=row.currentEdition?getApprovedEdition(this.projectRoot,paperId):null;
    if(!j.mode){j.mode=this.sameAcceptedInputs(p,current)?'certify_unchanged':'new_edition';if(j.mode==='certify_unchanged'){j.edition=current.version;j.editionSha256=current.recordSha256;}this.save(j);}
    const released=this.release(paperId,j.versionId);check(released.ready&&released.versionId===j.versionId,'Actual release receipt differs',409,'PROMOTION_RELEASE_GAP');
    j.releaseId=released.id;j.status='released';j.events.push({at:now(),type:'release_verified',releaseId:released.id});this.save(j);await this.fault('after_release',j);
    if(j.mode==='certify_unchanged'){
     check(current&&current.version===j.edition&&current.recordSha256===j.editionSha256&&this.sameAcceptedInputs(p,current),'Unchanged edition binding differs',409,'PROMOTION_CONFLICT');
     const relative='certifications/'+paperId+'/'+j.versionId+'.json',target=inside(this.library,path.join(this.library,relative));
     let certification;
     if(fs.existsSync(target)){certification=readJSON(target);check(certification.promotionId===j.id&&certification.editionRecordSha256===current.recordSha256,'Existing certification differs',409,'PROMOTION_CONFLICT');}
     else{certification={schemaVersion:1,promotionId:j.id,paperId,versionId:j.versionId,edition:current.version,editionRecordSha256:current.recordSha256,acceptedAt:j.startedAt,mode:'user_authorized_workflow',authority:this.authority,release:released,build:p.build,lineage:p.lineage,claimBoundary:'New current-version review certification of the unchanged accepted edition. Original individual user acceptance and all edition bytes remain unchanged.'};immutableWrite(target,JSON.stringify(certification,null,2)+'\n');}
     j.edition=current.version;j.editionSha256=current.recordSha256;j.certification=ref(target,relative);j.status='edition_committed';this.save(j);await this.fault('after_edition',j);
     this.authorized(paperId);this.assertGate(paperId,j.versionId);this.validatePrepared(p,gate);
     row.workflowCertifications=[...(row.workflowCertifications||[]).filter(x=>x.path!==relative),j.certification];writeJSON(indexFile,index);
    }else{
     if(!j.edition){const paperRoot=inside(this.library,path.join(this.library,paperId));const versions=fs.existsSync(paperRoot)?fs.readdirSync(paperRoot).filter(n=>/^v[1-9]\d*$/.test(n)).map(n=>Number(n.slice(1))):[];j.edition='v'+(Math.max(0,...versions)+1);this.save(j);}
     const dest=inside(this.library,path.join(this.library,paperId,j.edition)),stage=inside(this.library,path.join(this.library,'.staging',j.id));
     if(!fs.existsSync(dest)){
      fs.mkdirSync(stage,{recursive:true});const records=[];
      const copy=(source,relative,kind)=>{const target=inside(stage,path.join(stage,relative));immutableWrite(target,fs.readFileSync(source));const r={...ref(target,relative),...(kind?{kind}:{})};records.push(r);return r;};
      let latex;const assets=[],dependencies=[];
      for(const f of p.manifest.files){const file=copy(path.join(p.inputsRoot,f.file),f.file,f.file===p.main?null:/\.(png|jpe?g|pdf|eps)$/i.test(f.file)?'figure_asset':'tex_dependency');if(f.file===p.main)latex=file;else if(file.kind==='figure_asset')assets.push(file);else dependencies.push(file);}
      const pdf=copy(p.pdf,p.main.replace(/\.tex$/,'.pdf')),mapping=copy(p.mapping,'source-map.json');
      const json=(relative,value)=>{const target=inside(stage,path.join(stage,relative));immutableWrite(target,JSON.stringify(value,null,2)+'\n');return ref(target,relative);};
      const review={authorization:copy(this.authority.path,'provenance/workflow-authorization.json'),release:json('provenance/release.json',released),build:json('provenance/build.json',p.build),lineage:json('provenance/review-lineage.json',p.lineage)};
      for(const [i,extra] of (p.extraFiles||[]).entries()){check(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(extra.name)&&!extra.name.endsWith('.'),'Invalid provenance attachment name');review['attachment'+i]=copy(extra.path,'provenance/attachments/'+extra.name);}
      const record={schemaVersion:2,paperId,version:j.edition,source:p.source,approval:{status:'workflow_accepted',mode:'user_authorized_workflow',by:'standing_user_authorization',at:j.startedAt,authority:review.authorization,release:review.release},files:{latex,pdf,mapping,assets,dependencies},review,build:{success:true,inputSha256:p.manifest.sha256,inputManifest:p.manifest,pdfSha256:p.build.pdfSha256,engine:p.build.engine,receipt:review.build},promotion:{id:j.id,versionId:j.versionId},mappingScope:'Retained source mapping; exact current TeX/build/review bindings are recorded separately in provenance.',claimBoundary:'User-authorized reconstruction workflow acceptance, not individual human whole-paper reading, validation of source science or corpus completion.'};
      immutableWrite(path.join(stage,'edition.json'),JSON.stringify(record,null,2)+'\n');this.assertGate(paperId,j.versionId);this.validatePrepared(p,gate);
      fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(stage,dest);
     }
     const recordPath=path.join(dest,'edition.json'),record=readJSON(recordPath);check(record.promotion?.id===j.id&&record.build.inputSha256===gate.version.inputSha256,'Existing edition belongs to another publication',409,'PROMOTION_CONFLICT');
     j.editionSha256=hashFile(recordPath);j.status='edition_committed';this.save(j);await this.fault('after_edition',j);
     // Historical lookup validates the edition before making it the default.
     getApprovedEdition(this.projectRoot,paperId,{version:j.edition});this.assertGate(paperId,j.versionId);
     row.status='workflow_accepted';row.currentEdition=j.edition;row.editionRecord=paperId+'/'+j.edition+'/edition.json';row.editionRecordSha256=j.editionSha256;row.acceptanceMode='user_authorized_workflow';row.acceptanceState='workflow_accepted';writeJSON(indexFile,index);
    }
    j.status='index_committed';this.save(j);await this.fault('after_index',j);
    const edition=getApprovedEdition(this.projectRoot,paperId);check(edition.version===j.edition&&edition.recordSha256===j.editionSha256,'Default reader did not select the verified edition',409,'PROMOTION_READER_GAP');
    j.status='complete';j.completedAt=now();delete j.failure;j.events.push({at:now(),type:'default_reader_verified'});this.save(j);return j;
   }finally{unlock();}
  }catch(error){j.failure={at:now(),code:error.code||'PROMOTION_FAILED',message:error.message};this.save(j);throw error;}
 }
}
