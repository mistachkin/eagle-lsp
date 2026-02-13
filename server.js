#!/usr/bin/env node
/**
 * Eagle Language Server - LSP implementation for the Eagle scripting language.
 * Supports: completion, hover, signature help, diagnostics, document symbols,
 *           go-to-definition, folding ranges, formatting hints.
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
        version: '1.0.0',
      },
    },
  };
});

connection.onInitialized(() => {
  connection.console.log('Eagle Language Server initialized');
});

// --- Document Management ---
connection.onDidOpenTextDocument((params) => {
  const doc = TextDocument.create(params.textDocument.uri, params.textDocument.languageId, params.textDocument.version, params.textDocument.text);
  documents.set(params.textDocument.uri, doc);
  validateDocument(doc);
});

connection.onDidChangeTextDocument((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (doc) {
    const updated = TextDocument.update(doc, params.contentChanges, params.textDocument.version);
    documents.set(params.textDocument.uri, updated);
    validateDocument(updated);
  }
});

connection.onDidCloseTextDocument((params) => {
  documents.delete(params.textDocument.uri);
  connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics: [] });
});

// --- Diagnostics ---
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

// --- Completion ---
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
    const cmd = data.commands.get(ctx.commandName);
    if (cmd && cmd.options) {
      const prefix = ctx.prefix.toLowerCase();
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
