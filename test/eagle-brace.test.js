'use strict';
// Unit tests for the brace/bracket scanner behind "Unmatched closing brace".
// Zero dependencies: uses Node's built-in test runner.  Run with:
//     npm test           (or: node --test)
// Every case with expectation 0 is a script real tclsh accepts; every case
// with a nonzero expectation is one tclsh rejects.
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
  assert.equal(d.message, 'Unclosed opening brace');
  assert.deepEqual(d.range, { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } });
});

test('pathological input is capped, not unbounded', () => {
  const diags = scan('}\n'.repeat(200000));
  assert.equal(diags.length, MAX_DIAGNOSTICS);
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
