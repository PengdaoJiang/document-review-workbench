// workerCount=1. Every test owns a distinct temporary synthetic project; no
// production source, ledger, runtime, calculation, compiler or process is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateSourceBinding, resolveSourceView} from '../protocols/source-binding-v1/source-binding.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, stable(v[key])])) : v;
  return JSON.stringify(stable(value));
}
const literal = '\\lstinputlisting[basicstyle=\\ttfamily\\scriptsize,numbers=left]{algorithm1.m}';
function fixture(t, {main = 'Header\n' + literal + '\nFooter\n', content = '\uFEFFplain inert listing\r\nUnicode: \u{1F642}\tend\r\n', chooseLast = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-binding-security-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const paperId = 'r0149', release = 'dot-20261023', version = 'dot-' + 'a'.repeat(64);
  const releaseRoot = path.join(root, 'reconstructed_sources', release);
  const mainName = 'papers/r0149/source/r0149/main.tex', targetName = 'papers/r0149/source/r0149/algorithm1.m';
  const mainPath = path.join(releaseRoot, mainName), targetPath = path.join(releaseRoot, targetName);
  const recordPath = path.join(releaseRoot, 'papers/r0149/record.json'), indexPath = path.join(releaseRoot, 'index.json');
  const basePath = path.join(root, 'research_followup/network3_campaign/coverage/r0149/scan.json');
  const bindingPath = path.join(root, 'research_followup/network3_campaign/coverage/r0149/c001/source-binding.json');
  const write = (filename, bytes) => { fs.mkdirSync(path.dirname(filename), {recursive: true}); fs.writeFileSync(filename, bytes); return {path: filename, sha256: hash(bytes)}; };
  const mainRef = write(mainPath, main), targetRef = write(targetPath, content);
  const member = (name, ref) => ({path: name, sha256: ref.sha256, bytes: fs.statSync(ref.path).size});
  const record = {schemaVersion: 1, provider: 'dot', paperId, version, status: 'user_selected_dot_reconstruction',
    archive: {path: 'archives/r0149.zip', sha256: 'a'.repeat(64)}, source: {sha256: 'b'.repeat(64)},
    files: {latex: member(mainName, mainRef), all: [member(mainName, mainRef), member(targetName, targetRef)]}};
  const recordRef = write(recordPath, JSON.stringify(record));
  const index = {schemaVersion: 1, provider: 'dot', release, papers: [{paperId, version, record: 'papers/r0149/record.json', recordSha256: recordRef.sha256}]};
  const indexRef = write(indexPath, JSON.stringify(index));
  const scan = {schemaVersion: 1, paperId, inputVersion: version, reading: {schemaVersion: 2, paperId, mode: 'dot_latex',
    primary: mainRef, original: {path: path.join(root, 'never-opened-original.pdf'), sha256: 'b'.repeat(64)},
    edition: {provider: 'dot', version, release, indexSha256: indexRef.sha256, recordPath, recordSha256: recordRef.sha256}},
    resources: [{id: 'base-main', ...mainRef, type: 'text'}], units: [{id: 'base-unit', resourceId: 'base-main', start: 0, end: main.length, kind: 'text_block', excerptSha256: hash(main)}], diagnostics: []};
  const baseScan = write(basePath, canonical(scan));
  const start = chooseLast ? main.lastIndexOf('\\lstinputlisting') : main.indexOf('\\lstinputlisting');
  const end = main.indexOf('{algorithm1.m}', start) + '{algorithm1.m}'.length;
  const binding = {schemaVersion: 1, protocol: 'source-supplement-v1', paperId, baseScan,
    edition: {version, release, indexSha256: indexRef.sha256, recordSha256: recordRef.sha256}, index: indexRef, record: recordRef,
    includingResource: mainRef, include: {command: 'lstinputlisting', start, end, excerptSha256: hash(main.slice(start, end)), literalTarget: 'algorithm1.m'},
    supplement: targetRef, supplementBytes: fs.statSync(targetPath).size, kind: 'utf8_listing'};
  const reference = write(bindingPath, canonical(binding));
  const args = {root, scan, binding, reference};
  const reseal = () => {
    binding.record = write(recordPath, JSON.stringify(record));
    index.papers[0].recordSha256 = binding.record.sha256;
    binding.index = write(indexPath, JSON.stringify(index));
    for (const object of [binding.edition, scan.reading.edition]) {
      object.indexSha256 = binding.index.sha256; object.recordSha256 = binding.record.sha256;
    }
    binding.baseScan = write(basePath, canonical(scan));
    args.reference = write(bindingPath, canonical(binding));
  };
  return {args, root, main, content, mainPath, targetPath, recordPath, indexPath, basePath, bindingPath, record, index, write, reseal};
}

test('exact binding yields stable additive text/source_code view without changing base scan', t => {
  const f = fixture(t), before = canonical(f.args.scan);
  const inputs = [f.bindingPath, f.basePath, f.indexPath, f.recordPath, f.mainPath, f.targetPath].map(filename => ({filename, bytes: fs.readFileSync(filename)}));
  const a = validateSourceBinding(f.args), b = resolveSourceView({root: f.root, scan: f.args.scan, sourceBinding: f.args.reference});
  assert.equal(canonical(f.args.scan), before);
  assert.equal(a.text, f.content); assert.equal(a.resource.type, 'text'); assert.equal(a.unit.kind, 'source_code');
  assert.equal(a.unit.end, f.content.length); assert.equal(a.unit.excerptSha256, f.args.binding.supplement.sha256);
  assert.equal(a.resources.length, 2); assert.equal(a.units.length, 2); assert.equal(a.additionalResources.length, 1);
  assert.equal(a.resource.id, b.resource.id); assert.equal(a.unit.id, b.unit.id);
  assert.equal(a.sourceBindingSha256, hash(canonical(f.args.binding))); assert.equal(a.recheck(), true);
  for (const input of inputs) assert.deepEqual(fs.readFileSync(input.filename), input.bytes, 'Historical/frozen input bytes unchanged');
  assert.equal(fs.existsSync(f.args.scan.reading.original.path), false, 'No PDF or compiler input needed by pure binding validator');
});

test('validator and resolver never invoke filesystem mutation APIs', t => {
  const f = fixture(t), names = ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync'];
  const original = Object.fromEntries(names.map(name => [name, fs[name]]));
  for (const name of names) fs[name] = () => { throw Error('Forbidden mutation: ' + name); };
  try {
    validateSourceBinding(f.args).recheck();
    resolveSourceView({root: f.root, scan: f.args.scan, sourceBinding: f.args.reference}).recheck();
  } finally { for (const name of names) fs[name] = original[name]; }
});

test('supports normal unrelated definitions, escaped comments and precise UTF-16 offsets', t => {
  const prefix = '\uFEFF\u{1F642}\r\n\\def\\header{\\let\\@oddhead\\@empty}\n\\newcommand{\\eq}[1]{Eq.~#1}\n\\renewcommand\\figurename{Figure}\n\\% literal percent\n';
  const f = fixture(t, {main: prefix + literal});
  assert.equal(validateSourceBinding(f.args).unit.end, f.content.length);
});

test('comment, verbatim, definitions and non-top-level lookalikes never grant', async t => {
  const cases = [
    '% ' + literal + '\n', '\\verb|' + literal + '|', '\\verb*|' + literal + '|', '\\lstinline|' + literal + '|',
    '\\begin{verbatim}\n' + literal + '\n\\end{verbatim}', '\\begin{lstlisting}\n' + literal + '\n\\end{lstlisting}',
    '\\begin{minted}{text}\n' + literal + '\n\\end{minted}', '\\begin{comment}\n' + literal + '\n\\end{comment}',
    '\\newcommand{\\fake}{' + literal + '}', '\\def\\fake#1{' + literal + '}', '{' + literal + '}', '$' + literal + '$',
  ];
  for (const [i, main] of cases.entries()) await t.test(String(i), t => {
    const f = fixture(t, {main}); assert.throws(() => validateSourceBinding(f.args), /top-level|context|definition/);
  });
});

test('unsupported conditional, catcode, aliases, rewrites and redefinitions fail closed', async t => {
  const prefixes = ['\\iffalse\n', '\\ifdefined\\fake\n', '\\catcode`\\%=12\n', '\\csname fake\\endcsname\n',
    '\\let\\fake\\other\n', '^^5c', '\\renewcommand{\\lstinputlisting}[1]{}\n', '\\def\\begin#1{}\n',
    '\\newenvironment{fake}{}{}\n', '\\newcommand{\\fake}{\\catcode`\\%=12}\n'];
  for (const [i, prefix] of prefixes.entries()) await t.test(String(i), t => {
    const f = fixture(t, {main: prefix + literal}); assert.throws(() => validateSourceBinding(f.args), /context|unsupported|Unsupported|redefines|rewriting/);
  });
});

test('commented lookalike before real include does not shift explicit locator', t => {
  const f = fixture(t, {main: '% ' + literal + '\n' + literal, chooseLast: true}); assert.equal(validateSourceBinding(f.args).resource.type, 'text');
});

test('macro filename, malformed options, unknown fields and forged locator rejected', async t => {
  const edits = [
    f => { f.args.binding.include.start++; }, f => { f.args.binding.include.end--; },
    f => { f.args.binding.include.excerptSha256 = '0'.repeat(64); },
    f => { f.args.binding.include.literalTarget = '\\target'; },
    f => { f.args.binding.supplementBytes++; }, f => { f.args.binding.extra = true; },
    f => { f.args.binding.include.command = 'input'; }, f => { f.args.binding.kind = 'executable'; },
  ];
  for (const [i, edit] of edits.entries()) await t.test(String(i), t => {
    const f = fixture(t); edit(f); f.args.reference = null; assert.throws(() => validateSourceBinding(f.args));
  });
  for (const main of ['\\lstinputlisting[basicstyle={x]{algorithm1.m}', '\\lstinputlisting[\\input{evil}]{algorithm1.m}', '\\lstinputlisting[caption=%x\n]{algorithm1.m}']) {
    await t.test(main, t => { const f = fixture(t, {main}); assert.throws(() => validateSourceBinding(f.args)); });
  }
});

test('package membership and source/index/edition binding are mandatory', async t => {
  const edits = [
    f => { f.record.files.all.pop(); },
    f => { f.record.files.all[1].sha256 = '0'.repeat(64); },
    f => { f.record.files.all.push({...f.record.files.all[1], path: f.record.files.all[1].path.toUpperCase()}); },
    f => { f.record.source.sha256 = '0'.repeat(64); },
    f => { f.record.paperId = 'r0148'; },
    f => { f.index.papers[0].version = 'dot-' + 'c'.repeat(64); },
    f => { f.index.papers.push({...f.index.papers[0]}); },
    f => { f.record.files.latex = f.record.files.all[1]; },
    f => { f.args.scan.resources.push({id: 'already', ...f.args.binding.supplement, type: 'text'}); },
  ];
  for (const [i, edit] of edits.entries()) await t.test(String(i), t => {
    const f = fixture(t); edit(f); f.reseal(); assert.throws(() => validateSourceBinding(f.args));
  });
});

test('paths cannot escape via traversal, streams, device names, siblings or private evidence', async t => {
  const paths = ['../algorithm1.m', './algorithm1.m', 'algorithm1.m:secret', 'C:algorithm1.m', '\\\\?\\C:\\secret',
    'algorithm1.m.', 'algorithm1.m ', 'NUL.m', 'algorithm1.m\0', 'research_followup/reproduction_clean/coverage_verifications/r0149/c001/secret.m',
    'reconstructed_sources/dot-20261024/papers/r0149/source/r0149/algorithm1.m', 'reconstructed_sources/dot-20261023/papers/r0148/source/r0148/algorithm1.m'];
  for (const filename of paths) await t.test(filename.replaceAll('\0', '<NUL>'), t => {
    const f = fixture(t); f.args.binding.supplement.path = filename; f.args.reference = null; assert.throws(() => validateSourceBinding(f.args));
  });
});

test('invalid UTF-8 is rejected even with matching sealed raw hash/size', t => {
  const f = fixture(t, {content: Buffer.from([0xc3, 0x28])}); assert.throws(() => validateSourceBinding(f.args), /UTF-8/);
});

test('source-review metadata and nested refs cannot enroll an unsealed target', t => {
  const f = fixture(t); f.record.files.all.pop(); f.record.packageSupplement = {...f.args.binding.supplement}; f.reseal();
  assert.throws(() => validateSourceBinding(f.args), /sealed package member/);
});

test('base scan and binding files must remain exact canonical immutable JSON', async t => {
  for (const field of ['basePath', 'bindingPath']) await t.test(field, t => {
    const f = fixture(t); fs.appendFileSync(f[field], '\n');
    const ref = field === 'basePath' ? f.args.binding.baseScan : f.args.reference;
    ref.sha256 = hash(fs.readFileSync(f[field]));
    if (field === 'basePath') f.args.reference = null;
    assert.throws(() => validateSourceBinding(f.args), /canonical/);
  });
  await t.test('pretty binding is not a frozen canonical declaration', t => {
    const f = fixture(t); f.args.reference = f.write(f.bindingPath, JSON.stringify(f.args.binding, null, 2));
    assert.throws(() => validateSourceBinding(f.args), /canonical/);
  });
});

test('same-byte copies cannot substitute sibling index, record, main or target refs', async t => {
  for (const field of ['index', 'record', 'includingResource', 'supplement']) await t.test(field, t => {
    const f = fixture(t), original = f.args.binding[field], copy = path.join(f.root, 'unbound-copy', path.basename(original.path));
    f.args.binding[field] = f.write(copy, fs.readFileSync(original.path)); f.args.reference = null;
    assert.throws(() => validateSourceBinding(f.args), /differs/);
  });
});

test('recheck covers binding, base scan, index, record, including source and target', async t => {
  for (const field of ['bindingPath', 'basePath', 'indexPath', 'recordPath', 'mainPath', 'targetPath']) await t.test(field, t => {
    const f = fixture(t), view = validateSourceBinding(f.args); fs.appendFileSync(f[field], 'mutation');
    assert.throws(() => view.recheck(), /hash mismatch/);
  });
});

test('post-content-read recheck rejects an earlier source changed during target read', t => {
  const f = fixture(t), original = fs.readFileSync;
  fs.readFileSync = function(filename, ...args) {
    const bytes = original.call(fs, filename, ...args);
    if (String(filename) === f.targetPath) fs.appendFileSync(f.mainPath, 'mutation');
    return bytes;
  };
  try { assert.throws(() => validateSourceBinding(f.args), /hash mismatch/); }
  finally { fs.readFileSync = original; }
});

test('redirected parent and target are rejected without following a new grant', async t => {
  await t.test('junction parent', t => {
    const f = fixture(t), sourceDir = path.dirname(f.mainPath), elsewhere = path.join(f.root, 'elsewhere');
    fs.renameSync(sourceDir, elsewhere);
    fs.symlinkSync(elsewhere, sourceDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => validateSourceBinding(f.args), /Redirected/);
  });
  await t.test('file symlink', t => {
    const f = fixture(t), elsewhere = path.join(f.root, 'listing-copy'); fs.renameSync(f.targetPath, elsewhere);
    try { fs.symlinkSync(elsewhere, f.targetPath, 'file'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('OS denies file symlinks; junction protection independently tested'); return; } throw error; }
    assert.throws(() => validateSourceBinding(f.args), /Redirected/);
  });
});
