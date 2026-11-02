// @flow
import optionalRequire from '../../Utils/OptionalRequire';
import { getByokSpriteSheetTools } from './ByokSpriteSheetTools';
import { findByNameokExtraTool } from './ByokExtraTools';
import {
  BYOK_CORE_TOOL_NAMES,
  getByokDispatchableToolNames,
  searchByokToolSchemas,
} from './ByokToolSchema';
import type { ByokExtraToolCollaborators } from './ByokExtraTools';
import type { ForkSpriteSheetToolDeps } from '../../Fork/SpriteSheet/ForkSpriteSheetToolHandler';
import type { ForkSpriteSheetSliceRequest } from '../../Fork/SpriteSheet/ForkSpriteSheetPort';

const path = (optionalRequire('path'): any);

const gd: libGDevelop = global.gd;

const PROJECT_FILE = path.resolve('/projects/game/game.json');
const PROJECT_FOLDER = path.dirname(PROJECT_FILE);
const ASSETS_FOLDER = path.join(PROJECT_FOLDER, 'MyGameAssets');
const SOURCE_IMAGE = path.resolve('/sheets/player.png');

/** The same in-memory "disk" discipline as ForkSpriteSheetToolHandler.spec. */
const makeDeps = (): {|
  deps: ForkSpriteSheetToolDeps,
  invokeSliceCalls: Array<ForkSpriteSheetSliceRequest>,
|} => {
  const writtenFiles: Set<string> = new Set();
  const invokeSliceCalls: Array<ForkSpriteSheetSliceRequest> = [];
  const deps: ForkSpriteSheetToolDeps = {
    pathLib: path,
    portDeps: {
      readImageSize: async () => ({ width: 128, height: 128 }),
      invokeSlice: async request => {
        invokeSliceCalls.push(request);
        const writtenAbsolutePaths = request.frameFileNames.map(fileName =>
          path.join(request.assetsFolderAbsolutePath, fileName)
        );
        for (const writtenPath of writtenAbsolutePaths) {
          writtenFiles.add(writtenPath);
        }
        return { ok: true, writtenAbsolutePaths };
      },
    },
    assembleDeps: {
      fs: {
        existsSync: (filePath: string) => writtenFiles.has(filePath),
        copyFile: async () => {
          throw new Error('copyFile must not be called for sliced frames');
        },
      },
      pathLib: path,
      downloadFile: async () => {
        throw new Error('downloads are not part of sprite-sheet import');
      },
    },
  };
  return { deps, invokeSliceCalls };
};

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setName('MyGame');
  project.setProjectFile(PROJECT_FILE);
  const layout = project.insertNewLayout('TestScene', 0);
  layout.getObjects().insertNewObject(project, 'Sprite', 'Player', 0);
  return project;
};

const makeCollaborators = (project: any): ByokExtraToolCollaborators => ({
  getProject: () => project,
  onSceneEventsModifiedOutsideEditor: (jest.fn(): any),
});

const findTool = () => {
  const tool = getByokSpriteSheetTools().find(
    candidate => candidate.name === 'import_sprite_sheet'
  );
  if (!tool) throw new Error('no import_sprite_sheet tool');
  return tool;
};

describe('the sprite-sheet tool is registered and discoverable', () => {
  it('resolves the name through the interception registry', () => {
    const tool = findByNameokExtraTool('import_sprite_sheet');
    expect(tool).not.toBeNull();
    if (!tool) throw new Error('the tool is not registered');
    // It writes frame files and an animation: the approval gate fires (D19-1).
    expect(tool.modifiesProject).toBe(true);
  });

  it('is dispatchable but never in the advertised core set', () => {
    expect(getByokDispatchableToolNames()).toContain('import_sprite_sheet');
    // Advertising it inline would eat the 13.5 token budget: the model
    // finds it through search_tools instead.
    expect(BYOK_CORE_TOOL_NAMES).not.toContain('import_sprite_sheet');
  });

  it('is reachable through search_tools', () => {
    const names = searchByokToolSchemas('sprite sheet').map(
      schema => schema.name
    );
    expect(names).toContain('import_sprite_sheet');
  });
});

