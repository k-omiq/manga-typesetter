import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./fsx.js', () => {
  const tree = { dirs: new Set(), files: new Map() };
  return {
    fsx: {
      _tree: tree,
      async readDir(p) {
        const prefix = p.endsWith('/') ? p : p + '/';
        const names = new Set();
        for (const d of tree.dirs) {
          if (d.startsWith(prefix)) {
            const rest = d.slice(prefix.length);
            if (rest && !rest.includes('/')) names.add(rest);
          }
        }
        return [...names].map((name) => ({ name, isDirectory: true, isFile: false }));
      },
      async readTextFile(p) {
        if (!tree.files.has(p)) throw new Error('ENOENT ' + p);
        return tree.files.get(p);
      },
      async writeTextFile(p, c) {
        tree.files.set(p, c);
      },
      // Mirrors `{ recursive: true }`: every ancestor comes into being too, so
      // a directory the app created is visible to `exists` at every level.
      async mkdir(p) {
        const parts = p.split('/');
        for (let i = 1; i <= parts.length; i++) {
          const d = parts.slice(0, i).join('/');
          if (d) tree.dirs.add(d);
        }
      },
      async remove(p) {
        for (const d of [...tree.dirs]) if (d === p || d.startsWith(p + '/')) tree.dirs.delete(d);
        for (const f of [...tree.files.keys()]) if (f.startsWith(p + '/')) tree.files.delete(f);
      },
      async exists(p) {
        return tree.dirs.has(p) || tree.files.has(p);
      },
      async join(...parts) {
        return parts.join('/');
      },
      async homeDir() {
        return '/home/u';
      },
      async readFile(p) {
        return tree.files.get(p) ?? new Uint8Array();
      },
      async writeFile(p, bytes) {
        tree.files.set(p, bytes);
      },
    },
  };
});

const { fsx } = await import('./fsx.js');
const { library, setRoot, scanLibrary, createProject, deleteProject, deleteChapter, projectById } = await import(
  './library.svelte.js'
);

function seedProject(slug, json, chapters = []) {
  fsx._tree.dirs.add(`/lib/${slug}`);
  fsx._tree.files.set(`/lib/${slug}/project.json`, json);
  for (const [cslug, cjson] of chapters) {
    fsx._tree.dirs.add(`/lib/${slug}/${cslug}`);
    fsx._tree.files.set(`/lib/${slug}/${cslug}/chapter.json`, cjson);
  }
}

const PROJECT = (id, name) =>
  JSON.stringify({ schema: 1, id, name, createdAt: 'T0', updatedAt: 'T0', coverChapterId: null, coverPageId: null });

const CHAPTER = (id, number, pages) =>
  JSON.stringify({ schema: 1, id, number, title: '', createdAt: 'T0', updatedAt: 'T0', pages });

beforeEach(async () => {
  fsx._tree.dirs.clear();
  fsx._tree.files.clear();
  fsx._tree.dirs.add('/lib');
  await setRoot('/lib');
});

