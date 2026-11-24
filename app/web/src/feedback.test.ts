import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canEscalate, canFlagDraft, CATEGORY_LABEL, CATEGORY_MESSAGE, escalatedLine, feedbackErrors, NOTE_MESSAGE, statusActions } from './feedback.ts';

test('feedback form requires a category and a note', () => {
  assert.deepEqual(feedbackErrors('', ''), [CATEGORY_MESSAGE, NOTE_MESSAGE]);
  assert.deepEqual(feedbackErrors('incorrect', '   '), [NOTE_MESSAGE]);
  assert.deepEqual(feedbackErrors('', 'a note'), [CATEGORY_MESSAGE]);
  assert.deepEqual(feedbackErrors('other', 'x'.repeat(2001)), [NOTE_MESSAGE]);
  assert.deepEqual(feedbackErrors('missed_item', 'x'.repeat(2000)), []);
  assert.deepEqual(Object.values(CATEGORY_LABEL), ['Incorrect', 'Missed item', 'Misleading', 'Other']);
  // Only AI-origin draft versions can be flagged.
  assert.equal(canFlagDraft({ origin: 'ai', id: 'd1' }), true);
  assert.equal(canFlagDraft({ origin: 'human', id: 'd2' }), false);
  assert.equal(canFlagDraft(null), false);
});

test('PM sees status actions; Member does not', () => {
  assert.deepEqual(statusActions('open', true).map((a) => a.to), ['reviewed']);
  assert.deepEqual(statusActions('reviewed', true).map((a) => a.to), ['closed', 'open']);
  assert.deepEqual(statusActions('closed', true).map((a) => a.to), ['open']);
  for (const s of ['open', 'reviewed', 'closed'] as const) assert.deepEqual(statusActions(s, false), []);
  assert.equal(canEscalate({ escalatedAt: null }, true), true);
  assert.equal(canEscalate({ escalatedAt: '2026-11-11T02:00:00Z' }, true), false);
  assert.equal(canEscalate({ escalatedAt: null }, false), false);
});

test('escalated list shows no content fields', () => {
  const row = { id: 'f1', projectName: 'Alpha Project', category: 'missed_item' as const, model: null, runRef: 'r1', at: '2026-11-11T02:00:00Z', escalationNote: 'Please look at the prompt.' };
  const line = escalatedLine(row, () => 'when');
  assert.deepEqual(line.fields.map(([k]) => k), ['Project', 'Category', 'Model', 'Run', 'Escalated', 'Note from the Project Manager']);
  assert.deepEqual(line.fields.map(([, v]) => v), ['Alpha Project', 'Missed item', 'Not recorded', 'r1', 'when', 'Please look at the prompt.']);
  // Even if the server sent more, nothing but those six fields is shown.
  const rich = escalatedLine({ ...row, note: 'reporter text', body: 'discussion text', output: 'AI output' } as typeof row, () => 'when');
  assert.equal(JSON.stringify(rich).includes('reporter text') || JSON.stringify(rich).includes('discussion text') || JSON.stringify(rich).includes('AI output'), false);
});

test('feedback statuses have meanings', async () => {
  const { FEEDBACK_STATUS_MEANING } = await import('./feedback.ts');
  assert.deepEqual(FEEDBACK_STATUS_MEANING, { open: 'review', reviewed: 'active', closed: 'closed' });
});
