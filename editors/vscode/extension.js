/**
 * VS Code extension entry point for Eagle Scripting Language.
 */
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

/**
 * Compute the platform-specific default directory expected to contain
 * EagleShell.dll, returning the empty string when nothing plausible exists.
 *
 * This helper exists so the "Open Eagle Shell" command can work out-of-the-box
 * for users who have installed Eagle to a conventional location, without
 * forcing them to configure the "eagle.shell.binaryDir" setting first.  The
 * candidate directory is chosen per platform using the well-known install
 * layouts produced by the official packaging:
 *
 *   - Windows: %ProgramFiles%\Eagle\bin (using the ProgramFiles environment
 *     variable when present, otherwise falling back to the hard-coded
 *     "C:\Program Files" prefix).
 *   - macOS:   the Homebrew "libexec/bin" path, choosing the Apple Silicon
 *     prefix ("/opt/homebrew") when process.arch reports "arm64" and the
 *     Intel prefix ("/usr/local") otherwise.
 *   - Linux:   the distribution package layout "/usr/lib/eagle/bin".
 *   - Other:   no default is attempted; the empty string is returned.
 *
 * Tricky details: the function intentionally probes for EagleShell.dll inside
 * the candidate directory with fs.existsSync before returning the path.  If
 * the binary is absent the empty string is returned so the caller can fall
 * back to an explicit user-friendly error rather than silently producing a
 * terminal that will fail to launch dotnet.  This means a configured-but-empty
 * directory will not be hidden behind a phantom "default".
 *
 * Use cases: invoked from the "eagle.openShell" command handler when no
 * explicit "eagle.shell.binaryDir" setting is configured.
 *
 * @returns {string} Absolute path to the directory that contains
 *   EagleShell.dll, or the empty string when no suitable default can be
 *   located (including when the platform is unrecognized or the expected
 *   file is missing).
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

/**
 * VS Code extension activation entry point for the Eagle language client.
 *
 * Called by VS Code exactly once when the extension is first needed (per the
 * activation events declared in package.json, typically when an Eagle or Tcl
 * file is opened or when the "eagle.openShell" command is invoked).  This
 * function performs all one-time setup required to make Eagle support work in
 * the editor: it resolves the language server module path, constructs and
 * starts the LanguageClient, and registers the "Open Eagle Shell" command.
 *
 * What it does, in order:
 *
 *   1. Resolves the server module path.  The user may override the bundled
 *      server by setting "eagle.server.path" in their configuration; when
 *      that setting is empty the code falls back to "../../server.js"
 *      relative to this extension's own directory, which is where the
 *      bundled LSP server lives in the published layout (the extension is
 *      shipped two directories deep under "editors/vscode").
 *   2. Builds a serverOptions object that launches the same module for both
 *      the "run" and "debug" entries, using TransportKind.stdio so the
 *      server communicates over its stdin/stdout streams.  Sharing the
 *      "run" and "debug" entries means the language server cannot itself
 *      be debugged with the standard debug-mode incantation; this is a
 *      deliberate simplification.
 *   3. Builds a clientOptions documentSelector that activates the client
 *      for three document kinds: file-scheme documents with language id
 *      "eagle", "tcl", or "th8", and untitled documents with language id
 *      "eagle".  Registering for "tcl" and "th8" lets Eagle features
 *      apply to plain Tcl or TH8 files (Eagle is a mostly a superset of
 *      Tcl 8.4), while only "eagle" is recognized for brand new untitled
 *      buffers to avoid hijacking unsaved Tcl scratch buffers from other
 *      extensions.
 *   4. Constructs the LanguageClient with the identifier
 *      "eagleLanguageServer" and a human readable name, then calls
 *      client.start() to spin up the server and begin negotiating the LSP
 *      protocol.
 *   5. Registers the "eagle.openShell" command.  Its handler resolves the
 *      EagleShell.dll location (preferring the configured directory, then
 *      the platform default), validates it, and creates a VS Code terminal
 *      that runs "dotnet exec EagleShell.dll".  All error paths produce a
 *      tailored vscode.window.showErrorMessage so the user can tell
 *      whether the configured directory is wrong or whether they simply
 *      need to set the setting in the first place.
 *   6. Pushes the command disposable into context.subscriptions so that
 *      VS Code can clean it up automatically when the extension is
 *      deactivated.
 *
 * Tricky details: the module-level "client" variable is assigned here and
 * later read by deactivate(); the two functions intentionally share state
 * via this closure rather than going through context.  The LanguageClient
 * is NOT pushed into context.subscriptions because the explicit deactivate
 * hook below uses client.stop() to perform an orderly shutdown that returns
 * a Thenable for VS Code to await.
 *
 * Use cases: any time VS Code decides the extension is needed (file open,
 * command invocation, etc.).
 *
 * @param {vscode.ExtensionContext} context - The activation context provided
 *   by VS Code.  Used to register disposables that should live as long as
 *   the extension is active.
 * @returns {void} This function does not return a value; activation success
 *   is signaled by completing without throwing.
 */
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
      { scheme: 'file', language: 'th8' },
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
  /**
   * Handler for the "eagle.openShell" VS Code command.
   *
   * Opens an integrated terminal that runs "dotnet exec EagleShell.dll" so
   * the user gets a live interactive Eagle shell hosted inside the editor.
   * It resolves the EagleShell.dll location with a two-tier strategy:
   * first honor the explicit "eagle.shell.binaryDir" workspace setting,
   * and only when that is unset fall back to getDefaultBinaryDir() for the
   * conventional install path for the current platform.
   *
   * When the directory cannot be determined at all (no setting, no
   * platform default), or when EagleShell.dll is missing from the
   * directory that was determined, the handler bails out with a tailored
   * error message: a "set the setting" message when no directory was
   * configured, and a "verify the setting" message when the user
   * explicitly pointed at a directory that does not contain the DLL.
   * Distinguishing the two cases makes the error actionable.
   *
   * Tricky details: the terminal is created with shellPath set to "dotnet"
   * and shellArgs set to ["exec", shellDll].  This relies on the .NET CLI
   * being on PATH; if it is not, the terminal will open but immediately
   * report a missing command.  We deliberately do not validate "dotnet"
   * here because the terminal already surfaces that error verbatim.
   *
   * Use cases: invoked from the command palette, from a keybinding bound
   * to "eagle.openShell", or from any other UI affordance that runs the
   * command.
   *
   * @returns {void} No value; side effects are the terminal creation and
   *   show, or an error message.
   */
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

/**
 * VS Code extension deactivation hook for the Eagle language client.
 *
 * Called by VS Code when the extension is being unloaded -- typically at
 * window shutdown, when the extension is disabled, or when it is being
 * reloaded -- to give it a chance to release resources and perform an
 * orderly shutdown.  This implementation stops the LanguageClient that
 * activate() previously started, which closes the LSP connection and
 * terminates the child server process.
 *
 * VS Code awaits the returned Thenable before completing the deactivation
 * step, so returning client.stop() here matters: it makes the shutdown
 * actually wait for the server to exit cleanly rather than letting the
 * process get killed mid-message.  When client is undefined (which would
 * indicate that activate() was never called, an unusual but defensible
 * case) the function returns undefined and VS Code proceeds immediately.
 *
 * @returns {Thenable<void> | undefined} A Thenable that resolves once the
 *   language client has fully stopped, or undefined when no client was
 *   ever created.
 */
function deactivate() {
  if (client) {
    return client.stop();
  }
}

module.exports = { activate, deactivate };
