/**
 * VS Code extension entry point for Eagle Scripting Language.
 */
const fs = require('fs');
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
  let candidate;

  switch (process.platform) {
    case 'win32': {
      const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
      candidate = path.join(programFiles, 'Eagle', 'bin');
      break;
    }
    case 'darwin': {
      // Apple Silicon uses /opt/homebrew; Intel uses /usr/local.
      const homebrewPrefix = process.arch === 'arm64'
        ? '/opt/homebrew'
        : '/usr/local';
      candidate = path.join(homebrewPrefix, 'opt', 'eagle', 'libexec', 'bin');
      break;
    }
    case 'linux':
      candidate = '/usr/lib/eagle/bin';
      break;
    default:
      return '';
  }

  // Only return the default if EagleShell.dll actually exists there.
  if (fs.existsSync(path.join(candidate, 'EagleShell.dll'))) {
    return candidate;
  }
  return '';
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
    const configuredDir = shellConfig.get('shell.binaryDir');
    const binaryDir = configuredDir || getDefaultBinaryDir();

    if (!binaryDir) {
      vscode.window.showErrorMessage(
        'Eagle binary directory could not be determined. ' +
        'Please set "eagle.shell.binaryDir" in your settings.'
      );
      return;
    }

    const shellDll = path.join(binaryDir, 'EagleShell.dll');

    if (!fs.existsSync(shellDll)) {
      if (configuredDir) {
        vscode.window.showErrorMessage(
          `EagleShell.dll not found in configured directory "${binaryDir}". ` +
          'Please verify the "eagle.shell.binaryDir" setting.'
        );
      } else {
        vscode.window.showErrorMessage(
          `EagleShell.dll not found at "${shellDll}". ` +
          'Please set "eagle.shell.binaryDir" in your settings to the directory containing EagleShell.dll.'
        );
      }
      return;
    }

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
