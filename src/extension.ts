import * as vscode from 'vscode';
import { DeadExport, DeadweightEngine, normalize } from './engine';
import { applyDecorations, clearDecorations, disposeDecorations } from './decorations';
import { DeadweightActionProvider } from './actions';
import { DeadweightTreeProvider } from './sidebar';
import { DeadweightDashboard } from './dashboard';
import { ExportRef, findDeleteRange, resolveTarget } from './deleteRange';

const SUPPORTED_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);
const IGNORED_KEYS_STATE = 'deadweight.ignoredExports';

let engine: DeadweightEngine | undefined;
let statusBarItem: vscode.StatusBarItem;
let actionProvider: DeadweightActionProvider;
let treeProvider: DeadweightTreeProvider;
let diagnostics: vscode.DiagnosticCollection;
let extensionContext: vscode.ExtensionContext;

let refreshTimer: NodeJS.Timeout | undefined;
/** Cancels the in-flight workspace scan when a newer one supersedes it. */
let scanCancellation: vscode.CancellationTokenSource | undefined;
let scanning = false;
let rescanQueued = false;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;

  actionProvider = new DeadweightActionProvider();
  treeProvider = new DeadweightTreeProvider();
  diagnostics = vscode.languages.createDiagnosticCollection('deadweight');
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'deadweight.showDashboard';

  context.subscriptions.push(statusBarItem, diagnostics, { dispose: disposeDecorations });

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [...SUPPORTED_LANGUAGES].map((language) => ({ language })),
      actionProvider,
      { providedCodeActionKinds: DeadweightActionProvider.providedCodeActionKinds },
    ),
    vscode.window.registerTreeDataProvider('deadweight.tree', treeProvider),
  );

  registerCommands(context);
  registerListeners(context);

  createEngine();
  void runFullScan();
}

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('deadweight.refresh', () => runFullScan()),

    vscode.commands.registerCommand('deadweight.showDashboard', () => {
      if (!engine) return;
      DeadweightDashboard.show(context, lastDashboardData());
      void runFullScan();
    }),

    vscode.commands.registerCommand('deadweight.deleteExport', (arg: unknown) => {
      const target = resolveTarget(arg);
      if (!target) return;
      return deleteExport(target);
    }),

    vscode.commands.registerCommand('deadweight.ignoreExport', (arg: unknown) => {
      const target = resolveTarget(arg);
      if (!target || !engine) return;
      engine.setIgnored(`${normalize(target.fileName)}#${target.name}`, true);
      void persistIgnored();
      void runFullScan();
    }),

    vscode.commands.registerCommand('deadweight.clearIgnored', async () => {
      if (!engine) return;
      const count = engine.getIgnoredKeys().length;
      if (count === 0) {
        void vscode.window.showInformationMessage('Deadweight: no ignored exports.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Stop ignoring ${count} export${count === 1 ? '' : 's'}?`,
        { modal: true },
        'Clear',
      );
      if (confirm !== 'Clear') return;
      engine.setIgnoredKeys([]);
      await persistIgnored();
      void runFullScan();
    }),
  );
}

function registerListeners(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!SUPPORTED_LANGUAGES.has(doc.languageId)) return;
      engine?.invalidateFile(doc.fileName);
      scheduleRefresh();
    }),

    vscode.workspace.onDidChangeTextDocument((event) => {
      if (getConfig().get<string>('refreshOn', 'save') !== 'type') return;
      if (!SUPPORTED_LANGUAGES.has(event.document.languageId)) return;
      if (event.contentChanges.length === 0) return;
      // Feed the live buffer in so the service sees unsaved edits, then debounce
      // harder than the save path - a scan per keystroke would be unusable.
      engine?.updateFile(event.document.fileName, event.document.getText());
      scheduleRefresh(600);
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && SUPPORTED_LANGUAGES.has(editor.document.languageId)) {
        refreshEditor(editor);
      }
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // Root set changed: the old program's file list is stale, so rebuild.
      createEngine();
      void runFullScan();
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('deadweight')) return;
      if (
        event.affectsConfiguration('deadweight.exclude') ||
        event.affectsConfiguration('deadweight.ignoreBarrelFiles')
      ) {
        createEngine();
      }
      void runFullScan();
    }),
  );

  // Files can appear or vanish without any editor event - a branch switch, a
  // generator run, an external delete. Without this the program keeps stale
  // files and reports exports that no longer exist.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx}');
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate((uri) => {
      engine?.addFile(uri.fsPath);
      scheduleRefresh();
    }),
    watcher.onDidDelete((uri) => {
      engine?.removeFile(uri.fsPath);
      diagnostics.delete(uri);
      scheduleRefresh();
    }),
    watcher.onDidChange((uri) => {
      // Only matters for files changed on disk while not dirty in an editor;
      // the save handler already covers the in-editor case, and invalidating
      // twice is cheap next to missing an external write.
      engine?.invalidateFile(uri.fsPath);
      scheduleRefresh();
    }),
  );
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('deadweight');
}

