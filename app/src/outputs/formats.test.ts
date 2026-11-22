import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { effectiveFormats } from './formats';

const ALL = {
  approvedInputFormats: ['txt', 'md', 'docx', 'pdf'] as Array<'txt' | 'md' | 'docx' | 'pdf'>,
  approvedOutputFormats: ['md', 'docx', 'pdf', 'csv'] as Array<'md' | 'docx' | 'pdf' | 'csv'>,
};

describe('effective formats', () => {
  test('null project lists mean all approved', () => {
    const e = effectiveFormats({ ...ALL, approvedInputFormats: ['txt', 'pdf'] }, null);
    assert.deepEqual(e.input.map((f) => f.format), ['txt', 'pdf']);
    assert.deepEqual(e.output.map((f) => f.format), ['md', 'docx', 'pdf', 'csv']);
    const n = effectiveFormats(ALL, { inputFormats: null, outputFormats: null });
    assert.equal(n.input.length, 4);
  });

  test('project subset is intersected with approved', () => {
    const e = effectiveFormats({ ...ALL, approvedInputFormats: ['txt', 'md', 'docx'] }, { inputFormats: ['md', 'pdf'], outputFormats: ['csv', 'xx'] });
    assert.deepEqual(e.input.map((f) => f.format), ['md'], 'pdf is not approved so the project cannot have it');
    assert.deepEqual(e.output.map((f) => f.format), ['csv']);
  });

  test('sources are labelled organisation or project', () => {
    const e = effectiveFormats(ALL, { inputFormats: ['md'], outputFormats: null });
    assert.deepEqual(e.input, [{ format: 'md', source: 'project' }]);
    assert.ok(e.output.every((f) => f.source === 'organisation'));
  });
});
