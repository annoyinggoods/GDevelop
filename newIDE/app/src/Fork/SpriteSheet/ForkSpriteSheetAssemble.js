// @flow

/**
 * Phase 19.3 — assemble the sliced frames into a sprite animation (D19-6).
 *
 * Registers each frame file as a project image resource — in place, through
 * the canonical BYOK importer `importByokProjectResources` (D19-3: absolute
 * paths inside the project folder register without a copy) — then appends
 * (or creates) the target animation on the object's sprite configuration,
 * mirroring the exact upstream wrapper-ownership sequence of
 * `AnimationList.js` / `SpritesList.js`:
 *
 *   new gd.Animation() → setName + setDirectionsCount(1) → getDirection(0)
 *   → per frame: new gd.Sprite() → setImageName(resourceName) →
 *   direction.addSprite(sprite) → sprite.delete() (the container copied it)
 *   → direction.setTimeBetweenFrames(1/fps) + setLoop(loop) →
 *   animations.addAnimation(animation) → animation.delete() (ownership
 *   passed to the container — an un-deleted wrapper leaks WASM memory).
 *
 * Validate-then-mutate (the audit100226 lesson): the object lookup, the
 * sprite cast, the fps and the frame list are ALL checked before anything
 * is touched. If a frame registration fails, the resources this call had
 * registered are rolled back so a refusal leaves the project exactly as it
 * was. The function is async because `importByokProjectResources` is —
 * await it (this is the one deviation from the skeleton's synchronous
 * return type; see the phase worklog).
 */

import optionalRequire from '../../Utils/OptionalRequire';
import {
  importByokProjectResources,
  type ByokResourceImportDeps,
  type ByokResourceImportEntry,
  type ByokResourceImportEntryResult,
} from '../../AiGeneration/Byok/ByokResourceTools';

const gd: libGDevelop = global.gd;

export type ForkSpriteSheetAssembleResult = {|
  didModifyProject: boolean,
  animationName: string,
  frameCount: number,
  resourceNames: Array<string>,
  errors: Array<string>,
|};

/**
 * The importer deps (injected for the specs; the default builder uses the
 * node modules, and answers null outside the desktop app).
 */
export type ForkSpriteSheetAssembleDeps = ByokResourceImportDeps;

const describeError = (error: mixed): string =>
  error instanceof Error ? error.message : String(error);

const makeErrorResult = (
  animationName: mixed,
  errors: Array<string>
): ForkSpriteSheetAssembleResult => ({
  didModifyProject: false,
  animationName: String(animationName || ''),
  frameCount: 0,
  resourceNames: [],
  errors,
});

const makeDefaultForkSpriteSheetAssembleDeps = (): ?ForkSpriteSheetAssembleDeps => {
  const fs = optionalRequire('fs-extra');
  const pathLib = optionalRequire('path');
  if (!fs || !pathLib) return null;
  return {
    fs,
    pathLib,
    // Frame files are absolute in-project paths: URL downloads are not part
    // of sprite-sheet assembly, and the importer only calls this for URLs.
    downloadFile: async () => {
      throw new Error('Downloads are not part of sprite-sheet assembly.');
    },
  };
};

/**
 * Find an object by name anywhere in the project: scene objects first
 * (in declaration order), then the global objects — the resolution order
 * `resolveByokSpriteConfiguration` established for the sprite tools.
 */
const findObjectAnywhere = (project: any, objectName: string): any | null => {
  for (let index = 0; index < project.getLayoutsCount(); index++) {
    const objects = project.getLayoutAt(index).getObjects();
    if (objects.hasObjectNamed(objectName)) {
      return objects.getObject(objectName);
    }
  }
  const globalObjects = project.getObjects();
  if (globalObjects.hasObjectNamed(objectName)) {
    return globalObjects.getObject(objectName);
  }
  return null;
};

const findAnimationByName = (animations: any, name: string): any | null => {
  for (let index = 0; index < animations.getAnimationsCount(); index++) {
    const animation = animations.getAnimation(index);
    if (animation.getName() === name) return animation;
  }
  return null;
};

/**
 * Whether an "already-exists" import result still resolves to OUR frame
 * file: the resource exists with the same project-relative file (a re-run
 * over the same sliced files), so the animation can reference it as is.
 */
const isReusableExistingResource = (
  project: any,
  result: ByokResourceImportEntryResult
): boolean => {
  const resourcesManager = project.getResourcesManager();
  const existing = resourcesManager.getResource(result.name);
  if (
    typeof existing.getKind === 'function' &&
    existing.getKind() !== 'image'
  ) {
    return false;
  }
  return existing.getFile() === result.file;
};

/** Undo the registrations this call made (a registration failed). */
const rollbackRegisteredResources = (
  project: any,
  registeredNames: Array<string>
): Array<string> => {
  const failedRemovals: Array<string> = [];
  const resourcesManager = project.getResourcesManager();
  for (const name of registeredNames) {
    try {
      if (resourcesManager.hasResource(name)) {
        resourcesManager.removeResource(name);
      }
    } catch (error) {
      failedRemovals.push(name);
    }
  }
  return failedRemovals;
};

/**
 * Register the frame files as image resources and build (or append to) the
 * animation. Returns what happened honestly; never throws.
 */
