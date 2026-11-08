import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DueReading, Item, Run } from './api.ts';
import { blocksApproval, dueLine, editFormFrom, formatDay, formatSpan } from './due.ts';

const reading = (over: Partial<DueReading>): DueReading => ({
  state: 'needs_date', earliest: null, latest: null, event: null, reason: null, note: null, usedMeetingDate: false, ...over,
});

function item(over: Partial<Item> = {}): Item {
  return {
    id: 'i', position: 0, kind: 'action', text: 'Do it', owner: null, due: null, dueEvent: null, alternatives: [],
    dueReading: reading({ reason: 'no due given' }), reviewerDue: null,
    quote: 'q', quoteStart: 0, quoteEnd: 1, quoteMatches: 1, chosenOccurrence: null, reviewStatus: 'pending', ...over,
  };
}

function run(meetingDate: string | null, meetingDateSource: Run['meetingDateSource']): Run {
  return {
    id: 'r', sourceVersionId: 'v', status: 'succeeded', failureCode: null, failureDetail: null, attempts: 1,
    itemCount: 1, unlocatedCount: 0, createdAt: '', finishedAt: null, meetingDate, meetingDateSource,
  };
}

test('formatDay and formatSpan write days the way people read them', () => {
  assert.equal(formatDay('2026-11-04'), '4 Nov 2026');
  assert.equal(formatSpan('2026-11-05', '2026-11-05'), '5 Nov 2026');
  assert.equal(formatSpan('2026-11-04', '2026-11-07'), '4–7 Nov 2026');
  assert.equal(formatSpan('2026-11-28', '2026-12-02'), '28 Nov – 2 Dec 2026');
  assert.equal(formatSpan('2026-12-30', '2027-01-04'), '30 Dec 2026 – 4 Jan 2027');
});

test('the due line says what the notes say and what Kainow made of it', () => {
  const fromNotes = item({ due: 'Immediate', dueReading: reading({ state: 'range', earliest: '2026-11-04', latest: '2026-11-07', usedMeetingDate: true }) });
  assert.deepEqual(dueLine(fromNotes, run('2026-11-04', 'notes')), {
    tone: 'plain',
    text: 'Notes say “Immediate” → 4–7 Nov 2026 (from the meeting date in the notes, 4 Nov 2026)',
  });
  assert.deepEqual(dueLine(fromNotes, run('2026-11-04', 'reviewer')), {
    tone: 'plain',
    text: 'Notes say “Immediate” → 4–7 Nov 2026 (from the meeting date you entered, 4 Nov 2026)',
  });
  const exact = item({ due: '5 November 2026', dueReading: reading({ state: 'exact', earliest: '2026-11-05', latest: '2026-11-05' }) });
  assert.deepEqual(dueLine(exact, run(null, 'none')), { tone: 'plain', text: 'Notes say “5 November 2026” → 5 Nov 2026' });
  const several = item({ due: 'A: 6 November 2026; B: 9 November 2026', dueReading: reading({ state: 'range', earliest: '2026-11-06', latest: '2026-11-09', note: 'several dates in one item' }) });
  assert.equal(dueLine(several, run(null, 'none'))?.text, 'Notes say “A: 6 November 2026; B: 9 November 2026” → 6–9 Nov 2026 (several dates in one item)');
});

test('a reviewer due, an event and a missing date each have their own line', () => {
  const set = item({ due: 'Friday', reviewerDue: { earliest: '2026-11-10', latest: '2026-11-12', event: null, ignoreModelEvent: false }, dueReading: reading({ state: 'range', earliest: '2026-11-10', latest: '2026-11-12' }) });
  assert.deepEqual(dueLine(set, run(null, 'none')), { tone: 'plain', text: 'Set by reviewer: 10–12 Nov 2026' });
  const waits = item({ dueReading: reading({ state: 'event', event: 'approval by Dr Goh' }) });
  assert.deepEqual(dueLine(waits, run(null, 'none')), { tone: 'plain', text: 'Waits on: approval by Dr Goh' });
  const friday = item({ due: 'Friday', dueReading: reading({ reason: 'relative wording and no meeting date' }) });
  assert.deepEqual(dueLine(friday, run(null, 'none')), { tone: 'warn', text: 'Needs a date: “Friday”: relative wording and no meeting date' });
  assert.deepEqual(dueLine(item(), run(null, 'none')), { tone: 'warn', text: 'Needs a date: no due given' });
  for (const kind of ['decision', 'question', 'risk'] as const) {
    assert.equal(dueLine(item({ kind }), run(null, 'none')), null, kind);
  }
});

test('only an action that needs a date blocks approval', () => {
  assert.equal(blocksApproval(item()), true);
  assert.equal(blocksApproval(item({ kind: 'decision' })), false);
  assert.equal(blocksApproval(item({ dueReading: reading({ state: 'event', event: 'x' }) })), false);
  assert.equal(blocksApproval(item({ dueReading: reading({ state: 'exact', earliest: '2026-11-05', latest: '2026-11-05' }) })), false);
});

test("the edit form starts from the wording and the reviewer's due, so saving new wording keeps the dates", () => {
  const withDates = item({ due: 'Friday', owner: 'Sam', reviewerDue: { earliest: '2026-11-10', latest: '2026-11-12', event: null, ignoreModelEvent: false } });
  assert.deepEqual(editFormFrom(withDates), { text: 'Do it', owner: 'Sam', due: 'Friday', dueEarliest: '2026-11-10', dueLatest: '2026-11-12', dueEvent: '', ignoreModelEvent: false });
  assert.deepEqual(editFormFrom(item({ reviewerDue: { earliest: null, latest: null, event: 'Senate', ignoreModelEvent: false } })), {
    text: 'Do it', owner: '', due: '', dueEarliest: '', dueLatest: '', dueEvent: 'Senate', ignoreModelEvent: false,
  });
  assert.deepEqual(editFormFrom(item()), { text: 'Do it', owner: '', due: '', dueEarliest: '', dueLatest: '', dueEvent: '', ignoreModelEvent: false });
  assert.equal(editFormFrom(item({ reviewerDue: { earliest: null, latest: null, event: null, ignoreModelEvent: true } })).ignoreModelEvent, true);
});
