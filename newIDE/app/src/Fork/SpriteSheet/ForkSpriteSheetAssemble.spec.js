// @flow
import optionalRequire from '../../Utils/OptionalRequire';
import { assembleForkSpriteSheetAnimation } from './ForkSpriteSheetAssemble';
import type { ByokResourceImportDeps } from '../../AiGeneration/Byok/ByokResourceTools';

const path = (optionalRequire('path'): any);

const gd: libGDevelop = global.gd;

const PROJECT_FILE = path.resolve('/projects/game/game.json');
const PROJECT_FOLDER = path.dirname(PROJECT_FILE);
const ASSETS_FOLDER = path.join(PROJECT_FOLDER, 'MyGameAssets');

/** An in-memory fs: existsSync over a Set of existing paths. */
const makeFakeFs = (existingPaths: Array<string> = []) => {
  const existing = new Set(
    existingPaths.map(filePath => path.resolve(filePath))
  );
  return {
    existsSync: (filePath: string) => existing.has(path.resolve(filePath)),
    copyFile: async () => {
      throw new Error('copyFile must not be called for in-project frames');
    },
  };
};

const makeDeps = (fs: any): ByokResourceImportDeps => ({
  fs,
  pathLib: path,
  downloadFile: async () => {
    throw new Error('downloads must not be part of sprite-sheet assembly');
  },
});

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setProjectFile(PROJECT_FILE);
  const layout = project.insertNewLayout('TestScene', 0);
  layout.getObjects().insertNewObject(project, 'Sprite', 'Player', 0);
  layout.getObjects().insertNewObject(project, 'TextObject::Text', 'Label', 0);
  return project;
};

const makeFramePaths = (count: number): Array<string> =>
  Array.from({ length: count }, (_, index) =>
    path.join(ASSETS_FOLDER, `Player_Run_${index}.png`)
  );

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

const findAnimation = (animations: any, name: string) => {
  for (let index = 0; index < animations.getAnimationsCount(); index++) {
    if (animations.getAnimation(index).getName() === name) {
      return animations.getAnimation(index);
    }
  }
  return null;
};

/** The first direction of a named animation — fails the test when missing. */
const getDirectionOfAnimation = (animations: any, name: string) => {
  const animation = findAnimation(animations, name);
  if (!animation) throw new Error(`the animation "${name}" was not created`);
  return animation.getDirection(0);
};

/** The Upstream fixture pattern: seed an animation with named frames. */
const seedAnimation = (
  animations: any,
  name: string,
  imageNames: Array<string>
) => {
  const animation = new gd.Animation();
  animation.setName(name);
  animation.setDirectionsCount(1);
  const direction = animation.getDirection(0);
  for (const imageName of imageNames) {
    const sprite = new gd.Sprite();
    sprite.setImageName(imageName);
    direction.addSprite(sprite);
    sprite.delete();
  }
  animations.addAnimation(animation);
  animation.delete();
};

