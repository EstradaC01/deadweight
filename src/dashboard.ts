import * as path from 'path';
import * as vscode from 'vscode';
import { DeadExport, FileStats } from './engine';

export interface DashboardData {
  stats: FileStats[];
  dead: DeadExport[];
  roots: string[];
}

interface TreemapNode {
  label: string;
  fullPath: string;
  dead: number;
  total: number;
  lines: number;
  density: number;
}

/**
 * A webview treemap of dead exports across the workspace. The tree view answers
 * "what is dead"; this answers "where has the repo rotted most" - area is the
 * file's export count, color is the share of those that are dead, so a large
 * pale block (big but healthy) and a small dark one (tiny but entirely dead)
 * are visibly different problems.
 */
export class DeadweightDashboard {
  private static current: DeadweightDashboard | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private latest: DashboardData = { stats: [], dead: [], roots: [] };

  static show(context: vscode.ExtensionContext, data: DashboardData): DeadweightDashboard {
    if (DeadweightDashboard.current) {
      DeadweightDashboard.current.panel.reveal(vscode.ViewColumn.Beside);
      DeadweightDashboard.current.update(data);
      return DeadweightDashboard.current;
    }
    const dashboard = new DeadweightDashboard(context, data);
    DeadweightDashboard.current = dashboard;
    return dashboard;
  }

  /** Pushes a new scan into the panel if one is open; no-op otherwise. */
  static refresh(data: DashboardData): void {
    DeadweightDashboard.current?.update(data);
  }

  static isOpen(): boolean {
    return DeadweightDashboard.current !== undefined;
  }

