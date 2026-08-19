/**
 * Brace/bracket balance scanner - pass one of the LSP's diagnostics.
 */
'use strict';

/**
 * Hard ceiling on the number of diagnostics one scan may produce.  A
 * pathological document (say, 200 KB of `}` characters) would otherwise
 * generate hundreds of thousands of diagnostic objects, which is useless
 * to the user and expensive to publish over the wire.
 */
const MAX_DIAGNOSTICS = 100;

/**
 * Does `line` end in an unescaped backslash, i.e. a Tcl line continuation?
 *
 * Escape parity matters: `set dir C:\\` ends in TWO backslashes -- the
 * second is escaped data, not a continuation -- while three trailing
 * backslashes (`\\\`) do continue the line.  A trailing `\r` (CRLF
 * documents, which editors on Windows commonly produce) is ignored so the
 * backslash is still recognised as the last meaningful character.
 *
 * Shared with `eagle-parser.js` so both diagnostic passes agree on what a
 * continuation is.
 *
 * @param {string} line - One line of text, without its terminating `\n`
 *   (a trailing `\r` is tolerated).
 * @returns {boolean} True when the line continues onto the next one.
 */
function endsInLineContinuation(line) {
  let end = line.length;
  if (end > 0 && line[end - 1] === '\r') end--;
  let n = 0;
  while (n < end && line[end - 1 - n] === '\\') n++;
  return (n & 1) === 1;
}

/**
 * Scan `text` character-by-character and report unbalanced braces and
 * brackets: every closing `}` / `]` that has no matching opener, and --
 * matching real Tcl, which fails such scripts with "missing close-brace"
 * -- every opener still unmatched when the document ends.
 *
 * The scan honours the Eagle/Tcl lexical context that determines whether
 * a brace "counts":
 *
 *   - Backslash escapes: the character after a `\` is skipped, so `\{`,
 *     `\}`, `\[`, `\]`, and `\"` never affect the depth.  An unescaped
 *     `\` at end of line is a line continuation: the next line does NOT
 *     begin a new command.  Works for both LF and CRLF documents.
 *   - Braced words: inside `{...}` only braces themselves (and backslash
 *     escapes) are special.  `#`, `;`, `"`, `[`, and `]` are ordinary
 *     characters there -- `set re {]}`, `set x {a;# {}}`, and
 *     `set s {"}` are all well-formed.  Braces on comment-LOOKING lines
 *     inside a braced word still count, exactly as in Tcl's own
 *     brace-matching rule.
 *   - Double-quoted strings (outside braces): brace/bracket counting is
 *     disabled inside them.
 *   - Comments: a `#` starts a comment ONLY in command position -- the
 *     start of a line (unless the previous line continued), or the first
 *     non-whitespace after a `;` or an opening `[` -- and only at brace
 *     depth zero.  This is Tcl's actual rule; a `#` anywhere else
 *     (`uplevel #0 {...}`, `set c #ff0000`, `puts #x`) is an ordinary
 *     word character (issue #1).  A comment line that ends in a line
 *     continuation continues the COMMENT onto the next line, again
 *     matching Tcl.
 *
 * Unmatched closers are reported where they occur and the depth is
 * clamped, so a single typo does not avalanche into cascading errors.
 * Unmatched openers are reported at the opener once the whole document
 * has been scanned.  Output is capped at `MAX_DIAGNOSTICS`.
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
  const braceStack = [];   // [line, column] of each unmatched '{'
  const bracketStack = []; // [line, column] of each unmatched '['
  const lines = text.split('\n');
  let inString = false;
  // True while the scanner is at the start of a command -- the only place
  // Tcl recognises a `#` comment.  Only meaningful at brace depth zero.
  let atCommandStart = true;
  let continued = false;   // previous code line ended in a continuation
  let inComment = false;   // previous comment line ended in a continuation

  const report = (message, l, c) => {
    if (diagnostics.length >= MAX_DIAGNOSTICS) return;
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: { start: { line: l, character: c }, end: { line: l, character: c + 1 } },
      message,
      source: 'eagle',
    });
  };

  for (let l = 0; l < lines.length; l++) {
    let line = lines[l];
    if (line.length > 0 && line[line.length - 1] === '\r') {
      line = line.slice(0, -1); // CRLF document: drop the carriage return
    }
    if (inComment) {
      // A continued comment swallows this whole line too.
      inComment = endsInLineContinuation(line);
      continue;
    }
    if (!continued) atCommandStart = true;
    continued = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '\\') {
        if (c === line.length - 1) { continued = true; } // line continuation
        else { c++; if (braceStack.length === 0) atCommandStart = false; }
        continue;
      }
      if (braceStack.length > 0) {
        // Inside a braced word only braces themselves are special.
        if (ch === '{') braceStack.push([l, c]);
        else if (ch === '}') braceStack.pop();
        continue;
      }
      if (ch === '"') { inString = !inString; atCommandStart = false; continue; }
      if (inString) continue;
      if (ch === '#') {
        if (atCommandStart) {
          if (endsInLineContinuation(line)) inComment = true;
          break; // comment: the rest of the line is ignored
        }
        atCommandStart = false; // ordinary word character
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v') {
        continue; // whitespace does not leave command position
      }
      if (ch === ';') { atCommandStart = true; continue; }
      if (ch === '{') { braceStack.push([l, c]); atCommandStart = false; continue; }
      if (ch === '}') {
        report('Unmatched closing brace', l, c);
        atCommandStart = false;
        continue;
      }
      if (ch === '[') {
        bracketStack.push([l, c]);
        atCommandStart = true; // a new command begins inside [ ]
        continue;
      }
      if (ch === ']') {
        if (bracketStack.length > 0) bracketStack.pop();
        else report('Unmatched closing bracket', l, c);
        atCommandStart = false;
        continue;
      }
      atCommandStart = false; // every remaining case is inside a word
    }
  }

  for (const [l, c] of braceStack) report('Unclosed opening brace', l, c);
  for (const [l, c] of bracketStack) report('Unclosed opening bracket', l, c);
  return diagnostics;
}

module.exports = { scanBraces, endsInLineContinuation, MAX_DIAGNOSTICS };
