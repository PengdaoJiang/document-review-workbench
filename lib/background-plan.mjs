// Each paper is a complete synchronous planning transaction. No routing,
// alias-validation or job-index snapshot survives the yield between papers.
export async function planBackground(q){
  if(!q.v3||!q.blindExecutors?.enabled){q.plan();return true;}
  const papers=[...new Set(q.paperIds())];let waitingMath=false;
  for(const [index,paperId] of papers.entries()){
    await new Promise(resolve=>setImmediate(resolve));
    await q.blindExecutors.math?.registrationWindow?.wait();
    if(q.stopped)return false;
    q.plan({paperId,includeUnscoped:index===0});waitingMath ||= q.waitingMath;
  }
  q.waitingMath=waitingMath;return true;
}
