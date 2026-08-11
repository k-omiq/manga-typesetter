import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  route,
  goLibrary,
  goProject,
  goEditor,
  goBack,
  setLeaveEditorHook,
  resetRoute,
} from './route.svelte.js';

beforeEach(() => {
  setLeaveEditorHook(null);
  resetRoute();
});

describe('route', () => {
  it('starts at the library', () => {
    expect(route.name).toBe('library');
    expect(route.projectId).toBe(null);
    expect(route.chapterId).toBe(null);
  });

  it('carries ids into the project view', () => {
    goProject('p1');
    expect(route.name).toBe('project');
    expect(route.projectId).toBe('p1');
    expect(route.chapterId).toBe(null);
  });

  it('carries both ids into the editor', () => {
    goEditor('p1', 'c1');
    expect(route.name).toBe('editor');
    expect(route.projectId).toBe('p1');
    expect(route.chapterId).toBe('c1');
  });

  it('goes back to the previous entry', () => {
    goProject('p1');
    goEditor('p1', 'c1');
    goBack();
    expect(route.name).toBe('project');
    expect(route.projectId).toBe('p1');
  });

  it('stays at the library when there is no history', () => {
    goBack();
    expect(route.name).toBe('library');
  });

  it('does not record a no-op navigation in history', () => {
    goProject('p1');
    goProject('p1');
    goBack();
    expect(route.name).toBe('library');
  });
});

describe('leave-editor hook', () => {
  it('fires when leaving the editor', async () => {
    const hook = vi.fn();
    setLeaveEditorHook(hook);
    goEditor('p1', 'c1');
    expect(hook).not.toHaveBeenCalled();
    await goLibrary();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('does not fire when navigating between non-editor views', async () => {
    const hook = vi.fn();
    setLeaveEditorHook(hook);
    await goProject('p1');
    await goLibrary();
    expect(hook).not.toHaveBeenCalled();
  });

  it('fires on goBack out of the editor', async () => {
    const hook = vi.fn();
    setLeaveEditorHook(hook);
    goProject('p1');
    goEditor('p1', 'c1');
    await goBack();
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
