import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {check,hashFile} from './io.mjs';

// Standard MCP stdio client for the installed first-party app-tools server.
// The bundled server owns its Desktop connection; never speak private IPC here.
export class DesktopMcp {
  constructor({serverPath,serverSha256,callerThreadId,node=process.execPath,timeoutMs=20000}){
    check(process.env.CODEX_APP_TOOLS_PIPE_PATH,'Desktop did not provide its app-tools connection',503,'DESKTOP_UNAVAILABLE');
    check(hashFile(serverPath)===serverSha256,'Installed app-tools server changed; revalidate transport',409,'TRANSPORT_CHANGED');
    check(callerThreadId==='00000000-0000-4000-8000-6dfd6389e252','Unexpected review-desk caller identity',403);
    this.caller=callerThreadId;this.timeoutMs=timeoutMs;this.nextId=0;this.pending=new Map();this.buffer='';this.closed=false;
    this.child=spawn(node,[serverPath],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:process.env});
    this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',chunk=>this.onData(chunk));
    this.stderr='';this.child.stderr.on('data',b=>{this.stderr=(this.stderr+b.toString()).slice(-4000);});
    this.child.on('error',e=>this.fail(e));this.child.on('exit',()=>this.fail(new Error('Desktop MCP disconnected')));
  }
  fail(error){this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
  onData(chunk){this.buffer+=chunk;if(this.buffer.length>16*1024*1024){this.fail(new Error('Desktop response exceeded limit'));return;}
    for(let i;(i=this.buffer.indexOf('\n'))>=0;){const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);if(!line.trim())continue;
      let r;try{r=JSON.parse(line);}catch{this.fail(new Error('Invalid MCP response'));continue;}
      const p=this.pending.get(r.id);if(!p)continue;this.pending.delete(r.id);clearTimeout(p.timer);
      if(r.error)p.reject(Object.assign(new Error(r.error.message),{rpcCode:r.error.code}));else p.resolve(r.result);
    }
  }
  request(method,params){check(!this.closed,'Desktop MCP is closed',503);const id=++this.nextId;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(new Error('Desktop MCP response timeout'),{code:'DELIVERY_UNKNOWN'}));},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  }
  async connect(){this.initializeResult=await this.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'paper-review-desk',version:'2.0.0'}});
    this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const catalog=await this.request('tools/list',{});this.tools=new Map(catalog.tools.map(t=>[t.name,t]));return catalog;
  }
  async call(name,args,{callId=randomUUID()}={}){
    check(['read_thread','wait_threads','send_message_to_thread','set_thread_archived'].includes(name),'Desktop method outside review-desk scope',403);
    if(name==='set_thread_archived')check(args.archived===true&&args.threadId!==this.caller,'Only completed registered owner archival belongs to this route',403);
    check(this.tools?.has(name),'Installed Desktop tool is unavailable',503,'DESKTOP_UNAVAILABLE');
    const r=await this.request('tools/call',{name,arguments:args,_meta:{'openai/threadId':this.caller,'openai/toolCallId':callId}});
    check(!r.isError,(r.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')||'Desktop tool failed',502,'DESKTOP_TOOL_ERROR');
    const values=(r.content||[]).filter(c=>c.type==='text').map(c=>{try{return JSON.parse(c.text);}catch{return c.text;}});
    return values.length===1?values[0]:values;
  }
  close(){if(this.closing)return;this.closing=true;this.child.stdin.end();const child=this.child;setTimeout(()=>{if(child.exitCode===null)child.kill();},1000).unref();this.fail(new Error('Desktop MCP closed by its owner'));}
}
