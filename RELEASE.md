# Release Guide

How to build, package, and publish the Eagle Scripting Language extension for VS Code.

## Prerequisites

- **Node.js** 18 or later
- **npm** (included with Node.js)

The packaging script will automatically install `@vscode/vsce` via `npx`.

## Building from Source

1. Clone the repository and install server dependencies:

   ```bash
   git clone <this-repo>
   cd eagle-lsp
   npm install
   ```

2. Install the VS Code extension client dependencies:

   ```bash
   cd editors/vscode
   npm install
   ```

3. Verify the server starts correctly:

   ```bash
   node server.js --stdio
   ```

   Press `Ctrl+C` to stop. If the server starts without errors, you are ready
   to package.

## Packaging the VSIX

Run the build script from the repository root:

```bash
bash scripts/package-vsix.sh
```

This script:

1. Creates a clean `build/` staging directory.
2. Copies extension client files (syntaxes, icons, language config) into `build/`.
3. Installs source dependencies needed for bundling.
4. Bundles `extension.js` with esbuild (inlines `vscode-languageclient`; `vscode` is external).
5. Bundles `server.js` with esbuild (inlines `eagle-parser.js`, `eagle-data.js`, `eagle-brace.js`, and server dependencies).
6. Copies runtime data files (`data/*.json`) alongside the server bundle.
7. Generates a `package.json` with no runtime dependencies (everything is bundled).
8. Runs `npx @vscode/vsce package` to produce the `.vsix` file.
9. Copies the resulting `.vsix` back to the repository root.

On success you will see output like:

```
VSIX created: eagle-scripting-language-1.0.4.vsix
```

## Installing Locally

Install the extension from the generated `.vsix` file:

```bash
code --install-extension eagle-scripting-language-1.0.4.vsix
```

Then reload VS Code and open any `.eagle`, `.tcl`, or `.th8` file to verify
that syntax highlighting and LSP features (hover, completion, diagnostics)
are working.

## Publishing

Every release is published to **both** extension registries, in either
order, with the same VSIX:

- the **Microsoft VS Code Marketplace** (VS Code itself), and
- the **Open VSX Registry** (<https://open-vsx.org>) — used by VSCodium,
  code-server, Gitpod, Eclipse Theia, and other non-Microsoft builds,
  which cannot access the Microsoft marketplace.

### VS Code Marketplace

First-time setup:

1. Create a publisher account at
   <https://marketplace.visualstudio.com/manage>.
2. Generate a Personal Access Token (PAT) with the **Marketplace (Manage)**
   scope.

Publish:

```bash
cd build
npx @vscode/vsce publish
```

You will be prompted for your PAT. Alternatively, log in first:

```bash
npx @vscode/vsce login MistachkinSystems
npx @vscode/vsce publish
```

### Open VSX Registry

First-time setup:

1. Log in at <https://open-vsx.org> (GitHub account) and sign the Eclipse
   Foundation publisher agreement (Profile > Settings).
2. Generate an access token (Profile > Settings > Access Tokens).
3. Create the publisher namespace once:

   ```bash
   npx ovsx create-namespace MistachkinSystems -p <token>
   ```

Publish the same VSIX that went to the Marketplace:

```bash
cd build
npx ovsx publish eagle-scripting-language-<version>.vsix -p <token>
```

Open VSX requires a license; this extension's MIT `LICENSE` is copied into
the package by the build script, so no extra steps are needed.

### Release Checklist (Updating the Version)

The version lives in more places than the extension manifest.  For a
release `X.Y.Z`:

1. **CHANGELOG.md** — retitle `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`
   (start a fresh `[Unreleased]` section with the next change).
2. **Package versions** — updates `package.json` and `package-lock.json`
   in both places:

   ```bash
   npm version X.Y.Z --no-git-tag-version
   (cd editors/vscode && npm version X.Y.Z --no-git-tag-version)
   ```

3. **`server.js`** — the `serverInfo.version` reported in the `initialize`
   response.
4. **Docs** — the literal `eagle-scripting-language-X.Y.Z.vsix` filenames
   in this file and in `README.md`.
5. **Verify** — `npm test`, then `bash scripts/package-vsix.sh`, then
   confirm the artifact:

   ```bash
   unzip -p eagle-scripting-language-X.Y.Z.vsix extension/package.json | grep '"version"'
   ```

6. **Commit, tag, push** — CI re-runs the cross-platform test matrix and
   builds the VSIX as an artifact on the push.
7. **Publish to both registries** using the sections above.

## Troubleshooting

### "Cannot find module 'vscode-languageclient/node'"

The esbuild bundling step failed, or the source dependencies were not installed.
Re-run `bash scripts/package-vsix.sh` and check for esbuild or npm errors in
the output. Ensure that `npm install` has been run in both the repository root
and `editors/vscode/` directories.

### "Cannot find module './server/server.js'"

The server files were not copied into the staging directory. Verify that
`server.js`, `eagle-parser.js`, `eagle-data.js`, `eagle-brace.js`, and the
`data/` directory all exist at the repository root.

### VSIX is missing server files

Inspect the VSIX contents:

```bash
unzip -l eagle-scripting-language-1.0.4.vsix | grep server
```

You should see entries like `extension/server/server.js`. If they are missing,
check that the `.vscodeignore` file is not excluding the `server/` directory.

### Extension activates but no LSP features

1. Open the Output panel in VS Code (`View > Output`).
2. Select "Eagle Language Server" from the dropdown.
3. Look for initialization messages or errors.
4. Ensure the file type is recognized (check the status bar shows "Eagle" or
   "Tcl" as the language).

### "ERROR: Missing publisher name"

Set the `publisher` field in `editors/vscode/package.json` to your marketplace
publisher ID before packaging.
