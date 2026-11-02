/**
 * @jest-environment jsdom
 */
// @flow
import * as React from 'react';
import {
  isForkAssetOnlineExportPath,
  makeForkAssetOptimizingExportPipeline,
  resolveForkAssetOutputFolder,
  type ForkAssetPipelineDeps,
} from './ForkAssetOptimizingExportPipeline';
import { DEFAULT_FORK_ASSET_BUILD_SETTINGS } from './ForkAssetBuildSettings';

// jsdom does not implement matchMedia, and the report host reaches the
// Preferences context through UI/Dialog (loaded lazily, at render time).
if (!(window: any).matchMedia) {
  (window: any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  });
}

/** A pipeline context stub (cast at the call sites: the real type carries a
 * gdProject and a lingui i18n instance). */
const makeContext = (exportState: Object): any => ({
  project: {},
  exportState,
  updateStepProgress: () => {},
  i18n: {},
});

const makeUpstream = (calls: Array<string>): any => ({
  name: 'fake-pipeline',
  getInitialExportState: () => ({}),
  renderHeader: () => null,
  renderExportFlow: (props: Object) => {
    calls.push('renderExportFlow');
    return <div id="upstream-flow" />;
  },
  canLaunchBuild: () => true,
  isNavigationDisabled: () => false,
  prepareExporter: async () => ({}),
  launchExport: async () => ({ urlFiles: [] }),
  launchResourcesDownload: async (context: Object, output: Object) => {
    calls.push('resourcesDownload');
    return output;
  },
  launchCompression: async () => {
    calls.push('upstreamCompression');
    return 'zip-path';
  },
});

const makeDeps = (
  overrides: Partial<ForkAssetPipelineDeps>,
  calls: Array<string>,
  options?: {| enabled?: boolean, optimizeManualExports?: boolean |}
): any => ({
  getSettings: () => ({
    ...DEFAULT_FORK_ASSET_BUILD_SETTINGS,
    enabled: options && options.enabled === false ? false : true,
    optimizeManualExports:
      options && options.optimizeManualExports === false ? false : true,
  }),
  createOptimizerDeps: () => ({
    fs: {},
    path: {},
    invoke: async () => [],
    capabilities: { images: true, audio: true },
  }),
  optimize: async ({ folderPath }) => {
    calls.push(`optimize:${folderPath}`);
    return {
      folderPath,
      ranOptimization: true,
      error: null,
      summary: {
        totalBytesBefore: 1000,
        totalBytesAfter: 400,
        savedBytes: 600,
        optimizedCount: 1,
        failedCount: 0,
        largestSavings: [],
      },
      files: [],
      skipped: [],
    };
  },
  publishReport: report => {
    calls.push('publishReport');
  },
  ...overrides,
});

describe('isForkAssetOnlineExportPath / resolveForkAssetOutputFolder', () => {
  it('reads the temporary dir of the online path', () => {
    expect(
      isForkAssetOnlineExportPath({ temporaryOutputDir: 'C:/tmp/export' })
    ).toBe(true);
    expect(
      resolveForkAssetOutputFolder(makeContext({}), {
        temporaryOutputDir: 'C:/tmp/export',
      })
    ).toBe('C:/tmp/export');
  });

  it('falls back to the export state output folder for the manual path', () => {
    expect(isForkAssetOnlineExportPath(null)).toBe(false);
    expect(
      resolveForkAssetOutputFolder(makeContext({ outputDir: 'C:/out' }), null)
    ).toBe('C:/out');
  });

  it('answers null when neither folder is known', () => {
    expect(resolveForkAssetOutputFolder(makeContext({}), null)).toBeNull();
    expect(
      resolveForkAssetOutputFolder(makeContext({ outputDir: '' }), null)
    ).toBeNull();
  });
});

