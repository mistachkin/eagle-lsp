#!/usr/bin/env node
/**
 * Eagle Language Server - LSP implementation for the Eagle scripting language.
 *
 * This module implements the language-server side of the Microsoft Language
 * Server Protocol (LSP) for Eagle, the .NET-based Tcl-compatible scripting
 * engine.  It is designed to be launched as a child process by any LSP-aware
 * editor (VS Code, Neovim, Sublime, Emacs, etc.) and to speak JSON-RPC over
 * stdio via the `vscode-languageserver/node` connection.
 *
 * Provided LSP features:
 *
 *   - `textDocument/didOpen|didChange|didClose` document lifecycle tracking.
 *   - `textDocument/publishDiagnostics` with real-time validation: balanced
 *     braces/brackets and a hint-level "unknown command" check that ignores
 *     variable substitutions, bracketed sub-commands, namespaced names, and
 *     procs defined later in the same file.
 *   - `textDocument/completion` plus `completionItem/resolve`, supporting
 *     command, procedure, subcommand, option (with subcommand-specific option
 *     metadata), `string is` class, `expr` math function/operator, and
 *     variable (`$name`) completion.
 *   - `textDocument/hover` for commands, library procedures, user-defined
 *     procs, and variables, rendered as Markdown.
 *   - `textDocument/signatureHelp` driven by command usage strings or the
 *     synopsis lines from the data set.
 *   - `textDocument/documentSymbol` listing procedures, `namespace eval`
 *     blocks, `package provide` declarations, and top-level variables.
 *   - `textDocument/definition` for jumping to user-defined procs and
 *     variable definitions within the open document.
 *   - `textDocument/references` performing a simple textual scan.
 *   - `textDocument/foldingRange` for brace-delimited blocks and runs of
 *     consecutive comment lines.
 *
 * Static command/procedure metadata is provided by `./eagle-data` (which
 * loads JSON tables generated from the Eagle source tree), and syntactic
 * analysis of the open document is delegated to `./eagle-parser`.  The
 * server itself is stateless apart from a `documents` map keyed by URI.
 */
'use strict';

const {
  createConnection, ProposedFeatures, TextDocumentSyncKind,
  CompletionItemKind, SymbolKind, DiagnosticSeverity,
  MarkupKind, InsertTextFormat, FoldingRangeKind,
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const eagleData = require('./eagle-data');
const parser = require('./eagle-parser');

// --- Initialization ---
const connection = createConnection(ProposedFeatures.all);
const documents = new Map(); // uri -> TextDocument
let data; // loaded eagle data

/**
 * Handle the LSP `initialize` request.
 *
 * This is the first request the editor sends to the server; it negotiates
 * which protocol features the server supports and performs any one-time
 * setup that must happen before documents start flowing.  Here it lazily
 * loads the bundled Eagle data set (the commands, procedures, options,
 * subcommands, math functions, etc. extracted from the Eagle source tree)
 * via `eagleData.load()`, logs a one-line summary to the client console,
 * and then returns the server's `capabilities` object.
 *
 * The advertised capabilities tell the client to send the FULL document
 * text on every change (no incremental diffs), to ask the server for
 * completions when the user types `$`, space, `-`, or `:` (those being the
 * meaningful prefix characters in Eagle/Tcl: variable sigil, argument
 * separator, option leader, and namespace separator), and to enable hover,
 * signature help, document symbols, go-to-definition, references, and
 * folding range providers.  `resolveProvider` is set so that lightweight
 * completion items can be enriched on demand via `completionItem/resolve`.
 *
 * @param {object} params - Standard LSP `InitializeParams` from the client.
 *   Unused here, but the client supplies its capabilities, workspace
 *   folders, root URI, and other negotiation data.
 * @returns {object} An LSP `InitializeResult` describing the server's
 *   capabilities and including a `serverInfo` block with the human-readable
 *   name and version of this server.
 */
connection.onInitialize((params) => {
  data = eagleData.load();
  connection.console.log(`Eagle LSP: loaded ${data.commands.size} commands, ${data.procedures.size} procedures`);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      completionProvider: {
        triggerCharacters: ['$', ' ', '-', ':'],
        resolveProvider: true,
      },
      hoverProvider: true,
      signatureHelpProvider: {
        triggerCharacters: [' '],
      },
      documentSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      foldingRangeProvider: true,
      // Additional metadata
      serverInfo: {
        name: 'Eagle Language Server',
        version: '1.0.2',
      },
    },
  };
});

/**
 * Handle the LSP `initialized` notification.
 *
 * The client sends this exactly once, after it has received and processed
 * the response to `initialize`, signalling that two-way communication is
 * now fully established and that dynamic feature registrations (or
 * `workspace/configuration` round-trips) would be safe.  This server has
 * no dynamic registrations to perform, so the handler simply logs a status
 * line to the client's output channel as a heartbeat for debugging.
 *
 * @param {object} params - LSP `InitializedParams` (always empty).
 * @returns {void} Notifications have no response.
 */
connection.onInitialized(() => {
  connection.console.log('Eagle Language Server initialized');
});

// --- Document Management ---
/**
 * Handle the LSP `textDocument/didOpen` notification.
 *
 * Fired by the client when the user opens (or the editor otherwise becomes
 * aware of) an Eagle source file.  This handler constructs a fresh
 * `TextDocument` from the snapshot the client sent, stores it in the
 * per-server `documents` map keyed by URI, and immediately validates it so
 * the user sees diagnostics on open without having to type first.
 *
 * The full text is always provided here (the protocol requires it for
 * `didOpen`), so there is no need to consult any other source for the
 * initial document contents.
 *
 * @param {object} params - LSP `DidOpenTextDocumentParams`.  Its
 *   `textDocument` field carries `uri`, `languageId`, `version`, and the
 *   complete `text` of the file.
 * @returns {void}
 */
