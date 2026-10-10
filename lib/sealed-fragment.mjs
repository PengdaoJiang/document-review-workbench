import fs from 'node:fs';import path from 'node:path';import {check,hashObject,safePath} from './io.mjs';import {verifyManifest} from './inputs.mjs';import {validateFragment} from './target.mjs';

export function withoutComments(text){return text.split(/\r?\n/).map(line=>{for(let i=0;i<line.length;i++)if(line[i]==='%'){let slashes=0;for(let k=i-1;k>=0&&line[k]==='\\';k--)slashes++;if(slashes%2===0)return line.slice(0,i);}return line;}).join('\n');}
function group(text,start,open='{',close='}'){
 let i=start;while(/\s/.test(text[i]||'')&&i<text.length)i++;if(text[i]!==open)return null;let depth=1;const begin=++i;
 for(;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]===open)depth++;if(text[i]===close&&!--depth)return {text:text.slice(begin,i),end:i+1};}return null;
}
export function pureMacroCommands(sources,inputNames=[]){
 const definitions=new Map(),unsafeNames=new Set();
 for(const source of sources){const text=withoutComments(source);for(const match of text.matchAll(/\\(?:def|gdef|edef|xdef|let|futurelet)\s*\\([A-Za-z]+)\b/g))unsafeNames.add(match[1]);
  for(const match of text.matchAll(/\\(newcommand|renewcommand|providecommand|DeclareMathOperator)\*?\s*/g)){
   let at=match.index+match[0].length,name=group(text,at);if(!name){const simple=/^\\([A-Za-z]+)\b/.exec(text.slice(at));if(!simple)continue;name={text:simple[0],end:at+simple[0].length};}const ident=/^\\([A-Za-z]+)$/.exec(name.text.trim());if(!ident)continue;at=name.end;
   let arity=group(text,at,'[',']'),fallback=null;if(arity){if(!/^[0-9]$/.test(arity.text.trim())){unsafeNames.add(ident[1]);continue;}at=arity.end;fallback=group(text,at,'[',']');if(fallback)at=fallback.end;}
   const body=group(text,at);if(!body){unsafeNames.add(ident[1]);continue;}if(!definitions.has(ident[1]))definitions.set(ident[1],[]);definitions.get(ident[1]).push([body.text,fallback?.text||''].join(' '));
  }
 }
 const allowed=new Set();let changed=true;while(changed){changed=false;for(const [name,bodies] of definitions){if(allowed.has(name)||unsafeNames.has(name))continue;try{for(const body of bodies)validateFragment(body,inputNames,allowed);allowed.add(name);changed=true;}catch{}}}
 return allowed;
}
export function validateSealedFragment(fragment,request,inputs){
 verifyManifest(inputs,request.manifest);const sources=request.manifest.files.filter(f=>/\.(tex|sty|cls|clo|def)$/i.test(f.file)).map(f=>fs.readFileSync(safePath(inputs,f.file),'utf8')),names=request.manifest.files.map(f=>f.file),commands=pureMacroCommands(sources,names);
 validateFragment(fragment,names,commands);return {schemaVersion:1,inputSha256:request.manifest.sha256,trustedPureCommands:[...commands].sort(),policy:'Only pure macro bodies from verified sealed inputs; editor file I/O, executable primitives and macro definitions remain prohibited.'};
}
