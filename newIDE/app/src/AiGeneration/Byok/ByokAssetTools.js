// @flow

/**
 * Phase 16.5 (D16-9) + Phase 17.7 (D17-10) — the thin BYOK adapters over the
 * fork's asset features.
 *
 * Four tools, all `ByokExtraTool`s registered through the interception
 * registry (ByokExtraTools):
 * - `report_asset_optimization` (16.5): projects the per-file savings over
 *   the project's resources and WRITES NOTHING (not the project, not the
 *   originals — the compression itself only ever runs at export, on the
 *   export copy);
 * - `set_asset_optimization_settings` (16.5): normalizes and persists the
 *   export compression policy;
 * - `list_assets` (17.7): the project's resources with their tags, filtered
 *   by tag or untagged — the same membership the fork's Assets view groups
 *   by;
 * - `set_asset_tags` (17.7): set/merge/remove/clear the cosmetic tags of one
 *   or more resources, atomically (any invalid tag or unknown name refuses
 *   the whole call).
 *
 * Like ByokGameCodeTools, every failure answers with `{success:false,message}`
 * instead of throwing — a thrown error here would orphan the agent's
 * tool_calls and brick the chat. All four tools are advertised ONLY through
 * `search_tools` (never in BYOK_CORE_TOOL_NAMES), so the always-on prompt
 * budget is untouched.
 */

import {
  createDefaultForkAssetToolsDeps,
  reportAssetOptimization,
  setAssetOptimizationSettings,
  type ForkAssetToolsDeps,
} from '../../Fork/AssetBuild/ForkAssetToolsHandlers';
import { formatForkAssetBytes } from '../../Fork/AssetBuild/ForkAssetOptimizerPort';
import type { ForkAssetBuildSettings } from '../../Fork/AssetBuild/ForkAssetBuildSettings';
import {
  listForkPipelineAssets,
  setForkPipelineAssetTags,
} from '../../Fork/AssetPipeline/ForkAssetToolsHandlers';
import type { ByokExtraTool, ByokExtraToolResult } from './ByokExtraTools';

export type ByokAssetToolDeps = {|
  /** Null when the runtime has no filesystem (the tools then refuse). */
  toolsDeps: ?ForkAssetToolsDeps,
|};

const makeDefaultDeps = (): ByokAssetToolDeps => ({
  toolsDeps: null,
});

const resolveToolsDeps = (deps: ByokAssetToolDeps): ?ForkAssetToolsDeps =>
  deps.toolsDeps === null ? createDefaultForkAssetToolsDeps() : deps.toolsDeps;

/** The one failure shape of every tool (never throw, always a message). */
const refusal = (message: string): ByokExtraToolResult => ({
  output: { success: false, message },
  didModifyProject: false,
});

const describeSettings = (settings: ForkAssetBuildSettings): string =>
  [
    `enabled=${String(settings.enabled)}`,
    `png_level=${String(settings.pngLevel)}`,
    `jpeg_quality=${String(settings.jpegQuality)}`,
    `webp_quality=${String(settings.webpQuality)}`,
    `optimize_manual_exports=${String(settings.optimizeManualExports)}`,
    `audio_enabled=${String(settings.audioEnabled)}`,
    `audio_bitrate_kbps=${String(settings.audioBitrateKbps)}`,
  ].join(', ');

