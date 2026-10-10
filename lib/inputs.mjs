import {validateDependencySyntax} from '../paper_library/workflow-contract.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {check,listFiles,safePath,hashFile,hashObject,readJSON} from './io.mjs';

const allowed = /\.(tex|cls|sty|clo|def|cfg|fd|bib|bbl|bst|png|jpe?g|pdf|eps|otf|ttf|pfb|tfm|map)$/i;
export function inputManifest(outputs, main) {
  const files=listFiles(outputs).filter(f=> allowed.test(f) && !f.startsWith('review-evidence/') && (f.endsWith('.pdf') ? f.startsWith('assets/') : true));
  check(files.includes(main),'Canonical main TeX is missing');
  const entries=files.map(file=>({file,sha256:hashFile(safePath(outputs,file)),size:fs.statSync(safePath(outputs,file)).size}));
  check(entries.length<=1000 && entries.reduce((s,f)=>s+f.size,0)<150*1024*1024,'Input snapshot exceeds bounded limits');
  return {files:entries,sha256:hashObject(entries)};
}
export function verifyManifest(root,manifest) {
  check(hashObject(manifest.files)===manifest.sha256,'Input manifest hash mismatch',409,'INPUT_HASH');
  for(const f of manifest.files)check(hashFile(safePath(root,f.file))===f.sha256,'Input changed: '+f.file,409,'INPUT_CHANGED');
}
export function snapshotInputs(outputs,dest,manifest) {
  fs.mkdirSync(dest,{recursive:true});
  for(const f of manifest.files){const target=safePath(dest,f.file,false);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(safePath(outputs,f.file),target);}
  verifyManifest(dest,manifest);
}
export function validateProjectInputs(root,manifest) { validateDependencySyntax(root,manifest.files); }
export function verifyAuthority(paper) {
  check(hashFile(paper.source.path)===paper.source.sha256,'Sealed source changed',409,'AUTHORITY_CHANGED');
  if(paper.mapping)check(hashFile(paper.mapping.path)===paper.mapping.sha256,'Sealed mapping changed',409,'AUTHORITY_CHANGED');
  else check(paper.mapping===null&&!paper.boundaries?.excludedOriginalPages?.length&&!paper.boundaries?.excludedRegions?.length,'Source exclusions require a sealed mapping',409,'AUTHORITY_CHANGED');
}
export function guardKnownDecisions(paper,spec,fixture) {
  if(fixture)return;
  check(['unreadable','conflicting_readings','repeated_correction_failure'].includes(spec.reason)||(spec.reason==='blind_source_fidelity'&&spec.category==='blind_source_fidelity'&&spec.blindOrigin?.reportId)||(spec.reason==='mandatory_fragment_trigger'&&spec.category==='mandatory_fragment_human'&&spec.fragmentHumanOrigin?.stableFragmentId),'Only genuine transcription questions or required fragment escalation belongs in the pool');
  check(spec.boundedCheck && spec.boundedCheck.length>=20,'Describe the bounded readable-crop check already performed');
  const file=path.join(paper.root,'outputs/confidence-events.json');
  if(fs.existsSync(file))for(const e of readJSON(file).events||[]) {
    if(e.state==='resolved'&&(e.id===spec.issueId|| (paper.paperId==='r0176'&&/eq[-_ ]?36|式\s*[（(]?36|equation\s*36/i.test(spec.issueId+' '+spec.locator.label+' '+spec.target.anchorId))))
      check(false,'This source fragment has a final user decision for the current workflow; new evidence alone cannot reopen it',409,'HUMAN_FRAGMENT_LOCKED');
  }
}
