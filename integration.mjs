import path from 'node:path';
import {ROOT} from './setup.mjs';
import {readJSON,check} from './lib/io.mjs';
const [command,...args]=process.argv.slice(2),o=Object.fromEntries(args.map(x=>{const i=x.indexOf('=');return i<0?[x,true]:[x.slice(0,i),x.slice(i+1)];}));
const data=path.resolve(o['--data']||path.join(ROOT,'data/production')),rt=readJSON(path.join(data,'runtime.json')),auth=readJSON(path.join(data,'credentials.json'));
check(['status','enroll','reconcile'].includes(command),'Use status, enroll --paper=<paperId>, or reconcile --id=<notificationId>');
const r=await fetch('http://127.0.0.1:'+rt.port+'/internal/integration/'+command,{method:command==='status'?'GET':'POST',headers:{Authorization:'Bearer '+auth.admin,...(command!=='status'?{'Content-Type':'application/json'}:{})},body:command==='enroll'?JSON.stringify({paperId:o['--paper']}):command==='reconcile'?JSON.stringify({id:o['--id']}):undefined});
const b=await r.json();check(r.ok,b.error||'Integration request failed',r.status,b.code);console.log(JSON.stringify(b,null,2));
