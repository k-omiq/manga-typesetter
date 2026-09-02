import { describe, it, expect, beforeEach } from 'vitest';
import {
  liquifyTool,
  setLiquifyMode,
  liquifySettings,
  LIQUIFY_DEFAULTS,
  LIQUIFY_RADIUS_MIN,
  LIQUIFY_RADIUS_MAX,
} from './liquify-tool.svelte.js';
import { LIQUIFY_MODES } from './liquify.js';
import { EFFECTS_SUBTABS } from './inspector-tabs.svelte.js';

describe('the liquify tool', () => {
  beforeEach(() => Object.assign(liquifyTool, LIQUIFY_DEFAULTS));

  it('is an Effects sub-tab, beside the transform it edits', () => {
    expect(EFFECTS_SUBTABS).toContain('liquify');
    expect(EFFECTS_SUBTABS.indexOf('liquify')).toBe(EFFECTS_SUBTABS.indexOf('transform') + 1);
  });

  it('starts on push, at a usable radius and half strength', () => {
    expect(liquifyTool.mode).toBe('push');
    expect(LIQUIFY_DEFAULTS.radius).toBeGreaterThanOrEqual(LIQUIFY_RADIUS_MIN);
    expect(LIQUIFY_DEFAULTS.radius).toBeLessThanOrEqual(LIQUIFY_RADIUS_MAX);
  });

  it('takes every field the engine offers and refuses anything else', () => {
    for (const m of LIQUIFY_MODES) {
      expect(setLiquifyMode(m)).toBe(true);
      expect(liquifyTool.mode).toBe(m);
    }
    expect(setLiquifyMode('smudge')).toBe(false);
    expect(liquifyTool.mode).toBe(LIQUIFY_MODES[LIQUIFY_MODES.length - 1]);
  });

  it('hands the gesture settings clamped, and defaults for anything unreadable', () => {
    expect(liquifySettings({ mode: 'twirl', radius: 900, strength: 400 })).toEqual({ mode: 'twirl', radius: LIQUIFY_RADIUS_MAX, strength: 100 });
    expect(liquifySettings({ radius: -20, strength: -1 })).toEqual({ mode: 'push', radius: LIQUIFY_RADIUS_MIN, strength: 0 });
    expect(liquifySettings(null)).toEqual(LIQUIFY_DEFAULTS);
    liquifyTool.mode = 'pinch';
    liquifyTool.radius = 77;
    liquifyTool.strength = 12;
    expect(liquifySettings()).toEqual({ mode: 'pinch', radius: 77, strength: 12 });
  });
});
