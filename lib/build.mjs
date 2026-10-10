import fs from 'node:fs';
import path from 'node:path';
import {readJSON,writeJSON,check,hashFile,hashObject,DeskError} from './io.mjs';
import {run,successful} from './process.mjs';
import {currentCompiler} from './runtime-tools.mjs';

export async function compile(config,paper,{inputs,build,main,manifest,engine,publish,receipt=false}) {
  config=currentCompiler(config,engine);
  fs.mkdirSync(build,{recursive:true});
  const job=path.join(build,'job.json');writeJSON(job,{config,paperId:paper.paperId,inputs,build,main,manifest,engine,publish});
  const runner=[config.tools.node,path.join(config.root,'compile-runner.mjs'),job];
  const inner=receipt?[config.tools.node,path.join(config.batchRoot,'delivery-receipt.mjs'),'run',paper.root,'--',...runner]:runner;
  const wrapper=paper.enrollment?[path.join(config.root,'local-build-job.mjs'),job]:[path.join(config.batchRoot,'local-job.mjs'),paper.paperId];
  const r=await run(config.tools.node,[...wrapper,...inner],{cwd:paper.cpuCwd,timeout:600000});
  fs.writeFileSync(path.join(build,'slot.log'),r.output);
  if(r.code===75)throw new DeskError('Local CPU slots are occupied. No build began; retry later.',503,'CPU_BUSY');
  const resultPath=path.join(build,'receipt.json');
  const result=fs.existsSync(resultPath)?readJSON(resultPath):null;
  if(r.code!==0||!result?.success)throw new DeskError(result?.error||r.output.slice(-2000)||'Compiler failed',422,result?.errorCode||'BUILD_FAILED');
  check(hashFile(result.pdf)===result.pdfSha256,'Build PDF changed',409);
  return result;
}
export async function renderSource(config,paper,locator,pdf,out) {
  const job=path.join(out,'render-job.json');fs.mkdirSync(out,{recursive:true});
  writeJSON(job,{kind:'source',pdf,out,locator,boundaries:paper.boundaries,poppler:config.tools.poppler});
  successful(await run(config.tools.python,[path.join(config.root,'render.py'),job]),'Source rendering');
  return readJSON(path.join(out,'render.json'));
}
export async function renderCandidate(config,{pdf,out,targetFile,start,end,text}) {
  fs.mkdirSync(out,{recursive:true});const job=path.join(out,'render-job.json');
  const startLine=text.slice(0,start).split('\n').length,endLine=text.slice(0,end).split('\n').length;
  writeJSON(job,{kind:'candidate',pdf,out,targetFile,startLine,endLine,poppler:config.tools.poppler,synctex:config.tools.synctex});
  successful(await run(config.tools.python,[path.join(config.root,'render.py'),job]),'Candidate rendering');
  return readJSON(path.join(out,'render.json'));
}
export function changedManifest(manifest,file,newHash,size) {
  const files=manifest.files.map(f=>f.file===file?{...f,sha256:newHash,size}:f);
  return {files,sha256:hashObject(files)};
}
