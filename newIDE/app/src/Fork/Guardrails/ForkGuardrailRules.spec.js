// @flow
import {
  analyzeEventGuardrails,
  collectForkGuardrailDiagnostics,
  findActionWithoutPickingDiagnostics,
  findDuplicateOnceDiagnostic,
  findOnceInLoopDiagnostic,
  findWaitInLoopDiagnostic,
  FORK_GUARDRAIL_RULES,
  FORK_GUARDRAIL_RULE_IDS,
  getObjectParameterNamesFromMetadata,
} from './ForkGuardrailRules';
import { serializeToJSON } from '../../Utils/Serializer';

const gd: libGDevelop = global.gd;

// -- Duck-typed fixtures (pure-function tests) --------------------------------
// Mirroring the shape the real `gd` events expose, so the defensive accessors
// are exercised on both fakes and (below) real WebIDL objects.

const makeFakeInstruction = (
  type: any,
  parameters: Array<string> = []
): any => ({
  getType: () => type,
  getParametersCount: () => parameters.length,
  getParameter: (index: number) => ({
    getPlainString: () => parameters[index],
  }),
});

const makeFakeInstructionsList = (instructions: Array<any>): any => ({
  size: () => instructions.length,
  get: (index: number) => instructions[index] || null,
});

const makeFakeEvent = (options: {|
  type?: string,
  conditions?: Array<any>,
  actions?: Array<any>,
  whileConditions?: Array<any>,
  subEvents?: Array<any>,
  disabled?: boolean,
  folded?: boolean,
|}): any => ({
  getType: () => options.type || 'BuiltinCommonInstructions::Standard',
  isDisabled: () => !!options.disabled,
  isFolded: () => !!options.folded,
  getInstructionList: (label: string) => {
    if (label === 'conditions') {
      return makeFakeInstructionsList(options.conditions || []);
    }
    if (label === 'actions') {
      return makeFakeInstructionsList(options.actions || []);
    }
    if (label === 'whileConditions') {
      // Only a While event has this list — everything else answers null,
      // exactly like the real binding answers a null pointer.
      if (options.type !== WHILE) return null;
      return makeFakeInstructionsList(options.whileConditions || []);
    }
    return null;
  },
  getSubEvents: () =>
    makeFakeEventsList(options.subEvents ? options.subEvents : []),
});

const makeFakeEventsList = (events: Array<any>): any => ({
  getEventsCount: () => events.length,
  getEventAt: (index: number) => events[index] || null,
});

const ONCE = 'BuiltinCommonInstructions::Once';
const WAIT = 'BuiltinCommonInstructions::Wait';
const FOR_EACH = 'BuiltinCommonInstructions::ForEach';
const REPEAT = 'BuiltinCommonInstructions::Repeat';
const WHILE = 'BuiltinCommonInstructions::While';

const onceCondition = makeFakeInstruction(ONCE);
const waitAction = makeFakeInstruction(WAIT);

// -- Real gd fixtures ----------------------------------------------------------
// Events are created with `insertNewEvent` — the pattern the events sheet
// itself uses (EventsSheet/index.js) — because inserting a raw
// `new gd.XxxEvent()` template loses the event type (the WebIDL binding
// slices it through BaseEvent), which would make every rule blind.

/** Insert a real instruction of the given type at the end of a list. */
const insertRealInstruction = (
  instructionsList: any,
  type: string,
  parameters: Array<string> = []
): any => {
  const instruction = new gd.Instruction();
  instruction.setType(type);
  // The parameter count must be declared before values are set — setParameter
  // does not grow the list on its own.
  instruction.setParametersCount(parameters.length);
  parameters.forEach((parameter, index) => {
    instruction.setParameter(index, parameter);
  });
  const inserted = instructionsList.insert(
    instruction,
    instructionsList.size()
  );
  instruction.delete();
  return inserted;
};

const ruleIdsOf = (diagnostics: Array<any>): Array<string> =>
  diagnostics.map(diagnostic => diagnostic.ruleId);

// -- The registry --------------------------------------------------------------

