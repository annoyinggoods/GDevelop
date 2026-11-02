/**
 * The BYOK dev-only eval harness (Phase 9.8): 41 real game-building tasks
 * scored mechanically, runnable on demand against any configured endpoint.
 * The instrument that tells whether a prompt/skill/tool change actually
 * helped — eval-driven tool development.
 *
 * This file lives OUTSIDE `src/`, so nothing of it enters the shipped app
 * bundle; `src/AiGeneration/Byok/evals/` holds its Jest self-check and is
 * dev-only by the same rule (no app module imports it — asserted by a test).
 *
 * Static-eval mode: the model is asked to answer with the tool calls it
 * *would* make, as strict JSON. The scorers then verify the outcome encoded
 * in those arguments (event structure, instance geometry, variable shapes,
 * code properties, repair coordinates) — no editor needed, so the suite runs
 * anywhere the endpoint is reachable. An LLM-as-judge pass is optional and
 * flagged as such in the report when enabled.
 *
 * Usage:
 *   node scripts/run-byok-evals.js --endpoint https://api.openai.com/v1 \
 *        --key sk-... --model gpt-4o [--judge-model gpt-4o] [--out REVIEW/evals]
 *
 * Report lines track the four numbers that matter per task:
 * pass/fail, rounds, tool calls, tokens.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The REAL BYOK system prompt and tool schemas (audit100226 SCRIPT-2).
 *
 * The harness used to send a two-message chat with neither, while its
 * scorers require argument names (`create_if_missing`, `brush_position`,
 * `children_to_add`, …) the model was never shown — so the authoring-reach
 * tasks were near-unpassable except by training prior, and any prompt or
 * tool-schema change this harness was supposed to measure had no effect on
 * the answer. Both are now loaded from the app modules themselves (never
 * re-implemented), through the same `@babel/register` bootstrap
 * `scripts/byok-embedder/eval-embedder.js` uses.
 *
 * The shims below are what webpack does for us inside the app: CSS modules
 * and binary assets are importable from the dependency chain, and a web
 * worker module assigns to `self`. None of them are needed Node-side.
 */
const loadByokPromptModules = async () => {
  if (!global.self) {
    global.self = global;
    global.postMessage = () => {};
  }
  for (const extension of [
    '.css',
    '.svg',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.woff',
    '.woff2',
  ]) {
    if (!require.extensions[extension]) {
      require.extensions[extension] = () => {};
    }
  }
  if (!require.extensions['.js'].__byokBabelRegistered) {
    // eslint-disable-next-line import/no-unresolved
    require('@babel/register')({});
    require.extensions['.js'].__byokBabelRegistered = true;
  }
  // eslint-disable-next-line import/no-unresolved
  const toolSchema = require('../src/AiGeneration/Byok/ByokToolSchema');
  // eslint-disable-next-line import/no-unresolved
  const sections = require('../src/AiGeneration/Byok/Knowledge/ByokKnowledgeSections');
  // eslint-disable-next-line import/no-unresolved
  const prompts = require('../src/AiGeneration/Byok/ByokPrompts');
  // eslint-disable-next-line import/no-unresolved
  const skills = require('../src/AiGeneration/Byok/ByokSkills');

  const hasOpenedProject = true;
  const toolNames = toolSchema.getByokAdvertisedToolNames({ hasOpenedProject });
  return {
    systemPrompt: prompts.buildByokSystemPrompt({
      toolNames,
      hasOpenedProject,
      context: sections.makeByokPromptContext({
        toolNames,
        hasOpenedProject,
        skills: await skills.listByokSkillMetadata(),
        engineReferenceAvailable: true,
        projectNotes: null,
        customInstructions: '',
      }),
    }),
    tools: toolSchema.toOpenAiToolsFormat(
      toolSchema.getByokToolSchemasForNames(toolNames)
    ),
  };
};

// ----------------------------------------------------------------------
// The task suite.
// ----------------------------------------------------------------------

/**
 * One eval task. `scorer` receives the parsed model answer
 * `{ answerText, toolCalls }` and returns `{ passed, reason }`.
 */
const makeTask = (id, category, prompt, scorer) => ({
  id,
  category,
  prompt,
  scorer,
});

// Small assertion helpers shared by the scorers.
const findToolCall = (result, name) =>
  result.toolCalls.find(call => call.name === name) || null;

const collectToolCall = (result, name) => {
  const calls = result.toolCalls.filter(call => call.name === name);
  return calls.length > 0 ? calls[0] : null;
};

const parseArgs = call => {
  if (!call) return null;
  if (call.arguments && typeof call.arguments === 'object') {
    return call.arguments;
  }
  try {
    return JSON.parse(call.arguments);
  } catch (error) {
    return null;
  }
};

const fail = reason => ({ passed: false, reason });
const pass = reason => ({ passed: true, reason });

/** Search a JSON structure for any string value containing the fragment. */
const jsonContainsFragment = (value, fragment) => {
  if (typeof value === 'string') return value.includes(fragment);
  if (Array.isArray(value)) {
    return value.some(entry => jsonContainsFragment(entry, fragment));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).some(key =>
      jsonContainsFragment(value[key], fragment)
    );
  }
  return false;
};

