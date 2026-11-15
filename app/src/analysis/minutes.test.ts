import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ModelBadResponse } from '../extraction/model';
import { type MinutesAnswer, parseMinutes, renderMinutes } from './minutes';

const USAGE = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 };
const GOOD = {
  summary: 'We agreed the release date.',
  discussion_points: ['Release timing'],
  decisions: ['Ship on Friday'],
  action_items: [{ text: 'Email the vendor', owner: 'Bob', due: null }],
  open_questions: [],
  risks: ['Vendor may be late'],
};
const ANSWER: MinutesAnswer = {
  summary: 'We agreed the release date.',
  discussionPoints: ['Release timing'],
  decisions: ['Ship on Friday'],
  actionItems: [{ text: 'Email the vendor', owner: 'Bob', due: null }],
  openQuestions: [],
  risks: ['Vendor may be late'],
};
const HEAD = { title: 'Weekly check-in', meetingDate: '2026-11-11', present: ['Ada Member', 'Bob Member'], throughNo: 7 };

describe('minutes answer and rendering', () => {
  test('parseMinutes accepts the schema', () => {
    assert.deepEqual(parseMinutes(JSON.stringify(GOOD), USAGE), ANSWER);
  });

  test('parseMinutes rejects a missing section and a wrong type', () => {
    const { risks: _risks, ...missing } = GOOD;
    const bad: unknown[] = [
      'not json',
      '[]',
      'null',
      JSON.stringify(missing),
      JSON.stringify({ ...GOOD, extra: 1 }),
      JSON.stringify({ ...GOOD, summary: 5 }),
      JSON.stringify({ ...GOOD, decisions: 'Ship' }),
      JSON.stringify({ ...GOOD, decisions: [1] }),
      JSON.stringify({ ...GOOD, action_items: [{ text: 'x', owner: 3, due: null }] }),
      JSON.stringify({ ...GOOD, action_items: [{ text: 'x', owner: null }] }),
      JSON.stringify({ ...GOOD, action_items: [{ text: 'x', owner: null, due: null, extra: 1 }] }),
      JSON.stringify({ ...GOOD, action_items: ['x'] }),
    ];
    for (const content of bad) {
      assert.throws(() => parseMinutes(content, USAGE), (e: unknown) => e instanceof ModelBadResponse && e.usage === USAGE, String(content));
    }
  });

  test('renderMinutes writes the heading block from Kainow records and None recorded for empty sections', () => {
    const text = renderMinutes(HEAD, { ...ANSWER, decisions: [], openQuestions: [], summary: '' });
    const lines = text.split('\n');
    assert.deepEqual(lines.slice(0, 4), ['# Weekly check-in', 'Date: 11 November 2026', 'Present: Ada Member, Bob Member', 'Drafted by AI from messages #1–#7']);
    const section = (name: string) => text.split(`## ${name}\n`)[1].split('\n\n')[0];
    assert.equal(section('Summary'), 'None recorded.');
    assert.equal(section('Discussion points'), '- Release timing');
    assert.equal(section('Decisions'), 'None recorded.');
    assert.equal(section('Open questions'), 'None recorded.');
    assert.equal(section('Risks').trim(), '- Vendor may be late');
    assert.deepEqual(
      [...text.matchAll(/^## (.*)$/gm)].map((m) => m[1]),
      ['Summary', 'Discussion points', 'Decisions', 'Action items', 'Open questions', 'Risks'],
    );
    assert.ok(renderMinutes({ ...HEAD, present: [] }, ANSWER).includes('Present: Not recorded\n'));
    assert.ok(renderMinutes({ ...HEAD, meetingDate: '2026-01-05' }, ANSWER).includes('Date: 5 January 2026\n'));
  });

  test('owner and due print not stated when null', () => {
    const text = renderMinutes(HEAD, {
      ...ANSWER,
      actionItems: [
        { text: 'Email the vendor', owner: 'Bob', due: null },
        { text: 'Book the room', owner: null, due: 'Friday' },
      ],
    });
    assert.ok(text.includes('- Email the vendor — Owner: Bob; Due: not stated'));
    assert.ok(text.includes('- Book the room — Owner: not stated; Due: Friday'));
  });
});
