import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { maskTranscript, quoteSourceFlag, type SpanState } from './masking';

// "#1 Ada\nShip it.\n#2 Ben\nNot yet.\n#3 Ada\nOk.\n"
const text = '#1 Ada\nShip it.\n#2 Ben\nNot yet.\n#3 Ada\nOk.\n';
const spans = (second: SpanState['state'], third: SpanState['state'] = 'visible'): SpanState[] => [
  { headerStart: 0, bodyStart: 7, bodyEnd: 15, state: 'visible' },
  { headerStart: 16, bodyStart: 23, bodyEnd: 31, state: second },
  { headerStart: 32, bodyStart: 39, bodyEnd: 42, state: third },
];

describe('maskTranscript', () => {
  test('maskTranscript keeps visible messages and masks others', () => {
    assert.equal(maskTranscript(text, spans('visible')), text);
    assert.equal(maskTranscript(text, spans('deleted')), '#1 Ada\nShip it.\n[Message deleted]\n#3 Ada\nOk.\n');
    assert.equal(maskTranscript(text, spans('hidden', 'deleted')), '#1 Ada\nShip it.\n[Message hidden]\n[Message deleted]\n');
  });
});

describe('quoteSourceFlag', () => {
  test('quoteSourceFlag reports the state of the message containing the quote', () => {
    assert.equal(quoteSourceFlag(23, 30, spans('deleted')), 'deleted');
    assert.equal(quoteSourceFlag(23, 30, spans('hidden')), 'hidden');
    assert.equal(quoteSourceFlag(7, 14, spans('deleted')), null);
    assert.equal(quoteSourceFlag(23, 30, spans('visible')), null);
    assert.equal(quoteSourceFlag(null, null, spans('deleted')), null);
    assert.equal(quoteSourceFlag(100, 104, spans('deleted')), null);
  });
});
