import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./fsx.js', () => {
  const tree = { dirs: new Set(), files: new Map() };
  // A write into a directory that does not exist fails, the way the real one
  // does. Without this, deleting an mkdir anywhere in the library would not
  // break a single test. Kept off the object: tests swap these methods for
  // arrows that call the original unbound.
  const requireParent = (p) => {
    const parent = p.slice(0, p.lastIndexOf('/'));
    if (parent && !tree.dirs.has(parent)) throw new Error('ENOENT ' + parent);
  };
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
        requireParent(p);
        tree.files.set(p, c);
      },
      // Modelled by its contract, not its mechanics: the target ends up holding
      // either the previous contents or the new ones. It routes through this
      // object's own writeTextFile so a test that swaps in a disk which cannot
      // write still breaks the writes it means to break. The real temp-file and
      // rename dance is fsx's own and is tested in fsx.test.js.
      async writeTextFileAtomic(p, c) {
        return this.writeTextFile(p, c);
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
      // `{ recursive: true }` on a directory, and an ordinary unlink when the
      // path is a file — removing a single cleaned page is the latter.
      async remove(p) {
        for (const d of [...tree.dirs]) if (d === p || d.startsWith(p + '/')) tree.dirs.delete(d);
        for (const f of [...tree.files.keys()]) if (f === p || f.startsWith(p + '/')) tree.files.delete(f);
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
        requireParent(p);
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
const {
  readChapterSources,
  replaceCleanedPages,
  setPageCleaned,
  clearPageCleaned,
  removeAllCleaned,
  applyTranslations,
} = await import('./library.svelte.js');
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

  it('writes back the ids it had to repair instead of reminting them every session', async () => {
    const { p, c } = await seedOpenChapter();
    closeChapter();
    // What the PSD importer wrote before it numbered ids across the document:
    // page two answers to the same ids as page one. The loader repairs that on
    // the way in, but the repair is only worth anything if it reaches the file —
    // otherwise which id a box gets depends on how many chapters were opened
    // first, and it changes every session.
    const record = chapterJson(c);
    const dupe = (id) => ({ id, lineN: null, text: 'x', x: 0, y: 0, w: 10, h: 10, style: {} });
    record.pages[0].boxes = [dupe('b1'), dupe('b2')];
    record.pages[1].boxes = [dupe('b1')];
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));

    await openChapter(p.id, c.id);
    const ids = app.pages.flatMap((pg) => pg.boxes.map((b) => b.id));
    expect(new Set(ids).size).toBe(3);
    // A repair is unsaved work. An open that changed nothing still comes up
    // saved — that case is covered above.
    expect(app.saved).toBe(false);
    await saveOpenChapter();
    expect(chapterJson(c).pages.flatMap((pg) => pg.boxes.map((b) => b.id))).toEqual(ids);
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

// Cleaned pages pair with raws by position after the natural sort, which is the
// only rule that imposes no naming convention — and the reason every count
// mismatch has to be stated rather than absorbed.
describe('cleaned pages at creation', () => {
  const line = (n, en) => ({ n, type: 'dialogue', jp: 'あ', en });
  const parsed = (...ens) => ens.map((en) => ({ lines: [line(1, en)] }));

  async function chapterWith(files, cleanedFiles, translations = null) {
    const p = await createProject('Series');
    const c = await createChapter({ projectId: p.id, number: 1, title: '', files, cleanedFiles, translations });
    return { p, c, record: chapterJson(c) };
  }

  it('pairs the Nth cleaned file with the Nth page', async () => {
    const { record } = await chapterWith(
      [fakeFile('p10.png', 10), fakeFile('p2.png', 2)],
      [fakeFile('c10.png', 110), fakeFile('c2.png', 102)],
    );
    // Both lists take the same natural sort, so page 1 is p2/c2.
    expect(record.pages.map((pg) => [pg.file, pg.cleaned])).toEqual([
      ['p2.png', 'c2.png'],
      ['p10.png', 'c10.png'],
    ]);
  });

  it('leaves the pages a short cleaned list does not reach on their raw', async () => {
    const { record } = await chapterWith(
      [fakeFile('a.png', 1), fakeFile('b.png', 2), fakeFile('c.png', 3)],
      [fakeFile('x.png', 9)],
    );
    expect(record.pages.map((pg) => pg.cleaned)).toEqual(['x.png', null, null]);
  });

  it('ignores cleaned files past the end rather than inventing pages for them', async () => {
    const { c, record } = await chapterWith(
      [fakeFile('a.png', 1)],
      [fakeFile('x.png', 9), fakeFile('y.png', 8)],
    );
    expect(record.pages).toHaveLength(1);
    // The extra was never copied — a file with no page is a file nothing can
    // ever remove.
    expect(fsx._tree.files.has(`${c.dir}/cleaned/y.png`)).toBe(false);
  });

  it('creates no cleaned/ directory when no cleaned pages were picked', async () => {
    const { c, record } = await chapterWith([fakeFile('a.png', 1)], []);
    expect(record.pages[0].cleaned).toBeNull();
    expect(fsx._tree.dirs.has(`${c.dir}/cleaned`)).toBe(false);
  });

  it('dedups raws and cleaned pages independently, so one name can be both', async () => {
    const { c, record } = await chapterWith(
      [fakeFile('01.png', 1), fakeFile('01.png', 2)],
      [fakeFile('01.png', 3), fakeFile('01.png', 4)],
    );
    expect(record.pages.map((pg) => pg.file)).toEqual(['01.png', '01-2.png']);
    expect(record.pages.map((pg) => pg.cleaned)).toEqual(['01.png', '01-2.png']);
    // Same name, different directory, different bytes — neither overwrote the other.
    expect(fsx._tree.files.get(`${c.dir}/raws/01.png`)).toEqual(new Uint8Array([1]));
    expect(fsx._tree.files.get(`${c.dir}/cleaned/01.png`)).toEqual(new Uint8Array([3]));
  });

  it('copies the cleaned pages byte for byte', async () => {
    const { c } = await chapterWith([fakeFile('a.png', 1)], [fakeFile('x.png', 77)]);
    expect(fsx._tree.files.get(`${c.dir}/cleaned/x.png`)).toEqual(new Uint8Array([77]));
  });

  it('applies the translations it was given, and ignores the pages past the end', async () => {
    const { record } = await chapterWith(
      [fakeFile('a.png', 1), fakeFile('b.png', 2)],
      [],
      parsed('One', 'Two', 'Three'),
    );
    expect(record.pages.map((pg) => pg.lines[0]?.en)).toEqual(['One', 'Two']);
  });

  it('removes the whole chapter when a cleaned copy fails', async () => {
    const p = await createProject('Series');
    const broken = { name: 'bad.png', arrayBuffer: async () => { throw new Error('read failed'); } };
    await expect(
      createChapter({
        projectId: p.id,
        number: 1,
        title: '',
        files: [fakeFile('a.png', 1)],
        cleanedFiles: [broken],
      }),
    ).rejects.toThrow();
    // Not a chapter with raws and no cleaned pages — no chapter at all.
    expect(fsx._tree.dirs.has(`${p.dir}/001`)).toBe(false);
    expect(fsx._tree.files.has(`${p.dir}/001/raws/a.png`)).toBe(false);
    expect(projectById(p.id).chapters).toHaveLength(0);
  });
});

describe('cleaned pages survive the round trip', () => {
  async function seedCleanedChapter() {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1), fakeFile('b.png', 2)],
      cleanedFiles: [fakeFile('x.png', 9)],
    });
    return { p, c };
  }

  it('reopens with each page on the image it was typeset on', async () => {
    const { p, c } = await seedCleanedChapter();
    await openChapter(p.id, c.id);
    expect(app.pages.map((pg) => pg.cleanedFile)).toEqual(['x.png', null]);
    expect(String(app.pages[0].cleaned).startsWith('blob:')).toBe(true);
    expect(app.pages[1].cleaned).toBeNull();
    // Editing anything must not cost the page its cleaned image.
    app.pages[1].lines = [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }];
    await saveOpenChapter();
    expect(chapterJson(c).pages.map((pg) => pg.cleaned)).toEqual(['x.png', null]);
    closeChapter();
  });

  it('keeps the cleaned name when the file itself is gone', async () => {
    const { p, c } = await seedCleanedChapter();
    fsx._tree.files.delete(`${c.dir}/cleaned/x.png`);
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
    // Falls back to the raw for rendering, but the reference survives — a save
    // that dropped it would unlink a file the user only has to put back.
    expect(app.pages[0].cleaned).toBeNull();
    expect(app.pages[0].cleanedFile).toBe('x.png');
    await saveOpenChapter();
    expect(chapterJson(c).pages[0].cleaned).toBe('x.png');
    closeChapter();
  });

  it('opens a slice 1 chapter with no cleaned key, and gains one on save', async () => {
    const p = await createProject('Series');
    const c = await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    // Exactly what slice 1 wrote: a page record with no `cleaned` at all.
    const record = chapterJson(c);
    delete record.pages[0].cleaned;
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));
    await openChapter(p.id, c.id);
    expect(app.pages[0].cleanedFile).toBeNull();
    expect(app.pages[0].file).toBe('a.png');
    await saveOpenChapter();
    expect(chapterJson(c).pages[0]).toHaveProperty('cleaned', null);
    closeChapter();
  });
});