describe('scanLibrary', () => {
  it('finds projects and their chapters', async () => {
    seedProject('one-piece', PROJECT('p1', 'One Piece'), [['001', CHAPTER('c1', 1, [{ id: 1 }, { id: 2 }])]]);
    await scanLibrary();
    expect(library.projects).toHaveLength(1);
    expect(library.projects[0].name).toBe('One Piece');
    expect(library.projects[0].chapters[0].pageCount).toBe(2);
  });

  it('skips a corrupt project.json without failing the scan', async () => {
    seedProject('good', PROJECT('p1', 'Good'));
    fsx._tree.dirs.add('/lib/bad');
    fsx._tree.files.set('/lib/bad/project.json', '{ this is not json');
    await scanLibrary();
    expect(library.projects.filter((p) => !p.unreadable)).toHaveLength(1);
    expect(library.projects.filter((p) => p.unreadable)).toHaveLength(1);
    expect(library.error).toBeTruthy();
  });

  it('ignores directories with no project.json', async () => {
    fsx._tree.dirs.add('/lib/.DS_Store_dir');
    await scanLibrary();
    expect(library.projects).toHaveLength(0);
  });

  it('records whether a chapter has any typesetting on it', async () => {
    const BOXED = JSON.stringify({
      schema: 1,
      id: 'c2',
      number: 2,
      title: '',
      createdAt: 'T0',
      updatedAt: 'T0',
      pages: [{ id: 1, boxes: [{ id: 'b1', lineN: 1 }] }],
    });
    seedProject('t', PROJECT('p1', 'T'), [
      ['001', CHAPTER('c1', 1, [{ id: 1 }, { id: 2 }])],
      ['002', BOXED],
    ]);
    await scanLibrary();
    const [raws, typeset] = library.projects[0].chapters;
    expect(raws.typeset).toBe(false);
    expect(typeset.typeset).toBe(true);
  });

  it('sorts chapters by number', async () => {
    seedProject('x', PROJECT('p1', 'X'), [
      ['010', CHAPTER('c10', 10, [])],
      ['002', CHAPTER('c2', 2, [])],
    ]);
    await scanLibrary();
    expect(library.projects[0].chapters.map((c) => c.number)).toEqual([2, 10]);
  });

  it('flags a duplicated project folder instead of keying two cards on one id', async () => {
    // Duplicating a folder inside the library root is the obvious way to back
    // one up, and it copies the id along with everything else.
    seedProject('one-piece', PROJECT('p1', 'One Piece'));
    seedProject('one-piece-backup', PROJECT('p1', 'One Piece'));
    await scanLibrary();
    expect(library.projects).toHaveLength(2);
    // The {#each} key holds, so the grid neither throws nor mis-associates.
    expect(new Set(library.projects.map((p) => p.id)).size).toBe(2);
    // The first one keeps the id and stays usable; the copy is inert, so a
    // delete cannot remove one directory and leave the other entry behind.
    expect(projectById('p1').slug).toBe('one-piece');
    const flagged = library.projects.filter((p) => p.duplicate);
    expect(flagged.map((p) => p.slug)).toEqual(['one-piece-backup']);
    expect(flagged[0].unreadable).toBe(true);
    expect(library.error).toMatch(/one-piece-backup/);
  });

  it('flags a duplicated chapter folder the same way', async () => {
    seedProject('x', PROJECT('p1', 'X'), [
      ['001', CHAPTER('c1', 1, [{ id: 1 }])],
      ['001-copy', CHAPTER('c1', 1, [{ id: 1 }])],
    ]);
    await scanLibrary();
    const chapters = library.projects[0].chapters;
    expect(new Set(chapters.map((c) => c.id)).size).toBe(2);
    expect(chapters.filter((c) => c.duplicate).map((c) => c.slug)).toEqual(['001-copy']);
    expect(library.error).toMatch(/001-copy/);
  });

  it('keeps the boot failure on screen instead of scanning nowhere', async () => {
    // What a failed initRoot leaves behind: no root, and a message the library
    // screen is already rendering. The scan the screen runs on mount — and the
    // retry button that lands back here — must not wipe it.
    await setRoot('');
    library.error = 'Could not work out where your library lives — no home directory';
    await scanLibrary();
    expect(library.loading).toBe(false);
    expect(library.projects).toHaveLength(0);
    expect(library.error).toMatch(/Could not work out where your library lives/);
  });

  it('lets the newer scan win when a blocked one settles late', async () => {
    // Scan A goes out against the old root and blocks — on this machine that was
    // a macOS folder-permission prompt sitting unanswered at boot.
    fsx._tree.dirs.add('/old');
    await setRoot('/old');
    let refuse;
    const blocked = new Promise((_, reject) => {
      refuse = reject;
    });
    // The prompt sits in front of the very first call the scan makes, so the
    // old root is the one this scan is provably reading.
    const origExists = fsx.exists;
    fsx.exists = async (p) => (p === '/old' ? blocked : origExists(p));
    const scanA = scanLibrary();

    try {
      // The user takes the app's own documented recovery — Settings ▸ Change
      // folder — and scan B reads the new root successfully.
      seedProject('kept', PROJECT('p1', 'Kept'));
      await setRoot('/lib');
      await scanLibrary();
      expect(library.projects.map((p) => p.slug)).toEqual(['kept']);

      // Only now does the blocked scan give up.
      refuse(
        new Error('failed to read directory at path: /old with error: Operation not permitted'),
      );
      await scanA;
    } finally {
      fsx.exists = origExists;
    }

    // The freshly scanned library survives, and the user is not told that the
    // folder they are looking at cannot be read.
    expect(library.projects.map((p) => p.slug)).toEqual(['kept']);
    expect(library.error).toBe('');
    // The flag belongs to the scan that finished last in sequence, not in time.
    expect(library.loading).toBe(false);
  });

  it('names the root it actually read when a scan fails', async () => {
    await setRoot('/old');
    const origReadDir = fsx.readDir;
    fsx.readDir = async (p) => {
      if (p === '/old') throw new Error('Operation not permitted');
      return origReadDir(p);
    };
    try {
      fsx._tree.dirs.add('/old');
      await scanLibrary();
    } finally {
      fsx.readDir = origReadDir;
    }
    expect(library.error).toMatch(/library at \/old/);
    expect(library.error).not.toMatch(/\/lib\b/);
  });

  it('marks a corrupt chapter.json as unreadable without failing the scan', async () => {
    seedProject('y', PROJECT('p1', 'Y'), [['001', CHAPTER('c1', 1, [])]]);
    fsx._tree.dirs.add('/lib/y/002');
    fsx._tree.files.set('/lib/y/002/chapter.json', '{ this is not json');
    fsx._tree.dirs.add('/lib/y/no-marker');
    await scanLibrary();
    const chapters = library.projects[0].chapters;
    expect(chapters.filter((c) => !c.unreadable)).toHaveLength(1);
    expect(chapters.filter((c) => c.unreadable)).toHaveLength(1);
    expect(chapters.find((c) => c.slug === 'no-marker')).toBeUndefined();
    expect(library.error).toBeTruthy();
  });
});

