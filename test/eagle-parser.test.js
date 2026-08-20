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