// ---- Event-logic tasks (10): the model writes event batches. ----

/**
 * The EventScript text the agent sent, whatever shape it used: the
 * `event_script` string, or the `event_script` of each event batch (the
 * batches are EventScript too — see the add_scene_events schema).
 */
const readEventScriptText = args => {
  if (!args || typeof args !== 'object') return '';
  if (typeof args.event_script === 'string') return args.event_script;
  const batches = Array.isArray(args.event_batches) ? args.event_batches : [];
  return batches
    .map(batch =>
      batch && typeof batch.event_script === 'string' ? batch.event_script : ''
    )
    .join('\n');
};

/**
 * Score an event-logic answer against the EventScript the LOCAL WRITER
 * actually accepts.
 *
 * The scorers used to grep for the hosted backend's serialized
 * instruction vocabulary (`CreerObjet`, `DepartDeLaScene`, `ChangeScene`,
 * `BuiltinCommonInstructions::Timer`): the local writer refuses that shape,
 * so the harness failed every answer in the only format the real tool
 * accepts and passed answers the real tool would reject — the scores
 * measured the wrong thing entirely (audit100226 SCRIPT-1).
 */
const eventBatchHasStandardEvent = (
  args,
  conditionFragment,
  actionFragment
) => {
  const script = readEventScriptText(args);
  if (!script.trim()) {
    return fail('No event_script (EventScript) found in the arguments.');
  }
  if (conditionFragment && !script.includes(conditionFragment)) {
    return fail(`Missing condition "${conditionFragment}" in the EventScript.`);
  }
  if (actionFragment && !script.includes(actionFragment)) {
    return fail(`Missing action "${actionFragment}" in the EventScript.`);
  }
  return pass('The EventScript carries the expected condition and action.');
};

const eventLogicScorers = {
  'coin-spawner-every-3s': result => {
    const call = collectToolCall(result, 'add_scene_events');
    const args = parseArgs(call);
    if (!args) return fail('No add_scene_events call found.');
    const check = eventBatchHasStandardEvent(args, 'Timer', 'Create(');
    if (!check.passed) return check;
    if (!jsonContainsFragment(args, 'Coin')) return fail('No "Coin" created.');
    return pass('Timer condition and coin creation present.');
  },
  'player-movement-8-directions': result => {
    const args = parseArgs(collectToolCall(result, 'add_scene_events'));
    if (!args) return fail('No add_scene_events call found.');
    const check = eventBatchHasStandardEvent(args, 'Force', null);
    return check.passed ? pass('Forces applied for movement.') : check;
  },
  'enemy-patrol-left-right': result => {
    const args = parseArgs(collectToolCall(result, 'add_scene_events'));
    if (!args) return fail('No add_scene_events call found.');
    const script = readEventScriptText(args);
    if (!script.includes('Force')) return fail('No force-based movement.');
    if (!/Direction|Angle/.test(script)) {
      return fail('No direction flip for the patrol turn-around.');
    }
    return pass('Patrol with a direction flip described.');
  },
  'jump-when-space-pressed': result => {
    const args = parseArgs(collectToolCall(result, 'add_scene_events'));
    if (!args) return fail('No add_scene_events call found.');
    const check = eventBatchHasStandardEvent(args, 'Key', 'Force');
    return check;
  },
  'damage-on-collision': result => {
    const args = parseArgs(collectToolCall(result, 'add_scene_events'));
    if (!args) return fail('No add_scene_events call found.');
    const check = eventBatchHasStandardEvent(args, 'Collision', 'Variable');
    return check;
  },
  'score-increases-on-pickup': result => {
    const args = parseArgs(collectToolCall(result, 'add_scene_events'));
    if (!args) return fail('No add_scene_events call found.');
    const check = eventBatchHasStandardEvent(args, 'Collision', 'Score');
    return check;
  },
  'timer-based-difficulty-ramp': result => {
    const args = parseArgs(collectToolCall(result, 'add_scene_events'));
    if (!args) return fail('No add_scene_events call found.');
    const check = eventBatchHasStandardEvent(args, 'Timer', null);
    if (!check.passed) return check;
    if (!readEventScriptText(args).includes('ResetTimer')) {
      return fail('The timer is never reset (event would fire every frame).');
    }
    return pass('Timer condition with reset present.');
  },
  'delete-object-when-offscreen': result => {
    const args = parseArgs(collectToolCall(result, 'add_scene_events'));
    if (!args) return fail('No add_scene_events call found.');
    const check = eventBatchHasStandardEvent(args, 'DepartScene', 'Delete(');
    return check;
  },
  'scene-change-on-goal': result => {
    const args = parseArgs(collectToolCall(result, 'add_scene_events'));
    if (!args) return fail('No add_scene_events call found.');
    const check = eventBatchHasStandardEvent(args, 'Collision', 'Scene(');
    return check;
  },
  'while-loop-spawn-grid': result => {
    const args = parseArgs(collectToolCall(result, 'add_scene_events'));
    if (!args) return fail('No add_scene_events call found.');
    const script = readEventScriptText(args);
    if (!script.split('\n').some(line => /^\s*while\b/.test(line))) {
      return fail('No "while" event used.');
    }
    if (!script.includes('Create(')) {
      return fail('No object creation inside the while loop.');
    }
    return pass('While loop with creation present.');
  },
};

