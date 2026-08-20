/**
 * Basic Eagle/Tcl parser for LSP features.
 * Provides: tokenization, word-at-position, command-at-position, brace matching, etc.
 */
'use strict';

const { endsInLineContinuation, scanDocument, normalizeLineEndings } =
  require('./eagle-brace');

/**
 * Token types emitted by the scanner.
 */
const TokenType = {
  COMMAND: 'command',
  WORD: 'word',
  STRING: 'string',
  BRACE_STRING: 'brace_string',
  VARIABLE: 'variable',
  COMMENT: 'comment',
  OPTION: 'option',
  NEWLINE: 'newline',
  SEMICOLON: 'semicolon',
  BRACKET_OPEN: 'bracket_open',
  BRACKET_CLOSE: 'bracket_close',
};

/**
 * Tokenize a single physical line of Eagle/Tcl source.
 *
 * This is the lexical workhorse of the parser.  It walks the input one
 * character at a time and emits a stream of tokens that downstream stages
 * (parseDocument, getCommandContext, findVariables, etc.) consume to
 * implement LSP features such as completion, hover, and signature help.  It
 * exists because the LSP needs a fast, dependency-free recognizer that
 * understands the Eagle/Tcl word, quoting, substitution, and command-
 * separator rules well enough for editor-grade analysis -- not a full
 * evaluator, but more than a regex-based highlighter.
 *
 * How it works: a manual index "i" scans "line" until exhausted.  At each
 * step, leading horizontal whitespace is skipped and the next character is
 * dispatched to one of several recognizers: comment, semicolon (command
 * separator), variable reference, double-quoted string, brace-quoted
 * string, command substitution brackets, a standalone closing brace, or
 * bare word.  Each recognizer advances "i" past the lexeme it consumed and
 * appends a token object of the form { type, text, start, end }.
 *
 * Tricky details:
 *   - Comments are only recognized when the "#" is in command-leading
 *     position -- at the very start of the line (unless continued), or
 *     immediately after a NEWLINE, SEMICOLON, or BRACKET_OPEN token --
 *     because in Eagle/Tcl "#" is only a comment introducer where a
 *     command is expected.
 *   - Variable scanning handles three shapes: braced names "${name}",
 *     fully-qualified names beginning with "$::", and plain names possibly
 *     followed by an "$arr(index)" array element subscript; the subscript
 *     scanner tracks parenthesis depth so nested parens inside the index do
 *     not terminate it prematurely.
 *   - Double-quoted strings honour backslash escapes by skipping the
 *     character after a backslash; the loop tolerates an unterminated
 *     string by stopping at end of line.
 *   - Brace strings track nesting depth so embedded balanced braces do not
 *     close the outer brace; an opening or closing brace immediately
 *     preceded by a backslash is treated as literal and does not affect
 *     depth, matching Eagle/Tcl quoting rules.
 *   - "[" and "]" are emitted as their own BRACKET_OPEN / BRACKET_CLOSE
 *     tokens rather than being parsed as nested commands here; higher-
 *     level passes use them to reset command context.
 *   - Braces and double quotes are special only at WORD START, exactly
 *     as in eagle-brace.js: mid-word they are ordinary characters, so
 *     "prefix{suffix", "a}b", and 'a"b' each tokenize as one WORD, and
 *     a stray "}" at word start becomes a WORD token ("}" or "}x").
 *   - The bare-word recognizer stops only at whitespace, ";", "[", and
 *     "]", and honours backslash escapes; a word starting with "-" and
 *     longer than one character is reclassified as an OPTION token so
 *     option-aware completion can use it.
 *   - A safety fallback advances "i" if no recognizer consumed any input,
 *     guaranteeing forward progress on pathological characters.
 *
 * Use cases: called once per line by parseDocument, and again on a
 * left-trimmed prefix of the cursor's line by getCommandContext to figure
 * out which command and which argument index the user is editing.
 *
 * @param {string} line - One line of Eagle/Tcl source, without a trailing
 *   newline.  The caller is responsible for splitting multi-line input.
 * @param {{continuedFromPreviousLine?: boolean}} [opts] - When
 *   "continuedFromPreviousLine" is true, the line begins mid-command
 *   (the previous line ended in a backslash continuation), so a leading
 *   "#" is an ordinary word -- e.g. "puts \" then "#0" -- rather than a
 *   comment.  Omitted by prefix-tokenizing callers, which treat the line
 *   as a fresh command.
 * @returns {Array<{type: string, text: string, start: number, end: number}>}
 *   An array of token records in left-to-right order.  "start" and "end"
 *   are byte offsets within "line"; an empty input yields an empty array.
 */
