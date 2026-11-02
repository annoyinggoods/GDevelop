// @flow

/**
 * Phase 18.1 — the event-sheet guardrail rule engine (D18-1/D18-2/D18-5).
 *
 * What this is: pure, read-only predicates over `gd` events that flag the
 * owner's three worst workflow traps — Trigger Once inside a loop, Wait
 * stacking up inside a loop, actions hitting every instance because no
 * condition picked a subset, and duplicated Trigger Once conditions. No
 * React, no project, no filesystem: the tree builder (18.2) and the AI scan
 * tool (18.3) both call into this module.
 *
 * Never mutates and never throws: every `gd` accessor is guarded, and a rule
 * that cannot read what it needs degrades to "no diagnostic" rather than
 * breaking the events sheet.
 */

export type ForkGuardrailSeverity = 'warning' | 'info';

/** A diagnostic for a single event, before it is located on a row. */
export type ForkGuardrailEventDiagnostic = {|
  ruleId: string,
  severity: ForkGuardrailSeverity,
  message: string,
|};

/** A diagnostic located on the sheet: `nodePath` is the tree's row encoding. */
export type ForkGuardrailDiagnostic = {|
  ruleId: string,
  severity: ForkGuardrailSeverity,
  message: string,
  nodePath: Array<number>,
|};

/** One ancestor of an event, as threaded by the tree builder's recursion. */
export type ForkGuardrailAncestor = {|
  event: any,
  indexInList: number,
|};

/**
 * Resolves the object names an instruction references, or `null` when the
 * objects cannot be determined in this context (the picking rule then yields
 * nothing for that instruction instead of guessing).
 */
export type ForkGuardrailObjectParameterNamesResolver = (
  instruction: any,
  isCondition: boolean
) => Array<string> | null;

export type ForkGuardrailAnalysisOptions = {|
  event: any,
  ancestors: $ReadOnlyArray<ForkGuardrailAncestor>,
  indexInList: number,
  getObjectParameterNames?: ForkGuardrailObjectParameterNamesResolver,
  knownObjectNames?: $ReadOnlyArray<string>,
|};

export const FORK_GUARDRAIL_RULE_IDS: Array<string> = [
  'G18-once-in-loop',
  'G18-wait-in-loop',
  'G18-action-without-picking',
  'G18-duplicate-once',
];

export const FORK_GUARDRAIL_RULES: {
  [ruleId: string]: {|
    severity: ForkGuardrailSeverity,
    defaultEnabled: boolean,
  |},
} = {
  'G18-once-in-loop': { severity: 'warning', defaultEnabled: true },
  'G18-wait-in-loop': { severity: 'warning', defaultEnabled: true },
  'G18-action-without-picking': { severity: 'info', defaultEnabled: true },
  'G18-duplicate-once': { severity: 'warning', defaultEnabled: true },
};

const ONCE_CONDITION_TYPE = 'BuiltinCommonInstructions::Once';
const WAIT_ACTION_TYPE = 'BuiltinCommonInstructions::Wait';
const LOOP_EVENT_TYPES = [
  'BuiltinCommonInstructions::ForEach',
  'BuiltinCommonInstructions::Repeat',
  'BuiltinCommonInstructions::While',
];
const WAIT_LOOP_EVENT_TYPES = [
  'BuiltinCommonInstructions::ForEach',
  'BuiltinCommonInstructions::Repeat',
];

const ONCE_IN_LOOP_MESSAGE =
  'Trigger Once is used inside a loop: once it becomes true, the loop does nothing for the remaining objects or iterations.';
const WAIT_IN_LOOP_MESSAGE =
  'A Wait action is used inside a For Each or Repeat loop: every iteration queues its own wait, so the waits stack up and desynchronize the loop.';
const duplicateOnceMessage =
  'This event has several Trigger Once conditions: GDevelop keeps only the last one, the duplicates are silently ignored.';
const actionWithoutPickingMessage = (objectName: string) =>
  `No condition of this event picks "${objectName}", so the action is applied to every instance of ${objectName} in the scene.`;

// -- Defensive `gd` accessors ------------------------------------------------
// The events sheet rebuilds its tree on every change; a guardrail must never
// throw in the middle of that (a null instruction list on a Link event, a
// duck-typed fake in a test, a not-yet-loaded platform... all must degrade).

const runSafely = <T>(run: () => T, fallback: T): T => {
  try {
    return run();
  } catch (error) {
    return fallback;
  }
};

