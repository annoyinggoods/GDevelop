// @flow
import { createNewResource } from '../../ResourcesList/ResourceSource';
import optionalRequire from '../../Utils/OptionalRequire';
import {
  getByokResourceTools,
  importByokProjectResources,
  inferByokResourceKind,
  type ByokResourceImportDeps,
} from './ByokResourceTools';

const path = (optionalRequire('path'): any);

const gd: libGDevelop = global.gd;

const PROJECT_FILE = path.resolve('/projects/game/game.json');
const PROJECT_FOLDER = path.dirname(PROJECT_FILE);

/** An in-memory fs: existsSync/copyFile over a Set of existing paths. */
const makeFakeFs = (existingPaths: Array<string> = []) => {
  const existing = new Set(
    existingPaths.map(filePath => path.resolve(filePath))
  );
  const copies: Array<{| from: string, to: string |}> = [];
  return {
    existsSync: (filePath: string) => existing.has(path.resolve(filePath)),
    copyFile: async (from: string, to: string) => {
      copies.push({ from: path.resolve(from), to: path.resolve(to) });
      existing.add(path.resolve(to));
    },
    copies,
  };
};

const makeDeps = (
  fs: any
): {|
  deps: ByokResourceImportDeps,
  downloads: Array<{| url: string, to: string |}>,
|} => {
  const downloads = [];
  return {
    deps: {
      fs,
      pathLib: path,
      downloadFile: async (url, to) => {
        downloads.push({ url, to });
      },
    },
    downloads,
  };
};

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setProjectFile(PROJECT_FILE);
  return project;
};

const getTool = () =>
  getByokResourceTools().find(tool => tool.name === 'import_project_resources');