describe('createProject', () => {
  it('writes project.json and appears in the catalogue', async () => {
    const p = await createProject('New Series');
    expect(p.slug).toBe('new-series');
    expect(fsx._tree.files.has('/lib/new-series/project.json')).toBe(true);
    expect(projectById(p.id)).toBeTruthy();
  });

  it('avoids a directory collision on a duplicate name', async () => {
    await createProject('Dup');
    const second = await createProject('Dup');
    expect(second.slug).toBe('dup-2');
  });

  it('never writes into an existing directory the scan never saw', async () => {
    // The user's own folder, holding the only copies of their raws. It carries
    // no project.json, so the scan ignores it and the catalogue has no idea it
    // is there — which is exactly why the check has to reach the disk.
    fsx._tree.dirs.add('/lib/one-piece');
    fsx._tree.files.set('/lib/one-piece/ch1-p001.png', new Uint8Array([7]));

    const p = await createProject('One Piece');

    expect(p.slug).toBe('one-piece-2');
    expect(fsx._tree.files.has('/lib/one-piece/project.json')).toBe(false);
    expect(fsx._tree.files.has('/lib/one-piece-2/project.json')).toBe(true);
    // And the folder is still theirs: deleting the project they just made
    // cannot reach it.
    await deleteProject(p.id);
    expect(fsx._tree.files.get('/lib/one-piece/ch1-p001.png')).toEqual(new Uint8Array([7]));
  });
});

describe('deleteProject', () => {
  it('removes the directory and the catalogue entry', async () => {
    const p = await createProject('Gone');
    await deleteProject(p.id);
    expect(fsx._tree.dirs.has('/lib/gone')).toBe(false);
    expect(projectById(p.id)).toBeUndefined();
  });
});

describe('deleteChapter', () => {
  it('removes the chapter directory and entry without touching the project', async () => {
    const p = await createProject('Keep');
    fsx._tree.dirs.add('/lib/keep/001');
    fsx._tree.files.set('/lib/keep/001/chapter.json', CHAPTER('c1', 1, []));
    await scanLibrary();
    const chapter = projectById(p.id).chapters[0];
    await deleteChapter(p.id, chapter.id);
    expect(fsx._tree.dirs.has('/lib/keep/001')).toBe(false);
    expect(projectById(p.id).chapters).toHaveLength(0);
    expect(fsx._tree.dirs.has('/lib/keep')).toBe(true);
    expect(fsx._tree.files.has('/lib/keep/project.json')).toBe(true);
  });
});

const { createChapter } = await import('./library.svelte.js');

function fakeFile(name, byte) {
  return { name, arrayBuffer: async () => new Uint8Array([byte]).buffer };
}

