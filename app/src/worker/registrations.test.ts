import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { storageDailyTaskNames } from '../storage/jobs';
import './registrations';

/** Every compiled module under dist/ (this file runs from dist/worker). */
function modules(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return modules(p);
    return n.endsWith('.js') && !n.endsWith('.test.js') ? [p] : [];
  });
}

// A module-level registration call, as TypeScript compiles it: `(0, jobs_1.registerStorageHandler)(` or, in the
// module defining it, `registerInputBuilder(` at the start of a line.
const REGISTERS = /^(?:\(0, [\w$]+\.)?register(?:StorageHandler|StorageFinalFailure|StorageDailyTask|InputBuilder|Completion|RemovedCheck)\)?\(/m;

test('the worker registers every daily storage task, the source-area access and destination library checks among them', () => {
  const names = storageDailyTaskNames();
  for (const name of ['output-check', 'output-bytes', 'sharing', 'source-area-access', 'destination-library', 'relocate', 'source-check', 'source-area', 'withhold']) {
    assert.ok(names.includes(name), `${name} is registered (got ${names.join(', ')})`);
  }
});

test('every module that registers a handler, hook or daily task at import is imported by the worker', () => {
  const root = join(__dirname, '..');
  const registering = modules(root).filter((f) => REGISTERS.test(readFileSync(f, 'utf8')));
  assert.ok(registering.length >= 10, `found ${registering.length} registering modules`);
  const loaded = new Set(Object.keys(require.cache));
  const missing = registering.filter((f) => !loaded.has(f)).map((f) => f.slice(root.length + 1));
  assert.deepEqual(missing, [], 'modules the worker never imports');
});