function tokenizeLine(line, opts) {
  const tokens = [];
  let i = 0;
  const len = line.length;

  /**
   * Advance the shared scan index past any run of spaces and tabs.
   *
   * Closes over the enclosing tokenizer's "i", "line", and "len" so that
   * each recognizer can call it without threading state.  It only consumes
   * horizontal whitespace; newlines do not occur because tokenizeLine
   * operates on a single already-split line.
   *
   * @returns {void} Mutates the enclosing scope's "i" in place.
   */
  function skipWhitespace() {
    // Matches Parser.cs's Space character class: tab, vertical tab,
    // form feed, carriage return, and space (newlines never occur here
    // because tokenizeLine operates on a single already-split line).
    while (i < len && (line[i] === ' ' || line[i] === '\t' ||
           line[i] === '\v' || line[i] === '\f' || line[i] === '\r')) i++;
  }

  while (i < len) {
    skipWhitespace();
    if (i >= len) break;
    const ch = line[i];

    // Comment (only at start of command: line start -- unless the line is
    // a continuation of the previous one -- or right after ";" or "[").
    // This mirrors the command-position rule in eagle-brace.js so the two
    // diagnostic passes agree on what a comment is.
    if (ch === '#' &&
        ((tokens.length === 0 && !(opts && opts.continuedFromPreviousLine)) ||
         (tokens.length > 0 && (tokens[tokens.length-1].type === TokenType.NEWLINE ||
                                tokens[tokens.length-1].type === TokenType.SEMICOLON ||
                                tokens[tokens.length-1].type === TokenType.BRACKET_OPEN)))) {
      tokens.push({ type: TokenType.COMMENT, text: line.slice(i), start: i, end: len });
      i = len;
      continue;
    }

    // Semicolon - command separator
    if (ch === ';') {
      tokens.push({ type: TokenType.SEMICOLON, text: ';', start: i, end: i + 1 });
      i++;
      continue;
    }

    // Variable reference
    if (ch === '$') {
      const start = i;
      i++;
      if (i < len && line[i] === '{') {
        // ${varName}
        i++;
        while (i < len && line[i] !== '}') i++;
        if (i < len) i++;
      } else if (i < len && line[i] === ':') {
        // $::namespace::var
        while (i < len && /[a-zA-Z0-9_:]/.test(line[i])) i++;
      } else {
        while (i < len && /[a-zA-Z0-9_]/.test(line[i])) i++;
        // Handle array element $arr(index)
        if (i < len && line[i] === '(') {
          let depth = 1;
          i++;
          while (i < len && depth > 0) {
            if (line[i] === '(') depth++;
            else if (line[i] === ')') depth--;
            i++;
          }
        }
      }
      tokens.push({ type: TokenType.VARIABLE, text: line.slice(start, i), start, end: i });
      continue;
    }

    // Quoted string
    if (ch === '"') {
      const start = i;
      i++;
      while (i < len && line[i] !== '"') {
        if (line[i] === '\\') i++; // skip escape
        i++;
      }
      if (i < len) i++; // closing quote
      tokens.push({ type: TokenType.STRING, text: line.slice(start, i), start, end: i });
      continue;
    }

    // Braced string.  Escapes are consumed forward (`\{`, `\}`, and the
    // pair `\\` never affect the depth), matching eagle-brace.js -- the
    // old backward peek at `line[i-1]` misread `\\}` as an escaped brace.
    if (ch === '{') {
      const start = i;
      let depth = 1;
      i++;
      while (i < len && depth > 0) {
        const cch = line[i];
        if (cch === '\\') { i += 2; continue; }
        if (cch === '{') depth++;
        else if (cch === '}') depth--;
        i++;
      }
      if (i > len) i = len; // trailing escape may overshoot the line
      tokens.push({ type: TokenType.BRACE_STRING, text: line.slice(start, i), start, end: i });
      continue;
    }

    // Command substitution bracket
    if (ch === '[') {
      tokens.push({ type: TokenType.BRACKET_OPEN, text: '[', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === ']') {
      tokens.push({ type: TokenType.BRACKET_CLOSE, text: ']', start: i, end: i + 1 });
      i++;
      continue;
    }

    // Bare word (command name, option, etc.).  A stray `}` at word
    // start falls in here too and yields a WORD token (`}` alone, or
    // `}x` as one word), matching the scanner's literal treatment.  Only whitespace, `;`,
    // and the substitution brackets `[` / `]` end a bare word: braces
    // and double quotes are ORDINARY characters mid-word in Eagle/Tcl
    // (`prefix{suffix`, `a}b`, `a"b` are each one word), exactly as the
    // brace scanner treats them.  Braces/quotes group only at word
    // start, which the recognizers above have already claimed.
    const start = i;
    while (i < len && line[i] !== ' ' && line[i] !== '\t' &&
           line[i] !== '\v' && line[i] !== '\f' && line[i] !== '\r' &&
           line[i] !== ';' && line[i] !== '\n' &&
           line[i] !== '[' && line[i] !== ']') {
      if (line[i] === '\\') i++; // skip escape
      i++;
    }
    if (i === start) { i++; continue; } // safety: skip unrecognized character
    const text = line.slice(start, i);
    let type = TokenType.WORD;
    if (text.startsWith('-') && text.length > 1) type = TokenType.OPTION;
    tokens.push({ type, text, start, end: i });
  }

  return tokens;
}

/**
 * Parse an entire document into a flat list of command invocations.
 *
 * This is the second stage of the analyzer: it takes raw source text,
 * splits it into lines, runs tokenizeLine over each, and then groups the
 * resulting tokens into one record per Eagle/Tcl command call.  It exists
 * so higher-level features (variable discovery, procedure discovery,
 * cursor-context lookup) can iterate over commands rather than re-deriving
 * structure from tokens.
 *
 * How it works: a small state machine tracks the command currently being
 * accumulated.  For each line it remembers whether the previous line ended
 * with an unescaped trailing "\\" (line continuation, per the shared
 * endsInLineContinuation helper); if so, this line's tokens are
 * appended to the in-progress command instead of starting a new one.
 * Otherwise the previous command (if any) is flushed and a fresh scan of
 * the line begins.  Within a non-continuation line, semicolons split
 * multiple commands and the first WORD or COMMAND token after each split
 * becomes the new command name with subsequent non-comment tokens
 * accumulated as its arguments.
 *
 * Tricky details:
 *   - Line-continuation detection is purely textual: the trimmed line ends
 *     with "\\".  The trailing backslash token itself remains in the
 *     accumulated args because tokenizeLine treats it as part of a bare
 *     word; consumers tolerate this.
 *   - Comments are dropped during accumulation so they do not appear as
 *     arguments.
 *   - Empty lines flush any in-progress command unless the previous line
 *     requested continuation, in which case the empty line is silently
 *     skipped.
 *   - "cmdStart" is reset after every semicolon so the next non-comment
 *     WORD/COMMAND token becomes the command name; tokens encountered
 *     before any command name (for example, a stray STRING at start of
 *     line) are quietly ignored.
 *   - A final flush after the loop ensures the last command in the file is
 *     emitted even when there is no trailing newline.
 *   - Each argument token has its originating line number attached via
 *     spread + "line: lineNum" so callers can map results back to document
 *     positions.
 *
 * Use cases: invoked by findVariables, findProcedures, and any LSP feature
 * that needs a per-command view of the document; safe to call repeatedly,
 * but the caller is expected to cache the result when feasible.
 *
 * @param {string} text - Full document text, with "\n" as the line
 *   separator.  CRLF inputs work but will leave a trailing "\r" in each
 *   line's tokens.
 * @returns {Array<{line: number, commandName: string, args: Array<Object>,
 *   commandToken: Object}>} One record per command invocation.  "line" is
 *   the zero-based line where the command name appeared, "args" is the
 *   ordered list of argument tokens (with an added "line" field), and
 *   "commandToken" is the token that contributed the command name.  An
 *   empty document yields an empty array.
 */
function parseDocument(text) {
  text = normalizeLineEndings(text); // as the Engine does before parsing
  const lines = text.split('\n');
  const commands = [];
  let continuation = false;
  let currentArgs = [];
  let currentCmdName = null;
  let currentCmdLine = 0;
  let currentCmdToken = null;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];

    // Check for line continuation.  The shared helper is escape-parity
    // aware (`C:\\` does not continue; `a\\\` does) and CRLF-tolerant,
    // and it is the same rule the brace scanner uses.
    const isContinuation = continuation;
    continuation = endsInLineContinuation(line);

    const tokens = tokenizeLine(line, { continuedFromPreviousLine: isContinuation });
    if (tokens.length === 0) {
      if (isContinuation) continue;
      // Flush current command
      if (currentCmdName) {
        commands.push({ line: currentCmdLine, commandName: currentCmdName, args: currentArgs, commandToken: currentCmdToken });
        currentCmdName = null;
        currentArgs = [];
      }
      continue;
    }

    // If continuing a previous line, add tokens as args
    if (isContinuation) {
      for (const tok of tokens) {
        if (tok.type !== TokenType.COMMENT) {
          currentArgs.push({ ...tok, line: lineNum });
        }
      }
      continue;
    }

    // Flush previous command
    if (currentCmdName) {
      commands.push({ line: currentCmdLine, commandName: currentCmdName, args: currentArgs, commandToken: currentCmdToken });
      currentCmdName = null;
      currentArgs = [];
    }

    // Process tokens - split on semicolons for multiple commands per line
    let cmdStart = true;
    for (const tok of tokens) {
      if (tok.type === TokenType.COMMENT) continue;
      if (tok.type === TokenType.SEMICOLON) {
        if (currentCmdName) {
          commands.push({ line: lineNum, commandName: currentCmdName, args: currentArgs, commandToken: currentCmdToken });
          currentCmdName = null;
          currentArgs = [];
        }
        cmdStart = true;
        continue;
      }
      if (cmdStart && (tok.type === TokenType.WORD || tok.type === TokenType.COMMAND)) {
        currentCmdName = tok.text;
        currentCmdLine = lineNum;
        currentCmdToken = { ...tok, line: lineNum };
        currentArgs = [];
        cmdStart = false;
      } else if (currentCmdName) {
        currentArgs.push({ ...tok, line: lineNum });
      }
    }
  }

  // Flush last command
  if (currentCmdName) {
    commands.push({ line: currentCmdLine, commandName: currentCmdName, args: currentArgs, commandToken: currentCmdToken });
  }

  return commands;
}

