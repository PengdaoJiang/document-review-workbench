// Additive authoring CLI. Never dispatches, accepts, or mutates the scientific ledger.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical, fileRef, sameSourceBinding} from './coverage-core.mjs';
import {assembleCandidate, assembleReview} from './coverage-authoring.mjs';
import {writeOnceOrMatch} from '../../repair-flow.mjs';
import {campaignRelative, insist, read, bound, safeWithin, loadPaper, previousFor, contextFor, unitsFor, claimsFor} from './coverage-context.mjs';

export async function runKit(root, argv) {
  root = path.resolve(root);
  const [command, paperId, ...args] = argv;
  if (!command || command === 'help') return {commands: ['context <paperId> worker|reviewer', 'claims <paperId> [offset=0] [limit=20]', 'units <paperId> <resourceId> [offset=0] [limit=20]', 'assemble <paperId> <specPath> <newOutputPath>', 'assemble-review <paperId> <specPath> <newOutputPath>'], gate: 'Only deterministic assembly. Existing coverage CLI, validators, independent review and supervisor decisions remain mandatory.'};
  insist(['context', 'claims', 'units', 'assemble', 'assemble-review'].includes(command), 'Unknown command');
  const binding = loadPaper(root, paperId), {paper, scan} = binding;
  if (command === 'context') { insist(args.length === 1, 'Expected role'); return contextFor(binding, args[0]); }
  if (command === 'claims') { insist(args.length <= 2, 'Unexpected arguments'); return claimsFor(binding, ...args); }
  if (command === 'units') { insist(args.length >= 1 && args.length <= 3, 'Expected resource and optional page'); return unitsFor(binding, ...args); }
  const role = command === 'assemble' ? 'worker' : 'reviewer';
  insist(args.length === 2, 'Expected spec and new output path');
  insist(paper.owner?.role === role && paper.phase === (role === 'worker' ? 'source_working' : 'source_reviewing'), 'No active matching registered owner');
  const version = 'c' + String(paper.iteration).padStart(3, '0');
  const expectedRoot = `research_followup/reproduction_clean/${role === 'worker' ? 'coverage_work' : 'coverage_verifications'}/${paperId}/${version}`;
  const assignedRoot = role === 'worker' ? paper.workRoot : paper.staged.reviewRoot;
  insist(path.resolve(root, assignedRoot) === path.resolve(root, expectedRoot), 'Output root differs from registered paper/version');
  const workRoot = safeWithin(root, assignedRoot);
  const specPath = safeWithin(workRoot, path.resolve(root, args[0])), outputPath = safeWithin(workRoot, path.resolve(root, args[1]));
  insist(specPath.toLowerCase() !== outputPath.toLowerCase(), 'Output cannot overwrite its specification');
  insist(outputPath.endsWith('.json'), 'Output must be JSON');
  insist(!['candidate.json', 'review.json'].includes(path.basename(outputPath).toLowerCase()), 'Preserve legacy delivery names; use candidate-source-v2.json or review-source-v2.json');
  const specRef = fileRef(root, specPath), spec = bound(root, specRef);
  sameSourceBinding(root, spec.sourceBinding, paper.sourceEnrollment.sourceBinding, 'authoring enrolled source binding');
  const previous = previousFor(root, paper);
  let assembled;
  if (role === 'worker') {
    insist(spec.author === paper.owner.agent, 'Spec author differs from registered owner');
    assembled = await assembleCandidate({root, scan, scanSha256: paper.scan.sha256, spec, previous});
    insist(assembled.candidate.revision === paper.iteration, 'Revision differs from registered work');
    // Mirror the unchanged supervisor intake delta guard; no credit or ledger mutation.
    if (previous) {
      const allowed = new Set(paper.allowedScope), oldById = new Map(previous.candidate.assessments.map(value => [value.obligationId, value]));
      for (const assessment of assembled.candidate.assessments) {
        const old = oldById.get(assessment.obligationId);
        if (old && previous.decision.acceptedObligationIds.includes(assessment.obligationId) && canonical(old) !== canonical(assessment) && !allowed.has(assessment.obligationId)) {
          const impact = assembled.candidate.changeImpact?.find(value => value.obligationId === assessment.obligationId);
          insist(impact && typeof impact.reason === 'string' && impact.reason.trim() && Array.isArray(impact.dependsOnChangedItems) && impact.dependsOnChangedItems.length, 'Changed retained assessment needs explicit dependency-impact explanation');
        }
      }
    }
  } else {
    const candidate = bound(root, paper.staged.candidate);
    insist(candidate.revision === paper.iteration, 'Staged candidate revision mismatch');
    assembled = await assembleReview({root, scan, candidate, candidateSha256: paper.staged.candidate.sha256, spec,
      reviewer: paper.owner.agent, worker: paper.staged.worker, previous});
  }
  // Check this paper again; unrelated papers may legitimately advance concurrently.
  const current = loadPaper(root, paperId);
  insist(canonical(current.paper) === canonical(paper), 'Paper ownership/version changed during assembly; no output written');
  insist(fileRef(root, specPath).sha256 === specRef.sha256, 'Specification changed during assembly');
  safeWithin(workRoot, outputPath);
  const value = role === 'worker' ? assembled.candidate : assembled.review;
  writeOnceOrMatch(outputPath, canonical(value));
  return {paperId, role, output: fileRef(root, outputPath), summary: assembled.summary,
    valid: assembled.check.valid, ledgerWritten: false, scientificAcceptance: false,
    next: 'Report this path to the supervisor. The unchanged coverage intake/review/decide workflow is still required.'};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  runKit(root, process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value, null, 2) + '\n'))
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