connection.onDidOpenTextDocument((params) => {
  const doc = TextDocument.create(params.textDocument.uri, params.textDocument.languageId, params.textDocument.version, params.textDocument.text);
  documents.set(params.textDocument.uri, doc);
  validateDocument(doc);
});

/**
 * Handle the LSP `textDocument/didChange` notification.
 *
 * Fired whenever the user edits an open document.  Because the server
 * advertises `TextDocumentSyncKind.Full`, each notification carries a
 * single content change whose `text` is the entire new document body --
 * but the same `TextDocument.update` API is used so the implementation
 * would still be correct under incremental sync.
 *
 * If the document is not currently tracked (which can happen if a change
 * notification arrives after `didClose`), the handler silently does
 * nothing.  Otherwise it applies the change, stores the new immutable
 * `TextDocument` snapshot back into the map, and re-runs `validateDocument`
 * so diagnostics stay in sync with the latest contents.
 *
 * @param {object} params - LSP `DidChangeTextDocumentParams`, with the
 *   target document's identifier (`uri`, `version`) and a `contentChanges`
 *   array describing what changed.
 * @returns {void}
 */
connection.onDidChangeTextDocument((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (doc) {
    const updated = TextDocument.update(doc, params.contentChanges, params.textDocument.version);
    documents.set(params.textDocument.uri, updated);
    validateDocument(updated);
  }
});

/**
 * Handle the LSP `textDocument/didClose` notification.
 *
 * Fired when the editor stops being interested in a document (typically
 * because the user closed it, or because it was renamed/deleted on disk).
 * The handler drops the cached `TextDocument` so it can be garbage
 * collected, then publishes an empty diagnostics array for the URI to
 * clear any lingering squiggles in the editor's "Problems" view.
 *
 * Clearing diagnostics explicitly is required by the protocol; the client
 * will not clear them on its own when a file closes.
 *
 * @param {object} params - LSP `DidCloseTextDocumentParams` identifying
 *   the document being released by `textDocument.uri`.
 * @returns {void}
 */
connection.onDidCloseTextDocument((params) => {
  documents.delete(params.textDocument.uri);
  connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics: [] });
});

// --- Diagnostics ---
/**
 * Validate an Eagle document and publish the resulting diagnostics.
 *
 * This is the workhorse behind `textDocument/publishDiagnostics`.  It runs
 * two independent passes over the open document and sends a single combined
 * diagnostics array to the client.
 *
 * Pass one is a hand-rolled character scan that tracks the depth of curly
 * braces and square brackets while honouring two pieces of Eagle/Tcl
 * lexical context: backslash escapes (the next character is skipped) and
 * double-quoted strings (brace/bracket counting is disabled inside them).
 * It also treats a `#` as a comment only when it is the first non-space
 * character on the line or immediately preceded by whitespace -- this is
 * an approximation of Tcl's "comments are only recognized in command
 * position" rule that is good enough for editor diagnostics.  A negative
 * brace or bracket depth produces an Error-severity diagnostic for the
 * offending closer and the depth is clamped back to zero so a single typo
 * does not avalanche into a wall of cascading errors.
 *
 * Pass two delegates to `parser.parseDocument` to obtain a structured list
 * of commands, then for each command word that looks like an actual
 * identifier (skipping `$var`, `[bracket]`, `ns::scoped`, and `{braced}`
 * forms) checks the loaded `data` set for a matching built-in command or
 * library procedure.  If no match is found, the same document is scanned
 * for user-defined `proc` declarations via `parser.findProcedures` so that
 * forward references and procs defined later in the file are not flagged.
 * Anything that survives all of those filters is reported as a Hint-level
 * diagnostic, which most editors render unobtrusively.
 *
 * Tricky details: the diagnostic ranges use the command/closer's exact
 * column so the squiggle lands precisely; the function always calls
 * `connection.sendDiagnostics`, even when the array is empty, so that a
 * fix in the document clears stale diagnostics for that URI.
 *
 * @param {TextDocument} doc - The document snapshot to validate; must
 *   expose `getText()` and `uri`.
 * @returns {void} Diagnostics are delivered to the client via the LSP
 *   connection rather than returned to the caller.
 */
function validateDocument(doc) {
  const text = doc.getText();
  const diagnostics = [];

  // Check for unmatched braces
  let braceDepth = 0, bracketDepth = 0;
  const lines = text.split('\n');
  let inString = false;

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '\\') { c++; continue; }
      if (line[c] === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (line[c] === '#' && (c === 0 || /\s/.test(line[c-1]))) break; // comment
      if (line[c] === '{') braceDepth++;
      else if (line[c] === '}') {
        braceDepth--;
        if (braceDepth < 0) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: { start: { line: l, character: c }, end: { line: l, character: c + 1 } },
            message: 'Unmatched closing brace',
            source: 'eagle',
          });
          braceDepth = 0;
        }
      }
      if (line[c] === '[') bracketDepth++;
      else if (line[c] === ']') {
        bracketDepth--;
        if (bracketDepth < 0) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: { start: { line: l, character: c }, end: { line: l, character: c + 1 } },
            message: 'Unmatched closing bracket',
            source: 'eagle',
          });
          bracketDepth = 0;
        }
      }
    }
  }

  // Check for unknown commands (warning level)
  const cmds = parser.parseDocument(text);
  for (const cmd of cmds) {
    if (cmd.commandName && !cmd.commandName.startsWith('$') && !cmd.commandName.startsWith('[') &&
        !cmd.commandName.includes('::') && !cmd.commandName.startsWith('{')) {
      const name = cmd.commandName;
      if (!data.commands.has(name) && !data.procedures.has(name)) {
        // Check if it's a user-defined proc in this file
        const userProcs = parser.findProcedures(text);
        const isUserProc = userProcs.some(p => p.name === name);
        if (!isUserProc && name.length > 0 && /^[a-zA-Z]/.test(name)) {
          const tok = cmd.commandToken;
          if (tok) {
            diagnostics.push({
              severity: DiagnosticSeverity.Hint,
              range: { start: { line: cmd.line, character: tok.start }, end: { line: cmd.line, character: tok.end } },
              message: `Unknown command: '${name}' (may be defined elsewhere)`,
              source: 'eagle',
            });
          }
        }
      }
    }
  }

  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