/**
 * Extract the identifier-like word straddling a cursor position.
 *
 * This helper answers the question "what word is the user pointing at?",
 * which is the foundation of hover, go-to-definition, and prefix-based
 * completion.  It deliberately uses a broader character class than a strict
 * Tcl identifier so that the returned word can include namespace
 * separators, dots, the leading "$" of a variable reference, and the
 * leading "-" of an option, all of which the LSP wants to recognize as a
 * single unit.
 *
 * How it works: starting at "character", it expands left while the
 * preceding character matches the identifier class, then expands right
 * while the current character matches.  The slice between the resulting
 * bounds is returned together with those bounds.
 *
 * Tricky details:
 *   - The character class is [a-zA-Z0-9_:.$-]; embedded ":" supports
 *     namespace-qualified names like "::Eagle::foo", "." supports things
 *     like decimal numbers or method-style names, "$" allows the leading
 *     sigil of a variable reference to be captured, and "-" allows option
 *     names like "-nocase" to be captured intact.
 *   - When the cursor sits between two non-identifier characters, both
 *     expansions are no-ops and an empty word with start == end == character
 *     is returned; callers should treat this as "no word here".
 *   - Whitespace, brackets, braces, and quotes terminate the word, so
 *     structural boundaries are respected without parsing.
 *
 * Use cases: called from hover and definition handlers to learn what the
 * user is over, and from completion to derive an initial prefix when the
 * caller does not already have a tokenization handy.
 *
 * @param {string} line - The text of the line containing the cursor.
 * @param {number} character - Zero-based column of the cursor within "line".
 * @returns {{word: string, start: number, end: number}} The extracted word
 *   text and its half-open [start, end) range within "line".
 */
