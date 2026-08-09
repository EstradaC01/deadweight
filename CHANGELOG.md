# Changelog

## 0.0.1

First release.

- Inline annotation at the end of each dead export's own line, with Remove and
  Ignore in its hover, so nothing is inserted above the code and lines never
  shift
- Sidebar tree of every unused export, grouped by file and typed by symbol kind
- Workspace map: a treemap where area is a file's export count and colour is
  the share of those exports that are dead, plus a sortable table view
- Optional Problems-panel hints, faded and non-blocking
- Safe delete that re-locates the declaration in the current AST and re-checks
  liveness before removing anything
- Status bar count of unused exports across the workspace
