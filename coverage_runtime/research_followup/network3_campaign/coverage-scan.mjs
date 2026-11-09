/**
 * Lexical review candidates, not a TeX interpreter or a semantic inventory.
 * No macro expansion, compilation, file access, or academic classification.
 * All offsets are UTF-16 indices into the unchanged input; end is exclusive.
 * Text blocks intentionally include math, comments, macros, and code as well.
 */

const MATH_ENVIRONMENTS = new Set([
  'equation', 'align', 'alignat', 'gather', 'multline', 'flalign',
  'eqnarray', 'displaymath', 'math',
].flatMap(name => [name, `${name}*`]));

const CODE_ENVIRONMENTS = new Set([
  'verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'BVerbatim',
  'LVerbatim', 'SaveVerbatim', 'lstlisting', 'lstlisting*',
  'minted', 'minted*', 'comment', 'filecontents', 'filecontents*',
]);

const BLOCK_LIMIT = 2000;
const isLetter = char => char !== undefined && /[A-Za-z@]/.test(char);

function endOfLine(text, start) {
  let end = start;
  while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end++;
  return end;
}

function afterLineBreak(text, end) {
  if (text[end] === '\r' && text[end + 1] === '\n') return end + 2;
  return end < text.length ? end + 1 : end;
}

function skipWhitespaceAndComments(text, start) {
  let at = start;
  while (at < text.length) {
    if (/\s/.test(text[at])) at++;
    else if (text[at] === '%') at = endOfLine(text, at);
    else break;
  }
  return at;
}

function commandAt(text, start) {
  let end = start + 1;
  if (isLetter(text[end])) {
    while (isLetter(text[end])) end++;
  } else if (end < text.length) end++;
  return { name: text.slice(start + 1, end), end };
}

function environmentAt(text, command) {
  if (command.name !== 'begin' && command.name !== 'end') return null;
  const at = skipWhitespaceAndComments(text, command.end);
  if (text[at] !== '{') return null;
  let end = at + 1;
  while (end < text.length && /[A-Za-z*]/.test(text[end])) end++;
  if (end === at + 1 || text[end] !== '}') return null;
  return { name: text.slice(at + 1, end), end: end + 1 };
}

function codeEnvironmentEnd(text, start, name) {
  // Code bodies are literal: percent signs and backslashes have no TeX role.
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const close = new RegExp(`\\\\end[ \\t]*\\{${escapedName}\\}`, 'g');
  close.lastIndex = start;
  const match = close.exec(text);
  return match ? match.index + match[0].length : null;
}

function textBlocks(text) {
  const blocks = [];
  let paragraphStart = null;
  let paragraphEnd = 0;

  function emitParagraph() {
    if (paragraphStart === null) return;
    let start = paragraphStart;
    while (start < paragraphEnd) {
      let end = Math.min(start + BLOCK_LIMIT, paragraphEnd);
      if (end < paragraphEnd) {
        // Prefer whole source lines. Hard-split a line that is itself too long.
        const window = text.slice(start, end);
        const lineBreak = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('\r'));
        if (lineBreak >= 0) end = start + lineBreak + 1;
        if (text[end - 1] === '\r' && text[end] === '\n') end--;
        const previous = text.charCodeAt(end - 1);
        const next = text.charCodeAt(end);
        if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
      }
      // A CRLF immediately after a full-sized line may be a whitespace-only
      // piece; omitting it loses no non-whitespace character.
      if (end <= start) end = Math.min(start + BLOCK_LIMIT, paragraphEnd);
      if (/\S/u.test(text.slice(start, end))) blocks.push({ start, end, kind: 'text_block' });
      start = end;
    }
    paragraphStart = null;
  }

  for (let start = 0; start < text.length;) {
    const lineEnd = endOfLine(text, start);
    const next = afterLineBreak(text, lineEnd);
    if (/\S/u.test(text.slice(start, lineEnd))) {
      if (paragraphStart === null) paragraphStart = start;
      paragraphEnd = next;
    } else emitParagraph();
    start = next;
  }
  emitParagraph();
  return blocks;
}

/**
 * @param {string} text Unmodified TeX source.
 * @returns {{math: Array<{start:number,end:number,kind:string}>,
 *   blocks: Array<{start:number,end:number,kind:'text_block'}>,
 *   diagnostics: Array<{code:string,offset:number,message:string}>}}
 */
