// Additive, read-only source-scope checks. This is NOT a semantic classifier,
// scientific acceptance, inventory oracle, runner, or replacement for core gates.
import fs from 'node:fs';
import path from 'node:path';
import {canonical, hash, checkRef, sameSourceBinding} from './coverage-core.mjs';

import {resolveSourceView} from './source-binding.mjs';

const fail = (ok, message) => { if (!ok) throw Error('Coverage scope: ' + message); };
const objectHash = value => hash(canonical(value));
const text = value => typeof value === 'string' && value.trim().length > 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const TARGETS = ['not_empirical', 'statistical', 'scientific', 'exact_historical', 'unspecified'];
const RELATIONS = ['original', 'subclaim', 'conditional_variant', 'narrower_variant', 'stronger_variant', 'auxiliary', 'not_author_claim', 'unknown'];
const VERIFICATION = 'mechanical_source_scope_not_scientific_acceptance';
function shape(value, fields, label, optional = []) {
  fail(plain(value), label + ' must be an object');
  for (const key of fields) fail(Object.hasOwn(value, key), label + ': missing ' + key);
  for (const key of Object.keys(value)) fail([...fields, ...optional].includes(key), label + ': unexpected ' + key);
}
function array(value, label) { fail(Array.isArray(value), label + ' must be an array'); return value; }
function strings(value, label, nonempty = false) {
  array(value, label); fail(value.every(text) && (!nonempty || value.length > 0), label + ' needs explicit strings');
  fail(new Set(value).size === value.length, label + ' contains duplicates'); return value;
}
function index(values, field, label) {
  const result = new Map();
  for (const value of array(values, label)) { fail(plain(value) && text(value[field]) && !result.has(value[field]), label + ' has missing/duplicate ' + field); result.set(value[field], value); }
  return result;
}
function exact(actual, expected, label) {
  strings(actual, label); fail(actual.length === expected.length && actual.every(id => expected.includes(id)), label + ' must exactly cover expected IDs');
}
function boundary(source, at) { return at === 0 || at === source.length || !(source.charCodeAt(at - 1) >= 0xd800 && source.charCodeAt(at - 1) <= 0xdbff && source.charCodeAt(at) >= 0xdc00 && source.charCodeAt(at) <= 0xdfff); }
function range(source, start, end, label) {
  fail(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= source.length, label + ' invalid UTF-16 range');
  fail(boundary(source, start) && boundary(source, end), label + ' splits surrogate pair');
}
function overlaps(a, b) { return a.start < b.end && a.end > b.start; }
function meaningfulOverlap(source, a, b) {
  // A source-token overlap excludes whitespace/punctuation-only coincidences;
  // it does not establish that either passage expresses the same proposition.
  return overlaps(a, b) && /[\p{L}\p{N}]/u.test(source.slice(Math.max(a.start, b.start), Math.min(a.end, b.end)));
}
function sourceAccess(root, scan) {
  const resources = index(scan.resources, 'id', 'scan resources'), units = index(scan.units, 'id', 'scan units'), texts = new Map(), verified = new Set();
  function resource(id) {
    const found = resources.get(id); fail(found, 'unknown source resource');
    if (!verified.has(id)) { checkRef(root, {path: found.path, sha256: found.sha256}); verified.add(id); } return found;
  }
  function read(id) {
    const found = resource(id); fail(found.type === 'text', 'quoted source is not text');
    if (!texts.has(id)) { const bytes = fs.readFileSync(checkRef(root, {path: found.path, sha256: found.sha256})); fail(hash(bytes) === found.sha256, 'actual source bytes hash mismatch'); const source = bytes.toString('utf8'); fail(Buffer.from(source, 'utf8').equals(bytes), 'source is not valid UTF-8'); texts.set(id, source); }
    return texts.get(id);
  }
  return {resources, units, resource, read};
}
function validateAnchor(anchor, access, item) {
  const common = ['id', 'resourceId', 'resourceSha256', 'unitId'];
  fail(plain(anchor), 'source anchor must be an object');
  const resource = access.resource(anchor.resourceId), unit = access.units.get(anchor.unitId);
  fail(text(anchor.id) && resource.sha256 === anchor.resourceSha256 && unit?.resourceId === resource.id, 'anchor source identity/hash mismatch');
  if (resource.type === 'text') {
    shape(anchor, [...common, 'start', 'end', 'excerptSha256', 'quote'], 'text anchor');
    const source = access.read(resource.id); range(source, anchor.start, anchor.end, 'anchor');
    fail(anchor.start >= unit.start && anchor.end <= unit.end, 'anchor outside scan unit');
    fail(hash(source.slice(unit.start, unit.end)) === unit.excerptSha256, 'scan unit excerpt hash mismatch');
    fail(text(anchor.quote) && anchor.quote === source.slice(anchor.start, anchor.end) && hash(anchor.quote) === anchor.excerptSha256, 'stale source quote/hash');
    fail(anchor.quote.length <= 12000, 'anchor quote is too large; use focused source spans');
    return item.locators.some(locator => access.units.get(locator.unitId)?.resourceId === resource.id && meaningfulOverlap(source, anchor, locator));
  }
  shape(anchor, [...common, 'semantic'], 'asset anchor');
  fail(text(anchor.semantic) && unit.excerptSha256 === resource.sha256, 'asset anchor needs bound semantic location');
  return item.locators.some(locator => locator.unitId === anchor.unitId && text(locator.semantic));
}
function candidateBindings(root, scan, candidate, candidateSha256, contract, author) {
  shape(contract, ['schemaVersion', 'sourceBinding', 'paperId', 'revision', 'scanSha256', 'candidateSha256', 'author', 'inventory', 'cards', 'alignments', 'legacyRetainedObligationIds'], 'candidate scope');
  fail(contract.schemaVersion === 2 && candidate.schemaVersion === 2 && contract.paperId === scan.paperId && candidate.paperId === scan.paperId && contract.revision === candidate.revision, 'scope paper/revision mismatch');
  fail(candidateSha256 === objectHash(candidate) && contract.candidateSha256 === candidateSha256 && contract.scanSha256 === objectHash(scan) && candidate.scanSha256 === contract.scanSha256, 'scope candidate/scan hash mismatch');
  sameSourceBinding(root, contract.sourceBinding, candidate.sourceBinding, 'scope source binding');
  fail(text(author) && author === candidate.author && contract.author === author, 'scope author is not the registered constructor');
  shape(contract.inventory, ['complete', 'missingClaims', 'notes'], 'scope inventory');
  fail(typeof contract.inventory.complete === 'boolean' && text(contract.inventory.notes), 'scope inventory choices must be explicit');
  strings(contract.inventory.missingClaims, 'missing source claims');
  fail(!contract.inventory.complete || (candidate.inventory.complete === true && contract.inventory.missingClaims.length === 0), 'complete scope conflicts with incomplete inventory/missing source claims');
}

