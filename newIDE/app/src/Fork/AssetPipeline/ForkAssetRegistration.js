// @flow

/**
 * Phase 17.3 — the auto-registration reconcile (D17-5).
 *
 * The generalized `reconcileResources` of the game-code carrier
 * (ByokGameCodeCarrier.js): given the files that exist on disk (and the
 * ones reported gone), it creates/retargets resources keyed by origin
 * (`setOrigin('fork-asset-watcher', relativePath)`) and removes ONLY
 * resources whose origin is the watcher AND whose file was reported gone —
 * a resource a user added deliberately is never touched.
 *
 * The module is deterministic and dependency-light: the filesystem is the
 * CALLER's business (the auto-register stats the files); everything here
 * works over the lists it is handed, so the specs need no fs at all.
 */

import { applyResourceDefaults } from '../../ResourcesList/ResourceUtils';
import { createNewResource } from '../../ResourcesList/ResourceSource';

/** The resource origin name everything this feature registers carries. */
export const FORK_ASSET_WATCHER_ORIGIN = 'fork-asset-watcher';

/**
 * The extension -> resource kind map (D17-5), mirroring how the IDE's
 * "scan for resources" builds its resource kinds. An extension that maps
 * to nothing is SKIPPED, not forced into a wrong kind — the upstream scan
 * only registers known extensions too.
 */
export const FORK_ASSET_EXTENSION_TO_KIND: { [string]: string } = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  svg: 'image',
  mp3: 'audio',
  ogg: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  opus: 'audio',
  ttf: 'font',
  otf: 'font',
  json: 'json',
};

export const getForkAssetKindForExtension = (
  extension: string
): string | null => {
  const normalized = extension.replace(/^\./, '').toLowerCase();
  return FORK_ASSET_EXTENSION_TO_KIND[normalized] || null;
};

const getExtensionOfRelativePath = (relativePath: string): string => {
  const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return fileName.slice(dotIndex + 1);
};

const NUL = String.fromCharCode(0);
const FORBIDDEN_SEGMENT_CHARACTERS = /[<>:"|?*]/;
const RESERVED_DEVICE_NAMES = [
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
];

/**
 * Whether a relative path (forward or back slashes) is a confined,
 * plausible in-project path: no NUL, not absolute (no leading `/`, no
 * drive prefix), no URL scheme, no `.`/`..` segment, no Windows-forbidden
 * character or reserved device name in a segment — the segment rules the
 * game-code path core applies (ByokGameCodePathCore.js).
 */
export const checkForkAssetRelativePath = (
  relativePath: string
): {| ok: true, path: string |} | {| ok: false, error: string |} => {
  if (typeof relativePath !== 'string' || !relativePath) {
    return { ok: false, error: 'The path is empty.' };
  }
  if (relativePath.indexOf(NUL) !== -1) {
    return { ok: false, error: 'The path carries a NUL character.' };
  }
  const withForwardSlashes = relativePath.replace(/\\/g, '/');
  if (
    withForwardSlashes.startsWith('/') ||
    /^[a-zA-Z]:/.test(withForwardSlashes) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(withForwardSlashes)
  ) {
    return {
      ok: false,
      error:
        'The path is absolute or a URL; only project-relative paths apply.',
    };
  }
  const segments = withForwardSlashes.split('/').filter(Boolean);
  if (segments.length === 0) {
    return { ok: false, error: 'The path is empty.' };
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return { ok: false, error: 'The path escapes the project folder.' };
    }
    if (FORBIDDEN_SEGMENT_CHARACTERS.test(segment)) {
      return {
        ok: false,
        error: 'A path segment carries a forbidden character.',
      };
    }
    if (RESERVED_DEVICE_NAMES.includes(segment.split('.')[0].toLowerCase())) {
      return { ok: false, error: 'A path segment is a reserved device name.' };
    }
  }
  return { ok: true, path: withForwardSlashes };
};

export type ForkAssetReconcileSkip = {|
  +path: string,
  +reason: string,
|};

export type ForkAssetReconcileResult = {|
  +added: Array<string>,
  +retargeted: Array<string>,
  +removed: Array<string>,
  +skipped: Array<ForkAssetReconcileSkip>,
  +didModifyProject: boolean,
|};

export type ForkAssetReconcileOptions = {|
  +project: any,
  /** Project-relative paths (any slash style) of files that exist on disk. */
  +onDiskFiles: $ReadOnlyArray<string>,
  /** Project-relative paths reported gone (deleted since the last burst). */
  +deletedFiles?: $ReadOnlyArray<string>,
  /**
   * The project folder, as documentation of what the relative paths are
   * relative to (and the guard absolute inputs are checked against).
   */
  +projectFolder?: string,
  /** Returns true for paths the registration must leave alone. */
  +ignoreMatcher?: (relativePath: string) => boolean,
  /** Override of the extension -> kind map (defaults to the table above). */
  +resourceKindForExtension?: (extension: string) => string | null,
  /** Override of the resource constructor (specs fake it). */
  +resourceFactory?: (kind: string) => any,
|};

