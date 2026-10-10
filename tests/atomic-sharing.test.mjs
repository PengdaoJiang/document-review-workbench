import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
import {ROOT} from '../setup.mjs';import {atomicWrite} from '../lib/io.mjs';
const root=path.join(ROOT,'tests/runs/atomic-sharing-'+Date.now());fs.mkdirSync(root,{recursive:true});
async function hold(file,ms){
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$held = [IO.File]::Open($env:REVIEW_RENAME_FIXTURE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $held.Dispose()`],{windowsHide:true,env:{...process.env,REVIEW_RENAME_FIXTURE:file},stdio:['ignore','pipe','pipe']});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Fixture holder exit '+code)));});
 await new Promise((resolve,reject)=>{child.stdout.on('data',b=>{if(b.toString().includes('READY'))resolve();});child.once('error',reject);child.once('close',code=>reject(new Error('Fixture holder exited before ready '+code)));});return {exited};
}
test('Windows atomic replacement survives a real transient reader without delete sharing',{skip:process.platform!=='win32'},async()=>{
 const file=path.join(root,'transient.json'),temp=path.join(root,'direct.tmp');fs.writeFileSync(file,'old');fs.writeFileSync(temp,'direct');const {exited}=await hold(file,220);
 try{assert.throws(()=>fs.renameSync(temp,file),e=>['EPERM','EACCES','EBUSY'].includes(e.code));atomicWrite(file,'new');assert.equal(fs.readFileSync(file,'utf8'),'new');}finally{await exited;}
});
test('a persistent sharing denial preserves the old file and stops after a bounded retry',{skip:process.platform!=='win32'},async()=>{
 const file=path.join(root,'persistent.json');fs.writeFileSync(file,'old');const {exited}=await hold(file,1200),started=Date.now();
 try{assert.throws(()=>atomicWrite(file,'uncommitted'),e=>['EPERM','EACCES','EBUSY'].includes(e.code));assert.ok(Date.now()-started<1100);assert.equal(fs.readFileSync(file,'utf8'),'old');assert.equal(fs.readdirSync(root).filter(x=>x.startsWith('persistent.json.')&&x.endsWith('.tmp')).length,0);}finally{await exited;}
});