describe('ByokResourceTools', () => {
  let project: gdProject;

  beforeEach(() => {
    project = makeProject();
  });

  afterEach(() => {
    project.delete();
  });

  describe('inferByokResourceKind', () => {
    it('prefers an explicit valid kind', () => {
      expect(inferByokResourceKind({ source: 'x.wav', kind: 'image' })).toBe(
        'image'
      );
    });

    it('infers from the file extension', () => {
      expect(inferByokResourceKind({ source: 'music.ogg' })).toBe('audio');
      expect(inferByokResourceKind({ source: 'pic.PNG' })).toBe('image');
      expect(inferByokResourceKind({ source: 'font.ttf' })).toBe('font');
    });

    it('returns null when nothing matches', () => {
      expect(inferByokResourceKind({ source: 'thing.zzz' })).toBeNull();
      expect(
        inferByokResourceKind({ source: 'thing.zzz', kind: 'no-such-kind' })
      ).toBeNull();
    });
  });

  describe('importByokProjectResources', () => {
    it('registers a project-relative source in place', async () => {
      const { deps } = makeDeps(
        makeFakeFs([path.join(PROJECT_FOLDER, 'hero.png')])
      );

      const results = await importByokProjectResources({
        project,
        entries: [{ source: 'hero.png' }],
        replaceExisting: false,
        deps,
      });

      expect(results).toEqual([
        {
          source: 'hero.png',
          name: 'hero.png',
          kind: 'image',
          file: 'hero.png',
          status: 'registered',
        },
      ]);
      const manager = project.getResourcesManager();
      expect(manager.hasResource('hero.png')).toBe(true);
      expect(manager.getResource('hero.png').getFile()).toBe('hero.png');
    });

    it('copies an absolute outside path into the project folder, deduped', async () => {
      const fs = makeFakeFs([
        '/downloads/pic.jpg',
        path.join(PROJECT_FOLDER, 'pic.jpg'), // an existing collision
      ]);
      const { deps } = makeDeps(fs);

      const results = await importByokProjectResources({
        project,
        entries: [{ source: '/downloads/pic.jpg' }],
        replaceExisting: false,
        deps,
      });

      expect(results[0].status).toBe('registered');
      expect(results[0].file).toBe('pic-1.jpg');
      expect(fs.copies).toEqual([
        {
          from: path.resolve('/downloads/pic.jpg'),
          to: path.join(PROJECT_FOLDER, 'pic-1.jpg'),
        },
      ]);
    });

    it('registers an absolute in-project path in place', async () => {
      const inProject = path.join(PROJECT_FOLDER, 'sounds', 'boom.wav');
      const { deps } = makeDeps(makeFakeFs([inProject]));

      const results = await importByokProjectResources({
        project,
        entries: [{ source: inProject }],
        replaceExisting: false,
        deps,
      });

      expect(results[0].status).toBe('registered');
      expect(results[0].file).toBe('sounds/boom.wav');
      expect(fs2Copies(deps)).toEqual([]);
    });

    it('downloads a URL source and registers the file', async () => {
      const { deps, downloads } = makeDeps(makeFakeFs());

      const results = await importByokProjectResources({
        project,
        entries: [{ source: 'https://example.com/assets/song%20name.mp3' }],
        replaceExisting: false,
        deps,
      });

      expect(results[0].status).toBe('registered');
      expect(results[0].name).toBe('song name.mp3');
      expect(downloads).toHaveLength(1);
      expect(downloads[0].url).toBe(
        'https://example.com/assets/song%20name.mp3'
      );
      expect(downloads[0].to.endsWith('song name.mp3')).toBe(true);
    });

    it('replaces an existing resource in place and reports its users', async () => {
      // An object that uses the resource, so the report has something to list.
      const layout = project.insertNewLayout('Scene', 0);
      const object = layout
        .getObjects()
        .insertNewObject(project, 'Sprite', 'Player', 0);
      const spriteConfiguration = gd.asSpriteConfiguration(
        object.getConfiguration()
      );
      const animation = new gd.Animation();
      animation.setDirectionsCount(1);
      const frame = new gd.Sprite();
      frame.setImageName('old-image.png');
      animation.getDirection(0).addSprite(frame);
      frame.delete();
      spriteConfiguration.getAnimations().addAnimation(animation);
      animation.delete();

      const oldResource = new gd.ImageResource();
      oldResource.setName('old-image.png');
      oldResource.setFile('old-image.png');
      project.getResourcesManager().addResource(oldResource);
      oldResource.delete();

      const { deps } = makeDeps(
        makeFakeFs([path.join(PROJECT_FOLDER, 'new-image.png')])
      );

      const results = await importByokProjectResources({
        project,
        entries: [{ source: 'new-image.png', name: 'old-image.png' }],
        replaceExisting: true,
        deps,
      });

      expect(results[0].status).toBe('replaced');
      expect(results[0].usedBy).toContain('Player');
      expect(
        project
          .getResourcesManager()
          .getResource('old-image.png')
          .getFile()
      ).toBe('new-image.png');
    });

    it('skips an existing name without replace_existing', async () => {
      const resource = new gd.ImageResource();
      resource.setName('hero.png');
      resource.setFile('hero.png');
      project.getResourcesManager().addResource(resource);
      resource.delete();
      const { deps } = makeDeps(
        makeFakeFs([path.join(PROJECT_FOLDER, 'other.png')])
      );

      const results = await importByokProjectResources({
        project,
        entries: [{ source: 'other.png', name: 'hero.png' }],
        replaceExisting: false,
        deps,
      });

      expect(results[0].status).toBe('already-exists');
      expect(
        project
          .getResourcesManager()
          .getResource('hero.png')
          .getFile()
      ).toBe('hero.png');
    });

    it('refuses a project-relative path that escapes the project folder', async () => {
      const outside = path.resolve(PROJECT_FOLDER, '..', 'steal.png');
      const { deps } = makeDeps(makeFakeFs([outside]));

      const results = await importByokProjectResources({
        project,
        entries: [{ source: '../steal.png' }],
        replaceExisting: false,
        deps,
      });

      expect(results[0].status).toBe('failed');
      expect(results[0].error).toContain('outside the project folder');
    });

    it('refuses a sibling folder whose name extends the project folder name', async () => {
      // "/projects/game2/x.png" must NOT count as inside "/projects/game"
      // (the substring check the upstream helper uses would accept it).
      const sibling = path.resolve(PROJECT_FOLDER, '..', 'game2', 'x.png');
      const { deps } = makeDeps(makeFakeFs([sibling]));

      const results = await importByokProjectResources({
        project,
        entries: [{ source: '../game2/x.png' }],
        replaceExisting: false,
        deps,
      });

      expect(results[0].status).toBe('failed');
      expect(results[0].error).toContain('outside the project folder');
    });

    it('registers the font, video and json kinds end to end', async () => {
      const fs = makeFakeFs([
        path.join(PROJECT_FOLDER, 'main.ttf'),
        path.join(PROJECT_FOLDER, 'cutscene.mp4'),
        path.join(PROJECT_FOLDER, 'levels.json'),
      ]);
      const { deps } = makeDeps(fs);

      const results = await importByokProjectResources({
        project,
        entries: [
          { source: 'main.ttf' },
          { source: 'cutscene.mp4' },
          { source: 'levels.json' },
        ],
        replaceExisting: false,
        deps,
      });

      expect(results.map(result => result.status)).toEqual([
        'registered',
        'registered',
        'registered',
      ]);
      expect(results.map(result => result.kind)).toEqual([
        'font',
        'video',
        'json',
      ]);
      const manager = project.getResourcesManager();
      expect(manager.getResource('main.ttf').getFile()).toBe('main.ttf');
      expect(manager.getResource('cutscene.mp4').getFile()).toBe(
        'cutscene.mp4'
      );
      expect(manager.getResource('levels.json').getFile()).toBe('levels.json');
      expect(fs.copies).toEqual([]);
    });

    it('fails an entry with an unknown kind and keeps going', async () => {
      const { deps } = makeDeps(
        makeFakeFs([path.join(PROJECT_FOLDER, 'ok.png')])
      );

      const results = await importByokProjectResources({
        project,
        entries: [{ source: 'weird.zzz' }, { source: 'ok.png' }],
        replaceExisting: false,
        deps,
      });

      expect(results[0].status).toBe('failed');
      expect(results[0].error).toContain('Unknown resource kind');
      expect(results[1].status).toBe('registered');
    });
  });

  describe('the tool', () => {
    it('answers with the desktop-only message outside Electron', async () => {
      const result = await getTool()?.run(
        { entries: [{ source: 'x.png' }] },
        ({ getProject: () => project }: any)
      );

      // In the test environment there is no Electron ipcRenderer, so the
      // tool takes its web-build branch.
      expect(result?.output.success).toBe(false);
      expect(result?.output.message).toContain('desktop app');
    });

    it('requires a project', async () => {
      const result = await getTool()?.run(
        { entries: [{ source: 'x.png' }] },
        ({ getProject: () => null }: any)
      );

      expect(result?.output.message).toContain('No project is open');
    });
  });
});

