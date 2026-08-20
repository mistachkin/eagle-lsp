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
 *     brace-matching rule.  An opening brace starts this grouping only at
 *     the beginning of a word; braces in `prefix{suffix` and
 *     `prefix}suffix` are literal data.  The exception is `${`: a brace
 *     after a dollar sign begins a braced VARIABLE NAME even mid-word,
 *     running (with no nesting and no escapes) to the first `}` --
 *     `set x ${y` is Tcl's "missing close-brace for variable name".
 *   - Word ends: once a braced or quoted word closes, Tcl allows only
 *     whitespace, `;`, a closing `]`, the end of the line, or a line
 *     continuation to follow.  Anything else -- `set x {a}}`,
 *     `set x {a}{b`, `set x "a"{c`, `set x {a}[cmd]` -- is reported as
 *     "Extra characters after close-brace" / "close-quote", matching
 *     tclsh.  Conversely a stray `}` or `]` mid-word or at word start
 *     (`puts a}b`, `puts }`) is legal literal data and is NOT reported;
 *     an unmatched closer is flagged only in command position.
 *   - Double-quoted strings (outside braces): braces are literal inside
 *     them, but command substitution (`[...]`) and braced variable
 *     names (`${...}`) stay ACTIVE, exactly as in Tcl -- the string is
 *     suspended for the substitution and resumes after it, to any
 *     nesting depth.  A quote begins a string only at the start of a
 *     word (`puts a"b` is literal), and an unterminated string is
 *     reported at its opening quote ("missing quote" in tclsh).
 *   - NO `{*}` argument expansion: Eagle (Tcl 8.4 language baseline)
 *     does not support Tcl 8.5's expansion prefix, so `puts {*}$args`
 *     is an "extra characters after close-brace" error here -- exactly
 *     what the Eagle interpreter reports.  Do not "fix" this to match
 *     modern Tcl; the target language is Eagle.
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
 * @returns {{diagnostics: Array<object>, lineStates: Array<object>}}
 *   "diagnostics" is the LSP diagnostic array (possibly empty).
 *   "lineStates" has one entry per line of `text`, describing the lexical
 *   context at the START of that line: "braceOpener" is the [line, col]
 *   of the innermost still-open `{` (null at brace depth zero),
 *   "inString" is true inside a multiline double-quoted word, and
 *   "inComment" is true on the trailing lines of a continued comment.
 *   Callers (e.g. the unknown-command pass) use this to tell which lines
 *   are the interior of a multiline word rather than fresh commands.
 */
