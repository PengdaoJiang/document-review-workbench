// Physical location only; callers must still validate the original PDF bytes.
import {readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';

export function loadSourceResolver(projectRoot) {
 const project=path.resolve(projectRoot),configPath=path.join(project,'sources/source-locations.json');
 let config;
 try {config=JSON.parse(readFileSync(configPath,'utf8'));}
 catch(error){if(error.code==='ENOENT')return logical=>path.resolve(logical);throw error;}
 const destination=path.resolve(project,config.destinationRoot||'.');
 const relative=path.relative(project,destination);
 if(config.schemaVersion!==1||!path.isAbsolute(config.legacyRoot||'')||!Array.isArray(config.files)||!config.files.length||
    !config.destinationRoot||path.isAbsolute(config.destinationRoot)||config.destinationRoot.split(/[\\/]/).includes('..')||!relative||relative==='..'||relative.startsWith('..'+path.sep))throw new Error('Invalid source location configuration');
 const legacy=path.resolve(config.legacyRoot).toLowerCase(),files=new Map(),ids=new Set();
 for(const file of config.files){
  if(!file.filename||/[\\/:\x00]/.test(file.filename)||/[. ]$/.test(file.filename)||path.basename(file.filename)!==file.filename||path.extname(file.filename).toLowerCase()!=='.pdf'||
     !/^(origin|r\d{4})$/.test(file.id)||ids.has(file.id)||!/^[a-f0-9]{64}$/.test(file.sha256)||files.has(file.filename.toLowerCase()))throw new Error('Invalid source location identity');
  ids.add(file.id);
  files.set(file.filename.toLowerCase(),file);
 }
 return (logical,expectedSha256)=>{
  const original=path.resolve(logical);
  if(path.dirname(original).toLowerCase()!==legacy)return original;
  const entry=files.get(path.basename(original).toLowerCase());
  if(!entry||entry.sha256!==expectedSha256)throw new Error('Source location identity mismatch');
  const physicalRoot=realpathSync(destination),physical=realpathSync(path.join(destination,entry.filename));
  const inside=path.relative(realpathSync(project),physicalRoot);
  if(!inside||inside==='..'||inside.startsWith('..'+path.sep)||path.isAbsolute(inside)||
     physicalRoot.toLowerCase()!==destination.toLowerCase()||path.dirname(physical).toLowerCase()!==physicalRoot.toLowerCase())throw new Error('Source location escapes its physical root');
  return physical;
 };
}