function getWordAtPosition(line, character) {
  // Expand left
  let start = character;
  while (start > 0 && /[a-zA-Z0-9_:.$-]/.test(line[start - 1])) start--;
  // Expand right
  let end = character;
  while (end < line.length && /[a-zA-Z0-9_:.$-]/.test(line[end])) end++;
  return { word: line.slice(start, end), start, end };
}

/**
 * Determine which command, argument index, and partial prefix the cursor
 * is inside.
 *
 * This is the core context-resolution routine used by completion and
 * signature-help.  Given the line up to and including the cursor, it
 * figures out the surrounding command call so the LSP can decide things
 * like "the user is typing the second argument of [string ...] -- offer
 * subcommands" or "the user is in command-name position -- offer all
 * commands".  It exists because both completion ranking and option/
 * subcommand awareness depend critically on knowing argIndex and on
 * recognizing that a "[" starts a nested command context.
 *
 * How it works: the prefix of the line up to "character" is tokenized
 * fresh, then the tokens are scanned from right to left for the most
 * recent command boundary -- a SEMICOLON or a BRACKET_OPEN -- and the
 * tokens after that boundary become the "current command" slice (with
 * COMMENT tokens filtered out).  The first token in that slice supplies
 * the command name; remaining tokens are argument tokens.  Finally the
 * cursor's relationship to the last token is examined: if the cursor sits
 * past the end of the last token, the user is starting a new argument and
 * argIndex is the count of tokens; otherwise the cursor is still inside
 * the last token, and that token's text becomes the completion "prefix".
 *
 * Tricky details:
 *   - SEMICOLON and BRACKET_OPEN both reset context, mirroring how
 *     Eagle/Tcl evaluates "[...]" as a separate command.  A "]" does not
 *     reset context here because the cursor inside an unclosed "[" still
 *     belongs to the bracketed command.
 *   - The returned commandName is null when effectiveArgIndex is 0 (the
 *     cursor itself is the command-name slot) so callers know to offer
 *     command completion rather than argument completion.
 *   - "isSubcommandPosition" is a hint set to true when argIndex is 1,
 *     matching the common Eagle/Tcl pattern of "command subcommand args";
 *     it does not consult the command's metadata, so callers must still
 *     check that the command actually accepts subcommands.
 *   - "isCommandPosition" is true exactly when the cursor is in the
 *     command-name slot, regardless of whether any prefix has been typed.
 *   - Comments inside the line prefix are filtered out before indexing, so
 *     a "#" on a continuation line would skew nothing (and in practice
 *     comments cannot appear mid-command).
 *
 * Use cases: called from the LSP completion handler on every keystroke
 * inside an editable buffer; the returned record drives the choice of
 * completion items, their filtering by "prefix", and signature-help index.
 *
 * @param {string} line - The text of the line containing the cursor.
 * @param {number} character - Zero-based column of the cursor within "line";
 *   the function looks only at "line.slice(0, character)".
 * @returns {{commandName: (string|null), argIndex: number,
 *   isSubcommandPosition: boolean, prefix: string,
 *   isCommandPosition?: boolean, tokens?: Array<Object>}}
 *   A description of where the cursor sits.  When no command has begun on
 *   the current segment, "commandName" is null, "argIndex" is 0, and
 *   "prefix" is the empty string.
 */
