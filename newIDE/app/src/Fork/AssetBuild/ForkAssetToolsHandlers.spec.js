// @flow
import { createNewResource } from '../../ResourcesList/ResourceSource';
import optionalRequire from '../../Utils/OptionalRequire';
import {
  createDefaultForkAssetToolsDeps,
  listForkAssetProjectFiles,
  projectForkAssetOptimizationPlan,
  reportAssetOptimization,
  setAssetOptimizationSettings,
  type ForkAssetProjectFile,
} from './ForkAssetToolsHandlers';
import {
  getForkAssetBuildSettings,
  resetForkAssetBuildSettingsForTests,
} from './ForkAssetBuildSettings';
import { planForkAssetOptimization } from './ForkAssetPlan';

const path = (optionalRequire('path'): any);
const gd: libGDevelop = global.gd;

const PROJECT_FILE = path.resolve('/projects/game/game.json');

/** An in-memory filesystem: existsSync/statSync over a size map. */
const makeFakeFs = (filesWithSizes: { [string]: number }) => ({
  existsSync: (filePath: string) => path.resolve(filePath) in filesWithSizes,
  statSync: (filePath: string) => {
    const size = filesWithSizes[path.resolve(filePath)];
    if (typeof size !== 'number') throw new Error('ENOENT');
    return { size, isFile: () => true, isDirectory: () => false };
  },
});

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setProjectFile(PROJECT_FILE);
  return project;
};

const addResource = (
  project: any,
  kind: string,
  name: string,
  file: string
) => {
  const resource = createNewResource(kind);
  if (!resource) throw new Error(`no resource of kind ${kind}`);
  resource.setName(name);
  resource.setFile(file);
  project.getResourcesManager().addResource(resource);
  resource.delete();
};

/**
 * Serialize a project the way the IDE snapshots do: through a
 * SerializerElement (gd.Serializer.toJSON(project) directly is the
 * project-self-serialization trap the IDE guards against).
 */
const serialize = (project: any): string => {
  const element = new gd.SerializerElement();
  project.serializeTo(element);
  const json = gd.Serializer.toJSON(element);
  element.delete();
  return json;
};

describe('listForkAssetProjectFiles', () => {
  let project: any;
  beforeEach(() => {
    project = makeProject();
  });
  afterEach(() => {
    project.delete();
  });

  it('lists only local image/audio resources, with their on-disk size', () => {
    addResource(project, 'image', 'hero', 'hero.png');
    addResource(project, 'audio', 'music', 'music.ogg');
    addResource(project, 'image', 'remote', 'https://cdn.example.com/x.png');
    addResource(project, 'image', 'gone', 'gone.png'); // not on disk
    addResource(project, 'json', 'data', 'data.json');

    const heroPath = path.resolve('/projects/game/hero.png');
    const musicPath = path.resolve('/projects/game/music.ogg');
    const dataPath = path.resolve('/projects/game/data.json');
    const deps = {
      fs: makeFakeFs({
        [heroPath]: 200000,
        [musicPath]: 300000,
        [dataPath]: 500,
      }),
      path,
    };

    const files = listForkAssetProjectFiles({ project, deps });
    expect(files.map(file => file.resourceName).sort()).toEqual([
      'hero',
      'music',
    ]);
    const hero = files.find(file => file.resourceName === 'hero');
    expect(hero).toEqual({
      resourceName: 'hero',
      relativePath: 'hero.png',
      extension: '.png',
      sizeBytes: 200000,
    });
  });
});

