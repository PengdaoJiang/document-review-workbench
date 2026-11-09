// Result records validate provenance and shape, never the scientific judgment.
import {readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, lstatSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildScope} from './inputs.mjs';
import {verifyRun} from './runs.mjs';
import {loadDotIndex} from '../../../paper_library/dot-library.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const isText = x => typeof x === 'string' && x.trim().length > 0;
const isHash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const statuses = new Set(['unassessed', 'reproduced', 'partial', 'not_reproduced', 'counterexample', 'inconclusive', 'not_applicable']);
const roles = new Set(['source_review', 'symbolic', 'numeric', 'formal', 'runtime_performance']);
const decisive = new Set(['reproduced', 'counterexample']);
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

function keys(value, allowed, label) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
  for (const key of Object.keys(value)) requireThat(allowed.includes(key), `Unexpected ${label}.${key}`);
}
function strings(value, label) {
  requireThat(Array.isArray(value) && value.every(isText), `Invalid ${label}`);
}
function id(value, label) {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value), `Invalid ${label}`);
  requireThat(!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value), `Reserved ${label}`);
  return value;
}
function paperId(value) {
  requireThat(/^(origin|r\d{4})$/.test(value || ''), 'Invalid paperId');
  return value;
}
// Check every existing component, not just a leaf, before creating/reading paths.
function inside(root, relative, {mustExist = true} = {}) {
  requireThat(isText(relative) && !path.isAbsolute(relative) && !relative.split(/[\\/]/).some(x => !x || x === '.' || x === '..') && !relative.includes(':'), 'Unsafe relative path');
  const base = path.resolve(root), target = path.resolve(base, relative);
  requireThat(target.startsWith(base + path.sep), 'Path outside root');
  let cursor = path.parse(target).root;
  for (const part of target.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (existsSync(cursor)) requireThat(!lstatSync(cursor).isSymbolicLink(), `Symlink is not allowed: ${cursor}`);
  }
  if (mustExist) {
    requireThat(existsSync(target), `Missing file: ${relative}`);
    requireThat(realpathSync(target).toLowerCase() === target.toLowerCase(), 'Redirected path');
  }
  return target;
}
function locations(value, packet, inputSha256, reading, label) {
  requireThat(Array.isArray(value) && value.length > 0, `Missing ${label}`);
  for (const loc of value) {
    keys(loc, ['page', 'dot', 'section', 'equation', 'label', 'figure', 'table', 'excerpt'], label);
    const hasPage = Object.hasOwn(loc, 'page');
    if (hasPage) requireThat(Number.isInteger(loc.page) && loc.page >= 1 && loc.page <= packet.source.pages, `Invalid ${label}.page`);
    requireThat(hasPage || Object.hasOwn(loc, 'dot'), `Missing ${label}.page or bound Dot locator`);
    if (Object.hasOwn(loc, 'dot')) {
      keys(loc.dot, ['version', 'path', 'sha256'], `${label}.dot`);
      const bound = packet.reconstruction;
      requireThat(packet.inputKind === 'dot_original_only' && bound?.provider === 'dot', 'Dot locator needs a Dot-neutral packet');
      requireThat(reading?.mode === 'dot_latex' && reading.paperId === packet.paperId && reading.originalPacket?.sha256 === inputSha256, 'Dot locator needs the verified same-paper reading view');
      for (const field of ['provider', 'release', 'version', 'indexSha256', 'recordSha256']) {
        requireThat(reading.edition?.[field] === bound[field], `Dot reading ${field} differs from the input packet`);
      }
      requireThat(loc.dot.version === bound.version && isHash(loc.dot.sha256) && isText(loc.dot.path) && path.isAbsolute(loc.dot.path), 'Invalid Dot version/file/hash binding');
      // The caller supplies getReadingView/verifyRun's already verified view.
      // Only academic files from that view are allowed; no source-map import.
      const resources = [reading.primary, ...(reading.latexEntries ?? []), ...(reading.dependencies ?? []), ...(reading.assets ?? [])];
      requireThat(resources.some(file => file && path.resolve(file.path) === path.resolve(loc.dot.path) && file.sha256 === loc.dot.sha256), 'Dot locator file/hash is not in the selected academic reading resources');
      requireThat(['section', 'equation', 'label', 'figure', 'table', 'excerpt'].some(key => isText(loc[key])), 'Dot locator requires a semantic section/equation/label/figure/table/excerpt');
    }
    for (const [key, v] of Object.entries(loc)) if (!['page', 'dot'].includes(key)) requireThat(isText(v), `Invalid ${label}.${key}`);
  }
}

