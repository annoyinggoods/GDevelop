// @flow
import {
  unserializeFromJSObject,
  serializeToJSON,
} from '../../Utils/Serializer';
import { applyEventsChanges } from '../../EditorFunctions/ApplyEventsChanges';
import { renderEventSourceById } from '../../EventsSheet/EventsTree/TextRenderer/EventScriptSourceView';
import { parseByokEventScript } from './ByokEventScriptParser';
import {
  makeByokEventScriptRetryHint,
  type ByokEventScriptRetryHint,
} from './ByokEventScriptExamples';

/**
 * The local replacement of the hosted `add_scene_events`: parses the
 * model's EventScript batches, builds the same `AiGeneratedEventChange`
 * shaped operations `applyEventsChanges` consumes (the exact semantics of
 * the hosted event pipeline, minus its server-only fields), and applies
 * them to the scene — **without a single request to GDevelop's backend**.
 */

const gd: libGDevelop = global.gd;

/**
 * One batch of events to write, as the tool schema describes it (the hosted
 * wire shape minus the server-only fields: events_description is accepted
 * for parity but unused — the script is already written).
 */
export type ByokEventBatch = {|
  event_script?: ?string,
  placement_relation?: ?string,
  placement_target_event_id?: ?string,
  placement_expected_parent_event_id?: ?string,
  expected_event_source?: ?string,
  events_description?: ?string,
|};

export type ByokEventWriterOutput = {|
  success: boolean,
  message: string,
  appliedCount?: number,
  aiGeneratedEventId?: string,
  errors?: Array<string>,
  // The Phase 13.6 validator-repair injection: on a rejected batch, the
  // example most relevant to the failing construct — a complete, runnable
  // correction instead of the bare syntax complaint.
  retryHint?: ByokEventScriptRetryHint,
|};

/**
 * The placement operations accepted locally — the exact vocabulary of
 * `applyEventsChanges` (plus `delete`, the hosted name of `delete_event`,
 * mapped for parity with the server flow's placement_relation).
 */
const KNOWN_PLACEMENT_RELATIONS: Set<string> = new Set([
  'insert_at_end',
  'insert_and_replace_event',
  'replace_entire_event_and_sub_events',
  'replace_event_but_keep_existing_sub_events',
  'insert_before_event',
  'insert_after_event',
  'insert_as_sub_event',
  'insert_actions_conditions_at_end',
  'insert_actions_conditions_at_start',
  'replace_all_actions',
  'replace_all_conditions',
  'delete_event',
]);

const REPLACE_PLACEMENT_RELATIONS: Set<string> = new Set([
  'insert_and_replace_event',
  'replace_entire_event_and_sub_events',
  'replace_event_but_keep_existing_sub_events',
]);

let byokEventWriterIdCounter = 0;

/** A unique id for one local event-writing application. */
const makeByokAiGeneratedEventId = (): string => {
  byokEventWriterIdCounter++;
  return `byok-event-${Date.now().toString(36)}-${byokEventWriterIdCounter}`;
};

/**
 * Compare an `expected_event_source` anchor with the current source of the
 * target event: id annotations (which depend on positions) and trailing
 * whitespace are ignored, everything else must match.
 */
