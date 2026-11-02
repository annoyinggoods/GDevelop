// @flow
import {
  FORK_SPRITE_SHEET_SLICE_CHANNEL,
  getForkSpriteSheetAssetsFolder,
  getForkSpriteSheetAssetsFolderName,
  importForkSpriteSheetFrames,
  listForkSpriteSheetTakenFileNames,
  makeDefaultForkSpriteSheetPortDeps,
  makeForkSpriteSheetFileUrl,
  type ForkSpriteSheetPortDeps,
  type ForkSpriteSheetSliceRequest,
} from './ForkSpriteSheetPort';

const PROJECT_FILE_WINDOWS = 'C:\\projects\\my game\\game.json';
const ASSETS_FOLDER_WINDOWS = 'C:\\projects\\my game\\MyGameAssets';

/** A minimal project stand-in: the surfaces the port actually reads. */
const makeProject = (resourceFiles: Array<string> = []): any => ({
  getProjectFile: () => PROJECT_FILE_WINDOWS,
  getName: () => 'MyGame',
  getResourcesManager: () => ({
    getAllResourceNames: () => ({
      toJSArray: () => resourceFiles.map(file => file.replace(/.*\//, '')),
    }),
    getResource: (name: string) => ({
      getFile: () =>
        resourceFiles.find(file => file.replace(/.*\//, '') === name) || '',
    }),
  }),
});

const makeDeps = (
  overrides?: Partial<ForkSpriteSheetPortDeps>
): {|
  deps: ForkSpriteSheetPortDeps,
  sliceRequests: Array<ForkSpriteSheetSliceRequest>,
|} => {
  const sliceRequests: Array<ForkSpriteSheetSliceRequest> = [];
  const deps: ForkSpriteSheetPortDeps = {
    readImageSize: async () => ({ width: 512, height: 512 }),
    invokeSlice: async request => {
      sliceRequests.push(request);
      return {
        ok: true,
        writtenAbsolutePaths: request.frameFileNames.map(
          fileName => `${request.assetsFolderAbsolutePath}\\${fileName}`
        ),
      };
    },
    ...overrides,
  };
  return { deps, sliceRequests };
};

describe('getForkSpriteSheetAssetsFolderName', () => {
  it('derives <GameName>Assets with the carrier sanitization', () => {
    expect(getForkSpriteSheetAssetsFolderName('MyGame')).toBe('MyGameAssets');
    expect(getForkSpriteSheetAssetsFolderName('  My Game* ')).toBe(
      'My Game_Assets'
    );
    expect(getForkSpriteSheetAssetsFolderName('///')).toBe('GameAssets');
    expect(getForkSpriteSheetAssetsFolderName('')).toBe('GameAssets');
  });
});

describe('getForkSpriteSheetAssetsFolder', () => {
  it('derives the folder from the project file, native separator', () => {
    const folder = getForkSpriteSheetAssetsFolder(makeProject());
    expect(folder.ok).toBe(true);
    if (!folder.ok) return;
    expect(folder.folderName).toBe('MyGameAssets');
    expect(folder.folderAbsolutePath).toBe(ASSETS_FOLDER_WINDOWS);
  });

  it('refuses a project with no file on disk yet', () => {
    const folder = getForkSpriteSheetAssetsFolder({
      getProjectFile: () => '',
      getName: () => 'MyGame',
    });
    expect(folder.ok).toBe(false);
    if (folder.ok) return;
    expect(folder.error).toContain('saved');
  });
});

describe('listForkSpriteSheetTakenFileNames', () => {
  it('lists the BASE names of the project resource files', () => {
    const names = listForkSpriteSheetTakenFileNames(
      makeProject(['hero.png', 'res/icon128.png', 'MyGameAssets/old_0.png'])
    );
    expect(names).toEqual(['hero.png', 'icon128.png', 'old_0.png']);
  });
});

describe('makeForkSpriteSheetFileUrl', () => {
  it('builds triple-slash file URLs for Windows and POSIX paths', () => {
    expect(makeForkSpriteSheetFileUrl('C:\\a b\\hero.png')).toBe(
      'file:///C:/a%20b/hero.png'
    );
    expect(makeForkSpriteSheetFileUrl('/home/user/hero.png')).toBe(
      'file:///home/user/hero.png'
    );
  });
});

describe('importForkSpriteSheetFrames', () => {
  it('plans, slices and returns the paths in frame order', async () => {
    const { deps, sliceRequests } = makeDeps();

    const outcome = await importForkSpriteSheetFrames({
      project: makeProject(),
      sourceAbsolutePath: 'C:\\sheets\\player.png',
      grid: { mode: 'rows-columns', rows: 4, columns: 4 },
      objectName: 'Player',
      animationName: 'Run',
      deps,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.frames).toHaveLength(16);
    expect(outcome.frameFileNames).toHaveLength(16);
    expect(outcome.frameFileNames[0]).toBe('Player_Run_0.png');
    expect(outcome.frameFileNames[15]).toBe('Player_Run_15.png');
    expect(outcome.writtenAbsolutePaths).toHaveLength(16);
    expect(outcome.writtenAbsolutePaths[0]).toBe(
      `${ASSETS_FOLDER_WINDOWS}\\Player_Run_0.png`
    );
    // The slice request carries the plan, the deduped names and the folder.
    expect(sliceRequests).toHaveLength(1);
    expect(sliceRequests[0].sourceAbsolutePath).toBe('C:\\sheets\\player.png');
    expect(sliceRequests[0].assetsFolderAbsolutePath).toBe(
      ASSETS_FOLDER_WINDOWS
    );
    expect(sliceRequests[0].frames).toEqual(outcome.frames);
    expect(sliceRequests[0].frameFileNames).toEqual(outcome.frameFileNames);
  });

  it('invokes nothing when the plan refuses the grid', async () => {
    const { deps, sliceRequests } = makeDeps();

    const outcome = await importForkSpriteSheetFrames({
      project: makeProject(),
      sourceAbsolutePath: 'C:\\sheets\\player.png',
      grid: { mode: 'rows-columns', rows: 3, columns: 3 },
      objectName: 'Player',
      animationName: 'Run',
      deps,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('does not divide');
    expect(sliceRequests).toHaveLength(0);
  });

  it('maps a slice failure to the handler message', async () => {
    const { deps } = makeDeps({
      invokeSlice: async () => ({ ok: false, error: 'disk full' }),
    });

    const outcome = await importForkSpriteSheetFrames({
      project: makeProject(),
      sourceAbsolutePath: 'C:\\sheets\\player.png',
      grid: { mode: 'rows-columns', rows: 4, columns: 4 },
      objectName: 'Player',
      animationName: 'Run',
      deps,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('disk full');
  });

  it('maps a throwing dep to an honest error', async () => {
    const readError = new Error('not readable');
    const { deps, sliceRequests } = makeDeps({
      readImageSize: async () => {
        throw readError;
      },
    });

    const outcome = await importForkSpriteSheetFrames({
      project: makeProject(),
      sourceAbsolutePath: 'C:\\sheets\\player.png',
      grid: { mode: 'rows-columns', rows: 4, columns: 4 },
      objectName: 'Player',
      animationName: 'Run',
      deps,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('not readable');
    expect(sliceRequests).toHaveLength(0);
  });

  it('dedupes the frame names against the existing resource files', async () => {
    const { deps, sliceRequests } = makeDeps();

    const outcome = await importForkSpriteSheetFrames({
      project: makeProject(['Player_Run_0.png']),
      sourceAbsolutePath: 'C:\\sheets\\player.png',
      grid: { mode: 'rows-columns', rows: 2, columns: 2 },
      objectName: 'Player',
      animationName: 'Run',
      deps,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.frameFileNames).not.toContain('Player_Run_0.png');
    expect(outcome.frameFileNames[0]).toBe('Player_Run_02.png');
    expect(sliceRequests[0].frameFileNames).toEqual(outcome.frameFileNames);
  });
});

describe('makeDefaultForkSpriteSheetPortDeps', () => {
  it('never throws outside the desktop app (it returns null or the deps)', () => {
    const deps = makeDefaultForkSpriteSheetPortDeps();
    if (deps) {
      expect(typeof deps.invokeSlice).toBe('function');
      expect(typeof deps.readImageSize).toBe('function');
    } else {
      expect(deps).toBeNull();
    }
  });

  it('uses the flat slice channel name the Electron handler registers', () => {
    expect(FORK_SPRITE_SHEET_SLICE_CHANNEL).toBe('fork-sprite-sheet-slice');
  });
});
