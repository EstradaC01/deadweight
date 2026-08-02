import * as ts from 'typescript';

export interface DeleteTarget {
  /** Character offsets into the current file text. */
  start: number;
  end: number;
}

/** The minimum a command needs to locate an export; see resolveTarget. */
export interface ExportRef {
  fileName: string;
  name: string;
}

/**
 * Normalizes the argument shapes the delete/ignore commands are invoked with.
 *
 * The hover and code action pass `{fileName, name}` directly, while the sidebar
 * context menu passes the tree node (`{kind, deadExport}`). Handling only the
 * first shape is why right-clicking a sidebar entry used to do nothing at all -
 * the guard saw `fileName === undefined` and returned silently.
 *
 * Lives here rather than in extension.ts so it can be tested without vscode.
 */
export function resolveTarget(arg: unknown): ExportRef | undefined {
  if (!arg || typeof arg !== 'object') return undefined;

  const record = arg as Record<string, unknown>;
  const nested = record.deadExport;
  const source = (nested && typeof nested === 'object' ? nested : record) as Record<string, unknown>;

  const { fileName, name } = source;
  if (typeof fileName !== 'string' || typeof name !== 'string') return undefined;
  if (fileName.length === 0 || name.length === 0) return undefined;

  return { fileName, name };
}

/**
 * Finds the full declaration to remove for an export, given the *current* text
 * of the file rather than offsets captured at scan time.
 *
 * The old implementation deleted `[lineStart, nextLineStart)` for the line the
 * scan recorded. That is wrong in three ways this function fixes:
 *   - multi-line declarations (a function body, an interface) left their tail behind
 *   - `export const a = 1, b = 2` lost the sibling declarator too
 *   - a stale offset after an edit pointed at unrelated code and deleted it silently
 *
 * Returns undefined when the named export is no longer present, which is the
 * signal for the caller to abort rather than guess.
 */
export function findDeleteRange(fileName: string, text: string, exportName: string): DeleteTarget | undefined {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));

  const decl = findExportedDeclaration(sourceFile, exportName);
  if (!decl) return undefined;

  return rangeForDeclaration(sourceFile, decl, exportName);
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function findExportedDeclaration(sourceFile: ts.SourceFile, exportName: string): ts.Node | undefined {
  for (const statement of sourceFile.statements) {
    if (!hasExportModifier(statement) && !ts.isExportDeclaration(statement)) continue;

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.getText(sourceFile) === exportName
    ) {
      return statement;
    }

    if (ts.isVariableStatement(statement)) {
      const match = statement.declarationList.declarations.find(
        (d) => ts.isIdentifier(d.name) && d.name.text === exportName,
      );
      if (match) return match;
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const match = statement.exportClause.elements.find((el) => el.name.text === exportName);
      if (match) return match;
    }
  }
  return undefined;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function rangeForDeclaration(sourceFile: ts.SourceFile, decl: ts.Node, exportName: string): DeleteTarget {
  // A lone declarator in `export const a = 1` means the whole statement goes;
  // one of several means only that declarator plus its separating comma.
  if (ts.isVariableDeclaration(decl)) {
    const list = decl.parent as ts.VariableDeclarationList;
    const statement = list.parent as ts.VariableStatement;
    if (list.declarations.length === 1) {
      return withLeadingTriviaAndLine(sourceFile, statement);
    }
    return rangeForSibling(sourceFile, list.declarations, decl);
  }

  // Same shape for `export { a, b }`: drop the clause only if it's the last member.
  if (ts.isExportSpecifier(decl)) {
    const clause = decl.parent as ts.NamedExports;
    const statement = clause.parent as ts.ExportDeclaration;
    if (clause.elements.length === 1) {
      return withLeadingTriviaAndLine(sourceFile, statement);
    }
    return rangeForSibling(sourceFile, clause.elements, decl);
  }

  void exportName;
  return withLeadingTriviaAndLine(sourceFile, decl);
}

/** Removes one element of a comma-separated list, taking the comma with it. */
function rangeForSibling<T extends ts.Node>(
  sourceFile: ts.SourceFile,
  siblings: readonly T[],
  target: ts.Node,
): DeleteTarget {
  const index = siblings.findIndex((s) => s === target);
  const isLast = index === siblings.length - 1;

  if (isLast) {
    // Take the preceding comma so `a, b` -> `a`, not `a, `.
    return { start: siblings[index - 1].getEnd(), end: target.getEnd() };
  }
  return { start: target.getStart(sourceFile), end: siblings[index + 1].getStart(sourceFile) };
}

/**
 * Extends a declaration's range backwards over its own doc comment and forwards
 * to the start of the next line, so deleting leaves no orphaned `/** ... *\/`
 * block and no blank line where the declaration used to be.
 */
function withLeadingTriviaAndLine(sourceFile: ts.SourceFile, node: ts.Node): DeleteTarget {
  const text = sourceFile.getFullText();
  const nodeStart = node.getStart(sourceFile);

  let start = nodeStart;
  const commentRanges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  if (commentRanges.length > 0) {
    // Only absorb comments that are actually attached - a comment separated by a
    // blank line belongs to the section, not this declaration.
    const last = commentRanges[commentRanges.length - 1];
    const between = text.slice(last.end, nodeStart);
    if (!/\n\s*\n/.test(between)) {
      start = commentRanges[0].pos;
    }
  }

  // Walk back over the indentation on the declaration's own line.
  while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;

  let end = node.getEnd();
  // Consume a trailing `;` the node itself doesn't own.
  if (text[end] === ';') end++;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t' || text[end] === '\r')) end++;
  if (text[end] === '\n') end++;

  return { start, end };
}
