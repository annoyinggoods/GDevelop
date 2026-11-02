// @flow
import {
  FORK_ASSET_WATCHER_ORIGIN,
  checkForkAssetRelativePath,
  getForkAssetKindForExtension,
  reconcileForkAssetResources,
} from './ForkAssetRegistration';

const gd: libGDevelop = global.gd;

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setProjectFile('C:/projects/game/game.json');
  return project;
};

const resourceNames = (project: any): Array<string> =>
  project
    .getResourcesManager()
    .getAllResourceNames()
    .toJSArray();

const addUserResource = (project: any, name: string, file: string) => {
  const resource = new gd.ImageResource();
  resource.setName(name);
  resource.setFile(file);
  project.getResourcesManager().addResource(resource);
  resource.delete();
};

describe('getForkAssetKindForExtension', () => {
  it('maps the documented extensions, case-insensitively, with a dot or not', () => {
    expect(getForkAssetKindForExtension('png')).toBe('image');
    expect(getForkAssetKindForExtension('.PNG')).toBe('image');
    expect(getForkAssetKindForExtension('svg')).toBe('image');
    expect(getForkAssetKindForExtension('opus')).toBe('audio');
    expect(getForkAssetKindForExtension('m4a')).toBe('audio');
    expect(getForkAssetKindForExtension('ttf')).toBe('font');
    expect(getForkAssetKindForExtension('json')).toBe('json');
    expect(getForkAssetKindForExtension('zzz')).toBeNull();
  });
});

describe('checkForkAssetRelativePath', () => {
  it('accepts relative forward-slash paths and normalizes backslashes', () => {
    expect(checkForkAssetRelativePath('art/enemy.png')).toEqual({
      ok: true,
      path: 'art/enemy.png',
    });
    expect(checkForkAssetRelativePath('art\\enemy.png')).toEqual({
      ok: true,
      path: 'art/enemy.png',
    });
  });

  it('refuses absolute paths, URLs, dot segments and forbidden shapes', () => {
    expect(checkForkAssetRelativePath('/etc/passwd').ok).toBe(false);
    expect(checkForkAssetRelativePath('C:/x/hero.png').ok).toBe(false);
    expect(checkForkAssetRelativePath('../outside.png').ok).toBe(false);
    expect(checkForkAssetRelativePath('art/../../outside.png').ok).toBe(false);
    expect(checkForkAssetRelativePath('https://example.com/x.png').ok).toBe(
      false
    );
    expect(checkForkAssetRelativePath('hero.png:ads').ok).toBe(false);
    expect(
      checkForkAssetRelativePath('a' + String.fromCharCode(0) + '.png').ok
    ).toBe(false);
    expect(checkForkAssetRelativePath('con.png').ok).toBe(false);
  });
});

