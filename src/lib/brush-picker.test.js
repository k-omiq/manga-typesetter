import { describe, it, expect } from 'vitest';
import {
  brushSearchKey,
  filterBrushes,
  importSentence,
  pickedSettings,
  tipDims,
} from './brush-picker.js';
import { defaultBrushSettings } from './brush.js';
import { sanitiseBrushSettings, BUILTIN_BRUSH } from './brush-library.svelte.js';

const ROUND = { id: BUILTIN_BRUSH, name: 'Round', builtin: true };

const entry = (over = {}) => ({
  id: 'a1b2c3',
  name: 'Nijimi',
  width: 1468,
  height: 1297,
  source: 'pixels',
  settings: sanitiseBrushSettings({ size: 96, spacing: 4, angle: 330 }),
  ...over,
});

describe('the picker search', () => {
  it('ignores case and spacing on both sides', () => {
    expect(brushSearchKey(' Battle  Pen ')).toBe('battlepen');
    expect(brushSearchKey(null)).toBe('');
  });

  it('matches part of a name, however it was typed', () => {
    const list = [ROUND, entry(), entry({ id: 'b2', name: 'Battle Letter Pen' })];
    expect(filterBrushes(list, 'battleletter').map((b) => b.id)).toEqual(['b2']);
    expect(filterBrushes(list, 'NIJ').map((b) => b.id)).toEqual(['a1b2c3']);
    expect(filterBrushes(list, 'pen').map((b) => b.id)).toEqual(['b2']);
  });

  it('takes the words in any order, and does not need the ones between them', () => {
    const list = [ROUND, entry(), entry({ id: 'b2', name: 'Battle Letter Pen' })];
    expect(filterBrushes(list, 'battle pen').map((b) => b.id)).toEqual(['b2']);
    expect(filterBrushes(list, 'PEN   Battle').map((b) => b.id)).toEqual(['b2']);
    expect(filterBrushes(list, 'battle nijimi')).toEqual([]);
  });

  it('matches a japanese sub tool name', () => {
    const list = [entry({ id: 'j1', name: 'ボロ文字__5' }), entry({ id: 'j2', name: '滲み_' })];
    expect(filterBrushes(list, '文字').map((b) => b.id)).toEqual(['j1']);
  });

  it('shows everything for an empty or blank query, in the given order', () => {
    const list = [ROUND, entry(), entry({ id: 'b2', name: 'Battle' })];
    expect(filterBrushes(list, '').map((b) => b.id)).toEqual(['round', 'a1b2c3', 'b2']);
    expect(filterBrushes(list, '   ').map((b) => b.id)).toEqual(['round', 'a1b2c3', 'b2']);
  });

  it("never hands back the caller's own array", () => {
    const list = [ROUND];
    expect(filterBrushes(list, '')).not.toBe(list);
  });

  it('survives a list that is not one', () => {
    expect(filterBrushes(null, 'x')).toEqual([]);
    expect(filterBrushes([{ id: 'x' }], 'x')).toEqual([]);
  });
});

describe('picking a brush', () => {
  it('takes the imported settings and the id, and nothing else', () => {
    const before = { ...defaultBrushSettings(), color: '#c81e1e', postCorrect: 90 };
    const after = pickedSettings(before, entry());
    expect(after.brush).toBe('a1b2c3');
    expect(after.size).toBe(96);
    expect(after.spacing).toBe(4);
    expect(after.angle).toBe(330);
  });

  it('leaves the letterer their colour, dynamics and correction', () => {
    const before = {
      ...defaultBrushSettings(),
      color: '#c81e1e',
      dyn: { src: 'pressure', amount: 33 },
      postCorrect: 90,
    };
    const after = pickedSettings(before, entry());
    expect(after.color).toBe('#c81e1e');
    expect(after.dyn).toEqual({ src: 'pressure', amount: 33 });
    expect(after.postCorrect).toBe(90);
  });

  it('is the contract 2.3 wrote: a spread of the entry over the tool', () => {
    const before = { ...defaultBrushSettings(), color: '#c81e1e' };
    const e = entry();
    expect(pickedSettings(before, e)).toEqual({ ...before, ...e.settings, brush: e.id });
  });

  it('does not mutate the settings it was given', () => {
    const before = defaultBrushSettings();
    const copy = JSON.parse(JSON.stringify(before));
    pickedSettings(before, entry());
    expect(before).toEqual(copy);
  });

  it('swaps only the tip when the round brush is picked', () => {
    const before = { ...defaultBrushSettings(), brush: 'a1b2c3', size: 96, color: '#c81e1e' };
    const after = pickedSettings(before, ROUND);
    expect(after).toEqual({ ...before, brush: BUILTIN_BRUSH });
  });

  it('keeps the current brush when handed nothing', () => {
    const before = { ...defaultBrushSettings(), brush: 'a1b2c3' };
    expect(pickedSettings(before, null).brush).toBe('a1b2c3');
  });
});

describe('the size under the grid', () => {
  it("is the tip's true pixels", () => {
    expect(tipDims(entry())).toBe('1468 × 1297');
  });

  it('is empty for a brush that has no pixels', () => {
    expect(tipDims(ROUND)).toBe('');
    expect(tipDims({ width: 0, height: 10 })).toBe('');
    expect(tipDims(undefined)).toBe('');
  });
});

describe('what the import toast says', () => {
  const r = (over) => ({ added: 0, replaced: 0, previewQuality: 0, errors: [], ...over });

  it('counts what was added', () => {
    expect(importSentence(r({ added: 12 }))).toBe('12 brushes added');
    expect(importSentence(r({ added: 1 }))).toBe('1 brush added');
  });

  it('names the ones that fell back to the embedded preview', () => {
    expect(importSentence(r({ added: 12, previewQuality: 3 }))).toBe(
      '12 brushes added, 3 at preview quality',
    );
  });

  it('says nothing about preview quality when none fell back', () => {
    expect(importSentence(r({ added: 4, previewQuality: 0 }))).not.toContain('preview');
  });

  it('installs what it could and still reports the failures', () => {
    expect(
      importSentence(
        r({
          added: 5,
          errors: [
            { path: '/a.sut', error: 'not a brush file' },
            { path: '/b.sut', error: 'not a brush file' },
          ],
        }),
      ),
    ).toBe('5 brushes added - 2 files could not be imported');
  });

  it("shows a single failure's own message, which is the useful part", () => {
    expect(
      importSentence(
        r({ errors: [{ path: '/a.sut', error: 'Brush import needs the desktop app' }] }),
      ),
    ).toBe('No brushes added - Brush import needs the desktop app');
  });

  it('falls back to a count when that one failure had no message', () => {
    expect(importSentence(r({ errors: [{ path: '/a.sut', error: '' }] }))).toBe(
      'No brushes added - 1 file could not be imported',
    );
  });

  it('says so when the files held nothing and nothing went wrong', () => {
    expect(importSentence(r({}))).toBe('Nothing to add - those files hold no brushes');
  });

  it('survives a result that is not one', () => {
    expect(importSentence(undefined)).toBe('Nothing to add - those files hold no brushes');
    expect(importSentence({ added: 'lots', errors: 'none' })).toBe(
      'Nothing to add - those files hold no brushes',
    );
  });
});
