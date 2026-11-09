// Pure, narrowly released append-only correction proof. Never writes or runs science.
import fs from 'node:fs';
import path from 'node:path';
import {canonical, hash, checkRef, validateCandidate} from '../../coverage-core.mjs';
import {validateCandidateScope} from '../../coverage-scope.mjs';
import {guardRequired, guardAdmissionReferences, guardPrevious} from '../../coverage-guard.mjs';

const BASE = 'research_followup/network3_campaign';
export const APPEND_PROTOCOL = BASE + '/protocols/guard-append-v1';
export const APPEND_RELEASE = BASE + '/architecture/guard-append-20261105';
export const APPEND_MODULES = Object.freeze(['append-core.mjs', 'coverage.mjs']);
export const APPEND_UPSTREAM = Object.freeze([
  'paper_library/dot-library.mjs', 'paper_library/library.mjs', 'paper_library/revocations.mjs', 'paper_library/workflow-contract.mjs',
  ...['coverage-context', 'coverage-core', 'coverage-guard', 'coverage-recovery', 'coverage-scan', 'coverage-scope', 'coverage', 'repair-flow'].map(name => BASE + '/' + name + '.mjs'),
  ...['inputs', 'reading', 'results', 'runs'].map(name => 'research_followup/reproduction_clean/runtime/' + name + '.mjs'),
  'research_tree/src/journal-model.mjs', 'research_tree/src/review-model.mjs', 'sources/resolve-source.mjs',
]);
const DIAGNOSTIC = BASE + '/coverage/requests/architecture-diagnostic-r0186-r0187-c002-append-20261105.json';
const SHA = /^[a-f0-9]{64}$/;
const insist = (ok, message) => { if (!ok) throw Error('Append correction: ' + message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => hash(canonical(value));
const equal = (a, b) => canonical(a) === canonical(b);
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (directory, target) => { const rel = path.relative(directory, target); return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const sameRef = (root, a, b) => plain(a) && plain(b) && text(a.path) && text(b.path) && key(path.resolve(root, a.path)) === key(path.resolve(root, b.path)) && a.sha256 === b.sha256;
function shape(value, keys, label) {
  insist(plain(value) && equal(Object.keys(value).sort(), [...keys].sort()), label + ' fields differ');
}
function refShape(ref) { shape(ref, ['path', 'sha256'], 'reference'); insist(text(ref.path) && SHA.test(ref.sha256), 'invalid reference'); }
function expectedRef(root, ref, relative, label) {
  refShape(ref); insist(key(path.resolve(root, ref.path)) === key(path.resolve(root, relative)), label + ' path differs');
}
function raw(root, ref) {
  refShape(ref);
  const filename = checkRef(root, ref), bytes = fs.readFileSync(filename);
  insist(hash(bytes) === ref.sha256, 'actual bytes mismatch: ' + filename);
  return bytes;
}
function json(root, ref) {
  const bytes = raw(root, ref), value = bytes.toString('utf8');
  insist(Buffer.from(value, 'utf8').equals(bytes), 'invalid UTF-8: ' + ref.path);
  return JSON.parse(value.replace(/^\uFEFF/, ''));
}
function uniqueRefs(root, refs) {
  const found = new Map();
  for (const ref of refs) {
    refShape(ref); const name = key(path.resolve(root, ref.path)), old = found.get(name);
    insist(!old || old.sha256 === ref.sha256, 'conflicting reference hashes');
    if (!old) found.set(name, ref);
  }
  return [...found.values()];
}
function refsIn(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Object.hasOwn(value, 'path') && Object.hasOwn(value, 'sha256')) { refShape(value); output.push(value); return output; }
  for (const child of Object.values(value)) refsIn(child, output);
  return output;
}
function exactIds(actual, expected, label) {
  insist(Array.isArray(actual) && actual.every(text) && new Set(actual).size === actual.length && equal([...actual].sort(), [...expected].sort()), label + ' IDs differ');
}
function editionIntegrityRefs(root, scan) {
  const edition = scan.reading.edition;
  insist(edition?.provider === 'dot' && /^dot-[A-Za-z0-9_-]+$/.test(edition.release ?? ''), 'fixed Dot edition required');
  const base = 'reconstructed_sources/' + edition.release;
  const index = {path: path.resolve(root, base + '/index.json'), sha256: edition.indexSha256};
  const recordRef = {path: edition.recordPath, sha256: edition.recordSha256};
  expectedRef(root, recordRef, base + '/papers/' + scan.paperId + '/record.json', 'edition record');
  const indexValue = json(root, index), record = json(root, recordRef);
  const entry = indexValue.papers?.filter(row => row.paperId === scan.paperId);
  insist(entry?.length === 1 && entry[0].version === edition.version && entry[0].record === 'papers/' + scan.paperId + '/record.json' && entry[0].recordSha256 === recordRef.sha256, 'edition index identity differs');
  insist(record.paperId === scan.paperId && record.version === edition.version && record.provider === 'dot' && Array.isArray(record.files?.all), 'edition record identity differs');
  const members = [];
  function member(descriptor, prefix) {
    const ref = {path: descriptor?.path, sha256: descriptor?.sha256}; refShape(ref);
    insist(!path.isAbsolute(ref.path) && !ref.path.includes('\\') && ref.path.split('/').every(part => part && part !== '.' && part !== '..') && ref.path.startsWith(prefix), 'edition member escapes exact package');
    const projected = {path: path.resolve(root, base, ref.path), sha256: ref.sha256}; raw(root, projected); members.push(projected);
  }
  insist(record.archive?.path === 'archives/' + scan.paperId + '.zip' && edition.version === 'dot-' + record.archive.sha256, 'edition archive identity differs');
  member(record.archive, 'archives/');
  for (const ref of record.files.all) member(ref, 'papers/' + scan.paperId + '/');
  // Integrity references only: no added scan resource, source unit, reader grant,
  // or recursive interpretation of arbitrary path-bearing package content.
  return [index, recordRef, ...members];
}

const AUTHORIZATION = BASE + '/coverage/requests/architecture-coordination-r0186-r0187-c002-20261105.json';
const scopeFields = ['paperId','iteration','owner','scan','order','guardEnrollment','original','repaired','audit','baseline','priorSnapshotSha256','historySha256','preserved'];
function validateScope(root, scope) {
  shape(scope, scopeFields, 'repair scope');
  insist(['r0186','r0187'].includes(scope.paperId) && scope.iteration === 2, 'only the two released c002 deliveries are supported');
  shape(scope.owner, ['agent','role','startedAt'], 'owner');
  insist(scope.owner.agent === '/root/cov_' + scope.paperId + '_c002_worker' && scope.owner.role === 'worker' && Number.isFinite(Date.parse(scope.owner.startedAt)), 'original worker identity differs');
  const ledger = BASE + '/coverage/' + scope.paperId, work = 'research_followup/reproduction_clean/coverage_work/' + scope.paperId + '/c002';
  expectedRef(root, scope.scan, ledger + '/scan.json', 'scan');
  expectedRef(root, scope.order, ledger + '/c002/worker.md', 'order');
  shape(scope.guardEnrollment, ['profile','instructions'], 'enrollment');
  expectedRef(root, scope.guardEnrollment.profile, ledger + '/c002/guard-order.json', 'enrollment');
  expectedRef(root, scope.guardEnrollment.instructions, ledger + '/c002/guard-order.md', 'enrollment text');
  shape(scope.original, ['candidate','sourceScope','terminal'], 'original');
  shape(scope.repaired, ['candidate','sourceScope','terminal'], 'repaired');
  const is186 = scope.paperId === 'r0186';
  for (const [ref, name] of [[scope.original.candidate,'candidate.json'],[scope.original.sourceScope,'source-scope.json'],[scope.original.terminal,is186?'terminal-checkpoint.json':'terminal.json'],
    [scope.repaired.candidate,is186?'candidate-repair-v003.json':'candidate.json'],[scope.repaired.sourceScope,is186?'source-scope-repair-v003.json':'source-scope-repair-v002.json'],
    [scope.repaired.terminal,is186?'terminal-repair-v003.json':'terminal-repair-v002.json'],[scope.audit,is186?'candidate-repair-audit-v003.json':'source-scope-repair-v002-audit.json']]) expectedRef(root,ref,work+'/'+name,name);
  shape(scope.baseline,['candidate','review','decision','contract','scopeReview'],'baseline');
  for (const [field,name] of [['candidate','candidate.json'],['review','review.json'],['decision','decision.json'],['contract','source-scope.json'],['scopeReview','scope-review.json']]) expectedRef(root,scope.baseline[field],ledger+'/c001/'+name,'baseline '+field);
  insist(SHA.test(scope.priorSnapshotSha256) && SHA.test(scope.historySha256), 'baseline registration seal missing');
  insist(Array.isArray(scope.preserved) && scope.preserved.length === (is186?27:36) && uniqueRefs(root,scope.preserved).length === scope.preserved.length, 'preserved file inventory differs');
  for (const ref of scope.preserved) insist(inside(path.resolve(root,work),path.resolve(root,ref.path)), 'preserved file outside original owner root');
}

export function loadAppendRelease({root, reference}) {
  insist(text(root) && path.isAbsolute(root), 'absolute root required');
  expectedRef(root,reference,APPEND_RELEASE+'/release-manifest.json','release');
  const manifest=json(root,reference), references=[reference];
  shape(manifest,['schemaVersion','releaseId','modules','upstream','diagnostic','authorization','repairScopes'],'release');
  insist(manifest.schemaVersion===1 && manifest.releaseId==='guard-append-20261105','wrong release');
  exactIds(manifest.modules?.map(x=>x.name),APPEND_MODULES,'modules');
  for(const row of manifest.modules){
    shape(row,['name','installed','frozen'],'module');
    expectedRef(root,row.installed,APPEND_PROTOCOL+'/'+row.name,'installed module');
    expectedRef(root,row.frozen,APPEND_RELEASE+'/release/'+row.name,'frozen module');
    insist(row.installed.sha256===row.frozen.sha256 && raw(root,row.installed).equals(raw(root,row.frozen)),'installed/frozen module mismatch');references.push(row.installed,row.frozen);
  }
  exactIds(manifest.upstream?.map(x=>x.name),APPEND_UPSTREAM,'upstream');
  for(const row of manifest.upstream){shape(row,['name','ref'],'upstream');expectedRef(root,row.ref,row.name,'upstream');raw(root,row.ref);references.push(row.ref);}
  expectedRef(root,manifest.diagnostic,DIAGNOSTIC,'diagnostic');expectedRef(root,manifest.authorization,AUTHORIZATION,'authorization');
  const diagnostic=json(root,manifest.diagnostic), authorization=json(root,manifest.authorization);
  insist(diagnostic.schemaVersion===1 && diagnostic.scientificAcceptance===false && Array.isArray(diagnostic.papers),'invalid diagnostic');
  insist(authorization.schemaVersion===1 && authorization.authorization?.source==='direct_human_reply_in_sending_chat' && authorization.authorization.reply==='允许发送并协调修复' && sameRef(root,authorization.diagnostic,manifest.diagnostic),'missing exact human coordination authority');
  exactIds(manifest.repairScopes?.map(s=>s.paperId),['r0186','r0187'],'released papers');
  for(const scope of manifest.repairScopes){
    validateScope(root,scope);const rows=diagnostic.papers.filter(p=>p.paperId===scope.paperId);insist(rows.length===1,'ambiguous diagnostic paper');
    for(const field of ['paperId','iteration','owner','scan','order','guardEnrollment','original','repaired','audit']) insist(equal(scope[field],rows[0][field]),'release differs from diagnostic: '+field);
    insist(rows[0].preservedOriginalFileCount===scope.preserved.length,'diagnostic preservation count differs');
  }
  references.push(manifest.diagnostic,manifest.authorization);
  return {manifest,references};
}

function terminalProof(root,scope,old,terminal,audit) {
  for(const t of [old,terminal]) insist(t.schemaVersion===1&&t.paperId===scope.paperId&&t.revision===2&&t.agent===scope.owner.agent&&t.ownerFinished===true&&t.noActiveCalculation===true&&t.workerCount===1&&t.scientificAcceptance===false,'terminal identity/completion differs');
  insist(audit.schemaVersion===1&&audit.paperId===scope.paperId&&audit.revision===2&&audit.author===scope.owner.agent,'audit identity differs');
  insist(sameRef(root,old.candidate,scope.original.candidate)&&sameRef(root,old.sourceScope,scope.original.sourceScope),'original terminal delivery differs');
  insist(sameRef(root,terminal.candidate,scope.repaired.candidate),'repaired terminal candidate differs');
  const is186=scope.paperId==='r0186', oldTime=Date.parse(is186?old.completedAt:old.frozenAt), newTime=Date.parse(is186?terminal.completedAt:terminal.frozenAt);
  insist((is186?old.assignmentStartedAt:old.registeredStartedAt)===scope.owner.startedAt&&Number.isFinite(oldTime)&&oldTime>=Date.parse(scope.owner.startedAt)&&Number.isFinite(newTime)&&newTime>oldTime,'terminal registration/time differs');
  let preserved;
  if(is186){
    insist(old.role==='worker'&&terminal.role==='worker'&&terminal.assignmentStartedAt===scope.owner.startedAt&&terminal.repairVersion===3&&terminal.newScientificExecutions===0&&terminal.terminalState==='repair_frozen_ready_for_supervisor_intake_awaiting_scientific_review','r0186 repair terminal differs');
    insist(sameRef(root,terminal.sourceScope,scope.repaired.sourceScope)&&sameRef(root,terminal.deltaAndRetentionEvidence,scope.audit),'r0186 repair bindings differ');
    for(const [field,ref] of [['originalCandidate',scope.original.candidate],['originalSourceScope',scope.original.sourceScope],['originalTerminal',scope.original.terminal],['publicPriorCandidate',scope.baseline.candidate],['publicPriorDecision',scope.baseline.decision],['publicPriorScope',scope.baseline.contract]]) insist(sameRef(root,terminal.retentionChain?.[field],ref),'r0186 retention binding differs: '+field);
    const saved=terminal.preservation?.preExistingFiles;
    insist(Array.isArray(saved)&&saved.every(r=>r.identical===true),'r0186 preservation attestation missing');preserved=saved.map(({path,sha256})=>({path,sha256}));
  }else{
    insist(terminal.repairVersion==='v002'&&terminal.state==='append_only_source_scope_repair_frozen'&&Array.isArray(terminal.processState?.activeCalculations)&&terminal.processState.activeCalculations.length===0&&terminal.processState.backgroundJobs===0&&terminal.processState.newScientificExperiments===0,'r0187 repair terminal differs');
    for(const [field,ref] of [['repairedSourceScope',scope.repaired.sourceScope],['originalSourceScope',scope.original.sourceScope],['originalTerminal',scope.original.terminal],['previousPublicSourceScope',scope.baseline.contract],['audit',scope.audit]]) insist(sameRef(root,terminal[field],ref),'r0187 repair binding differs: '+field);
    preserved=audit.allPreexistingFilesUnchanged?.map(({path,sha256})=>({path,sha256}));
  }
  insist(Array.isArray(preserved)&&preserved.length===scope.preserved.length&&uniqueRefs(root,preserved).length===preserved.length,'terminal preservation inventory differs');
  for(const ref of scope.preserved) insist(preserved.some(r=>sameRef(root,r,ref)),'preserved hash not bound by terminal/audit');
  for(const ref of Object.values(scope.original)) insist(scope.preserved.some(r=>sameRef(root,r,ref)),'original delivery omitted from preservation');
}

function candidateProof(root,scope,original,candidate) {
  if(scope.paperId==='r0187'){
    insist(raw(root,scope.original.candidate).equals(raw(root,scope.repaired.candidate)),'r0187 candidate bytes changed');return [];
  }
  const derived=structuredClone(original), edits=[['r0186:i0035:o01',1],['r0186:i0073:o01',2]];
  for(const [id,index] of edits){const a=derived.assessments.filter(a=>a.obligationId===id);insist(a.length===1&&a[0].evidence[index]?.method==='numeric_test','exact old method missing');a[0].evidence[index].method='implementation_test';}
  insist(equal(derived,candidate),'candidate changes exceed two runtime method corrections');return edits.map(([obligationId,evidenceIndex])=>({obligationId,evidenceIndex,from:'numeric_test',to:'implementation_test'}));
}

function scopeProof(original,contract,previous,candidate,oldCandidate) {
  const remove=x=>Object.fromEntries(Object.entries(x).filter(([k])=>!['cards','alignments','legacyRetainedObligationIds','candidateSha256'].includes(k)));
  const header=structuredClone(remove(original));
  // The exact r0186 repair carries a provenance-only disclaimer. Complete and
  // missingClaims remain unchanged; this note is not inventory acceptance.
  if(candidate.paperId==='r0186')header.inventory.notes += ' Append-only original-author repair v002 restores the 47 previously guarded accepted alignments and their exact c001 source cards; no already-guarded obligation is reclassified as exempt legacy credit. The 12 mixed-item unresolved originals remain unknown; only their claim references are reconciled to the restored cards. Restoration does not assert prior inventory acceptance or new scientific acceptance.';
  insist(equal(header,remove(contract))&&original.candidateSha256===digest(oldCandidate)&&contract.candidateSha256===digest(candidate),'scope unrelated fields/candidate binding changed');
  insist(Array.isArray(original.legacyRetainedObligationIds)&&original.legacyRetainedObligationIds.length>0&&Array.isArray(contract.legacyRetainedObligationIds)&&contract.legacyRetainedObligationIds.length===0,'guard restoration must remove all false exemptions');
  const map=(rows,key)=>{const m=new Map(rows.map(x=>[x[key],x]));insist(m.size===rows.length,'duplicate proof row');return m;};
  const items=map(candidate.inventory.items,'id'),oldItems=map(previous.candidate.inventory.items,'id'),assessments=map(candidate.assessments,'obligationId'),oldAssessments=map(previous.candidate.assessments,'obligationId');
  const oldCards=map(original.cards,'itemId'),priorCards=map(previous.contract.cards,'itemId'),oldRows=map(original.alignments,'obligationId'),priorRows=map(previous.contract.alignments,'obligationId');
  const cards=map(contract.cards,'itemId'),rows=map(contract.alignments,'obligationId'),accepted=new Set(previous.decision.acceptedObligationIds),obligationItems=new Map();
  for(const item of items.values())for(const o of item.obligations)obligationItems.set(o.id,item.id);
  for(const id of original.legacyRetainedObligationIds){
    const itemId=obligationItems.get(id);insist(accepted.has(id)&&oldItems.has(itemId)&&equal(items.get(itemId),oldItems.get(itemId))&&equal(assessments.get(id),oldAssessments.get(id)),'false exemption is not exact prior accepted content');
    insist(priorRows.has(id)&&equal(rows.get(id),priorRows.get(id))&&equal(cards.get(itemId),priorCards.get(itemId)),'prior guarded row/card not restored exactly');
  }
  for(const id of oldCards.keys())insist(cards.has(id),'original scope card deleted');
  for(const id of oldRows.keys())insist(rows.has(id),'original scope alignment deleted');
  let restoredCards=0,restoredRows=0,reboundRows=0;
  for(const [id,card] of cards){
    insist(items.has(id)&&card.itemSha256===digest(items.get(id)),'scope card binding differs');
    if(oldCards.has(id)&&equal(card,oldCards.get(id)))continue;
    insist(priorCards.has(id)&&equal(card,priorCards.get(id)),'changed card is not exact prior guarded card');restoredCards++;
  }
  for(const [id,row] of rows){
    const item=items.get(obligationItems.get(id)),o=item?.obligations.find(x=>x.id===id),a=assessments.get(id);
    insist(o&&a&&row.obligationSha256===digest(o)&&row.assessmentSha256===digest(a),'scope alignment binding differs');
    if(oldRows.has(id)&&equal(row,oldRows.get(id)))continue;
    if(priorRows.has(id)&&equal(row,priorRows.get(id))){restoredRows++;continue;}
    const old=oldRows.get(id);insist(old,'new alignment must be exact prior guarded row');
    const remap=structuredClone(old);remap.claimIds=row.claimIds;remap.assessmentSha256=digest(a);
    insist(equal(row,remap),'alignment changed beyond claim-ID/method-hash rebinding');
    insist(Array.isArray(row.claimIds)&&row.claimIds.length===old.claimIds.length&&new Set(row.claimIds).size===row.claimIds.length&&row.claimIds.every(claim=>cards.get(item.id)?.claims.some(c=>c.id===claim)),'claim-ID remap differs from selected same-item card');reboundRows++;
  }
  return {falseLegacyExemptionsRemoved:original.legacyRetainedObligationIds.length,restoredCards,restoredRows,reboundRows};
}

// verifyResult validates entire frozen runs, not merely the cited artifact.
// Seal the exact same-paper run directories before that validator executes,
// then recheck bytes AND membership. This includes failed attempts and receipts
// without interpreting arbitrary path-bearing result/receipt content.
function legacyRunSnapshot(root,scan) {
  const result=json(root,scan.firstPass.result),references=[],trees=[];
  insist(result.paperId===scan.paperId&&Array.isArray(result.runBindings),'typed first-pass run bindings required');
  const runIds=new Set();
  function files(directory){
    const out=[];
    function visit(dir){insist(fs.lstatSync(dir).isDirectory()&&!fs.lstatSync(dir).isSymbolicLink(),'redirected frozen run directory');out.push(dir+path.sep);for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isDirectory())visit(file);else{insist(entry.isFile()&&!entry.isSymbolicLink(),'non-regular frozen run member');out.push(file);}}}
    visit(directory);return out;
  }
  for(const binding of result.runBindings){
    shape(binding,['runId','runSha256'],'run binding');
    insist(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(binding.runId)&&!binding.runId.includes('..')&&!runIds.has(binding.runId)&&SHA.test(binding.runSha256),'invalid/duplicate run identity');runIds.add(binding.runId);
    const directory=path.resolve(root,'research_followup/reproduction_clean/runs',scan.paperId,binding.runId),runRef={path:path.join(directory,'run.json'),sha256:binding.runSha256};raw(root,runRef);
    const members=files(directory);trees.push({directory,members});
    for(const filename of members){if(filename.endsWith(path.sep))continue;const ref={path:filename,sha256:hash(fs.readFileSync(filename))};raw(root,ref);references.push(ref);}
    insist(references.some(ref=>sameRef(root,ref,runRef)),'run changed during dependency capture');
  }
  for(const prior of result.supersedes??[]){insist(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prior.resultId)&&!prior.resultId.includes('..')&&SHA.test(prior.sha256),'invalid superseded result');references.push({path:path.resolve(root,'research_followup/reproduction_clean/results',scan.paperId,prior.resultId+'.json'),sha256:prior.sha256});}
  const membership=trees.map(tree=>({runId:path.basename(tree.directory),memberCount:tree.members.length,membershipSha256:digest(tree.members.map(member=>path.relative(tree.directory,member).split(path.sep).join('/')+(member.endsWith(path.sep)?'/':'')))}));
  const recheck=()=>{for(const tree of trees)insist(equal(files(tree.directory),tree.members),'frozen run membership changed');for(const ref of references)raw(root,ref);};recheck();return {references,recheck,membership};
}

