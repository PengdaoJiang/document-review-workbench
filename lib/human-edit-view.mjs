import fs from 'node:fs';
import path from 'node:path';
import {check,sha,hashFile,safePath} from './io.mjs';
import {verifyManifest} from './inputs.mjs';
import {replaceExact} from './target.mjs';
import {changedManifest} from './build.mjs';
import {exportBlindText,bindNodes} from './blind-input.mjs';

// Derive the neutral view from the exact saved, compiled human preview. This
// is a byte/representation operation, never a new reading of the decision.
export function humanEditView(store,request,decision){
 check(decision.action==='edit'&&decision.previewId&&decision.texSha256===sha(decision.tex),'Saved human edit identity is incomplete',409,'HUMAN_DECISION_EVIDENCE_GAP');
 const originalRoot=path.join(store.caseRoot(request.id),'package/inputs');verifyManifest(originalRoot,request.manifest);
 const original=fs.readFileSync(safePath(originalRoot,request.spec.target.file),'utf8'),changed=replaceExact(original,request.spec.target,decision.tex);
 const manifest=changedManifest(request.manifest,request.spec.target.file,sha(changed.text),Buffer.byteLength(changed.text));
 const preview=store.preview(decision.previewId),root=path.join(store.root,'previews',decision.previewId),inputs=path.join(root,'attempt-'+preview.attempt,'inputs');
 check(preview.id===decision.previewId&&preview.caseId===request.id&&preview.requestDigest===request.intentDigest&&preview.status==='succeeded'&&preview.fragment===decision.tex&&preview.fragmentSha256===decision.texSha256&&preview.build?.inputSha256===manifest.sha256&&preview.build.pdfSha256===decision.previewPdfSha256,'Saved preview differs from exact user edit',409,'HUMAN_DECISION_EVIDENCE_GAP');
 check(preview.artifacts?.pdf&&preview.artifactHashes?.pdf===preview.build.pdfSha256&&hashFile(safePath(root,preview.artifacts.pdf))===preview.build.pdfSha256,'Saved preview PDF changed',409,'HUMAN_DECISION_EVIDENCE_GAP');
 verifyManifest(inputs,manifest);
 const exported=exportBlindText(inputs,request.main,manifest),start=changed.start,end=start+decision.tex.length;
 const target={...request.spec.target,oldText:decision.tex,oldSha256:decision.texSha256,before:changed.text.slice(Math.max(0,start-120),start),after:changed.text.slice(end,end+120)};
 const [node]=bindNodes(inputs,[{semanticId:'human-decision',target}],exported);
 return {tex:node.quote,manifest,target,rawTargetSha256:sha(changed.text)};
}
