// @flow
import {
  byokSearchAndInstallAsset,
  byokSearchAndInstallResources,
  doesEffectMatchFilter,
  flattenByokEffectProperties,
  getByokCatalogTools,
  listByokEffects,
  setByokCatalogFetchersForTests,
} from './ByokCatalogTools';
import { makeTestExtensions } from '../../fixtures/TestExtensions';
import { makeTestProject } from '../../fixtures/TestProject';

const gd: libGDevelop = global.gd;

const makeProject = () => {
  makeTestExtensions(gd);
  return makeTestProject(gd).project;
};

const getTool = (name: string): any =>
  getByokCatalogTools().find(tool => tool.name === name);

describe('ByokCatalogTools', () => {
  let project: gdProject;

  beforeEach(() => {
    project = makeProject();
  });

  afterEach(() => {
    project.delete();
  });

  describe('doesEffectMatchFilter', () => {
    const makeMetadata = (flags: Object) => ({
      isMarkedAsNotWorkingForObjects: false,
      isMarkedAsOnlyWorkingFor2D: false,
      isMarkedAsOnlyWorkingFor3D: false,
      ...flags,
    });

    it('returns everything for no filter', () => {
      expect(doesEffectMatchFilter(makeMetadata({}), null)).toBe(true);
      expect(doesEffectMatchFilter(makeMetadata({}), 'unknown-filter')).toBe(
        true
      );
    });

    it('filters 2d vs 3d markers', () => {
      expect(
        doesEffectMatchFilter(
          makeMetadata({ isMarkedAsOnlyWorkingFor3D: true }),
          '2d'
        )
      ).toBe(false);
      expect(
        doesEffectMatchFilter(
          makeMetadata({ isMarkedAsOnlyWorkingFor2D: true }),
          '2d'
        )
      ).toBe(true);
      expect(
        doesEffectMatchFilter(
          makeMetadata({ isMarkedAsOnlyWorkingFor2D: true }),
          '3d'
        )
      ).toBe(false);
    });

    it('filters object applicability', () => {
      expect(
        doesEffectMatchFilter(
          makeMetadata({ isMarkedAsNotWorkingForObjects: true }),
          'object'
        )
      ).toBe(false);
      expect(doesEffectMatchFilter(makeMetadata({}), 'object')).toBe(true);
    });
  });

  describe('flattenByokEffectProperties', () => {
    const makeField = (name: string, overrides: Object = {}) => ({
      name,
      valueType: 'number',
      defaultValue: '0',
      visibility: 'basic',
      ...overrides,
    });

    it('compacts a plain field', () => {
      expect(
        flattenByokEffectProperties([
          makeField('brightness', { defaultValue: '0.5' }),
        ])
      ).toEqual([
        {
          name: 'brightness',
          type: 'number',
          defaultValue: '0.5',
          description: undefined,
          choices: undefined,
          isAdvanced: false,
          isDeprecated: false,
        },
      ]);
    });

    it('merges grouped fields (section children) into plain properties', () => {
      const properties = flattenByokEffectProperties([
        makeField('aSection', {
          children: [
            makeField('inner1'),
            makeField('inner2', { visibility: 'advanced' }),
          ],
        }),
        makeField('plain'),
      ]);
      expect(properties.map(property => property.name)).toEqual([
        'inner1',
        'inner2',
        'plain',
      ]);
      expect(properties[1].isAdvanced).toBe(true);
    });

    it('flattens nested groups recursively', () => {
      const properties = flattenByokEffectProperties([
        makeField('outer', {
          children: [makeField('mid', { children: [makeField('deep')] })],
        }),
      ]);
      expect(properties.map(property => property.name)).toEqual(['deep']);
    });
  });

  describe('list_effects', () => {
    it('lists every bundled effect type with its property schemas', async () => {
      const tool = getTool('list_effects');
      const result = await tool.run({}, ({ getProject: () => project }: any));

      expect(result.output.success).toBe(true);
      expect(result.didModifyProject).toBe(false);
      const effects: Array<Object> = result.output.effects;
      // The test extensions register three known fake effects.
      expect(effects.length).toBeGreaterThanOrEqual(3);
      const sepia = effects.find(effect => effect.type === 'FakeSepia');
      expect(sepia).toBeTruthy();
      expect(sepia?.fullName).toBe('Fake Sepia Effect');
      expect(Array.isArray(sepia?.properties)).toBe(true);
      for (const effect of effects) {
        expect(typeof effect.type).toBe('string');
        expect(Array.isArray(effect.properties)).toBe(true);
        for (const property of effect.properties) {
          expect(typeof property.name).toBe('string');
          expect(typeof property.type).toBe('string');
        }
      }
    });

    it('narrows with the object filter', async () => {
      const tool = getTool('list_effects');
      const all = await tool.run({}, ({ getProject: () => project }: any));
      const objectOnly = await tool.run(
        { filter: 'object' },
        ({ getProject: () => project }: any)
      );

      const allCount = all.output.effects.length;
      const objectCount = objectOnly.output.effects.length;
      expect(objectCount).toBeGreaterThan(0);
      expect(objectCount).toBeLessThan(allCount);
      // FakeSepiaThatWouldWorkOnlyForLayers is the excluded one.
      expect(
        objectOnly.output.effects.find(
          (effect: Object) =>
            effect.type === 'FakeSepiaThatWouldWorkOnlyForLayers'
        )
      ).toBeUndefined();
    });

    it('keeps the output deterministic for the same project', () => {
      const first = listByokEffects(project, null);
      const second = listByokEffects(project, null);
      expect(first.map(effect => effect.type)).toEqual(
        second.map(effect => effect.type)
      );
    });

    it('narrows with the 2d and 3d filters through the tool', async () => {
      const tool = getTool('list_effects');
      const all = await tool.run({}, ({ getProject: () => project }: any));
      const only2d = await tool.run(
        { filter: '2d' },
        ({ getProject: () => project }: any)
      );
      const only3d = await tool.run(
        { filter: '3d' },
        ({ getProject: () => project }: any)
      );

      const allTypes = all.output.effects.map((effect: Object) => effect.type);
      const types2d = only2d.output.effects.map(
        (effect: Object) => effect.type
      );
      const types3d = only3d.output.effects.map(
        (effect: Object) => effect.type
      );
      // The filters only ever remove entries, never add or duplicate.
      for (const type of types2d) {
        expect(allTypes).toContain(type);
      }
      for (const type of types3d) {
        expect(allTypes).toContain(type);
      }
      expect(types2d.length).toBeLessThanOrEqual(allTypes.length);
      expect(types3d.length).toBeLessThanOrEqual(allTypes.length);
    });

    it('requires a project', async () => {
      const tool = getTool('list_effects');
      const result = await tool.run({}, ({ getProject: () => null }: any));

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('No project is open');
    });
  });
});