describe('import_sprite_sheet', () => {
  it('imports a grid end-to-end with the documented defaults', async () => {
    const project = makeProject();
    try {
      const { deps, invokeSliceCalls } = makeDeps();
      // Defaults under test: animation_name "Imported", fps 10, loop true.
      const result = await getByokSpriteSheetTools({
        handlerDeps: deps,
      })[0].run(
        {
          object_name: 'Player',
          source_path: SOURCE_IMAGE,
          grid: { mode: 'rows-columns', rows: 2, columns: 2 },
        },
        makeCollaborators(project)
      );

      expect(result.didModifyProject).toBe(true);
      expect(result.output.success).toBe(true);
      expect(result.output.animation_name).toBe('Imported');
      expect(result.output.frame_count).toBe(4);
      expect(result.output.resource_names).toEqual([
        'Player_Imported_0.png',
        'Player_Imported_1.png',
        'Player_Imported_2.png',
        'Player_Imported_3.png',
      ]);
      expect(result.output.message).toContain('4 frame(s)');
      // The real assembly ran on the real project (10 fps, looping).
      const object = project
        .getLayout('TestScene')
        .getObjects()
        .getObject('Player');
      const animations = gd
        .asSpriteConfiguration(object.getConfiguration())
        .getAnimations();
      expect(animations.getAnimationsCount()).toBe(1);
      expect(animations.getAnimation(0).getName()).toBe('Imported');
      const direction = animations.getAnimation(0).getDirection(0);
      expect(direction.getSpritesCount()).toBe(4);
      expect(direction.getTimeBetweenFrames()).toBeCloseTo(1 / 10, 10);
      expect(direction.isLooping()).toBe(true);
      expect(invokeSliceCalls).toHaveLength(1);
      expect(invokeSliceCalls[0].assetsFolderAbsolutePath).toBe(ASSETS_FOLDER);
    } finally {
      project.delete();
    }
  });

  it('writes nothing when the handler refuses (bad grid, unknown object)', async () => {
    const project = makeProject();
    try {
      const { deps, invokeSliceCalls } = makeDeps();

      const badGrid = await getByokSpriteSheetTools({
        handlerDeps: deps,
      })[0].run(
        {
          object_name: 'Player',
          source_path: SOURCE_IMAGE,
          grid: { mode: 'rows-columns', rows: 3, columns: 3 },
        },
        makeCollaborators(project)
      );
      expect(badGrid.output.success).toBe(false);
      expect(badGrid.output.message).toContain('does not divide');
      expect(badGrid.didModifyProject).toBe(false);

      const unknownObject = await getByokSpriteSheetTools({
        handlerDeps: deps,
      })[0].run(
        {
          object_name: 'Ghost',
          source_path: SOURCE_IMAGE,
          grid: { mode: 'rows-columns', rows: 2, columns: 2 },
        },
        makeCollaborators(project)
      );
      expect(unknownObject.output.success).toBe(false);
      expect(unknownObject.output.message).toContain('Object not found');

      expect(invokeSliceCalls).toHaveLength(0);
      const object = project
        .getLayout('TestScene')
        .getObjects()
        .getObject('Player');
      expect(
        gd
          .asSpriteConfiguration(object.getConfiguration())
          .getAnimations()
          .getAnimationsCount()
      ).toBe(0);
    } finally {
      project.delete();
    }
  });

  it('refuses missing or ill-typed arguments with guidance', async () => {
    const project = makeProject();
    try {
      const { deps } = makeDeps();
      const collaborators = makeCollaborators(project);
      const tool = getByokSpriteSheetTools({ handlerDeps: deps })[0];

      const noObject = await tool.run(
        { source_path: SOURCE_IMAGE, grid: { mode: 'rows-columns' } },
        collaborators
      );
      expect(noObject.output.success).toBe(false);
      expect(noObject.output.message).toContain('object_name');

      const noSource = await tool.run(
        { object_name: 'Player', grid: { mode: 'rows-columns' } },
        collaborators
      );
      expect(noSource.output.success).toBe(false);
      expect(noSource.output.message).toContain('source_path');

      const noGrid = await tool.run(
        { object_name: 'Player', source_path: SOURCE_IMAGE },
        collaborators
      );
      expect(noGrid.output.success).toBe(false);
      expect(noGrid.output.message).toContain('grid');

      const badMode = await tool.run(
        {
          object_name: 'Player',
          source_path: SOURCE_IMAGE,
          grid: { mode: 'auto', rows: 2, columns: 2 },
        },
        collaborators
      );
      expect(badMode.output.success).toBe(false);
      expect(badMode.output.message).toContain('rows-columns');
    } finally {
      project.delete();
    }
  });

  it('refuses cleanly without a project', async () => {
    const result = await findTool().run({}, makeCollaborators(null));
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('No project is open');
    expect(result.didModifyProject).toBe(false);
  });
});
