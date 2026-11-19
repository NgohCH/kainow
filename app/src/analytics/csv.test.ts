import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { csvCell, toCsv } from './csv';

describe('analytics CSV', () => {
  test('csvCell guards = + - @ and quotes commas, quotes and newlines', () => {
    assert.equal(csvCell('=SUM(A1:A2)'), "'=SUM(A1:A2)");
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell('-1'), "'-1");
    assert.equal(csvCell('@cmd'), "'@cmd");
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a, b'), '"a, b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('two\nlines'), '"two\nlines"');
    assert.equal(csvCell('cr\rhere'), '"cr\rhere"');
    // Guarded and quoted together: the guard goes inside the quotes.
    assert.equal(csvCell('=1,2'), `"'=1,2"`);
    assert.equal(csvCell(42), '42');
    assert.equal(csvCell(0), '0');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(''), '');
  });

  test('header lines start with # and carry version, computedAt and coverage', () => {
    const text = toCsv(
      { Panel: 'Project progress', 'Measure definitions version': '1', 'Computed at': '2026-11-09 10:00 (UTC+8)', Coverage: 'Counts all.' },
      ['Name', 'Overdue'],
      [
        ['Alpha', 2],
        ['=Beta', null],
      ],
    );
    const lines = text.split('\r\n');
    assert.equal(lines[0], '# Panel: Project progress');
    assert.equal(lines[1], '# Measure definitions version: 1');
    assert.equal(lines[2], '# Computed at: 2026-11-09 10:00 (UTC+8)');
    assert.equal(lines[3], '# Coverage: Counts all.');
    assert.equal(lines[4], 'Name,Overdue');
    assert.equal(lines[5], 'Alpha,2');
    assert.equal(lines[6], "'=Beta,");
    assert.ok(text.endsWith('\r\n'));
    // A meta value cannot break out of its # line.
    const evil = toCsv({ Filters: 'a\nb,c' }, ['x'], []);
    assert.equal(evil.split('\r\n')[0], '# Filters: a b,c');
    assert.equal(evil.split('\r\n')[1], 'x');
  });
});