// ---- Layout/spatial tasks (5): instance grids scored numerically. ----

/**
 * Assert the put_2d_instances arguments describe rows×columns instances on
 * an even grid starting at (startX, startY) with the given spacing.
 */
const scoreGridPlacement = (result, expected, spacingTolerance = 0.01) => {
  const call = collectToolCall(result, 'put_2d_instances');
  const args = parseArgs(call);
  if (!args) return fail('No put_2d_instances call found.');
  const instances = Array.isArray(args.instances)
    ? args.instances
    : Array.isArray(args.positions)
    ? args.positions
    : null;
  if (!instances) return fail('No instances/positions list in arguments.');
  if (instances.length !== expected.rows * expected.columns) {
    return fail(
      `Expected ${expected.rows * expected.columns} instances, got ${
        instances.length
      }.`
    );
  }
  // audit011026 B-SCRIPT-10: NaN coordinates sort arbitrarily and make
  // every spacing comparison silently pass — reject them up front.
  if (
    instances.some(
      instance =>
        !Number.isFinite(Number(instance.x)) ||
        !Number.isFinite(Number(instance.y))
    )
  ) {
    return fail('An instance has a non-numeric position.');
  }
  const sortedX = instances
    .map(instance => Number(instance.x))
    .sort((a, b) => a - b);
  const distinctX = [...new Set(sortedX)];
  if (distinctX.length !== expected.columns) {
    return fail(
      `Expected ${expected.columns} distinct x positions, got ${
        distinctX.length
      }.`
    );
  }
  for (let index = 1; index < distinctX.length; index++) {
    const spacing = distinctX[index] - distinctX[index - 1];
    if (Math.abs(spacing - expected.spacingX) > spacingTolerance) {
      return fail(
        `Uneven x spacing: ${spacing} instead of ${expected.spacingX}.`
      );
    }
  }
  const sortedY = instances
    .map(instance => Number(instance.y))
    .sort((a, b) => a - b);
  const distinctY = [...new Set(sortedY)];
  if (distinctY.length !== expected.rows) {
    return fail(
      `Expected ${expected.rows} distinct y positions, got ${distinctY.length}.`
    );
  }
  for (let index = 1; index < distinctY.length; index++) {
    const spacing = distinctY[index] - distinctY[index - 1];
    if (Math.abs(spacing - expected.spacingY) > spacingTolerance) {
      return fail(
        `Uneven y spacing: ${spacing} instead of ${expected.spacingY}.`
      );
    }
  }
  return pass('A perfectly even grid.');
};

const layoutScorers = {
  'grid-5x5-platform': result =>
    scoreGridPlacement(result, {
      rows: 5,
      columns: 5,
      spacingX: 128,
      spacingY: 128,
    }),
  'wall-of-3x8-bricks': result =>
    scoreGridPlacement(result, {
      rows: 8,
      columns: 3,
      spacingX: 64,
      spacingY: 64,
    }),
  'row-of-6-lamps': result =>
    scoreGridPlacement(result, {
      rows: 1,
      columns: 6,
      spacingX: 200,
      spacingY: 0,
    }),
  'two-by-two-turrets': result =>
    scoreGridPlacement(result, {
      rows: 2,
      columns: 2,
      spacingX: 300,
      spacingY: 300,
    }),
  'stairs-of-4-platforms': result => {
    const call = collectToolCall(result, 'put_2d_instances');
    const args = parseArgs(call);
    if (!args) return fail('No put_2d_instances call found.');
    const instances = Array.isArray(args.instances)
      ? args.instances
      : Array.isArray(args.positions)
      ? args.positions
      : null;
    if (!instances || instances.length !== 4) {
      return fail('Expected 4 instances.');
    }
    const sorted = instances
      .map(instance => ({ x: Number(instance.x), y: Number(instance.y) }))
      .sort((a, b) => a.x - b.x);
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index].y >= sorted[index - 1].y) {
        return fail(
          'Each platform must be higher (smaller y) than the previous one.'
        );
      }
    }
    return pass('Four ascending platforms.');
  },
};

// ---- Variables/properties tasks (5): variable shapes. ----

const scoreVariable = (result, predicate, successReason) => {
  const call = collectToolCall(result, 'add_or_edit_variable');
  const args = parseArgs(call);
  if (!args) return fail('No add_or_edit_variable call found.');
  return predicate(args)
    ? pass(successReason)
    : fail('Variable arguments do not match the request.');
};

