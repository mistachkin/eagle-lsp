/**
 * Basic Eagle/Tcl parser for LSP features.
 * Provides: tokenization, word-at-position, command-at-position, brace matching, etc.
 */
'use strict';

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
 * Tokenize a line of Eagle code.
 * Returns array of { type, text, start, end }.
 */
function tokenizeLine(line) {
  const tokens = [];
  let i = 0;
  const len = line.length;

  function skipWhitespace() {
    while (i < len && (line[i] === ' ' || line[i] === '\t')) i++;
  }

  while (i < len) {
    skipWhitespace();
    if (i >= len) break;
    const ch = line[i];

    // Comment (only at start of command)
    if (ch === '#' && (tokens.length === 0 || tokens[tokens.length-1].type === TokenType.NEWLINE || tokens[tokens.length-1].type === TokenType.SEMICOLON)) {
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

    // Braced string
    if (ch === '{') {
      const start = i;
      let depth = 1;
      i++;
      while (i < len && depth > 0) {
        if (line[i] === '{' && line[i-1] !== '\\') depth++;
        else if (line[i] === '}' && line[i-1] !== '\\') depth--;
        if (depth > 0) i++;
      }
      if (i < len) i++;
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

    // Closing brace/bracket as standalone token (unmatched)
    if (ch === '}') {
      tokens.push({ type: TokenType.WORD, text: '}', start: i, end: i + 1 });
      i++;
      continue;
    }

    // Bare word (command name, option, etc.)
    const start = i;
    while (i < len && line[i] !== ' ' && line[i] !== '\t' && line[i] !== ';' &&
           line[i] !== '\n' && line[i] !== '[' && line[i] !== ']' &&
           line[i] !== '{' && line[i] !== '}' && line[i] !== '"') {
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
 * Parse a full document into a list of command invocations.
 * Each entry: { line, commandName, args: [{text, start, end, type}], commandToken }
 */
function parseDocument(text) {
  const lines = text.split('\n');
  const commands = [];
  let continuation = false;
  let currentArgs = [];
  let currentCmdName = null;
  let currentCmdLine = 0;
  let currentCmdToken = null;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    const trimmed = line.trimEnd();

    // Check for line continuation
    const isContinuation = continuation;
    continuation = trimmed.endsWith('\\');

    const tokens = tokenizeLine(line);
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
 * Get the word at a specific position in a line.
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
 * Find which command context the cursor is in.
 * Returns { commandName, argIndex, isSubcommandPosition, prefix }
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
 * Find all variable definitions (set, variable, global, upvar, foreach, etc.)
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
 * Find procedure definitions in document.
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
 * Find matching brace/bracket for a position.
 */
function findMatchingBrace(text, line, character) {
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

module.exports = {
  TokenType, tokenizeLine, parseDocument, getWordAtPosition,
  getCommandContext, findVariables, findProcedures, findMatchingBrace
};
