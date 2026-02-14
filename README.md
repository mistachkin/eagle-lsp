# Eagle Language Server

A [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) (LSP) implementation for the **Eagle** scripting language (Extensible Adaptable Generalized Logic Engine — a Tcl implementation for the CLR).

## Features

| Feature | Description |
|---------|-------------|
| **Completion** | Commands (120), subcommands, options, library procedures (135+), variables, user procs |
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
code --install-extension eagle-scripting-language-1.0.1.vsix
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

## Architecture

```
eagle-lsp/
├── server.js              # Main LSP server (Node.js)
├── eagle-data.js          # Documentation data loader
├── eagle-parser.js        # Eagle/Tcl tokenizer and parser
├── data/
│   ├── eagle_commands.json    # 120 built-in commands with full docs
│   └── eagle_procedures.json  # 135+ library procedures
├── editors/
│   └── vscode/            # VS Code extension
│       ├── extension.js
│       ├── package.json
│       ├── language-configuration.json
│       └── syntaxes/eagle.tmLanguage.json
└── extract_docs.py        # Documentation extraction script
```

## Data Sources

Command documentation is extracted from:
- [Eagle documentation repository](https://github.com/mistachkin/docs)
- Eagle HTML command reference pages
- `commands.json` structured command metadata

## License

MIT
