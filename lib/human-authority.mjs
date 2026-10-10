import path from 'node:path';import {readJSON,hashFile,hashObject} from './io.mjs';

// A display-only amendment must not revoke an already accepted handoff.
// Preserve its original authority hash, and prove both archived bytes and
// unchanged business/decision-lock rules before accepting the predecessor.
export function compatibleHumanAuthority(settings,receipt){
  const current=settings?.authority;if(!current||!receipt||path.resolve(receipt.path||'.')!==path.resolve(current.path))return false;
  if(receipt.sha256===current.sha256)return true;
  const prior=settings.receiptAuthorityPredecessors?.find(x=>x.sha256===receipt.sha256);if(!prior)return false;
  try{
    if(hashFile(current.path)!==current.sha256||hashFile(prior.path)!==prior.sha256)return false;
    const core=value=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='routeDisplay'));
    return hashObject(core(readJSON(current.path)))===hashObject(core(readJSON(prior.path)));
  }catch{return false;}
}
