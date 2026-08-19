import { describe, it, expect } from 'vitest';
import { normalizeTranslations } from './importer.js';
import { lineTags } from './tags.svelte.js';

// Only the tag half of the importer is covered here. The shape-tolerance above
// it (bare strings, `{text}`, `natural`/`stylised`, the four ways a file can
// wrap its pages) is exercised end-to-end through `applyTranslations` in
// library.test.js; what is new - and what a re-import can silently lose - is
// what a file says about tags.
const firstLine = (lines) => normalizeTranslations({ texts: lines })[0].lines[0];

describe('tags coming in from a translations file', () => {
  it('leaves `tags` absent when the file does not mention them', () => {
    // Absent is not the same as empty, and the difference is load-bearing: it is
    // what lets `lineTags` fall back to the legacy `type`, and what lets a
    // re-import carry the user's own tags over the file's silence. An array
    // materialised for every line would read as the user having deliberately
    // cleared the lot.
    const l = firstLine([{ n: 1, en: 'Hi', type: 'sfx' }]);
    expect('tags' in l).toBe(false);
    expect(lineTags(l)).toEqual(['sfx']);
  });

  it('folds, dedupes and caps what the file does say', () => {
    const l = firstLine([{ n: 1, en: 'Hi', tags: ['SFX', ' sfx ', '', 7, 'Sound   Effect'] }]);
    expect(l.tags).toEqual(['sfx', 'sound effect']);
  });

  it('makes `type` follow the tags rather than the file’s own field', () => {
    // A file carrying both, disagreeing, would otherwise land a line whose queue
    // badge and whose JSON/PSD export said different things about it.
    expect(firstLine([{ n: 1, en: 'Hi', type: 'dialogue', tags: ['whisper', 'sfx'] }]).type).toBe('sfx');
    expect(firstLine([{ n: 1, en: 'Hi', type: 'sfx', tags: [] }]).type).toBe('dialogue');
  });

  it('reads an explicitly emptied list as no tags, not as fall back to type', () => {
    const l = firstLine([{ n: 1, en: 'Hi', type: 'sfx', tags: [] }]);
    expect(lineTags(l)).toEqual([]);
  });

  it('ignores a `tags` that is not a list', () => {
    for (const tags of ['sfx', 7, null, {}]) {
      expect('tags' in firstLine([{ n: 1, en: 'Hi', type: 'narration', tags }])).toBe(false);
    }
  });

  it('never invents tags for a bare string line', () => {
    expect(normalizeTranslations(['One', 'Two'])[0].lines.every((l) => !('tags' in l))).toBe(true);
  });
});

describe('invalid top-level shapes and crash resilience', () => {
  it('rejects null input with clear error', () => {
    expect(() => normalizeTranslations(null)).toThrow('unrecognized translations JSON');
  });

  it('rejects undefined or primitive top-level inputs', () => {
    expect(() => normalizeTranslations(undefined)).toThrow('unrecognized translations JSON');
    expect(() => normalizeTranslations(123)).toThrow('unrecognized translations JSON');
    expect(() => normalizeTranslations('not an object')).toThrow('unrecognized translations JSON');
    expect(() => normalizeTranslations(true)).toThrow('unrecognized translations JSON');
  });

  it('rejects { pages: {} } or non-array pages property', () => {
    expect(() => normalizeTranslations({ pages: {} })).toThrow('unrecognized translations JSON');
    expect(() => normalizeTranslations({ pages: null })).toThrow('unrecognized translations JSON');
    expect(() => normalizeTranslations({ pages: 'not-an-array' })).toThrow('unrecognized translations JSON');
  });

  it('safely skips null and undefined page entries in arrays', () => {
    const res = normalizeTranslations([null, { texts: ['Hello'] }, null]);
    expect(res).toHaveLength(1);
    expect(res[0].lines).toHaveLength(1);
    expect(res[0].lines[0].en).toBe('Hello');
  });

  it('handles array consisting entirely of null entries [null]', () => {
    const res = normalizeTranslations([null]);
    expect(res).toEqual([{ lines: [] }]);
  });

  it('safely skips null line entries in texts or lines array', () => {
    const res = normalizeTranslations({ texts: [null, { en: 'Hello' }, null] });
    expect(res[0].lines).toHaveLength(1);
    expect(res[0].lines[0].en).toBe('Hello');
    expect(res[0].lines[0].n).toBe(1);
  });

  it('handles { texts: [null] } with empty output lines', () => {
    const res = normalizeTranslations({ texts: [null] });
    expect(res).toEqual([{ lines: [] }]);
  });
});

describe('page-array detection and alternative page key shapes', () => {
  it('recognizes page arrays with text_lines', () => {
    const res = normalizeTranslations([{ text_lines: [{ text: 'Hello text_lines' }] }]);
    expect(res).toHaveLength(1);
    expect(res[0].lines).toHaveLength(1);
    expect(res[0].lines[0].en).toBe('Hello text_lines');
  });

  it('recognizes page arrays with items and translations keys', () => {
    const res1 = normalizeTranslations([{ items: [{ en: 'Item 1' }] }]);
    expect(res1[0].lines[0].en).toBe('Item 1');
    const res2 = normalizeTranslations([{ translations: [{ translation: 'Trans 1' }] }]);
    expect(res2[0].lines[0].en).toBe('Trans 1');
  });

  it('recognizes top-level single page objects with text_lines / items / translations', () => {
    const res = normalizeTranslations({ text_lines: [{ text: 'Single page' }] });
    expect(res).toHaveLength(1);
    expect(res[0].lines[0].en).toBe('Single page');
  });
});

describe('0-indexed line numbering and uniqueness', () => {
  it('detects 0-indexed lines and shifts by +1 to prevent duplicates', () => {
    const res = normalizeTranslations([{ n: 0, en: 'A' }, { n: 1, en: 'B' }]);
    expect(res[0].lines).toHaveLength(2);
    expect(res[0].lines[0]).toMatchObject({ n: 1, en: 'A' });
    expect(res[0].lines[1]).toMatchObject({ n: 2, en: 'B' });
  });

  it('handles 0-indexing across id, number, index aliases', () => {
    const resId = normalizeTranslations([{ id: 0, en: 'First' }, { id: 1, en: 'Second' }]);
    expect(resId[0].lines.map((l) => l.n)).toEqual([1, 2]);
    const resNum = normalizeTranslations([{ number: 0, en: 'First' }, { number: 1, en: 'Second' }]);
    expect(resNum[0].lines.map((l) => l.n)).toEqual([1, 2]);
    const resIdx = normalizeTranslations([{ index: 0, en: 'First' }, { index: 1, en: 'Second' }]);
    expect(resIdx[0].lines.map((l) => l.n)).toEqual([1, 2]);
  });

  it('preserves standard 1-based line numbering without shifting', () => {
    const res = normalizeTranslations([{ n: 1, en: 'A' }, { n: 2, en: 'B' }]);
    expect(res[0].lines[0].n).toBe(1);
    expect(res[0].lines[1].n).toBe(2);
  });

  it('preserves explicit higher line numbers when 0 is not present', () => {
    const res = normalizeTranslations([{ lines: [{ n: 7, en: 'Specific' }] }]);
    expect(res[0].lines[0].n).toBe(7);
  });

  it('treats single n: 0 line as n: 1', () => {
    const res = normalizeTranslations([{ n: 0, en: 'Lone' }]);
    expect(res[0].lines[0].n).toBe(1);
  });
});