const getInstructionType = (instruction: any): string => {
  const type = runSafely(
    () =>
      instruction && typeof instruction.getType === 'function'
        ? instruction.getType()
        : '',
    ''
  );
  return typeof type === 'string' ? type : '';
};

const isNullPointer = (gdObject: any): boolean =>
  runSafely(() => {
    const gdModule: any = global.gd;
    if (!gdModule || typeof gdModule.getPointer !== 'function') return false;
    return gdModule.getPointer(gdObject) === 0;
  }, false);

/** A live snapshot of an instructions list, or [] when it cannot be read. */
const getSnapshotOfInstructionsList = (instructionsList: any): Array<any> => {
  const isValidList =
    instructionsList &&
    typeof instructionsList.size === 'function' &&
    typeof instructionsList.get === 'function';
  if (!isValidList || isNullPointer(instructionsList)) return [];
  return runSafely(() => {
    const instructions: Array<any> = [];
    for (let i = 0; i < instructionsList.size(); i++) {
      const instruction = instructionsList.get(i);
      if (instruction) instructions.push(instruction);
    }
    return instructions;
  }, []);
};

/**
 * The conditions, actions, or While-guard conditions of an event. Real `gd`
 * events expose them through `getInstructionList` (a While event answers a
 * distinct `whileConditions` list — the loop guard re-checked on every
 * iteration, [P18-while-conditions-unscanned]); duck-typed fakes often
 * expose `getConditions`/`getActions` directly — both are supported,
 * defensively. Events without the requested list (a non-While event asked
 * for its while-conditions) degrade to [].
 */
const getEventInstructions = (
  event: any,
  listName: 'conditions' | 'actions' | 'whileConditions'
): Array<any> =>
  runSafely(() => {
    if (!event) return [];
    if (typeof event.getInstructionList === 'function') {
      return getSnapshotOfInstructionsList(event.getInstructionList(listName));
    }
    const directAccessor =
      listName === 'conditions' ? event.getConditions : event.getActions;
    if (typeof directAccessor === 'function') {
      return getSnapshotOfInstructionsList(directAccessor.call(event));
    }
    return [];
  }, []);

const getEventType = (event: any): string => {
  const type = runSafely(
    () => (event && typeof event.getType === 'function' ? event.getType() : ''),
    ''
  );
  return typeof type === 'string' ? type : '';
};

const isEventDisabled = (event: any): boolean =>
  runSafely(
    () =>
      !!event &&
      typeof event.isDisabled === 'function' &&
      event.isDisabled() === true,
    false
  );

const isEventFolded = (event: any): boolean =>
  runSafely(
    () =>
      !!event &&
      typeof event.isFolded === 'function' &&
      event.isFolded() === true,
    false
  );

const getSubEventsList = (event: any): any =>
  runSafely(() => {
    if (!event || typeof event.getSubEvents !== 'function') return null;
    const subEvents = event.getSubEvents();
    if (isNullPointer(subEvents)) return null;
    return subEvents;
  }, null);

const getEventsCountInList = (eventsList: any): number =>
  runSafely(() => {
    if (!eventsList || typeof eventsList.getEventsCount !== 'function') {
      return 0;
    }
    const count = eventsList.getEventsCount();
    return typeof count === 'number' && count >= 0 ? count : 0;
  }, 0);

const getEventAtInList = (eventsList: any, index: number): any | null =>
  runSafely(() => {
    if (!eventsList || typeof eventsList.getEventAt !== 'function') {
      return null;
    }
    const event = eventsList.getEventAt(index);
    return event || null;
  }, null);

const hasAncestorOfType = (
  ancestors: $ReadOnlyArray<ForkGuardrailAncestor>,
  eventTypes: $ReadOnlyArray<string>
): boolean =>
  ancestors.some(ancestor =>
    eventTypes.some(type => getEventType(ancestor.event) === type)
  );

const isInstructionOfType = (instruction: any, type: string): boolean =>
  getInstructionType(instruction) === type;

// -- Object parameter resolution (for the picking advisory) ------------------

/**
 * Resolve an instruction's object parameters from its metadata on the JS
 * platform (the same lookup the events sheet does when rendering an
 * instruction). Returns null when the metadata is unavailable — the caller
 * then falls back, or skips the instruction.
 */