// --- Option Completion Helpers ---

/**
 * Extract the subcommand name from a completion context.
 *
 * Many Eagle commands behave as "ensembles": the first positional
 * argument selects a sub-command that has its own option set (for example,
 * `interp create -safe`, `string is integer`, or `dict get`).  When the
 * user types an option on such a command, the completion provider needs
 * to know not just the outer command but also which sub-command they are
 * working under so it can offer the right option metadata.
 *
 * This helper inspects the token list captured by
 * `parser.getCommandContext` and returns that sub-command word, or `null`
 * if the cursor is not actually inside an ensemble invocation.  It rejects
 * candidates that begin with `-`, `$`, `{`, or `[` because those denote an
 * option, a variable substitution, a braced word, or a bracketed command
 * substitution respectively -- none of which can be a sub-command name.
 *
 * To avoid false positives on commands that merely happen to take a bare
 * word first, the candidate is cross-checked against two sources before
 * being accepted: the per-command sub-command list in `data.subcommandMap`
 * and the keys of `data.commandOptions` formatted as `command.subcommand`.
 * Either match counts as confirmation.
 *
 * @param {object} ctx - A command context object as returned by
 *   `parser.getCommandContext`.  Only `ctx.tokens` (array of lexer tokens
 *   for the command) and `ctx.commandName` are consulted.
 * @returns {?string} The validated sub-command name, or `null` if the
 *   context does not contain a recognized sub-command.
 */
function getSubcommandFromContext(ctx) {
  if (!ctx.tokens || ctx.tokens.length < 2) return null;
  const firstArg = ctx.tokens[1];
  if (!firstArg || !firstArg.text) return null;
  const text = firstArg.text;
  // Subcommands don't start with - or $ or { or [
  if (text.startsWith('-') || text.startsWith('$') ||
      text.startsWith('{') || text.startsWith('[')) return null;
  // Check if this command actually has this subcommand
  const subs = data.subcommandMap.get(ctx.commandName);
  if (subs && subs.includes(text)) return text;
  // Also check command option metadata keys directly
  if (data.commandOptions[`${ctx.commandName}.${text}`]) return text;
  return null;
}

/**
 * Translate an option's value-kind code into a human-readable label.
 *
 * Eagle's option metadata records the expected value type for each option
 * (for example, `wideInteger`, `cultureInfo`, `matchMode`, `ruleSet`) using
 * the same identifiers the engine uses internally.  Those identifiers are
 * useful programmatically but not always pleasant to read in an editor
 * tooltip, so this helper maps each known code to a friendlier phrase
 * shown in the completion item's `detail` field (e.g. "wide integer",
 * "culture", "match mode").
 *
 * Two codes get special handling.  The literal string `none` (and any
 * falsy input) returns `null`, which the caller interprets as "this is a
 * switch with no value, do not show a type hint at all".  The code `enum`
 * is rendered using the short (final) segment of the supplied .NET enum
 * type name, so `Eagle._Components.Public.MatchMode` becomes simply
 * `MatchMode`; if `enumType` is not provided the generic word `enum` is
 * shown instead.  Unknown codes fall through to the `default` branch and
 * are returned verbatim so new value kinds added to the data set remain
 * visible even before this switch is updated.
 *
 * @param {?string} valueKind - The option's `valueKind` from the data
 *   set, or `null`/`undefined`/the string `'none'` for switch-only options.
 * @param {?string} [enumType] - For `enum`-kind options, the fully
 *   qualified .NET enum type name; only the final dotted segment is used.
 * @returns {?string} A display string for the value kind, or `null` if
 *   the option carries no value.
 */
function formatValueKind(valueKind, enumType) {
  if (!valueKind || valueKind === 'none') return null;
  switch (valueKind) {
    case 'enum':
      if (enumType) {
        const shortName = enumType.split('.').pop();
        return shortName;
      }
      return 'enum';
    case 'boolean': return 'boolean';
    case 'integer': return 'integer';
    case 'wideInteger': return 'wide integer';
    case 'unsignedWideInteger': return 'unsigned wide integer';
    case 'narrowInteger': return 'narrow integer';
    case 'string': return 'string';
    case 'encoding': return 'encoding';
    case 'type': return '.NET type';
    case 'typeList': return 'type list';
    case 'dateTime': return 'datetime';
    case 'matchMode': return 'match mode';
    case 'returnCode': return 'return code';
    case 'returnCodeList': return 'return code list';
    case 'ruleSet': return 'rule set';
    case 'object': return 'object handle';
    case 'interpreter': return 'interpreter path';
    case 'list': return 'list';
    case 'dictionary': return 'dictionary';
    case 'byteArray': return 'byte array';
    case 'cultureInfo': return 'culture';
    case 'version': return 'version';
    case 'absoluteNamespace': return 'namespace';
    default: return valueKind;
  }
}

