import { describe, it, expect } from 'vitest';
import { slugify, uniqueSlug, chapterSlug } from './paths.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('One Piece')).toBe('one-piece');
  });

  it('collapses runs of punctuation into a single hyphen', () => {
    expect(slugify('Jojo!!  Part -- 7')).toBe('jojo-part-7');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  ~hello~  ')).toBe('hello');
  });

  it('keeps non-ASCII letters', () => {
    expect(slugify('ワンピース')).toBe('ワンピース');
  });

  it('falls back to "untitled" when nothing survives', () => {
    expect(slugify('!!!')).toBe('untitled');
  });

  it('truncates to 60 characters', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(60);
  });

  it('suffixes DOS reserved device names', () => {
    expect(slugify('CON')).toBe('con-x');
    expect(slugify('aux')).toBe('aux-x');
    expect(slugify('NUL')).toBe('nul-x');
    expect(slugify('com1')).toBe('com1-x');
    expect(slugify('lpt9')).toBe('lpt9-x');
  });
});

describe('uniqueSlug', () => {
  it('returns the plain slug when free', () => {
    expect(uniqueSlug('Naruto', new Set())).toBe('naruto');
  });

  it('suffixes -2 on the first collision', () => {
    expect(uniqueSlug('Naruto', new Set(['naruto']))).toBe('naruto-2');
  });

  it('keeps counting past the first collision', () => {
    expect(uniqueSlug('Naruto', new Set(['naruto', 'naruto-2']))).toBe('naruto-3');
  });
});

describe('chapterSlug', () => {
  it('zero-pads the number to three digits', () => {
    expect(chapterSlug(7, 'The Duel')).toBe('007-the-duel');
  });

  it('omits the title when empty', () => {
    expect(chapterSlug(12, '')).toBe('012');
  });

  it('handles numbers past 999 without truncating', () => {
    expect(chapterSlug(1024, '')).toBe('1024');
  });
});
