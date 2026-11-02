// @flow

/**
 * Phase 18.3 (D18-6) — the thin BYOK adapter over the fork's event-sheet
 * guardrail engine.
 *
 * One tool, a `ByokExtraTool` registered through the interception registry
 * (ByokExtraTools):
 * - `scan_scene_events`: the read-only trap report of a scene (or every
 *   scene) — rule id, severity, message and event path of each diagnostic
 *   the Phase 18 rules produce (Trigger Once in a loop, Wait in a loop,
 *   actions with no picking condition, duplicate Trigger Once).
 *
 * It WRITES NOTHING (`modifiesProject: false` — the handler's spec asserts
 * the serialized project is byte-identical), and like every BYOK tool it
 * answers failures with `{success:false,message}` instead of throwing — a
 * thrown error here would orphan the agent's tool_calls and brick the chat.
 * The tool is advertised ONLY through `search_tools` (never in
 * BYOK_CORE_TOOL_NAMES), so the always-on prompt budget is untouched.
 */

import {
  scanSceneEvents,
  type ForkGuardrailScanDiagnostic,
} from '../../Fork/Guardrails/ForkGuardrailToolHandler';
import type { ByokExtraTool, ByokExtraToolResult } from './ByokExtraTools';

/** The one failure shape of the tool (never throw, always a message). */
const refusal = (message: string): ByokExtraToolResult => ({
  output: { success: false, message },
  didModifyProject: false,
});

/** Read the model-provided rule filter only when it is well-typed. */
const readRuleIds = (args: Object): Array<string> | void => {
  if (!Array.isArray(args.rule_ids)) return undefined;
  const ruleIds = args.rule_ids.filter(
    (ruleId: mixed) => typeof ruleId === 'string'
  );
  return ruleIds.length > 0 ? ruleIds : undefined;
};

const describeDiagnostic = (diagnostic: ForkGuardrailScanDiagnostic): string =>
  `- ${diagnostic.severity === 'warning' ? 'WARNING' : 'advisory'} [${
    diagnostic.ruleId
  }] scene "${diagnostic.sceneName}", event path ${diagnostic.nodePath.join(
    ' > '
  )}: ${diagnostic.message}`;

const makeScanSceneEventsTool = (): ByokExtraTool => ({
  name: 'scan_scene_events',
  // A read-only diagnostics projection: nothing to approve, nothing to save.
  modifiesProject: false,
  run: async (args, collaborators) => {
    const project = collaborators.getProject();
    if (!project) {
      return refusal('No project is open — open or create one first.');
    }
    const outcome = scanSceneEvents({
      project,
      sceneName:
        typeof args.scene_name === 'string' ? args.scene_name : undefined,
      ruleIds: readRuleIds(args),
    });
    if (!outcome.ok) return refusal(outcome.error);

    const lines: Array<string> = [];
    lines.push(
      outcome.diagnostics.length === 0
        ? `${outcome.summary} — no event-sheet trap found.`
        : `${
            outcome.summary
          }. Fix the events by hand or with add_scene_events (the events sheet shows the same findings as inline badges):`
    );
    for (const diagnostic of outcome.diagnostics) {
      lines.push(describeDiagnostic(diagnostic));
    }

    return {
      output: {
        success: true,
        message: lines.join('\n'),
        diagnostics: outcome.diagnostics,
        summary: outcome.summary,
      },
      didModifyProject: false,
    };
  },
});

/** The guardrail tool of Phase 18.3. */
export const getByokGuardrailTools = (): Array<ByokExtraTool> => [
  makeScanSceneEventsTool(),
];