describe('createChapter', () => {
  it('writes chapter.json with one page per file, in natural order', async () => {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 3,
      title: 'The Duel',
      files: [fakeFile('page10.png', 10), fakeFile('page2.png', 2)],
    });
    expect(c.slug).toBe('003-the-duel');
    const json = JSON.parse(fsx._tree.files.get(`${c.dir}/chapter.json`));
    expect(json.pages.map((pg) => pg.file)).toEqual(['page2.png', 'page10.png']);
  });

  it('appears in the project catalogue immediately', async () => {
    const p = await createProject('Series');
    await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    expect(projectById(p.id).chapters).toHaveLength(1);
  });

  it('rolls back the directory when a copy fails', async () => {
    const p = await createProject('Series');
    const broken = { name: 'bad.png', arrayBuffer: async () => { throw new Error('read failed'); } };
    await expect(
      createChapter({ projectId: p.id, number: 1, title: '', files: [broken] }),
    ).rejects.toThrow();
    expect(fsx._tree.dirs.has(`${p.dir}/001`)).toBe(false);
    expect(projectById(p.id).chapters).toHaveLength(0);
  });

  it('sidesteps an existing directory rather than merging into it', async () => {
    const p = await createProject('Series');
    fsx._tree.dirs.add(`${p.dir}/001`);
    fsx._tree.files.set(`${p.dir}/001/scan-001.png`, new Uint8Array([9]));
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1)],
    });
    expect(c.slug).toBe('001-2');
    expect(fsx._tree.files.has(`${p.dir}/001/chapter.json`)).toBe(false);
    expect(fsx._tree.files.get(`${p.dir}/001/scan-001.png`)).toEqual(new Uint8Array([9]));
  });

  it("rolls back nothing when the directory was not this run's to remove", async () => {
    const p = await createProject('Series');
    fsx._tree.dirs.add(`${p.dir}/001`);
    fsx._tree.files.set(`${p.dir}/001/scan-001.png`, new Uint8Array([9]));
    const broken = { name: 'bad.png', arrayBuffer: async () => { throw new Error('read failed'); } };
    await expect(
      createChapter({ projectId: p.id, number: 1, title: '', files: [broken] }),
    ).rejects.toThrow();
    // The rollback took out the directory this run made, and left the one it
    // stepped around completely alone.
    expect(fsx._tree.dirs.has(`${p.dir}/001-2`)).toBe(false);
    expect(fsx._tree.dirs.has(`${p.dir}/001`)).toBe(true);
    expect(fsx._tree.files.get(`${p.dir}/001/scan-001.png`)).toEqual(new Uint8Array([9]));
  });

  it('removes nothing at all when the directory could not be created', async () => {
    const p = await createProject('Series');
    const removed = [];
    const origMkdir = fsx.mkdir;
    const origRemove = fsx.remove;
    fsx.mkdir = async () => {
      throw new Error('read-only filesystem');
    };
    fsx.remove = async (path) => {
      removed.push(path);
      return origRemove(path);
    };
    try {
      await expect(
        createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] }),
      ).rejects.toThrow('read-only filesystem');
    } finally {
      fsx.mkdir = origMkdir;
      fsx.remove = origRemove;
    }
    expect(removed).toEqual([]);
  });

  it('dedupes colliding filenames instead of overwriting on disk', async () => {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('page.png', 1), fakeFile('page.png', 2)],
    });
    const json = JSON.parse(fsx._tree.files.get(`${c.dir}/chapter.json`));
    const names = json.pages.map((pg) => pg.file);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(fsx._tree.files.has(`${c.dir}/raws/${name}`)).toBe(true);
    }
    const bytesA = fsx._tree.files.get(`${c.dir}/raws/${names[0]}`);
    const bytesB = fsx._tree.files.get(`${c.dir}/raws/${names[1]}`);
    expect(bytesA).not.toEqual(bytesB);
  });

  it('rolls back when the project.json write fails after raws and chapter.json succeed', async () => {
    const orig = fsx.writeTextFile;
    let projectWrites = 0;
    fsx.writeTextFile = async (path, contents) => {
      if (path.endsWith('/project.json')) {
        projectWrites++;
        // First write is createProject's own project.json; the second is the
        // one createChapter performs after copying raws and writing chapter.json.
        if (projectWrites === 2) throw new Error('disk full');
      }
      return orig(path, contents);
    };
    let p;
    try {
      p = await createProject('Series');
      await expect(
        createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] }),
      ).rejects.toThrow();
    } finally {
      fsx.writeTextFile = orig;
    }
    expect(fsx._tree.dirs.has(`${p.dir}/001`)).toBe(false);
    expect(projectById(p.id).chapters).toHaveLength(0);
    expect(projectById(p.id).coverChapterId).toBeNull();
  });
});

const { openChapter, saveOpenChapter, closeChapter, chapterById, flushBeforeLeaving, resetSaveFailures } =
  await import('./library.svelte.js');
const { app, markUnsaved, page, loadProjectPages } = await import('./store.svelte.js');
const { importJsonFile } = await import('./importer.js');
const { importPsdFiles } = await import('./psd.js');
const { route, goEditor, goLibrary, resetRoute } = await import('./route.svelte.js');

// The editor store is module-global, so no case may inherit another's open
// chapter — a stale chapterRef would let a save land in the wrong file.
beforeEach(() => closeChapter());

// A chapter with two same-named picked files, so the on-disk names are deduped
// and `pages[].file` is provably not the name the user picked.
async function seedOpenChapter() {
  const p = await createProject('Series');
  const c = await createChapter({
    projectId: p.id,
    number: 1,
    title: '',
    files: [fakeFile('page.png', 1), fakeFile('page.png', 2)],
  });
  await openChapter(p.id, c.id);
  return { p, c };
}

