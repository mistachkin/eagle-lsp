'use strict';
// Unit tests for the brace/bracket scanner behind "Unmatched closing brace".
// Zero dependencies: uses Node's built-in test runner.  Run with:
//     npm test           (or: node --test)
// Every script case below has been verified against the EAGLE interpreter
// (the target language -- Tcl 8.4 baseline, no {*} expansion): expectation
// 0 means Eagle parses the document, nonzero means Eagle rejects it with a
// brace/bracket/quote error.  Where Eagle and modern Tcl diverge, Eagle
// wins; the divergences are marked in the case comments.
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanBraces, endsInLineContinuation, MAX_DIAGNOSTICS } =
  require('../eagle-brace');

const Severity = { Error: 1 };
const scan = (text) => scanBraces(text, Severity);

// Each case: [description, source text, expected number of diagnostics].
// `0` means the document is well-formed and must produce no error; a
// nonzero count means the scanner must catch each genuine imbalance.
const cases = [
  // Issue #1: `#` inside a word must not start a comment.
  ['uplevel #0 with braced body (issue #1)',      'uplevel #0 {\n  set my_var 3\n}\n', 0],
  ['uplevel 1 with braced body (baseline)',       'uplevel 1 {\n  set my_var 3\n}\n', 0],
  ['literal word starting with # then brace',     'set x #0 {\n}\n', 0],
  ['color literal',                               'set c #ff0000\nset d {\n}\n', 0],
  ['# inside a braced body is not command start', 'if 1 { puts #x }\n', 0],
  ['nested uplevel #0 inside proc',
    'proc p {} {\n  if {1} {\n    uplevel #0 { set z 1 }\n  }\n}\n', 0],

  // Genuine comments, in every command position Tcl recognises.
  ['comment at line start hides braces',          '# a comment {\nset x 1\n', 0],
  ['indented comment hides braces',               '   # comment {\nset x 1\n', 0],
  ['comment after ; hides {',                     'set x 1 ;# note {\nset y 2\n', 0],
  ['comment after ; hides }',                     'set x 1 ;# note }\nset y 2\n', 0],
  ['comment after ; with space',                  'set a 1; # b {\nset c 2\n', 0],
  ['comment as first thing inside [',             'set y [# comment {\n]\n', 0],
  ['comment on line inside [ ]',                  'set y [\n# comment {\nexpr 1]\n', 0],
  ['braces on consecutive comment lines',         '# {\n# }\nset ok 1\n', 0],

  // Line continuation keeps the command open, so a leading # is a word.
  ['backslash continuation then #... is a word',  'set x \\\n  #notacomment {\n}\n', 0],
  ['backslash continuation, # then braces',       'puts \\\n#0\nset y {\n}\n', 0],

  // Continuations on CRLF documents (finding: `\r` broke the trailing-`\`
  // test, so the fix above silently regressed on Windows line endings).
  ['CRLF: continuation then #... is a word',
    'set x \\\r\n  #notacomma {\r\n}\r\n', 0],
  ['CRLF: plain braced body',                     'set x {\r\n}\r\n', 0],
  ['CRLF: comment hides braces',                  '# comment {\r\nset x 1\r\n', 0],

  // Escape parity: `C:\\` ends in an ESCAPED backslash, not a continuation.
  ['even trailing backslashes do not continue',
    'set dir C:\\\\\n# comment {\nset x 1\n', 0],
  ['odd trailing backslashes do continue',        'set x a\\\\\\\n#0 {\n}\n', 0],

  // A comment that ends in a continuation continues the COMMENT (Tcl rule).
  ['comment continuation hides next line',        '# comment \\\n}\nputs OK\n', 0],
  ['comment continuation chains',                 '# a \\\n b \\\n c {\nset x 1\n', 0],

  // Inside a braced word, only braces are special: `#`, `;`, `"`, `[`,
  // and `]` are ordinary characters there (several findings).
  ['{a;# {} } - ;# inside braces is literal',     'set x {a;# {\n}}\n', 0],
  ['comment-looking line inside braces counts',   'set x {\n    # {\n}\n}\n', 0],
  ['lone ] inside braces is literal',             'set re {]}\n', 0],
  ['lone [ inside braces is literal',             'set re {[}\nset x 1\n]\n', 1],
  ['quote inside braces is literal',              'set re {"}\n}\n', 1],
  ['escaped brace inside braced word',            'set x {\\{}\n', 0],

  // Braces and quotes group only at the beginning of a word.  Mid-word
  // structural-looking characters are literal data in real Tcl.
  ['opening brace in a bare word is literal',     'set x prefix{suffix\n', 0],
  ['closing brace in a bare word is literal',     'set x prefix}suffix\n', 0],
  ['closing brace as an argument is literal',     'set x }\n', 0],
  ['closing bracket in a bare word is literal',   'set x prefix]suffix\n', 0],
  ['mid-word quote does not hide later errors',   'set x prefix"suffix\n}\n', 1],
  ['continuation begins a new braced word',       'set x \\\n{\n', 1],
  ['command continues after multiline braced word',
    'set x {\n} #notcomment {\n}\n', 0],
  ['command continues after multiline quoted word',
    'set x "a\n" #notcomment {\n}\n', 0],

  // Unbalanced brace hidden in a braced-body "comment": real Tcl fails
  // with "missing close-brace: possible unbalanced brace in comment".
  ['unbalanced { in comment inside braced body',
    'proc p {} {\n  # unbalanced {\n  set x 1\n}\n', 1],

  // Strings and escapes are unchanged.
  ['braces inside double quotes',                 'set s "a { b"\nset t "}"\n', 0],
  ['escaped braces',                              'set s \\{\nset t \\}\n', 0],

  // Word ends: after a closed braced/quoted word, Tcl allows only
  // whitespace, ';', a closing ']', end of line, or a continuation.
  // Everything else is "extra characters after close-brace/close-quote".
  ['extra } after close-brace',                   'set x {a}}\n', 1],
  ['extra } after proc body',                     'proc p {} {\n  puts hi\n}}\n', 1],
  ['extra { after close-brace',                   'set x {a}{b\n', 1],
  ['extra ] after close-brace',                   'set x {a}]\n', 1],
  ['extra [ after close-brace',                   'set x {a}[list]\n', 1],
  ['extra quote after close-brace',               'set x {a}"b"\n', 1],
  ['extra escape after close-brace',              'set x {a}\\b\n', 1],
  ['extra word char after close-brace',           'set x {a}b\n', 1],
  ['extra # after close-brace',                   'set x {a}#c\n', 1],
  ['extra } after close-quote',                   'set x "a"}\n', 1],
  ['extra { after close-quote',                   'set x ""{\n', 1],
  ['one typo, one diagnostic (no cascade)',       'set x {a}bcdef{\n', 1],
  ['whitespace after close-brace is fine',        'set x {a} {b}\n', 0],
  ['mid-line CR after close-brace is whitespace', 'set x {a}\rset y {b}\n', 0],
  ['; after close-brace is fine',                 'set x {a};puts hi\n', 0],
  ['] after close-brace closes substitution',     'puts [list {a}]\n', 0],
  ['continuation after close-brace separates',    'set x {a}\\\nb\n', 0],
  ['EOL after close-brace is fine',               'set x {a}\nset y {b}\n', 0],

  // Braced variable names: ${ is special even mid-word, no nesting.
  ['unclosed braced variable name',               'set x ${y\n', 1],
  ['braced variable name then text',              'set x ${y}tail\n', 0],
  ['braced variable name mid-word',               'puts pre${y}post\n', 0],
  ['escaped $ does not open variable name',       'puts \\${y\nset z {\n}\n', 0],

  // Continuation inside a quoted string must not leak word state
  // through the closing quote.
  ['string continuation then extra { after quote','set x "a\\\n"{c\n', 1],

  // --- Quoting corner cases, all oracle-verified against the Eagle shell ---

  // Eagle divergence: Eagle (Tcl 8.4 baseline) has NO {*} argument
  // expansion, so a word-initial {*} is a complete braced word and
  // anything directly after it is "extra characters after close-brace"
  // -- verified against the Eagle shell, which rejects all of these.
  // (Tcl 8.5+ would accept the first five; the target language wins.)
  ['no expansion: {*} before $var',               'puts {*}$argv\n', 1],
  ['no expansion: {*} before [cmd]',              'puts {*}[list a b]\n', 1],
  ['no expansion: {*} before braced word',        'puts {*}{a b}\n', 1],
  ['no expansion: {*} before quoted word',        'puts {*}"a b"\n', 1],
  ['no expansion: {*} before bare word',          'set x {*}z\n', 1],
  ['bare {*} word alone is a literal *',          'set x {*}\n', 0],
  ['{**} then char',                              'set x {**}b\n', 1],
  ['{} then char',                                'set x {}b\n', 1],
  ['{ *} then char',                              'set x { *}b\n', 1],
  ['{*}{*} then $var',                            'puts {*}{*}$argv\n', 1],

  // Double-quoted strings: command and variable substitution stay
  // active inside them, and an unterminated string is an error.
  ['unterminated quote at EOF',                   'set x "abc\n', 1],
  ['unterminated quote does not hide the rest',   'set x "abc\nset y {\n}\n', 1],
  ['command subst inside quotes',                 'set x "a[list b]c"\n', 0],
  ['unclosed [ inside quotes',                    'set x "a[list b"\n', 2],
  ['nested quotes via subst',                     'set x "a[list "b"]c"\n', 0],
  ['braces inside subst inside quotes',           'set x "a[list {b c}]d"\n', 0],
  ['stray ] inside quotes is literal',            'set x "a]b"\n', 0],
  ['stray } inside quotes is literal',            'set x "a}b"\n', 0],
  ['stray { inside quotes is literal',            'set x "a{b"\n', 0],
  ['semicolon inside quotes is literal',          'set x "a;b"\nset y {\n}\n', 0],
  ['hash inside quotes is literal',               'set x "a#b {"\nset y 1\n', 0],
  ['escaped quote inside string',                 'set x "a\\"b"\n', 0],
  ['escaped backslash then close quote',          'set x "a\\\\"\n', 0],
  ['braced varname inside quotes',                'set x "${argv}"\n', 0],
  ['unclosed braced varname in quotes',           'set x "${argv\n', 2],
  ['plain $ inside quotes',                       'set x "$argv b"\n', 0],
  ['quote spans lines then closes',               'set x "a\nb"\nset y {\n}\n', 0],
  ['empty quoted word',                           'set x ""\n', 0],
  ['adjacent quoted words',                       'set x "" ""\n', 0],
  ['subst directly after close-quote is extra',   'set x "a"[list b]\n', 1],

  // Backslash escapes in words.
  ['escaped hash at command start',               'catch {\\#x}\n', 0],
  ['escaped space joins words',                   'set x a\\ b\n', 0],
  ['escaped semicolon is literal',                'set x a\\;b\n', 0],
  ['escaped bracket open',                        'set x a\\[b\n', 0],
  ['escaped bracket close',                       'set x a\\]b\n', 0],
  ['continuation inside braced word',             'set x {a \\\n b}\n', 0],
  ['continuation inside quoted word',             'set x "a \\\nb"\n', 0],
  ['backslash at very end of document',           'set x a\\', 0],

  // Command substitution.
  ['mid-word command substitution',               'puts a[list x]b\n', 0],
  ['nested substitution',                         'set x [list [list a] b]\n', 0],
  ['quoted word inside subst then close',         'set x [list "a"]\n', 0],
  ['semicolons inside subst',                     'set x [set y 1; list a]\n', 0],
  ['stray ] at word start is literal',            'set x ]\n', 0],

  // Variable substitution.
  ['empty braced varname',                        'catch {set x ${}}\n', 0],
  ['dollar dollar brace',                         'catch {set x $${argv}}\n', 0],
  ['varname with braces inside',                  'set x ${a{b}\n', 0],
  ['array parens are not special',                'set a(1) x\nset y $a(1)\n', 0],

  // Brace words.
  ['escaped braces inside braced word',           'set x {a\\{b}\n', 0],
  ['escaped close inside braced word',            'set x {a\\}b}\n', 0],
  ['deeply nested braces',                        'set x {a{b{c}d}e}\n', 0],
  ['brace word ends at ; then comment',           'set x {a};# note {\nset y 1\n', 0],
  ['quote directly inside braces',                'set x {"a"}\n', 0],

  // Negatives: real errors must still be reported.
  ['genuine unmatched }',                         'set x 1\n}\n', 1],
  ['genuine unmatched ]',                         'set x 1\n]\n', 1],
  ['comment ends at newline; next-line } is real','# c\n}\n', 1],
  ['unclosed { is reported at end of document',   'set x {\nset y 1\n', 1],
  ['unclosed [ is reported at end of document',   'set y [\nexpr 1\n', 1],
];