/** The resource names of a project (the WASM-safe enumeration). */
const listResourceNames = (project: any): Array<string> =>
  project
    .getResourcesManager()
    .getAllResourceNames()
    .toJSArray();

/**
 * Bring the project's resources in line with what the watcher saw on disk:
 * register the new files, retarget the ones whose file moved, remove the
 * watcher-origin resources of the files that are gone. Idempotent by
 * construction — running it twice on the same lists reports only no-ops
 * the second time.
 */
export const reconcileForkAssetResources = (
  options: ForkAssetReconcileOptions
): ForkAssetReconcileResult => {
  const { project } = options;
  const resourcesManager = project.getResourcesManager();
  const ignoreMatcher =
    options.ignoreMatcher || ((relativePath: string) => false);
  const resourceKindForExtension =
    options.resourceKindForExtension || getForkAssetKindForExtension;
  const resourceFactory = options.resourceFactory || createNewResource;

  const added: Array<string> = [];
  const retargeted: Array<string> = [];
  const removed: Array<string> = [];
  const skipped: Array<ForkAssetReconcileSkip> = [];

  // One pass over the existing registry: the watcher-origin resources by
  // their origin identifier (the relative path they were registered from).
  const watcherResourceNameByIdentifier: Map<string, string> = new Map();
  for (const resourceName of listResourceNames(project)) {
    const resource = resourcesManager.getResource(resourceName);
    if (typeof resource.getOriginName !== 'function') continue;
    if (resource.getOriginName() !== FORK_ASSET_WATCHER_ORIGIN) continue;
    watcherResourceNameByIdentifier.set(
      resource.getOriginIdentifier(),
      resourceName
    );
  }

  const keptWatcherIdentifiers: Set<string> = new Set<string>();
  for (const rawPath of options.onDiskFiles) {
    const checked = checkForkAssetRelativePath(rawPath);
    if (!checked.ok) {
      skipped.push({ path: String(rawPath), reason: checked.error });
      continue;
    }
    const relativePath = checked.path;
    if (ignoreMatcher(relativePath)) {
      skipped.push({
        path: relativePath,
        reason: 'Ignored by the ignore list.',
      });
      continue;
    }
    const kind = resourceKindForExtension(
      getExtensionOfRelativePath(relativePath)
    );
    if (!kind) {
      skipped.push({
        path: relativePath,
        reason: 'The file extension does not map to a resource kind.',
      });
      continue;
    }

    const existingWatcherName = watcherResourceNameByIdentifier.get(
      relativePath
    );
    if (existingWatcherName) {
      keptWatcherIdentifiers.add(relativePath);
      const existing = resourcesManager.getResource(existingWatcherName);
      if (existing.getFile() !== relativePath) {
        existing.setFile(relativePath);
        retargeted.push(existingWatcherName);
      }
      continue;
    }

    // A resource with this NAME that is not ours is left completely alone:
    // silently retargeting a user's resource at another file (or another
    // kind) would break every object referencing it.
    if (resourcesManager.hasResource(relativePath)) {
      keptWatcherIdentifiers.add(relativePath);
      skipped.push({
        path: relativePath,
        reason: 'A resource with this name already exists.',
      });
      continue;
    }

    const resource = resourceFactory(kind);
    if (!resource) {
      skipped.push({
        path: relativePath,
        reason: `No resource constructor for the kind "${kind}".`,
      });
      continue;
    }
    resource.setName(relativePath);
    resource.setFile(relativePath);
    resource.setOrigin(FORK_ASSET_WATCHER_ORIGIN, relativePath);
    applyResourceDefaults(project, resource);
    resourcesManager.addResource(resource);
    // addResource stored a copy: free the wrapper (an un-deleted wrapper
    // leaks WASM memory — the ResourceSelector's rule).
    resource.delete();
    keptWatcherIdentifiers.add(relativePath);
    added.push(relativePath);
  }

  const deletedFiles = options.deletedFiles || [];
  for (const rawPath of deletedFiles) {
    const checked = checkForkAssetRelativePath(rawPath);
    if (!checked.ok) continue;
    const relativePath = checked.path;
    // A file deleted then re-created within the burst counts as existing.
    if (keptWatcherIdentifiers.has(relativePath)) continue;
    const watcherResourceName = watcherResourceNameByIdentifier.get(
      relativePath
    );
    if (!watcherResourceName) continue;
    resourcesManager.removeResource(watcherResourceName);
    removed.push(watcherResourceName);
  }

  return {
    added,
    retargeted,
    removed,
    skipped,
    didModifyProject:
      added.length > 0 || retargeted.length > 0 || removed.length > 0,
  };
};