function inheritedLegacy(root, candidate, contract, previous, scan) {
  const ids = strings(contract.legacyRetainedObligationIds, 'legacy retained obligations');
  if (!ids.length) return [];
  fail(previous?.candidate && previous?.review && previous?.decision, 'legacy retention needs exact previous acceptance');
  const old = previous.candidate, decision = previous.decision;
  for (const value of [old, previous.review, decision, ...(previous.contract ? [previous.contract] : [])]) {
    fail(value.schemaVersion === 2, 'legacy snapshot lost source-binding schema');
    sameSourceBinding(root, candidate.sourceBinding, value.sourceBinding, 'legacy source binding');
  }
  fail(previous.sha256 === objectHash(old) && decision.candidateSha256 === previous.sha256 && decision.scanSha256 === objectHash(scan) && decision.reviewSha256 === objectHash(previous.review) && decision.decision === 'accept_snapshot', 'legacy acceptance binding mismatch');
  fail(previous.review.candidateSha256 === previous.sha256 && previous.review.scanSha256 === objectHash(scan), 'legacy review binding mismatch');
  if (previous.contract) fail(previous.contractSha256 === objectHash(previous.contract) && previous.contract.candidateSha256 === previous.sha256 && previous.contract.scanSha256 === objectHash(scan), 'previous legacy scope contract binding mismatch');
  for (const id of ids) {
    fail(!previous.contract || previous.contract.legacyRetainedObligationIds?.includes(id), 'already guarded obligation cannot become exempt legacy credit');
    const priorItem = old.inventory.items.find(item => item.obligations.some(o => o.id === id)), item = candidate.inventory.items.find(value => value.obligations.some(o => o.id === id));
    const before = old.assessments.find(a => a.obligationId === id), current = candidate.assessments.find(a => a.obligationId === id);
    fail(decision.acceptedObligationIds.includes(id) && before?.status === 'accepted' && item && priorItem && objectHash(item) === objectHash(priorItem) && current && objectHash(before) === objectHash(current), 'legacy retention requires exact unchanged previously accepted item/assessment');
    unchangedBasis(old, candidate, current, 'legacy retention');
  }
  return [...ids];
}
function unchangedBasis(old, candidate, assessment, label) {
  fail(plain(assessment.basisItemHashes) && Object.keys(assessment.basisItemHashes).length > 0 && Object.entries(assessment.basisItemHashes).every(([itemId, digest]) => {
    const oldDependency = old.inventory.items.find(value => value.id === itemId), dependency = candidate.inventory.items.find(value => value.id === itemId);
    return oldDependency && dependency && objectHash(oldDependency) === digest && objectHash(dependency) === digest;
  }), label + ' changed transitive premises');
}

