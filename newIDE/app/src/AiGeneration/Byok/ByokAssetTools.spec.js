// @flow
import { createNewResource } from '../../ResourcesList/ResourceSource';
import optionalRequire from '../../Utils/OptionalRequire';
import { getByokAssetTools } from './ByokAssetTools';
import { findByNameokExtraTool } from './ByokExtraTools';
import {
  BYOK_CORE_TOOL_NAMES,
  getByokDispatchableToolNames,
  searchByokToolSchemas,
} from './ByokToolSchema';
import type { ByokExtraToolCollaborators } from './ByokExtraTools';
import {
  getForkAssetBuildSettings,
  resetForkAssetBuildSettingsForTests,
} from '../../Fork/AssetBuild/ForkAssetBuildSettings';

const path = (optionalRequire('path'): any);
const gd: libGDevelop = global.gd;

const PROJECT_FILE = path.resolve('/projects/game/game.json');

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

/** The IDE's project snapshot serialization (SerializerElement round-trip). */
const serialize = (project: any): string => {
  const element = new gd.SerializerElement();
  project.serializeTo(element);
  const json = gd.Serializer.toJSON(element);
  element.delete();
  return json;
};

const makeCollaborators = (project: any): ByokExtraToolCollaborators => ({
  getProject: () => project,
  onSceneEventsModifiedOutsideEditor: (jest.fn(): any),
});

