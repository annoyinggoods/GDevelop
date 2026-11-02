// @flow
import {
  listForkPipelineAssets,
  setForkPipelineAssetTags,
} from './ForkAssetToolsHandlers';
import { buildForkAssetTree } from './ForkAssetTree';
import { setForkResourceTags } from './ForkAssetTagStore';

const gd: libGDevelop = global.gd;

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setProjectFile('C:/projects/game/game.json');
  return project;
};

const addTaggedResource = (
  project: any,
  name: string,
  kind: 'image' | 'audio',
  tags: Array<string>
) => {
  const resource =
    kind === 'image' ? new gd.ImageResource() : new gd.AudioResource();
  resource.setName(name);
  resource.setFile(name);
  project.getResourcesManager().addResource(resource);
  resource.delete();
  setForkResourceTags({
    resource: project.getResourcesManager().getResource(name),
    tags,
  });
};

const makePopulatedProject = () => {
  const project = makeProject();
  addTaggedResource(project, 'zeta.png', 'image', ['boss']);
  addTaggedResource(project, 'alpha.png', 'image', ['enemy', 'red']);
  addTaggedResource(project, 'beta.wav', 'audio', ['enemy']);
  addTaggedResource(project, 'lonely.png', 'image', []);
  return project;
};

describe('listForkPipelineAssets', () => {
  it('lists everything, sorted by name, with kind/file/tags', () => {
    const project = makePopulatedProject();
    try {
      const result = listForkPipelineAssets({ project });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.assets.map(asset => asset.name)).toEqual([
        'alpha.png',
        'beta.wav',
        'lonely.png',
        'zeta.png',
      ]);
      expect(result.matchedCount).toBe(4);
      expect(result.assets[1]).toEqual({
        name: 'beta.wav',
        kind: 'audio',
        file: 'beta.wav',
        tags: ['enemy'],
      });
    } finally {
      project.delete();
    }
  });

  it('with a tag filter returns EXACTLY what the 17.1 tree groups under it', () => {
    const project = makePopulatedProject();
    try {
      const listing = listForkPipelineAssets({ project, tag: 'enemy' });
      expect(listing.ok).toBe(true);

      const tree = buildForkAssetTree({
        resources: listForkPipelineAssets({ project }).ok
          ? (listForkPipelineAssets({ project }): any).assets
          : [],
      });
      const enemyFolder = tree.find(
        item => item.kind === 'tag' && item.tagName === 'enemy'
      );
      const treeNames =
        enemyFolder && enemyFolder.kind === 'tag'
          ? enemyFolder.children.map(child => child.name)
          : [];

      if (!listing.ok) throw new Error('expected ok');
      expect(listing.assets.map(asset => asset.name)).toEqual(treeNames);
      expect(listing.matchedCount).toBe(2);
    } finally {
      project.delete();
    }
  });

  it('normalizes the tag filter and answers untaggedOnly', () => {
    const project = makePopulatedProject();
    try {
      const normalized = listForkPipelineAssets({ project, tag: '  ENEMY ' });
      expect(normalized.ok).toBe(true);
      if (normalized.ok) expect(normalized.matchedCount).toBe(2);

      const untagged = listForkPipelineAssets({
        project,
        untaggedOnly: true,
      });
      expect(untagged.ok).toBe(true);
      if (untagged.ok) {
        expect(untagged.assets.map(asset => asset.name)).toEqual([
          'lonely.png',
        ]);
      }
    } finally {
      project.delete();
    }
  });

  it('refuses an invalid tag filter or a missing project without throwing', () => {
    const project = makePopulatedProject();
    try {
      const refused = listForkPipelineAssets({ project, tag: 'art/enemy' });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toContain('not a valid tag');

      expect(listForkPipelineAssets({ project: null }).ok).toBe(false);
    } finally {
      project.delete();
    }
  });
});

describe('setForkPipelineAssetTags', () => {
  it('set / merge / remove / clear all take effect through the store', () => {
    const project = makePopulatedProject();
    try {
      const set = setForkPipelineAssetTags({
        project,
        assetNames: ['alpha.png'],
        tags: ['solo'],
        mode: 'set',
      });
      expect(set.ok).toBe(true);
      if (set.ok) {
        expect(set.updated).toEqual([{ name: 'alpha.png', tags: ['solo'] }]);
      }

      const merge = setForkPipelineAssetTags({
        project,
        assetNames: ['alpha.png'],
        tags: ['Extra'],
        mode: 'merge',
      });
      expect(merge.ok).toBe(true);
      if (merge.ok) {
        expect(merge.updated[0].tags).toEqual(['solo', 'extra']);
      }

      const remove = setForkPipelineAssetTags({
        project,
        assetNames: ['alpha.png'],
        tags: ['solo'],
        mode: 'remove',
      });
      expect(remove.ok).toBe(true);
      if (remove.ok) {
        expect(remove.updated[0].tags).toEqual(['extra']);
      }

      const clear = setForkPipelineAssetTags({
        project,
        assetNames: ['alpha.png'],
        tags: ['ignored-in-clear'],
        mode: 'clear',
      });
      expect(clear.ok).toBe(true);
      if (clear.ok) {
        expect(clear.updated[0].tags).toEqual([]);
      }
    } finally {
      project.delete();
    }
  });

  it('writes several assets in one call', () => {
    const project = makePopulatedProject();
    try {
      const result = setForkPipelineAssetTags({
        project,
        assetNames: ['alpha.png', 'beta.wav'],
        tags: ['wave-2'],
        mode: 'merge',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.updated).toHaveLength(2);
      const listing = listForkPipelineAssets({ project, tag: 'wave-2' });
      if (!listing.ok) throw new Error('expected ok');
      expect(listing.matchedCount).toBe(2);
    } finally {
      project.delete();
    }
  });

  it('refuses an invalid tag ATOMICALLY (no partial write)', () => {
    const project = makePopulatedProject();
    try {
      const refused = setForkPipelineAssetTags({
        project,
        assetNames: ['alpha.png', 'beta.wav'],
        tags: ['ok-tag', 'bad/tag'],
        mode: 'set',
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.invalidTags).toEqual(['bad/tag']);
        expect(refused.error).toContain('bad/tag');
      }
      // Nothing was written.
      const listing = listForkPipelineAssets({ project, tag: 'ok-tag' });
      if (!listing.ok) throw new Error('expected ok');
      expect(listing.matchedCount).toBe(0);
      expect(listForkPipelineAssets({ project, tag: 'enemy' }).ok).toBe(true);
    } finally {
      project.delete();
    }
  });

  it('refuses unknown asset names, listing them, without writing', () => {
    const project = makePopulatedProject();
    try {
      const refused = setForkPipelineAssetTags({
        project,
        assetNames: ['alpha.png', 'ghost.png'],
        tags: ['never-written'],
        mode: 'merge',
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.unknownAssets).toEqual(['ghost.png']);
      }
      const listing = listForkPipelineAssets({
        project,
        tag: 'never-written',
      });
      if (!listing.ok) throw new Error('expected ok');
      expect(listing.matchedCount).toBe(0);
    } finally {
      project.delete();
    }
  });

  it('never throws on a broken input shape or a missing project', () => {
    const project = makePopulatedProject();
    try {
      expect(
        setForkPipelineAssetTags({
          project: null,
          assetNames: ['a'],
          tags: [],
          mode: 'set',
        }).ok
      ).toBe(false);
      expect(
        setForkPipelineAssetTags({
          project,
          assetNames: (null: any),
          tags: (null: any),
          mode: 'clear',
        }).ok
      ).toBe(true);
    } finally {
      project.delete();
    }
  });
});
