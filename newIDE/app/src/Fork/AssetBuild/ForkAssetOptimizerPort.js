// @flow

/**
 * Phase 16.2 — the renderer-side port of the optimizer.
 *
 * It lists the export folder, plans with the pure 16.1 policy, invokes the
 * Electron main's thin applier and folds the answer into a report. Everything
 * platform-shaped (the `fs`/`path` modules, the `ipcRenderer.invoke`) is
 * injected so the whole port is unit-testable without Electron, and the
 * default deps builder returns null on a non-desktop runtime (D16-5: this is
 * a desktop-only feature).
 *
 * Never-fails-the-export contract (D16-7): a listing problem, an IPC refusal
 * or a per-file encoder error all degrade to "this file stays exactly as the
 * exporter wrote it" and the export keeps going. Nothing here throws.
 */

import optionalRequire from '../../Utils/OptionalRequire';
import {
  getForkAssetFileExtension,
  planForkAssetOptimization,
  summarizeForkAssetPlanResults,
  type ForkAssetApplyResult,
  type ForkAssetOptimizationSummary,
  type ForkAssetPlanEncoderCapabilities,
  type ForkAssetPlanEntry,
  type ForkAssetPlanFile,
} from './ForkAssetPlan';
import { type ForkAssetBuildSettings } from './ForkAssetBuildSettings';

/** The one applier channel: plan in, per-file before/after bytes out. */
export const FORK_ASSET_OPTIMIZE_APPLY_CHANNEL = 'fork-asset-optimize-apply';
/** The probe channel: which encoders this build actually has. */
export const FORK_ASSET_OPTIMIZE_CAPABILITIES_CHANNEL =
  'fork-asset-optimize-capabilities';

export type ForkAssetSkippedFile = {|
  relativePath: string,
  reason: string,
  /** The stable machine code of the reason, for the report UI's translation. */
  reasonCode: ?string,
|};

export type ForkAssetOptimizationReport = {|
  folderPath: string,
  /** False when the port could not even list/plan (the export continues). */
  ranOptimization: boolean,
  /** A whole-run failure reason (listing/IPC), null on a clean run. */
  error: ?string,
  summary: ForkAssetOptimizationSummary,
  files: Array<ForkAssetApplyResult>,
  skipped: Array<ForkAssetSkippedFile>,
|};

export type ForkAssetOptimizerDeps = {|
  /** The node `fs` module (or a fake with readdirSync/statSync). */
  fs: any,
  /** The node `path` module (or a fake with join). */
  path: any,
  /** Calls the Electron main applier. */
  invoke: (channel: string, payload: any) => Promise<any>,
  /**
   * The probed encoder capabilities. Absent: the run probes them over the
   * capabilities channel first (and a probe failure means "no encoders",
   * which skips everything rather than writing anything unverified).
   */
  capabilities?: ForkAssetPlanEncoderCapabilities,
|};

const describeError = (error: mixed): string =>
  error instanceof Error ? error.message : String(error);

const makeEmptySummary = (): ForkAssetOptimizationSummary =>
  summarizeForkAssetPlanResults([]);

/**
 * Walk the export folder and list every file, flat (the exporter copies
 * resources by basename, so nested folders only appear for game-code files).
 * A directory that cannot be read is skipped, never fatal — a partially
 * listed folder must still optimize what it can.
 */
export const listForkAssetFiles = (options: {|
  folderPath: string,
  fs: any,
  path: any,
|}): Array<ForkAssetPlanFile> => {
  const { folderPath, fs: fsModule, path: pathModule } = options;
  const found: Array<ForkAssetPlanFile> = [];

  const walk = (directory: string, prefix: string): void => {
    let entries: Array<string>;
    try {
      entries = fsModule.readdirSync(directory);
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      const absoluteEntry = pathModule.join(directory, entry);
      const relativeEntry = prefix ? `${prefix}/${entry}` : entry;
      let stat;
      try {
        stat = fsModule.statSync(absoluteEntry);
      } catch (error) {
        continue;
      }
      if (stat.isDirectory()) {
        walk(absoluteEntry, relativeEntry);
        continue;
      }
      if (!stat.isFile()) continue;
      found.push({
        relativePath: relativeEntry,
        extension: getForkAssetFileExtension(relativeEntry),
        sizeBytes: stat.size,
      });
    }
  };

  walk(folderPath, '');
  return found;
};