export function scanTex(text) {
  if (typeof text !== 'string') throw new TypeError('scanTex requires a string');
  const math = [];
  const diagnostics = [];
  let active = null;

  const diagnose = (code, offset, message) => diagnostics.push({ code, offset, message });
  const beginMath = (start, kind, close, environment = null) => {
    active = { start, kind, close, braceDepth: 0, environments: environment ? [{ name: environment, start }] : [] };
  };
  const finishMath = end => {
    math.push({ start: active.start, end, kind: active.kind });
    active = null;
  };

  for (let at = 0; at < text.length;) {
    const char = text[at];
    if (char === '%') {
      at = endOfLine(text, at);
      continue;
    }
    if (char === '\\') {
      const command = commandAt(text, at);
      if (command.name === 'verb' || command.name === 'Verb') {
        let delimiterAt = command.end;
        if (text[delimiterAt] === '*') delimiterAt++;
        const delimiter = text[delimiterAt];
        const lineEnd = endOfLine(text, delimiterAt);
        if (delimiter === undefined || /\s/.test(delimiter)) {
          diagnose('INVALID_VERB_DELIMITER', at, 'Literal verb command has no non-whitespace delimiter.');
          at = lineEnd;
        } else {
          const close = text.indexOf(delimiter, delimiterAt + 1);
          if (close < 0 || close >= lineEnd) {
            diagnose('UNTERMINATED_VERB', at, 'Literal verb command is not closed on its source line.');
            at = lineEnd;
          } else at = close + 1;
        }
        continue;
      }

      const environment = environmentAt(text, command);
      if (environment) {
        const { name, end } = environment;
        if (command.name === 'begin' && CODE_ENVIRONMENTS.has(name)) {
          const close = codeEnvironmentEnd(text, end, name);
          if (close === null) diagnose('UNTERMINATED_CODE_ENVIRONMENT', at, `Literal environment ${name} is not closed.`);
          at = close ?? text.length;
          continue;
        }
        if (command.name === 'begin') {
          if (active) active.environments.push({ name, start: at });
          else if (MATH_ENVIRONMENTS.has(name)) beginMath(at, 'math_environment', null, name);
        } else if (active) {
          const matching = active.environments.findLastIndex(frame => frame.name === name);
          if (matching >= 0) {
            for (const frame of active.environments.slice(matching + 1)) {
              diagnose('UNTERMINATED_ENVIRONMENT', frame.start, `Nested environment ${frame.name} is not closed before ${name}.`);
            }
            active.environments.length = matching;
            if (active.close === null && matching === 0) finishMath(end);
          } else {
            diagnose('UNMATCHED_ENVIRONMENT_END', at, `Environment end ${name} has no matching begin inside this math candidate.`);
          }
        } else if (MATH_ENVIRONMENTS.has(name)) {
          diagnose('UNMATCHED_MATH_END', at, `Math environment end ${name} has no matching begin.`);
        }
        at = end;
        continue;
      }

      if (command.name === '(' || command.name === '[') {
        if (!active) beginMath(at, command.name === '(' ? 'inline_math' : 'display_math', command.name === '(' ? ')' : ']');
      } else if (command.name === ')' || command.name === ']') {
        if (!active) diagnose('UNMATCHED_MATH_END', at, `Math delimiter \\${command.name} has no matching opener.`);
        else if (active.close === command.name && active.braceDepth === 0) {
          for (const frame of active.environments) {
            diagnose('UNTERMINATED_ENVIRONMENT', frame.start, `Nested environment ${frame.name} is not closed before the math delimiter.`);
          }
          finishMath(command.end);
        }
      }
      // Consuming the entire control token also handles \\%, \\$, and \\\\.
      at = command.end;
      continue;
    }
    if (char === '$') {
      if (!active) {
        const double = text[at + 1] === '$';
        beginMath(at, double ? 'display_math' : 'inline_math', double ? '$$' : '$');
        at += double ? 2 : 1;
      } else if (active.braceDepth === 0 && (active.close === '$' || (active.close === '$$' && text[at + 1] === '$'))) {
        const length = active.close.length;
        for (const frame of active.environments) {
          diagnose('UNTERMINATED_ENVIRONMENT', frame.start, `Nested environment ${frame.name} is not closed before the math delimiter.`);
        }
        finishMath(at + length);
        at += length;
      } else at++;
      continue;
    }
    if (active && char === '{') active.braceDepth++;
    if (active && char === '}') active.braceDepth = Math.max(0, active.braceDepth - 1);
    at++;
  }

  if (active) {
    diagnose('UNTERMINATED_MATH', active.start, 'Math candidate is not closed; its range extends to end of input.');
    for (const frame of active.environments.slice(active.close === null ? 1 : 0)) {
      diagnose('UNTERMINATED_ENVIRONMENT', frame.start, `Nested environment ${frame.name} is not closed at end of input.`);
    }
    finishMath(text.length);
  }
  diagnostics.sort((left, right) => left.offset - right.offset || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
  return { math, blocks: textBlocks(text), diagnostics };
}
