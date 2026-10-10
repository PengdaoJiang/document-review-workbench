import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {isIP} from 'node:net';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';

const staticPaths=new Set(['/','/app.js','/image-viewer.js','/case-explanations-view.js','/state-view.js','/blind-view.js','/tasks-view.js','/style.css','/tasks-style.css']);
const identifier='[A-Za-z0-9][A-Za-z0-9_-]{0,95}',asset='[A-Za-z][A-Za-z0-9]{0,95}';
const readRoutes=[new RegExp(`^/api/cases/${identifier}$`),new RegExp(`^/api/cases/${identifier}/assets/${asset}$`),new RegExp(`^/api/cases/${identifier}/result/(pdf|tex)$`),new RegExp(`^/api/previews/${identifier}$`),new RegExp(`^/api/previews/${identifier}/assets/${asset}$`)];
const writeRoute=new RegExp(`^/api/cases/${identifier}/(draft|preview|decision|defer)$`);
const safetyHeaders={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"};
const reject=(message,status=403,code='LAN_DENIED')=>{throw Object.assign(Error(message),{status,code});};
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function allowedClient(address){const ip=String(address||'').replace(/^::ffff:/,'');return isIP(ip)===4&&ip.split('.').slice(0,2).join('.')==='10.0';}
export function route(method,raw){
 if(typeof raw!=='string'||raw.length>1500||!raw.startsWith('/')||raw.startsWith('//'))return null;
 const target=raw.split('?')[0];if(!/^\/[A-Za-z0-9_./-]*$/.test(target)||target.includes('//')||target.split('/').some(x=>x==='.'||x==='..'))return null;
 if(method==='GET'&&staticPaths.has(target))return {kind:'static',path:target};
 if(method==='POST'&&target==='/api/session'&&raw===target)return {kind:'login',path:target};
 if(method==='POST'&&target==='/api/ui-digest'&&raw===target)return {kind:'digest',path:target};
 if(raw!==target)return null;
 if(method==='GET'&&(['/api/bootstrap','/api/cases'].includes(target)||readRoutes.some(r=>r.test(target))))return {kind:'read',path:target};
 if(method==='POST'&&writeRoute.test(target))return {kind:'write',path:target};
 return null;
}
export function validateLanEnvelope(req,{host,origin}){
 if(!allowedClient(req.socket.remoteAddress))reject('Client is outside the authorized LAN range');
 if(req.headers.host!==host||req.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()==='host').length!==1)reject('Host rejected',403,'HOST');
 if(req.headers.origin!==undefined&&req.headers.origin!==origin)reject('Origin rejected',403,'ORIGIN');
 if(req.method==='POST'&&req.headers.origin!==origin)reject('Write origin required',403,'ORIGIN');
 if(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))reject('Cross-site request rejected');
 if(req.headers.authorization||req.headers['x-http-method-override']||req.headers.expect)reject('Privileged or ambiguous request headers rejected');
 if(req.method==='GET'&&(req.headers['transfer-encoding']||Number(req.headers['content-length']||0)!==0))reject('GET bodies are not accepted',400);
}
async function jsonBody(req,limit){
 if((req.headers['content-type']||'').split(';')[0]!=='application/json')reject('Use JSON',415,'CONTENT_TYPE');
 const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>limit)reject('Request body too large',413,'BODY_LIMIT');chunks.push(c);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{reject('Malformed JSON',400,'JSON');}
}
export async function createLanGateway({bindAddress,port,upstreamPort,publicRoot,coreAuth,loginKey,uiVersion,onEvent=()=>{},sessionMs=8*60*60*1000}){
 if(!allowedClient(bindAddress)||!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(upstreamPort)||upstreamPort<1024||upstreamPort>65535||typeof loginKey!=='string'||loginKey.length<32)throw Error('Explicit LAN address, ports and independent strong login key required');
 const host=bindAddress+':'+port,origin='http://'+host,coreHost='127.0.0.1:'+upstreamPort,coreOrigin='http://'+coreHost,cookieName='review_desk_lan_'+port,sessions=new Map(),attempts=new Map();
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 const session=req=>{const pairs=(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookieName+'='));if(pairs.length!==1)reject('Use the private LAN login link',401,'LOGIN_REQUIRED');const key=pairs[0].slice(cookieName.length+1),s=sessions.get(key);if(!s||s.until<Date.now()){sessions.delete(key);reject('LAN session expired; reopen the private link',401,'LOGIN_REQUIRED');}return s;};
 const forward=async(req,res,target,body,s)=>{
  const headers={Host:coreHost,Cookie:'review_desk_'+upstreamPort+'='+coreAuth.cookie,Connection:'close'};
  const payload=body===undefined?null:Buffer.from(JSON.stringify(body));if(payload){headers.Origin=coreOrigin;headers['X-Review-Token']=coreAuth.csrf;headers['X-Review-Client']='human-lan-v1';headers['Content-Type']='application/json';headers['Content-Length']=payload.length;}
  const upstream=http.request({hostname:'127.0.0.1',port:upstreamPort,method:req.method,path:target.path,headers,agent:false},reply=>{
   // Only the human bootstrap needs transformation. Core cookies and redirect
   // targets never cross the gateway; all client forwarding headers are dropped.
   if(reply.statusCode>=300&&reply.statusCode<400){reply.resume();return json(res,502,{error:'Unexpected upstream redirect',code:'UPSTREAM_REDIRECT'});}
   if(target.path==='/api/bootstrap'&&reply.statusCode===200){const chunks=[];let size=0;reply.on('data',c=>{size+=c.length;if(size>8*1024*1024){upstream.destroy();return;}chunks.push(c);});reply.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks));json(res,200,{...value,csrf:s.csrf,uiVersion,humanOnly:true,accessMode:'lan-http',transportNotice:'HTTP 仅供受信局域网使用，连接未加密。'});}catch{if(!res.headersSent)json(res,502,{error:'Bootstrap unavailable',code:'UPSTREAM'});}});}
   else if(target.path==='/api/cases'&&reply.statusCode===200){const chunks=[];reply.on('data',c=>chunks.push(c));reply.on('end',()=>{try{json(res,200,{...JSON.parse(Buffer.concat(chunks)),uiVersion});}catch{if(!res.headersSent)json(res,502,{error:'Case list unavailable',code:'UPSTREAM'});}});}
   else{for(const h of ['content-type','content-length','content-disposition'])if(reply.headers[h])res.setHeader(h,reply.headers[h]);res.writeHead(reply.statusCode);reply.pipe(res);}
   reply.on('error',()=>{if(!res.headersSent)json(res,502,{error:'Core connection interrupted; reconcile saved state before resubmitting',code:'UPSTREAM'});else res.destroy();});
  });
  upstream.setTimeout(target.kind==='write'?660000:30000,()=>upstream.destroy(Error('Upstream timeout')));
  upstream.on('error',()=>{if(!res.headersSent)json(res,502,{error:'Workstation service unavailable. Drafts remain in this browser; retry after reconnection.',code:'BACKEND_UNAVAILABLE'});else res.destroy();});
  res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});upstream.end(payload);
 };
 const server=http.createServer({maxHeaderSize:16384},async(req,res)=>{for(const [k,v] of Object.entries(safetyHeaders))res.setHeader(k,v);let target;
  try{validateLanEnvelope(req,{host,origin});target=route(req.method,req.url);if(!target)reject('Route is not available on the human LAN desk',403,'LAN_ROUTE');
   if(target.kind==='static'){const name=target.path==='/'?'index.html':target.path.slice(1),bytes=fs.readFileSync(path.join(publicRoot,name));res.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Content-Length':bytes.length});return res.end(bytes);}
   if(target.kind==='login'){
    const now=Date.now(),ip=req.socket.remoteAddress;for(const [k,v] of attempts)if(v.until<now)attempts.delete(k);for(const [k,v] of sessions)if(v.until<now)sessions.delete(k);
    const a=attempts.get(ip)||{count:0,until:now+60000};if(a.count>=10)reject('Too many login attempts; wait one minute',429,'LOGIN_RATE');a.count++;attempts.set(ip,a);const b=await jsonBody(req,4096);if(!equal(b.key,loginKey))reject('Invalid private LAN login key',401,'LOGIN_REQUIRED');if(sessions.size>=64)reject('LAN session capacity reached',503,'SESSION_LIMIT');
    attempts.delete(ip);const id=randomBytes(32).toString('hex'),s={csrf:randomBytes(32).toString('hex'),until:now+sessionMs};sessions.set(id,s);res.setHeader('Set-Cookie',cookieName+'='+id+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+Math.floor(sessionMs/1000));onEvent({type:'human_login',remote:ip,at:new Date().toISOString()});return json(res,200,{authenticated:true});
   }
   const s=session(req);if(req.method==='POST'&&!equal(req.headers['x-review-token'],s.csrf))reject('Missing LAN write authorization',403,'CSRF');if(req.method==='POST'&&req.headers['x-review-client']!=='human-lan-v1')reject('界面已更新，请保留本机草稿并重新打开新版入口。',428,'CLIENT_UPDATE_REQUIRED');
   const b=req.method==='POST'?await jsonBody(req,2*1024*1024):undefined;
   if(target.kind==='digest'){if(typeof b.text!=='string'||b.text.length>40000)reject('Invalid draft text',400,'DRAFT_TEXT');return json(res,200,{sha256:createHash('sha256').update(b.text,'utf8').digest('hex')});}
   // No credentials, body, query strings, fragments or paper contents in logs.
   onEvent({type:'human_request',remote:req.socket.remoteAddress,method:req.method,route:target.kind,at:new Date().toISOString()});return forward(req,res,target,b,s);
  }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'LAN service error',code:e.code||'LAN_INTERNAL'});else res.destroy();}
 });
 server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.on('upgrade',(req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));server.on('connect',(req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:bindAddress,port,exclusive:true},resolve);});
 return {server,origin,close:()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();})};
}
