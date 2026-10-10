import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {check,writeJSON,hashFile,now} from './io.mjs';

export function workerEnvironment(parent=process.env){
 const env={...parent},removed=[];
 for(const key of Object.keys(env))if((/^CODEX_/i.test(key)&&key!=='CODEX_HOME')||/^(OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT_ID|CHATGPT_ACCOUNT_ID|MCP_SERVER_|APP_SERVER_)/i.test(key)){removed.push(key);delete env[key];}
 return {env,removed};
}
export function workerArguments({cwd,runRoot,schema,images=[],role='source'}){
 check(['source','blind'].includes(role),'Explicit CLI evidence role required');
 check(role!=='blind'||images.length===0,'Blind workers cannot receive images',403,'BLIND_INPUT_DENIED');
 return ['--no-daemon','-a','never','-s',role==='blind'?'workspace-write':'danger-full-access','exec','--ephemeral','--ignore-user-config','-m',role==='blind'?'gpt-6-astra':'gpt-6-luna','-c','model_reasoning_effort="max"','-c','approval_policy="never"','-c','project_doc_max_bytes=0',...(role==='blind'?['-c','sandbox_workspace_write.network_access=true','-c','windows.sandbox="elevated"']:[]),'--skip-git-repo-check','--json','--color','never','-C',cwd,'--output-schema',schema,'-o',path.join(runRoot,'final.json'),...images.flatMap(file=>['--image',file]),'-'];
}
export function verifyWorkerLogin(cli){const result=spawnSync(cli,['--no-daemon','login','status'],{env:workerEnvironment().env,windowsHide:true,encoding:'utf8',timeout:10000});check(result.status===0&&/Logged in using ChatGPT/i.test((result.stdout||'')+(result.stderr||'')),'Existing ChatGPT CLI login is required; no API-auth fallback is permitted',503,'WORKER_AUTH_REQUIRED');return {checkedAt:now(),usingChatGPT:true,command:'codex --no-daemon login status',exitCode:result.status};}
export function launchFreshSourceWorker({cli,cwd,runRoot,prompt,schema,images=[],role='source',authProof,onThread=async()=>{},onStarted=async()=>{},onEvent=()=>{}}){
 check(fs.existsSync(cli)&&fs.existsSync(schema),'Configured CLI and response schema are required');fs.mkdirSync(runRoot,{recursive:true});
 // A project-level MCP config must be explicitly handled; ignoring the user's
 // config alone cannot prove that an ancestor did not add another provider.
 const ignoredUserConfig=path.resolve(process.env.CODEX_HOME||path.join(process.env.USERPROFILE||process.env.HOME,'.codex'),'config.toml');
 for(let dir=path.resolve(cwd);;dir=path.dirname(dir)){const file=path.join(dir,'.codex','config.toml');if(path.resolve(file)!==ignoredUserConfig&&fs.existsSync(file))check(!/\[\s*mcp_servers(?:\.|\s*\])/m.test(fs.readFileSync(file,'utf8')),'Project MCP providers must be isolated before launching source workers',409,'WORKER_CONFIG_CONFLICT');if(path.dirname(dir)===dir)break;}
 const {env,removed}=workerEnvironment(),args=workerArguments({cwd,runRoot,schema,images,role}),stdout=fs.openSync(path.join(runRoot,'events.jsonl'),'a'),stderr=fs.openSync(path.join(runRoot,'stderr.log'),'a');
 fs.writeFileSync(path.join(runRoot,'prompt.txt'),prompt);const launch={at:now(),cli,cliSha256:hashFile(cli),args,removedEnvironmentNames:removed,model:role==='blind'?'gpt-6-astra':'gpt-6-luna',reasoningEffort:'max',sandbox:role==='blind'?'workspace-write':'danger-full-access',approvalPolicy:'never',auth:'existing_cli_chatgpt_account',authProof:authProof||null,fresh:true,ephemeral:true,ignoreUserConfig:true,projectDocMaxBytes:0,projectInstructions:'explicit_worker_protocol',role};writeJSON(path.join(runRoot,'launch.json'),launch);
 const child=spawn(cli,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let pending='',threadId=null,eventCount=0,spawnError=null,callbackError=null,closed=false;
 const recordError=error=>{callbackError={at:now(),error:error.message,code:error.code||'WORKER_REGISTRATION_FAILED'};writeJSON(path.join(runRoot,'identity-error.json'),callbackError);};
 let callbacks=Promise.resolve().then(()=>{check(child.pid,'Worker process did not start');return onStarted(child.pid);}).then(()=>child.stdin.end(prompt)).catch(error=>{recordError(error);child.stdin.end();});
 child.stdin.on('error',recordError);
 child.stdout.on('data',chunk=>{fs.writeSync(stdout,chunk);pending+=chunk.toString('utf8');const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines){let event;try{event=JSON.parse(line);}catch{continue;}eventCount++;try{onEvent(event);}catch(e){recordError(e);}if(event.type==='thread.started'&&event.thread_id){threadId=event.thread_id;callbacks=callbacks.then(()=>onThread(threadId)).catch(recordError);}}});
 child.stderr.on('data',chunk=>fs.writeSync(stderr,chunk));
 const completion=new Promise(resolve=>{child.once('error',error=>{spawnError={message:error.message,code:error.code};});child.once('close',async(code,signal)=>{await callbacks;if(!closed){closed=true;fs.closeSync(stdout);fs.closeSync(stderr);}const result={at:now(),exitCode:code,signal,threadId,eventCount,spawnError,callbackError,finalExists:fs.existsSync(path.join(runRoot,'final.json'))};writeJSON(path.join(runRoot,'process-exit.json'),result);resolve(result);});});
 launch.pid=child.pid||null;writeJSON(path.join(runRoot,'launch.json'),launch);
 return {child,completion,launch};
}