export const getObjectParameterNamesFromMetadata = (
  instruction: any,
  isCondition: boolean
): Array<string> | null =>
  runSafely(() => {
    const gdModule: any = global.gd;
    if (!gdModule || !instruction) return null;
    const type = getInstructionType(instruction);
    if (!type) return null;
    const platform = gdModule.JsPlatform.get();
    const metadata = isCondition
      ? gdModule.MetadataProvider.getConditionMetadata(platform, type)
      : gdModule.MetadataProvider.getActionMetadata(platform, type);
    if (gdModule.MetadataProvider.isBadInstructionMetadata(metadata)) {
      return null;
    }
    const parameters = metadata.getParameters();
    const names: Array<string> = [];
    const metadataParametersCount = parameters.getParametersCount();
    const instructionParametersCount = instruction.getParametersCount();
    for (let i = 0; i < metadataParametersCount; i++) {
      const parameterMetadata = parameters.getParameterAt(i);
      if (!gdModule.ParameterMetadata.isObject(parameterMetadata.getType())) {
        continue;
      }
      if (i >= instructionParametersCount) continue;
      const objectName = instruction.getParameter(i).getPlainString();
      if (typeof objectName === 'string' && objectName.length > 0) {
        names.push(objectName);
      }
    }
    return names;
  }, null);

/**
 * Fallback resolution for contexts without metadata: a parameter whose plain
 * string value is exactly a known object name is taken as an object
 * parameter. Returns null when no known names were provided.
 */
export const getObjectParameterNamesByKnownNames = (
  instruction: any,
  knownObjectNames: ?$ReadOnlyArray<string>
): Array<string> | null => {
  if (!knownObjectNames || knownObjectNames.length === 0) return null;
  const knownNamesSet = new Set<string>(knownObjectNames);
  return runSafely(() => {
    const names: Array<string> = [];
    if (!instruction || typeof instruction.getParametersCount !== 'function') {
      return names;
    }
    const parametersCount = instruction.getParametersCount();
    for (let i = 0; i < parametersCount; i++) {
      const plainString = instruction.getParameter(i).getPlainString();
      if (typeof plainString === 'string' && knownNamesSet.has(plainString)) {
        names.push(plainString);
      }
    }
    return names;
  }, []);
};

const makeDefaultObjectParameterNamesResolver = (
  knownObjectNames: ?$ReadOnlyArray<string>
): ForkGuardrailObjectParameterNamesResolver => (
  instruction: any,
  isCondition: boolean
) => {
  const fromMetadata = getObjectParameterNamesFromMetadata(
    instruction,
    isCondition
  );
  if (fromMetadata !== null) return fromMetadata;
  return getObjectParameterNamesByKnownNames(instruction, knownObjectNames);
};

const getAnalysisResolver = (
  options: ForkGuardrailAnalysisOptions
): ForkGuardrailObjectParameterNamesResolver => {
  if (options.getObjectParameterNames) return options.getObjectParameterNames;
  return makeDefaultObjectParameterNamesResolver(options.knownObjectNames);
};

// -- The v1 rule set (D18-2) ---------------------------------------------------
// Each rule is an isolated, independently callable predicate so a rule can be
// tested (and muted) alone.

/** G18-once-in-loop (warning): a Trigger Once condition inside a loop. */
export const findOnceInLoopDiagnostic = (options: {|
  event: any,
  ancestors: $ReadOnlyArray<ForkGuardrailAncestor>,
|}): Array<ForkGuardrailEventDiagnostic> => {
  // A While event's own while-conditions are re-checked on every iteration
  // of the loop they guard, so a Once there is inside a loop even when the
  // While event itself has no loop ancestor ([P18-while-conditions-unscanned]).
  const whileConditions = getEventInstructions(
    options.event,
    'whileConditions'
  );
  const hasOnceInWhileConditions = whileConditions.some(condition =>
    isInstructionOfType(condition, ONCE_CONDITION_TYPE)
  );
  if (hasOnceInWhileConditions) {
    return [
      {
        ruleId: 'G18-once-in-loop',
        severity: 'warning',
        message: ONCE_IN_LOOP_MESSAGE,
      },
    ];
  }
  if (!hasAncestorOfType(options.ancestors, LOOP_EVENT_TYPES)) return [];
  const conditions = getEventInstructions(options.event, 'conditions');
  const hasOnceCondition = conditions.some(condition =>
    isInstructionOfType(condition, ONCE_CONDITION_TYPE)
  );
  if (!hasOnceCondition) return [];
  return [
    {
      ruleId: 'G18-once-in-loop',
      severity: 'warning',
      message: ONCE_IN_LOOP_MESSAGE,
    },
  ];
};