const makeReportAssetOptimizationTool = (
  deps: ByokAssetToolDeps
): ByokExtraTool => ({
  name: 'report_asset_optimization',
  // A projection writes nothing, so it must never open the approval row.
  modifiesProject: false,
  run: async (args, collaborators) => {
    const project = collaborators.getProject();
    if (!project) {
      return refusal('No project is open — open or create one first.');
    }
    const outcome = reportAssetOptimization({
      project,
      deps: resolveToolsDeps(deps),
    });
    if (!outcome.ok) return refusal(outcome.error);

    const { projection, settings } = outcome;
    const lines: Array<string> = [];
    lines.push(
      settings.enabled
        ? 'These files would be re-encoded IN PLACE, under the same names, in the EXPORT copy only.'
        : 'Asset optimization is currently OFF, so these are the savings you WOULD get after turning it on (set_asset_optimization_settings or the Preferences > Build tab).'
    );
    lines.push(
      "The project's original files are never modified — the compression always runs on the export copy."
    );
    if (projection.plannedCount === 0) {
      lines.push(
        `No image or audio resource would be re-encoded (${
          projection.skippedCount
        } file(s) skipped).`
      );
    } else {
      lines.push(
        `${projection.plannedCount} file(s), ${formatForkAssetBytes(
          projection.bytesPlanned
        )} in total, would be re-encoded: an estimated ${formatForkAssetBytes(
          projection.projectedSavedLowBytes
        )} to ${formatForkAssetBytes(
          projection.projectedSavedHighBytes
        )} saved (estimate — the real numbers appear in the export report).`
      );
    }
    if (projection.skippedCount > 0) {
      lines.push(`${projection.skippedCount} file(s) would be skipped.`);
    }

    return {
      output: {
        success: true,
        message: lines.join('\n'),
        settings,
        settings_summary: describeSettings(settings),
        totals: {
          planned_files: projection.plannedCount,
          skipped_files: projection.skippedCount,
          bytes_planned: projection.bytesPlanned,
          projected_saved_low_bytes: projection.projectedSavedLowBytes,
          projected_saved_high_bytes: projection.projectedSavedHighBytes,
        },
        planned_files: projection.files.map(file => ({
          resource: file.resourceName,
          file: file.relativePath,
          kind: file.kind,
          transform: file.transform,
          size_bytes: file.sizeBytes,
          projected_saved_low_bytes: file.projectedSavedLowBytes,
          projected_saved_high_bytes: file.projectedSavedHighBytes,
        })),
        skipped_files: projection.skipped.map(skip => ({
          file: skip.relativePath,
          reason: skip.reason,
          reason_code: skip.reasonCode,
        })),
      },
      didModifyProject: false,
    };
  },
});

/** Read a model-provided knob only when it has the right primitive type. */
const readSettingKnobs = (args: Object): Object => {
  const partial: Object = {};
  if (typeof args.enabled === 'boolean') partial.enabled = args.enabled;
  if (typeof args.png_level === 'number') partial.pngLevel = args.png_level;
  if (typeof args.jpeg_quality === 'number') {
    partial.jpegQuality = args.jpeg_quality;
  }
  if (typeof args.webp_quality === 'number') {
    partial.webpQuality = args.webp_quality;
  }
  if (typeof args.optimize_manual_exports === 'boolean') {
    partial.optimizeManualExports = args.optimize_manual_exports;
  }
  if (typeof args.audio_enabled === 'boolean') {
    partial.audioEnabled = args.audio_enabled;
  }
  if (typeof args.audio_bitrate_kbps === 'number') {
    partial.audioBitrateKbps = args.audio_bitrate_kbps;
  }
  return partial;
};

const makeSetAssetOptimizationSettingsTool = (): ByokExtraTool => ({
  name: 'set_asset_optimization_settings',
  // App preferences, not project data: nothing to approve, nothing to save.
  modifiesProject: false,
  run: async args => {
    const partial = readSettingKnobs(args);
    if (Object.keys(partial).length === 0) {
      return refusal(
        'No optimization setting was provided — pass at least one of enabled, png_level (0-9), jpeg_quality (1-100), webp_quality (1-100), optimize_manual_exports, audio_enabled, audio_bitrate_kbps (32-320).'
      );
    }
    const outcome = setAssetOptimizationSettings({ partial });
    if (!outcome.ok)
      return refusal(outcome.error || 'The settings were refused.');
    return {
      output: {
        success: true,
        message: `Asset optimization settings updated — they take effect at the next export. Current: ${describeSettings(
          outcome.settings
        )}.`,
        settings: outcome.settings,
      },
      didModifyProject: false,
    };
  },
});

/** Read the model-provided asset-tag arguments only when well-typed. */
const readAssetNames = (args: Object): Array<string> =>
  Array.isArray(args.asset_names)
    ? args.asset_names.filter((name: mixed) => typeof name === 'string')
    : [];

const readTags = (args: Object): Array<string> =>
  Array.isArray(args.tags)
    ? args.tags.filter((tag: mixed) => typeof tag === 'string')
    : [];