/** The listing size of a relative path (0 when it is not in the listing). */
const getListedSize = (
  files: Array<ForkAssetPlanFile>,
  relativePath: string
): number => {
  const found = files.find(file => file.relativePath === relativePath);
  return found ? found.sizeBytes : 0;
};

/** One planned file left exactly as exported, with the reason it was not. */
const makeUnchangedResult = (
  entry: ForkAssetPlanEntry,
  files: Array<ForkAssetPlanFile>,
  error: string
): ForkAssetApplyResult => {
  const size = getListedSize(files, entry.relativePath);
  return {
    relativePath: entry.relativePath,
    bytesBefore: size,
    bytesAfter: size,
    error,
  };
};

/**
 * Normalize the applier's answer into one result per planned entry: a missing
 * entry, a non-numeric size or an explicit `error` all fold into "unchanged"
 * with the reason attached, so the report never shows a file it cannot
 * account for.
 */
const readApplyResults = (
  raw: mixed,
  entries: Array<ForkAssetPlanEntry>,
  files: Array<ForkAssetPlanFile>
): Array<ForkAssetApplyResult> => {
  const byPath: Map<string, Object> = new Map();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item.relativePath === 'string') {
        byPath.set(item.relativePath, item);
      }
    }
  }
  return entries.map(entry => {
    const item = byPath.get(entry.relativePath);
    if (!item) {
      return makeUnchangedResult(
        entry,
        files,
        'The optimizer returned no result for this file — it was left as exported.'
      );
    }
    const listedSize = getListedSize(files, entry.relativePath);
    const bytesBefore =
      Number.isFinite(item.bytesBefore) && item.bytesBefore >= 0
        ? item.bytesBefore
        : listedSize;
    const reportedAfter = Number.isFinite(item.bytesAfter)
      ? item.bytesAfter
      : bytesBefore;
    const error =
      typeof item.error === 'string' && item.error ? item.error : null;
    return {
      relativePath: entry.relativePath,
      bytesBefore,
      bytesAfter: error ? bytesBefore : reportedAfter,
      error,
    };
  });
};

const applyForkAssetPlan = async (options: {|
  folderPath: string,
  entries: Array<ForkAssetPlanEntry>,
  files: Array<ForkAssetPlanFile>,
  deps: ForkAssetOptimizerDeps,
|}): Promise<Array<ForkAssetApplyResult>> => {
  const { folderPath, entries, files, deps } = options;
  if (entries.length === 0) return [];

  const payloadEntries = entries.map(entry => ({
    relativePath: entry.relativePath,
    kind: entry.kind,
    transform: entry.transform,
    options: entry.options,
  }));

  let raw;
  try {
    raw = await deps.invoke(FORK_ASSET_OPTIMIZE_APPLY_CHANNEL, {
      folderPath,
      entries: payloadEntries,
    });
  } catch (error) {
    // A whole-channel failure (the handler is gone, IPC broke) degrades
    // EVERY planned file to "unchanged" — the export still succeeds.
    const reason = `The asset optimizer could not run: ${describeError(error)}`;
    return entries.map(entry => makeUnchangedResult(entry, files, reason));
  }
  return readApplyResults(raw, entries, files);
};

/**
 * Ask the Electron main which encoders this build has. A probe failure is an
 * honest "neither": the planner then skips every image and audio file rather
 * than planning a transform no applier can run.
 */