function getCommandContext(line, character) {
  const tokens = tokenizeLine(line.slice(0, character));
  if (tokens.length === 0) return { commandName: null, argIndex: 0, isSubcommandPosition: false, prefix: '' };

  // Find the last command boundary (semicolons, brackets reset context)
  let cmdStartIdx = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].type === TokenType.SEMICOLON || tokens[i].type === TokenType.BRACKET_OPEN) {
      cmdStartIdx = i + 1;
      break;
    }
  }

  const cmdTokens = tokens.slice(cmdStartIdx).filter(t => t.type !== TokenType.COMMENT);
  if (cmdTokens.length === 0) return { commandName: null, argIndex: 0, isSubcommandPosition: false, prefix: '' };

  const commandName = cmdTokens[0].text;
  const argIndex = cmdTokens.length - 1; // 0 = command itself, 1 = first arg, etc.

  // Check if cursor is right after the last token or in whitespace
  const lastTok = cmdTokens[cmdTokens.length - 1];
  const isAfterSpace = character > lastTok.end;
  const effectiveArgIndex = isAfterSpace ? cmdTokens.length : cmdTokens.length - 1;

  // Get the prefix (partial word being typed)
  let prefix = '';
  if (!isAfterSpace && cmdTokens.length > 0) {
    prefix = lastTok.text;
  }

  return {
    commandName: effectiveArgIndex === 0 ? null : commandName,
    argIndex: effectiveArgIndex,
    isSubcommandPosition: effectiveArgIndex === 1,
    prefix,
    isCommandPosition: effectiveArgIndex === 0,
    tokens: cmdTokens
  };
}

