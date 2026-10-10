const known=new Set('BLIND_FENCED BLIND_OPERATION_ACTIVE BLIND_DELIVERY_UNKNOWN MAINTENANCE_PAUSED ROLE_DENIED MATH_BUSY MATH_ACTIVE WOLFRAM_BUSY TOOL_UNSUPPORTED ENCODING_ERROR RESOURCE_BOUND DEPENDENCY_MISSING ROLE_FIELD_INVALID PROPOSAL_ID_CONFLICT DELIVERY_INCOMPLETE INVENTORY_CONFLICT DELIVERY_EVIDENCE_CHANGED VERSION_CONFLICT'.split(' '));
const oldMessages=new Set('ENCODING_ERROR RESOURCE_BOUND TOOL_UNSUPPORTED DELIVERY_INCOMPLETE INVENTORY_CONFLICT PROPOSAL_ID_CONFLICT DELIVERY_EVIDENCE_CHANGED'.split(' '));
const continuity={
 BLIND_GAP_PAYLOAD:'worker-gap requires code matching ^[A-Z][A-Z0-9_]{2,79}$ and reason of 20 to 4000 characters. Keep longer details in a local checkpoint. No gap receipt was accepted.',
 CONTINUITY_PLAN_CHANGED:'Refresh the exact assigned continuity plan; do not change an accepted receipt.',
 CONTINUITY_IMPACT_REQUIRED:'Account for each cumulative change and list every retained node dependency with the required explanation.',
 CONTINUITY_DEPENDENCY_CHANGED:'A retained claim or dependency has changed or is affected. Keep its real limitation; do not inherit old checking credit.',
 CONTINUITY_HUMAN_REFERENCE_REQUIRED:'Reference a protected unchanged premise using mode human_reference and the exact supplied humanScopeSha256 from reviewContinuity.humanDependencyBindings. Do not reread, judge or recheck it; refresh input if its binding changed.',
 CONTINUITY_IMPACT_CONFLICT:'Impact revisions are immutable. Reuse the accepted receipt or submit the next revision for a corrected assessment.',
 CONTINUITY_IMPACT_STALE:'Use the latest accepted impact receipt for this delta.',
 CONTINUITY_DELTA_INVALID:'Delta rows must have distinct current identifiers.',
 CONTINUITY_RECHECK_UNCHANGED:'Do not submit retained checked items as newly calculated results.',
 CONTINUITY_BASE_MISSING:'The assigned sealed prior inventory is missing; record the concrete lineage gap.',
 CONTINUITY_BASE_CHANGED:'The assigned baseline identity or evidence changed; preserve it and record the concrete lineage gap.',
 CONTINUITY_RESULT_CHANGED:'An original retained result no longer matches its sealed proof.',
 CONTINUITY_LINEAGE_INVALID:'The stored delta lineage cannot be verified; do not invent replacement evidence.',
 HUMAN_FRAGMENT_LOCKED:'This fragment is excluded from new scientific/source judgments. Keep its human scope and submit only remaining work; an unchanged protected premise may be referenced by its supplied human dependency binding.',
 HUMAN_LOCK_CONTENT_CHANGED:'A final human fragment no longer matches its exact decided content. Preserve the decision and report the binding gap.'
};
export function roleDiagnostic(error){return {error:'Role request rejected; no source details are returned.',code:known.has(error.code)||Object.hasOwn(continuity,error.code)?error.code:'ROLE_REQUEST_REJECTED',...(Object.hasOwn(continuity,error.code)?{diagnostic:continuity[error.code]}:oldMessages.has(error.code)?{diagnostic:error.message}:{}),...(error.code==='ROLE_FIELD_INVALID'?{fields:error.fields}:{})};}
