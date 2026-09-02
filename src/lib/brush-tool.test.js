import { describe, it, expect, beforeEach } from 'vitest';
import {
  brushTool,
  setBrushMode,
  brushArmed,
  defaultBrushToolSettings,
  BRUSH_MODES,
} from './brush-tool.svelte.js';
import { defaultBrushSettings } from './brush.js';
import { TOOLS } from './store.svelte.js';

describe('brush tool state', () => {
  beforeEach(() => {
    setBrushMode(null);
    brushTool.settings = defaultBrushToolSettings();
  });

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

  it('has draw and erase and nothing else: liquify is an effect on the box', () => {
    expect(BRUSH_MODES).toEqual(['draw', 'erase']);
    expect(setBrushMode('liquify')).toBe(false);
    expect(brushTool.mode).toBe(null);
  });

  it('carries nothing but a brush\'s own settings', () => {
    expect(Object.keys(defaultBrushToolSettings()).sort()).toEqual(Object.keys(defaultBrushSettings()).sort());
  });
});

describe('the panel tab and the manager', () => {
  it('starts on the board and only accepts its own tabs', async () => {
    const { BRUSH_TABS, setBrushTab } = await import('./brush-tool.svelte.js');
    expect(BRUSH_TABS[0]).toBe('board');
    expect(brushTool.tab).toBe('board');
    expect(setBrushTab('dynamics')).toBe(true);
    expect(brushTool.tab).toBe('dynamics');
    expect(setBrushTab('nope')).toBe(false);
    expect(brushTool.tab).toBe('dynamics');
    setBrushTab('board');
  });

  it('opens the manager on a brush, or on the plain list, and closes clean', async () => {
    const { openBrushManager, closeBrushManager } = await import('./brush-tool.svelte.js');
    openBrushManager('abc');
    expect(brushTool.manager).toBe(true);
    expect(brushTool.editBrushId).toBe('abc');
    closeBrushManager();
    expect(brushTool.manager).toBe(false);
    expect(brushTool.editBrushId).toBeNull();
    openBrushManager();
    expect(brushTool.editBrushId).toBeNull();
    openBrushManager('');
    expect(brushTool.editBrushId).toBeNull();
    closeBrushManager();
  });
});

describe('the finish', () => {
  it('is carried for the next placed layer, empty, and apart from the brush', async () => {
    const { BRUSH_TABS } = await import('./brush-tool.svelte.js');
    expect(BRUSH_TABS).toContain('finish');
    expect(brushTool.finish).toEqual({ strokes: [], shadows: [] });
    expect('strokes' in brushTool.settings).toBe(false);
  });
});