/**
 * Build a short documentation string describing a single command option.
 *
 * Used as the `documentation` field of completion items for option flags.
 * The result is a plain-text string (not Markdown) composed of one piece
 * of information per line so that editors which render the documentation
 * verbatim still produce a readable tooltip.
 *
 * The first line always describes the option's value: either the rich
 * .NET enum type name when present, the raw `valueKind` otherwise, or the
 * literal `Switch (no value)` for boolean switches.  Two optional lines
 * may follow: `Unsafe (hidden in safe interpreters)` for options that the
 * engine hides in safe interpreters, and `Mutual-exclusion group N` for
 * options that belong to a numbered group from which only one member may
 * be supplied at a time.
 *
 * @param {object} opt - One option-metadata entry from
 *   `data.commandOptions[...]`.  Recognized fields: `valueKind`,
 *   `enumType`, `unsafe`, and `group`.
 * @returns {string} A newline-joined documentation string.  Always
 *   contains at least one line.
 */
function buildOptionDoc(opt) {
  const parts = [];
  if (opt.valueKind && opt.valueKind !== 'none') {
    if (opt.enumType) {
      parts.push(`Value: ${opt.enumType}`);
    } else {
      parts.push(`Value: ${opt.valueKind}`);
    }
  } else {
    parts.push('Switch (no value)');
  }
  if (opt.unsafe) parts.push('Unsafe (hidden in safe interpreters)');
  if (opt.group !== undefined) parts.push(`Mutual-exclusion group ${opt.group}`);
  return parts.join('\n');
}

// --- Completion ---
/**
 * Handle the LSP `textDocument/completion` request.
 *
 * This is the single largest handler in the server and the one users
 * interact with most.  It analyses the line and cursor position the
 * client supplied and returns an array of `CompletionItem`s appropriate
 * to where the cursor is in the Eagle source.  Items are returned plain
 * (no resolved documentation); rich Markdown for command items is filled
 * in lazily by `onCompletionResolve` when the user actually highlights an
 * entry.
 *
 * The handler runs the cursor through several context buckets, in order,
 * and returns as soon as one of them produces an answer.  This keeps the
 * suggestion list focused and avoids mixing unrelated kinds of items:
 *
 *   1. Variable substitution: if the text immediately preceding the
 *      cursor matches `$[a-zA-Z0-9_:]*`, only variables (and procs
 *      treated as callables) collected by `parser.findVariables` are
 *      offered.
 *   2. Command position: when the parser reports the cursor is at the
 *      start of a command, built-in commands, user-defined procs (from
 *      this document), and library procedures are offered, grouped by
 *      sortText prefix (`0`, `1`, `2` respectively) so the editor shows
 *      built-ins first.
 *   3. Sub-command position: when the cursor is the first argument of an
 *      ensemble command and that command has a known sub-command list,
 *      its sub-commands are offered as `EnumMember` items.
 *   4. The special case `string is <class>`: scans the partial command to
 *      detect `string is` followed by a class slot and offers the values
 *      from `data.stringIsClasses`.
 *   5. The `expr` command: when typing inside an `expr` invocation, math
 *      functions (`sin`, `tan`, ...) are offered with an inserted opening
 *      parenthesis, followed by `expr` operators as `Operator` items.
 *   6. Option completion: when the partial word starts with `-`, the
 *      handler first tries subcommand-specific option metadata (via
 *      `getSubcommandFromContext`), falling back to top-level metadata
 *      and finally to the flat option list in `eagle_commands.json`.
 *      Unsupported options are filtered out; unsafe options sort after
 *      safe ones.
 *   7. Fallback: if none of the above produced any items but a command
 *      context exists, the set of in-scope variables is offered with a
 *      leading `$` so the user can quickly substitute a value.
 *
 * @param {object} params - LSP `CompletionParams`, providing the document
 *   identifier and the cursor `position` (line + character).
 * @returns {object[]} An array of `CompletionItem`s.  Empty when the
 *   document is not tracked, or when no context-specific suggestions
 *   apply and no in-scope variables exist.
 */
connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const text = doc.getText();
  const lines = text.split('\n');
  const line = lines[params.position.line] || '';
  const ctx = parser.getCommandContext(line, params.position.character);
  const items = [];

  // Variable completion after $
  const beforeCursor = line.slice(0, params.position.character);
  const varMatch = beforeCursor.match(/\$([a-zA-Z0-9_:]*)$/);
  if (varMatch) {
    const prefix = varMatch[1].toLowerCase();
    const vars = parser.findVariables(text);
    for (const [name, info] of vars) {
      if (name.toLowerCase().startsWith(prefix)) {
        items.push({
          label: name,
          kind: info.isProc ? CompletionItemKind.Function : CompletionItemKind.Variable,
          detail: info.isProc ? 'procedure' : `variable (${info.command})`,
          insertText: name,
        });
      }
    }
    return items;
  }

  // Command position - suggest commands and procedures
  if (ctx.isCommandPosition || (!ctx.commandName && ctx.argIndex === 0)) {
    const prefix = ctx.prefix.toLowerCase();
    for (const name of data.allCommandNames) {
      if (!prefix || name.toLowerCase().startsWith(prefix)) {
        const cmd = data.commands.get(name);
        items.push({
          label: name,
          kind: CompletionItemKind.Function,
          detail: `[${cmd.group}] command`,
          documentation: cmd.description ? { kind: MarkupKind.Markdown, value: cmd.description } : undefined,
          sortText: '0' + name,
        });
      }
    }
    // User-defined procs
    const userProcs = parser.findProcedures(text);
    for (const p of userProcs) {
      if (!prefix || p.name.toLowerCase().startsWith(prefix)) {
        items.push({
          label: p.name,
          kind: CompletionItemKind.Function,
          detail: `proc (${p.args})`,
          sortText: '1' + p.name,
        });
      }
    }
    // Library procedures
    for (const name of data.allProcNames) {
      if (!prefix || name.toLowerCase().startsWith(prefix)) {
        const proc = data.procedures.get(name);
        items.push({
          label: name,
          kind: CompletionItemKind.Function,
          detail: 'library procedure',
          documentation: proc.description ? { kind: MarkupKind.Markdown, value: proc.description } : undefined,
          sortText: '2' + name,
        });
      }
    }
    return items;
  }

  // Subcommand position
  if (ctx.isSubcommandPosition && ctx.commandName) {
    const subs = data.subcommandMap.get(ctx.commandName);
    if (subs) {
      const prefix = ctx.prefix.toLowerCase();
      for (const sub of subs) {
        if (!prefix || sub.toLowerCase().startsWith(prefix)) {
          items.push({
            label: sub,
            kind: CompletionItemKind.EnumMember,
            detail: `${ctx.commandName} subcommand`,
            sortText: '0' + sub,
          });
        }
      }
    }
  }

  // "string is" class completion
  if (ctx.commandName === 'string' && ctx.argIndex >= 2) {
    const tokens = beforeCursor.trim().split(/\s+/);
    const isIdx = tokens.indexOf('is');
    if (isIdx !== -1 && tokens.indexOf('string') < isIdx) {
      const prefix = ctx.prefix.toLowerCase();
      for (const cls of data.stringIsClasses) {
        if (!prefix || cls.toLowerCase().startsWith(prefix)) {
          items.push({
            label: cls,
            kind: CompletionItemKind.EnumMember,
            detail: 'string is class',
            sortText: '0' + cls,
          });
        }
      }
      if (items.length > 0) return items;
    }
  }

  // expr math function completion
  if (ctx.commandName === 'expr') {
    const prefix = ctx.prefix.toLowerCase();
    for (const fn of data.mathFunctions) {
      if (!prefix || fn.toLowerCase().startsWith(prefix)) {
        items.push({
          label: fn,
          kind: CompletionItemKind.Function,
          detail: 'math function',
          insertText: fn + '(',
          sortText: '0' + fn,
        });
      }
    }
    // Also suggest expr operators
    for (const op of data.exprOperators) {
      if (!prefix || op.toLowerCase().startsWith(prefix)) {
        items.push({
          label: op,
          kind: CompletionItemKind.Operator,
          detail: 'expr operator',
          sortText: '1' + op,
        });
      }
    }
    if (items.length > 0) return items;
  }

  // Option completion (after -)
  if (ctx.prefix.startsWith('-') && ctx.commandName) {
    const prefix = ctx.prefix.toLowerCase();
    let optionsUsed = false;

    //
    // Try subcommand-specific options from command option metadata first.
    // Look up by "command.subcommand" key, falling back to "command" for
    // top-level commands.
    //
    const subCmd = getSubcommandFromContext(ctx);
    const optKeys = [];
    if (subCmd) optKeys.push(`${ctx.commandName}.${subCmd}`);
    optKeys.push(ctx.commandName);

    for (const optKey of optKeys) {
      const optMeta = data.commandOptions[optKey];
      if (optMeta && optMeta.length > 0) {
        for (const opt of optMeta) {
          if (opt.unsupported) continue;
          if (opt.name.toLowerCase().startsWith(prefix)) {
            const valueDesc = formatValueKind(opt.valueKind, opt.enumType);
            items.push({
              label: opt.name,
              kind: CompletionItemKind.Property,
              detail: valueDesc
                ? `${ctx.commandName} option (${valueDesc})`
                : `${ctx.commandName} option`,
              documentation: buildOptionDoc(opt),
              sortText: (opt.unsafe ? '2' : '1') + opt.name,
            });
          }
        }
        optionsUsed = true;
        break;
      }
    }

    //
    // Fall back to the flat option list from eagle_commands.json
    // if no command option metadata is available.
    //
    if (!optionsUsed) {
      const cmd = data.commands.get(ctx.commandName);
      if (cmd && cmd.options) {
        for (const opt of cmd.options) {
          if (opt.toLowerCase().startsWith(prefix)) {
            items.push({
              label: opt,
              kind: CompletionItemKind.Property,
              detail: `${ctx.commandName} option`,
            });
          }
        }
      }
    }
  }

  // If no specific completions, suggest common snippets
  if (items.length === 0 && ctx.commandName) {
    // Suggest variables
    const vars = parser.findVariables(text);
    for (const [name] of vars) {
      items.push({
        label: '$' + name,
        kind: CompletionItemKind.Variable,
        insertText: '$' + name,
      });
    }
  }

  return items;
});

/**
 * Handle the LSP `completionItem/resolve` request.
 *
 * The completion handler returns lightweight items so the initial
 * suggestion list is fast to compute and cheap to transmit, even when the
 * user has typed only a single character.  When the editor needs to
 * actually display documentation -- for example, when the user highlights
 * an entry and the editor pops up a side panel -- it sends the chosen
 * item back via this `resolve` request, and the server replies with the
 * same item enriched with full Markdown documentation.
 *
 * This implementation only enriches items whose `kind` is `Function` and
 * whose `label` matches a known built-in command.  It composes a Markdown
 * payload made up of a fenced `tcl` synopsis block, the long description,
 * and any `Examples:` block from the data set.  Items that came from user
 * procs or library procs already carry enough data and are returned
 * unchanged; the editor is free to call resolve on them anyway and simply
 * gets the item back as-is.
 *
 * @param {object} item - The `CompletionItem` previously returned by the
 *   completion handler.
 * @returns {object} The same item, with `documentation` populated when
 *   applicable.  The reference is mutated and returned.
 */