describe('the chapter sources sheet', () => {
  const line = (n, en) => ({ n, type: 'dialogue', jp: 'あ', en });
  const parsed = (...ens) => ens.map((en) => ({ lines: [line(1, en)] }));

  async function seedThree(cleanedFiles = []) {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 1,
      title: '',
      files: [fakeFile('a.png', 1), fakeFile('b.png', 2), fakeFile('c.png', 3)],
      cleanedFiles,
    });
    return { p, c };
  }

  it('reports which cleaned files are actually on disk', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9), fakeFile('y.png', 8)]);
    fsx._tree.files.delete(`${c.dir}/cleaned/y.png`);
    const { pages } = await readChapterSources(p.id, c.id);
    expect(pages.map((pg) => pg.missing)).toEqual([false, true, false]);
  });

  it('replaces a subset in bulk and leaves the later pages alone', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9), fakeFile('y.png', 8), fakeFile('z.png', 7)]);
    const out = await replaceCleanedPages(p.id, c.id, [fakeFile('new.png', 20)]);
    expect(out).toEqual({ replaced: 1, ignored: 0 });
    expect(chapterJson(c).pages.map((pg) => pg.cleaned)).toEqual(['new.png', 'y.png', 'z.png']);
    // The image it replaced is gone, and the ones it did not touch are not.
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(false);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/z.png`)).toBe(true);
  });

  it('ignores bulk files past the last page', async () => {
    const { p, c } = await seedThree();
    const out = await replaceCleanedPages(p.id, c.id, [
      fakeFile('1.png', 1),
      fakeFile('2.png', 2),
      fakeFile('3.png', 3),
      fakeFile('4.png', 4),
    ]);
    expect(out).toEqual({ replaced: 3, ignored: 1 });
    expect(fsx._tree.files.has(`${c.dir}/cleaned/4.png`)).toBe(false);
  });

  it('keeps the pages it managed to replace when a copy fails part-way', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9), fakeFile('y.png', 8), fakeFile('z.png', 7)]);
    // Named so the natural sort puts the unreadable one second — this order is
    // the whole point of the case.
    const broken = { name: '2-bad.png', arrayBuffer: async () => { throw new Error('read failed') } };
    await expect(
      replaceCleanedPages(p.id, c.id, [fakeFile('1-new.png', 20), broken, fakeFile('3-later.png', 21)]),
    ).rejects.toThrow(/page 2/);
    // Page 1 keeps its new image; the rest keep theirs. No half-restored state,
    // and nothing points at a file that is not there.
    expect(chapterJson(c).pages.map((pg) => pg.cleaned)).toEqual(['1-new.png', 'y.png', 'z.png']);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/1-new.png`)).toBe(true);
  });

  it('leaves the record untouched and clears up after itself when the write fails', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    const before = fsx._tree.files.get(`${c.dir}/chapter.json`);
    const orig = fsx.writeTextFileAtomic;
    fsx.writeTextFileAtomic = async () => {
      throw new Error('disk full');
    };
    try {
      await expect(replaceCleanedPages(p.id, c.id, [fakeFile('new.png', 20)])).rejects.toThrow(
        /disk full/,
      );
    } finally {
      fsx.writeTextFileAtomic = orig;
    }
    // The record still says what it said, the image it named is still there,
    // and the copy nothing ever pointed at is gone.
    expect(fsx._tree.files.get(`${c.dir}/chapter.json`)).toBe(before);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(true);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/new.png`)).toBe(false);
  });

  it('never hands a new copy a name a page still claims, even a missing one', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9), fakeFile('y.png', 8)]);
    // Page 1's image has gone missing from disk — one of the states this sheet
    // exists to repair — while the record still names it.
    fsx._tree.files.delete(`${c.dir}/cleaned/x.png`);
    await replaceCleanedPages(p.id, c.id, [fakeFile('x.png', 30)]);
    const cleaned = chapterJson(c).pages.map((pg) => pg.cleaned);
    // Page 1 gets its own file. If the free name had been chosen from the disk
    // alone it would have been `x.png` again — and page 1 would then be sharing
    // one image with whatever else still claimed that name.
    expect(cleaned[0]).not.toBe('x.png');
    expect(new Set(cleaned.filter(Boolean)).size).toBe(cleaned.filter(Boolean).length);
    expect(fsx._tree.files.get(`${c.dir}/cleaned/${cleaned[0]}`)).toEqual(new Uint8Array([30]));
  });

  it('keeps a file two pages point at until the last of them lets go', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    // A record can name one file from two pages — a hand edit, or a chapter
    // folder copied and re-pointed. Unlinking on the first release would leave
    // the second page pointing at nothing.
    const record = chapterJson(c);
    record.pages[1].cleaned = 'x.png';
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));
    await clearPageCleaned(p.id, c.id, record.pages[0].id);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(true);
    await clearPageCleaned(p.id, c.id, record.pages[1].id);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(false);
  });

  it('refuses to aim a delete outside the chapter, whatever the record says', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    // chapter.json is an ordinary file: a hand edit or a foreign tool can put
    // a path in a name field, and fsx.remove is recursive.
    const record = chapterJson(c);
    record.pages[0].cleaned = '../raws';
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));
    await clearPageCleaned(p.id, c.id, record.pages[0].id);
    expect(chapterJson(c).pages[0].cleaned).toBeNull();
    // The raws are still there. The name was left alone rather than resolved.
    expect(fsx._tree.files.get(`${c.dir}/raws/a.png`)).toEqual(new Uint8Array([1]));
  });

  it('sets one page by its id, not its position', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    const id = chapterJson(c).pages[2].id;
    const name = await setPageCleaned(p.id, c.id, id, fakeFile('third.png', 30));
    expect(name).toBe('third.png');
    expect(chapterJson(c).pages.map((pg) => pg.cleaned)).toEqual(['x.png', null, 'third.png']);
  });

  it('deletes the image a per-page set replaced', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    const id = chapterJson(c).pages[0].id;
    const name = await setPageCleaned(p.id, c.id, id, fakeFile('x.png', 30));
    // Same name as the one already there, so it lands beside it and the old one
    // goes — never overwritten in place.
    expect(name).toBe('x-2.png');
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(false);
    expect(fsx._tree.files.get(`${c.dir}/cleaned/x-2.png`)).toEqual(new Uint8Array([30]));
  });

  it('unlinks one page without touching the others', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9), fakeFile('y.png', 8)]);
    await clearPageCleaned(p.id, c.id, chapterJson(c).pages[0].id);
    expect(chapterJson(c).pages.map((pg) => pg.cleaned)).toEqual([null, 'y.png', null]);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(false);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/y.png`)).toBe(true);
  });

  it('removes every cleaned page and leaves the raws alone', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9), fakeFile('y.png', 8)]);
    expect(await removeAllCleaned(p.id, c.id)).toBe(2);
    expect(chapterJson(c).pages.every((pg) => pg.cleaned === null)).toBe(true);
    expect(fsx._tree.files.has(`${c.dir}/cleaned/x.png`)).toBe(false);
    expect(fsx._tree.files.get(`${c.dir}/raws/a.png`)).toEqual(new Uint8Array([1]));
  });

  it('refuses every edit while the chapter is open in the editor', async () => {
    const { p, c } = await seedThree([fakeFile('x.png', 9)]);
    const pageId = chapterJson(c).pages[0].id;
    await openChapter(p.id, c.id);
    try {
      await expect(replaceCleanedPages(p.id, c.id, [fakeFile('n.png', 1)])).rejects.toThrow(/open/);
      await expect(setPageCleaned(p.id, c.id, pageId, fakeFile('n.png', 1))).rejects.toThrow(/open/);
      await expect(clearPageCleaned(p.id, c.id, pageId)).rejects.toThrow(/open/);
      await expect(removeAllCleaned(p.id, c.id)).rejects.toThrow(/open/);
      await expect(applyTranslations(p.id, c.id, parsed('One'))).rejects.toThrow(/open/);
      await expect(readChapterSources(p.id, c.id)).rejects.toThrow(/open/);
      // And nothing got as far as the disk.
      expect(chapterJson(c).pages.map((pg) => pg.cleaned)).toEqual(['x.png', null, null]);
    } finally {
      closeChapter();
    }
  });

  // A translations file says what is on pages 1..N. It says nothing about
  // whether the chapter has pages after that, so it never shortens one — the
  // bug that deleted a chapter's trailing pages and every box on them.
  it('applies lines without shortening or extending the chapter', async () => {
    const { p, c } = await seedThree();
    const before = chapterJson(c);
    before.pages[2].boxes = [{ id: 'b1', lineN: 1, text: 'End', x: 1, y: 2, w: 3, h: 4, style: {} }];
    before.pages[2].lines = [line(1, 'End')];
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(before));

    const out = await applyTranslations(p.id, c.id, parsed('One', 'Two'));
    expect(out).toEqual({ covered: 2, kept: 1, ignored: 0, lines: 2, orphaned: 0 });
    const after = chapterJson(c);
    expect(after.pages).toHaveLength(3);
    expect(after.pages.map((pg) => pg.lines[0].en)).toEqual(['One', 'Two', 'End']);
    expect(after.pages[2].boxes).toHaveLength(1);
    expect(after.pages.map((pg) => pg.file)).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('counts the placed boxes a renumbered file leaves with nothing to say', async () => {
    const { p, c } = await seedThree();
    const record = chapterJson(c);
    record.pages[0].lines = [line(1, 'Old')];
    // Line-backed: it renders whatever line 1 says. Free-typed boxes carry
    // their own text and are unaffected, so only the first is counted.
    record.pages[0].boxes = [
      { id: 'b1', lineN: 1, text: null, x: 0, y: 0, w: 1, h: 1, style: {} },
      { id: 'b2', lineN: null, text: 'mine', x: 0, y: 0, w: 1, h: 1, style: {} },
    ];
    fsx._tree.files.set(`${c.dir}/chapter.json`, JSON.stringify(record));

    const out = await applyTranslations(p.id, c.id, [{ lines: [line(7, 'New')] }]);
    expect(out.orphaned).toBe(1);
    // Nothing was deleted — the boxes are all still there to be re-pointed.
    expect(chapterJson(c).pages[0].boxes).toHaveLength(2);
  });

  it('never appends the pages a longer file describes', async () => {
    const { p, c } = await seedThree();
    const out = await applyTranslations(p.id, c.id, parsed('1', '2', '3', '4', '5'));
    expect(out.ignored).toBe(2);
    // No page arrives with file:'' — unrenderable, and impossible to get rid of.
    expect(chapterJson(c).pages.map((pg) => pg.file)).toEqual(['a.png', 'b.png', 'c.png']);
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

// The two ends of the wiring, against the same fake disk the chapter uses: the
// chapter's own directory is where its undo history lives, and putting the
// chapter away is what gets the live page's stack into it.
const { record, history, resetHistory } = await import('./editor/history.svelte.js');

describe('the undo history follows the chapter', () => {
  const historyJson = (c) => JSON.parse(fsx._tree.files.get(`${c.dir}/logs/history.json`));
  const aMove = (pageId) => ({
    t: 'move',
    pageId,
    boxId: 'b1',
    before: { x: 0, y: 0 },
    after: { x: 9, y: 9 },
  });
  // `openChapter` starts the history deliberately without awaiting it, so a
  // test has to let the microtasks it queued run before asking what it did.
  const settled = () => new Promise((r) => setTimeout(r, 0));

  it('writes the live page stack into the chapter it belongs to, on close', async () => {
    const { c } = await seedOpenChapter();
    await settled();
    const pid = app.pages[0].id;
    record(aMove(pid));
    closeChapter();
    await settled();
    expect(historyJson(c).pages[String(pid)].undo).toHaveLength(1);
    expect(history.canUndo).toBe(false); // and the live stack went with it
  });

  it('brings that stack back when the chapter is opened again', async () => {
    const { p, c } = await seedOpenChapter();
    await settled();
    record(aMove(app.pages[0].id));
    closeChapter();
    await settled();
    resetHistory();
    await openChapter(p.id, c.id);
    await settled();
    expect(history.canUndo).toBe(true);
    closeChapter();
    await settled();
  });

  it('flushes the records on the way out of the app, alongside the document', async () => {
    const { c } = await seedOpenChapter();
    await settled();
    const pid = app.pages[0].id;
    record(aMove(pid));
    // The quit path: the window is destroyed the moment this resolves, so
    // anything still on the history's debounce has to have landed by then.
    expect(await flushBeforeLeaving('quit')).toBe(true);
    expect(historyJson(c).pages[String(pid)].undo).toHaveLength(1);
    closeChapter();
    await settled();
  });

  // The history module reports and swallows every failure, so the one thing
  // left that can go wrong in it is a call that never comes back — a volume
  // that has gone away, a wedged mount. The close-request path is single-flight,
  // so a window held open by that could not even be retried.
  it('does not let a history write that never returns pin the window open', async () => {
    await seedOpenChapter();
    await settled();
    record(aMove(app.pages[0].id));
    let release;
    const wedged = new Promise((r) => (release = r));
    const orig = fsx.writeTextFileAtomic;
    fsx.writeTextFileAtomic = function (path, body) {
      return path.endsWith('/logs/history.json')
        ? wedged.then(() => orig.call(this, path, body))
        : orig.call(this, path, body);
    };
    vi.useFakeTimers();
    try {
      const leaving = flushBeforeLeaving('quit');
      await vi.advanceTimersByTimeAsync(3000);
      expect(await leaving).toBe(true);
    } finally {
      vi.useRealTimers();
      // Let the wedged write through on the way out: the queue it sits in is
      // module-global, and a case that left it stuck would take the next one
      // with it.
      release();
      await settled();
      fsx.writeTextFileAtomic = orig;
    }
    closeChapter();
    await settled();
  });
});
