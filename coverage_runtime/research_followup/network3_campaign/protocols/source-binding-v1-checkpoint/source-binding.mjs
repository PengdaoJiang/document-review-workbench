// Read-only, explicitly declared package supplement. Never executes TeX/code,
// recursively follows dependencies, selects a newer edition, or rewrites a scan.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const SHA = /^[a-f0-9]{64}$/;
const ID = /^(?:origin|r\d{4})$/;
const RELEASE = /^dot-\d{8}(?:-[A-Za-z0-9_-]+)?$/;
const MAX_BYTES = 64 * 1024 * 1024;
const fail = message => { throw Error('Source binding: ' + message); };
const insist = (ok, message) => { if (!ok) fail(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function canonical(value) {
  function stable(v) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') { insist(Number.isFinite(v), 'Non-finite JSON number'); return v; }
    if (Array.isArray(v)) return v.map(stable);
    insist(plain(v), 'Expected JSON value');
    return Object.fromEntries(Object.keys(v).sort().map(key => [key, stable(v[key])]));
  }
  return JSON.stringify(stable(value));
}
function shape(value, keys, label) {
  insist(plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'Invalid ' + label + ' fields');
}
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a, b) => key(path.resolve(a)) === key(path.resolve(b));
function relative(value) {
  insist(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !/[:\\\x00-\x1f\x7f]/.test(value), 'Invalid package-relative path');
  const parts = value.split('/');
  insist(parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Unsafe package path segment');
  return value;
}
function safeFile(root, filename) {
  insist(typeof filename === 'string' && filename.length > 0 && !/[\x00-\x1f\x7f]/.test(filename), 'Invalid file path');
  insist(!/^(?:\\\\|\/\/)/.test(filename), 'UNC/device paths are forbidden');
  const pieces = filename.replaceAll('\\', '/').replace(/^[A-Za-z]:\//, '').split('/');
  insist(pieces.every(part => part !== '.' && part !== '..' && !part.includes(':') && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Traversal/stream/device path is forbidden');
  const target = path.resolve(root, filename), rel = path.relative(root, target);
  insist(rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel), 'File escapes project root');
  for (let current = target;;) {
    insist(!fs.lstatSync(current).isSymbolicLink(), 'Redirected path is forbidden');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  insist(fs.statSync(target).isFile() && samePath(fs.realpathSync(target), target), 'Not an unredirected regular file');
  return target;
}
function tracker(root) {
  const refs = new Map();
  function read(ref, limit = MAX_BYTES) {
    shape(ref, ['path', 'sha256'], 'reference'); insist(SHA.test(ref.sha256), 'Invalid reference hash');
    const filename = safeFile(root, ref.path), prior = refs.get(key(filename));
    insist(!prior || prior.sha256 === ref.sha256, 'Conflicting hashes for one path');
    insist(fs.statSync(filename).size <= limit, 'Bound input exceeds byte limit');
    const bytes = fs.readFileSync(filename);
    insist(bytes.length <= limit && hash(bytes) === ref.sha256, 'Bound input hash mismatch');
    // Validate paths again after the content read, not just before it.
    insist(samePath(safeFile(root, ref.path), filename), 'Input redirected during read');
    refs.set(key(filename), {path: filename, sha256: ref.sha256});
    return {path: filename, bytes};
  }
  function utf8(ref, limit) {
    const found = read(ref, limit), text = found.bytes.toString('utf8');
    insist(Buffer.from(text, 'utf8').equals(found.bytes), 'Input is not valid UTF-8');
    return {...found, text};
  }
  function json(ref, requireCanonical = false) {
    const found = utf8(ref), value = JSON.parse(found.text);
    if (requireCanonical) insist(found.text === canonical(value), 'Frozen JSON must be canonical without a trailing newline');
    return {...found, value};
  }
  function recheck() {
    for (const ref of [...refs.values()]) read(ref);
    return true;
  }
  return {read, utf8, json, recheck};
}
function sameRef(root, a, b, label) {
  shape(a, ['path', 'sha256'], label); shape(b, ['path', 'sha256'], label);
  insist(samePath(path.resolve(root, a.path), path.resolve(root, b.path)) && a.sha256 === b.sha256, label + ' differs');
}
function whitespace(text, at) { while (/\s/.test(text[at] ?? '') && at < text.length) at++; return at; }
function commandAt(text, at) {
  insist(text[at] === '\\', 'Expected command');
  const match = text.slice(at + 1).match(/^[A-Za-z@]+/);
  return {name: match ? match[0] : (text[at + 1] ?? ''), end: at + 1 + (match?.[0].length ?? 1)};
}
function groupEnd(text, at, open = '{', close = '}') {
  insist(text[at] === open, 'Expected balanced group');
  let depth = 1;
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\') { i = commandAt(text, i).end - 1; continue; }
    if (text[i] === '%') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (open === '[' && text[i] === '{') { i = groupEnd(text, i) - 1; continue; }
    if (open === '[' && text[i] === '}') fail('Unbalanced options grouping');
    if (text[i] === open) depth++;
    if (text[i] === close) { depth--; if (depth === 0) return i + 1; }
  }
  fail('Unbalanced group');
}
const forbidden = /^(?:if[A-Za-z@]*|else|fi|catcode|csname|endcsname|expandafter|noexpand|edef|xdef|futurelet|scantokens|obeylines|obeyspaces|newenvironment|renewenvironment|endinput|stop)$/;
const reservedCommands = new Set(['lstinputlisting', 'begin', 'end', 'verb', 'lstinline', 'catcode', 'def', 'gdef', 'let', 'newcommand', 'renewcommand', 'providecommand']);
function definitionEnd(text, start, command) {
  let at = whitespace(text, command.end);
  if (text[at] === '*') at = whitespace(text, at + 1);
  let target, next;
  if (text[at] === '{') {
    next = groupEnd(text, at); const inner = text.slice(at + 1, next - 1).trim();
    insist(/^\\[A-Za-z@]+$/.test(inner), 'Ambiguous definition target'); target = inner.slice(1);
  } else { const parsed = commandAt(text, at); target = parsed.name; next = parsed.end; }
  insist(!reservedCommands.has(target) && !forbidden.test(target), 'Source redefines a structural/listing command');
  at = whitespace(text, next);
  if (['def', 'gdef'].includes(command.name)) {
    while (at < text.length && text[at] !== '{') {
      insist(!/[\\%]/.test(text[at]), 'Unsupported definition parameters'); at++;
    }
  } else {
    for (let n = 0; n < 2 && text[at] === '['; n++) at = whitespace(text, groupEnd(text, at, '[', ']'));
  }
  const end = groupEnd(text, at);
  // Definitions are opaque, never expanded. Structural lexer-changing commands
  // in them are not safe to infer as inert if the macro is invoked later.
  insist(!/\\(?:catcode|csname|endcsname|scantokens|newenvironment|renewenvironment)\b/.test(text.slice(at, end)), 'Unsupported lexical macro definition');
  return end;
}
function literalInclude(text, include) {
  let at = 0, depth = 0, math = false;
  const opaque = new Set(['verbatim', 'verbatim*', 'Verbatim', 'BVerbatim', 'LVerbatim', 'lstlisting', 'minted', 'comment', 'filecontents', 'filecontents*']);
  while (at < include.start) {
    const ch = text[at];
    if (ch === '%') { const end = text.indexOf('\n', at); at = end < 0 ? text.length : end + 1; continue; }
    if (ch === '$') { math = !math; at += text[at + 1] === '$' ? 2 : 1; continue; }
    if (ch === '{') { depth++; at++; continue; }
    if (ch === '}') { insist(depth > 0, 'Unbalanced source grouping'); depth--; at++; continue; }
    if (ch !== '\\') { insist(text.slice(at, at + 2) !== '^^', 'TeX character rewriting is unsupported'); at++; continue; }
    const command = commandAt(text, at);
    insist(!forbidden.test(command.name), 'Unsupported conditional/expansion/catcode context');
    if (['def', 'gdef', 'newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand'].includes(command.name)) {
      at = definitionEnd(text, at, command); continue;
    }
    if (command.name === 'let') fail('Unsupported top-level alias assignment');
    if (command.name === 'verb' || command.name === 'lstinline') {
      let next = command.end;
      if (text[next] === '*') next++;
      if (command.name === 'lstinline' && text[next] === '[') next = groupEnd(text, next, '[', ']');
      const delimiter = text[next]; insist(delimiter && !/[\sA-Za-z]/.test(delimiter), 'Unsupported inline verbatim delimiter');
      const end = text.indexOf(delimiter, next + 1); insist(end >= 0, 'Unclosed inline verbatim'); at = end + 1; continue;
    }
    if (command.name === 'begin' || command.name === 'end') {
      const arg = whitespace(text, command.end), end = groupEnd(text, arg), env = text.slice(arg + 1, end - 1);
      insist(/^[A-Za-z*]+$/.test(env), 'Ambiguous environment name');
      insist(!(command.name === 'end' && env === 'document'), 'Include occurs after end of document');
      if (command.name === 'begin' && opaque.has(env)) {
        const marker = '\\end{' + env + '}', close = text.indexOf(marker, end);
        insist(close >= 0, 'Unclosed verbatim/comment environment'); at = close + marker.length; continue;
      }
      at = end; continue;
    }
    if (command.name === '(' || command.name === '[') math = true;
    if (command.name === ')' || command.name === ']') math = false;
    at = command.end;
  }
  insist(at === include.start && depth === 0 && !math, 'Include is not a direct top-level literal command');
  const command = commandAt(text, at);
  insist(command.name === 'lstinputlisting' && include.command === command.name, 'Expected exact lstinputlisting command');
  at = whitespace(text, command.end);
  if (text[at] === '[') {
    at = groupEnd(text, at, '[', ']');
    // Options are inert data; reject lexical tricks and nested input commands.
    const options = text.slice(command.end, at);
    insist(!/%|\^\^|\\(?:lstinputlisting|input|include|catcode|csname|endcsname)\b/.test(options), 'Unsupported listing options');
    at = whitespace(text, at);
  }
  const end = groupEnd(text, at), literal = text.slice(at + 1, end - 1);
  insist(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(literal), 'Listing filename must be one literal sibling filename');
  relative(literal);
  insist(end === include.end && literal === include.literalTarget, 'Literal include locator/target mismatch');
  insist(hash(text.slice(include.start, include.end)) === include.excerptSha256, 'Include excerpt hash mismatch');
  return literal;
}

/** Mechanical source identity only; upstream validators must independently
 * rebuild/validate the base scan and retain all scientific acceptance gates. */
export function validateSourceBinding({root, scan, binding, reference = null}) {
  insist(typeof root === 'string' && path.isAbsolute(root), 'Expected absolute project root'); root = path.resolve(root);
  shape(binding, ['schemaVersion', 'protocol', 'paperId', 'baseScan', 'edition', 'index', 'record', 'includingResource', 'include', 'supplement', 'supplementBytes', 'kind'], 'source binding');
  insist(binding.schemaVersion === 1 && binding.protocol === 'source-supplement-v1' && ID.test(binding.paperId)
    && binding.kind === 'utf8_listing', 'Invalid source binding identity/kind');
  // Capture independent immutable JSON data before constructing the recheck closure.
  const bindingBytes = canonical(binding), value = JSON.parse(bindingBytes), tracked = tracker(root);
  if (reference) {
    const frozen = tracked.json(reference, true);
    insist(frozen.text === bindingBytes, 'Binding file differs from supplied binding');
  }
  const base = tracked.json(value.baseScan, true);
  insist(base.text === canonical(scan) && scan.schemaVersion === 1 && scan.paperId === value.paperId, 'Base scan canonical identity mismatch');
  insist(Array.isArray(scan.resources) && Array.isArray(scan.units) && Array.isArray(scan.diagnostics), 'Invalid base scan collections');
  const reading = scan.reading;
  insist(reading?.paperId === value.paperId && reading.mode === 'dot_latex' && reading.edition?.provider === 'dot', 'Expected same-paper frozen Dot reading');
  shape(value.edition, ['version', 'release', 'indexSha256', 'recordSha256'], 'edition');
  insist(/^dot-[a-f0-9]{64}$/.test(value.edition.version) && RELEASE.test(value.edition.release)
    && SHA.test(value.edition.indexSha256) && SHA.test(value.edition.recordSha256), 'Invalid edition identity');
  for (const field of Object.keys(value.edition)) insist(reading.edition[field] === value.edition[field], 'Edition differs from frozen reading');
  const releaseRoot = path.join(root, 'reconstructed_sources', value.edition.release);
  const indexPath = path.join(releaseRoot, 'index.json'), recordName = `papers/${value.paperId}/record.json`, recordPath = path.join(releaseRoot, recordName);
  sameRef(root, value.index, {path: indexPath, sha256: value.edition.indexSha256}, 'Index');
  sameRef(root, value.record, {path: recordPath, sha256: value.edition.recordSha256}, 'Record');
  sameRef(root, value.record, {path: reading.edition.recordPath, sha256: reading.edition.recordSha256}, 'Frozen record');
  const index = tracked.json(value.index).value, record = tracked.json(value.record).value;
  insist(index.schemaVersion === 1 && index.provider === 'dot' && index.release === value.edition.release && Array.isArray(index.papers), 'Invalid Dot index');
  const matches = index.papers.filter(entry => entry.paperId === value.paperId);
  insist(matches.length === 1 && matches[0].version === value.edition.version && matches[0].record === recordName
    && matches[0].recordSha256 === value.record.sha256, 'Index does not bind this exact paper record');
  insist(record.schemaVersion === 1 && record.provider === 'dot' && record.paperId === value.paperId && record.version === value.edition.version
    && record.status === 'user_selected_dot_reconstruction', 'Invalid Dot record identity/status');
  insist(record.archive?.sha256 && record.version === 'dot-' + record.archive.sha256 && record.source?.sha256 === reading.original?.sha256, 'Record source/archive identity mismatch');
  insist(Array.isArray(record.files?.all) && record.files.all.length, 'Missing package member manifest');
  const members = new Map();
  for (const member of record.files.all) {
    const name = relative(member.path);
    insist(name.startsWith(`papers/${value.paperId}/source/`) && SHA.test(member.sha256) && Number.isSafeInteger(member.bytes) && member.bytes >= 0, 'Invalid same-paper source member');
    insist(!members.has(name.toLowerCase()), 'Case-colliding package members'); members.set(name.toLowerCase(), member);
  }
  const memberFor = (ref, label) => {
    const filename = safeFile(root, ref.path), name = path.relative(releaseRoot, filename).replaceAll('\\', '/');
    relative(name); const member = members.get(name.toLowerCase());
    insist(member && member.path === name && member.sha256 === ref.sha256, label + ' is not the exact sealed package member');
    return member;
  };
  sameRef(root, value.includingResource, reading.primary, 'Including primary');
  const mainMember = memberFor(value.includingResource, 'Including source');
  insist(record.files.latex?.path === mainMember.path && record.files.latex.sha256 === mainMember.sha256 && /\.tex$/.test(mainMember.path), 'Including source differs from declared primary TeX');
  insist(scan.resources.some(resource => resource.type === 'text' && samePath(path.resolve(root, resource.path), path.resolve(root, value.includingResource.path))
    && resource.sha256 === value.includingResource.sha256), 'Including source absent from base scan');
  shape(value.include, ['command', 'start', 'end', 'excerptSha256', 'literalTarget'], 'include');
  const source = tracked.utf8(value.includingResource);
  insist(source.bytes.length === mainMember.bytes && Number.isSafeInteger(value.include.start) && Number.isSafeInteger(value.include.end)
    && value.include.start >= 0 && value.include.end > value.include.start && value.include.end <= source.text.length && SHA.test(value.include.excerptSha256), 'Invalid include locator/source size');
  const target = literalInclude(source.text, value.include);
  sameRef(root, value.supplement, {path: path.join(path.dirname(source.path), target), sha256: value.supplement.sha256}, 'Literal target');
  const member = memberFor(value.supplement, 'Supplement');
  insist(!scan.resources.some(resource => samePath(path.resolve(root, resource.path), path.resolve(root, value.supplement.path))), 'Supplement already exists in base scan');
  insist(Number.isSafeInteger(value.supplementBytes) && value.supplementBytes > 0 && value.supplementBytes === member.bytes, 'Supplement size binding mismatch');
  const content = tracked.utf8(value.supplement);
  insist(content.bytes.length === value.supplementBytes, 'Supplement raw byte length mismatch');
  const resource = {id: 'res-' + hash(canonical({path: content.path, sha256: value.supplement.sha256})), path: content.path, sha256: value.supplement.sha256, type: 'text'};
  const body = {resourceId: resource.id, start: 0, end: content.text.length, kind: 'source_code', excerptSha256: value.supplement.sha256};
  const unit = {id: 'unit-' + hash(canonical({sha256: resource.sha256, ...body})), ...body};
  insist(!scan.resources.some(item => item.id === resource.id) && !scan.units.some(item => item.id === unit.id), 'Supplement ID collision');
  tracked.recheck();
  return {sourceBinding: reference ? {...reference} : null, sourceBindingSha256: hash(bindingBytes), binding: value, baseScan: {...value.baseScan},
    resource, unit, text: content.text, resources: [...scan.resources, resource], units: [...scan.units, unit], diagnostics: [...scan.diagnostics],
    additionalResources: [resource], additionalUnits: [unit], recheck: tracked.recheck};
}

/** Resolve only an exact frozen reference, never an unbound latest pointer. */
export function resolveSourceView({root, scan, sourceBinding}) {
  const loaded = tracker(path.resolve(root)).json(sourceBinding, true);
  return validateSourceBinding({root, scan, binding: loaded.value, reference: sourceBinding});
}