/** Run beside (not instead of) validateCandidate. No writes or scientific credit. */
export function validateCandidateScope({root, scan, candidate, candidateSha256, contract, author, previous = null}) {
  candidateBindings(root, scan, candidate, candidateSha256, contract, author);
  const sourceView = resolveSourceView({root, scan, sourceBinding: candidate.sourceBinding});
  const items = index(candidate.inventory.items, 'id', 'candidate items'), obligations = new Map(), assessments = index(candidate.assessments, 'obligationId', 'assessments');
  for (const item of items.values()) for (const obligation of array(item.obligations, 'item obligations')) {
    fail(text(obligation.id) && !obligations.has(obligation.id), 'duplicate/missing obligation identity'); obligations.set(obligation.id, {item, obligation});
  }
  exact([...assessments.keys()], [...obligations.keys()], 'assessment coverage');
  if (previous) {
    fail(previous.candidate.schemaVersion === 2, 'previous source-binding schema required');
    sameSourceBinding(root, candidate.sourceBinding, previous.candidate.sourceBinding, 'previous scope source binding');
    fail(previous.sha256 === objectHash(previous.candidate) && candidate.predecessorSha256 === previous.sha256 && candidate.revision === previous.candidate.revision + 1, 'previous candidate binding mismatch');
    for (const item of previous.candidate.inventory.items) { fail(items.has(item.id), 'cannot remove an existing difficult item'); for (const obligation of item.obligations) fail(obligations.has(obligation.id), 'cannot remove an existing difficult obligation'); }
  }
  const inheritedLegacyIds = inheritedLegacy(root, candidate, contract, previous, scan), legacyIds = new Set(inheritedLegacyIds);
  const scopedIds = [...obligations.keys()].filter(id => !legacyIds.has(id));
  const scopedItems = [...items.values()].filter(item => item.obligations.some(o => !legacyIds.has(o.id))).map(item => item.id);
  const cards = index(contract.cards, 'itemId', 'scope cards'), alignments = index(contract.alignments, 'obligationId', 'scope alignments');
  exact([...cards.keys()], scopedItems, 'scope card coverage'); exact([...alignments.keys()], scopedIds, 'scope alignment coverage');
  const access = sourceAccess(root, sourceView), claims = new Map(), cardHashes = {}, alignmentHashes = {}, problems = new Map();
  const problem = (id, reason) => { if (!problems.has(id)) problems.set(id, []); if (!problems.get(id).includes(reason)) problems.get(id).push(reason); };
  for (const card of cards.values()) {
    shape(card, ['itemId', 'itemSha256', 'anchors', 'claims'], 'scope card'); const item = items.get(card.itemId);
    fail(card.itemSha256 === objectHash(item), 'stale item scope hash');
    const anchors = index(card.anchors, 'id', 'source anchors'); fail(anchors.size > 0, 'card needs source anchors');
    const matching = new Set(); for (const anchor of anchors.values()) if (validateAnchor(anchor, access, item)) matching.add(anchor.id);
    fail(matching.size > 0, 'card source anchors have no meaningful candidate-locator overlap');
    fail(card.anchors.reduce((total, a) => total + (a.quote?.length ?? 0), 0) <= 48000, 'card copies excessive source text');
    fail(array(card.claims, 'source claims').length > 0 || item.obligations.filter(o => !legacyIds.has(o.id)).every(o => alignments.get(o.id).relation === 'not_author_claim'), 'card must explicitly identify source claims');
    for (const claim of card.claims) {
      shape(claim, ['id', 'anchorIds', 'statement', 'kind', 'modality', 'quantifier', 'conditions', 'empiricalTarget'], 'source claim', ['legacyParentObligationIds']);
      fail(text(claim.id) && !claims.has(claim.id), 'duplicate/missing source claim ID');
      strings(claim.anchorIds, 'claim anchorIds', true); fail(claim.anchorIds.every(id => anchors.has(id)) && claim.anchorIds.some(id => matching.has(id)), 'claim lacks bound candidate-overlapping source anchor');
      fail(text(claim.statement) && text(claim.modality) && text(claim.quantifier), 'claim statement/modality/quantifier must be explicit');
      fail(['analytic', 'identity', 'empirical', 'algorithm', 'definition', 'practical', 'visual_observation'].includes(claim.kind), 'unknown source claim kind');
      fail(claim.kind === 'visual_observation' || claim.anchorIds.some(id => Object.hasOwn(anchors.get(id), 'quote')), 'nonvisual claim needs an actual source quote');
      strings(claim.conditions, 'source claim conditions');
      shape(claim.empiricalTarget, ['kind', 'description', 'identityRequirements'], 'empirical target');
      fail(TARGETS.includes(claim.empiricalTarget.kind) && text(claim.empiricalTarget.description), 'empirical target needs explicit kind/description');
      const requirements = array(claim.empiricalTarget.identityRequirements, 'historical identity requirements');
      fail(claim.empiricalTarget.kind === 'exact_historical' || requirements.length === 0, 'historical identity is not an automatic statistical/scientific prerequisite');
      for (const requirement of requirements) {
        shape(requirement, ['object', 'anchorIds', 'reason'], 'historical requirement'); fail(text(requirement.object) && text(requirement.reason), 'historical requirement needs object/reason');
        strings(requirement.anchorIds, 'historical requirement anchorIds', true); fail(requirement.anchorIds.every(id => claim.anchorIds.includes(id) && Object.hasOwn(anchors.get(id), 'quote')), 'necessary historical identity needs explicit source quotes');
      }
      fail(claim.empiricalTarget.kind !== 'exact_historical' || requirements.length > 0, 'exact historical target needs source-bound required objects');
      if (Object.hasOwn(claim, 'legacyParentObligationIds')) {
        strings(claim.legacyParentObligationIds, 'legacy parent obligation IDs', true);
        fail(claim.legacyParentObligationIds.every(id => legacyIds.has(id) && obligations.get(id)?.item.id === item.id), 'legacy parent must be unchanged accepted same-item credit');
      }
      claims.set(claim.id, {claim, itemId: item.id, anchors});
    }
    cardHashes[card.itemId] = objectHash(card);
  }
  const originalClaims = new Set([...claims].filter(([, value]) => value.claim.legacyParentObligationIds?.length).map(([id]) => id));
  for (const alignment of alignments.values()) {
    shape(alignment, ['obligationId', 'obligationSha256', 'assessmentSha256', 'claimIds', 'relation', 'additionalAssumptions', 'assessedTarget', 'reason'], 'alignment', ['blockerBasis']);
    const {item, obligation} = obligations.get(alignment.obligationId), assessment = assessments.get(alignment.obligationId);
    fail(alignment.obligationSha256 === objectHash(obligation) && alignment.assessmentSha256 === objectHash(assessment), 'stale obligation/assessment scope hash');
    fail(RELATIONS.includes(alignment.relation) && TARGETS.includes(alignment.assessedTarget) && text(alignment.reason), 'explicit alignment relation/target/reason required');
    strings(alignment.additionalAssumptions, 'additional assumptions'); strings(alignment.claimIds, 'alignment claimIds', alignment.relation !== 'not_author_claim');
    fail(alignment.claimIds.every(id => claims.get(id)?.itemId === item.id), 'alignment references unknown or other-item source claim');
    if (alignment.relation === 'not_author_claim') {
      fail(alignment.claimIds.length === 0, 'not_author_claim cannot erase a mapped original claim');
      if (assessment.status === 'accepted' && assessment.outcome !== 'not_applicable') problem(alignment.obligationId, 'extra_requested_guarantee_is_not_an_author_result');
    }
    if (alignment.relation === 'unknown' || alignment.assessedTarget === 'unspecified') problem(alignment.obligationId, 'unresolved_source_scope');
    if (alignment.relation === 'unknown') for (const id of alignment.claimIds) originalClaims.add(id);
    if (alignment.relation === 'original') {
      for (const id of alignment.claimIds) originalClaims.add(id);
      if (alignment.additionalAssumptions.length) problem(alignment.obligationId, 'original_target_has_additional_assumptions');
      if (alignment.claimIds.some(id => claims.get(id).claim.empiricalTarget.kind !== alignment.assessedTarget)) problem(alignment.obligationId, 'original_and_assessed_empirical_targets_differ');
    }
    if (assessment.status === 'external_blocked') {
      shape(alignment.blockerBasis, ['kind', 'anchorIds', 'reason'], 'blocker scope basis');
      fail(['historical_identity', 'model_or_operator', 'physical_observation', 'other', 'unresolved'].includes(alignment.blockerBasis.kind) && text(alignment.blockerBasis.reason), 'blocker scope basis needs explicit kind/reason');
      strings(alignment.blockerBasis.anchorIds, 'blocker anchorIds', true);
      const available = new Set(alignment.claimIds.flatMap(id => claims.get(id).claim.anchorIds));
      fail(alignment.blockerBasis.anchorIds.every(id => available.has(id)), 'necessary missing object lacks source anchors');
      if (alignment.blockerBasis.kind === 'unresolved') problem(alignment.obligationId, 'missing_object_necessity_unresolved');
      if (alignment.blockerBasis.kind === 'historical_identity' && (alignment.assessedTarget !== 'exact_historical' || alignment.claimIds.some(id => claims.get(id).claim.empiricalTarget.kind !== 'exact_historical'))) problem(alignment.obligationId, 'historical_identity_not_source_requirement');
    } else fail(!Object.hasOwn(alignment, 'blockerBasis'), 'blockerBasis belongs only to external_blocked');
    alignmentHashes[alignment.obligationId] = objectHash(alignment);
  }
  for (const id of claims.keys()) fail(originalClaims.has(id), 'source claim has no preserved original-target obligation: ' + id);
  const blockedObligationIds = [...problems.keys()];
  sourceView.recheck();
  return {valid: true, verification: VERIFICATION, candidateSha256, contractSha256: objectHash(contract), cardHashes, alignmentHashes,
    eligibleObligationIds: scopedIds.filter(id => !problems.has(id)), blockedObligationIds, inheritedLegacyIds,
    issues: [...problems].map(([obligationId, reasons]) => ({obligationId, reasons})),
    inventoryEligible: candidate.inventory.complete === true && contract.inventory.complete && contract.inventory.missingClaims.length === 0};
}

