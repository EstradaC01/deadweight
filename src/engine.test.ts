import * as assert from 'assert';
import * as path from 'path';
import { DeadweightEngine } from './engine';

function run(): void {
  const fixtureRoot = path.join(__dirname, '..', 'test-fixture');
  const engine = new DeadweightEngine(fixtureRoot, {
    exclude: ['**/*.d.ts', '**/*.test.*'],
    ignoreBarrelFiles: true,
  });

  const utilsFile = path.join(fixtureRoot, 'src', 'utils.ts');
  const dead = engine.findDeadExportsInFile(utilsFile);
  const names = dead.map((d) => d.name).sort();

  assert.deepStrictEqual(names, ['UNUSED_CONSTANT', 'UnusedShape', 'unusedHelper']);

  const indexFile = path.join(fixtureRoot, 'src', 'index.ts');
  const indexDead = engine.findDeadExportsInFile(indexFile);
  assert.deepStrictEqual(indexDead, []);

  console.log('engine.test.ts: all assertions passed');
}

run();