const chapterJson = (c) => JSON.parse(fsx._tree.files.get(`${c.dir}/chapter.json`));

describe('openChapter', () => {
  it('loads a page per record entry and resolves raws by file name', async () => {
    const { p, c } = await seedOpenChapter();
    expect(app.pages).toHaveLength(2);
    expect(app.pages.every((pg) => String(pg.raw).startsWith('blob:'))).toBe(true);
    expect(app.chapterRef).toEqual({ projectId: p.id, chapterId: c.id });
    expect(app.saved).toBe(true);
    closeChapter();
  });

  it('keeps the typesetting when a raw is missing from disk', async () => {
    const { p, c } = await seedOpenChapter();
    closeChapter();
    const record = chapterJson(c);
    record.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));
    fsx._tree.files.delete(`${c.dir}/raws/${record.pages[0].file}`);
    const orig = fsx.readFile;
    fsx.readFile = async (path) => {
      if (!fsx._tree.files.has(path)) throw new Error('ENOENT ' + path);
      return orig(path);
    };
    try {
      await openChapter(p.id, c.id);
    } finally {
      fsx.readFile = orig;
    }
    expect(app.pages[0].raw).toBeNull();
    expect(app.pages[0].lines).toHaveLength(1);
    // The reference survives the missing file, so the next save cannot orphan
    // the raw by writing an empty name over it.
    expect(app.pages[0].file).toBe(record.pages[0].file);
    closeChapter();
  });

  it('refuses to open an unreadable chapter rather than loading a blank one', async () => {
    closeChapter();
    seedProject('z', PROJECT('p1', 'Z'));
    fsx._tree.dirs.add('/lib/z/001');
    fsx._tree.files.set('/lib/z/001/chapter.json', '{ this is not json');
    await scanLibrary();
    const c = projectById('p1').chapters[0];
    expect(c.unreadable).toBe(true);
    await expect(openChapter('p1', c.id)).rejects.toThrow();
    expect(app.chapterRef).toBeNull();
  });
});

describe('saveOpenChapter', () => {
  it('keeps pages[].file exactly as it is on disk and never writes a blob URL', async () => {
    const { c } = await seedOpenChapter();
    const before = chapterJson(c).pages.map((pg) => pg.file);
    app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    await saveOpenChapter();
    const after = chapterJson(c);
    expect(after.pages.map((pg) => pg.file)).toEqual(before);
    expect(fsx._tree.files.get(`${c.dir}/chapter.json`)).not.toContain('blob:');
    expect(after.pages[0]).not.toHaveProperty('raw');
    closeChapter();
  });

  it('round-trips boxes with their nested style objects as plain data', async () => {
    const { p, c } = await seedOpenChapter();
    app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    app.pages[0].boxes = [
      {
        id: 'b1',
        lineN: 1,
        text: null,
        x: 10,
        y: 20,
        w: 100,
        h: 40,
        style: { font: 'Bangers', size: 30, shadow: { on: true, x: 3 }, roughen: { on: false } },
      },
    ];
    await saveOpenChapter();
    expect(chapterJson(c).pages[0].boxes[0].style.shadow.on).toBe(true);
    closeChapter();
    await openChapter(p.id, c.id);
    expect(app.pages[0].boxes[0].style.font).toBe('Bangers');
    expect(app.pages[0].boxes[0].style.shadow.on).toBe(true);
    // Unset keys are filled from the current schema, not left undefined.
    expect(app.pages[0].boxes[0].style.shadow.blur).toBe(2);
    closeChapter();
  });

  it('turns the catalogue entry typeset once a box is placed', async () => {
    const { p, c } = await seedOpenChapter();
    expect(chapterById(p.id, c.id).typeset).toBe(false);
    app.pages[0].boxes = [
      { id: 'b1', lineN: null, text: 'Ah', x: 0, y: 0, w: 10, h: 10, style: {} },
    ];
    await saveOpenChapter();
    expect(chapterById(p.id, c.id).typeset).toBe(true);
    closeChapter();
  });

  it('updates the catalogue entry only after the write lands', async () => {
    const { p, c } = await seedOpenChapter();
    const entry = chapterById(p.id, c.id);
    const stale = entry.updatedAt;
    fsx._tree.files.delete(`${c.dir}/chapter.json`); // read fails -> no write
    await expect(saveOpenChapter()).rejects.toThrow();
    expect(chapterById(p.id, c.id).updatedAt).toBe(stale);
    closeChapter();
  });

  it('does nothing when no chapter is open', async () => {
    const { c } = await seedOpenChapter();
    const before = fsx._tree.files.get(`${c.dir}/chapter.json`);
    closeChapter();
    await saveOpenChapter();
    expect(fsx._tree.files.get(`${c.dir}/chapter.json`)).toBe(before);
  });
});