// The in-place registration test asserts no copy happened; this helper
// reaches the copies list through the deps object.
const fs2Copies = (deps: ByokResourceImportDeps): Array<Object> =>
  (deps.fs: any).copies || [];

describe('importByokProjectResources: URL filename safety (audit011026 B-TOOL-2)', () => {
  const runOneImport = async (source: string) => {
    const { deps, downloads } = makeDeps(makeFakeFs());
    const project = makeProject();
    await importByokProjectResources({
      project,
      entries: [{ kind: 'image', source, name: 'safe' }],
      replaceExisting: false,
      deps,
    });
    return { deps, downloads };
  };

  it('rejects an encoded-separator traversal in the URL filename', async () => {
    const { deps, downloads } = await runOneImport(
      'https://host.example/a/..%2F..%2Fevil.png'
    );
    // Decoding happens BEFORE basename, so the traversal segments are
    // sanitized away: the target file lands directly in the project
    // folder, never in a parent of it.
    expect(downloads).toHaveLength(1);
    expect(deps.pathLib.basename(downloads[0].to)).toBe('evil.png');
    expect(deps.pathLib.dirname(downloads[0].to)).toBe(
      deps.pathLib.resolve(PROJECT_FOLDER)
    );
  });

  it('rejects an encoded-backslash traversal (Windows form)', async () => {
    const { deps, downloads } = await runOneImport(
      'https://host.example/img%5C..%5C..%5Cevil.png'
    );
    expect(downloads).toHaveLength(1);
    expect(deps.pathLib.basename(downloads[0].to)).toBe('evil.png');
    expect(deps.pathLib.dirname(downloads[0].to).endsWith('..')).toBe(false);
  });

  it('keeps a plain URL filename untouched', async () => {
    const { deps, downloads } = await runOneImport(
      'https://host.example/sprites/player%20idle.png'
    );
    expect(deps.pathLib.basename(downloads[0].to)).toBe('player idle.png');
  });
});

