// @flow

/**
 * Phase 16.5 — the feature-side handlers the BYOK tools delegate to.
 *
 * Two read/config handlers over the Phase 16 policy and settings:
 * - `reportAssetOptimization`: plan over the PROJECT's resources and answer
 *   with the projected per-file savings. It writes nothing — not the project,
 *   not the originals (D16-2, A16-9); the actual compression only ever
 *   happens at export, on the export copy.
 * - `setAssetOptimizationSettings`: normalize + persist the policy knobs the
 *   export reads (the same store the Preferences "Build" tab writes).
 *
 * The savings of the projection are a documented ESTIMATE (the real numbers
 * come from the export report): a per-transform low/high ratio band, applied
 * to the file's current size. Reporting a range, labelled as an estimate, is
 * the honest answer — the real gain depends on the source's existing
 * compression, which nothing here can know.
 */

import optionalRequire from '../../Utils/OptionalRequire';
import {
  getForkAssetFileExtension,
  planForkAssetOptimization,
  type ForkAssetPlanEntry,
} from './ForkAssetPlan';
import {
  getForkAssetBuildSettings,
  setForkAssetBuildSettings,
  type ForkAssetBuildSettings,
} from './ForkAssetBuildSettings';

/** The per-transform projection bands (low/high fraction saved). */
export const FORK_ASSET_PROJECTION_RATIOS: {
  [string]: {| low: number, high: number |},
} = {
  // PNG is lossless: the win is the re-compression only.
  png: { low: 0.05, high: 0.25 },
  jpeg: { low: 0.35, high: 0.55 },
  webp: { low: 0.15, high: 0.35 },
  // GIF is a mostly-lossless palette re-encode (animated): same class as PNG.
  gif: { low: 0.05, high: 0.25 },
  // Very source-dependent (the original bitrate is unknown).
  audio: { low: 0.25, high: 0.6 },
};

/** The resource kinds the planner can act on. */
const FORK_ASSET_RESOURCE_KINDS: Set<string> = new Set<string>([
  'image',
  'audio',
]);

export type ForkAssetToolsDeps = {|
  fs: any,
  path: any,
|};

/** The platform deps, or null outside a runtime with a filesystem. */
export const createDefaultForkAssetToolsDeps = (): ?ForkAssetToolsDeps => {
  const fsModule = optionalRequire('fs');
  const pathModule = optionalRequire('path');
  if (!fsModule || !pathModule) return null;
  return { fs: fsModule, path: pathModule };
};

const isAbsoluteOrUrl = (file: string): boolean => {
  if (!file) return true;
  if (file.includes('://')) return true;
  if (file.startsWith('/')) return true;
  const backslash = String.fromCharCode(92);
  if (file.startsWith(backslash)) return true;
  return /^[a-zA-Z]:/.test(file);
};

/** One project resource that has a real local file. */
export type ForkAssetProjectFile = {|
  resourceName: string,
  relativePath: string,
  extension: string,
  sizeBytes: number,
|};

/**
 * The project's local image/audio resources, with their on-disk size. A
 * cloud (URL) resource, a missing file or a folder is skipped — the export
 * would download it later, but there is nothing to size here.
 */
export const listForkAssetProjectFiles = (options: {|
  project: any,
  deps: ForkAssetToolsDeps,
|}): Array<ForkAssetProjectFile> => {
  const { project, deps } = options;
  const resourcesManager = project.getResourcesManager();
  const names: Array<string> = resourcesManager
    .getAllResourceNames()
    .toJSArray();
  const projectFolder = deps.path.dirname(project.getProjectFile());
  const files: Array<ForkAssetProjectFile> = [];

  for (const resourceName of names) {
    const resource = resourcesManager.getResource(resourceName);
    if (!resource) continue;
    const kind =
      typeof resource.getKind === 'function' ? resource.getKind() : '';
    if (!FORK_ASSET_RESOURCE_KINDS.has(kind)) continue;
    const file =
      typeof resource.getFile === 'function' ? resource.getFile() : '';
    if (isAbsoluteOrUrl(file)) continue;
    const absolutePath = deps.path.join(projectFolder, file);
    try {
      if (!deps.fs.existsSync(absolutePath)) continue;
      const stat = deps.fs.statSync(absolutePath);
      if (!stat.isFile()) continue;
      files.push({
        resourceName,
        relativePath: file.replace(/\\/g, '/'),
        extension: getForkAssetFileExtension(file),
        sizeBytes: stat.size,
      });
    } catch (error) {
      // A stat failure simply leaves this resource out of the projection.
    }
  }
  return files;
};

export type ForkAssetProjectionFile = {|
  resourceName: string,
  relativePath: string,
  kind: 'image' | 'audio',
  transform: string,
  sizeBytes: number,
  projectedSavedLowBytes: number,
  projectedSavedHighBytes: number,
|};

export type ForkAssetOptimizationProjection = {|
  files: Array<ForkAssetProjectionFile>,
  skipped: Array<{|
    relativePath: string,
    reason: string,
    reasonCode: ?string,
  |}>,
  plannedCount: number,
  skippedCount: number,
  bytesPlanned: number,
  projectedSavedLowBytes: number,
  projectedSavedHighBytes: number,
|};

