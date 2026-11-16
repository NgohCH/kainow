import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findMarks, parseLeaveOut } from './leave-out';

const spans = (body: string, marks: ReturnType<typeof findMarks>) => marks.map((m) => [m.kind, m.phrase, body.slice(m.start, m.end)]);

describe('leave-out marks', () => {
  test('the Leave out box splits on new lines and commas', () => {
    assert.deepEqual(parseLeaveOut(' Vendor name,\nthe penalty clause\r\n\n , Project  Falcon ,vendor name'), ['Vendor name', 'the penalty clause', 'Project Falcon', 'vendor name']);
    assert.deepEqual(parseLeaveOut(''), []);
    assert.deepEqual(parseLeaveOut(' , \n '), []);
  });

  test('leave-out matching ignores case, accents and line breaks', () => {
    const body = 'We met the CAFÉ  Société team.\nThe penalty\r\n   clause was discussed with cafe societe again.';
    const marks = findMarks(body, ['café société', 'Penalty Clause'], []);
    assert.deepEqual(spans(body, marks), [
      ['leave_out', 'café société', 'CAFÉ  Société'],
      ['leave_out', 'Penalty Clause', 'penalty\r\n   clause'],
      ['leave_out', 'café société', 'cafe societe'],
    ]);
    // Decomposed accents in the body, and a full-width form (NFKD), match too.
    const decomposed = 'Café Société and ＰＥＮＡＬＴＹ clause';
    assert.deepEqual(spans(decomposed, findMarks(decomposed, ['CAFÉ SOCIÉTÉ', 'penalty clause'], [])), [
      ['leave_out', 'CAFÉ SOCIÉTÉ', 'Café Société'],
      ['leave_out', 'penalty clause', 'ＰＥＮＡＬＴＹ clause'],
    ]);
  });

  test('matches whole words only', () => {
    const body = 'The vendors met; vendor-led work and the vendor. Avendor is not one; VENDOR is.';
    assert.deepEqual(spans(body, findMarks(body, ['vendor'], [])), [
      ['leave_out', 'vendor', 'vendor'],
      ['leave_out', 'vendor', 'vendor'],
      ['leave_out', 'vendor', 'VENDOR'],
    ]);
    assert.deepEqual(findMarks('Penalty clauses apply.', ['penalty clause'], []), []);
  });

  test('Markdown emphasis does not hide a phrase, and the mark covers the original words', () => {
    const body = 'The **penalty** clause, the *penalty clause*, `penalty` ~~clause~~ and _Acme_ Supplies.';
    assert.deepEqual(spans(body, findMarks(body, ['penalty clause', 'Acme Supplies'], [])), [
      ['leave_out', 'penalty clause', 'penalty** clause'],
      ['leave_out', 'penalty clause', 'penalty clause'],
      ['leave_out', 'penalty clause', 'penalty` ~~clause'],
      ['leave_out', 'Acme Supplies', 'Acme_ Supplies'],
    ]);
    // Emphasis written into the phrase is ignored as well.
    assert.deepEqual(spans('Acme Supplies', findMarks('Acme Supplies', ['**Acme** Supplies'], [])), [['leave_out', '**Acme** Supplies', 'Acme Supplies']]);
  });

  test('hyphens and dashes count as spaces, in the body and in the phrase', () => {
    const body = 'A penalty-clause, a penalty – clause, a penalty—clause and a penalty clause.';
    assert.deepEqual(spans(body, findMarks(body, ['penalty clause'], [])), [
      ['leave_out', 'penalty clause', 'penalty-clause'],
      ['leave_out', 'penalty clause', 'penalty – clause'],
      ['leave_out', 'penalty clause', 'penalty—clause'],
      ['leave_out', 'penalty clause', 'penalty clause'],
    ]);
    const plain = 'The penalty clause applies.';
    assert.deepEqual(spans(plain, findMarks(plain, ['penalty-clause'], [])), [['leave_out', 'penalty-clause', 'penalty clause']]);
    const named = 'Siti Nur-Aisyah agreed; siti nur aisyah will follow up.';
    assert.deepEqual(spans(named, findMarks(named, [], ['Siti Nur-Aisyah'])), [
      ['name', 'Siti Nur-Aisyah', 'Siti Nur-Aisyah'],
      ['name', 'Siti Nur-Aisyah', 'siti nur aisyah'],
    ]);
  });

  test('member names are marked', () => {
    const body = 'Ada Lim agreed the plan; ada  lim will tell Ben. Adam Limbo was not there.';
    const marks = findMarks(body, ['plan'], ['Ada Lim', 'Ben Tan', '']);
    assert.deepEqual(spans(body, marks), [
      ['name', 'Ada Lim', 'Ada Lim'],
      ['leave_out', 'plan', 'plan'],
      ['name', 'Ada Lim', 'ada  lim'],
    ]);
  });
});
