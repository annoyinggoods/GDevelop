// @flow
import optionalRequire from '../../Utils/OptionalRequire';
import {
  importForkSpriteSheet,
  makeDefaultForkSpriteSheetToolDeps,
  resolveForkSpriteSheetSourcePath,
  type ForkSpriteSheetToolDeps,
} from './ForkSpriteSheetToolHandler';
import type { ForkSpriteSheetSliceRequest } from './ForkSpriteSheetPort';

const path = (optionalRequire('path'): any);

const gd: libGDevelop = global.gd;

const PROJECT_FILE = path.resolve('/projects/game/game.json');
const PROJECT_FOLDER = path.dirname(PROJECT_FILE);
const SOURCE_IMAGE = path.resolve('/sheets/player.png');

/**
 * An in-memory "disk": existsSync over a Set that the invokeSlice fake
 * populates — a written frame appears on it, so the assembly's in-place
 * registration finds its files, and a refusal leaves it empty.
 */
const makeFakeDisk = () => {
  const writtenFiles: Set<string> = new Set();
  return {
    writtenFiles,
    fs: {
      existsSync: (filePath: string) => writtenFiles.has(filePath),
      copyFile: async () => {
        throw new Error('copyFile must not be called for sliced frames');
      },
    },
  };
};

/**
 * The full deps seam: the port fakes record their call order and write the
 * frame PNGs onto the fake disk; the assembly runs for real over that disk
 * (the same real-libGD discipline as ForkSpriteSheetAssemble.spec.js).
 */
const makeDeps = (
  disk: ReturnType<typeof makeFakeDisk>,
  overrides?: {|
    readImageSize?: (
      absolutePath: string
    ) => Promise<{| width: number, height: number |}>,
    invokeSlice?: (
      request: ForkSpriteSheetSliceRequest
    ) => Promise<{| ok: true, writtenAbsolutePaths: Array<string> |}>,
  |}
): {|
  deps: ForkSpriteSheetToolDeps,
  callOrder: Array<string>,
  sliceRequests: Array<ForkSpriteSheetSliceRequest>,
  readImageSizeCalls: Array<string>,
|} => {
  const callOrder: Array<string> = [];
  const sliceRequests: Array<ForkSpriteSheetSliceRequest> = [];
  const readImageSizeCalls: Array<string> = [];
  const deps: ForkSpriteSheetToolDeps = {
    pathLib: path,
    portDeps: {
      readImageSize:
        overrides && overrides.readImageSize
          ? overrides.readImageSize
          : async absolutePath => {
              callOrder.push('readImageSize');
              readImageSizeCalls.push(absolutePath);
              return { width: 512, height: 512 };
            },
      invokeSlice:
        overrides && overrides.invokeSlice
          ? overrides.invokeSlice
          : async request => {
              callOrder.push('invokeSlice');
              sliceRequests.push(request);
              const writtenAbsolutePaths = request.frameFileNames.map(
                fileName =>
                  path.join(request.assetsFolderAbsolutePath, fileName)
              );
              for (const writtenPath of writtenAbsolutePaths) {
                disk.writtenFiles.add(writtenPath);
              }
              return { ok: true, writtenAbsolutePaths };
            },
    },
    assembleDeps: {
      fs: disk.fs,
      pathLib: path,
      downloadFile: async () => {
        throw new Error('downloads must not be part of sprite-sheet import');
      },
    },
  };
  return { deps, callOrder, sliceRequests, readImageSizeCalls };
};

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setName('MyGame');
  project.setProjectFile(PROJECT_FILE);
  const layout = project.insertNewLayout('TestScene', 0);
  layout.getObjects().insertNewObject(project, 'Sprite', 'Player', 0);
  layout.getObjects().insertNewObject(project, 'TextObject::Text', 'Label', 1);
  return project;
};

const makeArgs = (overrides?: {|
  objectName?: string,
  sourceAbsolutePath?: string,
  grid?: Object,
|}): {|
  objectName: string,
  sourceAbsolutePath: string,
  grid: any,
  animationName: string,
  fps: number,
  loop: boolean,
|} => ({
  objectName:
    overrides && overrides.objectName !== undefined
      ? overrides.objectName
      : 'Player',
  sourceAbsolutePath:
    overrides && overrides.sourceAbsolutePath !== undefined
      ? overrides.sourceAbsolutePath
      : SOURCE_IMAGE,
  // Typed as `any`: the handler must reject malformed grids at runtime, so
  // the spec deliberately passes unrefined object literals.
  grid:
    overrides && overrides.grid
      ? overrides.grid
      : { mode: 'rows-columns', rows: 4, columns: 4 },
  animationName: 'Run',
  fps: 10,
  loop: true,
});