describe('assembleForkSpriteSheetAnimation', () => {
  let project: any;

  beforeEach(() => {
    project = makeProject();
  });

  afterEach(() => {
    project.delete();
  });

  it('creates the animation with the frames in order, timing 1/fps', async () => {
    const framePaths = makeFramePaths(3);
    const result = await assembleForkSpriteSheetAnimation({
      project,
      objectName: 'Player',
      animationName: 'Run',
      frameAbsolutePaths: framePaths,
      fps: 10,
      loop: true,
      deps: makeDeps(makeFakeFs(framePaths)),
    });

    expect(result.didModifyProject).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.frameCount).toBe(3);
    expect(result.resourceNames).toEqual([
      'Player_Run_0.png',
      'Player_Run_1.png',
      'Player_Run_2.png',
    ]);

    const animation = findAnimation(getAnimations(project), 'Run');
    if (!animation) throw new Error('the animation was not created');
    const direction = animation.getDirection(0);
    // The frames are exactly the given ones, IN ORDER (D19-6 row-major).
    expect(direction.getSpritesCount()).toBe(3);
    expect(direction.getSprite(0).getImageName()).toBe('Player_Run_0.png');
    expect(direction.getSprite(1).getImageName()).toBe('Player_Run_1.png');
    expect(direction.getSprite(2).getImageName()).toBe('Player_Run_2.png');
    // D19-8: the timing lives on the Direction.
    expect(direction.getTimeBetweenFrames()).toBeCloseTo(1 / 10, 10);
    expect(direction.isLooping()).toBe(true);
  });

  it('registers every frame as a project resource pointing at the file', async () => {
    const framePaths = makeFramePaths(2);
    await assembleForkSpriteSheetAnimation({
      project,
      objectName: 'Player',
      animationName: 'Run',
      frameAbsolutePaths: framePaths,
      fps: 8,
      loop: false,
      deps: makeDeps(makeFakeFs(framePaths)),
    });

    const manager = project.getResourcesManager();
    for (const name of ['Player_Run_0.png', 'Player_Run_1.png']) {
      expect(manager.hasResource(name)).toBe(true);
      // Registered IN PLACE: the project-relative path of the frame file.
      expect(manager.getResource(name).getFile()).toBe(`MyGameAssets/${name}`);
      expect(manager.getResource(name).getKind()).toBe('image');
    }
    // loop: false is written to the direction too.
    const direction = getDirectionOfAnimation(getAnimations(project), 'Run');
    expect(direction.isLooping()).toBe(false);
  });

  it('appends into an existing animation without destroying its frames', async () => {
    seedAnimation(getAnimations(project), 'Idle', [
      'stand-0.png',
      'stand-1.png',
    ]);
    const framePaths = makeFramePaths(2);

    const result = await assembleForkSpriteSheetAnimation({
      project,
      objectName: 'Player',
      animationName: 'Idle',
      frameAbsolutePaths: framePaths,
      fps: 5,
      loop: true,
      deps: makeDeps(makeFakeFs(framePaths)),
    });

    expect(result.didModifyProject).toBe(true);
    const direction = getDirectionOfAnimation(getAnimations(project), 'Idle');
    // The existing frames come first, the appended ones after them.
    expect(direction.getSpritesCount()).toBe(4);
    expect(direction.getSprite(0).getImageName()).toBe('stand-0.png');
    expect(direction.getSprite(1).getImageName()).toBe('stand-1.png');
    expect(direction.getSprite(2).getImageName()).toBe('Player_Run_0.png');
    expect(direction.getSprite(3).getImageName()).toBe('Player_Run_1.png');
    // The timing of the appended run is applied to the direction.
    expect(direction.getTimeBetweenFrames()).toBeCloseTo(1 / 5, 10);
  });

  it('reuses resources that already point at the same frame files', async () => {
    const framePaths = makeFramePaths(1);
    // A first run registers the resource; a second run over the same files
    // hits "already-exists" with the SAME file and must reuse it.
    const deps = makeDeps(makeFakeFs(framePaths));
    await assembleForkSpriteSheetAnimation({
      project,
      objectName: 'Player',
      animationName: 'Run',
      frameAbsolutePaths: framePaths,
      fps: 10,
      loop: true,
      deps,
    });
    const result = await assembleForkSpriteSheetAnimation({
      project,
      objectName: 'Player',
      animationName: 'Run2',
      frameAbsolutePaths: framePaths,
      fps: 10,
      loop: true,
      deps,
    });

    expect(result.errors).toEqual([]);
    expect(result.didModifyProject).toBe(true);
    expect(result.resourceNames).toEqual(['Player_Run_0.png']);
    const direction = getDirectionOfAnimation(getAnimations(project), 'Run2');
    expect(direction.getSpritesCount()).toBe(1);
  });

  it('refuses a resource-name collision pointing at another file', async () => {
    const framePaths = makeFramePaths(1);
    // An existing resource named like the frame but pointing elsewhere:
    // reusing it would show the wrong image.
    const resource = new gd.ImageResource();
    resource.setName('Player_Run_0.png');
    resource.setFile('somewhere-else.png');
    project.getResourcesManager().addResource(resource);
    resource.delete();

    const before = serializeProject(project);
    const result = await assembleForkSpriteSheetAnimation({
      project,
      objectName: 'Player',
      animationName: 'Run',
      frameAbsolutePaths: framePaths,
      fps: 10,
      loop: true,
      deps: makeDeps(makeFakeFs(framePaths)),
    });

    expect(result.didModifyProject).toBe(false);
    expect(result.errors.length).toBe(1);
    // The pre-existing resource is untouched.
    expect(serializeProject(project)).toBe(before);
    expect(
      project
        .getResourcesManager()
        .getResource('Player_Run_0.png')
        .getFile()
    ).toBe('somewhere-else.png');
  });

  it('rolls back its registrations when a frame file is missing', async () => {
    const framePaths = makeFramePaths(2);
    // Frame 0 exists, frame 1 does not: registration fails halfway and the
    // whole call must leave the project exactly as it was.
    const deps = makeDeps(makeFakeFs([framePaths[0]]));
    const before = serializeProject(project);

    const result = await assembleForkSpriteSheetAnimation({
      project,
      objectName: 'Player',
      animationName: 'Run',
      frameAbsolutePaths: framePaths,
      fps: 10,
      loop: true,
      deps,
    });

    expect(result.didModifyProject).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('File not found');
    expect(serializeProject(project)).toBe(before);
    expect(project.getResourcesManager().hasResource('Player_Run_0.png')).toBe(
      false
    );
  });

  it('refuses an unknown object with nothing mutated', async () => {
    const framePaths = makeFramePaths(1);
    const deps = makeDeps(makeFakeFs(framePaths));
    const before = serializeProject(project);

    const result = await assembleForkSpriteSheetAnimation({
      project,
      objectName: 'Ghost',
      animationName: 'Run',
      frameAbsolutePaths: framePaths,
      fps: 10,
      loop: true,
      deps,
    });

    expect(result.didModifyProject).toBe(false);
    expect(result.errors[0]).toContain('Object not found');
    expect(serializeProject(project)).toBe(before);
  });

  it('refuses a non-Sprite object with nothing mutated', async () => {
    const framePaths = makeFramePaths(1);
    const deps = makeDeps(makeFakeFs(framePaths));
    const before = serializeProject(project);

    const result = await assembleForkSpriteSheetAnimation({
      project,
      objectName: 'Label',
      animationName: 'Run',
      frameAbsolutePaths: framePaths,
      fps: 10,
      loop: true,
      deps,
    });

    expect(result.didModifyProject).toBe(false);
    expect(result.errors[0]).toContain('not "Sprite"');
    expect(serializeProject(project)).toBe(before);
  });

  it('refuses invalid arguments before touching the project', async () => {
    const framePaths = makeFramePaths(1);
    const deps = makeDeps(makeFakeFs(framePaths));
    const before = serializeProject(project);

    const refusals = [
      await assembleForkSpriteSheetAnimation({
        project,
        objectName: 'Player',
        animationName: 'Run',
        frameAbsolutePaths: [],
        fps: 10,
        loop: true,
        deps,
      }),
      await assembleForkSpriteSheetAnimation({
        project,
        objectName: 'Player',
        animationName: 'Run',
        frameAbsolutePaths: framePaths,
        fps: 0,
        loop: true,
        deps,
      }),
      await assembleForkSpriteSheetAnimation({
        project,
        objectName: 'Player',
        animationName: '',
        frameAbsolutePaths: framePaths,
        fps: 10,
        loop: true,
        deps,
      }),
    ];
    for (const result of refusals) {
      expect(result.didModifyProject).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(serializeProject(project)).toBe(before);
  });
});