/**
 * Discover variable and procedure names defined in a document.
 *
 * This routine scans the document for commands that introduce or refer to
 * named entities -- "set", "variable", "global", "upvar", "foreach",
 * "lassign", "append", "lappend", "incr", plus "proc" -- and records the
 * first occurrence of each name.  It exists to power workspace symbol
 * lookup and identifier-aware completion, letting the LSP suggest
 * variables that the user has already introduced even when no static type
 * information is available.
 *
 * How it works: parseDocument turns the text into a flat command list, then
 * each command whose name is in the "variable-defining" set contributes
 * its first argument as a candidate variable name.  Candidates are
 * filtered to exclude options ("-..."), brace-quoted words, and quoted
 * strings, since those are never plain identifiers.  A Map keyed by name
 * ensures only the first definition of each variable is kept, mirroring
 * the intuition that the introducing site is the most useful one.  The
 * "proc" branch records the procedure name itself (not its parameters) and
 * marks the entry with "isProc: true" so consumers can distinguish it.
 *
 * Tricky details:
 *   - "foreach" with multiple loop variables only captures the first
 *     variable name; this is a deliberate simplification since the LSP
 *     mostly needs to surface "is this a known name?" rather than full
 *     binding information.
 *   - "upvar" and "global" record the local alias names verbatim, even
 *     though their first argument might be a level number in the "upvar
 *     LEVEL name ..." form -- treating an integer literal as a name does
 *     no harm because it will not collide with later real identifiers.
 *   - The filter on leading "{" and "\"" prevents accidentally treating a
 *     braced expression or quoted literal as a variable; leading "-"
 *     guards against capturing an option flag.
 *   - The first-write-wins rule for variables does not apply to procs:
 *     proc entries always overwrite (via "set"), so redefinitions show the
 *     latest location.
 *
 * Use cases: feeds completion item lists, document-symbol responses, and
 * "go to definition" for non-builtin names.
 *
 * @param {string} text - Full document text to analyze.
 * @returns {Map<string, {name: string, line: number, command: string,
 *   isProc?: boolean}>} A map from name to a descriptor recording where it
 *   was introduced and by which command.  Empty when nothing matched.
 */
function findVariables(text) {
  const cmds = parseDocument(text);
  const vars = new Map();
  const varDefCommands = new Set(['set', 'variable', 'global', 'upvar', 'foreach', 'lassign', 'append', 'lappend', 'incr']);

  for (const cmd of cmds) {
    if (varDefCommands.has(cmd.commandName) && cmd.args.length > 0) {
      const varName = cmd.args[0].text;
      if (varName && !varName.startsWith('-') && !varName.startsWith('{') && !varName.startsWith('"')) {
        if (!vars.has(varName)) {
          vars.set(varName, { name: varName, line: cmd.line, command: cmd.commandName });
        }
      }
    }
    // proc definitions - extract arg names
    if (cmd.commandName === 'proc' && cmd.args.length >= 2) {
      const procName = cmd.args[0].text;
      vars.set(procName, { name: procName, line: cmd.line, command: 'proc', isProc: true });
    }
  }

  return vars;
}

/**
 * Discover user-defined procedure declarations in a document.
 *
 * This routine returns one entry per "proc" or "nproc" declaration found
 * in the document, including the procedure name, the literal parameter
 * list (with surrounding braces stripped), and the line on which the
 * declaration begins.  It exists so the LSP can populate document outlines,
 * provide signature help for user-defined procedures, and resolve
 * go-to-definition requests targeting them.
 *
 * How it works: parseDocument flattens the source into commands; for each
 * command whose name is "proc" or "nproc" and which has at least two
 * arguments (a name and an argument list), the first argument is captured
 * as the procedure name and the second argument's text is captured as the
 * parameter list.  If the parameter list is enclosed in matching braces
 * (the common case for "proc name {a b c} { ... }"), those braces are
 * stripped so callers receive just the parameter content.
 *
 * Tricky details:
 *   - Both "proc" (Tcl style) and "nproc" (Eagle's "named proc" variant)
 *     are recognized; only those exact head words trigger a match.
 *   - The argument list's brace stripping is purely textual -- it requires
 *     the text to start with "{" and end with "}".  Lists supplied via
 *     other quoting forms (a bare word for an empty list, or a substituted
 *     "[list a b]") are passed through untouched.
 *   - The procedure body argument is intentionally ignored; only the
 *     signature is captured here.  Body analysis happens elsewhere.
 *   - The result preserves declaration order, so callers can present
 *     symbols in source order without resorting.
 *
 * Use cases: used by document-symbols, outline view, and signature help
 * for user-defined procedures.
 *
 * @param {string} text - Full document text to analyze.
 * @returns {Array<{name: string, args: string, line: number}>} One record
 *   per "proc" or "nproc" declaration, in source order.  "args" is the
 *   raw parameter-list text with outer braces removed when present.
 */
function findProcedures(text) {
  const cmds = parseDocument(text);
  const procs = [];
  for (const cmd of cmds) {
    if ((cmd.commandName === 'proc' || cmd.commandName === 'nproc') && cmd.args.length >= 2) {
      const name = cmd.args[0].text;
      let argsText = cmd.args[1].text || '';
      // Strip braces
      if (argsText.startsWith('{') && argsText.endsWith('}')) {
        argsText = argsText.slice(1, -1);
      }
      procs.push({ name, args: argsText, line: cmd.line });
    }
  }
  return procs;
}