connection.onCompletionResolve((item) => {
  // Enrich completion item with full documentation
  if (item.kind === CompletionItemKind.Function && data.commands.has(item.label)) {
    const cmd = data.commands.get(item.label);
    const parts = [];
    if (cmd.synopsis) parts.push('```tcl\n' + cmd.synopsis + '\n```');
    if (cmd.description) parts.push(cmd.description);
    if (cmd.examples) parts.push('**Examples:**\n```tcl\n' + cmd.examples + '\n```');
    item.documentation = { kind: MarkupKind.Markdown, value: parts.join('\n\n') };
  }
  return item;
});

// --- Hover ---
/**
 * Handle the LSP `textDocument/hover` request.
 *
 * Produces the tooltip the editor shows when the user hovers the mouse
 * over (or otherwise queries) an identifier in an Eagle source file.
 * The handler asks `parser.getWordAtPosition` for the word under the
 * cursor and then probes three sources, in order of authority, returning
 * the first match as a Markdown-formatted hover:
 *
 *   1. Built-in commands (`data.commands`): renders a `## name` heading,
 *      the command group, a fenced `tcl` synopsis, the description,
 *      comma-separated sub-command and option lists, and any examples.
 *   2. Library procedures (`data.procedures`): renders a heading, the
 *      stored signature in a fenced `tcl` block, and the description.
 *   3. User-defined procedures from the open file (via
 *      `parser.findProcedures`): renders the proc name, a synthetic
 *      `proc name {args} {...}` block, and the source line.
 *
 * If the word begins with `$` it is treated as a variable reference.  The
 * leading sigil and any namespace colons, plus any `{`/`}` from a `${...}`
 * form, are stripped before looking the bare name up via
 * `parser.findVariables`.  When a definition is found the tooltip notes
 * which Eagle command introduced the variable (`set`, `variable`, `global`,
 * `upvar`, `foreach`, ...) and on what line.
 *
 * @param {object} params - LSP `HoverParams` with the target document and
 *   cursor position.
 * @returns {?object} An LSP `Hover` object with a Markdown body, or
 *   `null` when there is no word under the cursor and when nothing matches.
 */
connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const text = doc.getText();
  const lines = text.split('\n');
  const line = lines[params.position.line] || '';
  const { word } = parser.getWordAtPosition(line, params.position.character);
  if (!word) return null;

  // Check if it's a command
  const cmd = data.commands.get(word);
  if (cmd) {
    const parts = [`## ${cmd.name}`, `**Group:** ${cmd.group}`];
    if (cmd.synopsis) parts.push('```tcl\n' + cmd.synopsis + '\n```');
    if (cmd.description) parts.push(cmd.description);
    if (cmd.subcommands.length > 0) parts.push('**Subcommands:** ' + cmd.subcommands.join(', '));
    if (cmd.options.length > 0) parts.push('**Options:** ' + cmd.options.join(', '));
    if (cmd.examples) parts.push('**Examples:**\n```tcl\n' + cmd.examples + '\n```');
    return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n\n') } };
  }

  // Check library procedures
  const proc = data.procedures.get(word);
  if (proc) {
    const parts = [`## ${proc.name}`, '```tcl\n' + proc.signature + '\n```'];
    if (proc.description) parts.push(proc.description);
    return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n\n') } };
  }

  // Check user-defined procs
  const userProcs = parser.findProcedures(text);
  const userProc = userProcs.find(p => p.name === word);
  if (userProc) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `## ${userProc.name}\n\n\`\`\`tcl\nproc ${userProc.name} {${userProc.args}} {...}\n\`\`\`\n\n*Defined on line ${userProc.line + 1}*`,
      },
    };
  }

  // Variable hover
  if (word.startsWith('$')) {
    const varName = word.replace(/^\$:*/, '').replace(/[{}]/g, '');
    const vars = parser.findVariables(text);
    const v = vars.get(varName);
    if (v) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**Variable:** \`${varName}\`\n\nDefined on line ${v.line + 1} via \`${v.command}\``,
        },
      };
    }
  }

  return null;
});

// --- Signature Help ---
/**
 * Handle the LSP `textDocument/signatureHelp` request.
 *
 * Provides the in-line "what arguments does this command take, and which
 * one am I typing right now?" pop-up that editors display while the user
 * is inside a command invocation.  The handler asks
 * `parser.getCommandContext` for the command name and current argument
 * index, then looks the command up in `data.commands` to obtain its
 * documented call patterns.
 *
 * The candidate signature list is taken from `cmd.usages` when that
 * curated array is present; otherwise the synopsis is split into one
 * signature per non-empty line.  Each signature is wrapped in an LSP
 * `SignatureInformation` object whose `documentation` is the command's
 * long description (rendered as Markdown).  All discovered usages are
 * returned together so the client can let the user cycle through
 * overloads with the up/down keys, but the server marks the first one
 * active by default.
 *
 * The `activeParameter` is derived from the argument index:
 * `Math.max(0, ctx.argIndex - 1)` -- `argIndex` is 0 at the command word
 * itself, so subtracting one gives the zero-based index of the parameter
 * the user is actually typing, never going below zero.
 *
 * @param {object} params - LSP `SignatureHelpParams` with the document
 *   and cursor position.
 * @returns {?object} An LSP `SignatureHelp` object, or `null` if the
 *   document is not tracked, the cursor is not inside a known command, or
 *   the command has no documented signatures.
 */
