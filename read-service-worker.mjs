import {parentPort,workerData} from 'node:worker_threads';import {createReadService} from './lib/read-service.mjs';
const service=await createReadService(workerData);
parentPort.on('message',message=>{if(message.type==='state')service.update(message.state);if(message.type==='stop')void service.close().then(()=>parentPort.close());});
parentPort.postMessage({type:'ready',port:service.port});