/**
 * Locate the bracket, brace, or parenthesis that matches the one at a
 * given document position.
 *
 * This is the bracket-matching primitive used by the editor's
 * "highlight matching bracket" and "jump to matching bracket" features.
 * It exists because Eagle/Tcl source mixes three pair kinds -- "{}",
 * "[]", and "()" -- and the LSP needs a single uniform way to ask
 * "where does this group end (or begin)?".
 *
 * How it works: the document is split into lines so the search can be
 * driven by (line, character) pairs.  The character under the cursor is
 * looked up in a pairs table; if it is not a recognized bracket, null is
 * returned.  Opening brackets ("{", "[", "(") trigger a forward scan;
 * closing brackets ("}", "]", ")") trigger a backward scan.  A depth
 * counter increments on each occurrence of the same-direction bracket
 * and decrements on each occurrence of the matching one; when depth
 * returns to zero, the current position is the match.
 *
 * Tricky details:
 *   - The scan deliberately treats brackets purely textually -- it does
 *     not honour Eagle/Tcl quoting rules.  This means a bracket inside a
 *     string literal or after a backslash will still affect depth.  This
 *     is acceptable for an interactive matcher because it matches editor
 *     intuition; a stricter version would require running the full
 *     tokenizer over each line.
 *   - The forward scan starts at the cursor itself (which provides the
 *     initial depth-bump from depth 0 to 1) and walks to end of file; the
 *     backward scan does the symmetric thing from the cursor toward the
 *     beginning of the file.
 *   - On a line other than the starting line, the inner loop begins at
 *     column 0 (forward) or at the last column (backward), avoiding the
 *     need to track per-line offsets.
 *   - When no match exists -- for example, an unbalanced source file --
 *     null is returned so the caller can simply not highlight anything.
 *
 * Use cases: invoked by the LSP's document-highlight handler and any
 * navigation command that needs to jump between paired brackets.
 *
 * @param {string} text - Full document text.
 * @param {number} line - Zero-based line containing the bracket to match.
 * @param {number} character - Zero-based column of the bracket within that
 *   line.  The character at this position must be one of "{", "}", "[",
 *   "]", "(", or ")" for the search to begin.
 * @returns {({line: number, character: number}|null)} The position of the
 *   matching bracket, or null if the cursor is not on a bracket or no
 *   match was found before the end (or beginning) of the document.
 */
function findMatchingBrace(text, line, character) {
  text = normalizeLineEndings(text); // as the Engine does before parsing
  const lines = text.split('\n');
  if (line >= lines.length) return null;
  const ch = lines[line][character];
  const pairs = { '{': '}', '}': '{', '[': ']', ']': '[', '(': ')', ')': '(' };
  const match = pairs[ch];
  if (!match) return null;

  const forward = ch === '{' || ch === '[' || ch === '(';
  let depth = 0;
  if (forward) {
    for (let l = line; l < lines.length; l++) {
      const startC = (l === line) ? character : 0;
      for (let c = startC; c < lines[l].length; c++) {
        const cur = lines[l][c];
        if (cur === ch) depth++;
        else if (cur === match) { depth--; if (depth === 0) return { line: l, character: c }; }
      }
    }
  } else {
    for (let l = line; l >= 0; l--) {
      const startC = (l === line) ? character : lines[l].length - 1;
      for (let c = startC; c >= 0; c--) {
        const cur = lines[l][c];
        if (cur === ch) depth++;
        else if (cur === match) { depth--; if (depth === 0) return { line: l, character: c }; }
      }
    }
  }
  return null;
}

/**
 * Commands whose braced argument(s) are SCRIPTS: their multiline braced
 * words contain commands, so per-line analysis (and unknown-command
 * hints) inside them is meaningful.  Any command NOT in this set is
 * assumed to take braced arguments as DATA (`set colors {...}`,
 * `list`, `switch` patterns, `test2 -body` scripts, ...), where the
 * interior lines are not command invocations.
 *
 * Deliberate choices: `switch` is omitted because the immediate lines of
 * its braced argument are patterns, not commands (its arm bodies are
 * nested braced words owned by the pattern, which is likewise not in
 * this set); unknown/user commands default to data because a wrong
 * "Unknown command" hint is worse than a missing one.  Limitation: for
 * commands taking both list and script arguments (`foreach {v} {list}
 * {body}`), every multiline braced argument is treated as script.
 */
const SCRIPT_BODY_COMMANDS = new Set([
  'proc', 'if', 'while', 'for', 'foreach', 'lmap', 'do', 'catch', 'try',
  'eval', 'uplevel', 'apply', 'namespace', 'time', 'after', 'interp',
]);

