// A small read-only registry: approval is a user decision, not a compiler claim.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadSourceResolver } from '../sources/resolve-source.mjs';
import {validateWorkflowAcceptance,validateSealedDependencies} from './workflow-contract.mjs';
import {acceptanceRevocations,assertEditionEffective} from './revocations.mjs';

const PAPER_ID = /^(?:origin|r\d{4})$/;
const VERSION = /^v[1-9]\d*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['not_reconstructed', 'pending_review', 'user_approved', 'workflow_accepted']);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

function fail(message) { throw new Error(`Paper library: ${message}`); }

function relativeName(value, label) {
  if (typeof value !== 'string' || !value || /[:\x00-\x1f]/.test(value) ||
      path.isAbsolute(value) || path.win32.isAbsolute(value)) fail(`invalid ${label} path`);
  const parts = value.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    fail(`invalid ${label} path`);
  }
  return parts.join('/');
}

// Reject links at every directory level as well as at the final file. This is
// integrity validation, not an OS sandbox or a hostile-concurrent-writer lock.
function insideFile(root, relative, label) {
  const normalized = relativeName(relative, label);
  root = path.resolve(root);
  if (!samePath(fs.realpathSync(root), root) || fs.lstatSync(root).isSymbolicLink()) {
    fail(`${label} root is a symbolic link`);
  }
  let current = root;
  for (const part of normalized.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail(`${label} uses a symbolic link`);
  }
  if (!fs.statSync(current).isFile()) fail(`${label} is not a regular file`);
  return current;
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { fail(`cannot read JSON ${filename}: ${error.message}`); }
}

function loadIndex(projectRoot) {
  projectRoot = path.resolve(projectRoot);
  const indexPath = insideFile(projectRoot, 'paper_library/index.json', 'index');
  const index = readJson(indexPath);
  if (index.schemaVersion !== 1 || !Array.isArray(index.papers)) fail('invalid index schema');
  const seen = new Set();
  for (const item of index.papers) {
    if (!PAPER_ID.test(item.paperId ?? '') || seen.has(item.paperId) || !STATUSES.has(item.status)) {
      fail('invalid or duplicate index paper');
    }
    seen.add(item.paperId);
    if (item.currentEdition == null) {
      if (item.editionRecord != null || ['user_approved','workflow_accepted'].includes(item.status)) fail(`incomplete edition index for ${item.paperId}`);
    } else {
      if (!VERSION.test(item.currentEdition) ||
          item.editionRecord !== `${item.paperId}/${item.currentEdition}/edition.json`) {
        fail(`invalid edition index for ${item.paperId}`);
      }
      if (!['user_approved','workflow_accepted'].includes(item.status)) fail(`current edition approval disagrees with index for ${item.paperId}`);
    }
  }
  return { projectRoot, index, indexPath };
}

function sourceAuthority(projectRoot, paperId) {
  let logical, expected;
  if (paperId === 'origin') {
    const seal = readJson(insideFile(projectRoot, 'research_tree/data/origin-source.json', 'origin seal'));
    if (seal.paperId !== 'origin') fail('origin seal identity mismatch');
    logical = seal.sourcePath;
    expected = seal.sourceSha256;
  } else {
    const manifest = readJson(insideFile(projectRoot, 'output/model_clean/manifest.json', 'source seal'));
    const matches = (manifest.items ?? []).filter(item => `r${String(item.record_number).padStart(4, '0')}` === paperId);
    if (matches.length !== 1) fail(`source seal missing or duplicated for ${paperId}`);
    const item = matches[0];
    const filename = relativeName(item.source_file, 'original PDF');
    if (filename.includes('/') || !path.isAbsolute(manifest.source_directory ?? '')) fail('invalid source seal path');
    logical = path.join(manifest.source_directory, filename);
    expected = item.source_sha256;
  }
  if (!SHA256.test(expected ?? '') || !path.isAbsolute(logical ?? '')) fail('invalid source authority');
  const resolved = loadSourceResolver(projectRoot)(logical, expected);
  const sourcePath = insideFile(projectRoot, path.relative(projectRoot, resolved), 'original PDF');
  if (sha256(fs.readFileSync(sourcePath)) !== expected) fail(`original PDF hash mismatch for ${paperId}`);
  return { path: sourcePath, sha256: expected };
}

