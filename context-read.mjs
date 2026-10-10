import fs from 'node:fs';
import path from 'node:path';
import {readWorkerContext} from './worker-context.mjs';
try{
 const [inputFile,ref,...opts]=process.argv.slice(2);
 const input=JSON.parse(fs.readFileSync(inputFile,'utf8').replace(/^\uFEFF/,''));
 const value=readWorkerContext(input,{root:path.dirname(path.resolve(inputFile)),ref,full:ref==='--full'});
 const output=JSON.stringify(value,null,2)+'\n',out=opts.find(x=>x.startsWith('--out='))?.slice(6);
 if(out){
  const root=path.dirname(path.resolve(inputFile)),target=path.resolve(out),relative=path.relative(root,target);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Object.assign(new Error(),{code:'CONTEXT_OUTPUT_PATH'});
  for(let current=target;current!==root;current=path.dirname(current))if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Object.assign(new Error(),{code:'CONTEXT_OUTPUT_PATH'});
  fs.writeFileSync(target,output,{flag:'wx'});console.log(JSON.stringify({written:target,verified:true}));
 }else process.stdout.write(output);
}catch(e){console.error(JSON.stringify({error:e.code||'CONTEXT_READ_FAILED'}));process.exitCode=1;}