function independentEvidence(root, candidate, revision, evidence, retained = false) {
  fail(array(evidence, 'scope review evidence').length > 0, 'scope verdict needs independent evidence');
  const paperRoot = path.resolve(root, 'research_followup/reproduction_clean/coverage_verifications', candidate.paperId);
  const reviewRoot = path.join(paperRoot, 'c' + String(revision).padStart(3, '0'));
  const constructorRefs = candidate.assessments.flatMap(a => (a.evidence ?? []).flatMap(e => e.artifacts ?? []));
  for (const ref of evidence) {
    shape(ref, ['path', 'sha256'], 'scope review evidence ref');
    fail(text(ref.path) && /^[a-f0-9]{64}$/.test(ref.sha256 ?? '') && !/[\x00-\x1f]/.test(ref.path) && !ref.path.replaceAll('\\', '/').split('/').some(part => part === '.' || part === '..'), 'invalid scope review evidence path/hash');
    // Authorize the path before opening/hashing it. A rejected sibling/private
    // path must not be read merely in order to discover that it is forbidden.
    const absolute = path.resolve(root, ref.path), relative = path.relative(retained ? paperRoot : reviewRoot, absolute);
    fail(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'scope evidence must be in this revision independent review root');
    if (retained) {
      const parts = relative.split(path.sep), match = /^c(\d{3,})$/.exec(parts[0]);
      fail(parts.length > 1 && match && Number(match[1]) >= 1 && Number(match[1]) <= revision, 'retained scope evidence is outside prior accepted review revisions');
    }
    checkRef(root, ref);
    fail(!constructorRefs.some(other => other.sha256 === ref.sha256 || path.resolve(root, other.path).toLowerCase() === absolute.toLowerCase()), 'scope evidence aliases constructor evidence');
  }
}
function priorScope(root, previous, scan, sourceBinding) {
  fail(previous?.contract && previous?.scopeReview && previous?.review && previous?.decision, 'retention needs an exact previously accepted scope snapshot, not legacy credit alone');
  const {candidate, contract, scopeReview, review, decision} = previous;
  for (const value of [candidate, review, decision, contract, scopeReview]) {
    fail(value.schemaVersion === 2, 'previous scope source-binding schema required');
    sameSourceBinding(root, sourceBinding, value.sourceBinding, 'previous scope source binding');
  }
  fail(previous.sha256 === objectHash(candidate) && previous.contractSha256 === objectHash(contract) && previous.scopeReviewSha256 === objectHash(scopeReview), 'previous scope snapshot hash mismatch');
  fail(contract.candidateSha256 === previous.sha256 && contract.scanSha256 === objectHash(scan) && contract.paperId === candidate.paperId && contract.revision === candidate.revision && scopeReview.candidateSha256 === previous.sha256 && scopeReview.contractSha256 === previous.contractSha256 && scopeReview.reviewSha256 === objectHash(review) && scopeReview.paperId === candidate.paperId && scopeReview.revision === candidate.revision && scopeReview.scanSha256 === objectHash(scan), 'previous scope binding mismatch');
  fail(decision.candidateSha256 === previous.sha256 && decision.reviewSha256 === objectHash(review) && decision.scanSha256 === objectHash(scan) && decision.decision === 'accept_snapshot', 'previous scope lacks exact supervisor decision');
  fail(scopeReview.reviewerAgent === review.reviewerAgent && scopeReview.reviewerAgent !== candidate.author, 'previous scope was not independently reviewed');
  return previous;
}