function fileRecord(root, entry, label) {
  if (!entry || !SHA256.test(entry.sha256 ?? '')) fail(`invalid ${label} hash`);
  const relative = relativeName(entry.path, label);
  const filename = insideFile(root, relative, label);
  if (sha256(fs.readFileSync(filename)) !== entry.sha256) fail(`${label} hash mismatch`);
  return { ...entry, path: filename, relative };
}

function stripTexComments(text) {
  return text.split(/\r?\n/).map(line => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '%') continue;
      let escapes = 0;
      for (let p = i - 1; p >= 0 && line[p] === '\\'; p--) escapes++;
      if (!(escapes % 2)) return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

function validateGraphics(latex, declared, root) {
  // Intentionally support literal references, not execution/expansion of TeX.
  // A macro-based dependency needs explicit normalization before publication.
  for (const source of declared.filter(file => path.extname(file.path).toLowerCase() === '.tex')) {
    const text = stripTexComments(fs.readFileSync(source.path, 'utf8'));
    if (/\\(?:graphicspath|DeclareGraphicsExtensions|input|include|import|subimport)\b/.test(text)) {
      fail('external TeX inputs or graphics-path macros are unsupported; publish a self-contained entry');
    }
    const commands = [...text.matchAll(/\\includegraphics\b\*?/g)];
    for (const command of commands) {
      const tail = text.slice(command.index + command[0].length);
      const match = tail.match(/^\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]+)\}/);
      if (!match || /[\\#%$]/.test(match[1])) fail('includegraphics must use a literal local asset');
      const requested = relativeName(match[1], 'includegraphics');
      const candidates = path.extname(requested) ? [requested]
        : ['.pdf', '.png', '.jpg', '.jpeg', '.eps'].map(extension => requested + extension);
      const matches = declared.filter(file => candidates.includes(file.relative));
      if (matches.length !== 1 || matches[0].path === latex.path ||
          !/\.(?:pdf|png|jpe?g|eps)$/i.test(matches[0].relative)) {
        fail(`includegraphics asset is missing, ambiguous, or undeclared: ${requested}`);
      }
      insideFile(root, matches[0].relative, 'includegraphics');
    }
  }
}

/** Return an integrity-checked user-approved edition, or null if none exists.
 * A version pins a historical approved edition; newer approvals do not rewrite it.
 * Source-map details are returned as a locator, not as automatic academic input.
 */
