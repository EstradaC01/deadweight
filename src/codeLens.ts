import * as vscode from 'vscode';
import { DeadExport } from './engine';

export class DeadweightCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  private deadExportsByFile = new Map<string, DeadExport[]>();

  setDeadExports(fileName: string, deadExports: DeadExport[]): void {
    this.deadExportsByFile.set(fileName, deadExports);
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const deadExports = this.deadExportsByFile.get(document.fileName) ?? [];
    return deadExports.map((d) => {
      const range = new vscode.Range(d.line, d.column, d.line, d.column + d.name.length);
      return new vscode.CodeLens(range, {
        title: '0 references — unused export',
        command: 'deadweight.deleteExport',
        arguments: [{ fileName: d.fileName, name: d.name, start: d.start, end: d.end }],
      });
    });
  }
}