connection.onSignatureHelp((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const lines = doc.getText().split('\n');
  const line = lines[params.position.line] || '';
  const ctx = parser.getCommandContext(line, params.position.character);
  if (!ctx.commandName) return null;

  const cmd = data.commands.get(ctx.commandName);
  if (!cmd) return null;

  // Build signatures from usages or synopsis
  let usageList = cmd.usages;
  if (!usageList || usageList.length === 0) {
    // Fall back to synopsis lines
    if (cmd.synopsis) {
      usageList = cmd.synopsis.split('\n').filter(l => l.trim().length > 0);
    }
  }
  if (!usageList || usageList.length === 0) return null;

  const signatures = usageList.map(usage => ({
    label: usage,
    documentation: cmd.description ? { kind: MarkupKind.Markdown, value: cmd.description } : undefined,
  }));

  return {
    signatures,
    activeSignature: 0,
    activeParameter: Math.max(0, ctx.argIndex - 1),
  };
});

// --- Document Symbols ---
/**
 * Handle the LSP `textDocument/documentSymbol` request.
 *
 * Builds the outline/breadcrumb tree most editors show in their sidebar
 * or "Go to symbol in file..." command palette.  The returned array is a
 * flat list (not a hierarchy) of `DocumentSymbol`-shaped entries derived
 * from three sources:
 *
 *   - Every user-defined procedure found by `parser.findProcedures`,
 *     reported as a `SymbolKind.Function` with the parameter list shown
 *     in the `detail` field.
 *   - Every `namespace eval <name>` invocation, reported as a
 *     `SymbolKind.Namespace`.  The handler tolerates malformed calls by
 *     using the literal `'unknown'` when the namespace name is missing.
 *   - Every `package provide <name>` invocation, reported as a
 *     `SymbolKind.Package`, with the same tolerance for missing names.
 *   - Every top-level variable definition collected by
 *     `parser.findVariables` (skipping those flagged as procs, which were
 *     already added above), reported as a `SymbolKind.Variable` with the
 *     defining command (`set`, `variable`, `global`, ...) in `detail`.
 *
 * Range bookkeeping uses the line on which each symbol starts and an
 * end-character of 1000 as a deliberately generous upper bound -- the
 * exact column does not matter for outline display, only the line, and
 * 1000 comfortably exceeds the longest reasonable source line.
 *
 * @param {object} params - LSP `DocumentSymbolParams` with the target
 *   document identifier.
 * @returns {object[]} An array of symbol entries.  Empty when the
 *   document is not tracked.
 */
connection.onDocumentSymbol((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const text = doc.getText();
  const symbols = [];

  // Procedures
  const procs = parser.findProcedures(text);
  for (const p of procs) {
    symbols.push({
      name: p.name,
      kind: SymbolKind.Function,
      range: {
        start: { line: p.line, character: 0 },
        end: { line: p.line, character: 1000 },
      },
      selectionRange: {
        start: { line: p.line, character: 0 },
        end: { line: p.line, character: 1000 },
      },
      detail: `(${p.args})`,
    });
  }

  // Namespace declarations
  const cmds = parser.parseDocument(text);
  for (const cmd of cmds) {
    if (cmd.commandName === 'namespace' && cmd.args.length >= 1 && cmd.args[0].text === 'eval') {
      const nsName = cmd.args.length >= 2 ? cmd.args[1].text : 'unknown';
      symbols.push({
        name: `namespace ${nsName}`,
        kind: SymbolKind.Namespace,
        range: {
          start: { line: cmd.line, character: 0 },
          end: { line: cmd.line, character: 1000 },
        },
        selectionRange: {
          start: { line: cmd.line, character: 0 },
          end: { line: cmd.line, character: 1000 },
        },
      });
    }
    // Package provides
    if (cmd.commandName === 'package' && cmd.args.length >= 1 && cmd.args[0].text === 'provide') {
      const pkgName = cmd.args.length >= 2 ? cmd.args[1].text : 'unknown';
      symbols.push({
        name: `package ${pkgName}`,
        kind: SymbolKind.Package,
        range: {
          start: { line: cmd.line, character: 0 },
          end: { line: cmd.line, character: 1000 },
        },
        selectionRange: {
          start: { line: cmd.line, character: 0 },
          end: { line: cmd.line, character: 1000 },
        },
      });
    }
  }

  // Variables (top-level set commands)
  const vars = parser.findVariables(text);
  for (const [name, info] of vars) {
    if (!info.isProc) {
      symbols.push({
        name,
        kind: SymbolKind.Variable,
        range: {
          start: { line: info.line, character: 0 },
          end: { line: info.line, character: 1000 },
        },
        selectionRange: {
          start: { line: info.line, character: 0 },
          end: { line: info.line, character: 1000 },
        },
        detail: info.command,
      });
    }
  }

  return symbols;
});

