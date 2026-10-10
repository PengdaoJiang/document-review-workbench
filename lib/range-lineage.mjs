// Traverse exact (input manifest, text range) states, not every redundant
// receipt path. Every edge is authenticated by the caller before this walk.
// Two paths reaching the same state have identical future transformations.
export function walkRangeLineage({startInput,endInput,startRange,edges,transform}) {
 const key=x=>JSON.stringify([x.input,x.range.start,x.range.end]);
 const first={input:startInput,range:startRange,path:[]},queue=[first],seen=new Set([key(first)]),answers=[],gaps=[];
 let expanded=0;
 const bound=()=>{throw Object.assign(Error('ALIAS_LINEAGE_BOUND'),{code:'ALIAS_LINEAGE_BOUND',technicalGap:true,details:{distinctStates:seen.size,expanded,maxStates:512,maxDepth:32}});};
 for(let cursor=0;cursor<queue.length;cursor++){
  const x=queue[cursor];expanded++;
  if(x.input===endInput){answers.push(x);continue;}
  for(const edge of edges.filter(e=>e.beforeInputSha256===x.input)){
   let range;try{range=transform(x.range,edge);}catch(e){if(!e.technicalGap)throw e;gaps.push(e.code);continue;}
   const next={input:edge.afterInputSha256,range,path:[...x.path,edge]},identity=key(next);
   if(seen.has(identity))continue;
   // Breadth-first discovery gives the shortest proof. A new state beyond
   // either bound makes uniqueness unverified, even if another path succeeded.
   if(next.path.length>32||seen.size>=512)bound();
   seen.add(identity);queue.push(next);
  }
 }
 return {answers,gaps:[...new Set(gaps)]};
}