describe('the fork guardrail rule registry', () => {
  it('registers the four v1 rule ids, all enabled by default', () => {
    expect(FORK_GUARDRAIL_RULE_IDS).toEqual([
      'G18-once-in-loop',
      'G18-wait-in-loop',
      'G18-action-without-picking',
      'G18-duplicate-once',
    ]);
    for (const ruleId of FORK_GUARDRAIL_RULE_IDS) {
      expect(FORK_GUARDRAIL_RULES[ruleId].defaultEnabled).toBe(true);
    }
  });

  it('gives the warnings warning severity and the picking advisory info', () => {
    expect(FORK_GUARDRAIL_RULES['G18-once-in-loop'].severity).toBe('warning');
    expect(FORK_GUARDRAIL_RULES['G18-wait-in-loop'].severity).toBe('warning');
    expect(FORK_GUARDRAIL_RULES['G18-duplicate-once'].severity).toBe('warning');
    expect(FORK_GUARDRAIL_RULES['G18-action-without-picking'].severity).toBe(
      'info'
    );
  });
});

// -- G18-once-in-loop ----------------------------------------------------------

describe('G18-once-in-loop', () => {
  it('fires under a ForEach, Repeat and While ancestor', () => {
    for (const loopType of [FOR_EACH, REPEAT, WHILE]) {
      const diagnostics = findOnceInLoopDiagnostic({
        event: makeFakeEvent({ conditions: [onceCondition] }),
        ancestors: [
          { event: makeFakeEvent({ type: loopType }), indexInList: 0 },
        ],
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].ruleId).toBe('G18-once-in-loop');
      expect(diagnostics[0].severity).toBe('warning');
      expect(diagnostics[0].message).toContain('loop');
    }
  });

  it('does not fire top-level, nor under a non-loop ancestor', () => {
    const topLevel = findOnceInLoopDiagnostic({
      event: makeFakeEvent({ conditions: [onceCondition] }),
      ancestors: [],
    });
    expect(topLevel).toEqual([]);

    const underStandard = findOnceInLoopDiagnostic({
      event: makeFakeEvent({ conditions: [onceCondition] }),
      ancestors: [
        {
          event: makeFakeEvent({
            type: 'BuiltinCommonInstructions::Standard',
          }),
          indexInList: 0,
        },
      ],
    });
    expect(underStandard).toEqual([]);
  });

  it('fires for a Once in a While event own while-conditions, with no loop ancestor', () => {
    // The deferred [P18-while-conditions-unscanned] case: the While event
    // itself IS the loop — its guard conditions are re-checked on every
    // iteration, so a Once there traps exactly like a Once in a child.
    const diagnostics = findOnceInLoopDiagnostic({
      event: makeFakeEvent({ type: WHILE, whileConditions: [onceCondition] }),
      ancestors: [],
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe('G18-once-in-loop');
    expect(diagnostics[0].message).toContain('loop');
  });

  it('does not fire for a Once in a While event body conditions without a loop ancestor', () => {
    // The body conditions of a While event are evaluated once per frame,
    // before the loop starts — a Once there is not inside the loop.
    const diagnostics = findOnceInLoopDiagnostic({
      event: makeFakeEvent({ type: WHILE, conditions: [onceCondition] }),
      ancestors: [],
    });
    expect(diagnostics).toEqual([]);
  });

  it('still fires exactly once when the Once sits in both lists of a nested While', () => {
    const diagnostics = findOnceInLoopDiagnostic({
      event: makeFakeEvent({
        type: WHILE,
        conditions: [onceCondition],
        whileConditions: [onceCondition],
      }),
      ancestors: [{ event: makeFakeEvent({ type: FOR_EACH }), indexInList: 0 }],
    });
    expect(diagnostics).toHaveLength(1);
  });
});

// -- G18-wait-in-loop ----------------------------------------------------------

describe('G18-wait-in-loop', () => {
  it('fires under a ForEach and Repeat ancestor', () => {
    for (const loopType of [FOR_EACH, REPEAT]) {
      const diagnostics = findWaitInLoopDiagnostic({
        event: makeFakeEvent({ actions: [waitAction] }),
        ancestors: [
          { event: makeFakeEvent({ type: loopType }), indexInList: 0 },
        ],
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].ruleId).toBe('G18-wait-in-loop');
      expect(diagnostics[0].message).toContain('Wait');
    }
  });

  it('does not fire under a While ancestor (a While guard is re-checked) nor top-level', () => {
    const underWhile = findWaitInLoopDiagnostic({
      event: makeFakeEvent({ actions: [waitAction] }),
      ancestors: [{ event: makeFakeEvent({ type: WHILE }), indexInList: 0 }],
    });
    expect(underWhile).toEqual([]);

    const topLevel = findWaitInLoopDiagnostic({
      event: makeFakeEvent({ actions: [waitAction] }),
      ancestors: [],
    });
    expect(topLevel).toEqual([]);
  });
});

// -- G18-action-without-picking --------------------------------------------------

const resolverReturning = (
  conditionsByType: { [string]: Array<string> },
  actionsByType: { [string]: Array<string> }
) => (instruction: any, isCondition: boolean) => {
  const table = isCondition ? conditionsByType : actionsByType;
  const names = table[instruction.getType()];
  return names === undefined ? null : names;
};

describe('G18-action-without-picking', () => {
  const resolver = resolverReturning(
    { 'Cond.Picks': ['Player'] },
    { 'Act.Move': ['Player'], 'Act.Delete': ['Enemy'] }
  );

  it('fires only for the objects no condition of the same event references', () => {
    const event = makeFakeEvent({
      conditions: [makeFakeInstruction('Cond.Picks')],
      actions: [
        makeFakeInstruction('Act.Move'),
        makeFakeInstruction('Act.Delete'),
      ],
    });
    const diagnostics = findActionWithoutPickingDiagnostics({
      event,
      getObjectParameterNames: resolver,
    });
    expect(ruleIdsOf(diagnostics)).toEqual(['G18-action-without-picking']);
    expect(diagnostics[0].severity).toBe('info');
    // The message names the unpicked object.
    expect(diagnostics[0].message).toContain('Enemy');
    expect(diagnostics[0].message).not.toContain('Player');
  });

  it('never fires when some condition references the object', () => {
    const event = makeFakeEvent({
      conditions: [makeFakeInstruction('Cond.Picks')],
      actions: [makeFakeInstruction('Act.Move')],
    });
    expect(
      findActionWithoutPickingDiagnostics({
        event,
        getObjectParameterNames: resolver,
      })
    ).toEqual([]);
  });

  it('fires when the event has no condition at all (the classic all-instances trap)', () => {
    const event = makeFakeEvent({
      actions: [makeFakeInstruction('Act.Delete')],
    });
    const diagnostics = findActionWithoutPickingDiagnostics({
      event,
      getObjectParameterNames: resolver,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('Enemy');
  });

  it('dedupes identical (ruleId, object) pairs across the actions of one event', () => {
    const event = makeFakeEvent({
      actions: [
        makeFakeInstruction('Act.Delete'),
        makeFakeInstruction('Act.Delete'),
      ],
    });
    expect(
      findActionWithoutPickingDiagnostics({
        event,
        getObjectParameterNames: resolver,
      })
    ).toHaveLength(1);
  });

  it('yields nothing when the resolver cannot resolve the instruction', () => {
    const event = makeFakeEvent({
      actions: [makeFakeInstruction('Act.UnknownToResolver')],
    });
    expect(
      findActionWithoutPickingDiagnostics({
        event,
        getObjectParameterNames: resolver,
      })
    ).toEqual([]);
  });

  it('falls back to known object names when metadata is not available', () => {
    const event = makeFakeEvent({
      conditions: [makeFakeInstruction('Custom.Cond', ['Coin'])],
      actions: [makeFakeInstruction('Custom.Act', ['Player'])],
    });
    const diagnostics = findActionWithoutPickingDiagnostics({
      event,
      knownObjectNames: ['Player', 'Coin'],
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('Player');
  });

  it('counts a While event while-conditions as picking conditions', () => {
    // The while-conditions pick objects for the event's actions exactly
    // like body conditions do — an action on an object referenced only in
    // the loop guard must not be reported as unpicked.
    const whileEvent = makeFakeEvent({
      type: WHILE,
      whileConditions: [makeFakeInstruction('Cond.Picks')],
      actions: [makeFakeInstruction('Act.Move')],
    });
    expect(
      findActionWithoutPickingDiagnostics({
        event: whileEvent,
        getObjectParameterNames: resolver,
      })
    ).toEqual([]);

    // And the reverse: an object referenced by NO condition of either list
    // is still reported on a While event.
    const unpickedWhileEvent = makeFakeEvent({
      type: WHILE,
      whileConditions: [makeFakeInstruction('Cond.Picks')],
      actions: [makeFakeInstruction('Act.Delete')],
    });
    const diagnostics = findActionWithoutPickingDiagnostics({
      event: unpickedWhileEvent,
      getObjectParameterNames: resolver,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('Enemy');
  });
});

// -- G18-duplicate-once ----------------------------------------------------------

describe('G18-duplicate-once', () => {
  it('fires when the same conditions list holds two Once conditions', () => {
    const diagnostics = findDuplicateOnceDiagnostic({
      event: makeFakeEvent({
        conditions: [onceCondition, onceCondition],
      }),
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe('G18-duplicate-once');
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toContain('last one');
  });

  it('does not fire for a single Once, nor for Once split across parent and child', () => {
    expect(findDuplicateOnceDiagnostic({ event: makeFakeEvent({}) })).toEqual(
      []
    );

    const collected = collectForkGuardrailDiagnostics(
      makeFakeEventsList([
        makeFakeEvent({
          conditions: [onceCondition],
          subEvents: [makeFakeEvent({ conditions: [onceCondition] })],
        }),
      ]),
      { getObjectParameterNames: () => null }
    );
    expect(ruleIdsOf(collected)).toEqual([]);
  });

  it('fires for two Once conditions in a While event while-conditions list', () => {
    const diagnostics = findDuplicateOnceDiagnostic({
      event: makeFakeEvent({
        type: WHILE,
        whileConditions: [onceCondition, onceCondition],
      }),
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe('G18-duplicate-once');
  });

  it('does not fire for one Once in the body conditions and one in the while-conditions', () => {
    // Different lists, different evaluations — not a duplicate the
    // sanitizer would repair.
    const diagnostics = findDuplicateOnceDiagnostic({
      event: makeFakeEvent({
        type: WHILE,
        conditions: [onceCondition],
        whileConditions: [onceCondition],
      }),
    });
    expect(diagnostics).toEqual([]);
  });
});

// -- The per-event analyzer ------------------------------------------------------

describe('analyzeEventGuardrails', () => {
  it('reports both once-in-loop and duplicate-once on the same event', () => {
    const diagnostics = analyzeEventGuardrails({
      event: makeFakeEvent({ conditions: [onceCondition, onceCondition] }),
      ancestors: [{ event: makeFakeEvent({ type: FOR_EACH }), indexInList: 0 }],
      indexInList: 0,
      getObjectParameterNames: () => null,
    });
    expect(ruleIdsOf(diagnostics)).toEqual([
      'G18-once-in-loop',
      'G18-duplicate-once',
    ]);
  });

  it('skips a disabled event and everything under a disabled ancestor', () => {
    const selfDisabled = analyzeEventGuardrails({
      event: makeFakeEvent({
        conditions: [onceCondition, onceCondition],
        disabled: true,
      }),
      ancestors: [],
      indexInList: 0,
    });
    expect(selfDisabled).toEqual([]);

    const ancestorDisabled = analyzeEventGuardrails({
      event: makeFakeEvent({ conditions: [onceCondition] }),
      ancestors: [
        {
          event: makeFakeEvent({ type: FOR_EACH, disabled: true }),
          indexInList: 0,
        },
      ],
      indexInList: 0,
    });
    expect(ancestorDisabled).toEqual([]);
  });

  it('degrades to no diagnostic on broken or missing inputs instead of crashing', () => {
    expect(
      analyzeEventGuardrails({ event: null, ancestors: [], indexInList: 0 })
    ).toEqual([]);
    expect(
      analyzeEventGuardrails({ event: {}, ancestors: [], indexInList: 0 })
    ).toEqual([]);
    // A non-string instruction type is ignored, not fatal.
    const weirdType = analyzeEventGuardrails({
      event: makeFakeEvent({
        conditions: [makeFakeInstruction(42)],
        actions: [makeFakeInstruction(null)],
      }),
      ancestors: [{ event: makeFakeEvent({ type: FOR_EACH }), indexInList: 0 }],
      indexInList: 0,
    });
    expect(weirdType).toEqual([]);
  });

  it('reads conditions/actions through the getConditions/getActions fallback too', () => {
    const duckTypedEvent = {
      getType: () => 'BuiltinCommonInstructions::Standard',
      isDisabled: () => false,
      isFolded: () => false,
      getConditions: () => makeFakeInstructionsList([onceCondition]),
      getActions: () => makeFakeInstructionsList([]),
      getSubEvents: () => makeFakeEventsList([]),
    };
    const diagnostics = analyzeEventGuardrails({
      event: duckTypedEvent,
      ancestors: [{ event: makeFakeEvent({ type: REPEAT }), indexInList: 0 }],
      indexInList: 0,
    });
    expect(ruleIdsOf(diagnostics)).toEqual(['G18-once-in-loop']);
  });
});

// -- The sheet-wide collector ----------------------------------------------------

describe('collectForkGuardrailDiagnostics', () => {
  it('locates every diagnostic with the tree builder nodePath encoding', () => {
    const diagnostics = collectForkGuardrailDiagnostics(
      makeFakeEventsList([
        makeFakeEvent({
          type: FOR_EACH,
          subEvents: [
            makeFakeEvent({ conditions: [onceCondition] }),
            makeFakeEvent({ actions: [waitAction] }),
          ],
        }),
        makeFakeEvent({ conditions: [onceCondition, onceCondition] }),
      ]),
      { getObjectParameterNames: () => null }
    );

    expect(diagnostics).toHaveLength(3);
    // Depth-first pre-order flattened indices: ForEach=0, child0=1, child1=2, top=3.
    expect(diagnostics[0]).toMatchObject({
      ruleId: 'G18-once-in-loop',
      nodePath: [0, 1],
    });
    expect(diagnostics[1]).toMatchObject({
      ruleId: 'G18-wait-in-loop',
      nodePath: [0, 2],
    });
    expect(diagnostics[2]).toMatchObject({
      ruleId: 'G18-duplicate-once',
      nodePath: [3],
    });
  });

  it('restarts the flattened index inside a folded subtree, like the builder', () => {
    const diagnostics = collectForkGuardrailDiagnostics(
      makeFakeEventsList([
        makeFakeEvent({
          type: FOR_EACH,
          folded: true,
          subEvents: [
            makeFakeEvent({ conditions: [onceCondition] }),
            makeFakeEvent({ conditions: [onceCondition] }),
          ],
        }),
      ]),
      { getObjectParameterNames: () => null }
    );
    // The folded parent gets the throwaway list: its children count from 0.
    expect(diagnostics.map(diagnostic => diagnostic.nodePath)).toEqual([
      [0, 0],
      [0, 1],
    ]);
  });

  it('terminates on deeply nested sheets and still reports the trap', () => {
    let innermost = makeFakeEvent({ conditions: [onceCondition] });
    let sheet = innermost;
    for (let depth = 0; depth < 6; depth++) {
      sheet = makeFakeEvent({ subEvents: [sheet] });
    }
    const loopSheet = makeFakeEvent({ type: FOR_EACH, subEvents: [sheet] });
    const diagnostics = collectForkGuardrailDiagnostics(
      makeFakeEventsList([loopSheet]),
      { getObjectParameterNames: () => null }
    );
    expect(ruleIdsOf(diagnostics)).toEqual(['G18-once-in-loop']);
    expect(diagnostics[0].nodePath).toHaveLength(8);
  });

  it('returns nothing for an empty sheet or lists of length 0', () => {
    expect(collectForkGuardrailDiagnostics(makeFakeEventsList([]))).toEqual([]);
    expect(
      collectForkGuardrailDiagnostics(makeFakeEventsList([makeFakeEvent({})]))
    ).toEqual([]);
  });
});

// -- Real gd objects: prove the accessors match reality --------------------------

describe('the guardrail rules against real gd events', () => {
  const buildTrapSheet = (): any => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    const eventsList = new gd.EventsList();
    const forEachEvent = eventsList.insertNewEvent(project, FOR_EACH, 0);
    const childEvent = forEachEvent
      .getSubEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Standard', 0);
    insertRealInstruction(gd.asStandardEvent(childEvent).getConditions(), ONCE);
    return { project, eventsList };
  };

  it('detects a Once inside a real ForEach and locates it at [0, 1]', () => {
    const { project, eventsList } = buildTrapSheet();
    try {
      const diagnostics = collectForkGuardrailDiagnostics(eventsList, {
        getObjectParameterNames: () => null,
      });
      expect(ruleIdsOf(diagnostics)).toEqual(['G18-once-in-loop']);
      expect(diagnostics[0].nodePath).toEqual([0, 1]);
    } finally {
      eventsList.delete();
      project.delete();
    }
  });

  it('detects a Once in a real While event while-conditions ([P18])', () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    const eventsList = new gd.EventsList();
    try {
      const whileEvent = eventsList.insertNewEvent(project, WHILE, 0);
      insertRealInstruction(
        gd.asWhileEvent(whileEvent).getWhileConditions(),
        ONCE
      );

      const diagnostics = collectForkGuardrailDiagnostics(eventsList, {
        getObjectParameterNames: () => null,
      });
      expect(ruleIdsOf(diagnostics)).toEqual(['G18-once-in-loop']);
      expect(diagnostics[0].nodePath).toEqual([0]);

      // The same While event with the Once in its BODY conditions (no loop
      // ancestor) stays clean — those are evaluated once per frame.
      const secondWhile = eventsList.insertNewEvent(project, WHILE, 1);
      insertRealInstruction(gd.asWhileEvent(secondWhile).getConditions(), ONCE);
      const allDiagnostics = collectForkGuardrailDiagnostics(eventsList, {
        getObjectParameterNames: () => null,
      });
      expect(ruleIdsOf(allDiagnostics)).toEqual(['G18-once-in-loop']);
      expect(allDiagnostics[0].nodePath).toEqual([0]);
    } finally {
      eventsList.delete();
      project.delete();
    }
  });

  it('never mutates the events data (serialization identical before/after)', () => {
    const { project, eventsList } = buildTrapSheet();
    try {
      const before = serializeToJSON(eventsList);
      collectForkGuardrailDiagnostics(eventsList);
      const after = serializeToJSON(eventsList);
      expect(after).toBe(before);
    } finally {
      eventsList.delete();
      project.delete();
    }
  });

  it('resolves real object parameters through the instruction metadata', () => {
    const instruction = new gd.Instruction();
    try {
      instruction.setType('SetX');
      instruction.setParametersCount(3);
      instruction.setParameter(0, 'Player');
      expect(getObjectParameterNamesFromMetadata(instruction, false)).toEqual([
        'Player',
      ]);
    } finally {
      instruction.delete();
    }
  });

  it('runs the picking advisory on real events through the metadata resolver', () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    const eventsList = new gd.EventsList();
    try {
      const standardEvent = eventsList.insertNewEvent(
        project,
        'BuiltinCommonInstructions::Standard',
        0
      );
      insertRealInstruction(
        gd.asStandardEvent(standardEvent).getActions(),
        'SetX',
        ['Player', '0', '+']
      );

      const diagnostics = collectForkGuardrailDiagnostics(eventsList);
      expect(ruleIdsOf(diagnostics)).toEqual(['G18-action-without-picking']);
      expect(diagnostics[0].nodePath).toEqual([0]);
      expect(diagnostics[0].severity).toBe('info');

      // The same event with a picking condition on Player is clean.
      insertRealInstruction(
        gd.asStandardEvent(standardEvent).getConditions(),
        'PosX',
        ['Player', '<', '100']
      );
      expect(ruleIdsOf(collectForkGuardrailDiagnostics(eventsList))).toEqual(
        []
      );
    } finally {
      eventsList.delete();
      project.delete();
    }
  });
});
