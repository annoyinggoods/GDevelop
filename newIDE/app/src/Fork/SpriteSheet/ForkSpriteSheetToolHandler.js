// @flow

/**
 * Phase 19.5 — the feature-side handler composing the sprite-sheet pipeline
 * (19.2's port + 19.3's assembly) into the one call the BYOK tool and the
 * import dialog (19.4) share.
 *
 * `importForkSpriteSheet(project, args, deps?)`: plan/slice via the port,
 * then AWAIT the assembly (it is async — the deliberate Phase 19.3
 * deviation), and answer the BYOK convention: a refusal is
 * `{ success: false, message }` with NOTHING written (the pipeline
 * guarantees it — a plan refusal never invokes the slicer), a success is
 * `{ success: true, output, didModifyProject: true }` with a concise human
 * summary.
 *
 * The one check this handler OWNS: the target object must exist and be a
 * Sprite BEFORE any frame file is sliced (the assembly-side check would run
 * too late — the frame PNGs would already be on disk, and its rollback only
 * removes resource registrations, not files). The lookup mirrors the
 * assembly module's resolution order exactly (scenes in declaration order,
 * then the global objects).
 *
 * Desktop-guarded like import_project_resources: the default deps builder
 * answers null outside the Electron app, and the call refuses with a clear
 * message instead of throwing.
 */

import optionalRequire from '../../Utils/OptionalRequire';
import {
  getForkSpriteSheetAssetsFolder,
  importForkSpriteSheetFrames,
  makeDefaultForkSpriteSheetPortDeps,
  type ForkSpriteSheetGrid,
  type ForkSpriteSheetPortDeps,
} from './ForkSpriteSheetPort';
import {
  assembleForkSpriteSheetAnimation,
  type ForkSpriteSheetAssembleDeps,
} from './ForkSpriteSheetAssemble';

export type ForkSpriteSheetToolDeps = {|
  /** The port deps (slice IPC + image-size reader); null outside desktop. */
  portDeps: ?ForkSpriteSheetPortDeps,
  /** The assembly deps; omitted, the assembly resolves its own default. */
  assembleDeps?: ForkSpriteSheetAssembleDeps,
  /** The node path module (source-path resolution). */
  pathLib: any,
|};

/**
 * The production deps — or null when the runtime is not the desktop app
 * (no Electron IPC for the slicer, no node path module).
 */
export const makeDefaultForkSpriteSheetToolDeps = (): ?ForkSpriteSheetToolDeps => {
  const portDeps = makeDefaultForkSpriteSheetPortDeps();
  const pathLib = optionalRequire('path');
  if (!portDeps || !pathLib) return null;
  return { portDeps, pathLib };
};

export type ForkSpriteSheetImportResult =
  | {|
      success: false,
      message: string,
      // False for every ordinary refusal; only the assembly's
      // rollback-failed edge (a registration could not be undone) reports
      // an honest true here — the project DID change, the chat's
      // unsaved-changes flag must not miss it.
      didModifyProject: boolean,
    |}
  | {|
      success: true,
      output: string,
      didModifyProject: true,
      animationName: string,
      frameCount: number,
      resourceNames: Array<string>,
    |};

const refusal = (message: string): ForkSpriteSheetImportResult => ({
  success: false,
  message,
  didModifyProject: false,
});

/**
 * Find an object by name anywhere in the project — the same resolution
 * order assembleForkSpriteSheetAnimation uses (scenes in declaration order,
 * then the global objects). Duplicated here because the assembly module is
 * frozen (steps 19.1–19.3 are finished) and its own copy is private.
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

/**
 * Resolve the source argument to an absolute path: absolute paths pass
 * through, a project-relative one resolves against the project's folder
 * (the import_project_resources convention).
 */
export const resolveForkSpriteSheetSourcePath = (
  project: any,
  sourcePath: string,
  pathLib: any
): string => {
  if (pathLib.isAbsolute(sourcePath)) return sourcePath;
  const projectFile =
    project && typeof project.getProjectFile === 'function'
      ? project.getProjectFile()
      : '';
  return pathLib.resolve(pathLib.dirname(projectFile || ''), sourcePath);
};

/** Up to six names inline, then a count — the frame lists get long. */
const listResourceNames = (names: Array<string>): string =>
  names.length <= 6
    ? names.join(', ')
    : `${names.slice(0, 6).join(', ')} … and ${names.length - 6} more`;

/**
 * The concise human summary of a successful import: the animation, the
 * frame count, where the files landed and the resource names.
 */
