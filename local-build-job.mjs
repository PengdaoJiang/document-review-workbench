// The two separately enrolled papers share the existing four local build slots.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readJSON,check,hashFile,now} from './lib/io.mjs';
const [jobFile,...command]=process.argv.slice(2),job=readJSON(jobFile),{config,paperId}=job,p=config.papers[paperId],enrollment=config.reviewEnrollment;
check(p?.enrollment&&enrollment&&hashFile(enrollment.path)===enrollment.sha256,'Explicit additional-paper build enrollment required',409);
const authority=readJSON(enrollment.path);
check(authority.permissions.newBlindReviewOfR0167AndR0158&&authority.additionalReviewPaperIds.includes(paperId)&&p.enrollment.authoritySha256===enrollment.sha256&&path.resolve(process.cwd())===path.resolve(p.root),'Enrolled build identity differs',409);
check(command[0]===config.tools.node,'Fixed local build wrapper required',403);
const slots=path.join(config.batchRoot,'.slots');fs.mkdirSync(slots,{recursive:true});
let lease,fd;
for(let n=1;n<=4;n++){const candidate=path.join(slots,n+'.json');try{fd=fs.openSync(candidate,'wx');lease=candidate;break;}catch(e){if(e.code!=='EEXIST')throw e;}}
if(!lease){console.error('All local CPU slots occupied; no build started.');process.exit(75);}
try{
 fs.writeFileSync(fd,JSON.stringify({paperId,ownerPid:process.pid,createdAt:now(),program:command[0],enrollment:enrollment.sha256}));fs.closeSync(fd);fd=undefined;
 const child=spawn(command[0],command.slice(1),{cwd:process.cwd(),shell:false,windowsHide:true,stdio:'inherit',env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1'}});
 const result=await new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('exit',(code,signal)=>resolve({code,signal}));});if(result.error)throw result.error;process.exitCode=result.code??1;
}finally{if(fd!==undefined)fs.closeSync(fd);fs.unlinkSync(lease);}

