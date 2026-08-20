# Eagle Language Server

A [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) (LSP) implementation for the **[Eagle](https://urn.to/r/eagle)** scripting language (Extensible Adaptable Generalized Logic Engine — a Tcl implementation for the CLR).

## Features

| Feature | Description |
|---------|-------------|
| **Completion** | Commands (120+), subcommands, options, library procedures (135+), variables, user procs |
| **Hover** | Full documentation with synopsis, description, options, examples |
| **Signature Help** | Usage patterns shown as you type command arguments |
| **Diagnostics** | Unmatched braces/brackets, unknown command hints |
| **Document Symbols** | Procedures, namespaces, packages, variables |
| **Go to Definition** | Jump to proc/variable definitions within a file |
| **Find References** | Find all usages of a symbol |
| **Folding Ranges** | Brace-based and comment-block folding |
| **Syntax Highlighting** | TextMate grammar for VS Code (also works with other editors) |

## Installation

### Prerequisites

- Node.js 18+

### From Source

```bash
git clone <this-repo>
cd eagle-lsp
npm install
```

### Running the Server

The server communicates over **stdio** (standard LSP transport):

```bash
node server.js --stdio
```

## Editor Integration

### VS Code

A complete VS Code extension is included in `editors/vscode/`.

```bash
cd editors/vscode
npm install
# Then symlink or copy to ~/.vscode/extensions/eagle-scripting-language
```

Or install the VSIX (if packaged):
```bash
npx vsce package
code --install-extension eagle-scripting-language-1.0.3.vsix
```

### Neovim (via nvim-lspconfig)

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')

if not configs.eagle then
  configs.eagle = {
    default_config = {
      cmd = { 'node', '/path/to/eagle-lsp/server.js', '--stdio' },
      filetypes = { 'eagle', 'tcl' },
      root_dir = lspconfig.util.find_git_ancestor,
      settings = {},
    },
  }
end

lspconfig.eagle.setup({})
```

### Emacs (via lsp-mode)

```elisp
(require 'lsp-mode)

(lsp-register-client
 (make-lsp-client
  :new-connection (lsp-stdio-connection '("node" "/path/to/eagle-lsp/server.js" "--stdio"))
  :major-modes '(tcl-mode)
  :server-id 'eagle-ls))

(add-hook 'tcl-mode-hook #'lsp)
```

### Sublime Text (via LSP package)

In LSP Settings:
```json
{
  "clients": {
    "eagle": {
      "enabled": true,
      "command": ["node", "/path/to/eagle-lsp/server.js", "--stdio"],
      "selector": "source.tcl"
    }
  }
}
```

### Helix

In `~/.config/helix/languages.toml`:
```toml
[[language]]
name = "eagle"
scope = "source.eagle"
file-types = ["eagle", "eg", "tcl"]
language-servers = ["eagle-ls"]

[language-server.eagle-ls]
command = "node"
args = ["/path/to/eagle-lsp/server.js", "--stdio"]
```

## Architecture & how it works

There are two distinct phases — **build time** (when the documentation
data is regenerated from the Eagle docs) and **runtime** (when the LSP
server answers requests from an editor):

```text
                       BUILD TIME                            RUNTIME
                       ==========                            =======

  EAGLE_COMMAND_REFERENCE.md   ┐
  HTML command reference        ├─►  extract_docs.py  ─►  data/eagle_commands.json    ─┐
  commands.json (structured)   ┘                                                       │
                                                                                       │  load
  core_script_library.md        ─►  data/extract.py   ─►  data/eagle_procedures.json  ─┤
                                                                                       ▼
                                                                                  eagle-data.js
                                                                                       │
                                                                                       │  query
                                                                                       ▼
   editor (VS Code / Neovim / ...)  ──── LSP over stdio ────►   server.js
                                                                  │
                                                                  ├──► eagle-parser.js
                                                                  │     (per-document
                                                                  │      tokenize + parse)
                                                                  ▼
                                                          response (completion,
                                                          hover, diagnostics, ...)
```

### Build time — populating the data

- **`extract_docs.py`** and **`data/extract.py`** read the Eagle
  documentation in its source forms (the Markdown command reference,
  the HTML per-command pages, and a structured `commands.json` from
  the Eagle docs repository) and produce two JSON files under
  `data/`: `eagle_commands.json` (120+ built-in commands, with their
  subcommands / options / synopses / examples) and
  `eagle_procedures.json` (135+ library procedures with their
  signatures and brief descriptions). These extractors run when the
  Eagle docs are updated; they are not invoked at runtime.
- See [`PIPELINE.md`](PIPELINE.md) for the full source-of-truth
  chain, per-field provenance, and the step-by-step checklist for
  adding or updating a command so every layer stays in sync.

### Runtime — answering LSP requests

1. **`server.js`** is launched as a child process by an LSP-aware
   editor and speaks JSON-RPC over stdio via the
   `vscode-languageserver/node` connection. On `initialize` it calls
   `eagleData.load()` and advertises its capabilities.
2. **`eagle-data.js`** reads the two JSON files into in-memory `Map`s
   (`commands`, `procedures`, plus derived indexes used by completion
   and hover). It is loaded once and shared across every request.
3. **`eagle-parser.js`** tokenizes and parses one document at a time.
   It tracks quote state, bracket nesting, line continuations, and
   escape handling — the subtle parts of Tcl-like syntax — and exposes
   helpers for the LSP handlers (`getWordAtPosition`,
   `getCommandContext`, `findVariables`, `findProcedures`,
   `findMatchingBrace`).  **`eagle-brace.js`** is the other half of
   diagnostics: a dependency-free brace/bracket balance scanner that
   `validateDocument` runs alongside the parser; it also exports the
   shared `endsInLineContinuation` helper so both passes agree on
   Tcl's line-continuation and comment-position rules.
4. **`server.js` handlers** (one per LSP method —
   `textDocument/completion`, `.../hover`, `.../signatureHelp`,
   `.../documentSymbol`, `.../definition`, `.../references`,
   `.../foldingRange`, plus document-lifecycle and
   diagnostics-publishing handlers) each combine the static data from
   step 2 with the per-document parse from step 3 to produce a
   response.

The VS Code extension under `editors/vscode/` (`extension.js`) is the
client side — it activates on Eagle file types, launches `server.js`,
keeps the LSP client lifecycle in sync with the editor, and contributes
the syntax-highlighting grammar (`syntaxes/eagle.tmLanguage.json`) and
language configuration (brackets, comments, auto-indent).

## Repository layout

```text
eagle-lsp/
├── server.js                   # Main LSP server (Node.js)
├── eagle-data.js               # Documentation data loader
├── eagle-parser.js             # Eagle/Tcl tokenizer and parser
├── eagle-brace.js              # Brace/bracket balance scanner (diagnostics pass one)
├── test/
│   └── eagle-brace.test.js     # Scanner unit tests (node --test)
├── data/
│   ├── eagle_commands.json     # 120+ built-in commands with full docs
│   ├── eagle_procedures.json   # 135+ library procedures
│   └── extract.py              # JSON builder used at build time
├── extract_docs.py             # Doc-extraction driver (build time)
├── editors/
│   └── vscode/                 # VS Code extension
│       ├── extension.js
│       ├── package.json
│       ├── language-configuration.json
│       └── syntaxes/eagle.tmLanguage.json
├── demo/
│   └── index.html              # Self-contained browser demo
├── scripts/
│   └── package-vsix.sh         # Packaging helper for the VSIX
└── README.md                   # this file
```

## Limitations and non-goals

The server is intentionally focused on **single-file** static analysis
of Eagle source. The following are out of scope for the current design:

- **No cross-file / workspace symbol resolution.** Definitions and
  references are scoped to the active document. Procs declared in
  other files are not currently indexed.
- **No execution.** The server never runs the Eagle interpreter; it
  is a pure static analyzer driven by a documentation snapshot and
  the per-document parse.
- **`unknown command` is a hint, not an error.** It is suppressed for
  variable substitutions, bracketed sub-commands, namespaced names,
  and procs defined later in the same file, but false positives can
  still occur (for example, packages loaded conditionally at runtime
  whose procs the parser cannot see).
- **No code formatter.** The server exposes folding ranges and
  diagnostics; whitespace and indentation normalization are left to
  the editor.
- **Diagnostics are syntactic, not semantic.** Type / value / safety
  analysis is out of scope.
- **Library proc data is a build-time snapshot.** Procs from
  out-of-tree packages or runtime-defined procs are discovered
  per-file by the parser; if they aren't visible in the current
  document, completion and hover will not know about them.

These boundaries keep the server small, fast, and editor-agnostic;
they also map cleanly to what an LSP can usefully provide without an
embedded interpreter.

## Demo

A self-contained, no-install browser demo lives at `demo/index.html`.
Open it directly in a browser to exercise the same data and parser the
server uses (no LSP wiring required) — useful for previewing what the
server "knows" about a given Eagle snippet, or for sharing a quick
illustration without the editor-side setup.

## Data sources

Command documentation is extracted from:

- The [Eagle documentation repository](https://github.com/mistachkin/docs)
  (the canonical Markdown reference).
- The Eagle HTML command reference pages.
- A structured `commands.json` of command metadata.

When the upstream Eagle docs change, regenerate the JSON under `data/`
by re-running `extract_docs.py` / `data/extract.py` against the
updated sources. The committed JSON files are the source of truth at
runtime.

## Developer notes

Every function in this repo carries an inline doc block matching the
[Eagle script-library `# <help>` convention](https://github.com/mistachkin/docs)
in spirit, but rendered in the language's own native form:

- **JavaScript** (`server.js`, `eagle-parser.js`, `eagle-data.js`,
  `editors/vscode/extension.js`) — JSDoc `/** ... */` blocks above
  each function / method / LSP handler, with `@param` and `@returns`
  tags. LSP handlers are labeled with the LSP method they implement
  (e.g. `textDocument/completion`).
- **Python** (`extract_docs.py`, `data/extract.py`) — PEP 257
  triple-quoted docstrings (Google style: `Args:` / `Returns:` /
  `Raises:` sections).

Each block follows the same depth — what the function does, why it
exists, how it works, any tricky details (parser state machine
quirks, HTML/markdown extraction edge cases, VS Code activation
lifecycle), then the per-parameter and return-value detail. This
makes the source navigable directly in an editor without bouncing to
external documentation.

If you are extending the server, the natural entry points are:

- A new **LSP feature** → add a `connection.onXxx(...)` handler near
  the others in `server.js`, hand off to `parser` for per-document
  analysis and `data` for static lookup.
- A new **Eagle syntactic construct** → extend the tokenizer in
  `eagle-parser.js`; the existing functions are state-machine-style
  and the JSDoc calls out the invariants you need to preserve.
- A new **documented command or procedure** → either add it upstream
  in the Eagle docs and re-run the extractor, or extend the JSON
  directly under `data/` for a quick local override.

## License

MIT
