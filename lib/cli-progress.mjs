import path from 'node:path';
import {writeJSON,now} from './io.mjs';

// Accept event *types* only. Never persist model text, command text or output in
// the public progress channel. Raw event archives are private evidence.
export function progressRecorder(runRoot){
 let last=0,phase='starting';
 return event=>{
  const type=event?.type,item=event?.item?.type;
  let next;
  if(type==='thread.started'||type==='turn.started')next='working';
  if(type==='item.started'&&['command_execution','mcp_tool_call','web_search'].includes(item))next='tool_running';
  if(type==='item.completed'&&['command_execution','mcp_tool_call','web_search'].includes(item))next='working';
  if(type==='turn.completed')next='turn_finished';
  if(type==='turn.failed'||type==='error')next='failed';
  if(!next)return;
  if(next===phase&&Date.now()-last<1000)return;
  phase=next;last=Date.now();writeJSON(path.join(runRoot,'progress.json'),{schemaVersion:1,phase,lastActivityAt:now(),observableOnly:true});
 };
}