const findTool = (name: string) => {
  const tool = getByokAssetTools({
    toolsDeps: {
      fs: makeFakeFs({
        [path.resolve('/projects/game/hero.png')]: 200000,
        [path.resolve('/projects/game/music.ogg')]: 300000,
      }),
      path,
    },
  }).find(candidate => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};

describe('the asset-build tools are registered and discoverable', () => {
  it('resolves every name through the interception registry', () => {
    const reportTool = findByNameokExtraTool('report_asset_optimization');
    const setTool = findByNameokExtraTool('set_asset_optimization_settings');
    const listTool = findByNameokExtraTool('list_assets');
    const tagTool = findByNameokExtraTool('set_asset_tags');
    expect(reportTool).not.toBeNull();
    expect(setTool).not.toBeNull();
    expect(listTool).not.toBeNull();
    expect(tagTool).not.toBeNull();
    if (!reportTool || !setTool || !listTool || !tagTool)
      throw new Error('the tools are not registered');
    expect(reportTool.modifiesProject).toBe(false);
    expect(setTool.modifiesProject).toBe(false);
    expect(listTool.modifiesProject).toBe(false);
    // set_asset_tags writes the resource metadata: a project change.
    expect(tagTool.modifiesProject).toBe(true);
  });

  it('is dispatchable but never in the advertised core set (D16-9/D17-10)', () => {
    const dispatchable = getByokDispatchableToolNames();
    expect(dispatchable).toContain('report_asset_optimization');
    expect(dispatchable).toContain('set_asset_optimization_settings');
    expect(dispatchable).toContain('list_assets');
    expect(dispatchable).toContain('set_asset_tags');
    // Advertising these inline would eat the 13.5 token budget: the model
    // finds them through search_tools instead.
    expect(BYOK_CORE_TOOL_NAMES).not.toContain('report_asset_optimization');
    expect(BYOK_CORE_TOOL_NAMES).not.toContain(
      'set_asset_optimization_settings'
    );
    expect(BYOK_CORE_TOOL_NAMES).not.toContain('list_assets');
    expect(BYOK_CORE_TOOL_NAMES).not.toContain('set_asset_tags');
  });

  it('is reachable through search_tools', () => {
    const matches = searchByokToolSchemas('asset optimization');
    const names = matches.map(schema => schema.name);
    expect(names).toContain('report_asset_optimization');
    expect(names).toContain('set_asset_optimization_settings');

    const tagMatches = searchByokToolSchemas('asset tags');
    const tagNames = tagMatches.map(schema => schema.name);
    expect(tagNames).toContain('list_assets');
    expect(tagNames).toContain('set_asset_tags');
  });
});

describe('report_asset_optimization', () => {
  let project: any;
  beforeEach(() => {
    resetForkAssetBuildSettingsForTests();
    project = makeProject();
    addResource(project, 'image', 'hero', 'hero.png');
    addResource(project, 'audio', 'music', 'music.ogg');
  });
  afterEach(() => {
    project.delete();
  });

  it('projects the savings without touching the project', async () => {
    const tool = findTool('report_asset_optimization');
    const before = serialize(project);

    const result = await tool.run({}, makeCollaborators(project));

    expect(result.didModifyProject).toBe(false);
    expect(result.output.success).toBe(true);
    expect(result.output.totals.planned_files).toBe(2);
    expect(result.output.totals.bytes_planned).toBe(500000);
    expect(result.output.planned_files.map(file => file.file).sort()).toEqual([
      'hero.png',
      'music.ogg',
    ]);
    expect(result.output.message).toContain('estimate');
    // The non-destructiveness guarantee, stated to the model.
    expect(result.output.message).toContain('never');
    expect(serialize(project)).toBe(before);
  });

  it('says so when the feature is off (the projection is still useful)', async () => {
    const tool = findTool('report_asset_optimization');
    expect(getForkAssetBuildSettings().enabled).toBe(false);
    const result = await tool.run({}, makeCollaborators(project));
    expect(result.output.message).toContain('OFF');
  });

  it('refuses cleanly without a project', async () => {
    const tool = findTool('report_asset_optimization');
    const result = await tool.run({}, makeCollaborators(null));
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('No project is open');
    expect(result.didModifyProject).toBe(false);
  });
});

describe('set_asset_optimization_settings', () => {
  beforeEach(() => {
    resetForkAssetBuildSettingsForTests();
  });

  it('applies the provided knobs and reports the resulting settings', async () => {
    const tool = findTool('set_asset_optimization_settings');
    const result = await tool.run(
      { enabled: true, png_level: 3, jpeg_quality: 70, webp_quality: 80 },
      makeCollaborators(null)
    );
    expect(result.output.success).toBe(true);
    expect(result.didModifyProject).toBe(false);
    expect(getForkAssetBuildSettings().enabled).toBe(true);
    expect(getForkAssetBuildSettings().pngLevel).toBe(3);
    expect(getForkAssetBuildSettings().jpegQuality).toBe(70);
    expect(getForkAssetBuildSettings().webpQuality).toBe(80);
    expect(result.output.message).toContain('png_level=3');
    expect(result.output.message).toContain('webp_quality=80');
  });

  it('clamps the WebP knob independently of the JPEG one', async () => {
    const tool = findTool('set_asset_optimization_settings');
    await tool.run({ webp_quality: 0 }, makeCollaborators(null));
    expect(getForkAssetBuildSettings().webpQuality).toBe(1);
    // The untouched JPEG knob keeps its default.
    expect(getForkAssetBuildSettings().jpegQuality).toBe(85);
  });

  it('clamps an out-of-range knob instead of refusing it', async () => {
    const tool = findTool('set_asset_optimization_settings');
    await tool.run({ jpeg_quality: 500 }, makeCollaborators(null));
    expect(getForkAssetBuildSettings().jpegQuality).toBe(100);
  });

  it('refuses a call with no recognizable knob', async () => {
    const tool = findTool('set_asset_optimization_settings');
    const result = await tool.run({ nope: true }, makeCollaborators(null));
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('png_level');
  });

  it('ignores knobs of the wrong primitive type', async () => {
    const tool = findTool('set_asset_optimization_settings');
    const result = await tool.run(
      { enabled: 'yes', jpeg_quality: '90' },
      makeCollaborators(null)
    );
    expect(result.output.success).toBe(false);
    expect(getForkAssetBuildSettings().enabled).toBe(false);
  });
});

describe('list_assets (Phase 17.7)', () => {
  let project: any;
  beforeEach(() => {
    project = makeProject();
    addResource(project, 'image', 'hero', 'hero.png');
    addResource(project, 'image', 'enemy slime', 'slime.png');
    addResource(project, 'audio', 'music', 'music.ogg');
  });
  afterEach(() => {
    project.delete();
  });

  it('lists every asset with kind, file and tag state', async () => {
    const tool = findTool('list_assets');
    const result = await tool.run({}, makeCollaborators(project));
    expect(result.output.success).toBe(true);
    expect(result.didModifyProject).toBe(false);
    expect(result.output.matched_count).toBe(3);
    expect(result.output.assets.map(asset => asset.name)).toEqual([
      'enemy slime',
      'hero',
      'music',
    ]);
    expect(result.output.assets[0].kind).toBe('image');
    expect(result.output.message).toContain('[untagged]');
  });

  it('filters by tag after set_asset_tags wrote one', async () => {
    const setTool = findTool('set_asset_tags');
    const setResult = await setTool.run(
      { asset_names: ['hero', 'enemy slime'], tags: ['Enemy'], mode: 'merge' },
      makeCollaborators(project)
    );
    expect(setResult.output.success).toBe(true);

    const listTool = findTool('list_assets');
    const byTag = await listTool.run(
      { tag: 'enemy' },
      makeCollaborators(project)
    );
    // The filter normalizes like the tags do (lowercase).
    expect(byTag.output.matched_count).toBe(2);
    expect(byTag.output.assets.map(asset => asset.name).sort()).toEqual([
      'enemy slime',
      'hero',
    ]);

    const untagged = await listTool.run(
      { untagged_only: true },
      makeCollaborators(project)
    );
    expect(untagged.output.matched_count).toBe(1);
    expect(untagged.output.assets[0].name).toBe('music');
  });

  it('refuses cleanly without a project', async () => {
    const tool = findTool('list_assets');
    const result = await tool.run({}, makeCollaborators(null));
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('No project is open');
    expect(result.didModifyProject).toBe(false);
  });
});

describe('set_asset_tags (Phase 17.7)', () => {
  let project: any;
  beforeEach(() => {
    project = makeProject();
    addResource(project, 'image', 'hero', 'hero.png');
  });
  afterEach(() => {
    project.delete();
  });

  it('merges tags, flags the project modified and persists in metadata', async () => {
    const tool = findTool('set_asset_tags');
    const before = serialize(project);
    const result = await tool.run(
      { asset_names: ['hero'], tags: ['Player', 'Jump'], mode: 'merge' },
      makeCollaborators(project)
    );
    expect(result.output.success).toBe(true);
    // The write flag the approval row and the unsaved-changes marker read.
    expect(result.didModifyProject).toBe(true);
    expect(result.output.updated).toEqual([
      { name: 'hero', tags: ['player', 'jump'] },
    ]);
    expect(result.output.message).toContain('[player, jump]');
    // The write really happened: the serialized project changed.
    expect(serialize(project)).not.toBe(before);
  });

  it('set replaces, remove drops one tag, clear empties them', async () => {
    const tool = findTool('set_asset_tags');
    await tool.run(
      { asset_names: ['hero'], tags: ['a', 'b'], mode: 'set' },
      makeCollaborators(project)
    );
    const afterRemove = await tool.run(
      { asset_names: ['hero'], tags: ['a'], mode: 'remove' },
      makeCollaborators(project)
    );
    expect(afterRemove.output.updated).toEqual([{ name: 'hero', tags: ['b'] }]);
    const afterClear = await tool.run(
      { asset_names: ['hero'], tags: [], mode: 'clear' },
      makeCollaborators(project)
    );
    expect(afterClear.output.updated).toEqual([{ name: 'hero', tags: [] }]);
  });

  it('refuses an invalid tag atomically (no partial write)', async () => {
    const tool = findTool('set_asset_tags');
    const before = serialize(project);
    const result = await tool.run(
      { asset_names: ['hero'], tags: ['fine', 'Bad/Tag'], mode: 'merge' },
      makeCollaborators(project)
    );
    expect(result.output.success).toBe(false);
    expect(result.didModifyProject).toBe(false);
    expect(result.output.message).toContain('Bad/Tag');
    expect(serialize(project)).toBe(before);
  });

  it('refuses an unknown asset name atomically', async () => {
    const tool = findTool('set_asset_tags');
    const result = await tool.run(
      { asset_names: ['ghost'], tags: ['x'], mode: 'merge' },
      makeCollaborators(project)
    );
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('ghost');
  });

  it('refuses a call with no asset name or (non-clear) no tag', async () => {
    const tool = findTool('set_asset_tags');
    const noNames = await tool.run({ tags: ['x'] }, makeCollaborators(project));
    expect(noNames.output.success).toBe(false);
    expect(noNames.output.message).toContain('asset_names');
    const noTags = await tool.run(
      { asset_names: ['hero'], tags: [], mode: 'merge' },
      makeCollaborators(project)
    );
    expect(noTags.output.success).toBe(false);
    expect(noTags.output.message).toContain('tag');

    const clearWithoutTags = await tool.run(
      { asset_names: ['hero'], tags: [], mode: 'clear' },
      makeCollaborators(project)
    );
    expect(clearWithoutTags.output.success).toBe(true);
  });

  it('refuses cleanly without a project', async () => {
    const tool = findTool('set_asset_tags');
    const result = await tool.run(
      { asset_names: ['hero'], tags: ['x'] },
      makeCollaborators(null)
    );
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('No project is open');
    expect(result.didModifyProject).toBe(false);
  });
});
