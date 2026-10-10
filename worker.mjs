import fs from 'node:fs';
import path from 'node:path';
import {setup,ROOT} from './setup.mjs';
import {readJSON,check} from './lib/io.mjs';
import {preparePackage} from './lib/package.mjs';
import {client} from './lib/client.mjs';
import {applyDecision} from './lib/apply.mjs';
import {handoffEnvelope} from './wake-contract.mjs';
import {clearStaleOwnerLock,restoreBefore,ownerContext} from './lib/recovery.mjs';
const [command,...args]=process.argv.slice(2),options=Object.fromEntries(args.map(x=>{const i=x.indexOf('=');return i<0?[x,true]:[x.slice(0,i),x.slice(i+1)];}));
const fixture=options['--mode']==='fixture',dataRoot=path.resolve(options['--data']||path.join(ROOT,'data',fixture?'fixture':'production'));
const config=options['--config']?readJSON(options['--config']):fixture?readJSON(path.join(ROOT,'fixtures/config.json')):setup();
try{
  const spec=options['--spec']?readJSON(options['--spec']):null,paperId=options['--paper']||spec?.paperId,paper=config.papers[paperId];check(paper,'Choose a registered --paper or --spec');
  ownerContext(config,paper,fixture);
  if(!fixture){check(process.env.CODEX_THREAD_ID===paper.owner,'Production mutations must run in the existing paper owner chat (CODEX_THREAD_ID); this chat cannot assume ownership',403,'OWNER_CONTEXT');const current=readJSON(config.batchPath).papers.find(p=>p.paperId===paperId);check(current?.threadId===paper.owner,'Batch owner has changed',409);}
  const api=client(dataRoot,paperId);
  if(command==='connect'){
    check(process.env.CODEX_THREAD_ID===paper.owner,'Only the existing owner can acknowledge Desktop integration',403,'OWNER_CONTEXT');
    console.log(JSON.stringify(await api('connect',{notificationId:options['--notification']}),null,2));
  }
  else if(command==='process'){
    check(process.env.CODEX_THREAD_ID===paper.owner,'Only the existing owner can process a Desktop event',403,'OWNER_CONTEXT');
    check(options['--checkpoint'],'--checkpoint required',409,'CHECKPOINT_REQUIRED');
    const v=await api('case',{id:options['--id']},'GET');check(v.state.decision?.id===options['--decision'],'Notification names a different decision',409);
    if(!fixture)check(v.state.decision.by==='local_user','Production requires a saved human decision',403);
    await api('receive',{id:options['--id'],decisionId:options['--decision']});
    console.log(JSON.stringify(v.state.decision.action==='return'?{received:true,status:'returned',note:v.state.decision.note}:await applyDecision(config,dataRoot,paper,options['--id'],api,{fixture,checkpoint:true}),null,2));
  }
  else if(command==='prepare'){check(spec,'--spec required');console.log(JSON.stringify(await preparePackage(config,dataRoot,spec,{fixture}),null,2));}
  else if(command==='submit'){
    let prepared=options['--package']?{packageId:options['--package']}:null;
    if(!prepared){check(spec,'--spec or --package required');prepared=await preparePackage(config,dataRoot,spec,{fixture});}
    console.log(JSON.stringify(await api('submit',prepared),null,2));
  }else if(command==='inbox')console.log(JSON.stringify(await api('inbox',{},'GET'),null,2));
  else if(command==='handoff'){const v=await api('case',{id:options['--id']},'GET');console.log(JSON.stringify(handoffEnvelope(v.request,v.state),null,2));}
  else if(command==='receive'){const v=await api('case',{id:options['--id']},'GET');console.log(JSON.stringify(await api('receive',{id:options['--id'],decisionId:v.state.decision?.id}),null,2));}
  else if(command==='apply')console.log(JSON.stringify(await applyDecision(config,dataRoot,paper,options['--id'],api,{fixture,checkpoint:options['--checkpoint']}),null,2));
  else if(command==='recover-lock')console.log(JSON.stringify(clearStaleOwnerLock(config,paper,fixture),null,2));
  else if(command==='restore-before')console.log(JSON.stringify(await restoreBefore(config,dataRoot,paper,options['--id'],api,{fixture,checkpoint:options['--checkpoint']}),null,2));
  else throw new Error('Use connect, process, prepare, submit, inbox, receive, apply, recover-lock, restore-before or handoff');
}catch(e){console.error(JSON.stringify({error:e.message,code:e.code||'FAILED'}));process.exitCode=1;}
