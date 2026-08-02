# Deadweight

A live dead-export radar for VS Code. As you save a TypeScript or JavaScript file,
Deadweight tells you which of its exports have zero references anywhere else in
the workspace, no full-project lint run required.

## Why

`ts-prune` and `knip` are excellent, but they're CI/CLI tools: run them on demand
and read a wall of text. Deadweight is the same idea pushed into the editor as a
live signal: an inline note next to the dead export, a CodeLens to jump straight
to deleting it, a sidebar tree of everything unused across the workspace, and a
status bar count so you know at a glance whether a repo has drifted.

It's built on the TypeScript Language Service's own `findReferences`, so renames,
re-exports and JSX usage are counted the same way `tsserver` counts them, rather
than a hand-rolled resolver getting it subtly wrong.

## Features

- Inline decoration and CodeLens ("0 references") on every unused export
- Sidebar tree of all dead exports, grouped by file, click to jump
- One-click delete for a dead export, or mark it ignored
- Status bar count of unused exports in the workspace
- Configurable exclude globs and barrel-file handling

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `deadweight.exclude` | `.d.ts`, `.test.*`, `.spec.*`, `node_modules`, `dist`, `out` | Globs Deadweight never scans |
| `deadweight.ignoreBarrelFiles` | `true` | Skip `index.ts`/`index.tsx` re-export barrels |
| `deadweight.refreshOn` | `save` | Rescan on save (default) or on every edit |

## Development

```
npm install
npm run compile
```

Press `F5` in VS Code to launch the Extension Development Host against
`test-fixture/`, a small sample workspace with a few intentionally unused exports.

```
npm test          # typecheck + engine reference-counting assertions
```

## Scope

v1 covers TypeScript/JavaScript only, via the TS Language Service. No CI/CLI mode
and no auto-delete-cascade of now-empty files yet, those are candidates for v2 if
this proves useful day to day.
