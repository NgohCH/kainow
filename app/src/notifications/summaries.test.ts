import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADMIN_FALLBACK, emailLine, linkFor, resumptionSummary, shortDate, triggerSummary,
} from './summaries';

test('dates read as Ddd D Mmm', () => {
  assert.equal(shortDate('2026-11-17'), 'Tue 17 Nov');
  assert.equal(shortDate('2026-11-16'), 'Mon 16 Nov');
  assert.equal(shortDate('2026-12-05'), 'Sat 5 Dec');
});

test('one plain line per trigger kind', () => {
  const task = { title: 'Draft the tender', dueOn: '2026-11-16' };
  assert.equal(triggerSummary('reminder', task), "Reminder: 'Draft the tender' is due on Mon 16 Nov");
  assert.equal(triggerSummary('overdue', task), "Overdue: 'Draft the tender' was due on Mon 16 Nov");
  assert.equal(triggerSummary('past_due_set', task), "Due date set in the past: 'Draft the tender' was due on Mon 16 Nov");
  assert.equal(
    triggerSummary('parent_deadline', { ...task, parentDueOn: '2026-11-13' }),
    "Subtask 'Draft the tender' is unfinished past its parent's deadline (Fri 13 Nov)",
  );
  assert.equal(triggerSummary('assignee_unavailable', task), "Task 'Draft the tender' needs a new assignee");
  const risk = { description: 'Supplier may withdraw', reviewOn: '2026-11-18' };
  assert.equal(triggerSummary('risk_review_due', risk), "Risk review due: 'Supplier may withdraw' on Wed 18 Nov");
  assert.equal(triggerSummary('risk_review_missed', risk), "Risk review missed: 'Supplier may withdraw' was due for review on Wed 18 Nov");
});

test('the Administrator fallback names only the project', () => {
  assert.equal(ADMIN_FALLBACK('Harbour Works'), 'A task in Harbour Works needs reassignment.');
});

test('links point at the record, or the work list for a resumption', () => {
  assert.equal(linkFor('p1', 'task', 't1'), '#/projects/p1/work/t1');
  assert.equal(linkFor('p1', 'risk', 'r1'), '#/projects/p1/work/r1');
  assert.equal(linkFor('p1', 'project', 'p1'), '#/projects/p1/work');
});

test('an email line is the summary, a dash and the full link; no link gives the summary alone', () => {
  assert.equal(emailLine('Reminder: x', 'https://kainow.example.org/', '#/projects/p/work/t'), 'Reminder: x — https://kainow.example.org/#/projects/p/work/t');
  assert.equal(emailLine('Reminder: x', 'https://kainow.example.org', '#/projects/p/work/t'), 'Reminder: x — https://kainow.example.org/#/projects/p/work/t');
  assert.equal(emailLine('A task in P needs reassignment.', 'https://kainow.example.org', null), 'A task in P needs reassignment.');
});

test('the resumption summary lists what to check, by section, omitting empty ones', () => {
  assert.equal(
    resumptionSummary('Harbour Works', {
      reviewRequired: ['Draft the tender', 'Book the hall'],
      overdue: [{ title: 'Call the supplier', dueOn: '2026-11-12' }],
      risksPassed: [{ description: 'Supplier may withdraw', reviewOn: '2026-11-13' }],
    }),
    "Harbour Works: work to check after resuming. Deadline review required: 'Draft the tender', 'Book the hall'. " +
      "Overdue: 'Call the supplier' (due Thu 12 Nov). Risk review date passed: 'Supplier may withdraw' (Fri 13 Nov).",
  );
  assert.equal(
    resumptionSummary('Harbour Works', { reviewRequired: [], overdue: [], risksPassed: [] }),
    'Harbour Works: work to check after resuming. Nothing is outstanding.',
  );
  const many = Array.from({ length: 13 }, (_, i) => `T${i + 1}`);
  const s = resumptionSummary('P', { reviewRequired: many, overdue: [], risksPassed: [] });
  assert.match(s, /'T10', and 3 more\.$/);
  assert.doesNotMatch(s, /T11/);
});