describe('projectForkAssetOptimizationPlan', () => {
  it('bands the projected savings per transform and totals them', () => {
    const files: Array<ForkAssetProjectFile> = [
      {
        resourceName: 'hero',
        relativePath: 'hero.png',
        extension: '.png',
        sizeBytes: 10000,
      },
      {
        resourceName: 'bg',
        relativePath: 'bg.jpg',
        extension: '.jpg',
        sizeBytes: 20000,
      },
      {
        resourceName: 'notes',
        relativePath: 'notes.txt',
        extension: '.txt',
        sizeBytes: 10,
      },
    ];
    const settings = { ...getForkAssetBuildSettings(), enabled: true };
    const plan = planForkAssetOptimization({
      files: files.map(file => ({
        relativePath: file.relativePath,
        extension: file.extension,
        sizeBytes: file.sizeBytes,
      })),
      settings,
    });
    const projection = projectForkAssetOptimizationPlan({ plan, files });

    expect(projection.plannedCount).toBe(2);
    expect(projection.skippedCount).toBe(1);
    expect(projection.bytesPlanned).toBe(30000);
    // png band 5%-25% of 10000 + jpeg band 35%-55% of 20000.
    expect(projection.projectedSavedLowBytes).toBe(500 + 7000);
    expect(projection.projectedSavedHighBytes).toBe(2500 + 11000);
    expect(projection.skipped[0].relativePath).toBe('notes.txt');
    expect(projection.skipped[0].reason).toContain('Unsupported extension');
  });
});

describe('reportAssetOptimization', () => {
  let project: any;
  beforeEach(() => {
    resetForkAssetBuildSettingsForTests();
    project = makeProject();
  });
  afterEach(() => {
    project.delete();
  });

  const makeDeps = (filesWithSizes: { [string]: number }) => ({
    fs: makeFakeFs(filesWithSizes),
    path,
  });

  it('writes nothing to the project (serialized state is byte-identical)', () => {
    addResource(project, 'image', 'hero', 'hero.png');
    addResource(project, 'audio', 'music', 'music.ogg');
    const deps = makeDeps({
      [path.resolve('/projects/game/hero.png')]: 200000,
      [path.resolve('/projects/game/music.ogg')]: 300000,
    });

    const before = serialize(project);
    const outcome = reportAssetOptimization({ project, deps });
    const after = serialize(project);

    expect(outcome.ok).toBe(true);
    expect(after).toBe(before);
    if (!outcome.ok) throw new Error('expected a projection');
    expect(outcome.projection.plannedCount).toBe(2);
    expect(outcome.projection.projectedSavedHighBytes).toBeGreaterThan(0);
  });

  it('does not change the caller-supplied settings either', () => {
    addResource(project, 'image', 'hero', 'hero.png');
    const deps = makeDeps({
      [path.resolve('/projects/game/hero.png')]: 200000,
    });
    const readBack = { ...getForkAssetBuildSettings() };
    reportAssetOptimization({ project, deps });
    expect(getForkAssetBuildSettings()).toEqual(readBack);
  });

  it('refuses without a project, without deps or without a saved file', () => {
    expect(reportAssetOptimization({ project: null }).ok).toBe(false);

    const unsaved = makeProject();
    unsaved.setProjectFile('');
    expect(
      reportAssetOptimization({ project: unsaved, deps: makeDeps({}) }).ok
    ).toBe(false);
    unsaved.delete();

    const withoutDeps = reportAssetOptimization({
      project,
      deps: null,
    });
    // No deps at all is only a refusal when the platform cannot supply them.
    if (!createDefaultForkAssetToolsDeps()) {
      expect(withoutDeps.ok).toBe(false);
    }
  });
});

describe('setAssetOptimizationSettings', () => {
  beforeEach(() => {
    resetForkAssetBuildSettingsForTests();
  });

  it('normalizes and persists a partial change', () => {
    const outcome = setAssetOptimizationSettings({
      partial: { enabled: true, pngLevel: 42, jpegQuality: 70 },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.settings.enabled).toBe(true);
    expect(outcome.settings.pngLevel).toBe(9);
    expect(outcome.settings.jpegQuality).toBe(70);
    expect(getForkAssetBuildSettings().enabled).toBe(true);
  });

  it('refuses a non-object payload', () => {
    const outcome = setAssetOptimizationSettings({ partial: null });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('object');
  });
});

describe('createDefaultForkAssetToolsDeps', () => {
  it('resolves the node fs/path modules in a desktop-like runtime', () => {
    const deps = createDefaultForkAssetToolsDeps();
    expect(deps).not.toBeNull();
    if (deps) {
      expect(deps.fs).toBeTruthy();
      expect(deps.path).toBeTruthy();
    }
  });
});