/**
 * Fold the plan over the project's resource files into a projection. Pure
 * given the plan: the same files and settings always answer the same
 * estimate.
 */
export const projectForkAssetOptimizationPlan = (options: {|
  plan: Array<ForkAssetPlanEntry>,
  files: Array<ForkAssetProjectFile>,
|}): ForkAssetOptimizationProjection => {
  const { plan, files } = options;
  const sizeByPath: Map<string, number> = new Map();
  const nameByPath: Map<string, string> = new Map();
  for (const file of files) {
    sizeByPath.set(file.relativePath, file.sizeBytes);
    nameByPath.set(file.relativePath, file.resourceName);
  }

  const projectedFiles: Array<ForkAssetProjectionFile> = [];
  const skipped: Array<{|
    relativePath: string,
    reason: string,
    reasonCode: ?string,
  |}> = [];
  let bytesPlanned = 0;
  let projectedSavedLowBytes = 0;
  let projectedSavedHighBytes = 0;

  for (const entry of plan) {
    const transform = entry.transform;
    if (entry.kind === 'skip' || !transform) {
      skipped.push({
        relativePath: entry.relativePath,
        reason: entry.skipReason || 'Skipped by the optimization policy.',
        reasonCode: entry.skipReasonCode,
      });
      continue;
    }
    const sizeBytes = sizeByPath.get(entry.relativePath) || 0;
    const band: {| low: number, high: number |} = FORK_ASSET_PROJECTION_RATIOS[
      transform
    ] || { low: 0, high: 0 };
    const savedLow = Math.round(sizeBytes * band.low);
    const savedHigh = Math.round(sizeBytes * band.high);
    bytesPlanned += sizeBytes;
    projectedSavedLowBytes += savedLow;
    projectedSavedHighBytes += savedHigh;
    projectedFiles.push({
      resourceName: nameByPath.get(entry.relativePath) || '',
      relativePath: entry.relativePath,
      kind: entry.kind === 'audio' ? 'audio' : 'image',
      transform,
      sizeBytes,
      projectedSavedLowBytes: savedLow,
      projectedSavedHighBytes: savedHigh,
    });
  }

  return {
    files: projectedFiles,
    skipped,
    plannedCount: projectedFiles.length,
    skippedCount: skipped.length,
    bytesPlanned,
    projectedSavedLowBytes,
    projectedSavedHighBytes,
  };
};

export type ForkAssetOptimizationReportResult =
  | {|
      ok: true,
      settings: ForkAssetBuildSettings,
      projection: ForkAssetOptimizationProjection,
    |}
  | {| ok: false, error: string |};

/**
 * Project what an export would re-encode, reading the project and the
 * settings and WRITING NOTHING (A16-9's determinism guarantee: the project is
 * asserted unchanged after the call). Never throws.
 */
export const reportAssetOptimization = (options: {|
  project: any,
  settings?: ?ForkAssetBuildSettings,
  deps?: ?ForkAssetToolsDeps,
|}): ForkAssetOptimizationReportResult => {
  const { project } = options;
  if (!project) {
    return {
      ok: false,
      error: 'No project is open — open or create one first.',
    };
  }
  const deps = options.deps || createDefaultForkAssetToolsDeps();
  if (!deps) {
    return {
      ok: false,
      error:
        'Reading the project files needs the desktop app (this build has no filesystem access).',
    };
  }
  const projectFile =
    typeof project.getProjectFile === 'function'
      ? project.getProjectFile()
      : '';
  if (!projectFile) {
    return {
      ok: false,
      error:
        'The project has not been saved yet, so its resource files cannot be measured.',
    };
  }

  try {
    const settings = options.settings || getForkAssetBuildSettings();
    const files = listForkAssetProjectFiles({ project, deps });
    const plan = planForkAssetOptimization({
      files: files.map(file => ({
        relativePath: file.relativePath,
        extension: file.extension,
        sizeBytes: file.sizeBytes,
      })),
      settings,
    });
    return {
      ok: true,
      settings,
      projection: projectForkAssetOptimizationPlan({ plan, files }),
    };
  } catch (error) {
    return {
      ok: false,
      error: `The optimization projection failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};

export type ForkAssetSetSettingsResult = {|
  ok: boolean,
  settings: ForkAssetBuildSettings,
  error: ?string,
|};

/**
 * Normalize and persist a partial settings change (the same store the
 * Preferences tab writes). Writes nothing to the project.
 */
export const setAssetOptimizationSettings = (options: {|
  partial: mixed,
|}): ForkAssetSetSettingsResult => {
  if (!options.partial || typeof options.partial !== 'object') {
    return {
      ok: false,
      settings: getForkAssetBuildSettings(),
      error: 'The settings to change were not provided as an object.',
    };
  }
  return {
    ok: true,
    settings: setForkAssetBuildSettings(options.partial),
    error: null,
  };
};
