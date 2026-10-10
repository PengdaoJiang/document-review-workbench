import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJSON,writeJSON,token} from './lib/io.mjs';
export const ROOT=path.dirname(fileURLToPath(import.meta.url));
export const PROJECT=ROOT;
export function setup(){
 const location=path.join(ROOT,'config.json');
 if(fs.existsSync(location))return readJSON(location);
 const config={schemaVersion:1,root:ROOT,project:ROOT,batchPath:path.join(ROOT,'data/demo/batch.json'),batchRoot:path.join(ROOT,'data/demo'),host:'127.0.0.1',port:65439,
 tools:{node:process.execPath,python:process.env.REVIEW_PYTHON||'python',tectonic:process.env.REVIEW_TECTONIC||'tectonic',pdflatex:process.env.REVIEW_PDFLATEX||'pdflatex',synctex:process.env.REVIEW_SYNCTEX||'synctex',poppler:process.env.REVIEW_PDFTOPPM||'pdftoppm'},papers:{},wake:{automatic:false,status:'not_connected',reason:'No external transport configured'}};
 writeJSON(config.batchPath,{papers:[]});writeJSON(location,config);
 writeJSON(path.join(ROOT,'math-config.json'),{schemaVersion:1,stateRoot:path.join(ROOT,'data/math-state'),enabled:false,wolframIdleProviderCleanup:false});
 writeJSON(path.join(ROOT,'production-review.json'),{enabled:false});writeJSON(path.join(ROOT,'source-executors.json'),{enabled:false,maxConcurrent:0});writeJSON(path.join(ROOT,'blind-executors.json'),{enabled:false,maxConcurrent:0});
 return config;
}
export function credentials(dataRoot,config){fs.mkdirSync(dataRoot,{recursive:true});const p=path.join(dataRoot,'credentials.json');if(!fs.existsSync(p))writeJSON(p,{uiKey:token(),cookie:token(),csrf:token(),admin:token(),workers:Object.fromEntries(Object.keys(config.papers).map(k=>[k,token()]))});return readJSON(p);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const c=setup();console.log(JSON.stringify({configured:true,loopback:c.host,port:c.port,externalExecution:false}));}
