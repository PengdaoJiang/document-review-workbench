// Print only the private loopback entry for this deployment. Never publish it.
import path from 'node:path';
import {ROOT} from './setup.mjs';
import {readJSON,inside} from './lib/io.mjs';
const data=path.resolve(process.argv[2]||path.join(ROOT,'data/fixture'));
inside(ROOT,data);
const runtime=readJSON(path.join(data,'runtime.json'));
const auth=readJSON(path.join(data,'credentials.json'));
if(runtime.host!=='127.0.0.1'||!Number.isInteger(runtime.port))throw Error('Expected a loopback deployment');
console.log(`http://127.0.0.1:${runtime.port}/#access=${encodeURIComponent(auth.uiKey)}`);