/**
 * Classify which lines of `text` are the INTERIOR of a multiline word
 * rather than fresh commands, so the unknown-command pass can skip them.
 *
 * A line is a data-word line when, at its start, the scanner says it is
 * (a) inside a multiline double-quoted word (`set x "hello\nworld"` --
 * always data), or (b) inside a braced word whose owning command is not
 * one of the SCRIPT_BODY_COMMANDS above.  The owning command is the last
 * command record on or before the line where the innermost still-open
 * `{` appeared -- so in `proc p {} { set colors { red } }` spread over
 * lines, the `red` line is owned by `set` (data, suppressed) while the
 * `set colors {` line itself is owned by `proc` (script, analyzed).
 *
 * How it works: `scanDocument` (the brace scanner, the single source of
 * truth for cross-line lexical state) supplies each line's start-of-line
 * context; one pass over `commands` builds a last-command-per-line
 * index; each line's owner is then resolved and tested against the
 * script-command set.
 *
 * @param {string} text - Full document text.
 * @param {Array<{line: number, commandName: string}>} commands - The
 *   command records from `parseDocument(text)` (passed in so callers
 *   that already parsed the document do not parse it twice).
 * @param {Array<object>} [lineStates] - Optional precomputed per-line
 *   states from `scanDocument(text)`; pass them when the caller has
 *   already scanned the document (as `validateDocument` has, for pass
 *   one) to avoid a second scan.
 * @returns {Set<number>} Zero-based line numbers whose content is data.
 */
function getDataWordLines(text, commands, lineStates) {
  if (!lineStates) {
    lineStates = scanDocument(text, { Error: 1 }).lineStates;
  }
  const dataLines = new Set();

  // lastCmdName[l] = name of the last command that started on or before
  // line l (null before the first command).
  const cmdAtLine = new Map();
  for (const cmd of commands) {
    if (cmd.commandName) cmdAtLine.set(cmd.line, cmd.commandName);
  }
  const lastCmdName = new Array(lineStates.length);
  let carry = null;
  for (let l = 0; l < lineStates.length; l++) {
    if (cmdAtLine.has(l)) carry = cmdAtLine.get(l);
    lastCmdName[l] = carry;
  }

  for (let l = 0; l < lineStates.length; l++) {
    const state = lineStates[l];
    if (state.inString) {
      dataLines.add(l); // multiline quoted words are always data
      continue;
    }
    if (state.braceOpener) {
      const owner = lastCmdName[state.braceOpener[0]];
      if (owner === null || !SCRIPT_BODY_COMMANDS.has(owner)) {
        dataLines.add(l);
      }
    }
  }
  return dataLines;
}

/**
 * Compute the foldable regions of `text` for the LSP
 * `textDocument/foldingRange` provider.
 *
 * Two kinds of region are produced, both derived from the brace
 * scanner's single lexical model (`scanDocument`) rather than a private
 * character scan, so quoting rules apply everywhere:
 *
 *   - Every braced word spanning more than one line becomes a 'region'
 *     fold from its opening line to its closing line.  Braces inside
 *     double-quoted strings, comments, or escapes never count.
 *   - Every run of two or more consecutive comment lines becomes a
 *     'comment' fold.  "Comment line" means the scanner recognized a
 *     comment there (command position honoured): a line whose `#` is
 *     actually word content (`puts \` then `#0`) or braced-word data is
 *     NOT a comment line.  The trailing lines of a backslash-continued
 *     comment are part of the run.
 *
 * @param {string} text - Full document text.
 * @returns {Array<{startLine: number, endLine: number,
 *   kind: string}>} Folding ranges with kind 'region' or 'comment';
 *   the caller maps kinds onto its protocol constants.
 */
function computeFoldingRanges(text) {
  const { lineStates, foldingRanges } = scanDocument(text, { Error: 1 });
  const ranges = foldingRanges.slice();

  for (let l = 0; l < lineStates.length; l++) {
    if (lineStates[l].commentStart === null) continue;
    let endL = l;
    while (endL + 1 < lineStates.length &&
           lineStates[endL + 1].commentStart !== null) {
      endL++;
    }
    if (endL > l) {
      ranges.push({ startLine: l, endLine: endL, kind: 'comment' });
    }
    l = endL; // skip past the run
  }
  return ranges;
}

module.exports = {
  TokenType, tokenizeLine, parseDocument, getWordAtPosition,
  getCommandContext, findVariables, findProcedures, findMatchingBrace,
  getDataWordLines, computeFoldingRanges
};
