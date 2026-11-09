// Admission-only wrapper; the shared synthetic core fixture is imported read-only.
// Every call creates an independent temp project with workerCount=1.
import fs from 'node:fs';
import path from 'node:path';
import {setup as coreSetup,worker,supervisor,canonical,hash,objectHash,clone,scopeFor} from './core-fixture.mjs';
import {reviewFor,decisionFor,digest,read,campaignRelative,cleanRelative} from '../context-kit/fixture.mjs';

export const reviewer='synthetic-append-reviewer';
export const protocolRelative=campaignRelative+'/protocols/append-correction-final-v1';
export function setup(t){
  const f=coreSetup(t);let serial=0;
  const invoke=(command,request=null,ok=true)=>f.execute(protocolRelative+'/coverage.mjs',[command,...(request?[request.path]:[])],ok);
  const request=(fields={})=>f.put(campaignRelative+'/coverage/requests/append-admission-'+(++serial)+'.json',{...clone(f.requestPayload),expectedRevision:f.state().revision,...fields});
  const command=(name,fields={},ok=true)=>{const submitted=request(fields);return {...invoke(name,submitted,ok),request:submitted};};
  return {...f,invokeLegacy:f.invoke,commandLegacy:f.command,invoke,request,command};
}
export function files(root){const result={};const walk=(relative='')=>{for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){const name=path.join(relative,entry.name);if(entry.isDirectory())walk(name);else result[name]=digest(path.join(root,name));}};walk();return result;}
export function scopeReviewFor(f,candidate,contract,review){
  const evidence=[f.put(f.paper().staged.reviewRoot+'/scope-independent.txt','Independent synthetic scope inspection; not constructor output.')];
  return {schemaVersion:1,paperId:candidate.paperId,revision:candidate.revision,scanSha256:objectHash(f.scan),candidateSha256:objectHash(candidate),contractSha256:objectHash(contract),reviewSha256:objectHash(review),reviewerAgent:review.reviewerAgent,
    inventory:{complete:review.inventory.complete,checkedUnlistedSource:true,missingClaims:[],notes:'Synthetic unlisted regions independently inspected.',evidence},
    cards:contract.cards.map(card=>({itemId:card.itemId,cardSha256:objectHash(card),verdict:'aligned',reason:'Independent synthetic source match.',evidence})),
    entries:contract.alignments.map(row=>({obligationId:row.obligationId,alignmentSha256:objectHash(row),verdict:'aligned',reason:'Independent synthetic obligation match.',evidence})),retainedItemIds:[],retainedObligationIds:[]};
}
export function acceptThroughLegacy(f,{partial=false,actor=reviewer}={}){
  const candidate=read(f.paper().staged.candidate.path),contract=read(f.paper().staged.guard.contract.path);
  f.commandLegacy('assign',{role:'reviewer',agent:actor,freshContext:true,historyInherited:false});
  const review=reviewFor(f,f.scan,candidate,{reviewer:actor}),scopeReview=scopeReviewFor(f,candidate,contract,review);
  const delivery=f.put(f.paper().staged.reviewRoot+'/review.json',review);f.put(f.paper().staged.reviewRoot+'/scope-review.json',scopeReview);
  f.commandLegacy('review',{agent:actor,ownerFinished:true,reviewPath:delivery.path});
  const decision=decisionFor(f.scan,candidate,review);if(partial)decision.acceptedObligationIds.pop();
  const decisionRef=f.put(campaignRelative+'/coverage/requests/append-decision-'+candidate.revision+'.json',decision);f.commandLegacy('decide',{decisionPath:decisionRef.path});
  return {candidate,contract,review,decision};
}
export {worker,supervisor,canonical,hash,objectHash,clone,scopeFor,read,digest,campaignRelative,cleanRelative};