export function getApprovedEdition(projectRoot, paperId, { version } = {}) {
  if (!PAPER_ID.test(paperId ?? '')) fail('invalid paper identity');
  if (version != null && !VERSION.test(version)) fail('invalid requested version');
  // Older neutral-input workspaces may not have initialized a library yet.
  // Only that exact absence falls back; broken links/registered files never do.
  if (version == null) {
    for (const relative of ['paper_library', 'paper_library/index.json']) {
      let stat;
      try { stat = fs.lstatSync(path.join(path.resolve(projectRoot), relative)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (stat.isSymbolicLink()) fail('library/index uses a symbolic link');
    }
  }
  const loaded = loadIndex(projectRoot);
  projectRoot = loaded.projectRoot;
  const revoked = acceptanceRevocations(projectRoot,loaded.index);
  const item = loaded.index.papers.find(paper => paper.paperId === paperId);
  if (!item) fail(`paper is outside the library scope: ${paperId}`);
  version ??= item.currentEdition;
  if (version == null) return null;
  const recordPath = insideFile(projectRoot, `paper_library/${paperId}/${version}/edition.json`, 'edition record');
  const recordBytes = fs.readFileSync(recordPath);
  const recordSha256 = sha256(recordBytes);
  assertEditionEffective(revoked,paperId,version,recordSha256);
  if (version === item.currentEdition && item.editionRecordSha256 != null && item.editionRecordSha256 !== recordSha256) {
    fail('edition record hash mismatch');
  }
  const record = readJson(recordPath);
  if (![1,2].includes(record.schemaVersion) || record.paperId !== paperId || record.version !== version) fail('edition identity mismatch');
  const approval = record.approval;
  if (record.schemaVersion===1&&(!approval || approval.status !== 'user_approved' || approval.by !== 'user' ||
      typeof approval.statement !== 'string' || !approval.statement.trim() ||
      typeof approval.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(approval.at) || !Number.isFinite(Date.parse(approval.at)))) {
    fail('edition does not carry an explicit user approval');
  }
  if (version === item.currentEdition && item.status !== approval.status) fail('current edition approval disagrees with index');
  const source = sourceAuthority(projectRoot, paperId);
  if (!record.source || !path.isAbsolute(record.source.path ?? '') ||
      !samePath(record.source.path, source.path) || record.source.sha256 !== source.sha256) {
    fail('edition original PDF disagrees with authoritative seal');
  }
  const root = path.dirname(recordPath);
  const files = record.files;
  if(record.schemaVersion===2)validateWorkflowAcceptance(record,(entry,label)=>fileRecord(root,entry,label));
  if (!files || !Array.isArray(files.assets)) fail('invalid edition file manifest');
  const latex = fileRecord(root, files.latex, 'LaTeX');
  const pdf = fileRecord(root, files.pdf, 'rendered PDF');
  const mapping = fileRecord(root, files.mapping, 'source mapping');
  if (path.extname(latex.path).toLowerCase() !== '.tex' || path.extname(pdf.path).toLowerCase() !== '.pdf' ||
      path.extname(mapping.path).toLowerCase() !== '.json') fail('invalid entry file extensions');
  const assets = files.assets.map(asset => {
    if (!asset.kind || typeof asset.kind !== 'string') fail('asset kind is missing');
    return fileRecord(root, asset, 'asset');
  });
  const review = {};
  if (record.review !== undefined) {
    if (!record.review || typeof record.review !== 'object' || Array.isArray(record.review)) fail('invalid review attachments');
    for (const [name, entry] of Object.entries(record.review)) review[name] = fileRecord(root, entry, `review ${name}`);
  }
  const dependencies=(files.dependencies||[]).map(entry=>fileRecord(root,entry,'dependency'));
  const declared = [latex, pdf, mapping, ...assets, ...dependencies, ...Object.values(review)];
  const paths = declared.map(file => file.relative.toLowerCase());
  if (new Set(paths).size !== paths.length) fail('duplicate edition file declaration');
  if(record.schemaVersion===2)validateSealedDependencies(record,declared,root);else validateGraphics(latex, declared, root);
  return { paperId, version, recordPath, recordSha256, record, root, latex, pdf, mapping, assets, dependencies, review, source };
}

export function getLibraryStatus(projectRoot) {
  const { index } = loadIndex(projectRoot);
  const counts = { not_reconstructed: 0, pending_review: 0, user_approved: 0, workflow_accepted: 0 };
  const approved = [];
  for (const item of index.papers) {
    counts[item.status]++;
    if (item.currentEdition != null) {
      const edition = getApprovedEdition(projectRoot, item.paperId);
      approved.push({ paperId: item.paperId, version: edition.version, latex: edition.latex.path });
    }
  }
  return { schemaVersion: 1, total: index.papers.length, counts, approved };
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const [command, paperId, version] = process.argv.slice(2);
    let result;
    if (command === 'status') result = getLibraryStatus(projectRoot);
    else if (command === 'paper' && paperId) {
      const edition = getApprovedEdition(projectRoot, paperId, { version });
      result = edition ? {
        paperId, version: edition.version, status: edition.record.approval.status,
        latex: edition.latex, pdf: edition.pdf, assets: edition.assets, ...(edition.record.schemaVersion===2?{dependencies:edition.dependencies}:{}),
        source: edition.source, recordPath: edition.recordPath, recordSha256: edition.recordSha256,
      } : { paperId, status: 'no_approved_edition' };
    } else fail('usage: node paper_library/library.mjs status | paper <paperId> [version]');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
