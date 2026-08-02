import * as vscode from 'vscode';
import { DeadExport, DeadweightEngine } from './engine';
import { applyDecorations, clearDecorations } from './decorations';
import { DeadweightCodeLensProvider } from './codeLens';
import { DeadweightTreeProvider } from './sidebar';

const SUPPORTED_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);

let engine: DeadweightEngine | undefined;
let statusBarItem: vscode.StatusBarItem;
let codeLensProvider: DeadweightCodeLensProvider;
let treeProvider: DeadweightTreeProvider;
let refreshTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const config = vscode.workspace.getConfiguration('deadweight');
  engine = new DeadweightEngine(folder.uri.fsPath, {
    exclude: config.get<string[]>('exclude', []),
    ignoreBarrelFiles: config.get<boolean>('ignoreBarrelFiles', true),
  });

  codeLensProvider = new DeadweightCodeLensProvider();
  treeProvider = new DeadweightTreeProvider();
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'deadweight.refresh';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ language: 'typescript' }, { language: 'typescriptreact' }, { language: 'javascript' }, { language: 'javascriptreact' }],
      codeLensProvider,
    ),
    vscode.window.registerTreeDataProvider('deadweight.tree', treeProvider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deadweight.refresh', () => runFullScan()),
    vscode.commands.registerCommand('deadweight.deleteExport', (arg: { fileName: string; start: number; end: number }) =>
      deleteExport(arg),
    ),
    vscode.commands.registerCommand('deadweight.ignoreExport', (node: { deadExport?: DeadExport }) => {
      const target = node?.deadExport;
      if (!target || !engine) return;
      engine.setIgnored(`${target.fileName}#${target.name}`, true);
      runFullScan();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!SUPPORTED_LANGUAGES.has(doc.languageId)) return;
      engine?.invalidateFile(doc.fileName);
      scheduleRefresh(doc);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && SUPPORTED_LANGUAGES.has(editor.document.languageId)) {
        refreshEditor(editor);
      }
    }),
  );

  runFullScan();
}

function scheduleRefresh(doc: vscode.TextDocument): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.fileName === doc.fileName);
    if (editor) refreshEditor(editor);
    runFullScan();
  }, 300);
}

function refreshEditor(editor: vscode.TextEditor): void {
  if (!engine) return;
  const deadExports = engine.findDeadExportsInFile(editor.document.fileName);
  if (deadExports.length > 0) {
    applyDecorations(editor, deadExports);
  } else {
    clearDecorations(editor);
  }
  codeLensProvider.setDeadExports(editor.document.fileName, deadExports);
}

function runFullScan(): void {
  if (!engine) return;
  const all = engine.findDeadExportsInWorkspace();
  const byFile = new Map<string, DeadExport[]>();
  for (const d of all) {
    const list = byFile.get(d.fileName) ?? [];
    list.push(d);
    byFile.set(d.fileName, list);
  }
  treeProvider.setAll(byFile);

  const total = treeProvider.getTotalCount();
  statusBarItem.text = total === 0 ? '$(check) Deadweight: clean' : `$(warning) Deadweight: ${total} unused`;
  statusBarItem.show();

  for (const editor of vscode.window.visibleTextEditors) {
    if (SUPPORTED_LANGUAGES.has(editor.document.languageId)) {
      refreshEditor(editor);
    }
  }
}

async function deleteExport(arg: { fileName: string; start: number; end: number }): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(arg.fileName);
  const editor = await vscode.window.showTextDocument(doc);

  const startPos = doc.positionAt(arg.start);
  const line = doc.lineAt(startPos.line);
  const lineRange = new vscode.Range(
    line.range.start,
    doc.lineAt(Math.min(startPos.line + 1, doc.lineCount - 1)).range.start,
  );

  const confirm = await vscode.window.showWarningMessage(
    `Delete unused export on line ${startPos.line + 1}?`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') return;

  await editor.edit((builder) => builder.delete(lineRange));
  await doc.save();
}

export function deactivate(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
}
