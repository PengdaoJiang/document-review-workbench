// Neutral input preparation. This module does not reproduce or judge a paper.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadSourceResolver} from '../../../sources/resolve-source.mjs';
import {replayJournal} from '../../../research_tree/src/journal-model.mjs';

const BASE = 'research_followup/reproduction_clean';
const MANIFEST = 'output/model_clean/manifest.json';
const ORIGIN = 'research_tree/data/origin-source.json';
const REFINEMENT = 'research_tree/topic_review_20260929/refinement_20260930/records';
const ALIASES = 'docs/semantic_reconstruction/AUTHORITY_PATHS.json';
const idPattern = /^(origin|r\d{4})$/;
const hashPattern = /^[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const insist = (condition, message) => { if (!condition) throw new Error(message); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function safePath(projectRoot, relative, {allowMissing = false} = {}) {
  const root = path.resolve(projectRoot);
  insist(!path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'), 'Unsafe project-relative path');
  insist(!fs.lstatSync(root).isSymbolicLink() && samePath(fs.realpathSync(root), root), 'Project root must not be redirected');
  const result = path.resolve(root, relative);
  const relation = path.relative(root, result);
  insist(relation !== '..' && !relation.startsWith('..' + path.sep) && !path.isAbsolute(relation), 'Path escapes the project root');
  const parts = relation.split(path.sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      insist(!fs.lstatSync(cursor).isSymbolicLink(), 'Symlink or junction is not an allowed input/output: ' + cursor);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return result;
}

function read(projectRoot, relative) {
  const filename = safePath(projectRoot, relative);
  insist(fs.statSync(filename).isFile(), 'Expected ordinary file: ' + relative);
  const bytes = fs.readFileSync(filename);
  return {path: relative, sha256: digest(bytes), value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))};
}

function validId(id) { insist(typeof id === 'string' && idPattern.test(id), 'Invalid paperId'); return id; }
function validHash(value) { insist(hashPattern.test(value || ''), 'Invalid sealed source hash'); return value; }
function validPage(page, maximum) { insist(Number.isInteger(page) && page >= 1 && page <= maximum, 'Invalid original page'); return page; }
function validBox(box) {
  insist(Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1], 'Invalid exclusion/evidence bounding box');
  return [...box];
}

function authorities(projectRoot) {
  const manifest = read(projectRoot, MANIFEST), origin = read(projectRoot, ORIGIN);
  insist(Array.isArray(manifest.value.items) && manifest.value.items.length === 208, 'Expected sealed 208-paper corpus');
  const papers = new Map();
  for (const item of manifest.value.items) {
    insist(/^\d{1,4}$/.test(String(item.record_number)) && Number(item.record_number) > 0, 'Invalid manifest record number');
    const id = validId('r' + String(Number(item.record_number)).padStart(4, '0'));
    insist(!papers.has(id), 'Duplicate sealed paper identity');
    insist(typeof item.source_file === 'string' && !/[\\/:\x00]/.test(item.source_file) && item.source_file.toLowerCase().endsWith('.pdf'), 'Unsafe sealed filename');
    insist(Number.isInteger(item.source_pages) && item.source_pages > 0, 'Missing sealed original-page count');
    papers.set(id, {
      paperId: id, title: String(item.title), doi: String(item.doi || ''),
      sourceSha256: validHash(item.source_sha256), sourcePages: item.source_pages,
      sourceFile: item.source_file,
      logicalPath: path.join(manifest.value.source_directory, item.source_file), item,
    });
  }
  const anchor = origin.value;
  insist(anchor.paperId === 'origin' && Number.isInteger(anchor.sourcePages) && anchor.sourcePages > 0, 'Invalid independent origin seal');
  papers.set('origin', {
    paperId: 'origin', title: String(anchor.title), doi: String(anchor.doi || ''),
    sourceSha256: validHash(anchor.sourceSha256), sourcePages: anchor.sourcePages,
    sourceFile: path.basename(anchor.sourcePath.replaceAll('\\', '/')),
    logicalPath: anchor.sourcePath, item: anchor,
  });
  return {manifest, origin, papers};
}

function identity(paper) {
  return {paperId: paper.paperId, title: paper.title, doi: paper.doi, sourceSha256: paper.sourceSha256, sourcePages: paper.sourcePages};
}

/** Build the scheduling-only, fixed 199-paper scope. No old priorities or reasons. */
export function buildScope(projectRoot) {
  const {manifest, origin, papers} = authorities(projectRoot);
  const directory = safePath(projectRoot, REFINEMENT);
  const records = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
  insist(records.length === 209, 'Scope requires exactly 209 refinement identity records');
  const included = [], excluded = [], scopeSources = [];
  const counts = {current: 0, reserve: 0, excluded: 0};
  for (const filename of records) {
    const id = validId(filename.slice(0, -5));
    const record = read(projectRoot, REFINEMENT + '/' + filename);
    insist(record.value.paperId === id && papers.has(id), 'Unknown or mismatched scope identity');
    const collection = record.value.placement?.collection;
    insist(Object.hasOwn(counts, collection), 'Unsupported scope placement');
    counts[collection]++;
    if (collection === 'excluded') excluded.push(id);
    else included.push(identity(papers.get(id)));
    scopeSources.push({paperId: id, sha256: record.sha256});
  }
  insist(counts.current === 98 && counts.reserve === 101 && counts.excluded === 10 && included.some(p => p.paperId === 'origin'), 'Unexpected fixed-scope membership; explicit scope revision required');
  return {
    schemaVersion: 1,
    purpose: 'Scheduling identities only; not scientific input or reproduction progress.',
    counts: {included: included.length, excluded: excluded.length, total: papers.size},
    papers: included, excludedPaperIds: excluded,
    authority: {manifestSha256: manifest.sha256, originSealSha256: origin.sha256, scopeSources},
  };
}

function writeOnce(projectRoot, relative, value) {
  const filename = safePath(projectRoot, relative, {allowMissing: true});
  const bytes = Buffer.from(encoded(value));
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  safePath(projectRoot, path.relative(path.resolve(projectRoot), path.dirname(filename)));
  let created = false;
  try { fs.writeFileSync(filename, bytes, {flag: 'wx'}); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  safePath(projectRoot, relative);
  insist(fs.readFileSync(filename).equals(bytes), 'Existing immutable input differs; do not overwrite: ' + relative);
  return {path: filename, sha256: digest(bytes), created};
}

export function initializeScope(projectRoot) {
  const scope = buildScope(projectRoot);
  return {...writeOnce(projectRoot, BASE + '/scope.json', scope), scope};
}

function verifiedScope(projectRoot) {
  const current = buildScope(projectRoot);
  const stored = read(projectRoot, BASE + '/scope.json');
  insist(encoded(stored.value) === encoded(current), 'Scope no longer matches authoritative membership and seals');
  return current;
}

function originalSource(projectRoot, paper) {
  safePath(projectRoot, 'sources/source-locations.json');
  const resolver = loadSourceResolver(projectRoot);
  const location = path.resolve(resolver(paper.logicalPath, paper.sourceSha256));
  const root = path.resolve(projectRoot);
  const expected = safePath(root, 'sources/original_pdfs/' + paper.sourceFile);
  insist(samePath(location, expected), 'Original source must remain in the protected source directory');
  insist(fs.statSync(location).isFile(), 'Original source is not a file');
  insist(digest(fs.readFileSync(location)) === paper.sourceSha256, 'Original PDF no longer matches its unchanged seal');
  return {path: location, sha256: paper.sourceSha256, pages: paper.sourcePages};
}

function exclusionBoundaries(projectRoot, paper) {
  if (paper.paperId === 'origin') {
    insist(typeof paper.item.readingScope === 'string' && paper.item.readingScope.trim(), 'Origin reading boundary is missing');
    return {pageNumbering: 'one-based original PDF', readingScope: paper.item.readingScope, excludedOriginalPages: [], excludedRegions: []};
  }
  const item = paper.item;
  const dropped = [...(item.dropped_original_pages || [])].map(page => validPage(page, paper.sourcePages));
  insist(new Set(dropped).size === dropped.length, 'Duplicate dropped-page boundary');
  const retained = Array.from({length: paper.sourcePages}, (_, i) => i + 1).filter(page => !dropped.includes(page));
  insist(retained.length === item.clean_pages, 'Original/retained page mapping is inconsistent');
  const regions = [...(item.redactions || []), ...(item.article_boundary_removals || [])].map(region => ({
    originalPage: validPage(region.original_page, paper.sourcePages), bbox: validBox(region.bbox),
  }));
  const aliasSource = read(projectRoot, ALIASES);
  const alias = aliasSource.value.aliases?.[paper.paperId];
  const mappingPath = alias?.mapping || `output/latex/preservation/${paper.paperId}/mapping.json`;
  const mapping = read(projectRoot, mappingPath);
  if (alias) {
    insist(mapping.sha256 === alias.mapping_sha256 && alias.source_sha256 === paper.sourceSha256, 'Historical mapping alias seal mismatch');
    const original = mapping.value.artifacts?.desktop_source_pdf;
    insist(original?.sha256 === paper.sourceSha256, 'Pilot mapping source seal mismatch');
    const blank = mapping.value.artifacts?.blank_region_specification;
    insist(blank && typeof blank.path === 'string', 'Pilot exclusion specification missing');
    // The sealed historical specification remains beside the mapping after retirement.
    const blankRelative = path.posix.dirname(mappingPath.replaceAll('\\', '/')) + '/' + path.win32.basename(blank.path);
    const specification = read(projectRoot, blankRelative);
    insist(specification.sha256 === blank.sha256, 'Pilot exclusion specification seal mismatch');
    insist(specification.value.units === 'pt' && specification.value.origin === 'top-left', 'Unsupported pilot coordinate convention');
    for (const region of specification.value.regions || []) {
      const page = retained[validPage(region.page, retained.length) - 1];
      regions.push({originalPage: page, bbox: validBox(region.box)});
    }
  } else {
    insist(String(mapping.value.record_number) === String(Number(paper.paperId.slice(1))) && mapping.value.source_file === paper.sourceFile && mapping.value.reference_pdf?.sha256 === item.clean_pdf_sha256, 'Preservation mapping identity mismatch');
    insist(Array.isArray(mapping.value.excluded_visible_elements), 'Missing preservation exclusion list');
    for (const region of mapping.value.excluded_visible_elements) {
      const page = retained[validPage(region.page, retained.length) - 1];
      regions.push({originalPage: page, bbox: validBox(region.box)});
    }
  }
  return {
    pageNumbering: 'one-based original PDF', coordinateSystem: 'PDF points, top-left origin; original PDF geometry',
    excludedOriginalPages: dropped, excludedRegions: regions,
    boundarySourceSha256: mapping.sha256,
  };
}

/** Only literal same-paper evidence is exported, never the interpretive slice prose. */
export function selectSourceSlices(reading, paper) {
  if (!reading) return [];
  const evidence = new Map();
  for (const value of reading.review?.evidence || []) {
    if (value.assertionKind !== 'source_fact' || value.reviewStatus !== 'reviewed' || value.sourcePaperId !== paper.paperId || value.sourcePdfSha256 !== paper.sourceSha256) continue;
    if (!(typeof value.excerpt === 'string' && value.excerpt.trim()) && !value.bbox) continue;
    insist(typeof value.id === 'string' && !evidence.has(value.id), 'Duplicate or invalid evidence identity');
    const selected = {
      id: value.id, pdfPage: validPage(value.pdfPage, paper.sourcePages),
      section: typeof value.section === 'string' ? value.section : null,
      equation: typeof value.equation === 'string' ? value.equation : null,
      excerpt: typeof value.excerpt === 'string' ? value.excerpt : '',
      bbox: value.bbox ? validBox(value.bbox) : null,
    };
    evidence.set(value.id, selected);
  }
  const slices = [];
  const ids = new Set();
  for (const slice of reading.slices || []) {
    insist(typeof slice.id === 'string' && !ids.has(slice.id), 'Duplicate or invalid slice identity');
    ids.add(slice.id);
    const selected = [...new Set(slice.evidenceIds || [])].filter(id => evidence.has(id)).map(id => evidence.get(id));
    if (selected.length) slices.push({sliceId: slice.id, evidence: selected});
  }
  return slices;
}

function sourceSlices(projectRoot, paper) {
  if (paper.paperId === 'origin') return [];
  const catalog = read(projectRoot, 'research_tree/data/catalog.json');
  const journal = read(projectRoot, 'research_tree/data/research-journal.json');
  const entry = catalog.value.papers?.find(value => value.id === paper.paperId);
  insist(entry?.sourceSha256 === paper.sourceSha256 && entry.sourcePages === paper.sourcePages, 'Formal reading catalog identity mismatch');
  const replay = replayJournal(journal.value, catalog.value);
  const reading = replay.papers[paper.paperId];
  insist(reading, 'No formal published reading for corpus paper');
  return selectSourceSlices(reading, paper);
}

function expectedPacket(projectRoot, paperId) {
  validId(paperId);
  const scope = verifiedScope(projectRoot);
  insist(scope.papers.some(paper => paper.paperId === paperId), 'Paper is outside the authorized 199-paper scope');
  const paper = authorities(projectRoot).papers.get(paperId);
  return {
    schemaVersion: 1, paperId, identity: {title: paper.title, doi: paper.doi},
    source: originalSource(projectRoot, paper), boundaries: exclusionBoundaries(projectRoot, paper),
    slices: sourceSlices(projectRoot, paper),
    policy: {
      authority: 'The hash-matched original PDF is the only academic authority; slices are prior extraction/navigation aids and must be checked against it.',
      extraction: 'Only reviewed same-paper source_fact excerpts and locators are copied. Interpretations, slice conclusions/conditions, research-tree placement, corrections, rankings, prior algorithms, parameters and results are excluded.',
      workerContext: 'Use a fresh context containing this packet and its single original PDF only. Do not inherit prior conversation or load other project research.',
      scope: 'Reproduce this paper on its own terms. Do not infer parameters or outcomes from missing source information; record an unresolved gap.',
    },
  };
}

export function materializeInput(projectRoot, paperId) {
  const packet = expectedPacket(projectRoot, paperId);
  return {...writeOnce(projectRoot, `${BASE}/inputs/${paperId}/packet.json`, packet), packet};
}

/** Re-derive the exact whitelist from authority, not from a self-signed packet. */
export function verifyInput(projectRoot, paperId) {
  const expected = expectedPacket(projectRoot, paperId);
  const relative = `${BASE}/inputs/${paperId}/packet.json`;
  const stored = read(projectRoot, relative);
  insist(encoded(stored.value) === encoded(expected), 'Input packet differs from the current authoritative whitelist');
  insist(fs.readFileSync(safePath(projectRoot, relative), 'utf8') === encoded(expected), 'Input packet is not in its immutable canonical encoding');
  return {path: safePath(projectRoot, relative), sha256: stored.sha256, packet: stored.value, valid: true};
}

/** New Dot runs have a separate, original-only input packet. This deliberately
 * does not read the historical 199-paper selection or research-journal slices.
 * It reuses only unchanged original identities and documented exclusion bounds.
 * This prepares data on demand; it does not schedule or execute research. */
export function getDotInput(projectRoot, paperId, edition, {materialize = true} = {}) {
  validId(paperId);
  insist(edition?.provider === 'dot' && edition.paperId === paperId && /^dot-\d{8}(?:-[a-zA-Z0-9_-]+)?$/.test(edition.release ?? ''), 'Dot input requires an exact checked edition');
  const paper = authorities(projectRoot).papers.get(paperId);
  insist(paper, 'Dot paper is outside the sealed 209-paper corpus');
  const source = originalSource(projectRoot, paper);
  insist(source.sha256 === edition.source.sha256 && samePath(source.path, edition.source.path), 'Dot input source identity mismatch');
  const packet = {
    schemaVersion: 2, inputKind: 'dot_original_only', paperId, identity: {title: paper.title, doi: paper.doi},
    source, boundaries: exclusionBoundaries(projectRoot, paper), slices: [],
    reconstruction: {provider: 'dot', release: edition.release, version: edition.version, indexSha256: edition.indexSha256, recordSha256: edition.recordSha256},
    policy: {
      authority: 'The hash-matched original PDF is academic authority. The user-selected Dot TeX is its reading representation, not a scientific endorsement.',
      extraction: 'No historical reading slices, source-map interpretations, graph classifications, selection reasons, prior algorithms, parameters or results are included.',
      workerContext: 'Use a fresh context, this paper only, and the bound reading view. Original PDF and declared academic assets are available on demand.',
      scope: 'Establish assumptions and results independently from this paper. Record missing information rather than supplying prior project presets.',
    },
  };
  const relative = `${BASE}/inputs-dot/${edition.release}/${paperId}/packet.json`;
  if (materialize) writeOnce(projectRoot, relative, packet);
  const stored = read(projectRoot, relative);
  insist(encoded(stored.value) === encoded(packet) && fs.readFileSync(safePath(projectRoot, relative), 'utf8') === encoded(packet), 'Dot input packet differs from authoritative original-only input');
  return {path: safePath(projectRoot, relative), sha256: stored.sha256, packet: stored.value, valid: true};
}
