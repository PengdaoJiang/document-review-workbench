// Compact, role-scoped projections, not replacements for the complete academic inputs.
import fs from 'node:fs';
import path from 'node:path';
import {canonical, hash, checkRef, fileRef} from './coverage-core.mjs';

export const campaignRelative = 'research_followup/network3_campaign';
export const insist = (value, message) => { if (!value) throw Error('Coverage kit: ' + message); };
export const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
export const bound = (root, ref) => read(checkRef(root, ref));
export function safeWithin(root, filename) {
  insist(typeof filename === 'string' && filename.length > 0, 'Missing path');
  const segments = filename.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '').split('/');
  insist(!segments.some(segment => segment === '..' || segment === '.' || segment.includes(':')), 'Traversal/alternate stream path');
  const target = path.resolve(root, filename), relative = path.relative(path.resolve(root), target);
  insist(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Path escapes authorized root');
  let cursor = target;
  while (true) {
    if (fs.existsSync(cursor)) insist(!fs.lstatSync(cursor).isSymbolicLink(), 'Redirected path');
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return target;
}
export function loadPaper(root, paperId) {
  root = path.resolve(root);
  const statePath = safeWithin(root, campaignRelative + '/coverage/state.json'), state = read(statePath);
  const authorityPath = safeWithin(root, 'docs/network3-coverage-authorization-20261024.json');
  insist(path.resolve(root, state.authority.path) === authorityPath && state.authority.sha256 === fileRef(root, authorityPath).sha256, 'Ledger authority differs from installed authority');
  const authority = bound(root, state.authority), scope = bound(root, authority.scopeAuthority);
  insist(Array.isArray(scope.scope.paperIds) && scope.scope.paperIds.length === 53 && new Set(scope.scope.paperIds).size === 53, 'Invalid fixed scope');
  insist(canonical([...state.scope].sort()) === canonical([...scope.scope.paperIds].sort()), 'Scope mismatch');
  const nodes = bound(root, scope.scope.nodes), closure = bound(root, authority.firstPassClosure);
  insist(canonical(nodes.map(node => node.paper_id).sort()) === canonical([...state.scope].sort()), 'Authorized nodes mismatch');
  insist(closure.status === 'first_pass_complete_bounded' && canonical(closure.papers.map(value => value.paperId).sort()) === canonical([...state.scope].sort()), 'Baseline closure membership mismatch');
  const matches = state.papers.filter(paper => paper.paperId === paperId);
  insist(scope.scope.paperIds.includes(paperId) && matches.length === 1, 'Unknown/out-of-scope paper');
  const paper = matches[0]; insist(paper.scan, 'Paper not prepared');
  const baseline = closure.papers.find(value => value.paperId === paperId);
  for (const key of ['result', 'review', 'acceptance']) insist(canonical(paper.firstPass[key]) === canonical({path: baseline[key].path, sha256: baseline[key].sha256}), 'Baseline differs from frozen closure');
  const scan = bound(root, paper.scan);
  insist(scan.paperId === paperId && hash(canonical(scan)) === paper.scan.sha256, 'Noncanonical/mismatched scan');
  insist(canonical(scan.firstPass) === canonical(Object.fromEntries(['result', 'review', 'acceptance'].map(key => [key, paper.firstPass[key]]))), 'Baseline mismatch');
  for (const resource of scan.resources) checkRef(root, {path: resource.path, sha256: resource.sha256});
  return {root, paper, scan, statePath};
}
export function previousFor(root, paper) {
  if (!paper.latest) return null;
  return {candidate: bound(root, paper.latest.candidate), sha256: paper.latest.candidate.sha256,
    review: bound(root, paper.latest.review), decision: bound(root, paper.latest.decision)};
}
const page = (offset = '0', limit = '20') => {
  insist(/^\d+$/.test(String(offset)) && /^\d+$/.test(String(limit)), 'Invalid page');
  const start = Number(offset), count = Number(limit);
  insist(Number.isSafeInteger(start) && count >= 1 && count <= 50, 'Page limit must be 1..50');
  return {start, count};
};
export function contextFor(binding, role) {
  insist(['worker', 'reviewer'].includes(role), 'Expected worker or reviewer role');
  const {root, paper, scan} = binding;
  if (paper.owner) insist(paper.owner.role === role, 'Context role differs from active owner; this is a routing check, not OS authentication');
  const result = bound(root, paper.firstPass.result);
  insist(result.paperId === paper.paperId, 'Public result paper mismatch');
  const previous = paper.latest ? bound(root, paper.latest.decision) : null;
  if (previous) insist(previous.paperId === paper.paperId && previous.scanSha256 === paper.scan.sha256 && previous.candidateSha256 === paper.latest.candidate.sha256 && previous.reviewSha256 === paper.latest.review.sha256, 'Previous decision binding mismatch');
  const resources = scan.resources.map(resource => {
    const units = scan.units.filter(unit => unit.resourceId === resource.id);
    return {...resource, unitCounts: Object.fromEntries([...new Set(units.map(unit => unit.kind))].map(kind => [kind, units.filter(unit => unit.kind === kind).length]))};
  });
  return {schemaVersion: 1, paperId: paper.paperId, role, phase: paper.phase, iteration: paper.iteration,
    owner: paper.owner, order: role === 'worker' ? paper.order : paper.staged?.reviewOrder ?? null,
    outputRoot: role === 'worker' ? paper.workRoot : paper.staged?.reviewRoot ?? null,
    source: {scan: paper.scan, inputVersion: scan.inputVersion, resources, unitCount: scan.units.length, diagnostics: scan.diagnostics},
    publicBaseline: {result: paper.firstPass.result, acceptance: paper.firstPass.acceptance, claimCount: result.claims.length,
      claimIndexCommand: `node ${campaignRelative}/coverage-kit.mjs claims ${paper.paperId} 0 20`},
    previous: paper.latest ? {candidate: paper.latest.candidate, decision: paper.latest.decision,
      acceptedObligationIds: previous.acceptedObligationIds, metrics: paper.latest.metrics} : null,
    selectedObligationIds: paper.allowedScope ?? [], reopenReasons: paper.reopenReasons ?? {},
    ...(role === 'reviewer' ? {candidate: paper.staged?.candidate ?? null, privateReviewReferences: {firstPass: paper.firstPass.review, previous: paper.latest?.review ?? null}} : {}),
    rules: ['This is navigation, not a scientific summary or completion claim. Read the entire bound academic package; graphics and macro-generated statements remain in scope.',
      'Read the frozen role order and COVERAGE_AUTHORING.md. Full source and public evidence remain available on demand; do not bulk-read scans, historical governance, or implementation modules.',
      'Construction does not read private verification tests. Exact private-reference byte checks by validators do not expose their contents.',
      'Reuse only exact applicable accepted evidence; independently establish completeness and verify obligations. No auto-pass, numerical-to-general-proof promotion, or reduced acceptance gate.']};
}
export function claimsFor(binding, offset, limit) {
  const {root, paper} = binding, result = bound(root, paper.firstPass.result), {start, count} = page(offset, limit);
  insist(result.paperId === paper.paperId, 'Public result paper mismatch');
  return {paperId: paper.paperId, result: paper.firstPass.result, total: result.claims.length, offset: start,
    nextOffset: start + count < result.claims.length ? start + count : null,
    claims: result.claims.slice(start, start + count).map(claim => ({claimId: claim.claimId, status: claim.status,
      conclusion: claim.conclusion, testedScope: claim.testedScope, limitations: claim.limitations, evidence: claim.evidence.map(evidence => {
        insist(/^[A-Za-z0-9_-]+$/.test(evidence.runId), 'Invalid frozen evidence run ID');
        const runRoot = safeWithin(root, `research_followup/reproduction_clean/runs/${paper.paperId}/${evidence.runId}`);
        const artifactPath = safeWithin(runRoot, evidence.path);
        checkRef(root, {path: artifactPath, sha256: evidence.sha256});
        return {...evidence, resolvedArtifact: {path: artifactPath, sha256: evidence.sha256}};
      })})),
    note: 'Public exact same-paper evidence index only. Read its contract conditions/source scope when evaluating applicability; this index does not confer coverage credit.'};
}
export function unitsFor(binding, resourceId, offset, limit) {
  const {root, scan, paper} = binding, resource = scan.resources.find(value => value.id === resourceId);
  insist(resource, 'Unknown resource'); const {start, count} = page(offset, limit);
  const units = scan.units.filter(value => value.resourceId === resourceId);
  const source = resource.type === 'text' ? fs.readFileSync(checkRef(root, {path: resource.path, sha256: resource.sha256}), 'utf8') : null;
  return {paperId: paper.paperId, resource, total: units.length, offset: start,
    nextOffset: start + count < units.length ? start + count : null,
    units: units.slice(start, start + count).map(unit => {
      if (source === null) return unit;
      const excerpt = source.slice(unit.start, unit.end), maximum = 1200;
      return {...unit, excerpt: excerpt.slice(0, maximum), excerptTruncated: excerpt.length > maximum};
    }), note: 'Offsets are UTF-16, end-exclusive. Truncated excerpts are navigation only; read the exact full source range. Scanner candidates are not a completeness oracle.'};
}