const variableScorers = {
  'global-score-number': result =>
    scoreVariable(
      result,
      args =>
        args.variable_name === 'Score' &&
        (!args.variable_type || args.variable_type === 'number'),
      'A numeric Score variable.'
    ),
  'scene-health-variable': result =>
    scoreVariable(
      result,
      args =>
        args.variable_name === 'Health' && Number(args.initial_value) === 3,
      'Health starts at 3.'
    ),
  'player-structure-variable': result =>
    scoreVariable(
      result,
      args =>
        args.variable_name === 'Inventory' &&
        args.variable_type === 'structure',
      'An Inventory structure.'
    ),
  'object-ammo-variable': result =>
    scoreVariable(
      result,
      args => args.variable_name === 'Ammo' && !!args.object_name,
      'An object-scoped Ammo variable.'
    ),
  'boolean-has-key': result =>
    scoreVariable(
      result,
      args =>
        args.variable_name === 'HasKey' &&
        (args.initial_value === true ||
          args.initial_value === 'true' ||
          args.initial_value === 1),
      'HasKey is truthy by default.'
    ),
};

// ---- JS/extension tasks (5): produced code asserted statically. ----

const scoreJsCode = (result, requiredFragments) => {
  const text = result.answerText || '';
  const runScript = collectToolCall(result, 'run_script');
  const code =
    text + (runScript ? JSON.stringify(parseArgs(runScript) || '') : '');
  for (const fragment of requiredFragments) {
    if (!code.includes(fragment)) {
      return fail(`The code misses "${fragment}".`);
    }
  }
  return pass('All required API usages present.');
};

const jsScorers = {
  'js-spawn-every-seconds': result =>
    scoreJsCode(result, ['runtimeScene', 'getObjects', 'TimedTask']),
  'js-read-object-position': result =>
    scoreJsCode(result, ['getX()', 'getY()']),
  'js-change-scene': result =>
    scoreJsCode(result, ['runtimeScene', 'getSceneStack', 'push']),
  'extension-action-with-expression': result =>
    scoreJsCode(result, ['extension', 'addAction']),
  'js-camera-follow': result => scoreJsCode(result, ['getCamera', 'setX']),
};

// ---- Perception-repair tasks (5): overlapping HUD fixtures. ----

/**
 * The fixture: two HUD objects declared at the same spot; the model must
 * move the score display to the described corner via set_instance_position
 * (or put_2d_instances) so the rectangles no longer overlap.
 */
const scoreHudRepair = (result, target) => {
  const call =
    collectToolCall(result, 'set_instance_position') ||
    collectToolCall(result, 'put_2d_instances');
  const args = parseArgs(call);
  if (!args) return fail('No repositioning tool call found.');
  const serialized = JSON.stringify(args);
  if (!serialized.includes(target.objectName)) {
    return fail(`The ${target.objectName} was not moved.`);
  }
  // put_2d_instances carries the coordinates inside args.instances, not at
  // the top level (audit011026 B-SCRIPT-3: every correct repair through it
  // used to score "No numeric target position").
  let x = Number(args.x);
  let y = Number(args.y);
  if (
    (!Number.isFinite(x) || !Number.isFinite(y)) &&
    Array.isArray(args.instances)
  ) {
    const targetInstance = args.instances.find(
      instance =>
        instance &&
        typeof instance === 'object' &&
        JSON.stringify(instance).includes(target.objectName)
    );
    if (targetInstance) {
      x = Number(targetInstance.x);
      y = Number(targetInstance.y);
    }
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return fail('No numeric target position.');
  }
  const overlaps =
    Math.abs(x - target.overlappingWith.x) < target.size &&
    Math.abs(y - target.overlappingWith.y) < target.size;
  if (overlaps)
    return fail('The new position still overlaps the other HUD object.');
  return pass(`The HUD object moved clear of the overlap.`);
};

const perceptionScorers = {
  'hud-score-overlaps-button': result =>
    scoreHudRepair(result, {
      objectName: 'ScoreText',
      size: 64,
      overlappingWith: { x: 20, y: 20 },
    }),
  'health-bar-overlaps-minimap': result =>
    scoreHudRepair(result, {
      objectName: 'HealthBar',
      size: 64,
      overlappingWith: { x: 400, y: 20 },
    }),
  'joystick-overlaps-jump-button': result =>
    scoreHudRepair(result, {
      objectName: 'JumpButton',
      size: 80,
      overlappingWith: { x: 60, y: 400 },
    }),
  'quest-text-overlaps-inventory': result =>
    scoreHudRepair(result, {
      objectName: 'QuestText',
      size: 100,
      overlappingWith: { x: 200, y: 150 },
    }),
  'boss-bar-overlaps-score': result =>
    scoreHudRepair(result, {
      objectName: 'BossBar',
      size: 64,
      overlappingWith: { x: 320, y: 30 },
    }),
};

// ---- Authoring-reach tasks (Phase 11): the new surfaces. ----

