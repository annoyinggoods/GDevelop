// @flow

/**
 * Phase 18.3 — the fork-side handler behind the `scan_scene_events` AI tool
 * (D18-6).
 *
 * What this is: a read-only projection of the Phase 18.1 rule engine over a
 * project's SCENES. The BYOK adapter (ByokGuardrailTools) validates its own
 * arguments and delegates here; this module never touches the project it
 * reads — the serialized project is asserted byte-identical by its spec.
 *
 * Scope of v1: scenes only (`project.getLayoutAt`), never external events
 * layouts (Phase 18 §5 keeps cross-container analysis out of v1). Never
 * throws: every failure is a `{ ok: false, error }` a chat can render.
 */

import {
  collectForkGuardrailDiagnostics,
  FORK_GUARDRAIL_RULE_IDS,
  type ForkGuardrailDiagnostic,
  type ForkGuardrailSeverity,
} from './ForkGuardrailRules';

export type ForkGuardrailScanDiagnostic = {|
  ruleId: string,
  severity: ForkGuardrailSeverity,
  message: string,
  nodePath: Array<number>,
  sceneName: string,
|};

export type ForkGuardrailScanSceneEventsResult =
  | {|
      ok: true,
      diagnostics: Array<ForkGuardrailScanDiagnostic>,
      summary: string,
    |}
  | {| ok: false, error: string |};

const getSceneNames = (project: any): Array<string> => {
  const sceneNames: Array<string> = [];
  const scenesCount =
    typeof project.getLayoutsCount === 'function'
      ? project.getLayoutsCount()
      : 0;
  for (let index = 0; index < scenesCount; index++) {
    const layout = project.getLayoutAt(index);
    if (layout && typeof layout.getName === 'function') {
      sceneNames.push(layout.getName());
    }
  }
  return sceneNames;
};

const validateRequestedRuleIds = (ruleIds: ?Array<string>): ?string => {
  if (!ruleIds) return null;
  if (!Array.isArray(ruleIds)) {
    return 'The rule_ids argument must be an array of rule ids.';
  }
  const knownRuleIds = new Set<string>(FORK_GUARDRAIL_RULE_IDS);
  const unknownRuleIds = ruleIds.filter(
    ruleId => typeof ruleId !== 'string' || !knownRuleIds.has(ruleId)
  );
  if (unknownRuleIds.length === 0) return null;
  return `Unknown rule id(s): ${unknownRuleIds.join(
    ', '
  )}. Valid rule ids are: ${FORK_GUARDRAIL_RULE_IDS.join(', ')}.`;
};

const makeSummary = (
  diagnostics: Array<ForkGuardrailScanDiagnostic>,
  scenesScannedCount: number,
  rulesCheckedCount: number
): string => {
  const warningsCount = diagnostics.filter(
    diagnostic => diagnostic.severity === 'warning'
  ).length;
  const advisoriesCount = diagnostics.length - warningsCount;
  return `${warningsCount} warning(s), ${advisoriesCount} advisories across ${scenesScannedCount} scene(s) (${rulesCheckedCount} rules checked)`;
};

/**
 * Scan one scene (or every scene of the project) for guardrail diagnostics.
 * Writes nothing; returns the same diagnostics the engine produces, each
 * stamped with its scene name, plus a one-line summary.
 */
export const scanSceneEvents = (options: {|
  project: any,
  sceneName?: string,
  ruleIds?: Array<string>,
|}): ForkGuardrailScanSceneEventsResult => {
  try {
    if (!options || !options.project) {
      return {
        ok: false,
        error: 'No project is open — open or create one first.',
      };
    }
    const { project } = options;

    const ruleIdsError = validateRequestedRuleIds(options.ruleIds);
    if (ruleIdsError) return { ok: false, error: ruleIdsError };
    const requestedRuleIds = options.ruleIds
      ? new Set<string>(options.ruleIds)
      : null;

    const scenesToScan: Array<any> = [];
    const sceneName =
      typeof options.sceneName === 'string' ? options.sceneName : '';
    if (sceneName) {
      const hasLayout =
        typeof project.hasLayoutNamed === 'function' &&
        project.hasLayoutNamed(sceneName);
      if (!hasLayout) {
        return {
          ok: false,
          error: `Unknown scene "${sceneName}". Available scenes: ${getSceneNames(
            project
          ).join(', ')}.`,
        };
      }
      scenesToScan.push(project.getLayout(sceneName));
    } else {
      const scenesCount =
        typeof project.getLayoutsCount === 'function'
          ? project.getLayoutsCount()
          : 0;
      for (let index = 0; index < scenesCount; index++) {
        scenesToScan.push(project.getLayoutAt(index));
      }
    }

    const diagnostics: Array<ForkGuardrailScanDiagnostic> = [];
    for (const layout of scenesToScan) {
      const layoutName =
        layout && typeof layout.getName === 'function' ? layout.getName() : '';
      const sceneDiagnostics: Array<ForkGuardrailDiagnostic> = collectForkGuardrailDiagnostics(
        layout && typeof layout.getEvents === 'function'
          ? layout.getEvents()
          : null
      );
      for (const diagnostic of sceneDiagnostics) {
        if (requestedRuleIds && !requestedRuleIds.has(diagnostic.ruleId)) {
          continue;
        }
        diagnostics.push({ ...diagnostic, sceneName: layoutName });
      }
    }

    return {
      ok: true,
      diagnostics,
      summary: makeSummary(
        diagnostics,
        scenesToScan.length,
        requestedRuleIds
          ? requestedRuleIds.size
          : FORK_GUARDRAIL_RULE_IDS.length
      ),
    };
  } catch (error) {
    return {
      ok: false,
      error: `The guardrail scan failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};