export const probeForkAssetEncoderCapabilities = async (
  deps: ForkAssetOptimizerDeps
): Promise<ForkAssetPlanEncoderCapabilities> => {
  try {
    const raw = await deps.invoke(
      FORK_ASSET_OPTIMIZE_CAPABILITIES_CHANNEL,
      null
    );
    if (raw && typeof raw === 'object') {
      return { images: raw.images === true, audio: raw.audio === true };
    }
  } catch (error) {
    // Fall through to the honest "no encoders" answer.
  }
  return { images: false, audio: false };
};

/**
 * The whole run: list → plan → apply → report. Never throws (D16-7): a
 * listing failure returns `ranOptimization: false` with the reason, which the
 * pipeline wrapper reports and then delegates as if optimization were off.
 */
export const runForkAssetOptimization = async (options: {|
  folderPath: string,
  settings: ForkAssetBuildSettings,
  deps: ForkAssetOptimizerDeps,
|}): Promise<ForkAssetOptimizationReport> => {
  const { folderPath, settings, deps } = options;
  try {
    const capabilities =
      deps.capabilities || (await probeForkAssetEncoderCapabilities(deps));
    const files = listForkAssetFiles({
      folderPath,
      fs: deps.fs,
      path: deps.path,
    });
    const plan = planForkAssetOptimization({ files, settings, capabilities });
    const entries = plan.filter(entry => entry.kind !== 'skip');
    const skipped = plan
      .filter(entry => entry.kind === 'skip')
      .map(entry => ({
        relativePath: entry.relativePath,
        reason: entry.skipReason || 'Skipped by the optimization policy.',
        reasonCode: entry.skipReasonCode,
      }));
    const results = await applyForkAssetPlan({
      folderPath,
      entries,
      files,
      deps,
    });
    return {
      folderPath,
      ranOptimization: true,
      error: null,
      summary: summarizeForkAssetPlanResults(results),
      files: results,
      skipped,
    };
  } catch (error) {
    return {
      folderPath,
      ranOptimization: false,
      error: describeError(error),
      summary: makeEmptySummary(),
      files: [],
      skipped: [],
    };
  }
};

/** A byte count a human reads at a glance (KB/MB, one decimal). */
export const formatForkAssetBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * One-line human summary of a run, for the console log and the report's
 * header. Skips and failures are named, never hidden.
 */
export const formatForkAssetOptimizationReport = (
  report: ForkAssetOptimizationReport
): string => {
  if (!report.ranOptimization) {
    return `Asset optimization skipped: ${report.error || 'unknown reason'}.`;
  }
  const { summary } = report;
  const parts = [
    `Asset optimization: ${
      summary.optimizedCount
    } file(s) re-encoded, saved ${formatForkAssetBytes(
      summary.savedBytes
    )} (${formatForkAssetBytes(
      summary.totalBytesBefore
    )} → ${formatForkAssetBytes(summary.totalBytesAfter)}).`,
  ];
  if (summary.failedCount > 0) {
    parts.push(
      `${
        summary.failedCount
      } file(s) could not be optimized and were left as exported.`
    );
  }
  if (report.skipped.length > 0) {
    parts.push(`${report.skipped.length} file(s) skipped.`);
  }
  return parts.join(' ');
};

/**
 * The production deps: the node modules and the Electron IPC, or null when
 * the runtime is not the desktop app (the wrapper then delegates straight
 * through — D16-5).
 */
export const createDefaultForkAssetOptimizerDeps = (): ?ForkAssetOptimizerDeps => {
  const electron = optionalRequire('electron');
  const fsModule = optionalRequire('fs');
  const pathModule = optionalRequire('path');
  if (!electron || !electron.ipcRenderer || !fsModule || !pathModule) {
    return null;
  }
  const ipcRenderer = electron.ipcRenderer;
  return {
    fs: fsModule,
    path: pathModule,
    invoke: (channel: string, payload: any) =>
      ipcRenderer.invoke(channel, payload),
  };
};