export function validateContract(contract, packet, inputSha256, reading = null) {
  keys(contract, ['schemaVersion', 'paperId', 'inputSha256', 'sourceSha256', 'claimInventory', 'claims'], 'contract');
  requireThat(contract.schemaVersion === 1 && contract.paperId === packet.paperId && contract.inputSha256 === inputSha256 && contract.sourceSha256 === packet.source.sha256, 'Contract input identity mismatch');
  keys(contract.claimInventory, ['status', 'basis'], 'claimInventory');
  requireThat(['complete', 'partial', 'unknown'].includes(contract.claimInventory.status) && isText(contract.claimInventory.basis), 'Invalid claim inventory');
  requireThat(Array.isArray(contract.claims) && contract.claims.length > 0, 'Contract needs explicit claims');
  const seen = new Set();
  for (const claim of contract.claims) {
    keys(claim, ['claimId', 'kind', 'statement', 'sourceLocations', 'sourceConditions', 'implementationAssumptions', 'nativeUnits', 'conventions', 'unknowns', 'successCriteria'], 'claim');
    requireThat(new RegExp(`^${contract.paperId}:c[0-9]{4,}$`).test(claim.claimId || '') && !seen.has(claim.claimId), 'Invalid or duplicate claimId');
    seen.add(claim.claimId);
    requireThat(['author_claim', 'independent_check'].includes(claim.kind) && isText(claim.statement), 'Invalid claim identity');
    locations(claim.sourceLocations, packet, inputSha256, reading, 'sourceLocations');
    for (const field of ['sourceConditions', 'implementationAssumptions', 'unknowns', 'successCriteria']) strings(claim[field], field);
    requireThat(claim.successCriteria.length > 0 && isText(claim.nativeUnits) && isText(claim.conventions), 'Missing native units/conventions/criteria; use explicit unknown where necessary');
  }
  return contract;
}

