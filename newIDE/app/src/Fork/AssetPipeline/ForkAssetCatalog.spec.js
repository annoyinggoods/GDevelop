// @flow
import {
  FORK_ASSET_COMPLETION_FILE_PATH,
  FORK_ASSET_KNOWLEDGE_MAX_ENTRIES,
  buildForkAssetCatalog,
  buildForkAssetCompletionEntries,
  buildForkAssetKnowledgeBlock,
  clearForkAssetCompletionCatalog,
  getForkAssetCompletionEntries,
  setForkAssetCompletionCatalog,
} from './ForkAssetCatalog';
import { setForkResourceTags } from './ForkAssetTagStore';

const gd: libGDevelop = global.gd;

const makeEntry = (
  name: string,
  kind: string = 'image',
  tags: Array<string> = [],
  file: string = name
) => ({ name, kind, file, tags });

describe('buildForkAssetCatalog', () => {
  it('lists every resource with its real name, kind, file and tags', () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    try {
      const image = new gd.ImageResource();
      image.setName('hero.png');
      image.setFile('art/hero.png');
      project.getResourcesManager().addResource(image);
      image.delete();
      const stored = project.getResourcesManager().getResource('hero.png');
      setForkResourceTags({ resource: stored, tags: ['Enemy', 'red'] });

      const audio = new gd.AudioResource();
      audio.setName('jump.wav');
      audio.setFile('jump.wav');
      project.getResourcesManager().addResource(audio);
      audio.delete();

      const catalog = buildForkAssetCatalog(project);
      expect(catalog).toEqual([
        makeEntry('hero.png', 'image', ['enemy', 'red'], 'art/hero.png'),
        makeEntry('jump.wav', 'audio', [], 'jump.wav'),
      ]);
    } finally {
      project.delete();
    }
  });

  it('is empty for a missing project', () => {
    expect(buildForkAssetCatalog(null)).toEqual([]);
  });
});

describe('buildForkAssetCompletionEntries', () => {
  it('produces an addExtraLib-shaped entry quoting every name, with tags', () => {
    const entries = buildForkAssetCompletionEntries([
      makeEntry('hero.png', 'image', ['enemy', 'red']),
      makeEntry('player/jump', 'audio'),
    ]);

    expect(entries).toHaveLength(1);
    const lib = entries[0];
    expect(lib.filePath).toBe(FORK_ASSET_COMPLETION_FILE_PATH);
    expect(lib.content).toContain('declare const forkAssets: {');
    // Quoted property keys keep slash/dot names valid.
    expect(lib.content).toContain('readonly "hero.png": string;');
    expect(lib.content).toContain('readonly "player/jump": string;');
    expect(lib.content).toContain('image — tags: enemy, red');
  });

  it('emits NO ES import statement and NO @assets/ module specifier', () => {
    const entries = buildForkAssetCompletionEntries([
      makeEntry('hero.png'),
      makeEntry('player/jump', 'audio'),
      makeEntry('weird "quoted".png'),
    ]);
    for (const lib of entries) {
      // No import/require STATEMENTS (a prose mention of the prohibition
      // in the doc comment is fine).
      expect(/^\s*import[\s{'"]/m.test(lib.content)).toBe(false);
      expect(/^\s*import\s/m.test(lib.content)).toBe(false);
      expect(/^\s*require\(/m.test(lib.content)).toBe(false);
      expect(lib.content).not.toContain('@assets/');
      expect(lib.content).not.toContain("from '");
      expect(lib.content).not.toContain('from "');
    }
  });

  it('dedupes by name and skips unusable names', () => {
    const entries = buildForkAssetCompletionEntries([
      makeEntry('hero.png'),
      makeEntry('hero.png'),
      makeEntry('bad\u0007name.png'),
      makeEntry(''),
    ]);
    expect(entries[0].content.match(/readonly /g) || []).toHaveLength(1);
  });
});

describe('buildForkAssetKnowledgeBlock', () => {
  it('groups by kind with tags in parens', () => {
    const block = buildForkAssetKnowledgeBlock([
      makeEntry('hero.png', 'image', ['red']),
      makeEntry('jump.wav', 'audio'),
      makeEntry('enemy.png', 'image'),
    ]);
    expect(block.split('\n')).toEqual([
      'Assets (by resource NAME, never a file path):',
      '- audio: jump.wav',
      '- image: hero.png (red), enemy.png',
    ]);
  });

  it('caps a 500-resource catalog with an honest overflow line', () => {
    const catalog = [];
    for (let index = 0; index < 500; index++) {
      catalog.push(makeEntry(`a${index}.png`));
    }
    const block = buildForkAssetKnowledgeBlock(catalog);
    const listed = (block.match(/a\d+\.png/g) || []).length;
    expect(listed).toBe(FORK_ASSET_KNOWLEDGE_MAX_ENTRIES);
    expect(block).toContain('… and 380 more');
  });

  it('answers honestly for an empty project', () => {
    expect(buildForkAssetKnowledgeBlock([])).toContain(
      'No resources are registered'
    );
  });
});

describe('the completion feed (the editor hook source)', () => {
  afterEach(() => {
    clearForkAssetCompletionCatalog();
  });

  it('registers and clears the current entries', () => {
    expect(getForkAssetCompletionEntries()).toEqual([]);
    setForkAssetCompletionCatalog([makeEntry('hero.png')]);
    const entries = getForkAssetCompletionEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain('"hero.png"');
    clearForkAssetCompletionCatalog();
    expect(getForkAssetCompletionEntries()).toEqual([]);
  });
});
