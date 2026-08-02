import * as vscode from 'vscode';
import { DeadExport, normalize } from './engine';

/**
 * Quick-fix actions for dead exports.
 *
 * This deliberately is *not* a CodeLens provider any more. VS Code renders a
 * CodeLens on its own line above the declaration - there is no API to place one
 * inline - which pushed every dead export's code down a line and made a file
 * with several of them jump around on every scan.
 *
 * Code actions surface in the same places without moving any code: the lightbulb
 * beside the line, Ctrl+. , and the Problems panel entry.
 */
export class DeadweightActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  private deadExportsByFile = new Map<string, DeadExport[]>();

  setDeadExports(fileName: string, deadExports: DeadExport[]): void {
    this.deadExportsByFile.set(normalize(fileName), deadExports);
  }

  clear(): void {
    this.deadExportsByFile.clear();
  }

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    const deadExports = this.deadExportsByFile.get(normalize(document.fileName)) ?? [];
    const actions: vscode.CodeAction[] = [];

    for (const d of deadExports) {
      if (d.line >= document.lineCount) continue;
      // Offer the action when the cursor is anywhere on the declaration's line,
      // not just exactly on the identifier - matching where the hover appears.
      if (d.line < range.start.line || d.line > range.end.line) continue;

      const remove = new vscode.CodeAction(`Remove unused export '${d.name}'`, vscode.CodeActionKind.QuickFix);
      remove.command = {
        title: 'Remove',
        command: 'deadweight.deleteExport',
        // Offsets are deliberately not passed: they go stale between scan and
        // click, and the delete command re-derives the range from live text.
        arguments: [{ fileName: d.fileName, name: d.name }],
      };
      actions.push(remove);

      const ignore = new vscode.CodeAction(`Ignore '${d.name}'`, vscode.CodeActionKind.QuickFix);
      ignore.command = {
        title: 'Ignore',
        command: 'deadweight.ignoreExport',
        arguments: [{ fileName: d.fileName, name: d.name }],
      };
      actions.push(ignore);
    }

    return actions;
  }
}