const authoringReachScorers = {
  'external-events-sheet': result => {
    const args = parseArgs(collectToolCall(result, 'add_external_events'));
    if (!args) return fail('No add_external_events call found.');
    if (args.create_if_missing !== true) {
      return fail('create_if_missing must be true for a new sheet.');
    }
    if (!args.associated_scene || typeof args.associated_scene !== 'string') {
      return fail('No associated_scene given.');
    }
    const hasContent =
      typeof args.event_script === 'string' && args.event_script.length > 0;
    const hasBatches =
      Array.isArray(args.event_batches) && args.event_batches.length > 0;
    if (!hasContent && !hasBatches) {
      return fail('No event_script or event_batches content.');
    }
    return pass(
      'The sheet creation call carries scene association and content.'
    );
  },
  'external-layout-spawn': result => {
    const args = parseArgs(
      collectToolCall(result, 'put_external_layout_instances')
    );
    if (!args) {
      return fail('No put_external_layout_instances call found.');
    }
    if (args.create_if_missing !== true) {
      return fail('create_if_missing must be true for a new layout.');
    }
    if (!args.associated_scene) {
      return fail('No associated_scene given.');
    }
    if (!args.object_name) return fail('No object_name to place.');
    if (!args.brush_position) return fail('No brush_position.');
    return pass('The spawn-point layout creation call is complete.');
  },
  'effect-type-selection': result => {
    const listCall = findToolCall(result, 'list_effects');
    if (!listCall) {
      return fail('list_effects must be called before choosing an effect.');
    }
    const changeArgs =
      parseArgs(
        collectToolCall(result, 'change_scene_properties_layers_effects_groups')
      ) ||
      parseArgs(collectToolCall(result, 'change_object_properties_effects'));
    if (!changeArgs) return fail('No effect change call found.');
    const serialized = JSON.stringify(changeArgs);
    if (!/effect_type/.test(serialized)) {
      return fail('The change call carries no effect_type.');
    }
    return pass('The catalog is consulted before the effect is created.');
  },
  'sprite-frame-edit': result => {
    const args = parseArgs(collectToolCall(result, 'change_sprite_frames'));
    if (!args) return fail('No change_sprite_frames call found.');
    const operations = Array.isArray(args.operations) ? args.operations : [];
    if (operations.length === 0) {
      return fail('No operations in the call.');
    }
    const opNames = operations.map(op => (op && op.op) || '');
    if (!opNames.includes('set_frame_image')) {
      return fail('No set_frame_image operation.');
    }
    if (
      !opNames.some(
        name => name.startsWith('set_') && name !== 'set_frame_image'
      )
    ) {
      return fail('No second operation family exercised.');
    }
    return pass('The sprite edit mixes frame and property operations.');
  },
  'resource-import-url': result => {
    const args = parseArgs(collectToolCall(result, 'import_project_resources'));
    if (!args) return fail('No import_project_resources call found.');
    const entries = Array.isArray(args.entries) ? args.entries : [];
    if (entries.length === 0) return fail('No entries.');
    const hasUrl = entries.some(
      entry =>
        entry &&
        typeof entry.source === 'string' &&
        /^https?:\/\//.test(entry.source)
    );
    if (!hasUrl) return fail('No URL source in the entries.');
    return pass('The import call carries a URL entry.');
  },
  'custom-object-children': result => {
    const args = parseArgs(collectToolCall(result, 'change_custom_object'));
    if (!args) return fail('No change_custom_object call found.');
    const children = Array.isArray(args.children_to_add)
      ? args.children_to_add
      : [];
    if (children.length === 0) return fail('No children_to_add.');
    const wellFormed = children.every(
      child =>
        child &&
        typeof child.name === 'string' &&
        typeof child.object_type === 'string'
    );
    if (!wellFormed) {
      return fail('A child lacks name or object_type.');
    }
    return pass('The children declarations are well formed.');
  },
};

// ---- Discovery/runtime tasks (Phase 12): the new surfaces. ----

const discoveryScorers = {
  'starter-template-pick': result => {
    const listCall = findToolCall(result, 'get_game_starter_summary');
    if (!listCall) {
      return fail(
        'get_game_starter_summary must be called to pick a real slug.'
      );
    }
    const initArgs = parseArgs(collectToolCall(result, 'initialize_project'));
    if (!initArgs) return fail('No initialize_project call found.');
    const slug = initArgs.template_slug;
    if (typeof slug !== 'string' || !slug) {
      return fail('initialize_project carries no template_slug.');
    }
    return pass(
      `The starter "${slug}" comes from the catalog and feeds initialize_project.`
    );
  },
  'asset-search-then-install': result => {
    const searchArgs = parseArgs(
      collectToolCall(result, 'search_object_asset_store')
    );
    if (!searchArgs || typeof searchArgs.search_terms !== 'string') {
      return fail('No search_object_asset_store call with search_terms.');
    }
    const createArgs = parseArgs(
      collectToolCall(result, 'create_or_replace_object')
    );
    if (!createArgs || typeof createArgs.search_terms !== 'string') {
      return fail(
        'No create_or_replace_object call with search_terms (the install path).'
      );
    }
    return pass(
      'Searched the store, then installed through create_or_replace_object.'
    );
  },
  'resource-search-then-import': result => {
    const searchArgs = parseArgs(
      collectToolCall(result, 'search_resource_store')
    );
    if (!searchArgs || typeof searchArgs.search_terms !== 'string') {
      return fail('No search_resource_store call with search_terms.');
    }
    const importArgs = parseArgs(
      collectToolCall(result, 'import_project_resources')
    );
    if (
      !importArgs ||
      !Array.isArray(importArgs.entries) ||
      importArgs.entries.length === 0
    ) {
      return fail('No import_project_resources call with entries.');
    }
    const hasUrl = importArgs.entries.some(
      entry =>
        entry &&
        typeof entry.source === 'string' &&
        /^https?:\/\//.test(entry.source)
    );
    if (!hasUrl) return fail('No URL entry imported from the store results.');
    return pass('Searched the resource store, then imported the url.');
  },
  'notes-read-before-build': result => {
    const readCall = findToolCall(result, 'read_project_notes');
    if (!readCall) {
      return fail(
        'read_project_notes must be called before continuing an existing project.'
      );
    }
    return pass('The persistent notes were read first.');
  },
  'runtime-profile-slow-scene': result => {
    const profileArgs = parseArgs(collectToolCall(result, 'profile_runtime'));
    if (!profileArgs) {
      return fail('No profile_runtime call found.');
    }
    const controlCalls = result.toolCalls.filter(
      call =>
        call.name === 'control_runtime' || call.name === 'read_runtime_details'
    );
    if (controlCalls.length === 0) {
      return fail(
        'No control_runtime/read_runtime_details call to pair with the profile.'
      );
    }
    return pass(
      'The runtime was profiled and inspected through the debugger channel.'
    );
  },
};

