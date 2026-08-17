import { describe, it, expect } from 'vitest';
import {
  createFieldUndo,
  recordFieldEdit,
  resyncField,
  undoField,
  redoField,
  diffText,
  caretAfter,
  isAtomicInput,
  COALESCE_MS,
  MAX_FIELD_STEPS,
} from './field-undo.svelte.js';

// Every case drives its own clock, so a run that should coalesce and one that
// should not differ by the timestamp rather than by how fast the test ran.
const typer = (u, start = 1000) => {
  let t = start;
  return {
    // One keystroke: the value the field now holds, and how long the user
    // waited before it.
    key(value, gap = 50, opts = {}) {
      t += gap;
      return recordFieldEdit(u, value, { now: t, ...opts });
    },
    // The whole word, one character at a time, from wherever the field is.
    type(text, gap = 50) {
      let v = u.stack[u.i];
      for (const ch of text) this.key((v += ch), gap);
      return v;
    },
  };
};

describe('diffText', () => {
  it('finds the inserted span between two values', () => {
    expect(diffText('helo', 'hello')).toEqual({ at: 3, removed: '', inserted: 'l' });
  });

  it('finds the removed span', () => {
    expect(diffText('hello', 'helo')).toEqual({ at: 3, removed: 'l', inserted: '' });
  });

  it('reports a replacement as one span', () => {
    expect(diffText('cat sat', 'dog sat')).toEqual({ at: 0, removed: 'cat', inserted: 'dog' });
  });

  it('says nothing changed', () => {
    expect(diffText('same', 'same')).toBe(null);
  });
});

describe('caretAfter', () => {
  it('lands the caret where the text stopped matching', () => {
    // Undoing " world" off the end puts the caret back at the end of "hello".
    expect(caretAfter('hello world', 'hello')).toBe(5);
  });

  it('lands after text a redo put back', () => {
    expect(caretAfter('hello', 'hello world')).toBe(11);
  });

  it('falls back to the end when the two are identical', () => {
    expect(caretAfter('hello', 'hello')).toBe(5);
  });
});

describe('coalescing', () => {
  it('takes a whole typed word back in one step', () => {
    const u = createFieldUndo('');
    typer(u).type('hello');
    expect(u.stack[u.i]).toBe('hello');
    expect(undoField(u)).toBe('');
    expect(undoField(u)).toBe(null);
  });

  it('breaks the run at a word boundary, keeping the space with the word before it', () => {
    const u = createFieldUndo('');
    typer(u).type('hello world');
    expect(undoField(u)).toBe('hello ');
    expect(undoField(u)).toBe('');
  });

  it('breaks the run when the typing pauses', () => {
    const u = createFieldUndo('');
    const t = typer(u);
    t.type('ab');
    t.key('abc', COALESCE_MS + 1);
    t.key('abcd');
    expect(undoField(u)).toBe('ab');
    expect(undoField(u)).toBe('');
  });

  it('breaks the run when the caret jumps', () => {
    const u = createFieldUndo('');
    const t = typer(u);
    t.type('bc'); // "bc"
    t.key('abc'); // typed at the front instead — not adjacent to the last edit
    expect(undoField(u)).toBe('bc');
    expect(undoField(u)).toBe('');
  });

  it('does not merge a delete into the typing before it', () => {
    const u = createFieldUndo('');
    const t = typer(u);
    t.type('abc');
    t.key('ab');
    expect(undoField(u)).toBe('abc');
    expect(undoField(u)).toBe('');
  });

  it('takes a run of backspaces back in one step', () => {
    const u = createFieldUndo('abcd');
    const t = typer(u);
    t.key('abc');
    t.key('ab');
    t.key('a');
    expect(undoField(u)).toBe('abcd');
  });

  it('takes a run of forward deletes back in one step', () => {
    const u = createFieldUndo('abcd');
    const t = typer(u);
    t.key('bcd'); // Delete with the caret at 0
    t.key('cd');
    expect(undoField(u)).toBe('abcd');
  });

  it('gives a paste a step of its own mid-word', () => {
    const u = createFieldUndo('');
    const t = typer(u);
    t.type('ab');
    t.key('abPASTED', 50, { atomic: true });
    t.key('abPASTEDc'); // typing resumes in a step of its own, not inside the paste
    expect(undoField(u)).toBe('abPASTED');
    expect(undoField(u)).toBe('ab');
    expect(undoField(u)).toBe('');
  });

  it('keeps typing after a paste out of the paste', () => {
    const u = createFieldUndo('');
    const t = typer(u);
    t.key('PASTED', 50, { atomic: true });
    t.type('xy');
    expect(undoField(u)).toBe('PASTED');
    expect(undoField(u)).toBe('');
  });

  it('ignores an edit that changes nothing', () => {
    const u = createFieldUndo('abc');
    expect(recordFieldEdit(u, 'abc', { now: 1 })).toBe(false);
    expect(u.stack.length).toBe(1);
  });
});

describe('walking the stack', () => {
  it('redoes what it undid', () => {
    const u = createFieldUndo('');
    typer(u).type('hello world');
    expect(undoField(u)).toBe('hello ');
    expect(redoField(u)).toBe('hello world');
    expect(redoField(u)).toBe(null);
  });

  it('opens a new step for typing straight after an undo', () => {
    const u = createFieldUndo('');
    const t = typer(u);
    t.type('ab');
    expect(undoField(u)).toBe('');
    t.key('x');
    // The typing must not have been written into the step the undo landed on:
    // that step is what the next ⌘Z has to give back.
    expect(undoField(u)).toBe('');
  });

  it('forfeits the redo tail once a new edit lands', () => {
    const u = createFieldUndo('');
    const t = typer(u);
    t.type('hello world');
    undoField(u); // "hello "
    t.key('hello there');
    expect(redoField(u)).toBe(null);
    expect(undoField(u)).toBe('hello ');
  });

  it('drops the oldest step rather than growing without bound', () => {
    const u = createFieldUndo('');
    const t = typer(u);
    // Every keystroke is its own step: each one pauses past the coalesce window.
    let v = '';
    for (let n = 0; n < MAX_FIELD_STEPS + 10; n++) t.key((v += 'x'), COALESCE_MS + 1);
    expect(u.stack.length).toBe(MAX_FIELD_STEPS);
    expect(u.i).toBe(MAX_FIELD_STEPS - 1);
    // Still walks all the way back to the oldest step it kept.
    while (undoField(u) !== null);
    expect(u.i).toBe(0);
  });
});

describe('resyncField', () => {
  it('abandons a stack that no longer describes the field', () => {
    const u = createFieldUndo('');
    typer(u).type('one');
    resyncField(u, 'another box');
    expect(undoField(u)).toBe(null);
    expect(u.stack).toEqual(['another box']);
  });

  it('does not coalesce the first edit after a resync into the seed', () => {
    const u = createFieldUndo('');
    const t = typer(u);
    t.type('ab');
    resyncField(u, 'ab');
    t.key('abc');
    expect(undoField(u)).toBe('ab');
  });
});

describe('isAtomicInput', () => {
  it('names the sources that are not the keyboard', () => {
    for (const t of ['insertFromPaste', 'insertFromDrop', 'deleteByCut', 'insertReplacementText'])
      expect(isAtomicInput(t)).toBe(true);
  });

  it('leaves ordinary typing alone', () => {
    for (const t of ['insertText', 'deleteContentBackward', 'insertLineBreak', undefined])
      expect(isAtomicInput(t)).toBe(false);
  });
});
