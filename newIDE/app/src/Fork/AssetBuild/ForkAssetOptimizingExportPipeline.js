// @flow
import {
  createDefaultForkAssetOptimizerDeps,
  runForkAssetOptimization,
  type ForkAssetOptimizationReport,
  type ForkAssetOptimizerDeps,
} from './ForkAssetOptimizerPort';
import {
  getForkAssetBuildSettings,
  type ForkAssetBuildSettings,
} from './ForkAssetBuildSettings';
import { publishForkAssetReport } from './ForkAssetReportStore';
import type {
  ExportPipeline,
  ExportPipelineContext,
} from '../../ExportAndShare/ExportPipeline.flow';

/**
 * Phase 16.3 — the pipeline wrapper.
 *
 * The optimizer must run in the exact window between the resource download
 * and the packaging, on BOTH desktop export paths, without editing the C++
 * exporter (D16-4). The renderer's `ExportPipeline` is that extension point:
 * this factory spreads an upstream pipeline and overrides the packaging tail
 * (`launchCompression`, which ExportLauncher always calls after
 * `launchResourcesDownload`):
 *
 * - one-click online export: `resourcesDownloadOutput.temporaryOutputDir` —
 *   optimized BEFORE delegating to the upstream `launchCompression`, which
 *   builds the zip (so the archive holds the optimized files);
 * - manual "export to folder": the upstream `launchCompression` is a no-op,
 *   so this override IS the tail — it optimizes `exportState.outputDir`.
 *
 * With the feature off, on a non-desktop runtime, on a path with no output
 * folder, or when the manual path is not wanted, it delegates straight
 * through with the upstream function and its arguments untouched (A16-5).
 *
 * The size report is shown by the MainFrame-level ForkAssetReportDialogHost
 * ([P16-report-host]), which hears every report this wrapper publishes —
 * whatever export path produced it.
 */

export type ForkAssetPipelineDeps = {|
  getSettings: () => ForkAssetBuildSettings,
  /** Null on a non-desktop runtime (no fs / no ipcRenderer). */
  createOptimizerDeps: () => ?ForkAssetOptimizerDeps,
  optimize: (options: {|
    folderPath: string,
    settings: ForkAssetBuildSettings,
    deps: ForkAssetOptimizerDeps,
  |}) => Promise<ForkAssetOptimizationReport>,
  publishReport: (report: ForkAssetOptimizationReport) => void,
|};

export const makeDefaultForkAssetPipelineDeps = (): ForkAssetPipelineDeps => ({
  getSettings: getForkAssetBuildSettings,
  createOptimizerDeps: createDefaultForkAssetOptimizerDeps,
  optimize: runForkAssetOptimization,
  publishReport: publishForkAssetReport,
});

/** True when this run is the one-click online path (it carries a temp dir). */
export const isForkAssetOnlineExportPath = (
  resourcesDownloadOutput: mixed
): boolean => {
  if (!resourcesDownloadOutput || typeof resourcesDownloadOutput !== 'object') {
    return false;
  }
  const temporaryOutputDir = (resourcesDownloadOutput: Object)
    .temporaryOutputDir;
  return typeof temporaryOutputDir === 'string' && !!temporaryOutputDir;
};

/**
 * The folder the optimizer may rewrite: the temporary export dir of the
 * online path, or the user-chosen output folder of the manual path. Null when
 * neither is known (the wrapper then delegates untouched).
 */
export const resolveForkAssetOutputFolder = (
  context: ExportPipelineContext<any>,
  resourcesDownloadOutput: mixed
): ?string => {
  if (isForkAssetOnlineExportPath(resourcesDownloadOutput)) {
    return (resourcesDownloadOutput: Object).temporaryOutputDir;
  }
  const exportState: any = context ? context.exportState : null;
  if (exportState && typeof exportState.outputDir === 'string') {
    return exportState.outputDir || null;
  }
  return null;
};

const optimizeBeforePackaging = async (
  context: ExportPipelineContext<any>,
  resourcesDownloadOutput: mixed,
  deps: ForkAssetPipelineDeps
): Promise<void> => {
  const settings = deps.getSettings();
  if (!settings.enabled) return;

  const isManualPath = !isForkAssetOnlineExportPath(resourcesDownloadOutput);
  if (isManualPath && !settings.optimizeManualExports) return;

  const folderPath = resolveForkAssetOutputFolder(
    context,
    resourcesDownloadOutput
  );
  if (!folderPath) return;

  const optimizerDeps = deps.createOptimizerDeps();
  if (!optimizerDeps) return; // Not the desktop app (D16-5).

  try {
    const report = await deps.optimize({
      folderPath,
      settings,
      deps: optimizerDeps,
    });
    deps.publishReport(report);
  } catch (error) {
    // D16-7: the optimizer can never fail the export. `runForkAssetOptimization`
    // already contains its failures; this guard keeps a future regression from
    // reaching the export flow.
  }
};

/**
 * Wrap an upstream export pipeline with the optimizer. The returned pipeline
 * is the upstream object with `launchCompression` overridden; every other
 * method (header, export, resources download, upload, online build, done
 * footer, export flow) is the upstream one, untouched. The size report's
 * host is mounted at the MainFrame level ([P16-report-host]), so EVERY
 * export path shows its report — not only the paths that render this flow.
 */
export const makeForkAssetOptimizingExportPipeline = <
  ExportState,
  PreparedExporter,
  ExportOutput,
  ResourcesDownloadOutput,
  CompressionOutput
>(
  upstream: ExportPipeline<
    ExportState,
    PreparedExporter,
    ExportOutput,
    ResourcesDownloadOutput,
    CompressionOutput
  >,
  injectedDeps?: Partial<ForkAssetPipelineDeps>
): ExportPipeline<
  ExportState,
  PreparedExporter,
  ExportOutput,
  ResourcesDownloadOutput,
  CompressionOutput
> => {
  const deps: ForkAssetPipelineDeps = {
    ...makeDefaultForkAssetPipelineDeps(),
    ...(injectedDeps || {}),
  };

  const launchCompression = async (
    context: ExportPipelineContext<ExportState>,
    resourcesDownloadOutput: ResourcesDownloadOutput
  ): Promise<CompressionOutput> => {
    await optimizeBeforePackaging(context, resourcesDownloadOutput, deps);
    return upstream.launchCompression(context, resourcesDownloadOutput);
  };

  // $FlowFixMe[incompatible-type] - the spread of a generic exact pipeline
  // plus the one override is the same shape by construction.
  return {
    ...upstream,
    launchCompression,
  };
};
