// Read-only, hash-bound Dot source packages. User selection is not old-workflow
// acceptance, scientific validation, a compiler result, or execution permission.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {loadSourceResolver} from '../sources/resolve-source.mjs';

const ID = /^(?:origin|r\d{4})$/;
const SHA = /^[a-f0-9]{64}$/;
const RELEASE = /^dot-\d{8}(?:-[a-zA-Z0-9_-]+)?$/;
export const DOT_VERSION = /^dot-[a-f0-9]{64}$/;
const POINTER = 'reconstructed_sources/current.json';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error('Dot reconstruction: ' + message); };
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function relative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || path.win32.isAbsolute(value) || /[:\\\x00-\x1f]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) fail('invalid relative path');
  return value;
}
function inside(root, name) {
  relative(name); root = path.resolve(root);
  if (fs.lstatSync(root).isSymbolicLink() || !same(fs.realpathSync(root), root)) fail('redirected root');
  let current = root;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail('redirected file');
  }
  if (!fs.statSync(current).isFile()) fail('not a regular file: ' + name);
  return current;
}
function read(root, name, expected) {
  const filename = inside(root, name), bytes = fs.readFileSync(filename), sha256 = digest(bytes);
  if (expected !== undefined && (!SHA.test(expected) || expected !== sha256)) fail('hash mismatch: ' + name);
  return {path: filename, sha256, value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))};
}
function checked(root, value) {
  if (!value || !SHA.test(value.sha256 ?? '')) fail('invalid file hash');
  const filename = inside(root, value.path), bytes = fs.readFileSync(filename);
  if (digest(bytes) !== value.sha256 || (value.bytes !== undefined && value.bytes !== bytes.length)) fail('hash/size mismatch: ' + value.path);
  return {...value, path: filename, relative: value.path};
}