describe('pages[].file is durable, not positional', () => {
  const jsonFile = (obj) => ({ text: async () => JSON.stringify(obj) });
  const LINE = { n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' };

  it('keeps every covered page on its own raw when a shorter JSON is imported', async () => {
    const { c } = await seedOpenChapter();
    expect(chapterJson(c).pages.map((pg) => pg.file)).toEqual(['page.png', 'page-2.png']);
    await importJsonFile(jsonFile({ pages: [{ lines: [LINE] }] }));
    expect(app.pages[0].file).toBe('page.png');
    await saveOpenChapter();
    // Page 1 still owns page.png — it has not inherited its neighbour's name.
    expect(chapterJson(c).pages.map((pg) => pg.file)).toEqual(['page.png', 'page-2.png']);
    closeChapter();
  });

  it('says how many later pages it left alone', async () => {
    await seedOpenChapter();
    await importJsonFile(jsonFile({ pages: [{ lines: [LINE] }] }));
    expect(app.toast.msg).toMatch(/1 later page\(s\) left unchanged/);
    closeChapter();
  });

  it('says nothing about dropped pages outside a chapter', async () => {
    closeChapter();
    loadProjectPages([{ id: 1, lines: [], boxes: [] }, { id: 2, lines: [], boxes: [] }]);
    await importJsonFile(jsonFile({ pages: [{ lines: [LINE] }] }));
    expect(app.toast.msg).not.toMatch(/dropped/);
  });

  it('refuses a PSD substitution inside an open chapter rather than orphaning its raws', async () => {
    const { c } = await seedOpenChapter();
    const before = chapterJson(c).pages.map((pg) => pg.file);
    // Would throw if it were ever read: the guard has to return before the
    // import touches the file at all.
    const psd = {
      name: 'page.psd',
      arrayBuffer: async () => {
        throw new Error('the guard let this through');
      },
    };
    await importPsdFiles([psd]);
    expect(app.pages.map((pg) => pg.file)).toEqual(before);
    expect(app.toast.msg).toMatch(/new chapter/i);
    // And the refusal holds all the way to disk: nothing scheduled a write of
    // a foreign document over this chapter.
    await saveOpenChapter();
    expect(chapterJson(c).pages.map((pg) => pg.file)).toEqual(before);
    closeChapter();
  });
});

// The JSON button is one click away and enabled inside a chapter, because
// re-importing updated translations is exactly what it is for. What it must
// never be is a one-click way to delete the pages the file says nothing about.
describe('a JSON import never shortens the chapter', () => {
  const jsonFile = (obj) => ({ text: async () => JSON.stringify(obj) });
  const LINE = (n, en) => ({ n, type: 'dialogue', jp: 'あ', en });
  const pagesJson = (...ens) => jsonFile({ pages: ens.map((en) => ({ lines: [LINE(1, en)] })) });

  // Three pages, with the typesetting on the last one — the page a two-page
  // translations file has nothing to say about.
  async function seedTypesetChapter() {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('p1.png', 1), fakeFile('p2.png', 2), fakeFile('p3.png', 3)],
    });
    await openChapter(p.id, c.id);
    app.pages[2].lines = [LINE(1, 'End')];
    app.pages[2].boxes = [
      { id: 'b9', lineN: 1, text: null, x: 5, y: 6, w: 100, h: 40, style: {} },
    ];
    await saveOpenChapter();
    return { p, c };
  }

  it('keeps the pages a shorter JSON does not cover, and their boxes', async () => {
    const { c } = await seedTypesetChapter();
    await importJsonFile(pagesJson('One'));
    expect(app.pages).toHaveLength(3);
    expect(app.pages[2].boxes).toHaveLength(1);
    await saveOpenChapter();
    const record = chapterJson(c);
    expect(record.pages.map((pg) => pg.file)).toEqual(['p1.png', 'p2.png', 'p3.png']);
    expect(record.pages[2].boxes).toHaveLength(1);
    expect(record.pages[2].lines[0].en).toBe('End');
    closeChapter();
  });

  it('updates the lines on the pages the JSON does cover', async () => {
    const { c } = await seedTypesetChapter();
    await importJsonFile(pagesJson('One', 'Two'));
    expect(app.pages[0].lines[0].en).toBe('One');
    expect(app.pages[1].lines[0].en).toBe('Two');
    await saveOpenChapter();
    expect(chapterJson(c).pages.map((pg) => pg.lines[0]?.en)).toEqual(['One', 'Two', 'End']);
    closeChapter();
  });

  it('does not append pages that would persist with no raw', async () => {
    const { c } = await seedTypesetChapter();
    await importJsonFile(pagesJson('One', 'Two', 'Three', 'Four', 'Five'));
    expect(app.pages).toHaveLength(3);
    expect(app.toast.msg).toMatch(/2 page\(s\) past the end of the chapter ignored/);
    await saveOpenChapter();
    const files = chapterJson(c).pages.map((pg) => pg.file);
    // No page arrives with file:'' — unrenderable, and impossible to get rid of.
    expect(files).toEqual(['p1.png', 'p2.png', 'p3.png']);
    closeChapter();
  });

  it('saves the imported lines itself rather than waiting for the way out', async () => {
    const { c } = await seedTypesetChapter();
    vi.useFakeTimers();
    try {
      await importJsonFile(pagesJson('One'));
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }
    expect(chapterJson(c).pages[0].lines[0].en).toBe('One');
    closeChapter();
  });
});

