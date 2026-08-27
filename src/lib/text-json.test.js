import { describe, it, expect } from 'vitest';
import { serializePageText, buildTextJson } from './text-json.js';
import { PAGE_W, PAGE_H } from './store.svelte.js';
import { carryTagsForward } from './tags.svelte.js';

describe('serializePageText', () => {
  // Unknown, said as unknown. It used to publish PAGE_W/PAGE_H here, which is a
  // space the page was never in: every `box` and `placed` in this document is
  // quoted in the page's own coordinates, so a consumer that scaled by the
  // stated size placed every line against an 850x1200 sheet the art never was.
  it('says the page size is unknown rather than inventing one for an unmeasured page', () => {
    const unmeasuredPage = {
      id: 1,
      w: 0,
      h: 0,
      lines: [],
      boxes: [],
    };
    const out = serializePageText(unmeasuredPage);
    expect(out.width).toBeNull();
    expect(out.height).toBeNull();
    // …and the invented pair really is gone, not merely different.
    expect(out.width).not.toBe(PAGE_W);
    expect(out.height).not.toBe(PAGE_H);
  });

  it('says unknown for a page with no size fields at all', () => {
    const out = serializePageText({ id: 3, lines: [], boxes: [] });
    expect([out.width, out.height]).toEqual([null, null]);
  });

  it('preserves measured page dimensions when width and height are non-zero', () => {
    const measuredPage = {
      id: 2,
      w: 1200,
      h: 1800,
      lines: [],
      boxes: [],
    };
    const out = serializePageText(measuredPage);
    expect(out.width).toBe(1200);
    expect(out.height).toBe(1800);
  });

  it('omits `tags` key when the line has no explicit tags array', () => {
    const page = {
      id: 1,
      w: 800,
      h: 1200,
      lines: [
        { n: 1, type: 'dialogue', jp: '', en: 'Hello' },
        { n: 2, type: 'sfx', jp: '', en: 'BOOM' },
      ],
      boxes: [],
    };
    const out = serializePageText(page);
    expect('tags' in out.lines[0]).toBe(false);
    expect('tags' in out.lines[1]).toBe(false);
  });

  it('serializes explicit hand-applied tags when present', () => {
    const page = {
      id: 1,
      w: 800,
      h: 1200,
      lines: [
        { n: 1, type: 'dialogue', jp: '', en: 'Hello', tags: ['shout', 'custom'] },
        { n: 2, type: 'dialogue', jp: '', en: 'Quiet', tags: [] },
      ],
      boxes: [],
    };
    const out = serializePageText(page);
    expect(out.lines[0].tags).toEqual(['shout', 'custom']);
    expect(out.lines[1].tags).toEqual([]);
  });

  it('does not prevent carryTagsForward from restoring hand-applied tags on re-import', () => {
    // When exporting untagged lines, text-json must not materialize derived tags.
    // Otherwise carryTagsForward would see `Array.isArray(l.tags)` as true on every
    // incoming line and skip restoring the user's hand-applied tags from previous state.
    const exportedPage = serializePageText({
      id: 1,
      w: 800,
      h: 1200,
      lines: [{ n: 1, type: 'dialogue', jp: '', en: 'Updated text' }],
      boxes: [],
    });

    const previousLines = [{ n: 1, type: 'dialogue', jp: '', en: 'Old text', tags: ['important', 'whisper'] }];
    const importedLines = exportedPage.lines;

    const restored = carryTagsForward(previousLines, importedLines);
    expect(restored[0].tags).toEqual(['important', 'whisper']);
  });
});

describe('buildTextJson', () => {
  it('generates a valid formatted JSON string containing pages', () => {
    const pages = [
      { id: 1, w: 800, h: 1200, lines: [{ n: 1, type: 'dialogue', jp: '', en: 'Hi' }], boxes: [] },
    ];
    const jsonStr = buildTextJson(pages);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.schema).toBe(1);
    expect(parsed.generator).toBe('manga-typesetter');
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0].width).toBe(800);
    expect(parsed.pages[0].lines[0].en).toBe('Hi');
  });
});
