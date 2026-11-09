import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTex } from '../coverage-scan.mjs';

const fragments = (text, ranges) => ranges.map(({ start, end }) => text.slice(start, end));

function assertCoverage(text, result) {
  const hits = new Uint8Array(text.length);
  for (const [index, block] of result.blocks.entries()) {
    assert.equal(block.kind, 'text_block');
    assert.ok(block.start >= 0 && block.end <= text.length && block.end > block.start);
    assert.ok(block.end - block.start <= 2000);
    if (index) assert.ok(result.blocks[index - 1].end <= block.start);
    assert.match(text.slice(block.start, block.end), /\S/u);
    for (let i = block.start; i < block.end; i++) hits[i]++;
  }
  for (let i = 0; i < text.length; i++) {
    if (/\S/u.test(text[i])) assert.equal(hits[i], 1, `Coverage at UTF-16 index ${i}`);
  }
  for (const [index, span] of result.math.entries()) {
    assert.ok(span.start >= 0 && span.end <= text.length && span.end > span.start);
    if (index) assert.ok(result.math[index - 1].end <= span.start);
  }
  assert.deepEqual(result, scanTex(text), 'Output is stable across calls');
}

test('inline/display delimiters preserve exact source slices and UTF-16 offsets', () => {
  const text = '😀 prefix $a+b$ and $$c=d\n=e$$ then \\(f\\) and \\[g\\].';
  const result = scanTex(text);
  assert.deepEqual(fragments(text, result.math), ['$a+b$', '$$c=d\n=e$$', '\\(f\\)', '\\[g\\]']);
  assert.deepEqual(result.math.map(span => span.kind), ['inline_math', 'display_math', 'inline_math', 'display_math']);
  assert.equal(result.math[0].start, text.indexOf('$a+b$'));
  assert.deepEqual(result.diagnostics, []);
  assertCoverage(text, result);
});

test('escaped control symbols do not open comments or math; paired backslashes do not escape dollars', () => {
  const text = String.raw`cost \$5, literal \% then $a\$b$; slash \\$c$`;
  const result = scanTex(text);
  assert.deepEqual(fragments(text, result.math), [String.raw`$a\$b$`, '$c$']);
  assert.deepEqual(result.diagnostics, []);
  assertCoverage(text, result);
});

test('comments hide math openers and closers without changing original offsets', () => {
  const text = '% $ignored$ \\[ignored\\]\r\n$x % $not a close\r\n+y$\r\n% \\begin{equation}\n$z$';
  const result = scanTex(text);
  assert.deepEqual(fragments(text, result.math), ['$x % $not a close\r\n+y$', '$z$']);
  assert.deepEqual(result.diagnostics, []);
  assertCoverage(text, result);
});

test('all common math environments and starred variants are recognized', () => {
  const names = ['equation', 'align', 'alignat', 'gather', 'multline', 'flalign', 'eqnarray', 'displaymath', 'math'];
  const expected = names.flatMap(name => [name, `${name}*`]).map(name => `\\begin{${name}}a=b\\end{${name}}`);
  const text = expected.join('\n');
  const result = scanTex(text);
  assert.deepEqual(fragments(text, result.math), expected);
  assert.ok(result.math.every(span => span.kind === 'math_environment'));
  assert.deepEqual(result.diagnostics, []);
  assertCoverage(text, result);
});

test('nested environments and nested delimiters are one continuous outer candidate', () => {
  const text = String.raw`\begin{figure}
\begin{equation}\begin{aligned}a&=b\\c&=\text{$x$}\end{aligned}\begin{equation}d=e\end{equation}\end{equation}
\end{figure}
\[\begin{gathered}x=y\\z=w\end{gathered}\]
\begin{align}x&=1\\y&=2\end{align}`;
  const result = scanTex(text);
  assert.equal(result.math.length, 3);
  assert.equal(fragments(text, result.math)[0], text.split('\n')[1]);
  assert.equal(fragments(text, result.math)[1], text.split('\n')[3]);
  assert.equal(fragments(text, result.math)[2], text.split('\n')[4]);
  assert.deepEqual(result.diagnostics, []);
  assertCoverage(text, result);
});

test('comments between begin/end commands and their literal argument are accepted', () => {
  const text = '\\begin% comment\r\n{equation}a=b\\end % end comment\n{equation}';
  const result = scanTex(text);
  assert.deepEqual(fragments(text, result.math), [text]);
  assert.deepEqual(result.diagnostics, []);
  assertCoverage(text, result);
});

test('math nested inside text groups does not prematurely close its outer delimiter', () => {
  const expected = [String.raw`$a+\text{$b$ and \$5}$`, String.raw`\(a+\text{\(b\)}\)`, String.raw`$$a+\text{$b$}$$`];
  const text = expected.join('\n');
  const result = scanTex(text);
  assert.deepEqual(fragments(text, result.math), expected);
  assert.deepEqual(result.diagnostics, []);
  assertCoverage(text, result);
});

