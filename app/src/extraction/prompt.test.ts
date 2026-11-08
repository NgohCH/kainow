import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXTRACTION_SYSTEM_PROMPT } from './prompt';

// tests/extraction/run.mjs is the check that the model quotes accurately. It must send the same words as the app.
const RUN_MJS = join(__dirname, '..', '..', '..', 'tests', 'extraction', 'run.mjs');

function promptInCheckScript(): string {
  const src = readFileSync(RUN_MJS, 'utf8');
  const start = src.indexOf('content:', src.indexOf('role: "system"'));
  const end = src.indexOf('},', start);
  const literals = src.slice(start, end).match(/"[^"\n]*"/g) ?? [];
  return literals.map((l) => l.slice(1, -1)).join('');
}

test('the app prompt and the check script prompt are word for word the same', { skip: existsSync(RUN_MJS) ? false : 'tests/extraction/run.mjs is not in this checkout' }, () => {
  assert.equal(EXTRACTION_SYSTEM_PROMPT, promptInCheckScript());
});

test('the prompt asks for the things the human review found missing', () => {
  const p = EXTRACTION_SYSTEM_PROMPT;
  assert.match(p, /more than once[^.]*only once|once[^.]*more than one place|report it once/i, 'duplicates');
  assert.match(p, /next meeting[^.]*not a decision/i, 'next meeting date');
  assert.match(p, /owner[^.]*not[^.]*(approves|approver)/i, 'owner is not the approver');
  assert.match(p, /due[^.]*deadline[^.]*not[^.]*(date of the meeting|event)/i, 'event dates');
});

test('the prompt asks for the meeting date, due wording and events, and clearly worded questions', () => {
  const p = EXTRACTION_SYSTEM_PROMPT;
  assert.match(p, /meeting_date/);
  assert.match(p, /due_event/);
  assert.match(p, /decision only when the notes make clear/i);
  assert.match(p, /propose it as a question/i);
  assert.match(p, /alternatives/);
});