/** The IDE's project snapshot serialization, for nothing-mutated asserts. */
const serializeProject = (project: any): string => {
  const element = new gd.SerializerElement();
  project.serializeTo(element);
  const json = gd.Serializer.toJSON(element);
  element.delete();
  return JSON.stringify(json);
};

const getAnimations = (project: any) => {
  const layout = project.getLayout('TestScene');
  const object = layout.getObjects().getObject('Player');
  return gd.asSpriteConfiguration(object.getConfiguration()).getAnimations();
};

describe('resolveForkSpriteSheetSourcePath', () => {
  const project: any = { getProjectFile: () => PROJECT_FILE };

  it('passes absolute paths through', () => {
    expect(resolveForkSpriteSheetSourcePath(project, SOURCE_IMAGE, path)).toBe(
      SOURCE_IMAGE
    );
  });

  it('resolves a project-relative path against the project folder', () => {
    expect(
      resolveForkSpriteSheetSourcePath(project, 'sheets/player.png', path)
    ).toBe(path.join(PROJECT_FOLDER, 'sheets/player.png'));
  });
});

describe('makeDefaultForkSpriteSheetToolDeps', () => {
  it('never throws outside the desktop app (null or the deps)', () => {
    const deps = makeDefaultForkSpriteSheetToolDeps();
    if (deps) {
      expect(deps.portDeps).not.toBeNull();
      expect(typeof deps.pathLib.join).toBe('function');
    } else {
      expect(deps).toBeNull();
    }
  });
});

