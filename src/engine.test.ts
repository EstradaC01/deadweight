import * as assert from 'assert';
import * as path from 'path';
import { DeadweightEngine, globToRegExp, isExcluded, normalize } from './engine';
import { findDeleteRange, resolveTarget } from './deleteRange';

const fixtureRoot = path.join(__dirname, '..', 'test-fixture');
const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

function makeEngine(): DeadweightEngine {
  return new DeadweightEngine([fixtureRoot], {
    exclude: ['**/*.d.ts', '**/*.test.*'],
    ignoreBarrelFiles: true,
  });
}

// --- reference counting ------------------------------------------------------

test('flags exports with no external references', () => {
  const engine = makeEngine();
  const dead = engine.findDeadExportsInFile(path.join(fixtureRoot, 'src', 'utils.ts'));
  assert.deepStrictEqual(
    dead.map((d) => d.name).sort(),
    ['UNUSED_CONSTANT', 'UnusedShape', 'unusedHelper'],
  );
  engine.dispose();
});

test('does not flag exports that are imported elsewhere', () => {
  const engine = makeEngine();
  const dead = engine.findDeadExportsInFile(path.join(fixtureRoot, 'src', 'shapes.ts'));
  const names = dead.map((d) => d.name);
  assert.ok(!names.includes('LiveShape'), 'LiveShape is imported by index.ts');
  assert.ok(!names.includes('livePair'), 'livePair is imported by index.ts');
  engine.dispose();
});

test('reports declaration kinds', () => {
  const engine = makeEngine();
  const dead = engine.findDeadExportsInFile(path.join(fixtureRoot, 'src', 'shapes.ts'));
  const byName = new Map(dead.map((d) => [d.name, d.kind]));
  assert.strictEqual(byName.get('DeadShape'), 'interface');
  assert.strictEqual(byName.get('DeadEnum'), 'enum');
  assert.strictEqual(byName.get('DeadClass'), 'class');
  assert.strictEqual(byName.get('DeadAlias'), 'type');
  assert.strictEqual(byName.get('deadPair'), 'variable');
  engine.dispose();
});

test('skips barrel files when configured', () => {
  const engine = makeEngine();
  assert.deepStrictEqual(engine.findDeadExportsInFile(path.join(fixtureRoot, 'src', 'index.ts')), []);
  engine.dispose();
});

test('ignored exports are suppressed and restorable', () => {
  const engine = makeEngine();
  const utils = normalize(path.join(fixtureRoot, 'src', 'utils.ts'));

  engine.setIgnored(`${utils}#unusedHelper`, true);
  let names = engine.findDeadExportsInFile(utils).map((d) => d.name);
  assert.ok(!names.includes('unusedHelper'), 'ignored export should not be reported');
  assert.deepStrictEqual(engine.getIgnoredKeys(), [`${utils}#unusedHelper`]);

  engine.setIgnored(`${utils}#unusedHelper`, false);
  names = engine.findDeadExportsInFile(utils).map((d) => d.name);
  assert.ok(names.includes('unusedHelper'), 'un-ignoring should restore the report');
  engine.dispose();
});

test('live edits are seen without a disk write', () => {
  const engine = makeEngine();
  const utils = path.join(fixtureRoot, 'src', 'utils.ts');

  const before = engine.findDeadExportsInFile(utils).map((d) => d.name);
  assert.ok(before.includes('unusedHelper'));

  engine.updateFile(utils, 'export const onlyThing = 1;\n');
  const after = engine.findDeadExportsInFile(utils).map((d) => d.name);
  assert.deepStrictEqual(after, ['onlyThing'], 'the in-memory buffer should replace disk content');
  engine.dispose();
});

test('removed files drop out of the program', () => {
  const engine = makeEngine();
  const shapes = path.join(fixtureRoot, 'src', 'shapes.ts');
  assert.ok(engine.hasFile(shapes));
  engine.removeFile(shapes);
  assert.ok(!engine.hasFile(shapes));
  assert.deepStrictEqual(engine.findDeadExportsInFile(shapes), []);
  engine.dispose();
});

test('workspace scan reports stats and honours cancellation', async () => {
  const engine = makeEngine();

  const result = await engine.scanWorkspace();
  assert.ok(result.dead.length > 0, 'fixture has dead exports');
  assert.ok(result.stats.length > 0, 'stats should be populated');
  assert.strictEqual(result.errored.length, 0, 'fixture should analyze cleanly');

  const utilsStats = result.stats.find((s) => s.fileName.endsWith('utils.ts'));
  assert.ok(utilsStats && utilsStats.totalExports > utilsStats.deadExports);
  assert.ok(utilsStats.lines > 0, 'line count should be recorded');

  const cancelled = await engine.scanWorkspace({ isCancellationRequested: true });
  assert.deepStrictEqual(cancelled.dead, [], 'a pre-cancelled scan does no work');

  engine.dispose();
});

test('disposed engine refuses further analysis', () => {
  const engine = makeEngine();
  engine.dispose();
  assert.throws(() => engine.findDeadExportsInFile(path.join(fixtureRoot, 'src', 'utils.ts')), /disposed/);
  engine.dispose(); // must be idempotent
});

// --- glob handling -----------------------------------------------------------