const ALL_SCORERS = {
  'event-logic': eventLogicScorers,
  layout: layoutScorers,
  variables: variableScorers,
  'js-extension': jsScorers,
  'perception-repair': perceptionScorers,
  'authoring-reach': authoringReachScorers,
  'discovery-runtime': discoveryScorers,
};

const tasks = Object.keys(ALL_SCORERS)
  .map(category =>
    Object.keys(ALL_SCORERS[category]).map(id => ({ id, category }))
  )
  .reduce((all, entries) => all.concat(entries), [])
  .map(({ id, category }) =>
    makeTask(id, category, buildPromptForTask(id, category), result =>
      ALL_SCORERS[category][id](result)
    )
  );

/**
 * The task prompt: describes the goal and fixes the answer contract (the
 * strict JSON envelope the runner parses).
 */
function buildPromptForTask(id, category) {
  const envelope =
    'Answer with strict JSON only: {"tool_calls": [{"name": "<tool name>", ' +
    '"arguments": {…}}]} — the arguments must be complete and valid.';
  const prompts = require('./byok-eval-task-prompts');
  const prompt = prompts[id] || `Task ${id} (category ${category}).`;
  return `${prompt}\n\n${envelope}`;
}

// ----------------------------------------------------------------------
// The runner.
// ----------------------------------------------------------------------

/**
 * Parse the model's answer into the scorer input. Tolerant to code fences.
 */
function parseEvalAnswer(answerText) {
  let text = String(answerText || '').trim();
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenceMatch) text = fenceMatch[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { answerText: String(answerText || ''), toolCalls: [] };
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const toolCalls = Array.isArray(parsed.tool_calls)
      ? parsed.tool_calls
          .filter(call => call && typeof call.name === 'string')
          .map(call => ({
            name: call.name,
            arguments: call.arguments === undefined ? {} : call.arguments,
          }))
      : [];
    return { answerText: String(answerText || ''), toolCalls };
  } catch (error) {
    return { answerText: String(answerText || ''), toolCalls: [] };
  }
}

/**
 * Parse a judge answer (strict JSON envelope, fence-tolerant): whether the
 * judge considers the failed outcome acceptable, plus a one-sentence reason.
 */
function parseJudgeAnswer(answerText) {
  let text = String(answerText || '').trim();
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenceMatch) text = fenceMatch[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed.acceptable !== 'boolean') return null;
    return {
      acceptable: parsed.acceptable,
      reason:
        typeof parsed.reason === 'string'
          ? parsed.reason.slice(0, 300)
          : '(no reason given)',
    };
  } catch (error) {
    return null;
  }
}

/**
 * The optional LLM-as-judge pass (Phase 9.8 leftover, closed 2026-09-23):
 * one chat call per FAILED task asking a second model whether the outcome
 * was nonetheless acceptable. Advisory only — the mechanical score stays
 * the source of truth, a judge failure never fails the run.
 */
