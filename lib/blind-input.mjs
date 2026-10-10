import fs from 'node:fs';
import path from 'node:path';
import {check,safePath,sha,hashObject,id} from './io.mjs';
import {locate} from './target.mjs';

// This is a text exporter, never a TeX interpreter. Unsupported indirection
// stops export; a failed export returns no partially filtered text to a role.
export function stripComments(text){return text.replace(/(^|[^\\])(?:\\\\)*%[^\r\n]*/gm,m=>m.slice(0,m.indexOf('%')));}
export function forbiddenLocation(text){return /(?:(?<![a-z0-9_])[a-z]:[\\/](?!\\)(?!(?:mathbb|mathbf|mapsto|mathcal|mathrm)\b)|(?:^|[\s{"'=])\\\\[a-z0-9][a-z0-9_.-]*\\[a-z0-9_$.-]+(?:\\|\/|\b)|(?:file|https?|plugin|codex):|(?:^|[\s{])\/(?:Users|home|tmp|mnt|sources)\/|\.\.\s*[\\/])/im.test(text);}
export function exportBlindText(outputs,main,manifest){
  const allowed=new Set(manifest.files.filter(f=>/\.(tex|sty)$/.test(f.file)).map(f=>f.file));
  const seen=new Set(),stack=new Set(),redactions=[];let graphics=0,total=0;
  function visit(name){
    check(allowed.has(name)&&!stack.has(name),'Input dependency is unsupported',422,'BLIND_EXPORT');
    stack.add(name);seen.add(name);let text=stripComments(fs.readFileSync(safePath(outputs,name),'utf8'));total+=text.length;
    check(total<=2_000_000,'Blind input exceeds bounded export',422,'BLIND_EXPORT');
    check(!/\\(?:csname|catcode|scantokens|directlua|luaexec|write18|openin|read|openout|write|immediate|inputminted|lstinputlisting|verbatiminput|includeonly|IfFileExists|InputIfFileExists)\b/.test(text)&&!text.includes('^^'),'Dynamic or external TeX input requires owner normalization',422,'BLIND_EXPORT');
    text=text.replace(/\\(?:input|include)\s*\{([^{}]+)\}/g,(_,ref)=>{const rel=path.posix.normalize(path.posix.join(path.posix.dirname(name),ref.endsWith('.tex')?ref:ref+'.tex'));return '\n'+visit(rel)+'\n';});
    check(!/\\(?:input|include)\b/.test(text),'Unresolved TeX input rejected',422,'BLIND_EXPORT');
    for(const m of text.matchAll(/\\documentclass(?:\[[^\]]*\])?\{([^{}]+)\}/g)){
      check(/^[A-Za-z0-9-]+$/.test(m[1]),'Indirect class name is unsupported',422,'BLIND_EXPORT');const local=manifest.files.find(f=>f.file===m[1]+'.cls');
      const trusted={IEEEtran:'da751920a317ed318b7b5cd7fa585a6cc7d28502d457856382e9be24b10a3bd7',article:'f9c8770a909e5b6526eb72284e457cd379b9bedbf3b508a96bd7f922d4cb24ec'};
      check(!local||trusted[m[1]]===local.sha256,'Unverified local class may contain missing semantic definitions',422,'BLIND_EXPORT');
    }
    text=text.replace(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^{}]+)\}/g,(whole,refs)=>{
      check(refs.split(',').every(x=>/^[A-Za-z0-9-]+$/.test(x.trim())),'Indirect package reference is unsupported',422,'BLIND_EXPORT');
      const local=refs.split(',').map(x=>x.trim()+'.sty').filter(x=>allowed.has(x));
      check(!local.length||local.length===refs.split(',').length,'Mixed local/package declaration requires owner normalization',422,'BLIND_EXPORT');
      return local.length?local.map(visit).join('\n'):whole;
    });
    text=text.replace(/\\graphicspath\s*\{(?:\s*\{[^{}]*\}\s*)*\}/g,raw=>{redactions.push({raw,replacement:''});return '';});
    text=text.replace(/Path=C:\/Windows\/Fonts\//g,raw=>{const replacement='Path=BLIND-FONT-DIRECTORY/';redactions.push({raw,replacement});return replacement;});
    text=text.replace(/\\(includegraphics\*?|includepdf)(\[[^\]]*\])?\s*\{[^{}]+\}/g,(raw,command,opts)=>{const replacement='\\'+command+(opts||'')+'{BLIND-GRAPHIC-'+(++graphics)+'}';redactions.push({raw,replacement});return replacement;});
    check(!/\\(?:pdfximage|pdfimage|epsfbox|epsfig|special)\b/.test(text),'Unresolved image or external primitive requires owner normalization',422,'BLIND_EXPORT');
    check(!/\\(?:bibliography|addbibresource|href|url|externaldocument)\b/.test(text),'External references require a self-contained TeX export',422,'BLIND_EXPORT');
    check(!forbiddenLocation(text),'Location-bearing input rejected',422,'BLIND_EXPORT');stack.delete(name);return text;
  }
  const tex=visit(main);
  return {tex,texSha256:sha(tex),graphics,redactions,limitations:['Graphic bytes are withheld; figure contents are unexamined.','TeX-only inspection cannot establish source completeness.','No compiler or file loading is allowed in the blind role.'],dependencyCount:seen.size};
}
export function bindNodes(outputs,nodes,exported){
  check(Array.isArray(nodes)&&nodes.length>0&&nodes.length<=1000,'Explicit semantic nodes required');
  check(new Set(nodes.map(n=>n.semanticId)).size===nodes.length,'Duplicate semantic node');
  return nodes.map(n=>{id(n.semanticId);const text=fs.readFileSync(safePath(outputs,n.target.file),'utf8');locate(text,n.target);
    let quote=stripComments(n.target.oldText);for(const {raw,replacement} of exported.redactions||[])quote=quote.replace(raw,replacement);check(exported.tex.includes(quote),'Target not intact in neutral text',422,'BLIND_EXPORT');
    return {semanticId:n.semanticId,nodeId:hashObject({semanticId:n.semanticId}).slice(0,20),quote,contentSha256:sha(quote),kind:n.kind||'equation',target:n.target,locator:n.locator||null,locatorEvidence:n.locatorEvidence||null};});
}
// Exhaustive paragraph spans are an index into the full TeX, not an assertion
// that every source node is present. All definitions remain in document.text.
export function wholeDocumentNodes(outputs,main,exported){
  const text=fs.readFileSync(safePath(outputs,main),'utf8'),ends=[...text.matchAll(/(?:\r?\n[ \t]*){2,}/g)].map(m=>m.index+m[0].length);ends.push(text.length);
  const nodes=[];let start=0;
  for(const end of ends){if(end===start)continue;const oldText=text.slice(start,end);let quote=stripComments(oldText);for(const r of exported.redactions)quote=quote.replace(r.raw,r.replacement);
    if(quote.trim()){
      check(exported.tex.includes(quote),'Automatic paragraph index needs owner-provided nodes for this dependency',422,'BLIND_EXPORT');
      const semanticId='paragraph-'+String(nodes.length+1).padStart(4,'0');nodes.push({semanticId,kind:/\\begin\{(?:equation|align|gather)/.test(quote)?'equation':'paragraph',target:{file:main,anchorId:semanticId,oldText,oldSha256:sha(oldText),before:text.slice(Math.max(0,start-120),start),after:text.slice(end,end+120)}});
    }start=end;
  }
  return nodes;
}
export function completionClues(tex){
  // Clues never create owner jobs. A reviewer must quote and explain a defect.
  const clues=[];
  for(const [kind,re] of [['placeholder',/\b(?:TODO|TBD|FIXME)\b/g],['nonsemantic_body',/\\(?:includepdf|textblock|put)\b/g],['unresolved_reference',/\?\?/g],['ocr_fragment',/\uFFFD/g]])for(const m of tex.matchAll(re))clues.push({kind,offset:m.index,quote:tex.slice(Math.max(0,m.index-40),m.index+100)});
  return clues.slice(0,100);
}
