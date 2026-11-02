/**
 * Generate the curated EventScript example bank (Phase 13.6):
 * `src/AiGeneration/Byok/docs/eventscript-examples.json`.
 *
 * The bank extends the engine-reference corpus with runnable, tagged
 * EventScript examples, so `search_reference` returns an example the model
 * can copy verbatim into add_scene_events. Every example is round-tripped
 * through the real writer in ByokEventScriptExamples.spec.js — the bank and
 * the parser cannot drift apart.
 *
 * Run from newIDE/app/scripts:  node generate-byok-eventscript-examples.js
 */

const fs = require('fs');
const path = require('path');

/** One curated example. `tags` drive the search_reference hits. */
const EXAMPLES = [
  {
    id: 'collision-counter',
    name: 'Collision -> variable increment (a score counter)',
    tags: ['collision', 'variable', 'score', 'delete', 'pickup'],
    source: [
      'if Collision(Player, Coin):',
      '  Delete(Coin)',
      '  SetNumberVariable(Score, =, Score + 1)',
    ].join('\n'),
  },
  {
    id: 'timer-spawn',
    name: 'Spawning on a timer, resetting it',
    tags: ['timer', 'spawn', 'create', 'reset', 'random'],
    source: [
      'if Timer(2, "SpawnTimer") and once:',
      '  Create(Rock, Random(800), -50, "Base layer")',
      '  ResetTimer("SpawnTimer")',
    ].join('\n'),
  },
  {
    id: 'scene-switch',
    name: 'Switching to another scene (a menu)',
    tags: ['scene', 'input', 'menu', 'key'],
    source: ['if KeyPressed("Escape") and once:', '  Scene("MainMenu")'].join(
      '\n'
    ),
  },
  {
    id: 'movement-and-collision',
    name: 'Frame-rate independent movement and a collision',
    tags: ['movement', 'collision', 'time', 'delete'],
    source: [
      'always:',
      '  SetX(Player, GetX(Player) + 250 * TimeDelta())',
      'if Collision(Player, Spike):',
      '  Delete(Player)',
    ].join('\n'),
  },
  {
    id: 'trigger-once-shooting',
    name: 'Trigger-once shooting',
    tags: ['input', 'once', 'create', 'sound', 'shooting'],
    source: [
      'if KeyPressed("Space") and once:',
      '  Create(Bullet, GetX(Player), GetY(Player), "Base layer")',
      '  PlaySound("laser.wav")',
    ].join('\n'),
  },
  {
    id: 'else-chain',
    name: 'Else chains over the scene state',
    tags: ['else', 'variable', 'timer'],
    source: [
      'always:',
      '  SetNumberVariable(Score, =, Score + 1)',
      'else if DepartScene():',
      '  SetNumberVariable(Score, =, Score + 50)',
      '  ResetTimer("RoundTimer")',
    ].join('\n'),
  },
  {
    id: 'for-each-enemy',
    name: 'For-each iteration over instances',
    tags: ['loop', 'foreach', 'collision', 'variable', 'enemy'],
    source: [
      'for each Enemy:',
      '  if Collision(Enemy, KillZone):',
      '    Delete(Enemy)',
      '    SetNumberVariable(Escaped, =, Escaped + 1)',
    ].join('\n'),
  },
  {
    id: 'structure-children',
    name: 'Iterating the children of a structure variable',
    tags: ['structure', 'variable', 'foreach', 'save'],
    source: [
      'for each child in SaveData value Items:',
      '  SetStringVariable(ItemName, =, child)',
    ].join('\n'),
  },
  {
    id: 'loops-groups-waves',
    name: 'Loops, sub-events and a group',
    tags: ['loop', 'repeat', 'group', 'timer', 'spawn', 'waves'],
    source: [
      'group "Waves":',
      'repeat 3 times:',
      '  if Timer(1, "WaveTimer") and once:',
      '    ResetTimer("WaveTimer")',
      '    if not SceneVariableAsBoolean(BossAlive):',
      '      Create(Enemy, Random(800), 0, "Base layer")',
      '  always:',
      '    SetNumberVariable(WaveProgress, =, WaveProgress + 1)',
    ].join('\n'),
  },
  {
    id: 'comments-anchors-disabled',
    name: 'Comments, anchors, disabled events and links',
    tags: ['comment', 'anchor', 'disabled', 'link'],
    source: [
      'comment "The setup below runs once at the start of the scene"',
      'always: # event-3.1',
      '  SetNumberVariable(Score, =, 0)',
      'disabled always:',
      '  Wait(1)',
      'link "Shared enemy logic"',
    ].join('\n'),
  },
  {
    id: 'animation-speed-boost',
    name: 'Changing the animation on a pickup',
    tags: ['animation', 'collision', 'once', 'sprite'],
    source: [
      'if Collision(Player, SpeedBoost) and once:',
      '  Delete(SpeedBoost)',
      '  ChangeAnimationSpeedScale(Player, =, 2)',
    ].join('\n'),
  },
];

const SCHEMA_VERSION = 1;

const output = {
  schema: SCHEMA_VERSION,
  generatedFrom: 'scripts/generate-byok-eventscript-examples.js (curated)',
  examples: EXAMPLES,
};

const outputPath = path.join(
  __dirname,
  '..',
  'src',
  'AiGeneration',
  'Byok',
  'docs',
  'eventscript-examples.json'
);
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
console.info('Wrote ' + EXAMPLES.length + ' examples to ' + outputPath);