// --- Go to Definition ---
/**
 * Handle the LSP `textDocument/definition` request.
 *
 * Implements the editor's "Go to definition" command for Eagle source.
 * The handler resolves the word under the cursor and searches the open
 * document for either a matching user-defined procedure (via
 * `parser.findProcedures`) or a matching variable definition (via
 * `parser.findVariables`).  Whichever is found first is returned as an
 * LSP `Location` pointing at the line where the symbol is introduced.
 *
 * Variable name normalization mirrors the hover handler: any leading `$`
 * (followed by any number of namespace colons) is stripped, and the
 * braces from a `${name}` form are removed so the look-up uses the plain
 * variable name.
 *
 * Definitions in other files are not resolved -- only the current
 * document is searched.  Built-in commands and library procedures are
 * intentionally not navigable because their source lives outside the
 * user's project.
 *
 * @param {object} params - LSP `DefinitionParams` with the target
 *   document and cursor position.
 * @returns {?object} An LSP `Location` for the definition site, or
 *   `null` if no definition is found in the current document.
 */
connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const text = doc.getText();
  const lines = text.split('\n');
  const line = lines[params.position.line] || '';
  const { word } = parser.getWordAtPosition(line, params.position.character);
  if (!word) return null;

  // Check user-defined procs
  const procs = parser.findProcedures(text);
  const proc = procs.find(p => p.name === word);
  if (proc) {
    return {
      uri: params.textDocument.uri,
      range: {
        start: { line: proc.line, character: 0 },
        end: { line: proc.line, character: 1000 },
      },
    };
  }

  // Check variable definitions
  const varName = word.replace(/^\$:*/, '').replace(/[{}]/g, '');
  const vars = parser.findVariables(text);
  const v = vars.get(varName);
  if (v) {
    return {
      uri: params.textDocument.uri,
      range: {
        start: { line: v.line, character: 0 },
        end: { line: v.line, character: 1000 },
      },
    };
  }

  return null;
});

// --- References ---
/**
 * Handle the LSP `textDocument/references` request.
 *
 * Implements the editor's "Find all references" command.  This is a
 * deliberately simple textual implementation: the word under the cursor
 * is taken, any leading `$` is stripped, and the remaining string is
 * scanned for verbatim occurrences in every line of the open document.
 * Each match is reported as an LSP `Location` covering exactly the run
 * of characters where the substring appears.
 *
 * Because the search is purely lexical, it will find occurrences inside
 * comments, strings, and partial words (for example, looking up `len`
 * also matches inside `length`).  The trade-off is intentional: it makes
 * the feature work without any cross-file index, and the editor's UI
 * lets the user quickly filter the result list.
 *
 * @param {object} params - LSP `ReferenceParams` with the document and
 *   cursor position.  The protocol also carries an `includeDeclaration`
 *   flag, but this implementation always returns every occurrence.
 * @returns {object[]} An array of `Location` objects, one per textual
 *   match.  Empty when the document is not tracked or when no word lies
 *   under the cursor.
 */
connection.onReferences((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const text = doc.getText();
  const lines = text.split('\n');
  const line = lines[params.position.line] || '';
  let { word } = parser.getWordAtPosition(line, params.position.character);
  if (!word) return [];

  // Search for all occurrences
  const results = [];
  const search = word.replace(/^\$/, '');
  for (let l = 0; l < lines.length; l++) {
    let idx = 0;
    while ((idx = lines[l].indexOf(search, idx)) !== -1) {
      results.push({
        uri: params.textDocument.uri,
        range: {
          start: { line: l, character: idx },
          end: { line: l, character: idx + search.length },
        },
      });
      idx += search.length;
    }
  }
  return results;
});

// --- Folding Ranges ---
/**
 * Handle the LSP `textDocument/foldingRange` request.
 *
 * Computes the set of foldable regions the editor offers via its
 * gutter-arrow / outline-collapse UI.  Two kinds of regions are
 * produced.
 *
 * Brace-delimited regions are detected by a single character scan that
 * tracks brace depth using a stack of opening line numbers.  A backslash
 * before any character makes the next character skipped, mirroring the
 * Eagle/Tcl escape rule and preventing `\{` or `\}` from being treated as
 * a real delimiter.  When a matching closer is found on a different line
 * than its opener, a `FoldingRangeKind.Region` from the opener's line to
 * the closer's line is added.  Same-line braces are not foldable.
 *
 * Comment regions are detected per line: whenever a line's first
 * non-whitespace character is `#`, the scan looks ahead for additional
 * consecutive `#`-starting lines and, if at least two are present, emits
 * a `FoldingRangeKind.Comment` covering the block.  The outer loop index
 * is then advanced past the block to avoid emitting overlapping ranges
 * for the same comment.
 *
 * The two passes happen interleaved inside the same per-line loop;
 * because the brace scan only acts on individual characters and the
 * comment scan only acts on whole lines, they do not interfere with each
 * other.
 *
 * @param {object} params - LSP `FoldingRangeParams` with the document
 *   identifier.
 * @returns {object[]} An array of `FoldingRange` entries.  Empty when
 *   the document is not tracked or contains no foldable structures.
 */
connection.onFoldingRanges((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const text = doc.getText();
  const lines = text.split('\n');
  const ranges = [];
  const braceStack = [];

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '\\') { c++; continue; }
      if (line[c] === '{') {
        braceStack.push(l);
      } else if (line[c] === '}') {
        if (braceStack.length > 0) {
          const startLine = braceStack.pop();
          if (l > startLine) {
            ranges.push({
              startLine,
              endLine: l,
              kind: FoldingRangeKind.Region,
            });
          }
        }
      }
    }
    // Comment blocks
    if (line.trimStart().startsWith('#')) {
      let endL = l;
      while (endL + 1 < lines.length && lines[endL + 1].trimStart().startsWith('#')) endL++;
      if (endL > l) {
        ranges.push({ startLine: l, endLine: endL, kind: FoldingRangeKind.Comment });
        l = endL; // skip ahead
      }
    }
  }

  return ranges;
});

// --- Start ---
connection.listen();