/** Run beside validateReview; returned IDs only constrain a later supervisor decision. */
export function validateReviewScope({root, scan, candidate, candidateSha256, contract, contractSha256, review, scopeReview, reviewer, worker, historicalConstructors = [], previous = null}) {
  const checked = validateCandidateScope({root, scan, candidate, candidateSha256, contract, author: worker, previous});
  shape(scopeReview, ['schemaVersion', 'sourceBinding', 'paperId', 'revision', 'scanSha256', 'candidateSha256', 'contractSha256', 'reviewSha256', 'reviewerAgent', 'inventory', 'cards', 'entries', 'retainedItemIds', 'retainedObligationIds'], 'scope review');
  fail(contractSha256 === objectHash(contract) && scopeReview.contractSha256 === contractSha256 && scopeReview.reviewSha256 === objectHash(review), 'scope review contract/review hash mismatch');
  fail(scopeReview.schemaVersion === 2 && scopeReview.paperId === candidate.paperId && scopeReview.revision === candidate.revision && scopeReview.scanSha256 === objectHash(scan) && scopeReview.candidateSha256 === candidateSha256, 'scope review candidate identity mismatch');
  strings(historicalConstructors, 'historical constructors');
  fail(text(reviewer) && reviewer !== worker && reviewer !== candidate.author && !historicalConstructors.includes(reviewer) && reviewer !== previous?.candidate?.author && scopeReview.reviewerAgent === reviewer && review.reviewerAgent === reviewer, 'scope reviewer is not an independent registered agent');
  sameSourceBinding(root, scopeReview.sourceBinding, candidate.sourceBinding, 'scope review source binding');
  sameSourceBinding(root, review.sourceBinding, candidate.sourceBinding, 'main review source binding');
  fail(review.schemaVersion === 2, 'main review source-binding schema required');
  fail(review.candidateSha256 === candidateSha256 && review.scanSha256 === objectHash(scan) && review.paperId === candidate.paperId && review.revision === candidate.revision, 'main review binding mismatch');
  const cards = index(scopeReview.cards, 'itemId', 'reviewed cards'), entries = index(scopeReview.entries, 'obligationId', 'reviewed alignments');
  exact([...cards.keys()], Object.keys(checked.cardHashes), 'independent card coverage');
  exact([...entries.keys()], Object.keys(checked.alignmentHashes), 'independent alignment coverage');
  strings(scopeReview.retainedItemIds, 'retained scope items'); strings(scopeReview.retainedObligationIds, 'retained scope obligations');
  fail(scopeReview.retainedItemIds.every(id => cards.has(id)) && scopeReview.retainedObligationIds.every(id => entries.has(id)), 'unknown retained scope item/obligation');
  const inventory = scopeReview.inventory;
  shape(inventory, ['complete', 'checkedUnlistedSource', 'missingClaims', 'notes', 'evidence'], 'scope review inventory');
  fail(typeof inventory.complete === 'boolean' && typeof inventory.checkedUnlistedSource === 'boolean' && text(inventory.notes), 'inventory scope review choices must be explicit'); strings(inventory.missingClaims, 'review missing claims');
  independentEvidence(root, candidate, candidate.revision, inventory.evidence);
  fail(!inventory.complete || (checked.inventoryEligible && inventory.checkedUnlistedSource && inventory.missingClaims.length === 0 && review.inventory.complete === true), 'complete scope review conflicts with uninspected/incomplete source inventory');
  for (const [values, idField, hashField, hashes] of [[cards, 'itemId', 'cardSha256', checked.cardHashes], [entries, 'obligationId', 'alignmentSha256', checked.alignmentHashes]]) for (const value of values.values()) {
    shape(value, [idField, hashField, 'verdict', 'reason', 'evidence'], 'scope review entry');
    fail(value[hashField] === hashes[value[idField]] && ['aligned', 'needs_work', 'unknown'].includes(value.verdict) && text(value.reason), 'scope entry needs exact hash and explicit verdict/reason');
    const retained = idField === 'itemId' ? scopeReview.retainedItemIds.includes(value.itemId) : scopeReview.retainedObligationIds.includes(value.obligationId);
    if (!retained) independentEvidence(root, candidate, candidate.revision, value.evidence);
  }
  if (scopeReview.retainedItemIds.length || scopeReview.retainedObligationIds.length) {
    const prior = priorScope(root, previous, scan, candidate.sourceBinding);
    for (const id of scopeReview.retainedItemIds) {
      const oldCard = prior.contract.cards.find(card => card.itemId === id), oldReview = prior.scopeReview.cards.find(card => card.itemId === id);
      fail(oldCard && objectHash(oldCard) === checked.cardHashes[id] && oldReview?.verdict === 'aligned' && oldReview.cardSha256 === checked.cardHashes[id] && canonical(cards.get(id)) === canonical(oldReview), 'retained card is changed or lacks prior independent aligned check');
      fail(prior.decision.inventoryAccepted === true, 'retained card lacks previously accepted inventory');
      independentEvidence(root, prior.candidate, prior.candidate.revision, oldReview.evidence, true);
    }
    for (const id of scopeReview.retainedObligationIds) {
      const old = prior.contract.alignments.find(value => value.obligationId === id), oldReview = prior.scopeReview.entries.find(value => value.obligationId === id);
      fail(old && objectHash(old) === checked.alignmentHashes[id] && oldReview?.verdict === 'aligned' && oldReview.alignmentSha256 === checked.alignmentHashes[id] && prior.decision.acceptedObligationIds.includes(id) && canonical(entries.get(id)) === canonical(oldReview), 'retained alignment changed/unaccepted/unreviewed');
      const before = prior.candidate.assessments.find(value => value.obligationId === id), current = candidate.assessments.find(value => value.obligationId === id);
      fail(before && objectHash(before) === objectHash(current), 'retained assessment/dependencies changed'); unchangedBasis(prior.candidate, candidate, current, 'retained scope'); independentEvidence(root, prior.candidate, prior.candidate.revision, oldReview.evidence, true);
    }
  }
  const blocked = new Set(checked.blockedObligationIds), mainEntries = index(review.entries, 'obligationId', 'main review entries');
  exact([...mainEntries.keys(), ...strings(review.retainedObligationIds, 'main retained obligations')], candidate.assessments.map(a => a.obligationId), 'main review coverage');
  for (const item of candidate.inventory.items) for (const obligation of item.obligations) {
    if (checked.inheritedLegacyIds.includes(obligation.id)) continue;
    if (cards.get(item.id).verdict !== 'aligned' || entries.get(obligation.id).verdict !== 'aligned') blocked.add(obligation.id);
    const main = mainEntries.get(obligation.id);
    if (main) fail(main.assessmentSha256 === objectHash(candidate.assessments.find(value => value.obligationId === obligation.id)) && ['accept', 'needs_work'].includes(main.verdict), 'main review assessment/verdict mismatch');
    fail(!blocked.has(obligation.id) || (main?.verdict !== 'accept' && !review.retainedObligationIds.includes(obligation.id)), 'accept/retention conflicts with unresolved or needs_work source scope: ' + obligation.id);
  }
  resolveSourceView({root, scan, sourceBinding: candidate.sourceBinding}).recheck();
  return {...checked, contractSha256, scopeReviewSha256: objectHash(scopeReview), reviewSha256: objectHash(review),
    eligibleObligationIds: Object.keys(checked.alignmentHashes).filter(id => !blocked.has(id) && (mainEntries.get(id)?.verdict === 'accept' || review.retainedObligationIds.includes(id))),
    blockedObligationIds: [...blocked], inventoryEligible: checked.inventoryEligible && inventory.complete && inventory.checkedUnlistedSource && inventory.missingClaims.length === 0};
}
