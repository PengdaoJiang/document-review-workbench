import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {canonical, hash} from '../../../coverage-core.mjs';
import {prepareCheckpointCorrection} from '../../../protocols/source-binding-v1-checkpoint/source-admission.mjs';
import {resolveSourceView} from '../../../protocols/source-binding-v1-checkpoint/source-binding.mjs';
import {fixture, installCoverage, copyModuleClosure, objectHash,
  campaignRelative, read, digest} from '../source-binding/fixture.mjs';

// Synthetic setup only, derived from the already tested checkpoint-admission fixture.
// One independent temporary project, real neutral init/guard/adopt transitions.
// No production paper content or scientific runtime is copied or executed.
const worker='synthetic-source-worker', reviewer='synthetic-source-reviewer', supervisor='synthetic-supervisor';
const protocolBase=campaignRelative+'/protocols/source-binding-v1-checkpoint';
const releaseBase=campaignRelative+'/architecture/source-supplement-checkpoint-20261029';
const moduleNames=['coverage.mjs','coverage-guard.mjs','coverage-recovery.mjs','source-admission.mjs','source-binding.mjs','coverage-core.mjs','coverage-scope.mjs','coverage-context.mjs','coverage-reader.mjs','coverage-authoring.mjs','coverage-kit.mjs','coverage-batch.mjs','coverage-review-parts.mjs'];
const absolute=(f,ref)=>path.resolve(f.project,ref.path);
function legacyRelease(f){
 copyModuleClosure(f.project,campaignRelative+'/coverage-batch.mjs');
 const oldBase=campaignRelative+'/architecture/batch-scope-20261029';
 f.put(campaignRelative+'/COVERAGE_GUARDS.md','Synthetic source-scope guard guide.');
 for(const name of ['BATCH_API.md','SCOPE_API.md'])f.put(oldBase+'/'+name,'Synthetic neutral guide.');
 const modules=['coverage.mjs','coverage-guard.mjs','coverage-scope.mjs','coverage-batch.mjs','COVERAGE_GUARDS.md','BATCH_API.md','SCOPE_API.md'].map(name=>{
  const installedName=(['BATCH_API.md','SCOPE_API.md'].includes(name)?oldBase:campaignRelative)+'/'+name;
  const file=path.join(f.project,installedName),installed={path:installedName,sha256:digest(file)};
  return {name,installed,frozen:f.put(oldBase+'/release/'+name,fs.readFileSync(file))};
 });
 f.put(oldBase+'/release-manifest.json',{schemaVersion:1,releaseId:'batch-scope-20261029',modules});
}
export function setupSource(t,{adopt=true}={}){
 const legacy=installCoverage(fixture(t));copyModuleClosure(legacy.project,protocolBase+'/coverage.mjs');
 // Also ship adapter modules not directly imported by the CLI.
 for(const name of moduleNames)copyModuleClosure(legacy.project,protocolBase+'/'+name);
 legacyRelease(legacy);
 legacy.invoke('init');legacy.command('guard-policy',{supervisor,reason:'Synthetic guard activation.'});
 legacy.command('prepare');legacy.command('assign',{role:'worker',agent:worker,freshContext:true,historyInherited:false});
 const scan=read(legacy.paper().scan.path),reading=scan.reading,main=fs.readFileSync(reading.primary.path,'utf8');
 const literal='\\lstinputlisting{algorithm1.m}',start=main.indexOf(literal);
 assert.ok(start>=0);
 const supplementPath=path.join(path.dirname(reading.primary.path),'algorithm1.m');
 const binding={schemaVersion:1,protocol:'source-supplement-v1',paperId:'origin',baseScan:legacy.paper().scan,
  edition:Object.fromEntries(['version','release','indexSha256','recordSha256'].map(key=>[key,reading.edition[key]])),
  index:{path:'reconstructed_sources/'+reading.edition.release+'/index.json',sha256:reading.edition.indexSha256},
  record:{path:reading.edition.recordPath,sha256:reading.edition.recordSha256},includingResource:reading.primary,
  include:{command:'lstinputlisting',start,end:start+literal.length,excerptSha256:hash(literal),literalTarget:'algorithm1.m'},
  supplement:{path:supplementPath,sha256:digest(supplementPath)},supplementBytes:fs.statSync(supplementPath).size,kind:'utf8_listing'};
 const proposedBinding=legacy.put(releaseBase+'/proposed-binding.json',canonical(binding));
 const modules=moduleNames.map(name=>{const installed={path:protocolBase+'/'+name,sha256:digest(path.join(legacy.project,protocolBase,name))};return {name,installed,frozen:legacy.put(releaseBase+'/release/'+name,fs.readFileSync(absolute(legacy,installed)))};});

 const paper=legacy.paper(),draft=legacy.put(paper.workRoot+'/original-draft.txt','Original actor draft retained without relabeling.');
 const oldDrafts=['candidate.json','source-scope.json','terminal.json',...Array.from({length:91},(_,i)=>'sealed-original-'+String(i+1).padStart(3,'0')+'.txt')].map(name=>legacy.put(paper.workRoot+'/'+name,{legacyDraft:name,actor:worker}));
 const originalRecord={schemaVersion:1,status:'source_adoption_safe_checkpoint',paperId:'origin',revision:1,agent:worker,role:'worker',
  scan:paper.scan,order:paper.order,guardEnrollment:paper.guardEnrollment.profile,noActiveCalculation:true,noConcurrentReadWrite:true,
  preservedDrafts:[draft,...oldDrafts],checkpointedAt:'2026-10-29T00:00:00Z'};
 const originalCheckpoint=legacy.put(paper.workRoot+'/source-adoption-checkpoint.json',originalRecord);
 const checkpoint=prepareCheckpointCorrection({root:legacy.project,state:legacy.state(),paper,originalCheckpoint,agent:worker,noActiveCalculation:true,noConcurrentReadWrite:true,checkpointedAt:'2026-10-29T00:00:02Z'});
 const ownerCheckpoint=legacy.put(paper.workRoot+'/source-adoption-checkpoint-v002.json',checkpoint);
 const releaseManifest=legacy.put(releaseBase+'/release-manifest.json',{schemaVersion:1,releaseId:'source-supplement-checkpoint-20261029',protocol:'source-supplement-v1',
  repairScope:{paperId:'origin',iteration:1,baseScan:legacy.paper().scan,sourceBindingSha256:objectHash(binding)},checkpointCorrection:{originalCheckpoint,agent:worker},modules});
 const adoptFields={schemaVersion:1,paperId:'origin',iteration:1,agent:worker,supervisor,reason:'Exact synthetic omitted listing repair.',
  scan:paper.scan,order:paper.order,guardEnrollment:paper.guardEnrollment,sourceBinding:proposedBinding,releaseManifest,ownerCheckpoint};
 const invoke=(command,request=null,ok=true)=>legacy.execute(protocolBase+'/coverage.mjs',[command,...(request?[request.path]:[])],ok);
 const command=(name,fields={},ok=true)=>{const request=legacy.request(fields);return {...invoke(name,request,ok),request};};
 const f={...legacy,invokeLegacy:legacy.invoke,commandLegacy:legacy.command,invoke,command,scan,binding,proposedBinding,releaseManifest,originalRecord,originalCheckpoint,checkpoint,ownerCheckpoint,adoptFields,draft,oldDrafts};
 if(adopt){f.adoption=command('source-adopt',adoptFields);const view=resolveSourceView({root:f.project,scan,sourceBinding:f.paper().sourceEnrollment.sourceBinding});f.sourceView={...scan,resources:view.resources,units:view.units,diagnostics:view.diagnostics};}
 return f;
}
