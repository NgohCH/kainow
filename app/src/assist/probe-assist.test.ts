import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { JsonSchemaModel } from '../extraction/model';
import { datesNotInInput, probeFolder, selectMaterial } from './probe-assist-cli';

const DOC = {
  name: 'week-1.txt',
  text: [
    '## Decisions',
    'The team decided to move the vendor review to 12 November because the delivery schedule slipped. Ms Aisyah owns the follow-up and will report back to the steering committee before the next meeting.',
    '## Risks',
    'Ada risiko bahawa jadual tidak dapat dipenuhi jika kelulusan lewat diterima. The budget for the second phase is tight and any extra scope needs to be agreed first by finance.',
  ].join('\n\n'),
};

/** Answers by schema: citations to P1 and a P9 that was never sent; a summary that keeps "budget". */
const fake: JsonSchemaModel = {
  async callJson(_req, schema) {
    const usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 };
    const name = (schema as { name: string }).name;
    if (name === 'assist_answer') return { content: JSON.stringify({ answer_markdown: 'Moved to 12 November [P1] and 30 December [P9].', not_found: false, cited: ['P1', 'P9'] }), usage };
    if (name === 'assist_report') return { content: JSON.stringify({ sections: [{ section: 'Summary', markdown: 'Review moved [P1].', cited: ['P1'] }] }), usage };
    return { content: JSON.stringify({ summary_markdown: 'The budget is tight; the review moved.', omitted_categories: ['prices'] }), usage };
  },
};

describe('probe-assist (fake model)', () => {
  test('in-memory material: matching passages first, markers in order; nothing for unknown words', () => {
    const m = selectMaterial([DOC], ['risiko', 'jadual']);
    assert.ok(m.length >= 1);
    assert.equal(m[0].marker, 'P1');
    assert.match(m[0].text, /risiko/);
    assert.deepEqual(selectMaterial([DOC], ['zzzunknown']), []);
  });

  test('dates not in the input are counted', () => {
    assert.equal(datesNotInInput('On 12 November and 30 December.', 'met on 12 November'), 1);
  });

  test('prints unknown markers, failed citation checks, surviving Leave out phrases and usage, never the AI text by default', async () => {
    const lines: string[] = [];
    const total = await probeFolder(fake, 'model-x', [DOC], { questions: ['When is the vendor review?'], leaveOut: 'budget, gaji', log: (l) => lines.push(l) });
    const out = lines.join('\n');
    assert.match(out, /1 unknown markers \(cited but not sent: must be 0\) P9/);
    assert.match(out, /citation check FAILED/);
    assert.match(out, /dates not found word-for-word in the passages 1/);
    assert.match(out, /Leave out phrases surviving into the draft: 1 \(budget\)/);
    assert.match(out, /Total usage: \d+ input, 0 cached input, \d+ output tokens/);
    assert.doesNotMatch(out, /Moved to 12 November/);
    // 1 question + 10 reports + 1 summary
    assert.equal(total.inputTokens, 1200);
  });
});