describe('makeForkAssetOptimizingExportPipeline', () => {
  it('optimizes the online export after the download and before the zip', async () => {
    const calls: Array<string> = [];
    const wrapped = makeForkAssetOptimizingExportPipeline(
      makeUpstream(calls),
      makeDeps({}, calls)
    );
    const context = makeContext({ targets: ['winExe'] });

    const exportOutput = await wrapped.launchExport(context, {}, undefined);
    // The online path's download step returns the temporary export dir.
    const downloadOutput = await wrapped.launchResourcesDownload(context, {
      ...exportOutput,
      temporaryOutputDir: 'C:/tmp/export',
    });
    const compressionOutput = await wrapped.launchCompression(
      context,
      downloadOutput
    );

    // The window that matters: after the resource download, before the
    // upstream compression (whose zip must hold the optimized files).
    expect(calls).toEqual([
      'resourcesDownload',
      'optimize:C:/tmp/export',
      'publishReport',
      'upstreamCompression',
    ]);
    expect(compressionOutput).toBe('zip-path');
  });

  it('optimizes the manual export on the chosen output folder', async () => {
    const calls: Array<string> = [];
    const wrapped = makeForkAssetOptimizingExportPipeline(
      makeUpstream(calls),
      makeDeps({}, calls)
    );
    const context = makeContext({ outputDir: 'C:/Users/me/Exports/MyGame' });

    const exportOutput = await wrapped.launchExport(context, {}, undefined);
    const downloadOutput = await wrapped.launchResourcesDownload(
      context,
      exportOutput
    );
    await wrapped.launchCompression(context, downloadOutput);

    expect(calls).toEqual([
      'resourcesDownload',
      'optimize:C:/Users/me/Exports/MyGame',
      'publishReport',
      'upstreamCompression',
    ]);
  });

  it('skips the manual path when "also optimize manual exports" is off', async () => {
    const calls: Array<string> = [];
    const wrapped = makeForkAssetOptimizingExportPipeline(
      makeUpstream(calls),
      makeDeps({}, calls, { optimizeManualExports: false })
    );
    const context = makeContext({ outputDir: 'C:/out' });
    await wrapped.launchCompression(context, null);
    expect(calls).toEqual(['upstreamCompression']);
  });

  it('delegates with zero behavior change when the setting is off', async () => {
    const calls: Array<string> = [];
    const upstream = makeUpstream(calls);
    const wrapped = makeForkAssetOptimizingExportPipeline(
      upstream,
      makeDeps({}, calls, { enabled: false })
    );
    const context = makeContext({ targets: ['winExe'] });
    const output = await wrapped.launchCompression(context, {
      temporaryOutputDir: 'C:/tmp/export',
    });
    expect(calls).toEqual(['upstreamCompression']);
    expect(output).toBe('zip-path');

    // The flow itself is the upstream node, not a wrapper around it.
    const props: any = { project: {}, disabled: false };
    const offNode: any = wrapped.renderExportFlow(props);
    expect(offNode).toEqual(upstream.renderExportFlow(props));
  });

  it('renders the upstream export flow untouched (the report host is MainFrame-level)', () => {
    const calls: Array<string> = [];
    const upstream = makeUpstream(calls);
    const wrappedOn = makeForkAssetOptimizingExportPipeline(
      upstream,
      makeDeps({}, calls)
    );
    const props: any = { project: {}, disabled: false };
    // [P16-report-host]: the wrapper no longer injects the report host into
    // the flow — the MainFrame-level ForkAssetReportDialogHost shows every
    // report, whatever the export path.
    expect(wrappedOn.renderExportFlow).toBe(upstream.renderExportFlow);
    const node: any = wrappedOn.renderExportFlow(props);
    expect(node).toEqual(upstream.renderExportFlow(props));
  });

  it('delegates on a non-desktop runtime (no optimizer deps)', async () => {
    const calls: Array<string> = [];
    const wrapped = makeForkAssetOptimizingExportPipeline(
      makeUpstream(calls),
      makeDeps({ createOptimizerDeps: () => null }, calls)
    );
    await wrapped.launchCompression(makeContext({ targets: [] }), {
      temporaryOutputDir: 'C:/tmp/export',
    });
    expect(calls).toEqual(['upstreamCompression']);
  });

  it('delegates when no output folder can be resolved', async () => {
    const calls: Array<string> = [];
    const wrapped = makeForkAssetOptimizingExportPipeline(
      makeUpstream(calls),
      makeDeps({}, calls)
    );
    await wrapped.launchCompression(makeContext({}), null);
    expect(calls).toEqual(['upstreamCompression']);
  });

  it('never fails the export when the optimizer throws', async () => {
    const calls: Array<string> = [];
    const wrapped = makeForkAssetOptimizingExportPipeline(
      makeUpstream(calls),
      makeDeps(
        {
          optimize: async () => {
            calls.push('optimize:threw');
            throw new Error('encoder exploded');
          },
        },
        calls
      )
    );
    const output = await wrapped.launchCompression(
      makeContext({ targets: [] }),
      { temporaryOutputDir: 'C:/tmp/export' }
    );
    expect(calls).toEqual(['optimize:threw', 'upstreamCompression']);
    expect(output).toBe('zip-path');
  });

  it('keeps every other upstream method untouched', () => {
    const calls: Array<string> = [];
    const upstream = makeUpstream(calls);
    const wrapped = makeForkAssetOptimizingExportPipeline(
      upstream,
      makeDeps({}, calls)
    );
    expect(wrapped.name).toBe(upstream.name);
    expect(wrapped.prepareExporter).toBe(upstream.prepareExporter);
    expect(wrapped.launchExport).toBe(upstream.launchExport);
    expect(wrapped.launchResourcesDownload).toBe(
      upstream.launchResourcesDownload
    );
    expect(wrapped.canLaunchBuild).toBe(upstream.canLaunchBuild);
    expect(wrapped.isNavigationDisabled).toBe(upstream.isNavigationDisabled);
    expect(wrapped.renderExportFlow).toBe(upstream.renderExportFlow);
    expect(wrapped.launchCompression).not.toBe(upstream.launchCompression);
  });
});