function createEngine(): void {
  engine?.dispose();
  engine = undefined;

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    statusBarItem.hide();
    return;
  }

  const config = getConfig();
  try {
    engine = new DeadweightEngine(
      folders.map((f) => f.uri.fsPath),
      {
        exclude: config.get<string[]>('exclude', []),
        ignoreBarrelFiles: config.get<boolean>('ignoreBarrelFiles', true),
      },
    );
    const saved = extensionContext.workspaceState.get<string[]>(IGNORED_KEYS_STATE, []);
    if (saved.length) engine.setIgnoredKeys(saved);
  } catch (error) {
    void vscode.window.showErrorMessage(`Deadweight: failed to start - ${describe(error)}`);
  }
}

async function persistIgnored(): Promise<void> {
  if (!engine) return;
  await extensionContext.workspaceState.update(IGNORED_KEYS_STATE, engine.getIgnoredKeys());
}

function scheduleRefresh(delay = 300): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void runFullScan();
  }, delay);
}

function refreshEditor(editor: vscode.TextEditor): void {
  if (!engine) return;
  let deadExports: DeadExport[] = [];
  try {
    deadExports = engine.findDeadExportsInFile(editor.document.fileName);
  } catch {
    // A per-file analysis failure should leave the previous decorations alone
    // rather than flashing the file "clean".
    return;
  }

  if (deadExports.length > 0) applyDecorations(editor, deadExports);
  else clearDecorations(editor);

  actionProvider.setDeadExports(editor.document.fileName, deadExports);
  publishDiagnostics(editor.document.uri, deadExports);
}

function publishDiagnostics(uri: vscode.Uri, deadExports: DeadExport[]): void {
  if (!getConfig().get<boolean>('showDiagnostics', true)) {
    diagnostics.delete(uri);
    return;
  }
  diagnostics.set(
    uri,
    deadExports.map((d) => {
      const diag = new vscode.Diagnostic(
        new vscode.Range(d.line, d.column, d.line, d.column + d.name.length),
        `'${d.name}' is exported but never used outside this file.`,
        vscode.DiagnosticSeverity.Hint,
      );
      diag.source = 'deadweight';
      diag.tags = [vscode.DiagnosticTag.Unnecessary];
      return diag;
    }),
  );
}

let lastStats: import('./engine').FileStats[] = [];
let lastDead: DeadExport[] = [];

function lastDashboardData() {
  return {
    stats: lastStats,
    dead: lastDead,
    roots: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
  };
}