export const assembleForkSpriteSheetAnimation = async (options: {|
  project: any,
  objectName: string,
  animationName: string,
  frameAbsolutePaths: $ReadOnlyArray<string>,
  fps: number,
  loop: boolean,
  deps?: ForkSpriteSheetAssembleDeps,
|}): Promise<ForkSpriteSheetAssembleResult> => {
  const {
    project,
    objectName,
    animationName,
    frameAbsolutePaths,
    fps,
    loop,
  } = options;
  const deps = options.deps || makeDefaultForkSpriteSheetAssembleDeps();

  // ---- Validation: nothing is mutated below this block's guards. ----
  if (!deps) {
    return makeErrorResult(animationName, [
      'Sprite-sheet assembly is only available in the desktop app (it needs the local filesystem).',
    ]);
  }
  if (!project || typeof project !== 'object') {
    return makeErrorResult(animationName, ['No project is open.']);
  }
  if (typeof objectName !== 'string' || !objectName) {
    return makeErrorResult(animationName, ['An object name is required.']);
  }
  if (typeof animationName !== 'string' || !animationName) {
    return makeErrorResult(animationName, ['An animation name is required.']);
  }
  if (
    !Array.isArray(frameAbsolutePaths) ||
    frameAbsolutePaths.length === 0 ||
    frameAbsolutePaths.some(path => typeof path !== 'string' || !path)
  ) {
    return makeErrorResult(animationName, [
      'At least one non-empty frame file path is required.',
    ]);
  }
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
    return makeErrorResult(animationName, [
      'The frames-per-second must be a positive number.',
    ]);
  }
  const object = findObjectAnywhere(project, objectName);
  if (!object) {
    return makeErrorResult(animationName, [
      `Object not found: "${objectName}" (in no scene nor globally).`,
    ]);
  }
  if (object.getType() !== 'Sprite') {
    return makeErrorResult(animationName, [
      `Object "${objectName}" is of type "${object.getType()}", not "Sprite" — a sprite sheet can only be imported into a Sprite object.`,
    ]);
  }
  const spriteConfiguration = gd.asSpriteConfiguration(
    object.getConfiguration()
  );
  if (!spriteConfiguration) {
    return makeErrorResult(animationName, [
      `Object "${objectName}" has a configuration that is not a sprite configuration.`,
    ]);
  }

  // ---- Registration: the first mutation (D19-3, in place). ----
  const entries: Array<ByokResourceImportEntry> = frameAbsolutePaths.map(
    frameAbsolutePath => ({ kind: 'image', source: frameAbsolutePath })
  );
  let importResults: Array<ByokResourceImportEntryResult>;
  try {
    importResults = await importByokProjectResources({
      project,
      entries,
      replaceExisting: false,
      deps,
    });
  } catch (error) {
    return makeErrorResult(animationName, [
      `Registering the frames failed: ${describeError(error)}`,
    ]);
  }

  const resourceNames: Array<string> = [];
  const registeredNames: Array<string> = [];
  const errors: Array<string> = [];
  for (const result of importResults) {
    // A null name only happens on a failed entry — the branches below route
    // those to the errors list.
    const resultName = result.name || '';
    if (result.status === 'registered' && resultName) {
      resourceNames.push(resultName);
      registeredNames.push(resultName);
      continue;
    }
    if (
      result.status === 'already-exists' &&
      resultName &&
      isReusableExistingResource(project, result)
    ) {
      // A re-run over the same sliced files: the resource already points
      // at our frame, so the animation can reference it as is.
      resourceNames.push(resultName);
      continue;
    }
    errors.push(
      result.error
        ? `Frame "${result.source}": ${result.error}`
        : `Frame "${result.source}" could not be registered (${String(
            result.status
          )}).`
    );
  }
  if (errors.length > 0) {
    const failedRemovals = rollbackRegisteredResources(
      project,
      registeredNames
    );
    if (failedRemovals.length > 0) {
      // The rollback could not restore everything: report the mutation
      // that persisted rather than claim a clean refusal.
      return {
        didModifyProject: true,
        animationName,
        frameCount: 0,
        resourceNames: [],
        errors: errors.concat(
          failedRemovals.map(
            name => `The resource "${name}" could not be rolled back.`
          )
        ),
      };
    }
    return makeErrorResult(animationName, errors);
  }

  // ---- Animation assembly: the second mutation (D19-6/D19-8). ----
  const animations = spriteConfiguration.getAnimations();
  let animation = findAnimationByName(animations, animationName);
  let createdAnimation = false;
  if (!animation) {
    animation = new gd.Animation();
    animation.setName(animationName);
    animation.setDirectionsCount(1);
    createdAnimation = true;
  } else if (animation.getDirectionsCount() === 0) {
    // Only when zero: calling setDirectionsCount on an animation with
    // directions would destroy the ones we must not touch.
    animation.setDirectionsCount(1);
  }
  const direction = animation.getDirection(0);
  for (const resourceName of resourceNames) {
    const sprite = new gd.Sprite();
    sprite.setImageName(resourceName);
    direction.addSprite(sprite);
    // addSprite stored a copy: free the wrapper (SpritesList.js:215).
    sprite.delete();
  }
  direction.setTimeBetweenFrames(1 / fps);
  direction.setLoop(loop);
  if (createdAnimation) {
    animations.addAnimation(animation);
    // Ownership passed to the container: free the wrapper
    // (AnimationList.js:501-502).
    animation.delete();
  }

  return {
    didModifyProject: true,
    animationName,
    frameCount: resourceNames.length,
    resourceNames,
    errors: [],
  };
};
