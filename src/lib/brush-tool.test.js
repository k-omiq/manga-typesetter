import { describe, it, expect, beforeEach } from 'vitest';
import { brushTool, setBrushMode, brushArmed } from './brush-tool.svelte.js';
import { TOOLS } from './store.svelte.js';

describe('brush tool state', () => {
  beforeEach(() => setBrushMode(null));

  it('is a tool the rail can select', () => {
    expect(TOOLS).toContain('brush');
  });

  it('starts disarmed and arms into draw', () => {
    expect(brushArmed()).toBe(false);
    expect(setBrushMode('draw')).toBe(true);
    expect(brushTool.mode).toBe('draw');
    expect(brushArmed()).toBe(true);
  });

  it('refuses a mode it does not have', () => {
    expect(setBrushMode('smudge')).toBe(false);
    expect(brushTool.mode).toBe(null);
  });

  it('starts with a usable round brush', () => {
    expect(brushTool.settings.brush).toBe('round');
    expect(brushTool.settings.size).toBeGreaterThan(0);
    expect(brushTool.settings.dyn.src).toBe('velocity');
  });
});