test('globToRegExp handles the patterns users actually write', () => {
  assert.ok(globToRegExp('**/*.test.*').test('src/a/b.test.ts'));
  assert.ok(globToRegExp('**/node_modules/**').test('a/node_modules/pkg/index.js'));
  // `**/` must match zero segments, so a top-level dist is still excluded.
  assert.ok(globToRegExp('**/dist/**').test('dist/out.js'));
  assert.ok(globToRegExp('**/*.{spec,test}.ts').test('src/x.spec.ts'));
  assert.ok(globToRegExp('**/*.{spec,test}.ts').test('src/x.test.ts'));
  assert.ok(!globToRegExp('**/*.{spec,test}.ts').test('src/x.impl.ts'));
  assert.ok(globToRegExp('*.d.ts').test('src/types.d.ts'));
  // A `.` in the pattern is literal, not "any character".
  assert.ok(!globToRegExp('**/*.d.ts').test('src/typesXd.ts'));
});

test('malformed globs exclude nothing instead of throwing', () => {
  assert.doesNotThrow(() => isExcluded('src/a.ts', ['**/{unclosed']));
  assert.strictEqual(isExcluded('src/a.ts', ['**/{unclosed']), false);
});

// --- delete range ------------------------------------------------------------

function rangeOf(text: string, name: string, file = 'x.ts'): string {
  const target = findDeleteRange(file, text, name);
  assert.ok(target, `expected to locate ${name}`);
  return text.slice(0, target.start) + text.slice(target.end);
}

test('deletes a whole multi-line declaration, not just its first line', () => {
  const text = [
    'export function keep(): void {}',
    '',
    'export function dead(a: number): number {',
    '  return a * 2;',
    '}',
    '',
    'export const tail = 1;',
    '',
  ].join('\n');

  const result = rangeOf(text, 'dead');
  assert.ok(!result.includes('return a * 2'), 'the body must go with the signature');
  assert.ok(!result.includes('function dead'));
  assert.ok(result.includes('export function keep'));
  assert.ok(result.includes('export const tail = 1;'));
});

test('takes an attached doc comment with the declaration', () => {
  const text = ['/** Explains dead. */', 'export const dead = 1;', 'export const keep = 2;', ''].join('\n');
  const result = rangeOf(text, 'dead');
  assert.ok(!result.includes('Explains dead'), 'the doc comment should not be orphaned');
  assert.ok(result.includes('export const keep = 2;'));
});

test('leaves a detached comment alone', () => {
  const text = ['// Section header', '', 'export const dead = 1;', ''].join('\n');
  const result = rangeOf(text, 'dead');
  assert.ok(result.includes('Section header'), 'a blank line means the comment is not attached');
});

test('removes only the target declarator in a multi-declarator statement', () => {
  const text = 'export const keep = 1,\n  dead = 2;\n';
  const result = rangeOf(text, 'dead');
  assert.ok(result.includes('keep = 1'), 'the sibling declarator must survive');
  assert.ok(!result.includes('dead = 2'));
  assert.ok(!/,\s*;/.test(result), 'no dangling comma should be left');
});

test('removes one specifier from an export clause', () => {
  const text = 'const a = 1, b = 2;\nexport { a, b };\n';
  const result = rangeOf(text, 'b');
  assert.ok(result.includes('export { a }') || result.includes('export { a, }'.replace(', }', ' }')));
  assert.ok(!/\bb\b\s*}/.test(result), 'b should be gone from the clause');
});

test('drops the whole export statement when the last specifier goes', () => {
  const text = 'const a = 1;\nexport { a };\n';
  const result = rangeOf(text, 'a');
  assert.ok(!result.includes('export {'), 'an empty export clause should not be left behind');
  assert.ok(result.includes('const a = 1;'));
});

test('returns undefined for a name that is not there', () => {
  assert.strictEqual(findDeleteRange('x.ts', 'export const a = 1;\n', 'ghost'), undefined);
});

test('handles tsx without treating generics as JSX', () => {
  const text = 'export const dead = <T,>(x: T): T => x;\nexport const keep = 1;\n';
  const result = rangeOf(text, 'dead', 'x.tsx');
  assert.ok(result.includes('export const keep = 1;'));
  assert.ok(!result.includes('dead'));
});

// --- command argument shapes -------------------------------------------------

test('resolves the argument shape the hover and code action pass', () => {
  assert.deepStrictEqual(resolveTarget({ fileName: '/a/b.ts', name: 'dead' }), {
    fileName: '/a/b.ts',
    name: 'dead',
  });
});

test('resolves the tree node shape the sidebar context menu passes', () => {
  // Regression: the sidebar passes its node, not a bare ref. Handling only the
  // flat shape made "Delete Unused Export" in the context menu a silent no-op.
  const treeNode = { kind: 'export', deadExport: { fileName: '/a/b.ts', name: 'dead', line: 3, column: 7 } };
  assert.deepStrictEqual(resolveTarget(treeNode), { fileName: '/a/b.ts', name: 'dead' });
});

test('rejects argument shapes that cannot identify an export', () => {
  for (const bad of [undefined, null, 'string', 42, {}, { fileName: '/a/b.ts' }, { name: 'dead' }]) {
    assert.strictEqual(resolveTarget(bad), undefined, `should reject ${JSON.stringify(bad)}`);
  }
  // A tree node whose payload is missing must not fall back to the node itself.
  assert.strictEqual(resolveTarget({ kind: 'export', deadExport: undefined }), undefined);
  // Empty strings would produce a bogus ignore key.
  assert.strictEqual(resolveTarget({ fileName: '', name: 'dead' }), undefined);
});

// --- runner ------------------------------------------------------------------

async function run(): Promise<void> {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failed++;
      console.error(`  FAIL ${name}`);
      console.error(`       ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
}

void run();
