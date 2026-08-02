# Deadweight

A live dead-export radar for VS Code. As you save a TypeScript or JavaScript file,
Deadweight tells you which of its exports have zero references anywhere else in
the workspace, no full-project lint run required.

## Why

`ts-prune` and `knip` are excellent, but they're CI/CLI tools: run them on demand
and read a wall of text. Deadweight is the same idea pushed into the editor as a
live signal: an inline note next to the dead export, a CodeLens to jump straight
to deleting it, a sidebar tree of everything unused across the workspace, a
workspace map showing where the rot is concentrated, and a status bar count so
you know at a glance whether a repo has drifted.

It's built on the TypeScript Language Service's own `findReferences`, so renames,
re-exports and JSX usage are counted the same way `tsserver` counts them, rather
than a hand-rolled resolver getting it subtly wrong.

## Features

- Inline annotation at the end of the declaration's line, with Remove and Ignore
  in its hover — nothing is inserted above the code, so lines never shift
- Sidebar tree of all dead exports, grouped by file and typed by symbol kind
- **Workspace map**: a treemap where area is a file's export count and color is
  the share of those exports that are dead, plus a sortable table view
- Optional Problems-panel hints (faded, `Unnecessary`-tagged, non-blocking)
- Safe delete that re-verifies liveness and removes the whole declaration
- Status bar count of unused exports in the workspace

## The workspace map

`Deadweight: Open Workspace Map` (or click the status bar item) opens a treemap
panel. Area is the file's total export count, so big modules are big blocks;
color is the fraction of those exports that are dead. A large pale block is a
healthy module, a small dark one is a file that's almost entirely dead — two very
different problems that a flat list renders identically.

The density ramp is a single-hue sequential scale, validated for monotone
lightness and surface contrast in both light and dark mode. Files with no dead
exports are outlined only, never filled — "clean" is a distinct state, not the
lightest step of the ramp. Hover any block for the symbol list, click to jump to
the first dead export. A table view carries the same data for exact reading and
sorting.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `deadweight.exclude` | `.d.ts`, `.test.*`, `.spec.*`, `node_modules`, `dist`, `out` | Globs Deadweight never scans |
| `deadweight.ignoreBarrelFiles` | `true` | Skip `index.ts`/`index.tsx` re-export barrels |
| `deadweight.refreshOn` | `save` | Rescan on save (default) or while typing, debounced |
| `deadweight.showDiagnostics` | `true` | Also report unused exports as Problems-panel hints |

Ignored exports persist in workspace state; `Deadweight: Clear Ignored Exports`
resets them.

## Where the actions live

The annotation renders at the **end of the declaration's own line**, greyed and
italic, and its hover carries `Remove` and `Ignore` as clickable links. The same
two actions are on the lightbulb (`Ctrl+.`) and the sidebar's right-click menu.

This deliberately isn't a CodeLens. VS Code renders a CodeLens on a line of its
own above the declaration — there's no API to place one inline — so every dead
export pushed the code down a line, and a file with several of them shifted
around on each rescan. An `after` decoration is the only mechanism that puts text
beside the code without moving it.

## Safety

Deleting an export is the one destructive thing this extension does, so it takes
the long way around:

- The offsets captured at scan time are never used to edit. They go stale the
  moment you type, and acting on a stale offset means silently deleting the
  wrong code.
- The declaration is re-located by name in the file's *current* AST, and the
  export is re-checked for liveness first — if something imported it since the
  last scan, the delete is refused.
- The removed range is the whole declaration plus its attached doc comment, so a
  multi-line function or interface doesn't leave its body behind. One declarator
  out of `export const a = 1, b = 2` takes its comma and leaves the sibling intact.
- The confirmation dialog previews the exact text to be removed, and the range is
  re-derived after you confirm — if the file changed while the dialog was up,
  nothing is deleted.

## Robustness

- One language service spans every workspace folder, so a symbol exported from
  one folder and imported by another counts as used.
- Workspace scans are chunked and yield to the event loop, and a new scan cancels
  the one in flight — a burst of saves settles into a single final scan rather
  than freezing the extension host.
- A `findReferences` failure on one symbol is contained: it's treated as
  *referenced*, never as dead, because a false negative costs nothing and a false
  positive invites deleting live code.
- A file system watcher keeps the program in sync with changes made outside the
  editor — branch switches, generator runs, external deletes.
- The language service is disposed on deactivation and rebuilt when the workspace
  folders or the relevant settings change.

## Development

```
npm install
npm run compile
```

Press `F5` in VS Code to launch the Extension Development Host against
`test-fixture/`, a small sample workspace with intentionally unused exports
covering each declaration kind.

```
npm test          # typecheck + engine, glob and delete-range assertions
```

## Scope

TypeScript/JavaScript only, via the TS Language Service. Default exports are not
reported (no stable name to report against), and a workspace-only scan can't see
consumers outside the workspace — which is why barrel files are skipped by
default. No CI/CLI mode yet.