  private constructor(context: vscode.ExtensionContext, data: DashboardData) {
    this.panel = vscode.window.createWebviewPanel(
      'deadweight.dashboard',
      'Deadweight: Workspace Map',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );

    this.panel.webview.html = this.render();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message: { type: string; file?: string; line?: number; column?: number; name?: string }) => {
        if (message.type === 'open' && message.file) {
          await this.openAt(message.file, message.line ?? 0, message.column ?? 0, message.name);
        } else if (message.type === 'ready') {
          this.post();
        }
      },
      null,
      this.disposables,
    );

    context.subscriptions.push(this.panel);
    this.update(data);
  }

  private async openAt(file: string, line: number, column: number, name?: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
      });
      const end = column + (name?.length ?? 0);
      const range = new vscode.Range(line, column, line, end);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch {
      vscode.window.showWarningMessage(`Deadweight: could not open ${path.basename(file)} - it may have been deleted.`);
    }
  }

  update(data: DashboardData): void {
    this.latest = data;
    this.post();
  }

  private post(): void {
    const nodes = this.buildNodes(this.latest);
    const deadByFile: Record<string, { name: string; line: number; column: number; kind: string }[]> = {};
    for (const d of this.latest.dead) {
      (deadByFile[d.fileName] ??= []).push({ name: d.name, line: d.line, column: d.column, kind: d.kind });
    }

    void this.panel.webview.postMessage({
      type: 'data',
      nodes,
      deadByFile,
      totals: {
        deadExports: this.latest.dead.length,
        files: nodes.length,
        affectedFiles: nodes.filter((n) => n.dead > 0).length,
        totalExports: nodes.reduce((sum, n) => sum + n.total, 0),
      },
    });
  }

  private buildNodes(data: DashboardData): TreemapNode[] {
    const rootPrefixes = data.roots.map((r) => r.replace(/\\/g, '/').replace(/\/$/, '') + '/');

    return data.stats
      .filter((s) => s.totalExports > 0)
      .map((s) => {
        const normalized = s.fileName.replace(/\\/g, '/');
        const prefix = rootPrefixes.find((p) => normalized.startsWith(p));
        return {
          label: prefix ? normalized.slice(prefix.length) : path.basename(normalized),
          fullPath: s.fileName,
          dead: s.deadExports,
          total: s.totalExports,
          lines: s.lines,
          density: s.totalExports === 0 ? 0 : s.deadExports / s.totalExports,
        };
      })
      .sort((a, b) => b.dead - a.dead || b.total - a.total);
  }

  dispose(): void {
    DeadweightDashboard.current = undefined;
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        // Disposal of an already-torn-down webview listener throws; nothing to do.
      }
    }
    this.disposables = [];
  }

  /**
   * Chrome is bound to VS Code's own theme variables so the panel matches
   * whatever theme the user runs. Only the density ramp is fixed - it is a
   * sequential magnitude encoding (validated one-hue, monotone lightness,
   * light end clearing the surface in both modes) and must stay ordered
   * regardless of theme.
   */
  private render(): string {
    const nonce = makeNonce();
    const csp = [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deadweight: Workspace Map</title>
<style nonce="${nonce}">
  :root {
    --ramp-0: #86b6ef;
    --ramp-1: #5598e7;
    --ramp-2: #2a78d6;
    --ramp-3: #1c5cab;
    --ramp-4: #0d366b;
    --clean: var(--vscode-editorWidget-border, rgba(128,128,128,0.28));
    --ink: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --surface: var(--vscode-editor-background);
    --hairline: var(--vscode-editorWidget-border, rgba(128,128,128,0.28));
  }
  body.vscode-dark, body.vscode-high-contrast {
    --ramp-0: #cde2fb;
    --ramp-1: #9ec5f4;
    --ramp-2: #6da7ec;
    --ramp-3: #2a78d6;
    --ramp-4: #184f95;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px 20px 24px;
    font-family: var(--vscode-font-family, system-ui, -apple-system, "Segoe UI", sans-serif);
    font-size: 13px;
    color: var(--ink);
    background: var(--surface);
  }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 16px; }

  .tiles { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 18px; }
  .tile .value { font-size: 26px; font-weight: 600; line-height: 1.1; }
  .tile .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }

  .toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .toolbar input, .toolbar select {
    font-family: inherit; font-size: 12px; padding: 3px 6px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--hairline); border-radius: 3px;
  }
  .toolbar input:focus-visible, .toolbar select:focus-visible,
  .cell:focus-visible, .row:focus-visible, .tab:focus-visible {
    outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px;
  }
  .tabs { display: flex; gap: 4px; margin-left: auto; }
  .tab {
    font: inherit; font-size: 12px; padding: 3px 10px; cursor: pointer;
    background: transparent; color: var(--muted);
    border: 1px solid transparent; border-radius: 3px;
  }
  .tab[aria-selected="true"] { color: var(--ink); border-color: var(--hairline); background: var(--vscode-list-hoverBackground); }

  #treemap { position: relative; width: 100%; height: 460px; border: 1px solid var(--hairline); border-radius: 4px; overflow: hidden; }
  .cell {
    position: absolute; overflow: hidden; cursor: pointer;
    /* 2px surface gap between fills, per mark spec - drawn as a border in the
       surface color rather than by shrinking the rect, so the areas stay true. */
    border: 1px solid var(--surface);
    border-radius: 3px; padding: 4px 6px;
    display: flex; flex-direction: column; justify-content: flex-start;
  }
  .cell:hover, .cell:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; z-index: 3; }
  .cell .n { font-size: 11px; line-height: 1.25; word-break: break-all; }
  .cell .c { font-size: 10px; opacity: .85; margin-top: 1px; }
  .cell.on-fill { color: #ffffff; }
  .cell.on-surface { color: var(--ink); }

  .legend { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 11px; color: var(--muted); }
  .swatches { display: flex; gap: 2px; }
  .sw { width: 26px; height: 10px; border-radius: 2px; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--hairline); }
  th { color: var(--muted); font-weight: 500; cursor: pointer; user-select: none; white-space: nowrap; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .row { cursor: pointer; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .chip {
    display: inline-block; font-size: 10px; padding: 0 5px; border-radius: 8px; margin: 1px 3px 1px 0;
    border: 1px solid var(--hairline); color: var(--muted); white-space: nowrap;
  }
  .bar { height: 6px; border-radius: 3px; background: var(--ramp-2); display: inline-block; vertical-align: middle; }
  .hidden { display: none; }
  .empty { color: var(--muted); padding: 40px 0; text-align: center; }
  #tooltip {
    position: fixed; pointer-events: none; z-index: 20; max-width: 320px;
    background: var(--vscode-editorHoverWidget-background, var(--surface));
    color: var(--vscode-editorHoverWidget-foreground, var(--ink));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--hairline));
    border-radius: 4px; padding: 6px 9px; font-size: 11.5px; line-height: 1.45;
    box-shadow: 0 2px 10px rgba(0,0,0,.28);
  }
  #tooltip.hidden { display: none; }
  #tooltip .t-name { font-weight: 600; word-break: break-all; }
  #tooltip .t-row { color: var(--muted); }