for (const [name, text, expected] of cases) {
  test(name, () => {
    const diags = scan(text);
    assert.equal(
      diags.length, expected,
      `expected ${expected} diagnostic(s), got ${diags.length}: ` +
        diags.map((d) => `${d.message}@${d.range.start.line}:${d.range.start.character}`).join(', '),
    );
    for (const d of diags) {
      assert.equal(d.source, 'eagle');
      assert.equal(d.severity, Severity.Error);
    }
  });
}

test('diagnostic range points at the offending closer', () => {
  const [d] = scan('set x 1\n  }\n');
  assert.deepEqual(d.range, { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } });
});

test('unclosed opener diagnostic points at the opener', () => {
  const [d] = scan('set x {\nset y 1\n');
  assert.equal(d.message, 'missing close-brace');
  assert.deepEqual(d.range, { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } });
});

test('pathological input is capped, not unbounded', () => {
  const diags = scan('}\n'.repeat(200000));
  assert.equal(diags.length, MAX_DIAGNOSTICS);
});

test('single-line closer flood: first } is the command, rest are literal', () => {
  // `}}}}...` is ONE command whose (invalid) name is '}' followed by
  // literal word characters -- tclsh reports a single error, and so
  // must the scanner (this is the case the pre-word-boundary scanner
  // over-reported and the cap test above no longer exercises).
  const diags = scan('}'.repeat(200000));
  assert.equal(diags.length, 1);
  assert.equal(diags[0].message, 'invalid command name "}"');
});

