import * as vscode from 'vscode';
import { DeadExport } from './engine';

/**
 * The inline note sits at the end of the declaration's own line, so the actions
 * read as annotation *beside* the code rather than a banner above it. A CodeLens
 * cannot do this - VS Code only renders those on a line of their own.
 */
const decorationType = vscode.window.createTextEditorDecorationType({
  isWholeLine: false,
  after: {
    color: new vscode.ThemeColor('editorCodeLens.foreground'),
    fontStyle: 'italic',
    margin: '0 0 0 1.5rem',
  },
  // Dimming the symbol itself is the signal editors already use for unreachable
  // code, so the line reads as dead even before the note is noticed.
  opacity: '0.72',
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

export function applyDecorations(editor: vscode.TextEditor, deadExports: DeadExport[]): void {
  const lineCount = editor.document.lineCount;

  const ranges: vscode.DecorationOptions[] = deadExports
    // A scan can land after the document shrank; a stale line number would throw
    // out of lineAt and lose every decoration in the file.
    .filter((d) => d.line < lineCount)
    .map((d) => {
      const lineText = editor.document.lineAt(d.line).text;
      const endOfLine = new vscode.Position(d.line, lineText.length);

      return {
        range: new vscode.Range(endOfLine, endOfLine),
        hoverMessage: buildHover(d),
        renderOptions: {
          after: { contentText: `unused ${d.kind} — remove · ignore` },
        },
      };
    });

  editor.setDecorations(decorationType, ranges);
}

/**
 * Command links need `isTrusted`, and the payload must be URI-encoded JSON.
 * Only the two Deadweight commands are trusted, never a blanket `true` - the
 * hover text embeds a symbol name that comes from the user's source.
 */
function buildHover(d: DeadExport): vscode.MarkdownString {
  const args = encodeURIComponent(JSON.stringify([{ fileName: d.fileName, name: d.name }]));
  const hover = new vscode.MarkdownString();
  hover.isTrusted = {
    enabledCommands: ['deadweight.deleteExport', 'deadweight.ignoreExport'],
  };
  hover.appendMarkdown(
    `**${escapeMarkdown(d.name)}** — ${describeKind(d.kind)} with zero references outside this file.\n\n` +
      `[$(trash) Remove](command:deadweight.deleteExport?${args} "Re-checks that it is still unused, then deletes the whole declaration")` +
      ` &nbsp;|&nbsp; ` +
      `[$(eye-closed) Ignore](command:deadweight.ignoreExport?${args} "Stop reporting this export")`,
  );
  hover.supportThemeIcons = true;
  return hover;
}

/** A symbol name can contain `_` or `*`, which would otherwise italicise the hover. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}

export function clearDecorations(editor: vscode.TextEditor): void {
  editor.setDecorations(decorationType, []);
}

export function disposeDecorations(): void {
  decorationType.dispose();
}

function describeKind(kind: DeadExport['kind']): string {
  switch (kind) {
    case 'function':
      return 'function';
    case 'class':
      return 'class';
    case 'interface':
      return 'interface';
    case 'type':
      return 'type alias';
    case 'enum':
      return 'enum';
    case 'variable':
      return 'value';
    case 'reexport':
      return 're-export';
    default:
      return 'symbol';
  }
}