const readTagMode = (args: Object): 'set' | 'merge' | 'remove' | 'clear' => {
  if (args.mode === 'set') return 'set';
  if (args.mode === 'remove') return 'remove';
  if (args.mode === 'clear') return 'clear';
  return 'merge';
};

const makeListAssetsTool = (): ByokExtraTool => ({
  name: 'list_assets',
  // A read over the resource metadata: nothing to approve, nothing to save.
  modifiesProject: false,
  run: async (args, collaborators) => {
    const project = collaborators.getProject();
    if (!project) {
      return refusal('No project is open — open or create one first.');
    }
    const outcome = listForkPipelineAssets({
      project,
      tag: typeof args.tag === 'string' ? args.tag : undefined,
      untaggedOnly: args.untagged_only === true,
    });
    if (!outcome.ok) return refusal(outcome.error);

    const lines: Array<string> = [];
    if (outcome.assets.length === 0) {
      lines.push(
        args.untagged_only === true
          ? 'Every asset of the project carries at least one tag.'
          : 'The project has no asset matching this filter.'
      );
    } else {
      lines.push(
        `${outcome.assets.length} asset(s)${
          typeof args.tag === 'string' ? ` tagged "${args.tag}"` : ''
        }:`
      );
      for (const asset of outcome.assets.slice(0, 60)) {
        lines.push(
          `- ${asset.name} (${asset.kind}${
            asset.file ? `, ${asset.file}` : ''
          })${
            asset.tags.length > 0
              ? ` [${asset.tags.join(', ')}]`
              : ' [untagged]'
          }`
        );
      }
      if (outcome.assets.length > 60) {
        lines.push(`… and ${outcome.assets.length - 60} more.`);
      }
    }

    return {
      output: {
        success: true,
        message: lines.join('\n'),
        assets: outcome.assets,
        matched_count: outcome.matchedCount,
      },
      didModifyProject: false,
    };
  },
});

const makeSetAssetTagsTool = (): ByokExtraTool => ({
  name: 'set_asset_tags',
  // Writes the tags into the resource metadata — a project change to approve
  // and save like any other edit.
  modifiesProject: true,
  run: async (args, collaborators) => {
    const project = collaborators.getProject();
    if (!project) {
      return refusal('No project is open — open or create one first.');
    }
    const assetNames = readAssetNames(args);
    if (assetNames.length === 0) {
      return refusal(
        'No asset name was provided — pass asset_names as an array of resource names (see list_assets).'
      );
    }
    const mode = readTagMode(args);
    const tags = readTags(args);
    if (mode !== 'clear' && tags.length === 0) {
      return refusal(
        'No tag was provided — pass tags as an array (or mode "clear" to remove them all).'
      );
    }

    const outcome = setForkPipelineAssetTags({
      project,
      assetNames,
      tags,
      mode,
    });
    if (!outcome.ok) return refusal(outcome.error);

    const lines: Array<string> = [];
    lines.push(
      `Tags of ${
        outcome.updated.length
      } asset(s) updated (mode: ${mode}); the change is saved with the project.`
    );
    for (const asset of outcome.updated.slice(0, 60)) {
      lines.push(
        `- ${asset.name}${
          asset.tags.length > 0 ? ` [${asset.tags.join(', ')}]` : ' [untagged]'
        }`
      );
    }
    if (outcome.updated.length > 60) {
      lines.push(`… and ${outcome.updated.length - 60} more.`);
    }

    return {
      output: {
        success: true,
        message: lines.join('\n'),
        updated: outcome.updated,
      },
      didModifyProject: true,
    };
  },
});

/**
 * The four asset tools. The deps are injectable so the tests drive a fake
 * project filesystem; production resolves the real one at call time. The
 * two tag tools need no filesystem — they operate on the project model.
 */
export const getByokAssetTools = (
  overrides?: Partial<ByokAssetToolDeps>
): Array<ByokExtraTool> => {
  const deps: ByokAssetToolDeps = {
    ...makeDefaultDeps(),
    ...(overrides || {}),
  };
  return [
    makeReportAssetOptimizationTool(deps),
    makeSetAssetOptimizationSettingsTool(),
    makeListAssetsTool(),
    makeSetAssetTagsTool(),
  ];
};
