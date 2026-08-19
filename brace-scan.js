/**
 * Brace/bracket balance scanner - pass one of the LSP's diagnostics.
 */
'use strict';

/**
 * Scan `text` character-by-character and report every closing brace or
 * bracket that has no matching opener.
 *
 * The scan honours three pieces of Eagle/Tcl lexical context:
 *
 *   - Backslash escapes: the character after a `\` is skipped.  A `\` as
 *     the very last character of a line is a line continuation, so the
 *     next line does NOT begin a new command.
 *   - Double-quoted strings: brace/bracket counting is disabled inside them.
 *   - Comments: a `#` starts a comment ONLY in command position -- that is,
 *     as the first non-whitespace character of a command.  Command position
 *     is the start of a line (unless continued), or the first
 *     non-whitespace after a `;` or an opening `[`.  This is Tcl's actual
 *     rule.  A `#` anywhere else -- `uplevel #0 {...}`, `set c #ff0000`,
 *     `puts #x` -- is an ordinary word character.
 *
 * The comment rule matters more than it looks: an earlier version treated
 * any `#` preceded by whitespace as a comment, which swallowed the rest of
 * the line, including any `{`, so the matching `}` on a later line was
 * reported as "Unmatched closing brace" (issue #1, `uplevel #0 { ... }`).
 *
 * A negative depth produces one Error-severity diagnostic for the offending
 * closer and the depth is clamped back to zero, so a single typo does not
 * avalanche into cascading errors.
 *
 * Kept as its own dependency-free module so it can be unit-tested without
 * an LSP connection; `server.js`'s `validateDocument` is the production
 * caller.
 *
 * @param {string} text - Full document text.
 * @param {{Error: number}} DiagnosticSeverity - Severity enum to stamp on
 *   each diagnostic; passed in so this module has no import of its own.
 * @returns {Array<object>} LSP diagnostic objects, possibly empty.
 */
function scanBraces(text, DiagnosticSeverity) {
  const diagnostics = [];
  let braceDepth = 0, bracketDepth = 0;
  const lines = text.split('\n');
  let inString = false;
  // True while the scanner is at the start of a command -- the only place
  // Tcl recognises a `#` comment.  Cleared by any word character; set again
  // by `;`, `[`, and (unless the previous line ended in a continuation
  // backslash) the start of each line.
  let atCommandStart = true;
  let continued = false;

  const report = (message, l, c) => {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: { start: { line: l, character: c }, end: { line: l, character: c + 1 } },
      message,
      source: 'eagle',
    });
  };

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    if (!continued) atCommandStart = true;
    continued = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '\\') {
        if (c === line.length - 1) { continued = true; }   // line continuation
        else { c++; atCommandStart = false; }             // escape next char
        continue;
      }
      if (ch === '"') { inString = !inString; atCommandStart = false; continue; }
      if (inString) continue;
      if (ch === '#') {
        if (atCommandStart) break;   // comment: rest of line is ignored
        continue;                    // ordinary word character
      }
      if (/\s/.test(ch)) continue;   // whitespace does not leave command start
      if (ch === ';') { atCommandStart = true; continue; }

      atCommandStart = false;        // every remaining case is inside a word
      if (ch === '{') {
        braceDepth++;
      } else if (ch === '}') {
        if (--braceDepth < 0) { report('Unmatched closing brace', l, c); braceDepth = 0; }
      } else if (ch === '[') {
        bracketDepth++;
        atCommandStart = true;       // a new command begins inside [ ]
      } else if (ch === ']') {
        if (--bracketDepth < 0) { report('Unmatched closing bracket', l, c); bracketDepth = 0; }
      }
    }
  }
  return diagnostics;
}

module.exports = { scanBraces };