/** Pure exact-delivery proof; never writes, dispatches or grants scientific credit. */
export async function prepareAppendCorrection({root,state,paper,request}) {
  shape(request,['schemaVersion','expectedRevision','paperId','iteration','agent','ownerFinished','noActiveCalculation','supervisor','reason','releaseManifest','scan','order','guardEnrollment','original','repaired','audit'],'request');
  const release=loadAppendRelease({root,reference:request.releaseManifest}),{manifest}=release,scope=manifest.repairScopes.find(s=>s.paperId===request.paperId);
  insist(scope&&request.schemaVersion===1&&Number.isSafeInteger(request.expectedRevision)&&request.expectedRevision===state.revision,'unknown paper/stale revision');
  insist(paper&&paper.phase==='working'&&paper.iteration===2&&!paper.staged&&paper.latest?.iteration===1&&Array.isArray(paper.history)&&!Object.hasOwn(paper,'sourceEnrollment'),'only ordinary working c002 with bound c001 is admissible');
  insist(state.papers.filter(p=>p.paperId===paper.paperId).length===1&&equal(state.papers.find(p=>p.paperId===paper.paperId),paper),'paper is not exact live registration');
  insist(paper.paperId===scope.paperId&&request.iteration===2&&request.agent===scope.owner.agent&&equal(paper.owner,scope.owner),'original owner identity differs');
  insist(request.ownerFinished===true&&request.noActiveCalculation===true&&text(request.reason),'current natural completion attestation required');
  const authority=json(root,state.authority);insist(request.supervisor===(authority.supervisorThreadId??authority.supervisor?.threadId),'scientific supervisor differs');
  for(const k of ['scan','order','guardEnrollment','original','repaired','audit'])insist(equal(request[k],scope[k]),'request differs from exact released pair: '+k);
  for(const k of ['scan','order','guardEnrollment'])insist(equal(paper[k],scope[k]),'live binding differs: '+k);
  insist(digest(paper.latest)===scope.priorSnapshotSha256&&digest(paper.history)===scope.historySha256,'previous snapshot/history changed');
  const baseline={candidate:paper.latest.candidate,review:paper.latest.review,decision:paper.latest.decision,contract:paper.latest.guard?.contract,scopeReview:paper.latest.guard?.scopeReview};
  insist(equal(baseline,scope.baseline),'previous guarded bindings differ');
  const work=path.resolve(root,'research_followup/reproduction_clean/coverage_work/'+scope.paperId+'/c002');
  insist(text(paper.workRoot)&&key(path.resolve(root,paper.workRoot))===key(work)&&guardRequired(root,state,paper),'registered work root or guard differs');
  const references=[...release.references,state.authority,...guardAdmissionReferences(root,state,paper),...refsIn(scope),...(paper.latest.guard?.references??[])];
  const previous=guardPrevious(root,paper.latest,{candidate:json(root,baseline.candidate),sha256:baseline.candidate.sha256,review:json(root,baseline.review),decision:json(root,baseline.decision)});
  insist(previous.contract&&previous.scopeReview,'previous full guarded snapshot required');
  const scan=json(root,scope.scan),original=json(root,scope.original.candidate),candidate=json(root,scope.repaired.candidate),oldScope=json(root,scope.original.sourceScope),contract=json(root,scope.repaired.sourceScope);
  insist(scan.paperId===scope.paperId&&digest(scan)===scope.scan.sha256&&original.author===scope.owner.agent&&candidate.author===scope.owner.agent&&candidate.revision===2&&candidate.predecessorSha256===baseline.candidate.sha256,'source/author/revision/predecessor mismatch');
  terminalProof(root,scope,json(root,scope.original.terminal),json(root,scope.repaired.terminal),json(root,scope.audit));
  const methodEdits=candidateProof(root,scope,original,candidate),restoration=scopeProof(oldScope,contract,previous,candidate,original);
  const allowed=new Set(paper.allowedScope),oldById=new Map(previous.candidate.assessments.map(a=>[a.obligationId,a]));
  for(const assessment of candidate.assessments){const old=oldById.get(assessment.obligationId);if(old&&previous.decision.acceptedObligationIds.includes(assessment.obligationId)&&!equal(old,assessment)&&!allowed.has(assessment.obligationId)){const impact=candidate.changeImpact?.find(x=>x.obligationId===assessment.obligationId);insist(impact&&text(impact.reason)&&Array.isArray(impact.dependsOnChangedItems)&&impact.dependsOnChangedItems.length,'changed retained assessment lacks declared dependency impact');}}
  const readingRefs=[scan.reading.originalPacket,scan.reading.primary,...(scan.reading.original?[scan.reading.original]:[]),...(scan.reading.latexEntries??[]),...(scan.reading.dependencies??[]),...(scan.reading.assets??[])].map(({path,sha256})=>({path,sha256}));
  references.push(...scan.resources.map(({path,sha256})=>({path,sha256})),...readingRefs,...Object.values(scan.firstPass),...editionIntegrityRefs(root,scan));
  const legacy=legacyRunSnapshot(root,scan);references.push(...legacy.references);
  for(const ref of uniqueRefs(root,references))raw(root,ref);
  await validateCandidate({root,scan,scanSha256:scope.scan.sha256,candidate,previous});
  validateCandidateScope({root,scan,candidate,candidateSha256:digest(candidate),contract,author:scope.owner.agent,previous});
  // Capture only typed validator evidence and direct execution edges, never
  // recursively turn arbitrary path-bearing metadata into read permission.
  for(const assessment of candidate.assessments)for(const evidence of assessment.evidence){
    references.push(...evidence.artifacts);
    if(evidence.execution?.receipt){references.push(evidence.execution.receipt);const receipt=json(root,evidence.execution.receipt);references.push(...(receipt.inputs??[]),...(receipt.outputs??[]));}
  }
  const checked=uniqueRefs(root,references),recheck=()=>{legacy.recheck();for(const ref of checked)raw(root,ref);};recheck();
  return {manifest,scan,candidate,contract,references:checked,recheck,proof:{schemaVersion:1,verification:'mechanical_guard_restoration_not_scientific_acceptance',paperId:scope.paperId,iteration:2,methodEdits,...restoration,frozenRuns:legacy.membership,preservedFileCount:scope.preserved.length,originalCandidateSha256:scope.original.candidate.sha256,repairedCandidateSha256:scope.repaired.candidate.sha256,originalScopeSha256:scope.original.sourceScope.sha256,repairedScopeSha256:scope.repaired.sourceScope.sha256}};
}