test('literal verb commands and common code environments suppress math-looking code', () => {
  const literal = String.raw`\verb|$x$ % \(bad\)| \verb*+$$bad$$+ \Verb!\[bad\]!`;
  const names = ['verbatim', 'verbatim*', 'Verbatim', 'BVerbatim', 'LVerbatim', 'SaveVerbatim', 'lstlisting', 'minted', 'comment', 'filecontents*'];
  const code = names.map(name => `\\begin{${name}}\n$x$ % \\begin{equation} \\[x\\]\n\\end{${name}}`).join('\n');
  const text = `${literal}\n${code}\n$real$`;
  const result = scanTex(text);
  assert.deepEqual(fragments(text, result.math), ['$real$']);
  assert.deepEqual(result.diagnostics, []);
  assertCoverage(text, result);
});

test('unterminated math is retained as an EOF candidate with an explicit diagnostic', () => {
  for (const opener of ['$', '$$', '\\(', '\\[', '\\begin{equation}', '\\begin{align*}']) {
    const text = `prefix ${opener}unfinished`;
    const result = scanTex(text);
    assert.deepEqual(fragments(text, result.math), [`${opener}unfinished`]);
    assert.deepEqual(result.diagnostics.map(({ code, offset }) => ({ code, offset })), [{ code: 'UNTERMINATED_MATH', offset: 7 }]);
    assertCoverage(text, result);
  }
});

test('unclosed nested environments produce diagnostics without losing the outer span', () => {
  const text = String.raw`\begin{equation}\begin{aligned}x=y\end{equation} $z$`;
  const result = scanTex(text);
  assert.equal(result.math.length, 2);
  assert.equal(result.diagnostics[0].code, 'UNTERMINATED_ENVIRONMENT');
  assert.equal(result.diagnostics[0].offset, text.indexOf('\\begin{aligned}'));
  assertCoverage(text, result);
  const eof = scanTex(String.raw`\[\begin{aligned}x=y`);
  assert.deepEqual(eof.diagnostics.map(item => item.code), ['UNTERMINATED_MATH', 'UNTERMINATED_ENVIRONMENT']);
});

test('unclosed literal regions are diagnosed and do not emit fake math', () => {
  const codeText = String.raw`\begin{minted}{js} $not-math$`;
  const codeResult = scanTex(codeText);
  assert.equal(codeResult.math.length, 0);
  assert.equal(codeResult.diagnostics[0].code, 'UNTERMINATED_CODE_ENVIRONMENT');
  assertCoverage(codeText, codeResult);
  const verbText = '\\verb|$not-math$\n$real$';
  const verbResult = scanTex(verbText);
  assert.deepEqual(fragments(verbText, verbResult.math), ['$real$']);
  assert.equal(verbResult.diagnostics[0].code, 'UNTERMINATED_VERB');
  assertCoverage(verbText, verbResult);
  assert.equal(scanTex('\\verb').diagnostics[0].code, 'INVALID_VERB_DELIMITER');
});

test('unmatched math endings are explicit diagnostics', () => {
  const text = String.raw`\) \] \end{equation} $ok$`;
  const result = scanTex(text);
  assert.deepEqual(fragments(text, result.math), ['$ok$']);
  assert.deepEqual(result.diagnostics.map(item => item.code), Array(3).fill('UNMATCHED_MATH_END'));
  assertCoverage(text, result);
});

test('text blocks retain preamble, macros, captions, code and source comments', () => {
  const text = '\\newcommand{\\dummy}{$x$}\r\n% source comment\r\n\r\n  Caption $a$\r\n  \\includegraphics{figure.png}\r\n \t\r\n\\begin{verbatim}$code$\\end{verbatim}\n';
  const result = scanTex(text);
  assert.equal(result.blocks.length, 3);
  assert.equal(fragments(text, result.blocks)[0], '\\newcommand{\\dummy}{$x$}\r\n% source comment\r\n');
  assertCoverage(text, result);
});

test('long source without blank lines is bounded by lines or hard slices, not dropped', () => {
  for (const text of ['x'.repeat(10001), ('x'.repeat(997) + '\r\n').repeat(11), 'a'.repeat(1999) + '😀'.repeat(2500), ' '.repeat(6000) + 'x']) {
    const result = scanTex(text);
    assertCoverage(text, result);
    for (const block of result.blocks) {
      const chunk = text.slice(block.start, block.end);
      assert.equal(chunk.isWellFormed(), true, 'Hard splits preserve surrogate pairs');
    }
  }
});

test('empty and whitespace-only input has no candidates; non-strings fail closed', () => {
  for (const text of ['', ' \t\r\n\n']) assert.deepEqual(scanTex(text), { math: [], blocks: [], diagnostics: [] });
  for (const value of [null, undefined, 42, {}, ['tex']]) assert.throws(() => scanTex(value), TypeError);
});

test('adjacent inline candidates remain distinct and multiline relations stay together', () => {
  const text = '$a$$b$\n$$a=b\n=c\n=d$$';
  const result = scanTex(text);
  assert.deepEqual(fragments(text, result.math), ['$a$', '$b$', '$$a=b\n=c\n=d$$']);
  assert.deepEqual(result.diagnostics, []);
  assertCoverage(text, result);
});
