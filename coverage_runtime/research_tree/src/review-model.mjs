// Scientific evidence and display geometry are separate. No title rule enters this file.
export const ROOT_YEAR=1985;
export const YEAR_UNIT=32;
export const USE_TYPES=['mention','background','adoption','analysis','comparison','extension'];
export const OBJECT_TYPES=['algorithm','theory_bound','assumption_environment','evaluation_setup','other'];
export const USE_LABELS={mention:'仅提及',background:'背景讨论',adoption:'实际采用',analysis:'分析推导',comparison:'对比验证',extension:'改进扩展',unresolved:'关系待判定'};
export const OBJECT_LABELS={algorithm:'算法',theory_bound:'理论 / 界限',assumption_environment:'假设 / 噪声 / 信号环境',evaluation_setup:'评价设置',other:'其他对象'};
// A declared display tie-break, not a ranking of research quality or depth.
export const DIRECTION_PRIORITY=['extension','analysis','comparison','adoption','background','mention'];
export const DIRECTION_ANGLES={mention:0,background:60,adoption:120,analysis:180,comparison:240,extension:300};
export const OBJECT_PRIORITY=['algorithm','theory_bound','assumption_environment','evaluation_setup','other'];
export const OBJECT_ELEVATIONS={algorithm:-55,theory_bound:-20,assumption_environment:20,evaluation_setup:55,other:80};
export function emptyReview(paper,origin){return {
 schemaVersion:1,paperId:paper.id,paperSha256:paper.sourceSha256,
 inspectionDirection:origin==='source_reference'?'tretter_uses_reference':'paper_uses_tretter',
 reading:{status:'unread',reviewer:null,updatedAt:null},
 relationship:{status:'unassessed',useTypes:[],objects:[],domains:[],claims:[],primaryDirection:null,primaryDirectionReason:null,primaryObject:null,primaryObjectReason:null},
 evidence:[],contribution:null,methodInheritance:null,comparison:null,researchHistory:null,
 notes:null
};}
export function validateReview(review,paper,allPapers,root){
 const errors=[];
 if(review.paperId!==paper.id||review.paperSha256!==paper.sourceSha256)errors.push('Review identity / source seal mismatch');
 if(review.inspectionDirection!==(paper.sourceOrigin==='source_reference'?'tretter_uses_reference':'paper_uses_tretter'))errors.push('Inspection direction mismatch');
 if(!['unread','in_progress','reviewed'].includes(review.reading?.status))errors.push('Invalid reading state');
 if(review.reading?.status==='reviewed'&&(!review.reading.reviewer||!review.reading.updatedAt))errors.push('Reviewed reading requires named reviewer and date');
 if(!['unassessed','proposed','evidence_reviewed','disputed'].includes(review.relationship?.status))errors.push('Invalid relationship state');
 const seen=new Set();
 for(const ev of review.evidence||[]){
  if(!ev.id||seen.has(ev.id))errors.push('Evidence ID missing / duplicate');seen.add(ev.id);
  const source=ev.sourcePaperId==='origin'?root:allPapers.find(p=>p.id===ev.sourcePaperId);
  if(!source)errors.push('Evidence source outside closed set + anchor');
  if(ev.reviewStatus==='reviewed'){
   if(!source?.sourceSha256||ev.sourcePdfSha256!==source.sourceSha256)errors.push('Reviewed evidence requires a known matching original PDF seal');
   if(!Number.isInteger(ev.pdfPage)||ev.pdfPage<1||ev.pdfPage>source.sourcePages)errors.push('Evidence page outside original PDF');
   if(!ev.reviewer||!ev.reviewedAt)errors.push('Reviewed evidence needs named reviewer and timestamp');
   if(!ev.excerpt&&!ev.bbox)errors.push('Reviewed evidence needs a locatable excerpt or region');
  }
  if(ev.bbox&&(!Array.isArray(ev.bbox)||ev.bbox.length!==4||!ev.bbox.every(Number.isFinite)||ev.bbox[2]<=ev.bbox[0]||ev.bbox[3]<=ev.bbox[1]))errors.push('Invalid PDF region');
  if(ev.bbox&&ev.reviewStatus==='reviewed'&&(!ev.regionBasis||!Number.isFinite(ev.regionBasis.width)||!Number.isFinite(ev.regionBasis.height)||!Number.isFinite(ev.regionBasis.rotation)))errors.push('Reviewed PDF region needs page geometry and rotation');
  if(!['source_fact','researcher_inference'].includes(ev.assertionKind))errors.push('Separate source fact from researcher inference');
  if(!['supporting','contradictory','context','bibliography_only'].includes(ev.role))errors.push('Invalid evidence role');
 }
 const rel=review.relationship||{};
 if((rel.useTypes||[]).some(t=>!USE_TYPES.includes(t)))errors.push('Unknown usage type');
 if((rel.objects||[]).some(t=>!OBJECT_TYPES.includes(t)))errors.push('Unknown association object');
 const accepted=new Set(),acceptedObjects=new Set();
 for(const claim of rel.claims||[]){
  if(!USE_TYPES.includes(claim.useType))errors.push('Claim has unknown usage type');
  if((claim.objects||[]).some(t=>!OBJECT_TYPES.includes(t)))errors.push('Claim has unknown association object');
  if((claim.evidenceIds||[]).some(id=>!seen.has(id)))errors.push('Claim references missing evidence');
  if(claim.status==='reviewed'){
   const ev=(claim.evidenceIds||[]).map(id=>review.evidence.find(e=>e.id===id));
   if(!claim.reviewer||!claim.reviewedAt||!ev.length||ev.some(e=>!e||e.reviewStatus!=='reviewed'))errors.push('Reviewed claim needs reviewed, attributed evidence');
   const relevantSource=paper.sourceOrigin==='source_reference'?'origin':paper.id;
   if(!ev.some(e=>e?.sourcePaperId===relevantSource))errors.push('Claim needs evidence from the actual citing / discussing source');
   const sourceSupport=ev.some(e=>e?.sourcePaperId===relevantSource&&e.assertionKind==='source_fact'&&(e.role==='supporting'&&e.occurrenceKind!=='bibliography_entry'||claim.useType==='mention'&&e.role==='bibliography_only'&&e.occurrenceKind==='bibliography_entry'));
   if(!sourceSupport)errors.push('A claim needs source-fact evidence from its citing source; bibliography-only supports mention only');
   if(sourceSupport){accepted.add(claim.useType);for(const object of claim.objects||[])acceptedObjects.add(object);}
   else errors.push('Bibliography alone cannot establish substantive use');
  }
 }
 if(rel.status==='evidence_reviewed'&&!accepted.size)errors.push('Reviewed relationship needs a reviewed usage claim');
 if([...accepted].some(t=>!(rel.useTypes||[]).includes(t)))errors.push('Accepted use types must remain in the multi-label relationship record');
 if([...acceptedObjects].some(t=>!(rel.objects||[]).includes(t)))errors.push('Accepted objects must remain in the independent multi-label object record');
 if(rel.primaryDirection&&(!accepted.has(rel.primaryDirection)||!rel.primaryDirectionReason))errors.push('Primary direction requires accepted type and explicit display reason');
 if(rel.primaryObject&&(!acceptedObjects.has(rel.primaryObject)||!rel.primaryObjectReason))errors.push('Primary object requires accepted evidence and explicit display reason');
 return {errors,acceptedUseTypes:errors.length?[]:[...accepted],acceptedObjects:errors.length?[]:[...acceptedObjects]};
}
export function directionFor(review,validation){
 if(validation.errors.length||review.relationship.status!=='evidence_reviewed'||!validation.acceptedUseTypes.length)return 'unresolved';
 return review.relationship.primaryDirection||DIRECTION_PRIORITY.find(t=>validation.acceptedUseTypes.includes(t))||'unresolved';
}
export function objectDirectionFor(review,validation){
 if(validation.errors.length||review.relationship.status!=='evidence_reviewed'||!validation.acceptedObjects.length)return 'unresolved';
 return review.relationship.primaryObject||OBJECT_PRIORITY.find(t=>validation.acceptedObjects.includes(t))||'unresolved';
}
export function positionFor(paper){
 if(paper.spacePlacement)return {...paper.spacePlacement};
 const year=/^\d{4}$/.test(String(paper.year))?Number(paper.year):null;
 if(year===null)return {x:0,y:0,z:0,radius:null,delta:null,zone:'unknown_year'};
 const delta=year-ROOT_YEAR,radius=Math.abs(delta)*YEAR_UNIT;
 const direction=paper.relationshipSummary?.primaryDirection||'unresolved';
 const objectDirection=paper.relationshipSummary?.objectDirection||'unresolved';
 const fraction=((paper.recordNumber*0.61803398875)%1);
 const degrees=direction==='unresolved'?fraction*360:DIRECTION_ANGLES[direction]+(fraction-.5)*14;
 const angle=degrees*Math.PI/180;
 const spread=((paper.recordNumber*.7548776662467)%1)*1.8-.9;
 const latitude=direction==='unresolved'?Math.asin(spread):((OBJECT_ELEVATIONS[objectDirection]??0)+(fraction-.5)*6)*Math.PI/180;
 return {x:radius*Math.cos(angle)*Math.cos(latitude),y:radius*Math.sin(latitude),z:radius*Math.sin(angle)*Math.cos(latitude),radius,delta,azimuthDegrees:degrees,elevationDegrees:latitude*180/Math.PI,zone:direction==='unresolved'?'unassigned_3d_scatter':'evidence_direction'};
}