const makeImportSummary = (options: {|
  project: any,
  objectName: string,
  animationName: string,
  fps: number,
  loop: boolean,
  frameCount: number,
  resourceNames: Array<string>,
|}): string => {
  const { project, objectName, animationName, fps, loop } = options;
  const folder = getForkSpriteSheetAssetsFolder(project);
  const folderName = folder.ok
    ? folder.folderName
    : 'the project assets folder';
  return [
    `Imported ${
      options.frameCount
    } frame(s) into the animation "${animationName}" of "${objectName}" (${fps} fps, ${
      loop ? 'looping' : 'no loop'
    }).`,
    `The frame files were written to ${folderName}/ and registered as resources: ${listResourceNames(
      options.resourceNames
    )}.`,
  ].join('\n');
};

/**
 * Slice a sprite sheet and assemble its animation. Never throws: every
 * failure is an explicit refusal, and nothing is written before every
 * refusal-generating input has been checked.
 */
export const importForkSpriteSheet = async (
  project: any,
  args: {|
    objectName: string,
    sourceAbsolutePath: string,
    grid: ForkSpriteSheetGrid,
    animationName: string,
    fps: number,
    loop: boolean,
  |},
  deps?: ForkSpriteSheetToolDeps
): Promise<ForkSpriteSheetImportResult> => {
  const resolvedDeps = deps || makeDefaultForkSpriteSheetToolDeps();
  // Bound to a local so the null guard carries to the port call below
  // (a property of an object is not narrowed across the function body).
  const portDeps = resolvedDeps ? resolvedDeps.portDeps : null;
  if (!resolvedDeps || !portDeps) {
    return refusal(
      'import_sprite_sheet is only available in the desktop app (it needs the local filesystem to slice the frames).'
    );
  }
  if (!project || typeof project !== 'object') {
    return refusal('No project is open — open or create one first.');
  }
  const projectFile =
    typeof project.getProjectFile === 'function'
      ? project.getProjectFile()
      : '';
  if (typeof projectFile !== 'string' || !projectFile) {
    return refusal(
      'The project must be saved before importing a sprite sheet (the frames are written next to it).'
    );
  }
  if (typeof args.objectName !== 'string' || !args.objectName) {
    return refusal('An object name is required.');
  }
  if (typeof args.animationName !== 'string' || !args.animationName) {
    return refusal('An animation name is required.');
  }
  if (
    typeof args.fps !== 'number' ||
    !Number.isFinite(args.fps) ||
    args.fps <= 0
  ) {
    return refusal('The frames-per-second must be a positive number.');
  }
  if (typeof args.sourceAbsolutePath !== 'string' || !args.sourceAbsolutePath) {
    return refusal('No source image was given.');
  }
  // A19-4's "writes nothing on a refusal": the object check runs BEFORE the
  // slicer — a wrong object name must not leave frame files on disk.
  const object = findObjectAnywhere(project, args.objectName);
  if (!object) {
    return refusal(
      `Object not found: "${args.objectName}" (in no scene nor globally).`
    );
  }
  if (object.getType() !== 'Sprite') {
    return refusal(
      `Object "${
        args.objectName
      }" is of type "${object.getType()}", not "Sprite" — a sprite sheet can only be imported into a Sprite object.`
    );
  }

  const sourceAbsolutePath = resolveForkSpriteSheetSourcePath(
    project,
    args.sourceAbsolutePath,
    resolvedDeps.pathLib
  );
  const frames = await importForkSpriteSheetFrames({
    project,
    sourceAbsolutePath,
    grid: args.grid,
    objectName: args.objectName,
    animationName: args.animationName,
    deps: portDeps,
  });
  if (!frames.ok) {
    return refusal(frames.error);
  }

  const assemble = await assembleForkSpriteSheetAnimation({
    project,
    objectName: args.objectName,
    animationName: args.animationName,
    frameAbsolutePaths: frames.writtenAbsolutePaths,
    fps: args.fps,
    loop: args.loop,
    deps: resolvedDeps.assembleDeps,
  });
  if (assemble.errors.length > 0 || !assemble.didModifyProject) {
    return {
      success: false,
      message:
        assemble.errors.length > 0
          ? assemble.errors.join('\n')
          : 'The animation could not be assembled.',
      didModifyProject: assemble.didModifyProject,
    };
  }
  return {
    success: true,
    output: makeImportSummary({
      project,
      objectName: args.objectName,
      animationName: assemble.animationName,
      fps: args.fps,
      loop: args.loop,
      frameCount: assemble.frameCount,
      resourceNames: assemble.resourceNames,
    }),
    didModifyProject: true,
    animationName: assemble.animationName,
    frameCount: assemble.frameCount,
    resourceNames: assemble.resourceNames,
  };
};
