import http from 'node:http';import {Worker} from 'node:worker_threads';
let reader,writes=0;
const backend=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 if(req.method!=='GET')writes++;
 const authorized=req.headers.origin==='http://'+req.headers.host&&req.headers['x-review-token']==='test-csrf';
 res.writeHead(req.method==='GET'||authorized?200:403,{'Content-Type':'application/json','Set-Cookie':'test-backend-cookie=1; HttpOnly; SameSite=Strict'});
 res.end(JSON.stringify({writes,method:req.method,path:req.url,body,authorization:req.headers.authorization||null,host:req.headers.host,authorized}));
});
backend.listen(0,'127.0.0.1');await new Promise(resolve=>backend.once('listening',resolve));
process.on('message',async message=>{
 if(message.type==='start'){
  reader=new Worker(new URL('../read-service-worker.mjs',import.meta.url),{workerData:{...message.options,backendPort:backend.address().port}});
  reader.on('error',error=>process.send({type:'error',error:error.message}));
  reader.on('message',value=>process.send(value));
 }
 if(message.type==='block'){
  process.send({type:'blocking'},()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,message.ms);process.send({type:'unblocked'});});
 }
 if(message.type==='stop'){
  await new Promise(resolve=>{reader.once('exit',resolve);reader.postMessage({type:'stop'});});
  await new Promise(resolve=>backend.close(resolve));process.send({type:'stopped'},()=>process.disconnect());
 }
});