describe('importByokProjectResources: replace kind check (audit011026 B-TOOL-9)', () => {
  it('refuses replacing a resource with a different kind', async () => {
    const project = makeProject();
    try {
      const manager = project.getResourcesManager();
      const image = createNewResource('image');
      if (!image) throw new Error('the image resource could not be created');
      image.setName('hero');
      image.setFile('hero.png');
      manager.addResource(image);
      image.delete();
      const { deps } = makeDeps(
        makeFakeFs([path.join(PROJECT_FOLDER, 'hero.wav')])
      );

      const results = await importByokProjectResources({
        project,
        entries: [
          {
            kind: 'audio',
            source: path.join(PROJECT_FOLDER, 'hero.wav'),
            name: 'hero',
          },
        ],
        replaceExisting: true,
        deps,
      });

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
      expect(results[0].error || '').toContain('kind');
    } finally {
      project.delete();
    }
  });
});

describe('ByokResourceTools: a failed download is never a success', () => {
  // The production dep resolves the main-process {ok:false} result; the
  // renderer wrapper converts it to a rejection so resolveEntryToFile's
  // catch reports the failure instead of registering a resource pointing
  // at a file that was never written (audit 2026-10-02 ELEC-15).
  it('reports the entry as failed when downloadFile rejects', async () => {
    const { deps } = makeDeps(makeFakeFs());
    deps.downloadFile = async () => {
      throw new Error('The download failed: HTTP 404.');
    };
    const project = makeProject();

    const results = await importByokProjectResources({
      project,
      entries: [{ source: 'https://example.com/missing.png' }],
      replaceExisting: false,
      deps,
    });

    expect(results[0].status).toBe('failed');
    expect(results[0].error).toContain('404');
    // Nothing was registered: the project's resource list is untouched.
    expect(project.getResourcesManager().hasResource('missing.png')).toBe(
      false
    );
  });

  it('registers the resource when the download succeeds', async () => {
    const { deps } = makeDeps(makeFakeFs());
    const project = makeProject();

    const results = await importByokProjectResources({
      project,
      entries: [{ source: 'https://example.com/present.png' }],
      replaceExisting: false,
      deps,
    });

    expect(results[0].status).toBe('registered');
    expect(results[0].name).toBe('present.png');
  });
});

describe('ByokResourceTools: Windows-hostile file names (ELEC-18)', () => {
  // The model chooses the resource name through the URL. These shapes pass
  // a plain basename check but are not writable names on Windows: a colon
  // creates an NTFS Alternate Data Stream, and CON/nul/com1 are device
  // names. Each case gets its own project because sanitizing can collapse
  // several of them onto the same fallback name.
  const hostileSources = [
    'https://example.com/hero.png:secret',
    'https://example.com/CON.png',
    'https://example.com/nul.png',
    'https://example.com/com1.json',
    'https://example.com/lpt9.txt',
  ];

  it.each(hostileSources)(
    'never writes a hostile name for %s',
    async source => {
      const { deps } = makeDeps(makeFakeFs());
      const project = makeProject();
      const results = await importByokProjectResources({
        project,
        entries: [{ source, kind: 'image' }],
        replaceExisting: false,
        deps,
      });
      expect(results[0].status).toBe('registered');
      const name = results[0].name;
      expect(name).not.toContain(':');
      expect(name).not.toMatch(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|_|$)/i);
    }
  );
});