async function runJudgePass({ results, judgeModel, sendJudgeCompletion }) {
  const judged = [];
  for (const result of results) {
    if (result.passed) continue;
    // Infrastructure failures are not outcomes to judge (B-SCRIPT-2).
    if (result.error) continue;
    try {
      const response = await sendJudgeCompletion({
        model: judgeModel,
        messages: [
          {
            role: 'system',
            content:
              'You are an impartial judge for GDevelop game-building tasks. ' +
              'A mechanical scorer marked the task as failed. Answer with ' +
              'strict JSON only: {"acceptable": true|false, "reason": "<one sentence>"}.',
          },
          {
            role: 'user',
            content:
              `Task ${result.taskId} (${
                result.category
              }) failed the mechanical scorer: ${result.reason}. ` +
              `Rounds used: ${result.rounds}, tool calls: ${
                result.toolCalls
              }. ` +
              // audit011026 B-SCRIPT-2: without the answer text and the
              // tool calls the judge could only parrot the scorer's own
              // reason string.
              `The assistant's final answer was: ${String(
                result.answerText || ''
              ).slice(0, 2000)}. ` +
              `Its tool calls were: ${JSON.stringify(
                (result.toolCallDetails || []).slice(0, 20)
              ).slice(0, 4000)}. ` +
              'Was the outcome nonetheless acceptable for the user?',
          },
        ],
      });
      const content =
        response &&
        response.choices &&
        response.choices[0] &&
        response.choices[0].message &&
        response.choices[0].message.content;
      // The judge's own cost was discarded, so a full judge pass over the
      // suite reported only the TASK tokens and the eval looked far cheaper
      // than it really is (audit100226 SCRIPT-3).
      const judgeTokens =
        response &&
        response.usage &&
        typeof response.usage.total_tokens === 'number'
          ? response.usage.total_tokens
          : 0;
      const parsed = parseJudgeAnswer(content);
      if (!parsed) {
        judged.push({
          taskId: result.taskId,
          verdict: 'unparseable',
          tokens: judgeTokens,
          reason: 'The judge answer was not the expected JSON envelope.',
        });
        continue;
      }
      judged.push({
        taskId: result.taskId,
        verdict: parsed.acceptable ? 'acceptable' : 'not-acceptable',
        tokens: judgeTokens,
        reason: parsed.reason,
      });
    } catch (error) {
      judged.push({
        taskId: result.taskId,
        verdict: 'unavailable',
        tokens: 0,
        reason: String((error && error.message) || error).slice(0, 300),
      });
    }
  }
  return judged;
}

/**
 * Run one task against an endpoint. `sendCompletion` is injected so the
 * suite is testable without a network; the CLI builds it on axios.
 */
async function runEvalTask(task, sendCompletion, byokModules) {
  // The REAL BYOK prompt, with the answer contract appended, plus the real
  // tool schemas (audit100226 SCRIPT-2). The envelope stays in the user turn
  // so the task prompt itself is unchanged.
  const systemContent = byokModules
    ? `${byokModules.systemPrompt}\n\n${
        task.prompt.split('\n\n').pop() || ''
      }`.trim()
    : 'You complete GDevelop game-building tasks. You answer with the exact JSON envelope requested.';
  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: task.prompt },
  ];
  const response = await sendCompletion({
    messages,
    tools: byokModules ? byokModules.tools : undefined,
  });
  const choice = response.choices && response.choices[0];
  const answerText =
    choice && choice.message && typeof choice.message.content === 'string'
      ? choice.message.content
      : '';
  const tokens =
    response.usage && typeof response.usage.total_tokens === 'number'
      ? response.usage.total_tokens
      : 0;
  const parsed = parseEvalAnswer(answerText);
  const score = task.scorer(parsed);
  return {
    taskId: task.id,
    category: task.category,
    passed: score.passed,
    reason: score.reason,
    rounds: 1,
    toolCalls: parsed.toolCalls.length,
    // audit011026 B-SCRIPT-2: the judge pass needs the evidence (the count
    // above stays the compact report field).
    answerText: parsed.answerText,
    toolCallDetails: parsed.toolCalls,
    tokens,
  };
}

/**
 * The harness self-check: a trivially-passing and a trivially-failing task
 * both score correctly (this is what the Jest suite exercises).
 */
function makeSelfCheckTasks() {
  const passing = makeTask(
    'self-check-pass',
    'event-logic',
    'always pass',
    () => pass('by construction')
  );
  const failing = makeTask(
    'self-check-fail',
    'event-logic',
    'always fail',
    () => fail('by construction')
  );
  return { passing, failing };
}

function runSelfCheck() {
  const { passing, failing } = makeSelfCheckTasks();
  const passingResult = passing.scorer({ answerText: '', toolCalls: [] });
  const failingResult = failing.scorer({ answerText: '', toolCalls: [] });
  const ok = passingResult.passed === true && failingResult.passed === false;
  return {
    ok,
    passingResult,
    failingResult,
  };
}

/**
 * Format the report (markdown) — per task pass/fail, rounds, tool calls,
 * tokens; a summary line per category.
 */
function formatReport(modelName, results, options) {
  const lines = [];
  const ranAt = new Date().toISOString();
  lines.push(`# BYOK eval report — ${modelName} — ${ranAt}`);
  if (options && options.judgeModel) {
    lines.push(
      `> LLM-as-judge enabled (${
        options.judgeModel
      }) — subjective signal, the mechanical score above is the source of truth.`
    );
  }
  const passCount = results.filter(result => result.passed).length;
  lines.push(
    `**${passCount}/${results.length} tasks passed** · ${results.reduce(
      (total, result) => total + result.tokens,
      0
    )} tokens`
  );
  const categories = [...new Set(results.map(result => result.category))];
  for (const category of categories) {
    const categoryResults = results.filter(
      result => result.category === category
    );
    const categoryPasses = categoryResults.filter(result => result.passed)
      .length;
    lines.push('');
    lines.push(`## ${category} (${categoryPasses}/${categoryResults.length})`);
    lines.push('');
    for (const result of categoryResults) {
      lines.push(
        `- ${result.passed ? '✅' : '❌'} **${result.taskId}** — ${
          result.reason
        } (rounds: ${result.rounds}, tool calls: ${result.toolCalls}, tokens: ${
          result.tokens
        })${
          // audit011026 B-SCRIPT-4: an infrastructure failure (401, quota,
          // network) is not a model failure — the cause was console-only.
          result.error ? ` — error: ${result.error}` : ''
        }`
      );
    }
  }
  if (options && options.judgeResults) {
    lines.push('');
    lines.push(
      `## LLM-as-judge (advisory, ${options.judgeModel ||
        'judge'}) — the mechanical scores above are the source of truth`
    );
    lines.push('');
    if (options.judgeResults.length === 0) {
      lines.push('- No failed tasks to judge.');
    }
    for (const judged of options.judgeResults) {
      lines.push(
        `- **${judged.taskId}** — ${judged.verdict}: ${judged.reason}`
      );
    }
    const judgeTokens = options.judgeResults.reduce(
      (total, judged) => total + (judged.tokens || 0),
      0
    );
    if (judgeTokens > 0) {
      lines.push('');
      lines.push(
        `- Judge tokens spent on these verdicts: **${judgeTokens}** (not included in the task totals above).`
      );
    }
  }
  return lines.join('\n');
}