/** G18-wait-in-loop (warning): a Wait action inside a For Each or Repeat loop. */
export const findWaitInLoopDiagnostic = (options: {|
  event: any,
  ancestors: $ReadOnlyArray<ForkGuardrailAncestor>,
|}): Array<ForkGuardrailEventDiagnostic> => {
  if (!hasAncestorOfType(options.ancestors, WAIT_LOOP_EVENT_TYPES)) return [];
  const actions = getEventInstructions(options.event, 'actions');
  const hasWaitAction = actions.some(action =>
    isInstructionOfType(action, WAIT_ACTION_TYPE)
  );
  if (!hasWaitAction) return [];
  return [
    {
      ruleId: 'G18-wait-in-loop',
      severity: 'warning',
      message: WAIT_IN_LOOP_MESSAGE,
    },
  ];
};

/**
 * G18-duplicate-once (warning): several Trigger Once conditions in the same
 * conditions list (the sanitizer silently repairs these; the guardrail
 * explains the repair). A While event's while-conditions list is scanned as
 * its own list ([P18-while-conditions-unscanned]): a Once in the body
 * conditions and one in the loop guard are two different evaluations, not a
 * duplicate.
 */
export const findDuplicateOnceDiagnostic = (options: {|
  event: any,
|}): Array<ForkGuardrailEventDiagnostic> => {
  const onceConditionsCount = (instructions: Array<any>): number =>
    instructions.filter(condition =>
      isInstructionOfType(condition, ONCE_CONDITION_TYPE)
    ).length;
  const conditions = getEventInstructions(options.event, 'conditions');
  const whileConditions = getEventInstructions(
    options.event,
    'whileConditions'
  );
  if (
    onceConditionsCount(conditions) < 2 &&
    onceConditionsCount(whileConditions) < 2
  ) {
    return [];
  }
  return [
    {
      ruleId: 'G18-duplicate-once',
      severity: 'warning',
      message: duplicateOnceMessage,
    },
  ];
};

/** Collect the object names of one action that no condition picks. */
const collectUnpickedObjectNames = (
  action: any,
  pickedObjectNames: Set<string>,
  resolver: ForkGuardrailObjectParameterNamesResolver
): Array<string> => {
  const actionObjectNames = resolver(action, false);
  if (!actionObjectNames) return [];
  return actionObjectNames.filter(objectName => {
    const isPickedElsewhere = pickedObjectNames.has(objectName);
    return !isPickedElsewhere && objectName.length > 0;
  });
};

/**
 * G18-action-without-picking (info): an action references an object that no
 * condition of the same event references — the action then applies to every
 * instance of that object. Advisory by design (D18-2): acting on all
 * instances is sometimes intended, hence info, not warning.
 */
export const findActionWithoutPickingDiagnostics = (options: {|
  event: any,
  getObjectParameterNames?: ForkGuardrailObjectParameterNamesResolver,
  knownObjectNames?: $ReadOnlyArray<string>,
|}): Array<ForkGuardrailEventDiagnostic> => {
  const resolver = getAnalysisResolver((options: any));
  const pickedObjectNames = new Set<string>();
  // A While event's while-conditions pick objects exactly like its body
  // conditions do ([P18-while-conditions-unscanned]) — both are conditions
  // of the same event for the picking question.
  const conditions = [
    ...getEventInstructions(options.event, 'conditions'),
    ...getEventInstructions(options.event, 'whileConditions'),
  ];
  for (const condition of conditions) {
    const conditionObjectNames = resolver(condition, true);
    if (!conditionObjectNames) continue;
    conditionObjectNames.forEach(objectName =>
      pickedObjectNames.add(objectName)
    );
  }

  // One diagnostic per object missed across the event's actions — identical
  // (ruleId, object) pairs are deduped.
  const missedObjectNames = new Set<string>();
  const actions = getEventInstructions(options.event, 'actions');
  for (const action of actions) {
    collectUnpickedObjectNames(action, pickedObjectNames, resolver).forEach(
      objectName => missedObjectNames.add(objectName)
    );
  }

  return Array.from(missedObjectNames)
    .sort()
    .map(objectName => ({
      ruleId: 'G18-action-without-picking',
      severity: 'info',
      message: actionWithoutPickingMessage(objectName),
    }));
};