async function validateResult(cleanRoot, record, {comparePrevious = false} = {}) {
  keys(record, ['schemaVersion', 'paperId', 'resultId', 'phase', 'inputSha256', 'contractSha256', 'contract', 'runBindings', 'claims', 'assessment', 'supersedes'], 'result');
  paperId(record.paperId); id(record.resultId, 'resultId');
  requireThat(record.schemaVersion === 1 && record.phase === 'first_pass', 'This registry only accepts first_pass results; extensions belong downstream');
  requireThat(isHash(record.inputSha256) && isHash(record.contractSha256), 'Result input/contract mismatch');
  requireThat(Array.isArray(record.runBindings) && record.runBindings.length > 0, 'Archive evidence in at least one bound run');
  const runMap = new Map();
  let contractBound = false;
  let input;
  for (const binding of record.runBindings) {
    keys(binding, ['runId', 'runSha256'], 'run binding');
    id(binding.runId, 'runId');
    requireThat(isHash(binding.runSha256) && !runMap.has(binding.runId), 'Invalid/duplicate run binding');
    const runDir = inside(cleanRoot, `runs/${record.paperId}/${binding.runId}`);
    const runFile = inside(runDir, 'run.json');
    requireThat(hash(readFileSync(runFile)) === binding.runSha256, 'Run record hash changed');
    const checked = await verifyRun(cleanRoot, record.paperId, binding.runId, {requireCurrentSource: false});
    requireThat(checked.record.inputSha256 === record.inputSha256, 'Run used another input packet');
    const packetFile = inside(runDir, 'packet.json');
    const packetBytes = readFileSync(packetFile);
    requireThat(hash(packetBytes) === record.inputSha256, 'Frozen input packet changed');
    input = {sha256: record.inputSha256, packet: JSON.parse(packetBytes)};
    validateContract(record.contract, input.packet, input.sha256, checked.readingView);
    const frozenContract = inside(runDir, 'source/contract.json');
    requireThat(hash(readFileSync(frozenContract)) === record.contractSha256 && canonical(read(frozenContract)) === canonical(record.contract), 'Contract differs from pre-run snapshot');
    contractBound = true;
    runMap.set(binding.runId, {runDir, checked});
  }
  requireThat(contractBound, 'No frozen contract');
  keys(record.assessment, ['by', 'at', 'basis'], 'assessment');
  requireThat(isText(record.assessment.by) && Number.isFinite(Date.parse(record.assessment.at)) && isText(record.assessment.basis), 'Missing actual scientific assessment');
  requireThat(Array.isArray(record.claims) && record.claims.length === record.contract.claims.length, 'Result must account for every contract claim, including unassessed');
  const defined = new Map(record.contract.claims.map(c => [c.claimId, c]));
  const seen = new Set();
  for (const claim of record.claims) {
    keys(claim, ['claimId', 'status', 'conclusion', 'testedScope', 'limitations', 'evidence'], 'claim result');
    requireThat(defined.has(claim.claimId) && !seen.has(claim.claimId), 'Unknown/duplicate result claimId');
    seen.add(claim.claimId);
    requireThat(statuses.has(claim.status) && isText(claim.conclusion) && isText(claim.testedScope), 'Missing scoped claim conclusion');
    strings(claim.limitations, 'limitations');
    requireThat(Array.isArray(claim.evidence), 'Invalid evidence');
    if (decisive.has(claim.status)) requireThat(claim.evidence.length > 0, 'A decisive claim requires evidence');
    for (const evidence of claim.evidence) {
      keys(evidence, ['role', 'runId', 'path', 'sha256', 'description'], 'evidence');
      requireThat(roles.has(evidence.role) && runMap.has(evidence.runId) && isHash(evidence.sha256) && isText(evidence.description), 'Invalid evidence binding');
      const {runDir, checked} = runMap.get(evidence.runId);
      // Source notes are frozen before execution; output evidence must come from a verified completed chunk.
      requireThat(evidence.path.startsWith('source/') || evidence.path.startsWith('chunks/'), 'Evidence must be frozen source or completed chunk output');
      const file = inside(runDir, evidence.path);
      requireThat(lstatSync(file).isFile() && hash(readFileSync(file)) === evidence.sha256, 'Evidence bytes changed');
      if (evidence.path.startsWith('source/')) {
        requireThat(evidence.role === 'source_review', 'Computed evidence must be captured output, not input source');
        requireThat(checked.record.codeFiles[evidence.path.slice(7)] === evidence.sha256, 'Source note is not in frozen inventory');
      }
      if (evidence.path.startsWith('chunks/')) {
        const match = /^chunks\/([^/]+)\/(attempt-\d{4}\.(completed|failed))\/(.+)$/.exec(evidence.path);
        requireThat(match && checked.chunks.some(c => c.id === match[1]), 'Evidence was not captured as a planned chunk output');
        const receipt = read(inside(runDir, `chunks/${match[1]}/${match[2]}/receipt.json`));
        requireThat(receipt.fingerprint === checked.record.fingerprint && receipt.state === match[3], 'Evidence receipt identity mismatch');
        const relative = match[4];
        const recordedHash = relative.startsWith('work/') ? receipt.outputs.work[relative.slice(5)]
          : relative === 'stdout.log' ? receipt.outputs.stdout : relative === 'stderr.log' ? receipt.outputs.stderr : null;
        requireThat(recordedHash === evidence.sha256, 'Evidence was not captured in the output inventory');
        if (decisive.has(claim.status)) requireThat(receipt.state === 'completed', 'Failed execution is not decisive scientific evidence');
      }
    }
  }
  requireThat(Array.isArray(record.supersedes), 'supersedes must be explicit (empty for first version)');
  const resultDir = inside(cleanRoot, `results/${record.paperId}`, {mustExist: false});
  for (const prior of record.supersedes) {
    keys(prior, ['resultId', 'sha256', 'reason'], 'supersedes');
    id(prior.resultId, 'superseded resultId');
    requireThat(prior.resultId !== record.resultId && isHash(prior.sha256) && isText(prior.reason), 'Invalid supersession');
    const previous = inside(resultDir, `${prior.resultId}.json`);
    requireThat(hash(readFileSync(previous)) === prior.sha256, 'Superseded result identity mismatch');
  }
  if (comparePrevious && existsSync(resultDir)) {
    for (const file of readdirSync(resultDir).filter(f => f.endsWith('.json'))) {
      const previous = read(inside(resultDir, file));
      for (const oldClaim of previous.contract?.claims || []) {
        if (defined.has(oldClaim.claimId)) requireThat(canonical(oldClaim) === canonical(defined.get(oldClaim.claimId)), 'An existing claimId cannot silently change its definition; issue a new claimId');
      }
    }
  }
  return {input, record};
}

