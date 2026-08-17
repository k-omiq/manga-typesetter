import { describe, it, expect } from 'vitest';
import { balanceLines, neededHeight, growToFit, TYPESET_DEFAULTS } from './typeset.js';
import { layoutLines, shapedLines, wrapLinesDOM, arcLayout, wrapLines, lineWidth } from './measure.js';

// The measurer is injected precisely so this file can use one: a character is
// one unit wide, so every expectation below can be read off the strings without
// a canvas, a font, or a browser anywhere in it. The real one lives in
// `measure.js` and is wired in at the call sites.
const chars = (s) => s.length;
// A metric where a capital letter is wider than a lowercase one, for the cases
// that would otherwise pass by accident under a uniform width.
const weighted = (s) => [...s].reduce((a, c) => a + (c === ' ' ? 0.5 : /[A-Z]/.test(c) ? 1.4 : 1), 0);

const widths = (lines) => lines.map((l) => l.length);
// The shape test, stated once. An hourglass is both ends wider than the middle;
// a square and an oval are not, and neither is the ordinary block whose last
// line runs short.
const dip = (lines, w) => {
  if (lines.length < 3) return 0;
  const r = lines.map((l) => l.length / w);
  const mid = Math.min(...r.slice(1, -1));
  return Math.min(r[0], r[r.length - 1]) - mid;
};

describe('balanceLines — the block reads as a square or an oval', () => {
  it('balances instead of filling greedily', () => {
    // Greedy would give "THE WORLD IS ENDING" (18, brim-full) and then trail
    // off. Every line here is within a few units of every other, which is the
    // square [] the rule asks for.
    const lines = balanceLines('THE WORLD IS ENDING AND NOBODY CARES AT ALL', 18, chars);
    expect(lines).toEqual(['THE WORLD IS', 'ENDING AND NOBODY', 'CARES AT ALL']);
    const w = widths(lines);
    expect(Math.max(...w) - Math.min(...w)).toBeLessThanOrEqual(5);
  });

  it('never leaves a line wider than the box it was measured against', () => {
    const lines = balanceLines('YOU ARE GOING TO REGRET THIS FOR THE REST OF YOUR LIFE', 24, chars);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(24);
  });

  it('accepts an oval — narrow, wide, narrow — as a shape', () => {
    // The widest line in the middle is the beehive (), which is explicitly a
    // shape the rule wants, so nothing here may penalise it into oblivion.
    const lines = ['AB', 'ABCDEFGH', 'ABCD'];
    expect(dip(lines, 10)).toBeLessThanOrEqual(0);
  });

  it('rejects the hourglass when a non-pinched breaking of the same text exists', () => {
    // Chosen so that the lowest-variance breaking IS the pinched one: a profile
    // of (12, 7, 7, 10) has a smaller spread than the alternatives, and only the
    // interior-shortfall term moves the short line out of the middle.
    const text = 'DDDDD EEEEEE JJJJJJJ FFF BBB FFF FFF CC';
    const blind = balanceLines(text, 13, chars, { pinch: 0, hourglass: 0 });
    expect(dip(blind, 13)).toBeGreaterThan(0.12);
    const shaped = balanceLines(text, 13, chars);
    expect(dip(shaped, 13)).toBeLessThanOrEqual(0.12);
  });

  it('puts the short line at the end rather than in the middle', () => {
    const lines = balanceLines('AAAA BBBB CC DDDD EEEE FFFF GGGG', 12, chars);
    const w = widths(lines);
    const shortest = Math.min(...w);
    // Whatever the breaking, the narrowest line is an edge, never a pinch.
    expect(w.indexOf(shortest) === 0 || w.lastIndexOf(shortest) === w.length - 1).toBe(true);
  });

  // The two halves of the rule are tested one at a time here, which the case
  // above deliberately does not do: zeroing `pinch` and `hourglass` together
  // cannot tell which of them is doing the work, and the answer used to be that
  // `hourglass` did none. It was a modest weight competing with `lineCost` for
  // the choice of line count, where it could only ever be small; it is now a
  // heavy weight choosing between two breakings of the SAME line count, where it
  // cannot buy a line at all.
  it('rejects a pinch with the interior-shortfall term switched off', () => {
    // `pinch: 0`, so nothing inside the dynamic program prefers a short line at
    // the end — and the profile term alone still moves it there.
    const text = 'DDDDD EEEEEE JJJJJJJ FFF BBB FFF FFF CC';
    const blind = balanceLines(text, 13, chars, { pinch: 0, pinchHard: 0, hourglass: 0 });
    expect(dip(blind, 13)).toBeGreaterThan(0.12);
    const shaped = balanceLines(text, 13, chars, { pinch: 0 });
    expect(dip(shaped, 13)).toBeLessThanOrEqual(0.12);
  });

  it('rejects a pinch the interior-shortfall term leaves standing', () => {
    // Measured, not invented: with `hourglass: 0` this is what the block breaks
    // to, and the dip is small enough that the old weight of 6 could never have
    // paid for the repair.
    const text = 'STOP ALWAYS WHY NEVER HELP NEVER A NEVER I NEVER';
    const blind = balanceLines(text, 15, chars, { hourglass: 0 });
    expect(blind).toEqual(['STOP ALWAYS', 'WHY NEVER', 'HELP NEVER A', 'NEVER I NEVER']);
    expect(dip(blind, 15)).toBeGreaterThan(0.12);
    const shaped = balanceLines(text, 15, chars);
    expect(dip(shaped, 15)).toBeLessThanOrEqual(0.12);
    // And the repair is a different breaking, never a bigger block: the rule
    // chooses break points at a line count that has already been settled.
    expect(shaped).toHaveLength(blind.length);
  });

  it('cannot buy a line at any weight', () => {
    // The line count is decided by raggedness and `lineCost` alone. Cranking the
    // profile penalty to absurdity may change where a block breaks and must
    // never change how many pieces it breaks into — which is exactly what a
    // cross-candidate penalty did, and why it had to be kept small.
    const texts = [
      'STOP ALWAYS WHY NEVER HELP NEVER A NEVER I NEVER',
      'THE WORLD IS ENDING AND NOBODY CARES AT ALL',
      'WE HAVE TO GET OUT OF HERE BEFORE IT FINDS US AGAIN',
      'DDDDD EEEEEE JJJJJJJ FFF BBB FFF FFF CC',
    ];
    for (const text of texts) {
      for (const w of [11, 13, 15, 18, 22]) {
        const off = balanceLines(text, w, chars, { hourglass: 0 });
        for (const weight of [TYPESET_DEFAULTS.hourglass, 5000]) {
          expect(balanceLines(text, w, chars, { hourglass: weight })).toHaveLength(off.length);
        }
      }
    }
  });

  it('lets an hourglass stand when the text admits nothing else', () => {
    // Two unbreakable words that cannot share a line with anything, and a scrap
    // between them. There is no non-pinched breaking, and the rule degrades to a
    // penalty rather than refusing to answer — which is the whole reason it is a
    // penalty and not a rejection.
    const lines = balanceLines('WWWWWWWWWWWW ab cd WWWWWWWWWWWW', 13, chars);
    expect(lines).toEqual(['WWWWWWWWWWWW', 'ab cd', 'WWWWWWWWWWWW']);
  });
});