async function runFullScan(): Promise<void> {
  if (!engine) return;

  // Collapse overlapping scans: cancel the running one and remember that another
  // is wanted, so a burst of saves settles into exactly one final scan.
  if (scanning) {
    rescanQueued = true;
    scanCancellation?.cancel();
    return;
  }

  scanning = true;
  scanCancellation?.dispose();
  scanCancellation = new vscode.CancellationTokenSource();
  const token = scanCancellation.token;

  statusBarItem.text = '$(sync~spin) Deadweight: scanning…';
  statusBarItem.show();

  try {
    const result = await engine.scanWorkspace(token);
    if (token.isCancellationRequested) return;

    lastStats = result.stats;
    lastDead = result.dead;

    const byFile = new Map<string, DeadExport[]>();
    for (const d of result.dead) {
      const list = byFile.get(d.fileName) ?? [];
      list.push(d);
      byFile.set(d.fileName, list);
    }
    treeProvider.setAll(byFile);

    const total = result.dead.length;
    statusBarItem.text = total === 0 ? '$(check) Deadweight: clean' : `$(warning) Deadweight: ${total} unused`;
    statusBarItem.tooltip = buildTooltip(total, byFile.size, result.errored.length);
    statusBarItem.show();

    for (const editor of vscode.window.visibleTextEditors) {
      if (SUPPORTED_LANGUAGES.has(editor.document.languageId)) refreshEditor(editor);
    }

    DeadweightDashboard.refresh(lastDashboardData());
  } catch (error) {
    statusBarItem.text = '$(error) Deadweight: scan failed';
    statusBarItem.tooltip = describe(error);
    statusBarItem.show();
  } finally {
    scanning = false;
    if (rescanQueued) {
      rescanQueued = false;
      void runFullScan();
    }
  }
}

function buildTooltip(total: number, fileCount: number, erroredCount: number): string {
  if (total === 0) return 'No unused exports found. Click to open the workspace map.';
  const parts = [`${total} unused export${total === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'}`];
  if (erroredCount > 0) parts.push(`${erroredCount} file(s) could not be analyzed`);
  parts.push('Click to open the workspace map.');
  return parts.join('\n');
}

type DeleteArg = ExportRef;

/**
 * Deletes a dead export, re-deriving everything from the file's current text.
 *
 * The offsets in the CodeLens/tree arguments were captured at scan time and may
 * be stale by the time the user clicks. Trusting them is how you silently delete
 * the wrong line, so they are used for nothing here: the declaration is located
 * by name in the live AST, and the export is re-checked for liveness first.
 */
async function deleteExport(arg: DeleteArg): Promise<void> {
  if (!engine || !arg?.fileName || !arg?.name) return;

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(arg.fileName));
  } catch {
    void vscode.window.showErrorMessage(`Deadweight: could not open ${arg.fileName}.`);
    return;
  }

  // Re-verify against current content: an import added since the last scan must
  // block the delete.
  engine.updateFile(doc.fileName, doc.getText());
  let stillDead: DeadExport | undefined;
  try {
    stillDead = engine.findDeadExportsInFile(doc.fileName).find((d) => d.name === arg.name);
  } catch {
    void vscode.window.showErrorMessage(`Deadweight: could not analyze ${arg.name}.`);
    return;
  }

  if (!stillDead) {
    void vscode.window.showInformationMessage(
      `Deadweight: '${arg.name}' is now referenced (or no longer exists) - nothing deleted.`,
    );
    void runFullScan();
    return;
  }

  const target = findDeleteRange(doc.fileName, doc.getText(), arg.name);
  if (!target) {
    void vscode.window.showWarningMessage(`Deadweight: could not locate '${arg.name}' to delete.`);
    return;
  }

  const range = new vscode.Range(doc.positionAt(target.start), doc.positionAt(target.end));
  const preview = doc.getText(range).trim();
  const summary = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview;

  const confirm = await vscode.window.showWarningMessage(
    `Delete unused export '${arg.name}'?`,
    { modal: true, detail: summary },
    'Delete',
  );
  if (confirm !== 'Delete') return;

  // The document may have changed while the modal was up; re-derive rather than
  // applying a range computed against older text.
  const fresh = findDeleteRange(doc.fileName, doc.getText(), arg.name);
  if (!fresh || fresh.start !== target.start || fresh.end !== target.end) {
    void vscode.window.showWarningMessage(`Deadweight: '${arg.name}' changed while confirming - nothing deleted.`);
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.delete(doc.uri, range);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    void vscode.window.showErrorMessage(`Deadweight: the edit to remove '${arg.name}' was rejected.`);
    return;
  }

  engine.updateFile(doc.fileName, doc.getText());
  void runFullScan();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function deactivate(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
  scanCancellation?.cancel();
  scanCancellation?.dispose();
  scanCancellation = undefined;
  engine?.dispose();
  engine = undefined;
}
