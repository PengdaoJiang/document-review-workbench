import {check, sha} from './io.mjs';

export function locate(text, target) {
  check(target && typeof target.oldText === 'string' && target.oldText.length > 0 && target.oldText.length <= 40000, 'Target text is required');
  check(sha(target.oldText) === target.oldSha256, 'Old fragment hash does not match',409,'TARGET_HASH');
  check(typeof target.anchorId === 'string' && target.anchorId.length > 0 && typeof target.before === 'string' && typeof target.after === 'string' && target.before.length + target.after.length >= 24, 'A stable anchor and surrounding context are required');
  const needle = target.before + target.oldText + target.after;
  const start = text.indexOf(needle);
  check(start >= 0, 'Exact target context was not found',409,'TARGET_MISSING');
  check(text.indexOf(needle,start+1) < 0, 'Target context is not unique',409,'TARGET_AMBIGUOUS');
  return {start: start + target.before.length, end: start + target.before.length + target.oldText.length};
}
export function replaceExact(text,target,replacement) {
  const at = locate(text,target);
  return {text:text.slice(0,at.start) + replacement + text.slice(at.end), ...at};
}

// Accept keeps exactly the sealed existing body. The editor whitelist applies
// only to newly supplied replacement TeX; it is not a second source verdict.
export function validateDecisionFragment(request,decision,validateEdit=tex=>validateFragment(tex,request.manifest.files.map(f=>f.file))){
  check(decision.requestDigest===request.intentDigest&&decision.texSha256===sha(decision.tex),'Saved decision identity changed',409,'DECISION_CONTENT_CHANGED');
  if(decision.action==='accept'){
    check(decision.tex===request.spec.target.oldText&&sha(decision.tex)===request.spec.target.oldSha256,'Accept must preserve the exact sealed original fragment',409,'DECISION_CONTENT_CHANGED');
    return;
  }
  check(decision.action==='edit','Only an accepted or edited decision can be applied',409,'DECISION_CONTENT_CHANGED');
  validateEdit(decision.tex);
}

// A browser edits a body fragment, never the compiler, preamble or TeX runtime.
// Trusted local class files are sealed separately. This deliberately rejects
// metaprogramming: owners can prepare a new request for unusual representations.
export function validateFragment(fragment, inputNames = [], trustedPureCommands=new Set()) {
  check(typeof fragment === 'string' && fragment.length > 0 && fragment.length <= 40000, 'Fragment must contain 1–40000 characters');
  check(!fragment.includes('^^') && !fragment.includes('\0'), 'TeX encoded control tokens are not allowed');
  const environments=new Set('equation equation* align align* aligned alignedat gather gather* gathered multline multline* split cases array matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix figure figure* table table* tabular tabular* minipage center enumerate itemize description flushleft flushright'.split(' '));
  for(const m of fragment.matchAll(/\\(?:begin|end)\s*\{([^}]+)\}/g))check(environments.has(m[1]),'Unsupported body environment: '+m[1],400,'UNSAFE_TEX');
  const safe=new Set(('begin end '+
    'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa varkappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega '+
    'Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega '+
    'frac dfrac tfrac cfrac sqrt binom dbinom tbinom left right middle big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr Biggl Biggr '+
    'sum prod coprod int iint iiint oint lim limsup liminf inf sup min max arg det Pr gcd dim ker hom exp log ln sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth '+
    'le ge leq geq leqslant geqslant neq ne eqsim sim simeq approx cong equiv propto in notin ni subset subseteq supset supseteq ll gg to mapsto gets rightarrow leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow implies iff times cdot div pm mp ast star circ bullet oplus otimes cap cup bigcap bigcup wedge vee land lor neg forall exists nexists partial nabla infty emptyset varnothing ell hbar imath jmath Re Im angle triangle perp parallel '+
    'hat widehat bar overline underline vec dot ddot dddot tilde widetilde breve check acute grave mathring overbrace underbrace overset underset stackrel substack limits nolimits '+
    'mathbb mathbf mathcal mathrm mathit mathsf mathtt mathfrak boldsymbol bm text textrm textit textbf textsf texttt textnormal operatorname operatornamewithlimits mathop ensuremath displaystyle textstyle scriptstyle scriptscriptstyle '+
    'qquad quad thinspace medspace thickspace negthinspace space hspace vspace hfill vfill phantom hphantom vphantom smash strut mathstrut rule noindent indent par newline linebreak pagebreak nopagebreak smallskip medskip bigskip '+
    'label ref eqref pageref cite tag notag nonumber intertext shortintertext multicolumn hline cline toprule midrule bottomrule addlinespace cmidrule tabularnewline centering raggedright raggedleft caption captionof includegraphics footnote footnotemark footnotetext item emph textsc textsuperscript textsubscript textbackslash textasciitilde textasciicircum textendash textemdash textquotedblleft textquotedblright textquoteleft textquoteright copyright dag ddag S P ldots cdots vdots ddots dots lbrace rbrace langle rangle lvert rvert lVert rVert vert Vert backslash '+
    'small normalsize footnotesize scriptsize tiny large Large LARGE huge Huge bfseries itshape upshape mdseries rmfamily sffamily ttfamily scshape selectfont fontsize setlength addtolength baselineskip linewidth columnwidth textwidth textheight parindent parskip abovedisplayskip belowdisplayskip newcounter setcounter addtocounter stepcounter value arabic roman Roman alph Alph '+
    'paperheading sourceSection sourceSubsection sourceSubheading needspace mbox makebox fbox parbox raisebox rotatebox scalebox resizebox').split(/\s+/));
  const blocked = /^(input|include|includeonly|openin|openout|closein|closeout|read|readline|write|immediate|special|shipout|directlua|latelua|lua.*|pdf.*|XeTeX.*|catcode|mathcode|lccode|uccode|endlinechar|escapechar|csname|endcsname|expandafter|noexpand|scantokens|def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|Declare.*|usepackage|RequirePackage|documentclass|makeatletter|makeatother|every.*|loop|repeat|endinput|end|bye|batchmode|scrollmode|errorstopmode)$/i;
  for (const m of fragment.matchAll(/\\([a-zA-Z@]+|.)/g)) {
    if (m[1] === 'end' && /^\{(?:equation\*?|align\*?|aligned|gather\*?|split|cases|array|matrix|[bpBvV]matrix|figure\*?|table\*?|tabular\*?|minipage|center|enumerate|itemize|description)\}/.test(fragment.slice(m.index+m[0].length))) continue;
    check(!m[1].includes('@') && !blocked.test(m[1]), 'Unsupported executable TeX command in editor: \\' + m[1], 400, 'UNSAFE_TEX');
    check(!/^[a-zA-Z]/.test(m[1])||safe.has(m[1])||trustedPureCommands.has(m[1]),'Unsupported body command: \\' + m[1] + '. Ask the owner to prepare a supported representation.',400,'UNSAFE_TEX');
  }
  check(!/\\begin\s*\{document\}/.test(fragment), 'Editor only accepts body content');
  for (const m of fragment.matchAll(/\\includegraphics(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    check(inputNames.includes(m[1]), 'Figure must be a sealed project asset: ' + m[1], 400,'ASSET_NOT_SEALED');
  }
}
