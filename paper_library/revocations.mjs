import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail=message=>{const e=Error('Paper library: '+message);e.code='LIBRARY_REVOCATION_INVALID';throw e;};
function file(root,relative){
 if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||path.win32.isAbsolute(relative)||/[:\\\x00-\x1f]/.test(relative)||relative.split('/').some(x=>!x||x==='.'||x==='..'))fail('invalid revocation path');
 let p=path.resolve(root);if(fs.realpathSync(p).toLowerCase()!==p.toLowerCase())fail('linked revocation root');
 for(const part of relative.split('/')){p=path.join(p,part);if(fs.lstatSync(p).isSymbolicLink())fail('linked revocation evidence');}return p;
}
export function acceptanceRevocations(projectRoot,index={}){
 const ledgerPath=path.join(projectRoot,'paper_library/acceptance-revocations.json'),binding=index.acceptanceRevocations;
 if(!fs.existsSync(ledgerPath)){if(binding)fail('required revocation ledger missing');return [];}
 const ledgerFile=file(projectRoot,'paper_library/acceptance-revocations.json');
 if(binding&&(binding.path!=='acceptance-revocations.json'||hash(ledgerFile)!==binding.sha256))fail('revocation ledger hash changed');
 const ledger=JSON.parse(fs.readFileSync(ledgerFile,'utf8'));
 if(ledger.schemaVersion!==1||!Array.isArray(ledger.entries)||!ledger.authority)fail('invalid revocation ledger');
 const authFile=file(projectRoot,ledger.authority.path);
 if(hash(authFile)!==ledger.authority.sha256)fail('revocation authority changed');
 const authority=JSON.parse(fs.readFileSync(authFile,'utf8'));
 if(authority.kind!=='direct-user-revocation-of-two-historical-individual-acceptances'||!Array.isArray(authority.revocations))fail('revocation authority invalid');
 if(ledger.entries.length!==authority.revocations.length)fail('revocation ledger scope differs');
 const key=x=>x.paperId+'/'+x.version,authorizedKeys=authority.revocations.map(key),actualKeys=ledger.entries.map(key);
 if(new Set(authorizedKeys).size!==authorizedKeys.length||new Set(actualKeys).size!==actualKeys.length||authorizedKeys.some(k=>!actualKeys.includes(k)))fail('revocation identities must be unique and complete');
 for(const entry of ledger.entries){
  if(!authority.revocations.some(r=>r.paperId===entry.paperId&&r.version===entry.version&&r.editionRecordSha256===entry.editionRecordSha256)||entry.status!=='revoked_pending_blind')fail('unauthorized revocation');
  if(hash(file(projectRoot,'paper_library/'+entry.paperId+'/'+entry.version+'/edition.json'))!==entry.editionRecordSha256)fail('revoked historical edition changed');
 }
 return ledger.entries;
}
export function assertEditionEffective(revocations,paperId,version,recordSha256){
 const revocation=revocations.find(x=>x.paperId===paperId&&x.version===version);
 if(revocation){if(revocation.editionRecordSha256!==recordSha256)fail('revoked edition bytes differ');const e=Error('Paper library: '+paperId+'/'+version+' acceptance revoked; pending complete blind review. Historical bytes are retained for traceability only.');e.code='LIBRARY_APPROVAL_REVOKED';e.paperId=paperId;e.version=version;throw e;}
}