const isEventSourceMatchingAnchor = (
  currentSource: string,
  expectedSource: string
): boolean => {
  const normalize = (source: string): string =>
    source
      .split(/\r?\n/)
      .map(line => line.replace(/\s*#\s*event-[\d.]+\s*$/, '').trimEnd())
      .join('\n')
      .trim();
  return normalize(currentSource) === normalize(expectedSource);
};

/**
 * Parse one batch's EventScript into the JSON text of an events list (what
 * `generatedEvents` carries). Returns the text or a model-fixable failure.
 */
const parseBatchEventScript = (
  batch: ByokEventBatch,
  batchIndex: number
): {|
  generatedEvents: string | null,
  failure: ByokEventWriterOutput | null,
|} => {
  const eventScript = batch.event_script || '';
  if (eventScript.trim() === '') {
    return {
      generatedEvents: null,
      failure: {
        success: false,
        message: `Batch ${batchIndex} has no event_script (only delete_event batches may omit it).`,
      },
    };
  }

  const parseResult = parseByokEventScript(eventScript);
  if (parseResult.error) {
    const message = `Batch ${batchIndex} EventScript is not valid (line ${
      parseResult.error.lineNumber
    }, column ${parseResult.error.columnNumber}): ${
      parseResult.error.message
    }\nOffending line: ${parseResult.error.lineText.trim()}`;
    return {
      generatedEvents: null,
      failure: withByokRetryHint(
        { success: false, message },
        parseResult.error.lineText
      ),
    };
  }

  return { generatedEvents: JSON.stringify(parseResult.events), failure: null };
};

/**
 * Attach the retryHint to a failure output when the example bank has a
 * relevant example (13.6): the hint rides on the same JSON the model reads.
 */
const withByokRetryHint = (
  failure: ByokEventWriterOutput,
  offendingLine: string
): ByokEventWriterOutput => {
  const retryHint = makeByokEventScriptRetryHint(
    failure.message,
    offendingLine
  );
  if (!retryHint) return failure;
  return { ...failure, retryHint };
};

/**
 * Verify the `expected_event_source` anchor of a replace batch against the
 * scene: the edit is refused when the target moved on since it was read —
 * this is what makes anchored edits surgical instead of blind overwrites.
 */
const checkBatchAnchor = (
  batch: ByokEventBatch,
  batchIndex: number,
  placementRelation: string,
  sceneEvents: any,
  project: any
): ByokEventWriterOutput | null => {
  const expectedSource = batch.expected_event_source;
  if (!expectedSource) return null;
  if (!REPLACE_PLACEMENT_RELATIONS.has(placementRelation)) return null;

  const targetEventId = batch.placement_target_event_id || '';
  if (!targetEventId) {
    return {
      success: false,
      message: `Batch ${batchIndex} has an expected_event_source anchor but no placement_target_event_id.`,
    };
  }

  const currentSource = renderEventSourceById({
    eventsList: sceneEvents,
    eventIdOrGroupName: targetEventId,
    includeSubEvents:
      placementRelation === 'replace_entire_event_and_sub_events',
  });
  if (currentSource === null) {
    return {
      success: false,
      message: `Batch ${batchIndex}: the target event "${targetEventId}" was not found — read_events_source again and use a current event id.`,
    };
  }
  if (!isEventSourceMatchingAnchor(currentSource, expectedSource)) {
    return {
      success: false,
      message: `Batch ${batchIndex}: the event "${targetEventId}" changed since expected_event_source was read — read_events_source again, then retry with the updated anchor.`,
    };
  }
  return null;
};

/**
 * Build the `AiGeneratedEventChange` shaped operation of one batch (the
 * schema of Generation.js minus the server-only fields: diagnostics,
 * undeclared variables, missing resources — nothing of which a local
 * application produces).
 */
const buildBatchChange = (
  batch: ByokEventBatch,
  batchIndex: number,
  project: any
): {| change: Object | null, failure: ByokEventWriterOutput | null |} => {
  const relation = batch.placement_relation || 'insert_at_end';
  const placementRelation = relation === 'delete' ? 'delete_event' : relation;
  if (!KNOWN_PLACEMENT_RELATIONS.has(placementRelation)) {
    return {
      change: null,
      failure: {
        success: false,
        message: `Batch ${batchIndex} has an unknown placement_relation "${relation}".`,
      },
    };
  }

  // A delete carries no generated events; everything else needs a script.
  let generatedEvents = null;
  if (placementRelation !== 'delete_event') {
    const parsed = parseBatchEventScript(batch, batchIndex);
    if (parsed.failure) return { change: null, failure: parsed.failure };
    // Round-trip through a real gd.EventsList before anything is applied:
    // a batch the project cannot unserialize must fail the whole call
    // upfront, not half-apply (the same pre-validation the hosted flow
    // does server-side with isEventsJsonValid).
    try {
      generatedEvents = byokParsedEventsToGeneratedEventsJson(
        JSON.parse(parsed.generatedEvents || '[]'),
        project
      );
    } catch (error) {
      const message = `Batch ${batchIndex} could not be turned into events: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return {
        change: null,
        failure: withByokRetryHint(
          { success: false, message },
          batch.event_script || ''
        ),
      };
    }
  }

  // insert_at_end needs no target; insert_as_sub_event targets the parent
  // that will own the new sub-events.
  let operationTargetEvent = null;
  if (placementRelation !== 'insert_at_end') {
    operationTargetEvent =
      placementRelation === 'insert_as_sub_event'
        ? batch.placement_expected_parent_event_id ||
          batch.placement_target_event_id
        : batch.placement_target_event_id;
    if (!operationTargetEvent) {
      return {
        change: null,
        failure: {
          success: false,
          message: `Batch ${batchIndex} (${placementRelation}) needs a placement_target_event_id — get one from read_events_source (e.g. "event-2.1").`,
        },
      };
    }
  }

  return {
    change: {
      operationName: placementRelation,
      operationTargetEvent,
      generatedEvents,
      isEventsJsonValid: generatedEvents !== null,
      areEventsValid: generatedEvents !== null,
      extensionNames: [],
      diagnosticLines: [],
      undeclaredVariables: [],
      undeclaredObjectVariables: {},
      missingObjectBehaviors: {},
      missingResources: [],
    },
    failure: null,
  };
};

/**
 * Apply the event batches of one add_scene_events call to a scene:
 * parse → anchor-check → build changes → applyEventsChanges → notify the
 * editor. Everything is local (the hosted flow's backend job, its polling
 * and its uploads are all replaced by this function).
 */
export const byokApplySceneEventBatches = ({
  project,
  sceneName,
  eventBatches,
  onSceneEventsModifiedOutsideEditor,
}: {|
  project: any,
  sceneName: string,
  eventBatches: Array<ByokEventBatch>,
  onSceneEventsModifiedOutsideEditor: (changes: any) => void,
|}): ByokEventWriterOutput => {
  if (!sceneName) {
    return { success: false, message: 'Missing scene_name.' };
  }
  if (!project.hasLayoutNamed(sceneName)) {
    return {
      success: false,
      message: `No scene named "${sceneName}" in the project — create it with create_scene first.`,
    };
  }

  const scene = project.getLayout(sceneName);
  return byokApplyEventBatchesToEventsList({
    project,
    eventsList: scene.getEvents(),
    eventBatches,
    onApplied: aiGeneratedEventId =>
      onSceneEventsModifiedOutsideEditor({
        scene,
        newOrChangedAiGeneratedEventIds: new Set([aiGeneratedEventId]),
      }),
  });
};

/**
 * The container-generic core of the event writer (Phase 11): applies the
 * same parse → anchor-check → build → apply pipeline to ANY `gdEventsList`
 * — a scene's events or an external-events sheet — and leaves the editor
 * notification to the caller (`onApplied` receives the generated event id).
 */
export const byokApplyEventBatchesToEventsList = ({
  project,
  eventsList,
  eventBatches,
  onApplied,
}: {|
  project: any,
  eventsList: any,
  eventBatches: Array<ByokEventBatch>,
  onApplied: (aiGeneratedEventId: string) => void,
|}): ByokEventWriterOutput => {
  if (!Array.isArray(eventBatches) || eventBatches.length === 0) {
    return {
      success: false,
      message:
        'Missing or empty event_batches: at least one batch is required.',
    };
  }

  const changes: Array<Object> = [];
  for (let index = 0; index < eventBatches.length; index++) {
    const anchorFailure = checkBatchAnchor(
      eventBatches[index],
      index,
      eventBatches[index].placement_relation || 'insert_at_end',
      eventsList,
      project
    );
    if (anchorFailure) return anchorFailure;

    const built = buildBatchChange(eventBatches[index], index, project);
    if (built.failure) return built.failure;
    changes.push(built.change);
  }

  const aiGeneratedEventId = makeByokAiGeneratedEventId();
  const { applied, errors } = applyEventsChanges(
    project,
    eventsList,
    changes,
    aiGeneratedEventId
  );

  if (applied === 0) {
    return {
      success: false,
      message:
        'No event change could be applied (the targets may not exist anymore). Read the events again and retry with current ids.',
      aiGeneratedEventId,
      errors,
    };
  }

  onApplied(aiGeneratedEventId);

  const output: ByokEventWriterOutput = {
    success: true,
    message: `Applied ${applied} event change(s)${
      errors.length > 0 ? ` (${errors.length} skipped)` : ''
    }.`,
    appliedCount: applied,
    aiGeneratedEventId,
  };
  if (errors.length > 0) output.errors = errors;
  return output;
};

/**
 * Serialize parsed events into the `generatedEvents` JSON text through a
 * real gd.EventsList round-trip: unserialize validates the events against
 * the project (dropping nothing silently — a wrong shape throws), and the
 * serialized text is exactly what applyEventsChanges expects. Exported for
 * tests of the parse → gd → apply pipeline.
 */
/**
 * Pre-validate an EventScript batch against the project WITHOUT touching
 * anything: parse + a real gd round-trip (audit011026 B-TOOL-3 — the
 * create/change tools used to insert/rename/parameter-mutate first and
 * fail on the script after, reporting didModifyProject:false on an
 * already-mutated project). Returns the failure message or null.
 */
export const validateByokEventScript = (
  project: any,
  eventScript: string
): ?string => {
  const parseResult = parseByokEventScript(eventScript);
  if (parseResult.error) {
    return `The EventScript is not valid (line ${
      parseResult.error.lineNumber
    }, column ${parseResult.error.columnNumber}): ${parseResult.error.message}`;
  }
  try {
    byokParsedEventsToGeneratedEventsJson(parseResult.events, project);
    return null;
  } catch (error) {
    return `The events could not be applied: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
};

export const byokParsedEventsToGeneratedEventsJson = (
  parsedEvents: Array<Object>,
  project: any
): string => {
  const eventsList = new gd.EventsList();
  try {
    unserializeFromJSObject(
      eventsList,
      parsedEvents,
      'unserializeFrom',
      project
    );
    return serializeToJSON(eventsList);
  } finally {
    eventsList.delete();
  }
};
