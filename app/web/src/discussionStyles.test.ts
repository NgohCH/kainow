import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Discussion keeps people's messages, AI answers and drafts apart by outline, not by colour alone (11a spec 7.10).
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** Every border declaration in rules whose selector list contains `selector` exactly. */
function borders(selector: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const d of m[2].matchAll(/(?:^|;)\s*border\s*:\s*([^;]+)/g)) out.push(d[1].trim());
  }
  return out;
}

test('an AI answer in a thread has a dashed outline', () => {
  const b = borders('.message.ai-answer');
  assert.ok(b.length > 0, 'styles.css has a border for .message.ai-answer');
  assert.match(b[b.length - 1], /\bdashed\b/);
});

test('every draft keeps a dashed outline, like other AI output', () => {
  const b = borders('.ai-proposed.draft-box');
  assert.ok(b.length > 0, 'styles.css has a border for .ai-proposed.draft-box');
  assert.match(b[b.length - 1], /\bdashed\b/);
});

test('a person’s message has a solid outline', () => {
  const b = borders('.message');
  assert.ok(b.length > 0);
  assert.match(b[b.length - 1], /\bsolid\b/);
});

test('the draft label does not use ✎, which means "Changed by a person"', () => {
  const rule = /\.draft-label::before\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'styles.css has a symbol for the draft label');
  assert.doesNotMatch(rule[1], /✎/);
});