describe('balanceLines — a short word is never left alone', () => {
  it('keeps a two-letter word company', () => {
    const lines = balanceLines('WHAT DID YOU DO', 10, chars);
    expect(lines).toEqual(['WHAT DID', 'YOU DO']);
    for (const l of lines) expect(l.split(/\s+/).length === 1 && l.length < 3).toBe(false);
  });

  it('holds over the whole block, not just the last line', () => {
    const lines = balanceLines('IT IS A VERY LONG DAY', 10, chars);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      if (l.split(/\s+/).length === 1) expect(l.replace(/[^\p{L}\p{N}]/gu, '').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('counts letters, not characters — punctuation does not rescue a short word', () => {
    // "IT!" is three characters and two letters, so it is still an orphan.
    const lines = balanceLines('SOMETHING HAPPENED IT!', 12, chars, { minOrphan: 3 });
    expect(lines.at(-1)).not.toBe('IT!');
  });

  it('takes the threshold from the caller', () => {
    const text = 'THE RAIN CAME DOWN AND IT WAS COLD';
    const strict = balanceLines(text, 12, chars, { minOrphan: 6 });
    for (const l of strict) {
      if (l.split(/\s+/).length === 1) expect(l.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('gives way when the constraint cannot be satisfied at all', () => {
    // "ok" has nowhere else to go: the word before it cannot share a line with
    // anything and cannot be split either, since a run of W has no syllable in
    // it for the pattern set to find. An unsatisfiable hard constraint is
    // relaxed rather than left to return nothing.
    expect(balanceLines('WWWWWWWWWWWWWWWWWWWW ok', 8, chars)).toEqual([
      'WWWWWWWWWWWWWWWWWWWW',
      'ok',
    ]);
  });

  it('gives way for the one word that cannot be placed, and no others', () => {
    // "A", between two words too long to share a line with it, is a genuine
    // orphan no breaking of this text can avoid. It used to take the rule down
    // with it for the whole paragraph — the relaxed pass dropped the constraint
    // rather than pricing it, so "I" was stranded on a line of its own although
    // "I DIE" fits and obeys the rule. Priced, only the impossible one survives.
    //
    // Hyphenation is off here because it is a second escape route from the same
    // corner and would answer the question this case is asking: with a hyphen
    // available `UNDERSTAND` splits, `A` finds company, and the orphan rule is
    // no longer under any strain at all. What is under test is `orphanCost`.
    const lines = balanceLines('I DIE UNDERSTAND A MONSTER A NO', 6, chars, { hyphenate: false });
    expect(lines).toEqual(['I DIE', 'UNDERSTAND', 'A', 'MONSTER', 'A NO']);
    const alone = lines.filter((l) => l.split(/\s+/).length === 1 && l.length < 3);
    expect(alone).toEqual(['A']);
  });
});

describe('balanceLines — a word is only broken when nothing else will do', () => {
  it('puts a word with no syllable points on its own line, whole', () => {
    // Nothing in the pattern set can pronounce a run of W, so there is no break
    // point to offer and the old behaviour is the only behaviour.
    const lines = balanceLines('SAY WWWWWWWWWWWWWWWWWWWWWWWWWWWW NOW PLEASE', 12, chars);
    expect(lines).toContain('WWWWWWWWWWWWWWWWWWWWWWWWWWWW');
    expect(lines.join(' ').replace(/\s+/g, ' ')).toBe('SAY WWWWWWWWWWWWWWWWWWWWWWWWWWWW NOW PLEASE');
  });

  it('lets that one line overflow rather than splitting it', () => {
    const lines = balanceLines('AAAAAAAAAAAAAAAAAAAA', 5, chars);
    expect(lines).toEqual(['AAAAAAAAAAAAAAAAAAAA']);
  });

  it('carries a word to the next line whole when it fits there', () => {
    // `WONDERFUL` is nine units in a ten-unit box, so it fits on a line of its
    // own and is therefore never offered a break point at all — the gate is
    // about fitting, not about length.
    expect(balanceLines('THE WONDERFUL THING', 10, chars)).toEqual([
      'THE',
      'WONDERFUL',
      'THING',
    ]);
  });

  it('splits the word rather than hang it out of the box, when it fits nowhere', () => {
    expect(balanceLines('TINY ENORMOUSWORDHERE', 12, chars)).toEqual([
      'TINY ENOR-',
      'MOUSWORDHERE',
    ]);
    // And with the feature off, the old answer, unchanged.
    expect(balanceLines('TINY ENORMOUSWORDHERE', 12, chars, { hyphenate: false })).toEqual([
      'TINY',
      'ENORMOUSWORDHERE',
    ]);
  });
});

describe('balanceLines — the user’s text is never touched', () => {
  it('treats a newline as a hard paragraph break and balances each side alone', () => {
    const lines = balanceLines('ONE TWO\nTHREE FOUR FIVE SIX', 12, chars);
    expect(lines[0]).toBe('ONE TWO');
    expect(lines.slice(1).join(' ')).toBe('THREE FOUR FIVE SIX');
  });

  it('keeps a blank paragraph as a blank line', () => {
    expect(balanceLines('A\n\nB', 10, chars)).toEqual(['A', '', 'B']);
  });

  it('preserves interior spacing exactly, because a line is a slice', () => {
    // Nothing is re-joined from a word list — every line is `text.slice(a, b)`
    // between two word boundaries — so a double space the user typed survives.
    expect(balanceLines('HELLO   THERE FRIEND OF MINE', 14, chars)).toEqual([
      'HELLO   THERE',
      'FRIEND OF MINE',
    ]);
  });

  it('drops nothing and adds nothing', () => {
    const text = 'WE HAVE TO GET OUT OF HERE BEFORE IT FINDS US AGAIN';
    const lines = balanceLines(text, 16, chars);
    expect(lines.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it('answers for the empty and the single-word cases without ceremony', () => {
    expect(balanceLines('', 10, chars)).toEqual(['']);
    expect(balanceLines('   ', 10, chars)).toEqual(['']);
    expect(balanceLines('ALONE', 10, chars)).toEqual(['ALONE']);
    expect(balanceLines(null, 10, chars)).toEqual(['']);
  });
});

describe('balanceLines — determinism', () => {
  it('gives the same answer every time, for the same input', () => {
    const text = 'THIS IS THE PART WHERE YOU TELL ME IT WAS ALL A MISUNDERSTANDING';
    const first = balanceLines(text, 22, chars);
    for (let i = 0; i < 20; i++) expect(balanceLines(text, 22, chars)).toEqual(first);
  });

  it('breaks a tie toward fewer lines', () => {
    // Two lines is never beaten by three when the cost is otherwise equal —
    // `lineCost` is what makes that true, and it is what stops a perfectly
    // balanced tower of one-word lines from winning on raggedness alone.
    const lines = balanceLines('ALPHA BRAVO', 12, chars);
    expect(lines).toEqual(['ALPHA BRAVO']);
  });

  it('does not depend on the metric being uniform', () => {
    const text = 'THE quick BROWN fox JUMPED over IT';
    const a = balanceLines(text, 14, weighted);
    const b = balanceLines(text, 14, weighted);
    expect(a).toEqual(b);
    expect(a.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it('falls back to greedy wrapping rather than enumerating an essay', () => {
    const text = Array.from({ length: TYPESET_DEFAULTS.maxWords + 20 }, (_, i) => `W${i}`).join(' ');
    const lines = balanceLines(text, 20, chars);
    expect(lines.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(20);
  });
});

// ===== the width may be a shape =====
//
// A speech balloon is an oval, and the room inside an oval is narrow at the top
// and the bottom and wide across the middle. `balanceLines` takes that as a
// callback from a line count to one width per line; a bare number still means
// the same width for every line, which is what every caller in the app passes.

// The shape the app will actually hand in, near enough for a test: an ellipse of
// half-width `half`, cut into `L` horizontal bands, each reported at the width
// of its narrowest edge.
const ellipse = (half) => (L) =>
  Array.from({ length: L }, (_, k) => {
    const t = ((k + 0.5) / L) * 2 - 1;
    return 2 * half * Math.sqrt(Math.max(0.02, 1 - t * t));
  });
// How full each line is relative to the room it was given. Every shape rule in
// the module is really a statement about these numbers and not about lengths.
const fills = (lines, w) => lines.map((l, i) => l.length / w[i]);
const spread = (xs) => Math.max(...xs) - Math.min(...xs);

describe('balanceLines — one width per line', () => {
  const texts = [
    'THE WORLD IS ENDING AND NOBODY CARES AT ALL',
    'YOU ARE GOING TO REGRET THIS FOR THE REST OF YOUR LIFE',
    'WE HAVE TO GET OUT OF HERE BEFORE IT FINDS US AGAIN',
    'THIS IS THE PART WHERE YOU TELL ME IT WAS ALL A MISUNDERSTANDING',
    'HELLO   THERE FRIEND OF MINE',
    'ONE TWO\nTHREE FOUR FIVE SIX',
    'STOP ALWAYS WHY NEVER HELP NEVER A NEVER I NEVER',
  ];

  it('is the same function whether the width arrives as a number or an array', () => {
    // The claim the whole change rests on: a callback that happens to be
    // constant is not a second code path, it is the same one. Measured here on
    // a handful of strings and, off-line, on 54,000 breakings of a 3000-string
    // corpus across nine widths and two metrics, where the two hash identically.
    for (const text of texts) {
      for (const w of [8, 11, 14, 18, 24, 33]) {
        for (const metric of [chars, weighted]) {
          expect(balanceLines(text, (L) => new Array(L).fill(w), metric)).toEqual(
            balanceLines(text, w, metric),
          );
        }
      }
    }
  });

  it('fits each line to its own allowance rather than to the widest one', () => {
    const w = ellipse(14);
    const text = 'YOU ARE GOING TO REGRET THIS FOR THE REST OF YOUR LIFE';
    const shaped = balanceLines(text, w, chars);
    const allow = w(shaped.length);
    for (let i = 0; i < shaped.length; i++) expect(shaped[i].length).toBeLessThanOrEqual(allow[i]);

    // And the thing it is fixing: one flat number set to the balloon's widest
    // point puts every line over the curve, which is what the reader sees as
    // text running into the outline.
    const flat = balanceLines(text, Math.max(...allow), chars);
    const flatAllow = w(flat.length);
    expect(flat.some((l, i) => l.length > flatAllow[i])).toBe(true);
  });

  it('does not read an oval’s narrow ends as a defect', () => {
    // The first and last lines of a block in an ellipse are the shortest strings
    // in it, and that is the shape working rather than the shape failing. What
    // the rules look at is fill, and the fills come out flat.
    const w = ellipse(12);
    const lines = balanceLines('THE WORLD IS ENDING AND NOBODY CARES AT ALL', w, chars);
    const allow = w(lines.length);
    expect(lines).toEqual(['THE WORLD IS', 'ENDING AND NOBODY', 'CARES AT ALL']);
    expect(spread(fills(lines, allow))).toBeLessThan(0.1);
    // Narrow, wide, narrow in absolute terms — the beehive the rules ask for.
    expect(lines[1].length).toBeGreaterThan(lines[0].length);
    expect(lines[1].length).toBeGreaterThan(lines[2].length);
  });

  it('balances against the room the block has, not against a number', () => {
    // A wedge, so the widths differ by a lot and cannot be mistaken for each
    // other. The line lengths track the widths; the fills do not move much.
    const wedge = (L) => Array.from({ length: L }, (_, k) => 26 - 5 * k);
    const lines = balanceLines('YOU ARE GOING TO REGRET THIS FOR THE REST OF YOUR LIFE', wedge, chars);
    const allow = wedge(lines.length);
    expect(lines).toEqual(['YOU ARE GOING TO REGRET', 'THIS FOR THE REST', 'OF YOUR LIFE']);
    expect(spread(lines.map((l) => l.length))).toBeGreaterThan(8);
    expect(spread(fills(lines, allow))).toBeLessThan(0.15);
  });

  it('calls a pinch a pinch by fill, and not by length', () => {
    // The same physical profile, judged twice. Under a flat fifteen the module
    // repairs (11, 9, 12, 13) because the 9 in the middle is a hole; told that
    // the second line only ever had twelve units of room, it leaves the very
    // same breaking alone, because a line filled to three quarters between two
    // filled to three quarters is not a hole. This is the whole of what the
    // shape rules mean under a width that varies.
    const text = 'STOP ALWAYS WHY NEVER HELP NEVER A NEVER I NEVER';
    const blind = balanceLines(text, 15, chars, { hourglass: 0 });
    expect(blind.map((l) => l.length)).toEqual([11, 9, 12, 13]);
    expect(balanceLines(text, 15, chars)).not.toEqual(blind);

    const narrowSecond = (L) => (L === 4 ? [15, 12, 15, 15] : new Array(L).fill(15));
    const shaped = balanceLines(text, narrowSecond, chars);
    expect(shaped).toEqual(blind);
    expect(dip(shaped.map((l, i) => 'x'.repeat(Math.round(l.length / narrowSecond(4)[i] * 100))), 100))
      .toBeLessThanOrEqual(TYPESET_DEFAULTS.hourglassTol);
  });

  it('asks for a line count once, and only for counts it might use', () => {
    const seen = [];
    const spy = (L) => {
      seen.push(L);
      return new Array(L).fill(16);
    };
    balanceLines('THE WORLD IS ENDING AND NOBODY CARES AT ALL', spy, chars);
    // Once each, so the search and the scorer can never be looking at two
    // different balloons; and never above the number of words, because a block
    // of nine words has nowhere to put a tenth line.
    expect(new Set(seen).size).toBe(seen.length);
    expect(Math.max(...seen)).toBe(9);
  });

  it('survives a callback that hands back nonsense', () => {
    const text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL';
    // A hole at the top of the array is filled from the same balloon rather
    // than from a number that would put every line over the edge.
    expect(balanceLines(text, () => [NaN, 20], chars)).toEqual(balanceLines(text, 20, chars));
    // And nothing anywhere throws, divides by zero, or returns a NaN line. The
    // widths these produce are degenerate, so the breaking is too — but every
    // character the user typed still comes back, in order.
    const strip = (s) => s.replace(/[-\s]/g, '');
    for (const bad of [() => [], () => [0, -4], () => null, () => [Infinity], () => 12]) {
      const lines = balanceLines(text, bad, chars);
      for (const l of lines) expect(typeof l).toBe('string');
      expect(strip(lines.join(''))).toBe(strip(text));
    }
  });

  it('still treats a bare number, or none at all, as one width for every line', () => {
    expect(balanceLines('ALPHA BRAVO', 12, chars)).toEqual(['ALPHA BRAVO']);
    expect(balanceLines('ALPHA BRAVO', 12, chars)).toEqual(
      balanceLines('ALPHA BRAVO', () => [12, 12], chars),
    );
  });
});

// ===== hyphenation =====
//
// The reference is a tall narrow balloon reading MURA- / MATA- / SAN!, which is
// what a letterer does with a name that will not fit and what this module used
// to refuse to do at all.

// Every line is a slice of the input, and the hyphen is the one character the
// module may add — so dropping a single trailing hyphen from any line has to
// leave a substring of what the user typed. That is the statement `box.text` and
// the queue line depend on.
const isSlice = (line, text) => text.includes(line) || text.includes(line.slice(0, -1));
const letters = (s) => (s.match(/[\p{L}\p{N}]/gu) || []).length;

describe('balanceLines — hyphenation, priced as a last resort', () => {
  it('sets the reference block', () => {
    expect(balanceLines('MURAMATA-SAN!', 5, chars)).toEqual(['MURA-', 'MATA-', 'SAN!']);
  });

  it('never invents a break the pattern set did not offer', () => {
    // The failure this is guarding against by name. `MURAMA-TASAN` is a
    // typesetting error a reader notices; the en-US patterns put the points
    // after MU and after MURA, and nowhere else inside that chunk.
    for (let w = 4; w <= 12; w++) {
      const lines = balanceLines('MURAMATASAN', w, chars);
      expect(lines.join('')).toBe(lines.join('')); // no reordering, checked below
      for (const l of lines) expect(isSlice(l, 'MURAMATASAN')).toBe(true);
      const hyphenated = lines.filter((l) => l.endsWith('-'));
      for (const h of hyphenated) expect(['MU-', 'MURA-']).toContain(h);
    }
  });

  it('leaves a word that fits alone', () => {
    // The gate, and the reason ordinary dialogue never sees a hyphen: the word
    // has to fit on no line the block could give it before it is even offered a
    // break point.
    expect(balanceLines('WONDERFUL', 9, chars)).toEqual(['WONDERFUL']);
    expect(balanceLines('THE WONDERFUL THING', 10, chars)).toEqual(['THE', 'WONDERFUL', 'THING']);
    const real = [
      'THE WORLD IS ENDING AND NOBODY CARES AT ALL',
      'WE HAVE TO GET OUT OF HERE BEFORE IT FINDS US AGAIN',
      'THIS IS THE PART WHERE YOU TELL ME IT WAS ALL A MISUNDERSTANDING',
      'SOMETHING TERRIBLE HAPPENED AT THE SCHOOL YESTERDAY',
      'EVERYTHING I EVER TOLD YOU ABOUT MY FAMILY WAS A LIE',
    ];
    for (const text of real) {
      for (const w of [16, 18, 20, 22, 26, 30]) {
        for (const l of balanceLines(text, w, chars)) expect(l.endsWith('-')).toBe(false);
      }
    }
  });

  it('keeps at least two letters before the hyphen and three after it', () => {
    const words = [
      'ANTIDISESTABLISHMENTARIANISM', 'MISUNDERSTANDING', 'MURAMATA-SAN!', 'CO-OPERATE',
      'WONDERFULLY', 'IMPOSSIBILITY', 'EXTRAORDINARY', 'UNBELIEVABLE', 'CONGRATULATIONS',
      'TRANSFORMATION', 'RESPONSIBILITY', 'ELECTRICITY', 'INTERNATIONAL', 'ONOMATOPOEIA',
    ];
    let split = 0;
    for (const word of words) {
      for (let w = 3; w <= 14; w++) {
        const lines = balanceLines(word, w, chars);
        if (lines.length > 1) split++;
        for (let i = 0; i < lines.length; i++) {
          const frag = lines[i].endsWith('-') && i < lines.length - 1 ? lines[i].slice(0, -1) : lines[i];
          // Two letters on every fragment the block carries, three on the one
          // that ends the word — the tail rule is also the anti-stub rule for
          // the end of a paragraph, since the last word's tail IS the last line.
          expect(letters(frag)).toBeGreaterThanOrEqual(
            i === lines.length - 1 ? TYPESET_DEFAULTS.minHyphenTail : TYPESET_DEFAULTS.minHyphenHead,
          );
        }
      }
    }
    expect(split).toBeGreaterThan(100); // the sweep really did split things
  });

  it('counts the minimums in letters, so punctuation cannot dress up a stub', () => {
    // `hypher` enforces 2 and 3 itself and counts characters, which would let a
    // trailing exclamation mark pass as a third letter. `SAN!` is three letters
    // and survives; a tail of `N!!` would be one and does not.
    expect(balanceLines('MURAMATA-SAN!', 5, chars).at(-1)).toBe('SAN!');
    for (let w = 3; w <= 10; w++) {
      for (const l of balanceLines('WONDERFUL!!!', w, chars)) {
        expect(letters(l.replace(/-$/, ''))).toBeGreaterThanOrEqual(2);
      }
      expect(letters(balanceLines('WONDERFUL!!!', w, chars).at(-1))).toBeGreaterThanOrEqual(3);
    }
  });

  it('breaks at a hyphen the user typed, and does not add a second', () => {
    const lines = balanceLines('MURAMATA-SAN!', 9, chars);
    expect(lines).toEqual(['MURAMATA-', 'SAN!']);
    expect(lines[0].endsWith('--')).toBe(false);
    expect(balanceLines('CO-OPERATE', 6, chars)).toEqual(['CO-', 'OPERATE']);
    // Where both kinds are available and both fit, the typed one is cheaper and
    // wins: `MURA-` is a legal invented break at this width and is not taken.
    expect(balanceLines('LISTEN MURAMATA-SAN!', 9, chars)).toEqual([
      'LISTEN',
      'MURAMATA-',
      'SAN!',
    ]);
  });

  it('avoids two hyphenated lines in a row when there is an alternative', () => {
    const text = 'SAY ANTIDISESTABLISHMENTARIANISM NOW PLEASE';
    const twoInARow = (lines) =>
      lines.some((l, i) => i > 0 && l.endsWith('-') && lines[i - 1].endsWith('-'));
    // With the term switched off the search happily strings them together; at
    // the default it takes an overflowing line instead, which is the trade the
    // rule asks for.
    expect(twoInARow(balanceLines(text, 12, chars, { hyphenPair: 0 }))).toBe(true);
    expect(twoInARow(balanceLines(text, 12, chars))).toBe(false);
  });

  it('takes two in a row anyway when the text admits nothing else', () => {
    // The reference block is exactly this case: every line of `MURAMATA-SAN!` in
    // a five-unit balloon has to end in a hyphen, so the rule is a price and not
    // a prohibition — the same shape the orphan rule has.
    expect(balanceLines('MURAMATA-SAN!', 5, chars)).toEqual(['MURA-', 'MATA-', 'SAN!']);
  });

  it('loses to an equally good block without one', () => {
    // `TERRIBLE` is one unit over a seven-unit box, and splitting it would give
    // a tidier block: (3, 6, 7) against (3, 8, 3). The tidier block is not
    // chosen, because the hyphen costs more than the tidying is worth — and
    // zeroing that one price is all it takes to flip the answer, which is how
    // the claim is shown to be about the price and not about anything else.
    const text = 'SAY TERRIBLE NOW';
    expect(balanceLines(text, 7, chars)).toEqual(['SAY', 'TERRIBLE', 'NOW']);
    expect(balanceLines(text, 7, chars, { hyphen: 0, lastWordHyphen: 0 })).toEqual([
      'SAY',
      'TERRI-',
      'BLE NOW',
    ]);
  });

  it('prefers a small overflow to a hyphen, and a hyphen to a large one', () => {
    // The overflow term is quadratic, which is what makes that sentence true
    // rather than merely hopeful. `SENPAI` is one unit over a five-unit box and
    // keeps its overflow; `ENORMOUSWORDHERE` is eleven over and does not.
    expect(balanceLines('SENPAI', 5, chars)).toEqual(['SENPAI']);
    expect(balanceLines('ENORMOUSWORDHERE', 5, chars).length).toBeGreaterThan(1);
  });

  it('leaves a sound effect alone', () => {
    // Every one of these is plain A-Z, so the pattern set will cheerfully offer
    // points inside it — `KRRSH-` / `HHHH-` / `HHHHH` is what came out before
    // the vowel rule. A syllable has a vowel in it; these pieces do not.
    for (const sfx of [
      'KRRSHHHHHHHHHH', 'SHHHHHHHHHHHH', 'GRRRRRRRRRRRR', 'THHHHHHHHHHHH', 'MMMMMMMMMMMM',
    ]) {
      for (const w of [3, 5, 8]) expect(balanceLines(sfx, w, chars)).toEqual([sfx]);
    }
  });

  it('leaves anything the en-US patterns have no business judging', () => {
    // An apostrophe in the middle, an accent, a digit, and two scripts the
    // pattern set has never seen. A word left whole is only a word left whole;
    // a word broken in the wrong place is an error on the page.
    for (const word of ['DOESN’T', "DOESN'T", 'CAFÉTERIARIA', 'MP3PLAYERTHING', 'ЗДРАВСТВУЙТЕ', 'ありがとうございます']) {
      for (const w of [3, 4, 6]) expect(balanceLines(word, w, chars)).toEqual([word]);
    }
  });

  it('works on text that has already been uppercased', () => {
    // Which is how it always arrives: the style carries an `uppercase` flag and
    // `applyCase` runs before any of this. The patterns are matched
    // case-insensitively and the user's own characters come back out.
    for (const [lower, upper] of [
      ['wonderful', 'WONDERFUL'],
      ['misunderstanding', 'MISUNDERSTANDING'],
      ['muramata-san', 'MURAMATA-SAN'],
    ]) {
      const a = balanceLines(lower, 6, chars);
      const b = balanceLines(upper, 6, chars);
      expect(b).toEqual(a.map((l) => l.toUpperCase()));
      for (const l of b) expect(isSlice(l, upper)).toBe(true);
    }
  });

  it('adds a hyphen to the rendered line and to nothing else', () => {
    // The contract the queue and `box.text` rely on. Every line is still a slice
    // of the input once the one hyphen this module is allowed to add is taken
    // back off, and the letters come out in the order they went in.
    const texts = [
      'MURAMATA-SAN!', 'SAY ANTIDISESTABLISHMENTARIANISM NOW PLEASE',
      'TINY ENORMOUSWORDHERE', 'HELLO   MISUNDERSTANDING FRIEND', 'IS CONGRATULATIONS RIGHT',
    ];
    for (const text of texts) {
      for (let w = 4; w <= 20; w += 2) {
        const lines = balanceLines(text, w, chars);
        for (const l of lines) expect(isSlice(l, text)).toBe(true);
        // Nothing dropped, nothing added, nothing reordered — hyphens and
        // whitespace aside, the characters are the characters.
        const strip = (s) => s.replace(/[-\s]/g, '');
        expect(strip(lines.join(''))).toBe(strip(text));
      }
    }
  });

  it('measures the hyphen it is about to draw', () => {
    // A hyphen that was not measured is a hyphen hanging out of the balloon, so
    // a hyphenated line has to fit its width WITH the hyphen on it. The only
    // lines allowed past that are single unbreakable pieces, which have nowhere
    // else to go.
    for (const text of ['MISUNDERSTANDING FOREVER', 'IS CONGRATULATIONS RIGHT NOW']) {
      for (let w = 8; w <= 20; w++) {
        for (const l of balanceLines(text, w, chars)) {
          if (l.endsWith('-') && /\s/.test(l)) expect(l.length).toBeLessThanOrEqual(w + 0.5);
        }
      }
    }
  });

  it('is one flag away from the module it used to be', () => {
    // `hyphenate: false` restores every previous answer exactly, which is what
    // makes the feature reviewable: the diff against the old behaviour is
    // entirely inside blocks that had a word hanging out of them.
    const text = 'SAY ANTIDISESTABLISHMENTARIANISM NOW PLEASE';
    expect(balanceLines(text, 12, chars, { hyphenate: false })).toEqual([
      'SAY',
      'ANTIDISESTABLISHMENTARIANISM',
      'NOW PLEASE',
    ]);
  });

  it('hyphenates against a per-line width like everything else', () => {
    // The two halves of this change meeting: the word is split against the room
    // its own line has, not against the widest line in the balloon.
    const w = (L) => (L === 3 ? [6, 14, 6] : new Array(L).fill(6));
    const lines = balanceLines('MISUNDERSTANDING NOW', w, chars);
    expect(lines).toHaveLength(3);
    const allow = w(3);
    for (let i = 0; i < 3; i++) {
      if (/\s/.test(lines[i])) expect(lines[i].length).toBeLessThanOrEqual(allow[i] + 0.5);
    }
    for (const l of lines) expect(isSlice(l, 'MISUNDERSTANDING NOW')).toBe(true);
  });
});

// The parity seam. Both the canvas (`TextBox.svelte`) and the exporter
// (`layoutBox` in exporter.js) ask this one function, with the box's own style
// size and content width, which is what makes them break in the same places.
// Under node there is no canvas, so `lineWidth` falls back to a stand-in metric
// — enough to prove which branch is taken, which is what is under test here.
describe('layoutLines — one answer for the editor and the export', () => {
  const style = { font: 'Comic Neue', size: 20, bold: false, italic: false, lineHeight: 1.1, letterSpacing: 0, align: 'center', uppercase: false };

  it('shapes by default', () => {
    const lines = layoutLines('ONE TWO THREE FOUR', 200, { ...style }, 200);
    expect(lines.join(' ').split(/\s+/)).toEqual(['ONE', 'TWO', 'THREE', 'FOUR']);
  });

  it('hands the job back to plain wrapping when shaping is off', () => {
    // Asserted against the two functions themselves rather than against a
    // particular breaking, so the claim holds in an environment with real text
    // metrics and in this one, which has none.
    const text = 'AAAA BBBB CCCC DDDD EEEE';
    const narrow = 12 * 20 * 0.55; // the node fallback metric, ~12 characters wide
    expect(layoutLines(text, { ...style, shape: 'off' }, 20, narrow)).toEqual(
      wrapLinesDOM(text, { ...style, shape: 'off' }, 20, narrow),
    );
    expect(layoutLines(text, { ...style, shape: 'auto' }, 20, narrow)).toEqual(
      shapedLines(text, { ...style, shape: 'auto' }, 20, narrow),
    );
  });

  it('reads the orphan threshold off the style', () => {
    const narrow = 10 * 20 * 0.55;
    const lines = layoutLines('WHAT DID YOU DO', { ...style, minOrphan: 3 }, 20, narrow);
    for (const l of lines) expect(l.split(/\s+/).length === 1 && l.length < 3).toBe(false);
  });

  // The seam the balloon fitter will plug into. `layoutLines` grew a fifth
  // argument rather than a new function, because the whole value of this being
  // one function is that the editor and the exporter cannot drift apart — and a
  // second entry point is exactly how they would.
  it('passes a per-line width through to the breaker', () => {
    // The node fallback metric is 0.55 * size per character, so these are
    // widths in characters, converted.
    const unit = 20 * 0.55;
    const text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL';
    const box = 24 * unit; // the content width the box would report
    const wide = (L) => new Array(L).fill(box);
    const oval = ellipse(12 * unit); // twenty-four characters across the middle, less at the ends
    const width = (l) => l.length * unit;

    const shaped = layoutLines(text, { ...style }, 20, box, oval);
    const allow = oval(shaped.length);
    for (let i = 0; i < shaped.length; i++) expect(width(shaped[i])).toBeLessThanOrEqual(allow[i]);

    // The same box laid out against its widest point alone runs past the curve,
    // which is the whole reason the fifth argument exists.
    const flat = layoutLines(text, { ...style }, 20, box);
    const flatAllow = oval(flat.length);
    expect(flat.some((l, i) => width(l) > flatAllow[i])).toBe(true);

    // A callback that happens to be constant is not a different answer.
    expect(layoutLines(text, { ...style }, 20, box, wide)).toEqual(flat);
  });

  it('leaves the fifth argument out of the plain-wrapping path', () => {
    // `shape: 'off'` means "wrap the way the browser would", and the browser has
    // no way to wrap to a width that changes line by line. Honouring the
    // callback there would quietly break the one promise that path makes.
    const unit = 20 * 0.55;
    const text = 'AAAA BBBB CCCC DDDD EEEE';
    const off = { ...style, shape: 'off' };
    expect(layoutLines(text, off, 20, 12 * unit, () => [unit, unit])).toEqual(
      layoutLines(text, off, 20, 12 * unit),
    );
  });

  it('still answers the four-argument call every caller in the app makes', () => {
    const narrow = 12 * 20 * 0.55;
    const text = 'THE WORLD IS ENDING AND NOBODY CARES';
    expect(layoutLines(text, { ...style }, 20, narrow)).toEqual(
      shapedLines(text, { ...style }, 20, narrow),
    );
  });
});

describe('measure.js robustness and trailing whitespace', () => {
  it('guards arcLayout against size 0 and missing letterSpacing without emitting NaN', () => {
    expect(arcLayout('hello', { size: 0, letterSpacing: 0, curve: 50 }, 20)).toEqual([]);
    expect(arcLayout('hello', { size: 20, letterSpacing: 0, curve: 50 }, 0)).toEqual([]);
    const layout = arcLayout('hello', { size: 20, letterSpacing: undefined, curve: 50 }, 20);
    expect(layout.length).toBe(5);
    for (const ch of layout) {
      expect(Number.isFinite(ch.x)).toBe(true);
      expect(Number.isFinite(ch.y)).toBe(true);
      expect(Number.isFinite(ch.rot)).toBe(true);
      expect(Number.isFinite(ch.w)).toBe(true);
    }
  });

  it('guards lineWidth against zero size and missing letterSpacing', () => {
    expect(lineWidth('hello', { size: 0, letterSpacing: undefined }, 20)).toBeGreaterThan(0);
    expect(lineWidth('hello', { size: 20, letterSpacing: undefined }, 20)).toBeGreaterThan(0);
    expect(lineWidth('hello', { size: 20, letterSpacing: 0 }, 0)).toBe(0);
  });

  it('strips trailing whitespace on wrapLines terminal lines to match wrapLinesDOM', () => {
    const wrapped = wrapLines('hello world   ', { font: 'Comic Neue', size: 20, letterSpacing: 0 }, 20, 200);
    expect(wrapped).toEqual(['hello world']);
    const multiline = wrapLines('line 1   \nline 2   ', { font: 'Comic Neue', size: 20, letterSpacing: 0 }, 20, 200);
    expect(multiline).toEqual(['line 1', 'line 2']);
  });
});

// ===== auto-height =====

describe('neededHeight', () => {
  it('is the block plus the padding the box lays out inside', () => {
    expect(neededHeight(3, { size: 20, lineHeight: 1.1 }, 2)).toBe(Math.ceil(3 * 22) + 4);
  });

  it('ceils, so a box never lands a sub-pixel short of its own text', () => {
    expect(neededHeight(3, { size: 10, lineHeight: 1.13 }, 0)).toBe(34);
  });
});

describe('growToFit', () => {
  it('grows downward from a top-aligned box', () => {
    expect(growToFit({ y: 100, h: 50, valign: 'top' }, 90, 1000)).toEqual({ y: 100, h: 90 });
  });

  it('grows upward from a bottom-aligned box', () => {
    expect(growToFit({ y: 100, h: 50, valign: 'bottom' }, 90, 1000)).toEqual({ y: 60, h: 90 });
  });

  it('opens equally in both directions when the text is centred', () => {
    // The block stays centred on the bubble the user aimed at, which is the
    // whole reason the anchor follows `valign` rather than being fixed.
    const before = { y: 100, h: 50, valign: 'middle' };
    const after = growToFit(before, 90, 1000);
    expect(after).toEqual({ y: 80, h: 90 });
    expect(after.y + after.h / 2).toBe(before.y + before.h / 2);
  });

  it('never shrinks a box the user sized by hand', () => {
    for (const valign of ['top', 'middle', 'bottom']) {
      expect(growToFit({ y: 100, h: 200, valign }, 40, 1000)).toEqual({ y: 100, h: 200 });
    }
    expect(growToFit({ y: 100, h: 200, valign: 'middle' }, 200, 1000)).toEqual({ y: 100, h: 200 });
  });

  it('is capped at the page and clamped inside it', () => {
    expect(growToFit({ y: 10, h: 50, valign: 'top' }, 5000, 1200)).toEqual({ y: 0, h: 1200 });
    // Growing upward off the top edge is pulled back onto the page.
    expect(growToFit({ y: 20, h: 40, valign: 'bottom' }, 200, 1200)).toEqual({ y: 0, h: 200 });
    // And downward off the bottom edge.
    expect(growToFit({ y: 1100, h: 40, valign: 'top' }, 200, 1200)).toEqual({ y: 1000, h: 200 });
  });

  it('does not clamp against a page nobody has measured', () => {
    // `p.w`/`p.h` are 0 until something decodes the image. Clamping against a
    // zero would drag every box on an unvisited page to the origin.
    expect(growToFit({ y: 300, h: 40, valign: 'top' }, 200, 0)).toEqual({ y: 300, h: 200 });
  });

  it('is idempotent, so re-running it can never ratchet', () => {
    const once = growToFit({ y: 100, h: 50, valign: 'middle' }, 90, 1000);
    expect(growToFit({ ...once, valign: 'middle' }, 90, 1000)).toEqual(once);
  });
});
