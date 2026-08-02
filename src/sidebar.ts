import * as path from 'path';
import * as vscode from 'vscode';
import { DeadExport, DeadExportKind } from './engine';

type TreeNode = FileNode | ExportNode;

class FileNode {
  readonly kind = 'file' as const;
  constructor(public readonly fileName: string, public readonly exports: DeadExport[]) {}
}

class ExportNode {
  readonly kind = 'export' as const;
  constructor(public readonly deadExport: DeadExport) {}
}

export class DeadweightTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private byFile = new Map<string, DeadExport[]>();

  setAll(all: Map<string, DeadExport[]>): void {
    this.byFile = all;
    this.emitter.fire();
  }

  getTotalCount(): number {
    let total = 0;
    for (const list of this.byFile.values()) total += list.length;
    return total;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(
        path.basename(element.fileName),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = `${element.exports.length} unused`;
      item.resourceUri = vscode.Uri.file(element.fileName);
      item.tooltip = element.fileName;
      item.contextValue = 'deadFile';
      return item;
    }

    const d = element.deadExport;
    const item = new vscode.TreeItem(d.name, vscode.TreeItemCollapsibleState.None);
    item.description = `${d.kind} · line ${d.line + 1}`;
    item.iconPath = new vscode.ThemeIcon(iconFor(d.kind));
    item.tooltip = `${d.name} — no references outside ${path.basename(d.fileName)}`;
    item.contextValue = 'deadExport';
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [
        vscode.Uri.file(d.fileName),
        { selection: new vscode.Range(d.line, d.column, d.line, d.column + d.name.length) },
      ],
    };
    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return [...this.byFile.entries()]
        .filter(([, list]) => list.length > 0)
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map(([fileName, list]) => new FileNode(fileName, list));
    }
    if (element.kind === 'file') {
      return [...element.exports]
        .sort((a, b) => a.line - b.line)
        .map((d) => new ExportNode(d));
    }
    return [];
  }
}

/** Matches the symbol icons VS Code uses elsewhere, so the tree reads at a glance. */
function iconFor(kind: DeadExportKind): string {
  switch (kind) {
    case 'function':
      return 'symbol-function';
    case 'class':
      return 'symbol-class';
    case 'interface':
      return 'symbol-interface';
    case 'type':
      return 'symbol-parameter';
    case 'enum':
      return 'symbol-enum';
    case 'variable':
      return 'symbol-variable';
    case 'reexport':
      return 'references';
    default:
      return 'symbol-misc';
  }
}
