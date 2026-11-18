import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const SRC = resolve(__dirname, '..', '..', 'src');
const ALLOWED = new Set(['ai/key-check.ts', 'ai/client-factory.ts']);
const DEFINER = 'ai/keys.ts';

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (p.endsWith('.ts') && !/\.test\.ts$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** True when the text names openApiKey anywhere (import, alias, re-export, require, dynamic import). */
export function mentionsOpenApiKey(text: string): boolean {
  return /\bopenApiKey\b/.test(text);
}

test('the detector catches every import form', () => {
  for (const s of [
    "import { openApiKey } from './keys';",
    "import { x, openApiKey as y } from './keys';",
    "export { openApiKey } from './keys';",
    "export { openApiKey as z } from './keys';",
    "const { openApiKey } = require('./keys');",
    "const m = require('./keys'); m.openApiKey(k);",
    "import * as k from './keys'; k.openApiKey(a);",
    "import {\n  x,\n  openApiKey,\n} from './keys';",
  ]) assert.ok(mentionsOpenApiKey(s), s);
  assert.ok(!mentionsOpenApiKey("import { sealApiKey } from './keys';"));
});

test('only ai/key-check.ts and ai/client-factory.ts import openApiKey', () => {
  const offenders = sources(SRC)
    .map((p) => ({ rel: relative(SRC, p).split('\\').join('/'), p }))
    .filter(({ rel }) => rel !== DEFINER && !ALLOWED.has(rel))
    .filter(({ p }) => mentionsOpenApiKey(readFileSync(p, 'utf8')))
    .map(({ rel }) => rel);
  assert.deepEqual(offenders, []);
});
