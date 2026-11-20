import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const SRC = resolve(__dirname, '..', '..', 'src');
// storage/connector-factory is created in a later task; only settings.service (the connection check) exists now.
const ALLOWED = new Set(['storage/connector-factory.ts', 'storage/settings.service.ts']);
const DEFINER = 'storage/secret.ts';

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (p.endsWith('.ts') && !/\.test\.ts$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

export function mentionsOpenStorageSecret(text: string): boolean {
  return /\bopenStorageSecret\b/.test(text);
}

test('the detector catches every import form', () => {
  for (const s of [
    "import { openStorageSecret } from './secret';",
    "import { x, openStorageSecret as y } from './secret';",
    "export { openStorageSecret } from './secret';",
    "const { openStorageSecret } = require('./secret');",
    "const m = require('./secret'); m.openStorageSecret(k);",
    "import * as k from './secret'; k.openStorageSecret(a);",
    "import {\n  x,\n  openStorageSecret,\n} from './secret';",
  ]) assert.ok(mentionsOpenStorageSecret(s), s);
  assert.ok(!mentionsOpenStorageSecret("import { sealStorageSecret } from './secret';"));
});

test('only the connector factory and the connection check import openStorageSecret', () => {
  const offenders = sources(SRC)
    .map((p) => ({ rel: relative(SRC, p).split('\\').join('/'), p }))
    .filter(({ rel }) => rel !== DEFINER && !ALLOWED.has(rel))
    .filter(({ p }) => mentionsOpenStorageSecret(readFileSync(p, 'utf8')))
    .map(({ rel }) => rel);
  assert.deepEqual(offenders, []);
});
