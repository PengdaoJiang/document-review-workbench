// Invoked only by the fixed local-job wrapper (and by isolated tests).
import fs from 'node:fs';
import path from 'node:path';
import {readJSON,writeJSON,check,hashFile,now} from './lib/io.mjs';
import {verifyManifest,validateProjectInputs,inputManifest} from './lib/inputs.mjs';
import {run,successful} from './lib/process.mjs';
const job=readJSON(process.argv[2]);
const {config,inputs,build,main,manifest,engine}=job;
fs.mkdirSync(build,{recursive:true});
let result={schemaVersion:1,startedAt:now(),engine,inputSha256:manifest.sha256,success:false};
try {
  verifyManifest(inputs,manifest);validateProjectInputs(inputs,manifest);
  check(['tectonic','pdflatex','xelatex'].includes(engine),'Engine is not explicitly verified');
  const exe=config.tools[engine];const commands=[];let log='';
  const flags=engine==='tectonic'?['-X','compile','--only-cached','--untrusted','--synctex','--keep-logs','--outdir',build,main]:['-no-shell-escape','-interaction=nonstopmode','-halt-on-error','-synctex=1','-recorder','-output-directory='+build,main];
  const count=engine==='tectonic'?1:2;
  for(let n=0;n<count;n++) {
    commands.push([exe,...flags]);
    const r=await run(exe,flags,{cwd:inputs,env:{openin_any:'p',openout_any:'p',shell_escape:'f',SYNCTEX_VIEWER:'',TEXMFOUTPUT:build,TEXMFVAR:path.join(build,'texmf-var'),SOURCE_DATE_EPOCH:'1790812800',FORCE_SOURCE_DATE:'1'},onSpawn:pid=>writeJSON(path.join(build,'child.json'),{pid,executable:exe,startedAt:now()})});
    log+=r.output;fs.writeFileSync(path.join(build,'compiler.log'),log);successful(r,'Local TeX compilation');
  }
  verifyManifest(inputs,manifest);
  const pdf=path.join(build,path.basename(main,'.tex')+'.pdf');check(fs.existsSync(pdf)&&fs.statSync(pdf).size>100,'Compiler produced no PDF',422);
  const synctex=pdf.replace(/\.pdf$/,'.synctex.gz');check(fs.existsSync(synctex),'Compiler did not produce SyncTeX',422);
  result={...result,success:true,pdf,pdfSha256:hashFile(pdf),texSha256:hashFile(path.join(inputs,main)),synctex,commands,compilerSha256:hashFile(exe),shellEscape:false,systemPackagesFullySealed:false};
  if(job.publish) {
    // Owner-side publisher: fail if ANY source input changed while compiling.
    check(inputManifest(job.publish.outputs,main).sha256===manifest.sha256,'Owner inputs changed during build; PDF was not published',409,'INPUT_CHANGED');
    const temp=job.publish.pdf+'.review-desk.tmp';fs.copyFileSync(pdf,temp);fs.renameSync(temp,job.publish.pdf);
    result.publishedPdfSha256=hashFile(job.publish.pdf);
  }
} catch(e) {result.error=e.message;result.errorCode=e.code||'BUILD_FAILED';process.exitCode=1;}
result.completedAt=now();writeJSON(path.join(build,'receipt.json'),result);console.log(JSON.stringify(result));