describe('reconcileForkAssetResources', () => {
  it('registers a new file as a resource with the watcher origin', () => {
    const project = makeProject();
    try {
      const result = reconcileForkAssetResources({
        project,
        onDiskFiles: ['hero.png'],
      });

      expect(result.added).toEqual(['hero.png']);
      expect(result.didModifyProject).toBe(true);
      const resource = project.getResourcesManager().getResource('hero.png');
      expect(resource.getKind()).toBe('image');
      expect(resource.getFile()).toBe('hero.png');
      expect(resource.getOriginName()).toBe(FORK_ASSET_WATCHER_ORIGIN);
      expect(resource.getOriginIdentifier()).toBe('hero.png');
    } finally {
      project.delete();
    }
  });

  it('is idempotent: a second run over the same listing is all no-ops', () => {
    const project = makeProject();
    try {
      reconcileForkAssetResources({ project, onDiskFiles: ['hero.png'] });
      const second = reconcileForkAssetResources({
        project,
        onDiskFiles: ['hero.png'],
      });

      expect(second).toEqual({
        added: [],
        retargeted: [],
        removed: [],
        skipped: [],
        didModifyProject: false,
      });
    } finally {
      project.delete();
    }
  });

  it('retargets a watcher-origin resource whose recorded file drifted', () => {
    const project = makeProject();
    try {
      reconcileForkAssetResources({ project, onDiskFiles: ['hero.png'] });
      // Simulate a drifted file (e.g. a hand-edited project file).
      project
        .getResourcesManager()
        .getResource('hero.png')
        .setFile('old-place/hero.png');

      const result = reconcileForkAssetResources({
        project,
        onDiskFiles: ['hero.png'],
      });

      expect(result.retargeted).toEqual(['hero.png']);
      expect(result.didModifyProject).toBe(true);
      expect(
        project
          .getResourcesManager()
          .getResource('hero.png')
          .getFile()
      ).toBe('hero.png');
    } finally {
      project.delete();
    }
  });

  it('registers a moved file under its new path and drops the old resource', () => {
    const project = makeProject();
    try {
      reconcileForkAssetResources({ project, onDiskFiles: ['hero.png'] });
      const result = reconcileForkAssetResources({
        project,
        onDiskFiles: ['art/hero.png'],
        deletedFiles: ['hero.png'],
      });

      expect(result.retargeted).toEqual([]);
      expect(result.added).toEqual(['art/hero.png']);
      expect(result.removed).toEqual(['hero.png']);
    } finally {
      project.delete();
    }
  });

  it('removes only watcher-origin resources whose file is gone', () => {
    const project = makeProject();
    try {
      reconcileForkAssetResources({ project, onDiskFiles: ['watched.png'] });
      addUserResource(project, 'user.png', 'user.png');

      const result = reconcileForkAssetResources({
        project,
        onDiskFiles: [],
        deletedFiles: ['watched.png', 'user.png'],
      });

      expect(result.removed).toEqual(['watched.png']);
      expect(resourceNames(project)).toEqual(['user.png']);
    } finally {
      project.delete();
    }
  });

  it('never hijacks a user resource that already carries the name', () => {
    const project = makeProject();
    try {
      addUserResource(project, 'hero.png', 'elsewhere/hero.png');
      const result = reconcileForkAssetResources({
        project,
        onDiskFiles: ['hero.png'],
      });

      expect(result.added).toEqual([]);
      expect(result.skipped).toEqual([
        {
          path: 'hero.png',
          reason: 'A resource with this name already exists.',
        },
      ]);
      const resource = project.getResourcesManager().getResource('hero.png');
      expect(resource.getFile()).toBe('elsewhere/hero.png');
      expect(resource.getOriginName()).toBe('');
    } finally {
      project.delete();
    }
  });

  it('skips unconfined, ignored and unknown-extension files with reasons', () => {
    const project = makeProject();
    try {
      const result = reconcileForkAssetResources({
        project,
        onDiskFiles: ['../outside.png', 'notes.txt', 'hero.png'],
        ignoreMatcher: relativePath => relativePath === 'notes.txt',
      });

      expect(result.added).toEqual(['hero.png']);
      expect(result.skipped).toEqual([
        {
          path: '../outside.png',
          reason: 'The path escapes the project folder.',
        },
        { path: 'notes.txt', reason: 'Ignored by the ignore list.' },
      ]);
    } finally {
      project.delete();
    }
  });

  it('supports an injected resource factory (the spec seam)', () => {
    const project = makeProject();
    try {
      const created: Array<string> = [];
      const fakeFactory = (kind: string) => {
        created.push(kind);
        const resource = new gd.ImageResource();
        return resource;
      };
      const result = reconcileForkAssetResources({
        project,
        onDiskFiles: ['sound.ogg'],
        resourceKindForExtension: () => 'audio',
        resourceFactory: fakeFactory,
      });

      expect(created).toEqual(['audio']);
      expect(result.added).toEqual(['sound.ogg']);
    } finally {
      project.delete();
    }
  });
});