describe('importForkSpriteSheet', () => {
  let project: any;

  beforeEach(() => {
    project = makeProject();
  });

  afterEach(() => {
    project.delete();
  });

  it('composes the port and the assembly end-to-end (success)', async () => {
    const disk = makeFakeDisk();
    const { deps, callOrder, sliceRequests } = makeDeps(disk);

    const result = await importForkSpriteSheet(project, makeArgs(), deps);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.didModifyProject).toBe(true);
    expect(result.animationName).toBe('Run');
    expect(result.frameCount).toBe(16);
    expect(result.resourceNames).toHaveLength(16);
    expect(result.resourceNames[0]).toBe('Player_Run_0.png');
    // The summary names the animation, the frame count and the folder.
    expect(result.output).toContain('"Run"');
    expect(result.output).toContain('16 frame(s)');
    expect(result.output).toContain('MyGameAssets/');
    expect(result.output).toContain('Player_Run_0.png');
    // The real assembly ran: the animation exists with the frames in order.
    const animations = getAnimations(project);
    expect(animations.getAnimationsCount()).toBe(1);
    const animation = animations.getAnimation(0);
    expect(animation.getName()).toBe('Run');
    const direction = animation.getDirection(0);
    expect(direction.getSpritesCount()).toBe(16);
    expect(direction.getSprite(0).getImageName()).toBe('Player_Run_0.png');
    expect(direction.getSprite(15).getImageName()).toBe('Player_Run_15.png');
    expect(direction.getTimeBetweenFrames()).toBeCloseTo(1 / 10, 10);
    // The fakes ran in the pipeline order: size → slice (→ assembly).
    expect(callOrder).toEqual(['readImageSize', 'invokeSlice']);
    expect(sliceRequests).toHaveLength(1);
    expect(sliceRequests[0].sourceAbsolutePath).toBe(SOURCE_IMAGE);
  });

  it('resolves a project-relative source against the project folder', async () => {
    const disk = makeFakeDisk();
    const { deps, readImageSizeCalls } = makeDeps(disk);

    const result = await importForkSpriteSheet(
      project,
      makeArgs({ sourceAbsolutePath: 'sheets/player.png' }),
      deps
    );

    expect(result.success).toBe(true);
    expect(readImageSizeCalls).toEqual([
      path.join(PROJECT_FOLDER, 'sheets/player.png'),
    ]);
  });

  it('writes NOTHING when the plan refuses the grid', async () => {
    const disk = makeFakeDisk();
    const { deps, callOrder } = makeDeps(disk);
    const before = serializeProject(project);

    const result = await importForkSpriteSheet(
      project,
      makeArgs({ grid: { mode: 'rows-columns', rows: 3, columns: 3 } }),
      deps
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toContain('does not divide');
    expect(result.didModifyProject).toBe(false);
    expect(callOrder).toEqual(['readImageSize']);
    expect(disk.writtenFiles.size).toBe(0);
    expect(getAnimations(project).getAnimationsCount()).toBe(0);
    expect(serializeProject(project)).toBe(before);
  });

  it('writes NOTHING when the object is unknown or not a Sprite', async () => {
    const disk = makeFakeDisk();
    const { deps } = makeDeps(disk);
    const before = serializeProject(project);

    const unknownObject = await importForkSpriteSheet(
      project,
      makeArgs({ objectName: 'Ghost' }),
      deps
    );
    expect(unknownObject.success).toBe(false);
    if (unknownObject.success) return;
    expect(unknownObject.message).toContain('Object not found: "Ghost"');
    expect(unknownObject.didModifyProject).toBe(false);

    const notASprite = await importForkSpriteSheet(
      project,
      makeArgs({ objectName: 'Label' }),
      deps
    );
    expect(notASprite.success).toBe(false);
    if (notASprite.success) return;
    expect(notASprite.message).toContain('not "Sprite"');

    // Neither refusal reached the slicer or the disk.
    expect(disk.writtenFiles.size).toBe(0);
    expect(serializeProject(project)).toBe(before);
  });

  it('relays a slicer failure without assembling anything', async () => {
    const disk = makeFakeDisk();
    const { deps } = makeDeps(disk, {
      invokeSlice: (jest.fn(): any).mockResolvedValue({
        ok: false,
        error: 'disk full',
      }),
    });
    const before = serializeProject(project);

    const result = await importForkSpriteSheet(project, makeArgs(), deps);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toBe('disk full');
    expect(result.didModifyProject).toBe(false);
    expect(getAnimations(project).getAnimationsCount()).toBe(0);
    expect(serializeProject(project)).toBe(before);
  });

  it('refuses with the desktop-only message when the default deps are unavailable', async () => {
    // The jest runtime has the node path module but no Electron ipcRenderer,
    // so the default deps builder answers null — the import_project_resources
    // guard, spec-proven.
    const result = await importForkSpriteSheet(project, makeArgs());

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toContain('only available in the desktop app');
    expect(result.didModifyProject).toBe(false);
    expect(getAnimations(project).getAnimationsCount()).toBe(0);
  });

  it('refuses before anything runs without a project or a saved file', async () => {
    const disk = makeFakeDisk();
    const { deps, callOrder } = makeDeps(disk);
    const unsaved: any = {
      getProjectFile: () => '',
      getLayoutsCount: () => 0,
      getObjects: () => ({ hasObjectNamed: () => false }),
    };

    const noProject = await importForkSpriteSheet(
      (null: any),
      makeArgs(),
      deps
    );
    expect(noProject.success).toBe(false);
    if (noProject.success) return;
    expect(noProject.message).toContain('No project is open');

    const result = await importForkSpriteSheet(unsaved, makeArgs(), deps);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toContain('must be saved');
    expect(callOrder).toEqual([]);
  });

  it('refuses invalid arguments before touching the pipeline', async () => {
    const disk = makeFakeDisk();
    const { deps, callOrder } = makeDeps(disk);

    const noObject = await importForkSpriteSheet(
      project,
      makeArgs({ objectName: '' }),
      deps
    );
    expect(noObject.success).toBe(false);
    if (noObject.success) return;
    expect(noObject.message).toContain('object name');

    const badFps = await importForkSpriteSheet(
      project,
      { ...makeArgs(), fps: 0 },
      deps
    );
    expect(badFps.success).toBe(false);
    if (badFps.success) return;
    expect(badFps.message).toContain('frames-per-second');

    const noSource = await importForkSpriteSheet(
      project,
      makeArgs({ sourceAbsolutePath: '' }),
      deps
    );
    expect(noSource.success).toBe(false);
    if (noSource.success) return;
    expect(noSource.message).toContain('No source image');

    expect(callOrder).toEqual([]);
  });
});
