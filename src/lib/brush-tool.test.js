import { describe, it, expect, beforeEach } from 'vitest';
import {
  brushTool,
  setBrushMode,
  setLiquifyMode,
  brushArmed,
  liquifySettings,
  defaultBrushToolSettings,
  LIQUIFY_DEFAULTS,
  LIQUIFY_RADIUS_MIN,
  LIQUIFY_RADIUS_MAX,
} from './brush-tool.svelte.js';
import { LIQUIFY_MODES } from './liquify.js';
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

  it('arms liquify as a third mode of the same tool', () => {
    expect(setBrushMode('liquify')).toBe(true);
    expect(brushTool.mode).toBe('liquify');
    expect(brushArmed()).toBe(true);
    // Draw and erase are untouched by the new mode.
    expect(setBrushMode('erase')).toBe(true);
    expect(brushTool.mode).toBe('erase');
  });

  it('starts liquify on push, at a usable radius and half strength', () => {
    expect(brushTool.settings.liquifyMode).toBe('push');
    expect(brushTool.settings.liquifyRadius).toBe(LIQUIFY_DEFAULTS.liquifyRadius);
    expect(brushTool.settings.liquifyStrength).toBe(LIQUIFY_DEFAULTS.liquifyStrength);
    expect(LIQUIFY_DEFAULTS.liquifyRadius).toBeGreaterThanOrEqual(LIQUIFY_RADIUS_MIN);
    expect(LIQUIFY_DEFAULTS.liquifyRadius).toBeLessThanOrEqual(LIQUIFY_RADIUS_MAX);
  });

  it('takes every field the engine offers and refuses anything else', () => {
    for (const m of LIQUIFY_MODES) {
      expect(setLiquifyMode(m)).toBe(true);
      expect(brushTool.settings.liquifyMode).toBe(m);
    }
    expect(setLiquifyMode('smudge')).toBe(false);
    expect(setLiquifyMode(null)).toBe(false);
    expect(brushTool.settings.liquifyMode).toBe(LIQUIFY_MODES[LIQUIFY_MODES.length - 1]);
  });

  it('hands the gesture settings inside the ranges the panel offers', () => {
    // The panel clamps as it writes; this is the second door, for a settings
    // object that came from somewhere else - a picked brush, an older session.
    expect(liquifySettings({ liquifyMode: 'twirl', liquifyRadius: 900, liquifyStrength: 400 })).toEqual({
      mode: 'twirl',
      radius: LIQUIFY_RADIUS_MAX,
      strength: 100,
    });
    expect(liquifySettings({ liquifyRadius: -20, liquifyStrength: -1 })).toEqual({
      mode: 'push',
      radius: LIQUIFY_RADIUS_MIN,
      strength: 0,
    });
  });

  it('falls back to the defaults for anything unreadable, including no settings at all', () => {
    const want = { mode: 'push', radius: LIQUIFY_DEFAULTS.liquifyRadius, strength: LIQUIFY_DEFAULTS.liquifyStrength };
    expect(liquifySettings({ liquifyMode: 'nope', liquifyRadius: 'x', liquifyStrength: NaN })).toEqual(want);
    expect(liquifySettings({})).toEqual(want);
    expect(liquifySettings(null)).toEqual(want);
  });

  it('reads the live settings when it is asked for nothing in particular', () => {
    brushTool.settings.liquifyMode = 'pinch';
    brushTool.settings.liquifyRadius = 77;
    brushTool.settings.liquifyStrength = 12;
    expect(liquifySettings()).toEqual({ mode: 'pinch', radius: 77, strength: 12 });
  });

  it('keeps the liquify three out of what a stroke is drawn with', () => {
    // `buildStroke` names the keys it copies, so these never reach a stored
    // stroke - but they must not collide with a brush setting either.
    const brushKeys = Object.keys(defaultBrushToolSettings()).filter((k) => k.startsWith('liquify'));
    expect(brushKeys.sort()).toEqual(['liquifyMode', 'liquifyRadius', 'liquifyStrength']);
  });
});
