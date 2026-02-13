/**
 * VS Code extension entry point for Eagle Scripting Language.
 */
const path = require('path');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

function activate(context) {
  // Determine server path
  const config = require('vscode').workspace.getConfiguration('eagle');
  let serverModule = config.get('server.path');
  if (!serverModule) {
    // Default: bundled server (two directories up from this extension)
    serverModule = path.join(__dirname, '..', '..', 'server.js');
  }

  const serverOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: { module: serverModule, transport: TransportKind.stdio },
  };

  const clientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'eagle' },
      { scheme: 'file', language: 'tcl' },
      { scheme: 'untitled', language: 'eagle' },
    ],
  };

  client = new LanguageClient(
    'eagleLanguageServer',
    'Eagle Language Server',
    serverOptions,
    clientOptions
  );

  client.start();
}

function deactivate() {
  if (client) {
    return client.stop();
  }
}

module.exports = { activate, deactivate };
