import fs from 'node:fs';
import path from 'node:path';
import {sha,hashFile,now,check,safePath} from './io.mjs';
import {snapshotInputs,verifyManifest} from './inputs.mjs';
import {replaceExact} from './target.mjs';
import {validateSealedFragment} from './sealed-fragment.mjs';
import {compile,renderCandidate,changedManifest} from './build.mjs';

export class PreviewQueue {
  constructor(store){this.store=store;this.busy=false;this.queue=[];}
  recover(){for(const id of fs.readdirSync(path.join(this.store.root,'previews'))){const p=this.store.preview(id);if(['running','queued'].includes(p.status)){if(p.status==='running')p.attempt++;p.status='queued';p.recoveredAt=now();this.store.savePreview(p);this.queue.push(id);}}this.pump();}
  enqueue(key,version,retry=false){const r=this.store.request(key),s=this.store.state(key);check(!s.decision&&!s.supersededBy,'Request has a decision or a newer revision',409);check(s.draft.version===version,'Draft changed',409,'DRAFT_CONFLICT');
    const validation=validateSealedFragment(s.draft.tex,r,safePath(this.store.caseRoot(key),'package/inputs'));
    const id=sha(r.intentDigest+'\n'+s.draft.tex).slice(0,32);let p;
    if(fs.existsSync(path.join(this.store.root,'previews',id,'state.json'))){p=this.store.preview(id);if((p.status!=='failed'||!retry)&&!(p.status==='succeeded'&&!p.artifactHashes)){if(s.latestPreview!==id){s.latestPreview=id;this.store.save(key,s);}return p;}}
    check(this.queue.length<24,'Preview queue is full; retry later',429);
    p={id,caseId:key,requestDigest:r.intentDigest,fragment:s.draft.tex,fragmentSha256:sha(s.draft.tex),validation,status:'queued',createdAt:p?.createdAt||now(),attempt:(p?.attempt||0)+1};this.store.savePreview(p);this.queue.push(id);
    s.latestPreview=id;this.store.save(key,s);this.pump();return p;
  }
  async pump(){if(this.busy)return;this.busy=true;
    try{while(this.queue.length){const id=this.queue.shift();let p=this.store.preview(id);p.status='running';p.startedAt=now();this.store.savePreview(p);
      try{const r=this.store.request(p.caseId),c=this.store.config,paper=c.papers[r.spec.paperId];const source=safePath(this.store.caseRoot(p.caseId),'package/inputs');verifyManifest(source,r.manifest);validateSealedFragment(p.fragment,r,source);
        const root=path.join(this.store.root,'previews',id,'attempt-'+p.attempt),inputs=path.join(root,'inputs');fs.mkdirSync(root,{recursive:true});snapshotInputs(source,inputs,r.manifest);
        const target=safePath(inputs,r.spec.target.file),old=fs.readFileSync(target,'utf8'),changed=replaceExact(old,r.spec.target,p.fragment);fs.writeFileSync(target,changed.text);
        const manifest=changedManifest(r.manifest,r.spec.target.file,hashFile(target),fs.statSync(target).size);
        const built=await compile(c,paper,{inputs,build:path.join(root,'build'),main:r.main,manifest,engine:r.engine});
        const rendered=await renderCandidate(c,{pdf:built.pdf,out:path.join(root,'view'),targetFile:target,text:changed.text,start:changed.start,end:changed.start+p.fragment.length});
        const artifacts={pdf:path.relative(path.join(this.store.root,'previews',id),built.pdf).replaceAll('\\','/')};rendered.pages.forEach((x,i)=>{for(const [label,field] of [['crop','cropFile'],['context','contextFile'],['page','pageFile']])artifacts[label+i]='attempt-'+p.attempt+'/view/'+x[field];});
        const artifactHashes=Object.fromEntries(Object.entries(artifacts).map(([name,rel])=>[name,hashFile(safePath(path.join(this.store.root,'previews',id),rel))]));
        p={...p,status:'succeeded',completedAt:now(),build:{pdfSha256:built.pdfSha256,texSha256:built.texSha256,inputSha256:built.inputSha256,engine:r.engine},rendered,artifacts,artifactHashes};
      }catch(e){p={...p,status:'failed',completedAt:now(),error:e.message,errorCode:e.code||'PREVIEW_FAILED'};}
      this.store.savePreview(p);
    }}finally{this.busy=false;}
  }
}