export async function publishResult(cleanRoot, record) {
  await validateResult(cleanRoot, record, {comparePrevious: true});
  const target = inside(cleanRoot, `results/${record.paperId}/${record.resultId}.json`, {mustExist: false});
  mkdirSync(path.dirname(target), {recursive: true});
  const bytes = JSON.stringify(record, null, 2) + '\n';
  writeFileSync(target, bytes, {flag: 'wx'});
  return {path: target, sha256: hash(bytes), scientificStatus: 'recorded_assessment_not_automatically_certified'};
}

export async function verifyResult(cleanRoot, paper, resultId) {
  paperId(paper); id(resultId, 'resultId');
  const target = inside(cleanRoot, `results/${paper}/${resultId}.json`);
  const bytes = readFileSync(target), record = JSON.parse(bytes);
  requireThat(record.paperId === paper && record.resultId === resultId, 'Result filename/identity mismatch');
  await validateResult(cleanRoot, record);
  return {path: target, sha256: hash(bytes), record};
}

export async function buildResultIndex(cleanRoot) {
  const projectRoot = path.resolve(cleanRoot, '..', '..'), dot = loadDotIndex(projectRoot);
  const scope = dot ? {papers: dot.index.papers.map(entry => ({paperId: entry.paperId}))} : read(inside(cleanRoot, 'scope.json'));
  if (!dot) requireThat(canonical(scope) === canonical(buildScope(projectRoot)), 'Scope no longer matches the authoritative fixed membership');
  // The input layer owns the precise scope schema; only normalized IDs enter this index.
  const entries = scope.papers ?? scope.members;
  requireThat(Array.isArray(entries), 'Unknown scope schema');
  const papers = [];
  for (const entry of entries) {
    const paper = paperId(typeof entry === 'string' ? entry : entry.paperId ?? entry.id);
    const resultDir = inside(cleanRoot, `results/${paper}`, {mustExist: false});
    const results = [];
    for (const file of existsSync(resultDir) ? readdirSync(resultDir).filter(f => f.endsWith('.json')).sort() : []) {
      const verified = await verifyResult(cleanRoot, paper, file.slice(0, -5));
      results.push({resultId: verified.record.resultId, path: path.relative(cleanRoot, verified.path).replaceAll('\\', '/'), sha256: verified.sha256,
        claimInventory: verified.record.contract.claimInventory, claims: verified.record.claims.map(c => ({claimId: c.claimId, status: c.status})), supersedes: verified.record.supersedes});
    }
    papers.push({paperId: paper, status: results.length ? 'has_scoped_results' : 'no_published_result', results});
  }
  return {schemaVersion: 1, scopeSha256: dot ? dot.indexSha256 : hash(readFileSync(inside(cleanRoot, 'scope.json'))),
    ...(dot ? {scopeProvider: 'dot_source_identities', release: dot.release} : {}),
    purpose: 'Downstream version index, not a scientific completion certificate',
    counts: {papers: papers.length, papersWithResults: papers.filter(p => p.results.length).length, resultVersions: papers.reduce((n, p) => n + p.results.length, 0)}, papers};
}

export async function snapshotResultIndex(cleanRoot, snapshotId) {
  id(snapshotId, 'snapshotId');
  const record = await buildResultIndex(cleanRoot);
  const target = inside(cleanRoot, `synthesis/snapshots/${snapshotId}.json`, {mustExist: false});
  mkdirSync(path.dirname(target), {recursive: true});
  writeFileSync(target, JSON.stringify(record, null, 2) + '\n', {flag: 'wx'});
  return {path: target, counts: record.counts};
}