</style>
</head>
<body>
  <h1>Workspace Map</h1>
  <div class="sub">Area is the file's export count. Color is the share of those exports that are dead.</div>

  <div class="tiles" id="tiles"></div>

  <div class="toolbar">
    <input type="search" id="filter" placeholder="Filter by path…" aria-label="Filter files by path">
    <select id="scope" aria-label="Which files to show">
      <option value="affected">Files with dead exports</option>
      <option value="all">All files with exports</option>
    </select>
    <div class="tabs" role="tablist">
      <button class="tab" id="tab-map" role="tab" aria-selected="true" aria-controls="view-map">Map</button>
      <button class="tab" id="tab-table" role="tab" aria-selected="false" aria-controls="view-table">Table</button>
    </div>
  </div>

  <div id="view-map" role="tabpanel">
    <div id="treemap"></div>
    <div class="legend">
      <span>0% dead</span>
      <span class="swatches" id="swatches"></span>
      <span>100% dead</span>
      <span style="margin-left:12px">Files with no dead exports are outlined only.</span>
    </div>
  </div>

  <div id="view-table" class="hidden" role="tabpanel">
    <table>
      <thead>
        <tr>
          <th data-sort="label">File</th>
          <th class="num" data-sort="dead">Dead</th>
          <th class="num" data-sort="total">Exports</th>
          <th class="num" data-sort="density">Density</th>
          <th>Unused symbols</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>

  <div id="tooltip" class="hidden" role="tooltip" aria-hidden="true"></div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const RAMP = ['--ramp-0','--ramp-1','--ramp-2','--ramp-3','--ramp-4'];

  let nodes = [];
  let deadByFile = {};
  let totals = { deadExports: 0, files: 0, affectedFiles: 0, totalExports: 0 };
  let sortKey = 'dead';
  let sortDir = -1;
  let view = 'map';

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Density -> ordinal bucket. Zero is never a ramp step: "no dead exports"
      is a different state, not the lightest magnitude. */
  function bucket(d) {
    if (d <= 0) return -1;
    if (d < 0.25) return 0;
    if (d < 0.5) return 1;
    if (d < 0.75) return 2;
    if (d < 1) return 3;
    return 4;
  }
  const fill = (b) => (b < 0 ? 'transparent' : 'var(' + RAMP[b] + ')');

  function visible() {
    const q = el('filter').value.trim().toLowerCase();
    const scope = el('scope').value;
    return nodes.filter((n) => {
      if (scope === 'affected' && n.dead === 0) return false;
      return !q || n.label.toLowerCase().includes(q);
    });
  }

  // Squarified treemap: keeps blocks near-square so small files stay clickable
  // and area stays comparable, which a naive slice-and-dice loses.
  function squarify(items, x, y, w, h) {
    const out = [];
    const total = items.reduce((s, i) => s + i.weight, 0);
    if (total <= 0 || w <= 0 || h <= 0) return out;

    let list = items.map((i) => ({ ...i, area: (i.weight / total) * w * h }));
    let rect = { x, y, w, h };

    const worst = (row, side) => {
      const sum = row.reduce((s, r) => s + r.area, 0);
      const mx = Math.max(...row.map((r) => r.area));
      const mn = Math.min(...row.map((r) => r.area));
      const s2 = sum * sum, side2 = side * side;
      return Math.max((side2 * mx) / s2, s2 / (side2 * mn));
    };

    while (list.length) {
      const side = Math.min(rect.w, rect.h);
      const row = [list[0]];
      let i = 1;
      while (i < list.length && worst(row.concat(list[i]), side) <= worst(row, side)) {
        row.push(list[i]);
        i++;
      }
      const sum = row.reduce((s, r) => s + r.area, 0);
      const horizontal = rect.w >= rect.h;
      const thickness = sum / side;
      let off = 0;
      for (const r of row) {
        const len = r.area / thickness;
        out.push(horizontal
          ? { ...r, x: rect.x, y: rect.y + off, w: thickness, h: len }
          : { ...r, x: rect.x + off, y: rect.y, w: len, h: thickness });
        off += len;
      }
      if (horizontal) { rect = { x: rect.x + thickness, y: rect.y, w: rect.w - thickness, h: rect.h }; }
      else { rect = { x: rect.x, y: rect.y + thickness, w: rect.w, h: rect.h - thickness }; }
      list = list.slice(row.length);
    }
    return out;
  }

  function drawMap() {
    const host = el('treemap');
    host.textContent = '';
    const items = visible();
    if (!items.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = 'No files to show.';
      host.appendChild(d);
      return;
    }

    const W = host.clientWidth, H = host.clientHeight;
    // Weight by export count, floored so a 1-export file still gets a hit target.
    const laid = squarify(items.map((n) => ({ n, weight: Math.max(n.total, 1) })), 0, 0, W, H);

    for (const cell of laid) {
      const n = cell.n;
      const b = bucket(n.density);
      const div = document.createElement('div');
      div.className = 'cell ' + (b >= 2 ? 'on-fill' : 'on-surface');
      div.style.left = cell.x + 'px';
      div.style.top = cell.y + 'px';
      div.style.width = cell.w + 'px';
      div.style.height = cell.h + 'px';
      div.style.background = fill(b);
      div.tabIndex = 0;
      div.setAttribute('role', 'button');
      div.setAttribute('aria-label',
        n.label + ': ' + n.dead + ' of ' + n.total + ' exports unused');

      // Direct-label only where the block can actually hold text; the tooltip
      // carries the rest so labels never overlap their neighbours.
      if (cell.w > 54 && cell.h > 26) {
        const name = document.createElement('div');
        name.className = 'n';
        name.textContent = n.label.split('/').pop();
        div.appendChild(name);
        if (cell.h > 42) {
          const c = document.createElement('div');
          c.className = 'c';
          c.textContent = n.dead + '/' + n.total;
          div.appendChild(c);
        }
      }

      div.addEventListener('mousemove', (e) => showTip(e, n));
      div.addEventListener('mouseleave', hideTip);
      div.addEventListener('click', () => openFile(n));
      div.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(n); }
      });
      host.appendChild(div);
    }
  }

  function showTip(e, n) {
    const tip = el('tooltip');
    const names = (deadByFile[n.fullPath] || []).slice(0, 8);
    const more = (deadByFile[n.fullPath] || []).length - names.length;
    let html = '<div class="t-name">' + esc(n.label) + '</div>' +
      '<div class="t-row">' + n.dead + ' of ' + n.total + ' exports unused · ' +
      Math.round(n.density * 100) + '% · ' + n.lines + ' lines</div>';
    if (names.length) {
      html += '<div style="margin-top:4px">' +
        names.map((d) => '<span class="chip">' + esc(d.name) + '</span>').join('') +
        (more > 0 ? '<span class="chip">+' + more + ' more</span>' : '') + '</div>';
    }
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let left = e.clientX + pad, top = e.clientY + pad;
    if (left + r.width > window.innerWidth - 8) left = e.clientX - r.width - pad;
    if (top + r.height > window.innerHeight - 8) top = e.clientY - r.height - pad;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }
  function hideTip() { el('tooltip').classList.add('hidden'); }

  function openFile(n, sym) {
    const first = sym || (deadByFile[n.fullPath] || [])[0];
    vscode.postMessage({
      type: 'open',
      file: n.fullPath,
      line: first ? first.line : 0,
      column: first ? first.column : 0,
      name: first ? first.name : undefined,
    });
  }

  function drawTable() {
    const body = el('tbody');
    body.textContent = '';
    const items = visible().slice().sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (typeof av === 'string') return sortDir * av.localeCompare(bv);
      return sortDir * (av - bv);
    });

    for (const n of items) {
      const tr = document.createElement('tr');
      tr.className = 'row';
      tr.tabIndex = 0;

      const f = document.createElement('td');
      f.textContent = n.label;
      tr.appendChild(f);

      const d = document.createElement('td');
      d.className = 'num';
      d.textContent = n.dead;
      tr.appendChild(d);

      const t = document.createElement('td');
      t.className = 'num';
      t.textContent = n.total;
      tr.appendChild(t);

      const dens = document.createElement('td');
      dens.className = 'num';
      const bar = document.createElement('span');
      bar.className = 'bar';
      bar.style.width = Math.max(2, Math.round(n.density * 40)) + 'px';
      bar.style.background = fill(Math.max(bucket(n.density), 0));
      dens.appendChild(bar);
      dens.appendChild(document.createTextNode(' ' + Math.round(n.density * 100) + '%'));
      tr.appendChild(dens);

      const syms = document.createElement('td');
      for (const s of (deadByFile[n.fullPath] || []).slice(0, 6)) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = s.name;
        chip.title = s.kind + ' · line ' + (s.line + 1);
        syms.appendChild(chip);
      }
      const extra = (deadByFile[n.fullPath] || []).length - 6;
      if (extra > 0) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = '+' + extra + ' more';
        syms.appendChild(chip);
      }
      tr.appendChild(syms);

      tr.addEventListener('click', () => openFile(n));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); openFile(n); }
      });
      body.appendChild(tr);
    }
  }

  function drawTiles() {
    const t = el('tiles');
    t.textContent = '';
    const cells = [
      ['Dead exports', totals.deadExports],
      ['Affected files', totals.affectedFiles],
      ['Exports scanned', totals.totalExports],
      ['Dead share', totals.totalExports ? Math.round((totals.deadExports / totals.totalExports) * 100) + '%' : '0%'],
    ];
    for (const [label, value] of cells) {
      const d = document.createElement('div');
      d.className = 'tile';
      const v = document.createElement('div');
      v.className = 'value';
      v.textContent = value;
      const l = document.createElement('div');
      l.className = 'label';
      l.textContent = label;
      d.appendChild(v); d.appendChild(l);
      t.appendChild(d);
    }
  }

  function drawSwatches() {
    const s = el('swatches');
    s.textContent = '';
    for (let i = 0; i < RAMP.length; i++) {
      const d = document.createElement('span');
      d.className = 'sw';
      d.style.background = 'var(' + RAMP[i] + ')';
      s.appendChild(d);
    }
  }

  function draw() {
    drawTiles();
    drawSwatches();
    if (view === 'map') drawMap(); else drawTable();
  }

  function setView(next) {
    view = next;
    el('tab-map').setAttribute('aria-selected', String(next === 'map'));
    el('tab-table').setAttribute('aria-selected', String(next === 'table'));
    el('view-map').classList.toggle('hidden', next !== 'map');
    el('view-table').classList.toggle('hidden', next !== 'table');
    draw();
  }

  el('tab-map').addEventListener('click', () => setView('map'));
  el('tab-table').addEventListener('click', () => setView('table'));
  el('filter').addEventListener('input', draw);
  el('scope').addEventListener('change', draw);

  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (sortKey === key) sortDir = -sortDir;
      else { sortKey = key; sortDir = key === 'label' ? 1 : -1; }
      drawTable();
    });
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (view === 'map') drawMap(); }, 120);
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'data') {
      nodes = msg.nodes || [];
      deadByFile = msg.deadByFile || {};
      totals = msg.totals || totals;
      draw();
    }
  });

  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
