/**
 * VS Code extension entry point for Eagle Scripting Language.
 */
const path = require('path');
const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

/**
 * Returns the platform-specific default path to the directory containing
 * EagleShell.dll.  This is used when the user has not explicitly configured
 * the "eagle.shell.binaryDir" setting.
 *
 * - Windows: %ProgramFiles%\Eagle\bin  (via process.env, falls back to
 *            "C:\Program Files\Eagle\bin")
 * - macOS:   /opt/homebrew/opt/eagle/libexec/bin  (Apple Silicon) or
 *            /usr/local/opt/eagle/libexec/bin      (Intel)
 * - Linux:   /usr/lib/eagle/bin
 */
function getDefaultBinaryDir() {
  switch (process.platform) {
    case 'win32': {
      const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
      return path.join(programFiles, 'Eagle', 'bin');
    }
    case 'darwin': {
      // Apple Silicon uses /opt/homebrew; Intel uses /usr/local.
      const homebrewPrefix = process.arch === 'arm64'
        ? '/opt/homebrew'
        : '/usr/local';
      return path.join(homebrewPrefix, 'opt', 'eagle', 'libexec', 'bin');
    }
    case 'linux':
      return '/usr/lib/eagle/bin';
    default:
      return '';
  }
}

function activate(context) {
  // Determine server path
  const config = vscode.workspace.getConfiguration('eagle');
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

  // Register the Eagle Shell terminal command
  const openShellCmd = vscode.commands.registerCommand('eagle.openShell', () => {
    const shellConfig = vscode.workspace.getConfiguration('eagle');
    const binaryDir = shellConfig.get('shell.binaryDir') || getDefaultBinaryDir();

    if (!binaryDir) {
      vscode.window.showErrorMessage(
        'Eagle binary directory could not be determined. ' +
        'Please set "eagle.shell.binaryDir" in your settings.'
      );
      return;
    }

    const shellDll = path.join(binaryDir, 'EagleShell.dll');

    const terminal = vscode.window.createTerminal({
      name: 'Eagle Shell',
      shellPath: 'dotnet',
      shellArgs: ['exec', shellDll],
    });

    terminal.show();
  });

  context.subscriptions.push(openShellCmd);
}

function deactivate() {
  if (client) {
    return client.stop();
  }
}

module.exports = { activate, deactivate };