// Any registered pointer (including a malformed one) prevents implicit legacy
// fallback. A dangling link is present, not the absence of a selection.
export function hasDotSelection(projectRoot) {
  const root = path.resolve(projectRoot);
  let required = false;
  for (const marker of ['reconstructed_sources/selection-required.json', 'paper_library/retired-by-dot.json']) {
    try { fs.lstatSync(path.join(root, marker)); required = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of ['reconstructed_sources', POINTER]) {
    try {
      const value = fs.lstatSync(path.join(root, name));
      if (value.isSymbolicLink()) fail('redirected selection');
    } catch (error) { if (error.code === 'ENOENT') { if (required) fail('required current selection is missing; legacy fallback is retired'); return false; } throw error; }
  }
  return true;
}

export function loadDotIndex(projectRoot, {release, indexSha256} = {}) {
  projectRoot = path.resolve(projectRoot);
  let pointer = null;
  if (release === undefined) {
    if (!hasDotSelection(projectRoot)) return null;
    pointer = read(projectRoot, POINTER);
    const p = pointer.value;
    if (p.schemaVersion !== 1 || p.provider !== 'dot' || !RELEASE.test(p.release ?? '') || p.index !== `reconstructed_sources/${p.release}/index.json` || !SHA.test(p.indexSha256 ?? '')) fail('invalid current pointer');
    release = p.release; indexSha256 = p.indexSha256;
  }
  if (!RELEASE.test(release ?? '') || !SHA.test(indexSha256 ?? '')) fail('explicit release requires exact index hash');
  const found = read(projectRoot, `reconstructed_sources/${release}/index.json`, indexSha256), index = found.value;
  if (index.schemaVersion !== 1 || index.provider !== 'dot' || index.release !== release || !Array.isArray(index.papers) || !index.papers.length) fail('invalid release index');
  const seen = new Set();
  for (const entry of index.papers) {
    if (!ID.test(entry.paperId ?? '') || seen.has(entry.paperId) || !DOT_VERSION.test(entry.version ?? '') || entry.record !== `papers/${entry.paperId}/record.json` || !SHA.test(entry.recordSha256 ?? '')) fail('invalid or duplicate indexed paper');
    seen.add(entry.paperId);
  }
  return {projectRoot, release, root: path.dirname(found.path), index, indexPath: found.path, indexSha256: found.sha256, pointer};
}

export function dotSourceAuthority(projectRoot, paperId) {
  if (!ID.test(paperId ?? '')) fail('invalid paper identity');
  let name, logicalPath, sha256, pages;
  if (paperId === 'origin') {
    const seal = read(projectRoot, 'research_tree/data/origin-source.json').value;
    if (seal.paperId !== paperId) fail('origin seal identity mismatch');
    logicalPath = seal.sourcePath; sha256 = seal.sourceSha256; pages = seal.sourcePages;
    name = path.basename(String(logicalPath).replaceAll('\\', '/'));
  } else {
    const seal = read(projectRoot, 'output/model_clean/manifest.json').value;
    const entries = (seal.items ?? []).filter(x => `r${String(Number(x.record_number)).padStart(4, '0')}` === paperId);
    if (entries.length !== 1) fail('original seal missing or duplicated');
    const entry = entries[0]; name = entry.source_file; sha256 = entry.source_sha256; pages = entry.source_pages;
    if (!path.isAbsolute(seal.source_directory ?? '')) fail('invalid original source directory');
    logicalPath = path.join(seal.source_directory, relative(name));
  }
  if (!SHA.test(sha256 ?? '') || !path.isAbsolute(logicalPath ?? '') || typeof name !== 'string' || /[\\/]/.test(name)) fail('invalid original seal');
  const resolved = loadSourceResolver(projectRoot)(logicalPath, sha256);
  const original = inside(projectRoot, 'sources/original_pdfs/' + relative(name));
  if (!same(path.resolve(resolved), original) || digest(fs.readFileSync(original)) !== sha256) fail('original PDF hash/location mismatch');
  return {path: original, sha256, ...(Number.isInteger(pages) && pages > 0 ? {pages} : {})};
}

export function getDotEdition(projectRoot, paperId, options = {}) {
  if (!ID.test(paperId ?? '')) fail('invalid paper identity');
  if (options.version !== undefined && !DOT_VERSION.test(options.version)) fail('invalid Dot version');
  const selected = loadDotIndex(projectRoot, options);
  if (!selected) { if (options.version !== undefined) fail('requested Dot release is unavailable'); return null; }
  const entry = selected.index.papers.find(x => x.paperId === paperId);
  if (!entry) fail('paper is absent from selected release: ' + paperId);
  if (options.version !== undefined && options.version !== entry.version) fail('requested version is not in the selected release; pin its release and index hash');
  const found = read(selected.root, entry.record, entry.recordSha256), record = found.value;
  if (record.schemaVersion !== 1 || record.provider !== 'dot' || record.paperId !== paperId || record.version !== entry.version || record.status !== 'user_selected_dot_reconstruction') fail('record identity/status mismatch');
  const archive = checked(selected.root, record.archive);
  if (archive.relative !== `archives/${paperId}.zip` || record.version !== 'dot-' + archive.sha256) fail('archive version identity mismatch');
  const source = dotSourceAuthority(projectRoot, paperId);
  if (record.source?.sha256 !== source.sha256) fail('record original differs from authoritative source');
  const files = record.files;
  if (!files || !Array.isArray(files.all) || !files.all.length || !Array.isArray(files.assets) || !Array.isArray(files.dependencies)) fail('incomplete file manifest');
  const all = files.all.map(item => checked(selected.root, item)), byName = new Map();
  for (const item of all) {
    if (!item.relative.startsWith(`papers/${paperId}/`) || item.relative === entry.record || byName.has(item.relative.toLowerCase())) fail('duplicate or out-of-paper package member');
    byName.set(item.relative.toLowerCase(), item);
  }
  function declared(value, extensions, label) {
    const known = byName.get(relative(value?.path).toLowerCase());
    if (!known || known.relative !== value.path || known.sha256 !== value.sha256 || !extensions.test(known.relative)) fail('undeclared/invalid ' + label);
    return known;
  }
  const latex = declared(files.latex, /\.tex$/i, 'entry TeX');
  const latexEntries = (files.latexEntries ?? [files.latex]).map(item => declared(item, /\.tex$/i, 'TeX entry'));
  if (!latexEntries.some(item => item.relative === latex.relative)) fail('primary TeX missing from entry list');
  const assets = files.assets.map(item => declared(item, /\.(?:pdf|png|jpe?g|eps|ps|svg|tiff?|bmp)$/i, 'asset'));
  const dependencies = files.dependencies.map(item => declared(item, /\.(?:tex|cls|sty|clo|def|cfg|fd|bib|bbl|bst|otf|ttf|pfb|tfm|map|enc|vf|ist|dat|csv|tsv)$/i, 'dependency'));
  const mapping = files.mapping ? declared(files.mapping, /\.(?:json|csv|tsv|txt|md)$/i, 'mapping') : null;
  return {provider: 'dot', paperId, version: entry.version, release: selected.release, indexPath: selected.indexPath, indexSha256: selected.indexSha256,
    recordPath: found.path, recordSha256: found.sha256, record, root: selected.root, latex, latexEntries, pdf: null, mapping, assets, dependencies, archive, source};
}

export function getDotStatus(projectRoot) {
  const selected = loadDotIndex(projectRoot);
  if (!selected) return null;
  const papers = selected.index.papers.map(row => {
    const item = getDotEdition(projectRoot, row.paperId, {release: selected.release, indexSha256: selected.indexSha256});
    return {paperId: item.paperId, version: item.version, latex: item.latex.path};
  });
  return {schemaVersion: 1, provider: 'dot', release: selected.release, indexSha256: selected.indexSha256, total: papers.length,
    counts: {user_selected_dot_reconstruction: papers.length}, papers,
    claimBoundary: 'Hash-verified selected source packages; not old workflow acceptance or scientific correctness.'};
}