function scanDocument(text, DiagnosticSeverity) {
  const diagnostics = [];
  const lineStates = [];
  const braceStack = [];   // [line, column] of each unmatched '{'
  const bracketStack = []; // [line, column] of each unmatched '['
  const lines = text.split('\n');
  let inString = false;

  // Word-position state, a single strictly-ordered variable rather than
  // cooperating booleans.  The invariants live in one place:
  //
  //   COMMAND_START  start of a command: the only place `#` starts a
  //                  comment, and the only place a stray `}` / `]` is an
  //                  error ("invalid command name").
  //   WORD_START     between words of a command: `{` and `"` begin
  //                  grouping here (and at COMMAND_START), stray closers
  //                  are literal.
  //   IN_WORD        inside a bare word: `{`, `}`, `]`, and `"` are all
  //                  literal; `[` and `${` still substitute.
  //   AFTER_CLOSE    a braced or quoted word just closed: only
  //                  whitespace, `;`, a closing `]`, end of line, or a
  //                  continuation may follow ("extra characters after
  //                  close-brace/close-quote" otherwise).
  const COMMAND_START = 0, WORD_START = 1, IN_WORD = 2, AFTER_CLOSE = 3;
  let wordPos = COMMAND_START;
  let lastClose = 'brace'; // which kind of word closed ('brace'/'quote')
  let varNameStart = null; // [line, col, fromString] of the '{' in an open '${'
  let stringStart = null;  // [line, col] of the current string's opening '"'
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

  // Report "extra characters after close-brace/quote" once at the first
  // offending character, then drop to IN_WORD so one typo produces one
  // diagnostic instead of one per following character.
  const extraChars = (l, c) => {
    report('Extra characters after close-' + lastClose, l, c);
    wordPos = IN_WORD;
  };

  for (let l = 0; l < lines.length; l++) {
    let line = lines[l];
    if (line.length > 0 && line[line.length - 1] === '\r') {
      line = line.slice(0, -1); // CRLF document: drop the carriage return
    }
    lineStates.push({
      braceOpener: braceStack.length > 0 ? braceStack[braceStack.length - 1] : null,
      inString,
      inComment,
    });
    if (inComment) {
      // A continued comment swallows this whole line too.
      inComment = endsInLineContinuation(line);
      continue;
    }
    // A physical newline starts a new command only at the active script
    // level.  Newlines inside braced words, quoted words, or braced
    // variable names belong to the outer command, which resumes after
    // the closing delimiter.
    if (!continued && braceStack.length === 0 && !inString &&
        varNameStart === null) {
      wordPos = COMMAND_START;
    }
    continued = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (varNameStart !== null) {
        // Braced variable name: everything (no nesting, no escapes) up
        // to the first '}' -- Tcl's rule for `${name}`.  When the name
        // was opened inside a double-quoted string, the string simply
        // resumes.
        if (ch === '}') {
          const fromString = varNameStart[2];
          varNameStart = null;
          if (!fromString) wordPos = IN_WORD;
        }
        continue;
      }
      if (ch === '\\') {
        if (c === line.length - 1) {
          continued = true;
          // Backslash-newline acts as a word separator; inside a string
          // or braced word it is ordinary content and must not disturb
          // the word state (a quoted word can span lines).
          if (!inString && braceStack.length === 0) wordPos = WORD_START;
        } else {
          c++;
          if (!inString && braceStack.length === 0) {
            if (wordPos === AFTER_CLOSE) extraChars(l, c - 1);
            else wordPos = IN_WORD;
          }
        }
        continue;
      }
      if (braceStack.length > 0) {
        // Inside a braced word only braces themselves are special.
        if (ch === '{') {
          braceStack.push([l, c]);
        } else if (ch === '}') {
          braceStack.pop();
          if (braceStack.length === 0) {
            // NOTE: unlike Tcl 8.5+, Eagle has NO `{*}` argument
            // expansion, so a word-initial `{*}` is a complete braced
            // word like any other: `puts {*}$args` is Eagle's "extra
            // characters after close-brace" error, and is reported as
            // such here (verified against the Eagle shell).
            wordPos = AFTER_CLOSE;
            lastClose = 'brace';
          }
        }
        continue;
      }
      if (inString) {
        if (ch === '"') {
          inString = false;
          stringStart = null;
          wordPos = AFTER_CLOSE;
          lastClose = 'quote';
        } else if (ch === '[') {
          // Command substitution stays active inside double quotes; the
          // string resumes after the matching close bracket.
          bracketStack.push([l, c, true, stringStart]);
          inString = false;
          stringStart = null;
          wordPos = COMMAND_START;
        } else if (ch === '$' && c + 1 < line.length && line[c + 1] === '{') {
          // Braced variable names substitute inside quotes too.
          varNameStart = [l, c + 1, true];
          c++;
        }
        continue;
      }
      if (ch === '#') {
        if (wordPos === COMMAND_START) {
          if (endsInLineContinuation(line)) inComment = true;
          break; // comment: the rest of the line is ignored
        }
        if (wordPos === AFTER_CLOSE) extraChars(l, c);
        else wordPos = IN_WORD; // ordinary word character
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v') {
        // Whitespace ends the current word but does not leave command
        // position.
        if (wordPos !== COMMAND_START) wordPos = WORD_START;
        continue;
      }
      if (ch === ';') {
        wordPos = COMMAND_START;
        continue;
      }
      if (ch === '$') {
        if (wordPos === AFTER_CLOSE) extraChars(l, c);
        else wordPos = IN_WORD;
        if (c + 1 < line.length && line[c + 1] === '{') {
          varNameStart = [l, c + 1, false];
          c++; // consume the '{' so the variable-name branch owns it
        }
        continue;
      }
      if (ch === '"') {
        if (wordPos === COMMAND_START || wordPos === WORD_START) {
          inString = true;
          stringStart = [l, c];
          wordPos = IN_WORD;
        } else if (wordPos === AFTER_CLOSE) {
          extraChars(l, c);
          inString = true; // recover by scanning the quoted text anyway
          stringStart = [l, c];
        } else {
          wordPos = IN_WORD; // mid-word quote is literal
        }
        continue;
      }
      if (ch === '{') {
        if (wordPos === COMMAND_START || wordPos === WORD_START) {
          braceStack.push([l, c]);
          wordPos = IN_WORD;
        } else if (wordPos === AFTER_CLOSE) {
          extraChars(l, c);
        } else {
          wordPos = IN_WORD; // mid-word brace is literal
        }
        continue;
      }
      if (ch === '}') {
        if (wordPos === COMMAND_START) {
          // A '}' cannot be a command name ("invalid command name").
          report('Unmatched closing brace', l, c);
          wordPos = IN_WORD;
        } else if (wordPos === AFTER_CLOSE) {
          extraChars(l, c);
        } else {
          wordPos = IN_WORD; // stray '}' in or at the start of a word is literal
        }
        continue;
      }
      if (ch === '[') {
        // Command substitution starts anywhere in a word...
        if (wordPos === AFTER_CLOSE) extraChars(l, c);
        bracketStack.push([l, c, false, null]);
        wordPos = COMMAND_START; // ...and a new command begins inside it
        continue;
      }
      if (ch === ']') {
        if (bracketStack.length > 0) {
          const entry = bracketStack.pop();
          if (entry[2]) {
            // This bracket suspended a double-quoted string: resume it.
            inString = true;
            stringStart = entry[3];
          } else {
            wordPos = IN_WORD; // the enclosing word continues: `a[cmd]b`
          }
        } else if (wordPos === COMMAND_START) {
          report('Unmatched closing bracket', l, c);
          wordPos = IN_WORD;
        } else if (wordPos === AFTER_CLOSE) {
          extraChars(l, c);
        } else {
          wordPos = IN_WORD; // stray ']' in a word is literal
        }
        continue;
      }
      // Every remaining character is ordinary word content.
      if (wordPos === AFTER_CLOSE) extraChars(l, c);
      else wordPos = IN_WORD;
    }
  }

  for (const [l, c] of braceStack) report('Unclosed opening brace', l, c);
  for (const [l, c, fromString, sStart] of bracketStack) {
    report('Unclosed opening bracket', l, c);
    if (fromString && sStart) {
      report('Unclosed double quote', sStart[0], sStart[1]);
    }
  }
  if (inString && stringStart) {
    report('Unclosed double quote', stringStart[0], stringStart[1]);
  }
  if (varNameStart !== null) {
    report('Missing close-brace for variable name', varNameStart[0], varNameStart[1]);
  }
  return { diagnostics, lineStates };
}

/**
 * Back-compat wrapper around `scanDocument` returning only the
 * diagnostics array -- the shape `validateDocument` historically used
 * and the unit tests exercise.
 *
 * @param {string} text - Full document text.
 * @param {{Error: number}} DiagnosticSeverity - Severity enum.
 * @returns {Array<object>} LSP diagnostic objects, possibly empty.
 */
function scanBraces(text, DiagnosticSeverity) {
  return scanDocument(text, DiagnosticSeverity).diagnostics;
}

module.exports = {
  scanBraces, scanDocument, endsInLineContinuation, MAX_DIAGNOSTICS,
};
