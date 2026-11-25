import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notePlace, parseNoteHash, parseRunHash, placeLink, recordHref, sourceHref } from './proposalLinks.ts';
import { currentMenuHref } from './ui/menu.ts';

const P = '0f8fad5b-d9cb-469f-a165-70867728950e';
const S = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const T = '16fd2706-8baf-433b-82eb-8c7fada847da';
const src = (sourceKind: string, threadId: string | null = null) => ({ sourceId: S, sourceKind, threadId, versionNo: 2 });
const item = { quoteStart: 5, quoteEnd: 12, quoteMatches: 1, chosenOccurrence: null };

test('a source opens at its version; a discussion at its thread', () => {
  for (const kind of ['notes', 'minutes', 'summary']) assert.equal(sourceHref(P, src(kind)), `#/notes/${S}/v/2`);
  assert.equal(sourceHref(P, src('discussion', T)), `#/projects/${P}/threads/${T}`);
  assert.equal(sourceHref(P, src('discussion')), null);
});

test('a proposal links to the exact place in its note, minutes or summary', () => {
  for (const kind of ['notes', 'minutes', 'summary']) {
    assert.deepEqual(placeLink(P, { ...src(kind), opens: true }, item, undefined), { href: `#/notes/${S}/v/2?at=5-12`, exact: true });
  }
  const repeated = { ...item, quoteMatches: 2, occurrences: [{ start: 5, end: 12 }, { start: 40, end: 47 }] };
  assert.equal(placeLink(P, { ...src('notes'), opens: true }, repeated, 1)?.href, `#/notes/${S}/v/2?at=40-47`);
  assert.equal(placeLink(P, { ...src('notes'), opens: true }, { ...repeated, chosenOccurrence: 1 }, undefined)?.href, `#/notes/${S}/v/2?at=40-47`);
  const unplaced = { ...item, quoteStart: null, quoteEnd: null, quoteMatches: 0 };
  assert.deepEqual(placeLink(P, { ...src('notes'), opens: true }, unplaced, undefined), { href: `#/notes/${S}/v/2`, exact: false });
});

test('a proposal from a discussion links to its message, or to the discussion when no message is known', () => {
  const ev = { threadId: T, messageNo: 12 };
  assert.deepEqual(placeLink(P, { ...src('discussion', T), opens: true }, { ...item, discussionEvidence: ev }, undefined), { href: `#/projects/${P}/threads/${T}?m=12`, exact: true });
  assert.deepEqual(placeLink(P, { ...src('discussion', T), opens: true }, { ...item, discussionEvidence: null }, undefined), { href: `#/projects/${P}/threads/${T}`, exact: false });
});

test('no link when the source cannot be opened, or the quote is masked', () => {
  assert.equal(placeLink(P, { ...src('notes'), opens: false }, item, undefined), null);
  assert.equal(placeLink(P, src('notes'), item, undefined), null);
  assert.equal(placeLink(P, { ...src('discussion', T), opens: false }, { ...item, discussionEvidence: { threadId: T, messageNo: 12 } }, undefined), null);
  for (const sourceFlag of ['deleted', 'hidden', 'source_deleted'] as const) {
    assert.equal(placeLink(P, { ...src('notes'), opens: true }, { ...item, sourceFlag }, undefined), null);
  }
});

test('a record opens at its own place: a task on its page, the others at their row in Work', () => {
  assert.equal(recordHref(P, { kind: 'task', id: T }), `#/projects/${P}/tasks/${T}`);
  for (const kind of ['decision', 'question', 'risk']) assert.equal(recordHref(P, { kind, id: T }), `#/projects/${P}/work/${T}`);
});

test("a run's address, alone or with one of its proposals", () => {
  assert.deepEqual(parseRunHash(`#/runs/${S}/${T}`), { runId: S, itemId: T });
  assert.deepEqual(parseRunHash(`#/runs/${S}`), { runId: S, itemId: undefined });
  assert.equal(parseRunHash(`#/runs/${S}/x`), null);
  assert.equal(currentMenuHref(`#/runs/${S}/${T}`), '#/projects');
});

test('note addresses, old and new', () => {
  assert.deepEqual(parseNoteHash(`#/notes/${S}`), { sourceId: S, versionNo: null, place: null });
  assert.deepEqual(parseNoteHash(`#/notes/${S}/v/2`), { sourceId: S, versionNo: 2, place: null });
  assert.deepEqual(parseNoteHash(`#/notes/${S}/v/2?at=5-12`), { sourceId: S, versionNo: 2, place: { start: 5, end: 12 } });
  assert.equal(parseNoteHash(`#/notes/${S}/v/2?at=x`), null);
  assert.equal(parseNoteHash('#/notes'), null);
  assert.equal(currentMenuHref(`#/notes/${S}/v/2?at=5-12`), '#/projects');
});

test('a place is marked only where it fits the text', () => {
  assert.deepEqual(notePlace('We agreed to ship.', { start: 3, end: 9 }), { before: 'We ', match: 'agreed', after: ' to ship.' });
  assert.equal(notePlace('short', { start: 3, end: 9 }), null);
  assert.equal(notePlace('short', { start: 3, end: 3 }), null);
  assert.equal(notePlace('short', null), null);
});
