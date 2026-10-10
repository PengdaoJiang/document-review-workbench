import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
export const objectHash=x=>hash(canonical(x));
const requireThat=(value,message)=>{if(!value)throw Error('Paper library: '+message);};

export function validateWorkflowAcceptance(record,readFile){
 const approval=record.approval;
 requireThat(record.schemaVersion===2&&approval?.status==='workflow_accepted'&&approval.mode==='user_authorized_workflow'&&approval.by==='standing_user_authorization','invalid workflow acceptance');
 requireThat(Number.isFinite(Date.parse(approval.at)),'invalid workflow acceptance time');
 const auth=JSON.parse(fs.readFileSync(readFile(approval.authority,'workflow authority').path,'utf8'));
 requireThat(auth.permissions?.automaticCurrentVersionSignoffAndRelease===true&&auth.permissions?.automaticImmutableLibraryPromotion===true&&auth.permissions?.perPaperWholeDocumentHumanAcceptanceRequired===false,'workflow authority does not permit automatic publication');
 requireThat([...auth.existingBatchPaperIds,...auth.additionalReviewPaperIds].includes(record.paperId),'paper outside workflow authority');
 const release=JSON.parse(fs.readFileSync(readFile(approval.release,'workflow release').path,'utf8'));
 requireThat(release.ready===true&&release.paperId===record.paperId&&release.gaps?.length===0&&release.versionId===objectHash(release.version)&&release.version?.inputSha256===record.build?.inputSha256,'workflow release differs from edition input');
 requireThat(release.versionId===record.promotion?.versionId,'workflow version identity differs');
 return {authority:approval.authority,release:approval.release};
}

export function validateSealedDependencies(record,declared,root){
 const manifest=record.build?.inputManifest;
 requireThat(manifest&&Array.isArray(manifest.files)&&manifest.sha256===objectHash(manifest.files)&&manifest.sha256===record.build.inputSha256,'sealed input manifest differs');
 requireThat(record.build.pdfSha256===record.files.pdf.sha256&&record.build.success===true,'PDF lacks an exact successful build binding');
 const listed=new Map(declared.map(f=>[f.relative,f]));
 requireThat(new Set(manifest.files.map(f=>f.file)).size===manifest.files.length,'duplicate sealed input');
 for(const entry of manifest.files){
  requireThat(typeof entry.file==='string'&&!path.isAbsolute(entry.file)&&!path.win32.isAbsolute(entry.file)&&!entry.file.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'),'unsafe sealed dependency');
  const file=listed.get(entry.file);
  requireThat(file&&file.sha256===entry.sha256&&fs.statSync(file.path).size===entry.size,'missing or changed sealed dependency: '+entry.file);
 }
 requireThat(manifest.files.some(f=>f.file===record.files.latex.path),'main TeX absent from sealed inputs');
 const buildFile=listed.get(record.build.receipt?.path);
 requireThat(buildFile&&buildFile.sha256===record.build.receipt.sha256,'build receipt is not sealed');
 const receipt=JSON.parse(fs.readFileSync(buildFile.path,'utf8'));
 requireThat(receipt.success===true&&receipt.inputSha256===manifest.sha256&&receipt.pdfSha256===record.files.pdf.sha256,'actual build receipt differs from published files');
 validateDependencySyntax(root,manifest.files);
}

export function validateDependencySyntax(root,files){
 const manifest={files},listed=new Map(files.map(f=>[f.file,{path:path.join(root,f.file)}]));
 // This is static dependency integrity, not execution/sandboxing of arbitrary TeX.
 // Parameterized graphics macros are allowed only with the sealed successful
 // build and complete project manifest. Input commands remain literal and local.
 for(const entry of manifest.files.filter(f=>/\.(tex|sty|cls|clo|def|cfg)$/i.test(f.file))){
  const text=fs.readFileSync(listed.get(entry.file).path,'utf8');
  if(!entry.file.endsWith('.tex'))continue; // Verified class/package bytes are dependencies.
  const clean=text.split(/\r?\n/).map(line=>{for(let i=0;i<line.length;i++)if(line[i]==='%'){let n=0;for(let j=i-1;j>=0&&line[j]==='\\';j--)n++;if(n%2===0)return line.slice(0,i);}return line;}).join('\n');
  requireThat(!/\\(?:import|subimport|openin|openout|read|readline|write\s*18|directlua|latelua|scantokens)\b|\^\^/.test(clean),'uncontrolled external TeX input');
  for(const c of clean.matchAll(/\\(?:input|include)\b/g)){
   const m=clean.slice(c.index+c[0].length).match(/^\s*\{([^{}]+)\}/);requireThat(m,'TeX input must use a literal braced local dependency');
   const name=m[1];requireThat(!/[\\#:$]/.test(name)&&!name.split('/').includes('..')&&!path.isAbsolute(name),'unsafe external TeX input');
   requireThat(manifest.files.some(f=>[name,name+'.tex'].includes(f.file)),'unsealed TeX input: '+name);
  }
  const dirs=[''];
  for(const c of clean.matchAll(/\\graphicspath\b/g)){const m=clean.slice(c.index+c[0].length).match(/^\s*\{((?:\s*\{[^{}]*\}\s*)+)\}/);requireThat(m,'Graphics directories must be literal and local');for(const d of m[1].matchAll(/\{([^{}]*)\}/g)){
   requireThat(!/[\\#:$]/.test(d[1])&&!d[1].split('/').includes('..')&&!path.isAbsolute(d[1]),'unsafe graphics directory');dirs.push(d[1]);
  }}
  for(const c of clean.matchAll(/\\includegraphics\b\*?/g)){const m=clean.slice(c.index+c[0].length).match(/^\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]+)\}/);requireThat(m,'Graphics reference must use a supported braced dependency');
   const name=m[1];if(/^#[1-9](?:\/#[1-9])*$/.test(name))continue;
   requireThat(!/[\\#:$]/.test(name)&&!name.split('/').includes('..')&&!path.isAbsolute(name),'unsafe graphics input');
   const candidates=dirs.flatMap(d=>{const f=d+name;return path.extname(f)?[f]:['.pdf','.png','.jpg','.jpeg','.eps'].map(e=>f+e);});
   requireThat(manifest.files.some(f=>candidates.includes(f.file)),'unsealed graphics input: '+name);
  }
 }
}
