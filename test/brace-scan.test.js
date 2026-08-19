'use strict';
// Unit tests for the brace/bracket scanner behind "Unmatched closing brace".
// Zero dependencies: uses Node's built-in test runner.  Run with:
//     node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanBraces } = require('../brace-scan');

const Severity = { Error: 1 };
const scan = (text) => scanBraces(text, Severity);

// Each case: [description, source text, expected number of diagnostics].
// `0` means the document is well-formed and must produce no error; `1`
// means the scanner must still catch a genuinely unmatched closer.
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

  // Strings and escapes are unchanged.
  ['braces inside double quotes',                 'set s "a { b"\nset t "}"\n', 0],
  ['escaped braces',                              'set s \\{\nset t \\}\n', 0],

  // Negatives: real errors must still be reported.
  ['genuine unmatched }',                         'set x 1\n}\n', 1],
  ['genuine unmatched ]',                         'set x 1\n]\n', 1],
  ['comment ends at newline; next-line } is real','# c\n}\n', 1],
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