describe('ByokCatalogTools: Phase 12 public catalogs (fake fetchers)', () => {
  const gdCatalog: libGDevelop = global.gd;

  const makeFakeFetchers = () => ({
    listAllExamples: async () => [
      {
        slug: 'platformer',
        name: 'Platformer',
        shortDescription: 'A side-scrolling platformer',
        tags: ['platformer'],
        difficultyLevel: 'Beginner',
        license: 'MIT',
      },
      {
        slug: 'space-shooter',
        name: 'Space Shooter',
        shortDescription: 'Shoot asteroids in space',
        tags: ['shooter', 'space'],
        difficultyLevel: 'Intermediate',
        license: 'MIT',
      },
    ],
    getExample: async (header: any) => ({
      ...header,
      description: 'A full template description.',
      authors: ['GDevelop'],
    }),
    listAllPublicAssets: async () => [
      {
        id: 'asset-1',
        name: 'Coin',
        objectType: 'sprite',
        shortDescription: 'A spinning gold coin',
        tags: ['coin', 'pickups'],
        width: 32,
        height: 32,
        dominantColors: ['#FFD700'],
        previewImageUrls: ['https://example.com/coin.png'],
      },
      {
        id: 'asset-2',
        name: 'Gold Chest',
        objectType: 'sprite',
        shortDescription: 'A chest full of coins',
        tags: ['coin', 'chest'],
        width: 64,
        height: 64,
        dominantColors: [],
        previewImageUrls: [],
      },
      {
        id: 'asset-3',
        name: 'Explosion Sound',
        objectType: 'audio',
        shortDescription: 'Boom',
        tags: ['audio'],
        width: 0,
        height: 0,
        dominantColors: [],
        previewImageUrls: [],
      },
    ],
    getPublicAsset: async (header: any) => ({
      id: header.id,
      authors: [],
      objectAssets: [],
      resources: [],
    }),
    listAllResources: async () => [
      {
        name: 'Jump Sound',
        type: 'audio',
        url: 'https://example.com/sounds/jump.mp3',
        tags: ['jump'],
        license: 'CC0',
      },
      {
        name: 'Pixel Font',
        type: 'font',
        url: 'https://example.com/fonts/pixel.ttf',
        tags: ['pixel'],
        license: 'CC0',
      },
    ],
  });

  const makeOfflineFetchers = () => ({
    listAllExamples: async () => {
      throw new Error('network down');
    },
    getExample: async () => {
      throw new Error('network down');
    },
    listAllPublicAssets: async () => {
      throw new Error('network down');
    },
    getPublicAsset: async () => {
      throw new Error('network down');
    },
    listAllResources: async () => {
      throw new Error('network down');
    },
  });

  const getCatalogTool = (name: string): any =>
    getByokCatalogTools().find(tool => tool.name === name);

  afterEach(() => {
    setByokCatalogFetchersForTests(null);
  });

  it('registers the three Phase 12 tools', () => {
    expect(getCatalogTool('get_game_starter_summary')?.modifiesProject).toBe(
      false
    );
    expect(getCatalogTool('search_object_asset_store')?.modifiesProject).toBe(
      false
    );
    expect(getCatalogTool('search_resource_store')?.modifiesProject).toBe(
      false
    );
  });

  describe('get_game_starter_summary', () => {
    it('lists the catalog as compact headers', async () => {
      setByokCatalogFetchersForTests(makeFakeFetchers());
      const result = await getCatalogTool('get_game_starter_summary').run(
        {},
        ({ getProject: () => null }: any)
      );

      expect(result.output.success).toBe(true);
      expect(result.output.total).toBe(2);
      expect(result.output.starters).toHaveLength(2);
      expect(result.output.starters[0].slug).toBe('platformer');
      expect(result.output.starters[0].name).toBe('Platformer');
      expect(result.output.note).toContain('initialize_project');
    });

    it('summarizes one starter by slug (case-insensitive)', async () => {
      setByokCatalogFetchersForTests(makeFakeFetchers());
      const result = await getCatalogTool('get_game_starter_summary').run(
        { template_slug: 'Platformer' },
        ({ getProject: () => null }: any)
      );

      expect(result.output.success).toBe(true);
      expect(result.output.starter.slug).toBe('platformer');
      expect(result.output.starter.description).toBe(
        'A full template description.'
      );
      expect(result.output.note).toContain('initialize_project');
    });

    it('suggests near-miss slugs on an unknown slug', async () => {
      setByokCatalogFetchersForTests(makeFakeFetchers());
      const result = await getCatalogTool('get_game_starter_summary').run(
        { template_slug: 'platformer-game' },
        ({ getProject: () => null }: any)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('platformer');
    });

    it('fails with the explicit offline message', async () => {
      setByokCatalogFetchersForTests((makeOfflineFetchers(): any));
      const result = await getCatalogTool('get_game_starter_summary').run(
        {},
        ({ getProject: () => null }: any)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('could not be fetched');
      expect(result.output.message).toContain('offline');
    });
  });

  describe('search_object_asset_store', () => {
    it('ranks public assets by pertinence and trims the headers', async () => {
      setByokCatalogFetchersForTests(makeFakeFetchers());
      const result = await getCatalogTool('search_object_asset_store').run(
        { search_terms: 'coin' },
        ({ getProject: () => null }: any)
      );

      expect(result.output.success).toBe(true);
      expect(result.output.results.length).toBe(2);
      expect(result.output.results[0].name).toBe('Coin');
      expect(result.output.results[0].id).toBe('asset-1');
      expect(result.output.results[0].previewImageUrls).toHaveLength(1);
      expect(result.output.note).toContain('create_or_replace_object');
    });

    it('applies the object_type filter', async () => {
      setByokCatalogFetchersForTests(makeFakeFetchers());
      const result = await getCatalogTool('search_object_asset_store').run(
        { search_terms: 'explosion', object_type: 'audio' },
        ({ getProject: () => null }: any)
      );

      expect(result.output.results).toHaveLength(1);
      expect(result.output.results[0].name).toBe('Explosion Sound');
    });

    it('answers empty and offline without throwing', async () => {
      setByokCatalogFetchersForTests(makeFakeFetchers());
      const empty = await getCatalogTool('search_object_asset_store').run(
        { search_terms: 'nothing-matches-this' },
        ({ getProject: () => null }: any)
      );
      expect(empty.output.success).toBe(true);
      expect(empty.output.results).toEqual([]);

      setByokCatalogFetchersForTests((makeOfflineFetchers(): any));
      const offline = await getCatalogTool('search_object_asset_store').run(
        { search_terms: 'coin' },
        ({ getProject: () => null }: any)
      );
      expect(offline.output.success).toBe(false);
      expect(offline.output.message).toContain('could not be fetched');
    });
  });

  describe('search_resource_store', () => {
    it('returns audio and font hits with their direct urls', async () => {
      setByokCatalogFetchersForTests(makeFakeFetchers());
      const result = await getCatalogTool('search_resource_store').run(
        { search_terms: 'jump sound' },
        ({ getProject: () => null }: any)
      );

      expect(result.output.success).toBe(true);
      expect(result.output.results).toHaveLength(1);
      expect(result.output.results[0].url).toContain('jump.mp3');
      expect(result.output.note).toContain('import_project_resources');
    });

    it('filters by resource_type', async () => {
      setByokCatalogFetchersForTests(makeFakeFetchers());
      const result = await getCatalogTool('search_resource_store').run(
        { search_terms: 'pixel', resource_type: 'font' },
        ({ getProject: () => null }: any)
      );

      expect(result.output.results).toHaveLength(1);
      expect(result.output.results[0].type).toBe('font');
    });
  });

  describe('the headless install collaborators', () => {
    let project: gdProject;

    beforeEach(() => {
      project = gdCatalog.ProjectHelper.createNewGDJSProject();
    });

    afterEach(() => {
      project.delete();
    });

    it('byokSearchAndInstallResources registers hits by URL with the store origin', async () => {
      setByokCatalogFetchersForTests(makeFakeFetchers());
      const result = await byokSearchAndInstallResources(
        {
          resources: [
            { resourceName: 'Jump Sound', resourceKind: 'audio' },
            { resourceName: 'Beep Boop Melody', resourceKind: 'audio' },
          ],
        },
        { project }
      );

      expect(result.results).toEqual([
        {
          resourceName: 'Jump Sound',
          resourceKind: 'audio',
          status: 'resource-installed',
        },
        {
          resourceName: 'Beep Boop Melody',
          resourceKind: 'audio',
          status: 'nothing-found',
        },
      ]);
      const resource = project.getResourcesManager().getResource('Jump Sound');
      expect(resource.getFile()).toContain('jump.mp3');
      expect(resource.getOriginName()).toBe('gdevelop-asset-store');

      // A second install of the same name dedupes.
      const again = await byokSearchAndInstallResources(
        { resources: [{ resourceName: 'Jump Sound', resourceKind: 'audio' }] },
        { project }
      );
      expect(again.results[0].status).toBe('resource-already-exists');
    });

    it('byokSearchAndInstallAsset installs the best public match', async () => {
      const fetchers = makeFakeFetchers();
      // A real serialized sprite object for addAssetToProject to unserialize.
      const layout = project.insertNewLayout('Scene', 0);
      const object = layout
        .getObjects()
        .insertNewObject(project, 'Sprite', 'TemplateCoin', 0);
      const { serializeToJSObject } = require('../../Utils/Serializer');
      const serializedObject = serializeToJSObject(object);
      (fetchers: any).getPublicAsset = async () => ({
        id: 'asset-1',
        authors: [],
        objectAssets: [
          { object: serializedObject, resources: [], requiredExtensions: [] },
        ],
      });
      setByokCatalogFetchersForTests(fetchers);
      const ensured: Array<string> = [];

      const result = await byokSearchAndInstallAsset(
        {
          objectsContainer: layout.getObjects(),
          objectName: 'Coin',
          objectType: null,
          searchTerms: 'gold coin',
          description: '',
        },
        {
          project,
          ensureExtensionInstalled: async ({ extensionName }) => {
            ensured.push(extensionName);
          },
        }
      );

      if (result.status !== 'asset-installed') throw new Error(result.message);
      expect(result.status).toBe('asset-installed');
      expect(result.assetShortHeader.id).toBe('asset-1');
      expect(result.createdObjects.length).toBe(1);
      expect(result.createdObjects[0].getName()).toBe('Coin');
      expect(ensured).toEqual([]);
      expect(layout.getObjects().hasObjectNamed('Coin')).toBe(true);
    });

    it('byokSearchAndInstallAsset answers nothing-found and offline as values', async () => {
      setByokCatalogFetchersForTests(makeFakeFetchers());
      const nothing = await byokSearchAndInstallAsset(
        {
          objectsContainer: null,
          objectName: 'Ghost',
          objectType: null,
          searchTerms: 'nothing-matches-this',
          description: '',
        },
        {
          project,
          ensureExtensionInstalled: async () => {},
        }
      );
      expect(nothing.status).toBe('nothing-found');

      setByokCatalogFetchersForTests((makeOfflineFetchers(): any));
      const offline = await byokSearchAndInstallAsset(
        {
          objectsContainer: null,
          objectName: 'Coin',
          objectType: null,
          searchTerms: 'coin',
          description: '',
        },
        {
          project,
          ensureExtensionInstalled: async () => {},
        }
      );
      expect(offline.status).toBe('error');
      expect(offline.message).toContain('could not be fetched');
    });
  });
});
