import * as vscode from 'vscode';
import { DeadExport } from './engine';

const decorationType = vscode.window.createTextEditorDecorationType({
  isWholeLine: false,
  after: {
    contentText: '  ⚠ unused export',
    color: new vscode.ThemeColor('editorWarning.foreground'),
    fontStyle: 'italic',
    margin: '0 0 0 1rem',
  },
  gutterIconPath: undefined,
});

export function applyDecorations(editor: vscode.TextEditor, deadExports: DeadExport[]): void {
  const ranges: vscode.DecorationOptions[] = deadExports.map((d) => {
    const lineText = editor.document.lineAt(d.line).text;
    const endOfLine = new vscode.Position(d.line, lineText.length);
    return {
      range: new vscode.Range(endOfLine, endOfLine),
      hoverMessage: `**${d.name}** has zero references anywhere else in the workspace.`,
    };
  });
  editor.setDecorations(decorationType, ranges);
}

export function clearDecorations(editor: vscode.TextEditor): void {
  editor.setDecorations(decorationType, []);
}
