'use strict';
// Unit tests for eagle-parser.js: the data-word line classification that
// suppresses "Unknown command" hints inside multiline data words, plus
// regression pins for the parser/scanner agreement on continuations and
// comment position.  Run with: npm test (or: node --test)
const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../eagle-parser');

// Convenience: which lines of `text` are classified as data-word interior?
const dataLines = (text) =>
  parser.getDataWordLines(text, parser.parseDocument(text));

// Each case: [description, source text, lines that MUST be suppressed,
// lines that MUST NOT be suppressed].
const cases = [
  // The review repro: multiline data words must not produce hints.
  ['set with multiline braced list',
    'set colors {\nred green\n}\n', [1, 2], [0]],
  ['set with multiline quoted string',
    'set x "hello\nworld"\n', [1], [0]],

  // Script bodies must still be analyzed.
  ['proc body is script',
    'proc p {} {\n  set x 1\n}\n', [], [0, 1]],
  ['if body is script',
    'if {1} {\n  puts hi\n}\n', [], [0, 1]],
  ['while body is script',
    'while {1} {\n  mystery\n}\n', [], [0, 1]],
  ['foreach body is script',
    'foreach v {a b} {\n  puts $v\n}\n', [], [0, 1]],
  ['catch body is script',
    'catch {\n  risky\n}\n', [], [0, 1]],
  ['namespace eval body is script',
    'namespace eval ns {\n  proc q {} {}\n}\n', [], [0, 1]],

  // Nesting: a data word inside a script body is still data.
  ['set data word inside proc body',
    'proc p {} {\n  set colors {\n    red\n  }\n  puts ok\n}\n',
    [2, 3], [0, 1, 4]],

  // switch: the immediate braced-argument lines are patterns, not
  // commands, so they are data.
  ['switch patterns are data',
    'switch $x {\n  a { puts 1 }\n  b { puts 2 }\n}\n', [1, 2, 3], [0]],

  // Unknown commands default to data (a wrong hint is worse than a
  // missing one).
  ['unknown command braced arg is data',
    'mycmd {\n  payload\n}\n', [1, 2], [0]],
];

for (const [name, text, mustSuppress, mustKeep] of cases) {
  test(name, () => {
    const got = dataLines(text);
    for (const l of mustSuppress) {
      assert.ok(got.has(l), `line ${l} should be suppressed; got {${[...got]}}`);
    }
    for (const l of mustKeep) {
      assert.ok(!got.has(l), `line ${l} should NOT be suppressed; got {${[...got]}}`);
    }
  });
}

test('single-line document has no data lines', () => {
  assert.equal(dataLines('set x {a b}\nputs $x\n').size, 0);
});

// Regression pins: parser/scanner agreement established in review.
test('continuation makes a leading # a word, not a comment', () => {
  const cmds = parser.parseDocument('puts \\\n#0\n');
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].commandName, 'puts');
});

test('escaped trailing backslash does not continue the line', () => {
  const cmds = parser.parseDocument('set dir C:\\\\\nmycmd $dir\n');
  assert.deepEqual(cmds.map((c) => c.commandName), ['set', 'mycmd']);
});

test('comment is recognized after an opening bracket', () => {
  const toks = parser.tokenizeLine('set y [# comment');
  assert.equal(toks[toks.length - 1].type, parser.TokenType.COMMENT);
});

// --- Tokenizer word boundaries (aligned with eagle-brace.js; each
// --- literal-word claim verified against the Eagle shell) ---

const lastTok = (line) => {
  const toks = parser.tokenizeLine(line);
  return toks[toks.length - 1];
};

test('mid-word open brace is part of the word', () => {
  const t = lastTok('set x prefix{suffix');
  assert.equal(t.type, parser.TokenType.WORD);
  assert.equal(t.text, 'prefix{suffix');
});

test('mid-word close brace is part of the word', () => {
  const t = lastTok('puts a}b');
  assert.equal(t.type, parser.TokenType.WORD);
  assert.equal(t.text, 'a}b');
});

test('mid-word quote is part of the word', () => {
  const t = lastTok('puts a"b');
  assert.equal(t.type, parser.TokenType.WORD);
  assert.equal(t.text, 'a"b');
});

test('stray } at word start is a word; }x is one word', () => {
  assert.equal(lastTok('set x }').text, '}');
  assert.equal(lastTok('puts }x').text, '}x');
});

test('word-start braces and quotes still group', () => {
  const toks = parser.tokenizeLine('proc p {a b} {body}');
  assert.deepEqual(toks.map((t) => t.type), [
    parser.TokenType.WORD, parser.TokenType.WORD,
    parser.TokenType.BRACE_STRING, parser.TokenType.BRACE_STRING,
  ]);
});

test('escaped braces do not affect brace-string depth', () => {
  // {a\}b} closes at the final brace; {a\\} closes after the escaped
  // backslash pair (the old backward peek misread this).
  assert.equal(lastTok('set x {a\\}b}').text, '{a\\}b}');
  assert.equal(lastTok('set x {a\\\\}').text, '{a\\\\}');
});

test('options are still recognized after the boundary change', () => {
  const toks = parser.tokenizeLine('lsort -integer $l');
  assert.equal(toks[1].type, parser.TokenType.OPTION);
});

test('mid-line CR is a word separator (Parser.cs Space class)', () => {
  // Verified against the Eagle shell: a raw CR after a close-brace is
  // legal inter-word whitespace, not "extra characters".
  const toks = parser.tokenizeLine('set x\ry');
  assert.deepEqual(toks.map((t) => t.text), ['set', 'x', 'y']);
});

// --- Folding ranges (single lexical model via scanDocument) ---

const folds = (text) => parser.computeFoldingRanges(text);

test('multiline braced word folds', () => {
  assert.deepEqual(folds('proc p {} {\n  set x 1\n}\n'),
    [{ startLine: 0, endLine: 2, kind: 'region' }]);
});

test('nested braced words fold individually', () => {
  const r = folds('proc p {} {\n  if {1} {\n    puts hi\n  }\n}\n');
  assert.deepEqual(r, [
    { startLine: 1, endLine: 3, kind: 'region' },
    { startLine: 0, endLine: 4, kind: 'region' },
  ]);
});

test('braces inside strings and comments do not fold', () => {
  assert.deepEqual(folds('# opening {\nset x 1\nset y "}"\n'), []);
  assert.deepEqual(folds('set s "a {\nb"\nset t 1\n'), []);
});

test('comment runs fold; word-content # lines do not', () => {
  assert.deepEqual(folds('# one\n# two\n# three\nset x 1\n'),
    [{ startLine: 0, endLine: 2, kind: 'comment' }]);
  // `#0` here is word content (continuation), not a comment line.
  assert.deepEqual(folds('puts \\\n#0\n# real\n# run\n'),
    [{ startLine: 2, endLine: 3, kind: 'comment' }]);
});

test('continued comment lines join the comment run', () => {
  assert.deepEqual(folds('# a \\\n b\n# c\nset x 1\n'),
    [{ startLine: 0, endLine: 2, kind: 'comment' }]);
});

test('single comment line does not fold', () => {
  assert.deepEqual(folds('# alone\nset x 1\n'), []);
});
