// Neutral, local execution bookkeeping. This is not an OS sandbox or scientific review.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { verifyInput } from './inputs.mjs';
import { getReadingInput, getReadingView, verifyReadingSnapshot } from './reading.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const essentialEnvironment = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PATH'];
const threadEnvironment = ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'TBB_NUM_THREADS'];
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const read = (filename) => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const writeNew = (filename, value) => fs.writeFileSync(filename, json(value), { flag: 'wx' });
function fail(message) { throw new Error(message); }
function id(value, label) { if (typeof value !== 'string' || !ID.test(value)) fail(`Invalid ${label}`); return value; }
function isInside(root, target) { const rel = path.relative(root, target); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); }
function noLinks(filename) {
  let cursor = path.resolve(filename);
  while (true) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail(`Symlink/reparse path rejected: ${cursor}`);
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function within(root, ...parts) {
  const target = path.resolve(root, ...parts);
  if (!isInside(path.resolve(root), target)) fail('Path escapes its permitted root');
  noLinks(target); return target;
}
function fileHash(filename) {
  noLinks(filename);
  if (!fs.statSync(filename).isFile()) fail(`Not a regular file: ${filename}`);
  // Streaming avoids loading large source PDFs and runtime executables at once.
  const hash = crypto.createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filename, 'r');
  try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function inventory(root) {
  noLinks(root); const result = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = within(root, path.relative(root, dir), entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) result[path.relative(root, filename).split(path.sep).join('/')] = fileHash(filename);
      else fail(`Non-regular source/output rejected: ${filename}`);
    }
  }
  visit(root); return result;
}
function same(actual, expected, label) { if (json(actual) !== json(expected)) fail(`${label} changed; use a new run`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an explicit JSON object`);
  const normalized = JSON.parse(JSON.stringify(value)); same(normalized, value, label); return normalized;
}
function locations(cleanRoot, paperId, runId) {
  const root = path.resolve(cleanRoot); noLinks(root); id(paperId, 'paperId');
  const project = path.resolve(root, '..', '..');
  if (root !== path.join(project, 'research_followup', 'reproduction_clean')) fail('Expected project research_followup/reproduction_clean root');
  return { root, project, input: within(root, 'inputs', paperId, 'packet.json'), paper: within(root, 'papers', paperId),
    ...(runId ? { run: within(root, 'runs', paperId, id(runId, 'runId')) } : {}) };
}
function sourceFor(packet, paperId) {
  if (packet.paperId !== paperId || !packet.source || !path.isAbsolute(packet.source.path ?? '') || !HASH.test(packet.source.sha256 ?? '')) fail('Invalid same-paper source packet');
  if (fileHash(packet.source.path) !== packet.source.sha256) fail('Original PDF hash mismatch');
  return { path: packet.source.path, sha256: packet.source.sha256 };
}
function sourceSeal(projectRoot, paperId, source) {
  const sealPath = paperId === 'origin' ? 'research_tree/data/origin-source.json' : 'output/model_clean/manifest.json';
  const filename = within(projectRoot, sealPath); const seal = read(filename);
  const entry = paperId === 'origin' ? seal : seal.items?.find(item => `r${String(Number(item.record_number)).padStart(4, '0')}` === paperId);
  const expectedHash = paperId === 'origin' ? entry?.sourceSha256 : entry?.source_sha256;
  const sourceName = paperId === 'origin' ? path.basename((entry?.sourcePath ?? '').replaceAll('\\', '/')) : entry?.source_file;
  if (!sourceName || /[\\/]/.test(sourceName) || expectedHash !== source.sha256 || path.resolve(source.path) !== within(projectRoot, 'sources/original_pdfs', sourceName)) fail('Frozen original does not match authoritative source seal');
  return { path: sealPath, sha256: fileHash(filename) };
}
function command(chunk) {
  object(chunk, 'chunk'); id(chunk.id, 'chunkId');
  if (!path.isAbsolute(chunk.executable ?? '') || !Array.isArray(chunk.args) || chunk.args.some(a => typeof a !== 'string' || a.includes('\0'))) fail('Each command requires absolute executable and string args');
  if (/^(wolframkernel|wolframscript|mathkernel|mathematica|math)(\.exe)?$/i.test(path.basename(chunk.executable))) fail('Direct Wolfram launch blocked: machine-wide single-owner coordination is not integrated; use an independently compliant owner');
  for (const arg of chunk.args) {
    if (path.isAbsolute(arg) || /^[A-Za-z]:[\\/]/.test(arg) || /^(\.\.[\\/])|([\\/]\.\.([\\/]|$))/.test(arg)) fail('External/escaping path argument rejected; use ${SOURCE}, ${PACKET}, ${READING} or ${CONFIG}');
    if (arg.includes('${') && !/^(\$\{SOURCE\}(?:\/[A-Za-z0-9_.\/-]+)?|\$\{PACKET\}|\$\{READING\}|\$\{CONFIG\})$/.test(arg)) fail('Unknown or embedded command placeholder');
  }
  return { id: chunk.id, executable: chunk.executable, executableSha256: fileHash(chunk.executable), args: [...chunk.args] };
}
function processEnvironment(workerCount) {
  const env = {};
  for (const key of essentialEnvironment) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const key of threadEnvironment) env[key] = String(workerCount);
  return env;
}
function lock(runDir) {
  const filename = within(runDir, '.writer.lock');
  const token = crypto.randomUUID();
  writeNew(filename, { token, pid: process.pid, processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), acquiredAt: new Date().toISOString(), argv: process.argv });
  return () => { if (read(filename).token !== token) fail('Writer lock ownership changed; not removing it'); fs.unlinkSync(filename); };
}
function attempts(runDir, chunkId) {
  const dir = within(runDir, 'chunks', chunkId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map(name => {
    const match = /^attempt-(\d{4})\.(completed|failed|partial)$/.exec(name);
    if (!match) fail(`Unknown chunk state: ${name}`);
    return { number: Number(match[1]), state: match[2], dir: within(dir, name) };
  });
}
function outputInventory(attemptDir) {
  return { work: inventory(within(attemptDir, 'work')), stdout: fileHash(within(attemptDir, 'stdout.log')), stderr: fileHash(within(attemptDir, 'stderr.log')) };
}
function chunkState(record, runDir, chunk) {
  const history = attempts(runDir, chunk.id);
  let completed;
  for (const item of history) {
    if (item.state === 'partial') continue;
    const receiptPath = within(item.dir, 'receipt.json'); const receipt = read(receiptPath);
    if (receipt.fingerprint !== record.fingerprint || receipt.chunkId !== chunk.id || receipt.attempt !== item.number || receipt.state !== item.state) fail('Receipt does not match frozen run');
    same(outputInventory(item.dir), receipt.outputs, 'Chunk output');
    if (item.state === 'completed') {
      if (completed || receipt.exitCode !== 0 || receipt.signal !== null || receipt.error !== null || receipt.integrityError !== null) fail('Invalid/duplicate completed chunk');
      completed = { receiptPath, receiptSha256: fileHash(receiptPath), attempt: item.number };
    }
  }
  if (completed && (history.at(-1)?.state !== 'completed')) fail('Completed chunk followed by another attempt');
  return { id: chunk.id, state: completed ? 'completed' : history.at(-1)?.state ?? 'pending', attempts: history.length, ...(completed ?? {}) };
}

/** The run validates and freezes the authoritative packet, all files under this
 * new paper root, the PDF and the chosen approved reading edition if present.
 * freshContext is a human/agent declaration, never proof of isolation or review.
 */
export function createRun(cleanRoot, paperId, options) {
  object(options, 'options');
  const loc = locations(cleanRoot, paperId, options.runId); if (!loc.run) fail('runId is required');
  if (!Number.isSafeInteger(options.workerCount) || options.workerCount < 1) fail('workerCount must be an explicit positive integer');
  const fresh = object(options.freshContext, 'freshContext');
  if (fresh.historyInherited !== false || !fresh.contextId || !fresh.declaredBy) fail('An explicit fresh-context declaration is required');
  const config = object(options.config, 'config'); const environment = object(options.environment, 'environment');
  if (!Array.isArray(options.chunks) || options.chunks.length === 0) fail('Explicit nonempty chunk plan required');
  const chunks = options.chunks.map(command);
  if (new Set(chunks.map(c => c.id)).size !== chunks.length) fail('Duplicate chunkId');
  if (options.readingEditionVersion !== undefined && !/^(?:v[1-9]\d*|dot-[a-f0-9]{64})$/.test(options.readingEditionVersion)) fail('readingEditionVersion must name a legacy or Dot edition version');
  const readingOptions = options.readingEditionVersion === undefined ? {} : {version: options.readingEditionVersion};
  const {input: verifiedInput, edition: selectedEdition} = getReadingInput(loc.project, paperId, readingOptions);
  const inputRelative = path.relative(loc.project, verifiedInput.path).split(path.sep).join('/');
  if (selectedEdition?.provider !== 'dot' && verifiedInput.path !== loc.input) fail('Input exporter returned an unexpected path');
  if (selectedEdition?.provider === 'dot' && inputRelative !== `research_followup/reproduction_clean/inputs-dot/${selectedEdition.release}/${paperId}/packet.json`) fail('Dot input exporter returned an unexpected path');
  const packet = verifiedInput.packet; const source = sourceFor(packet, paperId); const inputSha256 = verifiedInput.sha256;
  if (options.expectedInputSha256 !== undefined && options.expectedInputSha256 !== inputSha256) fail('Input selection changed after contract validation; prepare against the selected input');
  const readingView = getReadingView(loc.project, paperId, selectedEdition?.provider === 'dot' ? {version: selectedEdition.version, release: selectedEdition.release, indexSha256: selectedEdition.indexSha256} : readingOptions);
  if (readingView.originalPacket.sha256 !== inputSha256) fail('Reading selection changed during run preparation');
  const codeFiles = inventory(loc.paper); if (!Object.keys(codeFiles).length) fail('New paper source/contract files are required');
  if (options.sourceFiles !== undefined) {
    if (!Array.isArray(options.sourceFiles)) fail('sourceFiles must list every same-paper file');
    for (const name of options.sourceFiles) { if (typeof name !== 'string' || path.isAbsolute(name)) fail('Invalid source file'); within(loc.paper, name); }
    same([...options.sourceFiles].sort(), Object.keys(codeFiles).sort(), 'Source file list');
  }
  const frozen = { schemaVersion: 1, paperId, runId: options.runId, inputSha256, packetPath: 'packet.json', readingViewPath: 'reading.json', readingViewSha256: digest(json(readingView)), configPath: 'config.json', sourceSha256: source.sha256, source, sourceSeal: sourceSeal(loc.project, paperId, source), codeFiles, config, environment,
    ...(selectedEdition?.provider === 'dot' ? {sourcePacketPath: inputRelative} : {}),
    workerCount: options.workerCount, chunks, freshContext: fresh, processEnvironment: processEnvironment(options.workerCount), host: { platform: process.platform, arch: process.arch, node: process.version } };
  const record = { ...frozen, fingerprint: digest(json(frozen)), createdAt: new Date().toISOString(),
    boundary: 'Trusted local command execution, not an OS sandbox; declarations do not prove source independence or scientific correctness.' };
  fs.mkdirSync(path.dirname(loc.run), { recursive: true }); fs.mkdirSync(loc.run); // Exclusive run ID, never overwrite.
  writeNew(within(loc.run, 'run.json'), record);
  writeNew(within(loc.run, record.configPath), config);
  fs.mkdirSync(within(loc.run, 'source'));
  fs.copyFileSync(verifiedInput.path, within(loc.run, 'packet.json'), fs.constants.COPYFILE_EXCL);
  writeNew(within(loc.run, record.readingViewPath), readingView);
  for (const name of Object.keys(codeFiles)) {
    const dest = within(loc.run, 'source', name); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(within(loc.paper, name), dest, fs.constants.COPYFILE_EXCL);
  }
  fs.mkdirSync(within(loc.run, 'chunks'));
  verifyRun(cleanRoot, paperId, options.runId);
  return { ...record, runDir: loc.run };
}

export function verifyRun(cleanRoot, paperId, runId, { requireCurrentSource = true } = {}) {
  const loc = locations(cleanRoot, paperId, runId); const record = read(within(loc.run, 'run.json'));
  const { fingerprint, createdAt, boundary, ...frozen } = record;
  if (record.paperId !== paperId || record.runId !== runId || record.schemaVersion !== 1 || digest(json(frozen)) !== fingerprint) fail('Run record fingerprint mismatch');
  if (record.packetPath !== 'packet.json' || fileHash(within(loc.run, record.packetPath)) !== record.inputSha256) fail('Frozen input packet changed');
  if (record.configPath !== 'config.json' || fileHash(within(loc.run, record.configPath)) !== digest(json(record.config))) fail('Frozen configuration changed');
  const packet = read(within(loc.run, record.packetPath));
  const source = sourceFor(packet, paperId); same(source, record.source, 'Source');
  if (source.sha256 !== record.sourceSha256) fail('Original source hash binding mismatch');
  same(sourceSeal(loc.project, paperId, source), record.sourceSeal, 'Original authority seal');
  let readingView = null;
  if (record.readingViewPath !== undefined || record.readingViewSha256 !== undefined) {
    if (record.readingViewPath !== 'reading.json' || fileHash(within(loc.run, record.readingViewPath)) !== record.readingViewSha256) fail('Frozen reading view changed');
    readingView = read(within(loc.run, record.readingViewPath));
    const sourcePacketPath = record.sourcePacketPath ? within(loc.project, record.sourcePacketPath) : loc.input;
    if (record.sourcePacketPath && (readingView.mode !== 'dot_latex' || record.sourcePacketPath !== `research_followup/reproduction_clean/inputs-dot/${readingView.edition?.release}/${paperId}/packet.json`)) fail('Frozen Dot input path mismatch');
    verifyReadingSnapshot(loc.project, readingView, {path: sourcePacketPath, sha256: record.inputSha256, packet});
  }
  if (requireCurrentSource) {
    const currentInput = readingView?.mode === 'dot_latex' ? getReadingInput(loc.project, paperId, {version: readingView.edition.version, release: readingView.edition.release, indexSha256: readingView.edition.indexSha256}).input : verifyInput(loc.project, paperId);
    if (currentInput.sha256 !== record.inputSha256) fail('Input packet changed; use a new run');
    same(inventory(loc.paper), record.codeFiles, 'Paper source');
  }
  same(inventory(within(loc.run, 'source')), record.codeFiles, 'Frozen source');
  if (requireCurrentSource) for (const chunk of record.chunks) if (fileHash(chunk.executable) !== chunk.executableSha256) fail('Runtime executable changed; use a new run');
  const chunks = record.chunks.map(c => chunkState(record, loc.run, c));
  const completionPath = within(loc.run, 'completion.json'); const completion = fs.existsSync(completionPath) ? read(completionPath) : null;
  if (completion) {
    if (completion.fingerprint !== fingerprint || completion.status !== 'computation_complete' || completion.scientificStatus !== 'not_assessed' || chunks.some(c => c.state !== 'completed')) fail('Invalid completion record');
    same(completion.receipts, Object.fromEntries(chunks.map(c => [c.id, c.receiptSha256])), 'Completion receipts');
  }
  return { runDir: loc.run, packetPath: within(loc.run, record.packetPath), readingViewPath: readingView ? within(loc.run, record.readingViewPath) : null, readingView, record, chunks, completion, verificationMode: requireCurrentSource ? 'current' : 'frozen_history', currentSourceChecked: requireCurrentSource, status: completion ? 'computation_complete' : 'incomplete' };
}

/** Failure is retained. Retrying is explicit; a crash/partial attempt requires
 * operator inspection and a new run, never automatic lock stealing or killing.
 */
export async function runChunk(cleanRoot, paperId, runId, chunkId, { retry = false } = {}) {
  id(chunkId, 'chunkId'); const loc = locations(cleanRoot, paperId, runId); const unlock = lock(loc.run);
  try {
    const verified = verifyRun(cleanRoot, paperId, runId);
    if (verified.completion) fail('Completed run is immutable');
    if (verified.chunks.some(c => c.state === 'partial')) fail('Partial attempt requires inspection and a new run');
    const chunk = verified.record.chunks.find(c => c.id === chunkId); if (!chunk) fail('Chunk not in frozen plan');
    const state = verified.chunks.find(c => c.id === chunkId);
    if (state.state === 'completed') return { ...state, reused: true };
    if (state.state === 'partial') fail('Partial attempt requires inspection and a new run');
    if (state.state === 'failed' && !retry) fail('Failed chunk requires explicit retry or a new run');
    if (state.state === 'pending' && retry) fail('Cannot retry a chunk that has not failed');
    const number = state.attempts + 1; if (number > 9999) fail('Attempt limit reached; create a new run');
    const attemptRoot = within(loc.run, 'chunks', chunkId); fs.mkdirSync(attemptRoot, { recursive: true });
    const prefix = `attempt-${String(number).padStart(4, '0')}`; const temp = within(attemptRoot, `${prefix}.partial`); fs.mkdirSync(temp);
    const work = within(temp, 'work'); fs.mkdirSync(work);
    if (chunk.args.includes('${READING}') && !verified.readingViewPath) fail('Legacy run has no frozen reading view; create a new run');
    const args = chunk.args.map(arg => arg === '${PACKET}' ? within(loc.run, 'packet.json') : arg === '${READING}' ? verified.readingViewPath : arg === '${CONFIG}' ? within(loc.run, 'config.json') : arg.startsWith('${SOURCE}') ? within(loc.run, 'source', arg.slice(9).replace(/^\//, '')) : arg);
    const stdout = fs.openSync(within(temp, 'stdout.log'), 'wx'); const stderr = fs.openSync(within(temp, 'stderr.log'), 'wx');
    const start = { fingerprint: verified.record.fingerprint, chunkId, attempt: number, executable: chunk.executable, args, cwd: work, startedAt: new Date().toISOString(), runnerPid: process.pid };
    let child; let outcome;
    try {
      outcome = await new Promise(resolve => {
        try {
          child = spawn(chunk.executable, args, { cwd: work, env: verified.record.processEnvironment, shell: false, windowsHide: true, stdio: ['ignore', stdout, stderr] });
          let error = null;
          child.on('error', value => { error = value.message; });
          child.on('close', (exitCode, signal) => resolve({ exitCode, signal, error }));
          // A metadata write failure must not release the writer while its child
          // still runs. Keep waiting for this exact child, then retain failure.
          try { writeNew(within(temp, 'process.json'), { ...start, pid: child.pid ?? null }); }
          catch (value) { error = `Process metadata write failed: ${value.message}`; }
        } catch (error) { resolve({ exitCode: null, signal: null, error: error.message }); }
      });
    } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
    // Mutations during a command invalidate the attempt, even after exit 0.
    let integrityError = null;
    try { verifyRun(cleanRoot, paperId, runId); } catch (error) { integrityError = error.message; }
    const success = outcome.exitCode === 0 && outcome.signal === null && outcome.error === null && !integrityError;
    const receipt = { ...start, pid: child?.pid ?? null, ...outcome, integrityError, endedAt: new Date().toISOString(), state: success ? 'completed' : 'failed', outputs: outputInventory(temp) };
    writeNew(within(temp, 'receipt.json'), receipt);
    const dest = within(attemptRoot, `${prefix}.${receipt.state}`); fs.renameSync(temp, dest);
    return { id: chunkId, state: receipt.state, attempt: number, reused: false, receiptPath: within(dest, 'receipt.json'), receiptSha256: fileHash(within(dest, 'receipt.json')) };
  } finally { unlock(); }
}

export function finishRun(cleanRoot, paperId, runId) {
  const loc = locations(cleanRoot, paperId, runId); const unlock = lock(loc.run);
  try {
    const verified = verifyRun(cleanRoot, paperId, runId);
    if (verified.completion) fail('Completed run is immutable');
    if (verified.chunks.some(c => c.state !== 'completed')) fail('Cannot finish: not every planned chunk completed');
    const completion = { schemaVersion: 1, paperId, runId, fingerprint: verified.record.fingerprint, status: 'computation_complete', scientificStatus: 'not_assessed', completedAt: new Date().toISOString(), receipts: Object.fromEntries(verified.chunks.map(c => [c.id, c.receiptSha256])) };
    const pending = within(loc.run, 'completion.partial'); writeNew(pending, completion);
    fs.renameSync(pending, within(loc.run, 'completion.json')); return completion;
  } finally { unlock(); }
}
