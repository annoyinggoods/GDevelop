// @flow
import {
  serializeToJSON,
  unserializeFromJSObject,
} from '../../Utils/Serializer';
import {
  applyForkAssetTagsToProject,
  getForkResourceTags,
  setForkResourceTags,
} from './ForkAssetTagStore';

const gd: libGDevelop = global.gd;

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setProjectFile('C:/projects/game/game.json');
  return project;
};

const addImageResource = (project: any, name: string, file: string) => {
  const resource = new gd.ImageResource();
  resource.setName(name);
  resource.setFile(file);
  project.getResourcesManager().addResource(resource);
  resource.delete();
  return project.getResourcesManager().getResource(name);
};

/** A save/reload round-trip through the real serializer. */
const reloadProject = (project: any) => {
  const serialized = serializeToJSON(project);
  const reloaded = gd.ProjectHelper.createNewGDJSProject();
  unserializeFromJSObject(reloaded, JSON.parse(serialized));
  return reloaded;
};

describe('setForkResourceTags', () => {
  it('writes tags into the metadata and ONLY into the metadata', () => {
    const project = makeProject();
    try {
      const resource = addImageResource(project, 'hero.png', 'hero.png');
      resource.setMetadata(
        JSON.stringify({ localFilePath: 'C:/x/hero.png', extension: 'png' })
      );
      const before = {
        name: resource.getName(),
        file: resource.getFile(),
        kind: resource.getKind(),
      };

      const result = setForkResourceTags({
        resource,
        tags: ['  Enemy ', 'red'],
      });

      expect(result.refusedTags).toEqual([]);
      expect(result.didChangeMetadata).toBe(true);
      expect(getForkResourceTags(resource)).toEqual(['enemy', 'red']);

      // Nothing but the metadata string moved.
      expect(resource.getName()).toBe(before.name);
      expect(resource.getFile()).toBe(before.file);
      expect(resource.getKind()).toBe(before.kind);
      const metadata = JSON.parse(resource.getMetadata());
      expect(metadata.localFilePath).toBe('C:/x/hero.png');
      expect(metadata.extension).toBe('png');
    } finally {
      project.delete();
    }
  });

  it('survives a save/reload round-trip of the project (real gd classes)', () => {
    const project = makeProject();
    try {
      const resource = addImageResource(project, 'hero.png', 'hero.png');
      setForkResourceTags({ resource, tags: ['enemy', 'red'] });

      const reloaded = reloadProject(project);
      try {
        const reloadedResource = reloaded
          .getResourcesManager()
          .getResource('hero.png');
        expect(getForkResourceTags(reloadedResource)).toEqual(['enemy', 'red']);
      } finally {
        reloaded.delete();
      }
    } finally {
      project.delete();
    }
  });

  it('reports refused tags instead of silently dropping them', () => {
    const project = makeProject();
    try {
      const resource = addImageResource(project, 'hero.png', 'hero.png');
      const result = setForkResourceTags({
        resource,
        tags: ['ok', '', 'bad\u0001tag', 'art/enemy'],
      });

      expect(result.tags).toEqual(['ok']);
      expect(result.refusedTags).toEqual([
        { input: '', reason: 'empty' },
        { input: 'bad\u0001tag', reason: 'control-characters' },
        { input: 'art/enemy', reason: 'path-separator' },
      ]);
    } finally {
      project.delete();
    }
  });

  it('de-duplicates repeated tags and reports a no-op write honestly', () => {
    const project = makeProject();
    try {
      const resource = addImageResource(project, 'hero.png', 'hero.png');
      setForkResourceTags({ resource, tags: ['enemy', 'enemy'] });
      expect(getForkResourceTags(resource)).toEqual(['enemy']);

      const secondWrite = setForkResourceTags({ resource, tags: ['enemy'] });
      expect(secondWrite.didChangeMetadata).toBe(false);
      expect(secondWrite.tags).toEqual(['enemy']);
    } finally {
      project.delete();
    }
  });

  it('also works against a faithful fake resource object', () => {
    const metadataHolder = { metadata: '' };
    const fakeResource = {
      getMetadata: () => metadataHolder.metadata,
      setMetadata: (value: string) => {
        metadataHolder.metadata = value;
      },
    };
    setForkResourceTags({ resource: fakeResource, tags: ['Enemy'] });
    expect(JSON.parse(metadataHolder.metadata)).toEqual({ tags: ['enemy'] });
    expect(getForkResourceTags(fakeResource)).toEqual(['enemy']);
  });
});

describe('applyForkAssetTagsToProject', () => {
  it('applies a batch and reports whether anything changed', () => {
    const project = makeProject();
    try {
      const hero = addImageResource(project, 'hero.png', 'hero.png');
      const enemy = addImageResource(project, 'enemy.png', 'enemy.png');
      setForkResourceTags({ resource: enemy, tags: ['enemy'] });

      const batch = applyForkAssetTagsToProject(project, [
        { resource: hero, tags: ['player'] },
        { resource: enemy, tags: ['enemy'] },
      ]);

      expect(batch.results).toHaveLength(2);
      expect(batch.didChangeAnyMetadata).toBe(true);
      expect(getForkResourceTags(hero)).toEqual(['player']);

      const noOpBatch = applyForkAssetTagsToProject(project, [
        { resource: hero, tags: ['player'] },
      ]);
      expect(noOpBatch.didChangeAnyMetadata).toBe(false);
    } finally {
      project.delete();
    }
  });
});