// -- The per-event analyzer and the sheet-wide collector ----------------------

/**
 * Run every rule on one event. A disabled event — or any event inside a
 * disabled subtree — yields nothing: a disabled loop cannot trap, and a
 * disabled event does not run at all (re-enabling rebuilds the tree and the
 * diagnostics come back).
 */
export const analyzeEventGuardrails = (
  options: ForkGuardrailAnalysisOptions
): Array<ForkGuardrailEventDiagnostic> => {
  if (!options || !options.event) return [];
  if (isEventDisabled(options.event)) return [];
  const insideDisabledSubtree = options.ancestors.some(ancestor =>
    isEventDisabled(ancestor.event)
  );
  if (insideDisabledSubtree) return [];

  return [
    ...findOnceInLoopDiagnostic({
      event: options.event,
      ancestors: options.ancestors,
    }),
    ...findWaitInLoopDiagnostic({
      event: options.event,
      ancestors: options.ancestors,
    }),
    ...findActionWithoutPickingDiagnostics({
      event: options.event,
      getObjectParameterNames: options.getObjectParameterNames,
      knownObjectNames: options.knownObjectNames,
    }),
    ...findDuplicateOnceDiagnostic({ event: options.event }),
  ];
};

type ForkGuardrailCollectionContext = {|
  eventsList: any,
  ancestors: Array<ForkGuardrailAncestor>,
  flattenedCount: {| count: number |},
  parentAbsolutePath: Array<number>,
  diagnostics: Array<ForkGuardrailDiagnostic>,
  analysisOptions: {|
    getObjectParameterNames?: ForkGuardrailObjectParameterNamesResolver,
    knownObjectNames?: $ReadOnlyArray<string>,
  |},
|};

const appendEventDiagnostics = (
  context: ForkGuardrailCollectionContext,
  event: any,
  indexInList: number,
  absolutePath: Array<number>
): void => {
  const eventDiagnostics = analyzeEventGuardrails({
    event,
    ancestors: context.ancestors,
    indexInList,
    getObjectParameterNames: context.analysisOptions.getObjectParameterNames,
    knownObjectNames: context.analysisOptions.knownObjectNames,
  });
  for (const diagnostic of eventDiagnostics) {
    context.diagnostics.push({ ...diagnostic, nodePath: absolutePath });
  }
};

/**
 * Walk an events list recursively, mirroring the tree builder's walk
 * EXACTLY — including its flattened-list discipline, so every `nodePath`
 * matches the absolute row path `EventsTree/index.js` computes:
 * - each visited event occupies the next flattened index (depth-first
 *   pre-order);
 * - descending into a FOLDED event restarts from a throwaway flattened list,
 *   so indices inside a folded subtree are relative to that subtree.
 */
const collectFromEventsList = (
  context: ForkGuardrailCollectionContext
): void => {
  const eventsCount = getEventsCountInList(context.eventsList);
  for (let i = 0; i < eventsCount; i++) {
    const event = getEventAtInList(context.eventsList, i);
    if (!event) continue;
    context.flattenedCount.count += 1;
    const absoluteIndex = context.flattenedCount.count - 1;
    const currentAbsolutePath = context.parentAbsolutePath.concat(
      absoluteIndex
    );

    appendEventDiagnostics(context, event, i, currentAbsolutePath);

    collectFromEventsList({
      eventsList: getSubEventsList(event),
      ancestors: [...context.ancestors, { event, indexInList: i }],
      flattenedCount: isEventFolded(event)
        ? { count: 0 }
        : context.flattenedCount,
      parentAbsolutePath: currentAbsolutePath,
      diagnostics: context.diagnostics,
      analysisOptions: context.analysisOptions,
    });
  }
};

/**
 * Diagnostics for a whole events list (typically a scene's), each located by
 * the tree's row encoding. Read-only and never throws.
 */
export const collectForkGuardrailDiagnostics = (
  eventsList: any,
  options?: {|
    getObjectParameterNames?: ForkGuardrailObjectParameterNamesResolver,
    knownObjectNames?: $ReadOnlyArray<string>,
  |}
): Array<ForkGuardrailDiagnostic> => {
  const diagnostics: Array<ForkGuardrailDiagnostic> = [];
  collectFromEventsList({
    eventsList,
    ancestors: [],
    flattenedCount: { count: 0 },
    parentAbsolutePath: [],
    diagnostics,
    analysisOptions: options || {},
  });
  return diagnostics;
};