describe('a save whose chapter moved under it', () => {
  it('abandons the write when the chapter is closed while the read is in flight', async () => {
    const { c } = await seedOpenChapter();
    app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    const before = fsx._tree.files.get(`${c.dir}/chapter.json`);
    const orig = fsx.readTextFile;
    fsx.readTextFile = async (path) => {
      const out = await orig(path);
      // The user leaves the editor while this save's read is still in flight.
      if (path === `${c.dir}/chapter.json`) closeChapter();
      return out;
    };
    try {
      await saveOpenChapter();
    } finally {
      fsx.readTextFile = orig;
    }
    expect(fsx._tree.files.get(`${c.dir}/chapter.json`)).toBe(before);
    expect(c.pageCount).toBe(2);
  });
});

describe('a failed save is visible', () => {
  it('toasts when the debounced autosave cannot write', async () => {
    await seedOpenChapter();
    const orig = fsx.writeTextFile;
    fsx.writeTextFile = async () => {
      throw new Error('disk full');
    };
    vi.useFakeTimers();
    try {
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      markUnsaved();
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
      fsx.writeTextFile = orig;
    }
    expect(app.saved).toBe(false);
    expect(app.toast.msg).toMatch(/Could not save/);
    closeChapter();
  });

  it('keeps the user in the editor when the leave-save fails', async () => {
    const { p, c } = await seedOpenChapter();
    resetRoute();
    await goEditor(p.id, c.id);
    app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    const orig = fsx.writeTextFile;
    fsx.writeTextFile = async () => {
      throw new Error('disk full');
    };
    let moved;
    try {
      moved = await goLibrary();
    } finally {
      fsx.writeTextFile = orig;
    }
    expect(moved).toBe(false);
    expect(route.name).toBe('editor');
    expect(app.chapterRef).not.toBeNull();
    expect(app.pages[0].lines).toHaveLength(1); // the work is still on screen
    expect(app.toast.msg).toMatch(/staying in the editor/);
    resetRoute();
    closeChapter();
  });

  // A disk that will never write must not be able to pin the user in the editor
  // — or, via the same guard on the window, inside a window that will not close.
  describe('the second-attempt escape', () => {
    // Swap in a filesystem that cannot write, for the duration of `fn`.
    async function withBrokenDisk(fn) {
      const orig = fsx.writeTextFile;
      fsx.writeTextFile = async () => {
        throw new Error('disk full');
      };
      try {
        return await fn();
      } finally {
        fsx.writeTextFile = orig;
      }
    }

    it('lets the user out of the editor on a second consecutive failure', async () => {
      const { p, c } = await seedOpenChapter();
      resetRoute();
      await goEditor(p.id, c.id);
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];

      const [first, second] = await withBrokenDisk(async () => {
        const a = await goLibrary();
        const firstMsg = app.toast.msg;
        const b = await goLibrary();
        return [
          { moved: a, msg: firstMsg },
          { moved: b, msg: app.toast.msg },
        ];
      });

      expect(first.moved).toBe(false);
      expect(first.msg).toMatch(/ask to leave again/i);
      expect(second.moved).toBe(true);
      expect(route.name).toBe('library');
      expect(app.chapterRef).toBeNull();
      // The message names the cost rather than repeating the error.
      expect(second.msg).toMatch(/never written to disk/i);
      // Nothing reached the file — which is exactly what the user was told.
      expect(chapterJson(c).pages[0].lines).toHaveLength(0);
      resetRoute();
    });

    it('starts the two-step over once a save works again', async () => {
      const { p, c } = await seedOpenChapter();
      resetRoute();
      await goEditor(p.id, c.id);
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];

      // One failure banks an escape...
      expect(await withBrokenDisk(() => goLibrary())).toBe(false);
      // ...but a save that lands spends it, so the next failure refuses again
      // rather than walking out on work the user never agreed to lose.
      await saveOpenChapter();
      expect(await withBrokenDisk(() => goLibrary())).toBe(false);
      expect(route.name).toBe('editor');
      expect(app.toast.msg).toMatch(/staying in the editor/);

      resetRoute();
      closeChapter();
    });

    it('refuses the first quit and releases the second, in quit wording', async () => {
      await seedOpenChapter();
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];

      const first = await withBrokenDisk(() => flushBeforeLeaving('quit'));
      expect(first).toBe(false);
      expect(app.toast.msg).toMatch(/not quitting/);
      expect(app.toast.msg).toMatch(/ask to quit again/i);

      const second = await withBrokenDisk(() => flushBeforeLeaving('quit'));
      expect(second).toBe(true);
      expect(app.toast.msg).toMatch(/never written to disk/i);
      // The chapter is still open: quitting is the caller's job, not the guard's.
      expect(app.chapterRef).not.toBeNull();
      closeChapter();
    });

    it('counts the streak across both ways out, not per button', async () => {
      // One refused quit, then one attempt to leave the editor: the escape is
      // about a disk that keeps failing, not about which button was pressed.
      await seedOpenChapter();
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      expect(await withBrokenDisk(() => flushBeforeLeaving('quit'))).toBe(false);
      expect(await withBrokenDisk(() => flushBeforeLeaving('editor'))).toBe(true);
      closeChapter();
    });

    it('closing the chapter clears the streak', async () => {
      await seedOpenChapter();
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      expect(await withBrokenDisk(() => flushBeforeLeaving('quit'))).toBe(false);
      closeChapter();

      await seedOpenChapter();
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      // A fresh chapter must get its own first refusal, not inherit one.
      expect(await withBrokenDisk(() => flushBeforeLeaving('quit'))).toBe(false);
      closeChapter();
      resetSaveFailures();
    });
  });

  it('leaves the editor normally when the save succeeds', async () => {
    const { p, c } = await seedOpenChapter();
    resetRoute();
    await goEditor(p.id, c.id);
    app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    const moved = await goLibrary();
    expect(moved).toBe(true);
    expect(route.name).toBe('library');
    expect(app.chapterRef).toBeNull();
    expect(chapterJson(c).pages[0].lines).toHaveLength(1);
    resetRoute();
  });
});