test('extra-characters diagnostic points at the offending character', () => {
  const [d] = scan('set x {a}}\n');
  assert.equal(d.message, 'extra characters after close-brace');
  assert.deepEqual(d.range, { start: { line: 0, character: 9 }, end: { line: 0, character: 10 } });
});

test('missing close-brace for variable name points at the {', () => {
  const [d] = scan('set x ${y\n');
  assert.equal(d.message, 'missing close-brace for variable name');
  assert.deepEqual(d.range, { start: { line: 0, character: 7 }, end: { line: 0, character: 8 } });
});

test('unclosed double quote points at the opening quote', () => {
  const [d] = scan('set x "abc\n');
  assert.equal(d.message, 'missing "');
  assert.deepEqual(d.range, { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } });
});

test('endsInLineContinuation: parity and CRLF', () => {
  assert.equal(endsInLineContinuation('set x \\'), true);
  assert.equal(endsInLineContinuation('set x \\\r'), true);
  assert.equal(endsInLineContinuation('set dir C:\\\\'), false);
  assert.equal(endsInLineContinuation('set x a\\\\\\'), true);
  assert.equal(endsInLineContinuation('set x'), false);
  assert.equal(endsInLineContinuation(''), false);
  assert.equal(endsInLineContinuation('\\'), true);
});
