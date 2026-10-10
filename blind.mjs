import fs from 'node:fs';
import path from 'node:path';
import {ROOT,setup,credentials} from './setup.mjs';
import {readJSON,check,writeJSON} from './lib/io.mjs';
import {ownerContext} from './lib/recovery.mjs';
import {reworkReceipt} from './lib/blind-bridge.mjs';

// Administrative dispatch and the existing owner's safe-checkpoint entrypoint.
// Never give this script or admin/owner credentials to blind agents.
const action=process.argv[2],opts=Object.fromEntries(process.argv.slice(3).map(a=>{const i=a.indexOf('=');return i<0?[a,true]:[a.slice(0,i),a.slice(i+1)];}));
const data=path.resolve(opts['--data']||path.join(ROOT,'data/production')),config=opts['--config']?readJSON(opts['--config']):setup(),fixture=opts['--mode']==='fixture';
const auth=credentials(data,config),rt=readJSON(path.join(data,'runtime.json')),ownerActions=['freeze','freeze-review','locate','inbox','receive','return','disposition'];
const paper=config.papers[opts['--paper']];if(ownerActions.includes(action)){check(paper,'Named paper required');ownerContext(config,paper,fixture);check(opts['--checkpoint'],'Safe checkpoint required');}
async function api(endpoint,body={},owner=false){const r=await fetch('http://127.0.0.1:'+rt.port+(owner?'/api/worker/blind/':'/internal/blind/')+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(owner?auth.workers[paper.paperId]:auth.admin)},body:JSON.stringify(owner?{...body,paperId:paper.paperId}:body)});const b=await r.json();check(r.ok,b.error||'Blind request failed',r.status,b.code);return b;}
let result;
if(action==='status')result=await api('status');
else if(['blind-reconcile-operation','blind-resume','enable-exhaustive','reconcile-discoveries','recover-delivery','resume-reviewer-technical','resume-audited-math','resume-owner-technical','resume-completion','migrate-location','recover-registration','resume-tool-request','owner-release','owner-archive','owner-rotate'].includes(action))result=await api(action,readJSON(opts['--spec']));
else if(action==='owner-gate')result=await api(action,{paperId:opts['--paper']});
else if(action==='reviewer-math-admission')result=await api(action,{enabled:opts['--enabled']==='true'});
else if(action==='start-production')result=await api('start-production');
else if(action==='retry-math')result=await api('retry-math',readJSON(opts['--spec']));
else if(action==='unmerge')result=await api('unmerge',readJSON(opts['--spec']));
else if(action==='math-admission')result=await api('math-admission',{enabled:opts['--enabled']==='true'});
else if(action==='resume-math')result=await api('resume-math',readJSON(opts['--spec']));
else if(action==='request-location')result=await api('request-location',readJSON(opts['--spec']));
else if(action==='reconcile-dispatch')result=await api('reconcile-dispatch',readJSON(opts['--spec']));
else if(action==='resume-assignment')result=await api('resume-assignment',readJSON(opts['--spec']));
else if(action==='resume-owner-return')result=await api('resume-owner-return',readJSON(opts['--spec']));
else if(action==='resume-owner-packet')result=await api('resume-owner-packet',{id:opts['--id']});
else if(action==='source-observation')result=await api('source-observation',readJSON(opts['--spec']));
else if(action==='freeze-review')result=await api('freeze-review',{checkpoint:true,engine:opts['--engine'],note:opts['--note']},true);
else if(action==='resources')result=await api('resources');
else if(action==='recover-lock')result=await api('recover-lock',{name:opts['--name']});
else if(action==='freeze')result=await api('freeze',{spec:readJSON(opts['--spec'])},true);
else if(action==='locate')result=await api('locate',readJSON(opts['--spec']),true);
else if(action==='disposition')result=await api('disposition',readJSON(opts['--spec']),true);
else if(action==='inbox')result=await api('inbox',{},true);
else if(action==='receive')result=await api('receive',{id:opts['--id']},true);
else if(action==='grant')result=await api('grant',readJSON(opts['--spec']));
else if(action==='claim')result=await api('claim');
else if(action==='screen')result=await api('screen',readJSON(opts['--spec']));
else if(action==='bridge')result=await api('bridge',{id:opts['--id'],supplement:!!opts['--supplement'],...(opts['--spec']?readJSON(opts['--spec']):{})});
else if(action==='return'){
  const spec=readJSON(opts['--spec']);const b=await api('freeze',{spec},true);const node=b.nodes.find(n=>n.semanticId===opts['--node']);check(node,'Affected node required');
  const request=await api('receive',{id:opts['--id']},true),affectedIds=request.report.screening?.affectedSemanticIds||[node.semanticId],affectedNodes=affectedIds.map(id=>b.nodes.find(n=>n.semanticId===id));check(affectedNodes.every(Boolean),'Return spec must include every screened fragment');
  const receipt=await reworkReceipt(config,data,paper,b,node,affectedNodes);result=await api('return',{id:opts['--id'],bundleId:b.id,receipt},true);
}else throw Error('Use status, freeze, grant, claim, screen, locate, bridge, inbox, receive or return');
if(opts['--out']){writeJSON(opts['--out'],result);console.log(JSON.stringify({saved:opts['--out']}));}else console.log(JSON.stringify(result,null,2));