describe('the stand-in page', () => {
  it('is frozen, so an accidental write throws instead of polluting it', () => {
    closeChapter();
    const p = page();
    expect(Object.isFrozen(p)).toBe(true);
    expect(() => {
      p.w = 5;
    }).toThrow();
    expect(() => p.boxes.push({ id: 'x' })).toThrow();
    expect(page().boxes).toHaveLength(0);
  });
});

describe('autosave debounce', () => {
  function countChapterWrites(c) {
    const orig = fsx.writeTextFile;
    const state = { n: 0, restore: () => (fsx.writeTextFile = orig) };
    fsx.writeTextFile = async (path, contents) => {
      if (path === `${c.dir}/chapter.json`) state.n++;
      return orig(path, contents);
    };
    return state;
  }

  it('writes the open chapter once the debounce elapses', async () => {
    const { c } = await seedOpenChapter();
    const writes = countChapterWrites(c);
    vi.useFakeTimers();
    try {
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      markUnsaved();
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
      writes.restore();
    }
    expect(writes.n).toBe(1);
    expect(chapterJson(c).pages[0].lines).toHaveLength(1);
    closeChapter();
  });

  it('does not write after the chapter has been closed', async () => {
    const { c } = await seedOpenChapter();
    const writes = countChapterWrites(c);
    vi.useFakeTimers();
    try {
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      markUnsaved();
      closeChapter();
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
      writes.restore();
    }
    expect(writes.n).toBe(0);
    expect(chapterJson(c).pages[0].lines).toEqual([]);
  });

  it('does not write into the chapter opened next', async () => {
    const { p, c } = await seedOpenChapter();
    const second = await createChapter({
      projectId: p.id,
      number: 2,
      title: '',
      files: [fakeFile('a.png', 3)],
    });
    const writes = countChapterWrites(second);
    vi.useFakeTimers();
    try {
      app.pages[0].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
      markUnsaved();
      closeChapter();
      await openChapter(p.id, second.id);
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
      writes.restore();
    }
    expect(writes.n).toBe(0);
    expect(chapterJson(second).pages[0].lines).toEqual([]);
    expect(chapterJson(c).pages[0].lines).toEqual([]);
    closeChapter();
  });
});