// ----------------------------------------------------------------------
// The CLI (only when run directly).
// ----------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const readArg = name => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 && args[index + 1] ? args[index + 1] : null;
  };
  const endpoint = readArg('endpoint');
  const key = readArg('key');
  const model = readArg('model');
  const judgeModel = readArg('judge-model');
  const outDir =
    readArg('out') || path.join(__dirname, '..', '..', '..', 'REVIEW', 'evals');

  if (!endpoint || !model) {
    console.error(
      'Usage: node scripts/run-byok-evals.js --endpoint https://host/v1 --model <model> [--key <key>] [--judge-model <model>] [--out <dir>]'
    );
    process.exit(1);
  }

  // The axios dependency of the app; the script runs from newIDE/app.
  // eslint-disable-next-line import/no-unresolved
  const axios = require('axios');

  const sendCompletion = async ({ messages, tools }) => {
    // audit011026 B-SCRIPT-8: an uncapped completion is the same failure
    // class the QA round-1 benchmark fix addressed.
    const body = { model, messages, max_tokens: 4096 };
    if (tools && tools.length > 0) body.tools = tools;
    const response = await axios.post(
      `${endpoint.replace(/\/+$/, '')}/chat/completions`,
      body,
      {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        timeout: 120000,
      }
    );
    return response.data;
  };

  // The real BYOK prompt + tool schemas, loaded once (audit100226 SCRIPT-2).
  const byokModules = await loadByokPromptModules();
  console.log(
    `BYOK prompt: ${Math.ceil(
      byokModules.systemPrompt.length / 4
    )} tokens, ${byokModules.tools.length} tool schemas.`
  );
  console.log(`Running ${tasks.length} eval tasks on ${model}…`);
  const results = [];
  for (const task of tasks) {
    try {
      const result = await runEvalTask(task, sendCompletion, byokModules);
      results.push(result);
      console.log(
        `${result.passed ? 'PASS' : 'FAIL'} ${result.taskId} (${
          result.tokens
        } tokens)`
      );
    } catch (error) {
      results.push({
        taskId: task.id,
        category: task.category,
        passed: false,
        reason: 'The task run failed.',
        rounds: 0,
        toolCalls: 0,
        tokens: 0,
        error: String((error && error.message) || error),
      });
      console.error(
        `ERROR ${task.id}: ${String((error && error.message) || error)}`
      );
    }
    // audit011026 B-SCRIPT-4: a partial-results checkpoint after every
    // task — a killed run (Ctrl+C, OOM, sleep) used to lose everything.
    fs.mkdirSync(outDir, { recursive: true });
    const checkpointPath = path.join(
      outDir,
      `eval-${model.replace(/[^a-zA-Z0-9._-]+/g, '_')}-partial.json`
    );
    fs.writeFileSync(
      checkpointPath,
      JSON.stringify(
        { modelName: model, results, writtenAt: new Date().toISOString() },
        null,
        2
      ),
      'utf8'
    );
  }

  let judgeResults = null;
  if (judgeModel) {
    console.log(`Running the LLM-as-judge pass on ${judgeModel}…`);
    const sendJudgeCompletion = async ({ messages }) => {
      const response = await axios.post(
        `${endpoint.replace(/\/+$/, '')}/chat/completions`,
        { model: judgeModel, messages, max_tokens: 512 },
        {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          timeout: 120000,
        }
      );
      return response.data;
    };
    judgeResults = await runJudgePass({
      results,
      judgeModel,
      sendJudgeCompletion,
    });
  }

  const report = formatReport(model, results, { judgeModel, judgeResults });
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `eval-${model.replace(
    /[^a-zA-Z0-9._-]+/g,
    '_'
  )}-${Date.now()}.md`;
  const outPath = path.join(outDir, fileName);
  fs.writeFileSync(outPath, report, 'utf8');
  console.log(`Report written to ${outPath}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  tasks,
  makeTask,
  parseEvalAnswer,
  parseJudgeAnswer,
  runEvalTask,
  runJudgePass,
  makeSelfCheckTasks,
  runSelfCheck,
  formatReport,
  ALL_SCORERS,
};
