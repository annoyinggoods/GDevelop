// @flow
import {
  registerByokKnowledgeSection,
  estimateByokTokens,
} from './ByokKnowledgeSections';

/**
 * The EventScript grammar pack (Phase 7.3): the full authoring reference of
 * the EventScript language `add_scene_events` accepts, with worked examples.
 * The always-on surface is TWO pieces, not one: the `eventscript-core` core
 * section (how to target the scene) and the NON-degradable
 * `eventscript-pinned` block (the headers, actions and canonical examples).
 * This full pack is degradable knowledge — it degrades to its first line
 * under context pressure, and stays reachable as the `eventscript-authoring`
 * skill. The spec test-links every example to the Phase 5 parser: each one
 * must parse, so the pack and the parser can never drift apart.
 */

const GRAMMAR_REFERENCE = `## Structure
- One event per block. A condition line ends with a colon; the actions are the indented lines below it, one call per line.
- Indentation is significant: sub-events are indented under their parent event. Use exactly the indentation shown by read_events_source.
- Every event may carry a trailing anchor comment: \`# event-2.1\` — the id used as placement_target_event_id. Never edit the anchors; echo them back unchanged.

## Event headers (condition lines)
- \`always:\` — runs every frame (no condition).
- \`if Cond() and Cond():\` — conditions joined with \`and\`.
- \`if not Cond():\` — \`not\` inverts one condition.
- \`if Cond(1) or Cond(2):\` — \`Or(Cond(1), Cond(2))\` is the form for "or" between two conditions: \`if Or(KeyPressed("Space"), KeyPressed("Enter")) and once:\`.
- \`if Cond() and once:\` — \`once\` marks a trigger-once: the actions run one time while the conditions stay true.
- \`else:\` / \`else if Cond():\` — attach to the closest previous \`if\` at the same level.
- \`while Cond():\` — re-checks every frame while true.
- \`repeat 5 times:\` — counted loop (\`repeat 5+3 times:\` takes any expression).
- \`for each Enemy:\` — iterates the instances of an object (or group).
- \`for each child in Inventory value Key:\` — iterates the children of a structure variable/array.
- \`group "Name":\` — a group of events (shows as a foldable group in the editor).
- \`comment "text"\` — a standalone comment event (no colon, no body).
- \`link "SceneName"\` — a link event to another scene's group (no body).
- Prefix any header with \`disabled \`: \`disabled if Cond():\` — the event stays but never runs.

## Actions
- One call per indented line: \`Delete(Enemy)\`, \`Create(Player, 100, 200, "Base layer")\`, \`ResetTimer("SpawnTimer")\`.
- Prefix with \`await \` to wait for its completion before the next line: \`await Wait(1)\`.
- Variables: \`SetNumberVariable(Score, =, +1)\` (operators: =, +, -, *, /), \`SetSceneNumberVariable(...)\`, \`SetGlobalNumberVariable(...)\`.

## Values, strings and escaping
- Numbers are plain (250, -3.5, 2 * TimeDelta()). Strings are double-quoted: "Hello".
- Inside a string, escape double quotes with a backslash: "He said \\"hi\\"" — same for backslashes.
- Expressions are usable in any number or string parameter: \`SetX(Player, GetX(Player) + 250 * TimeDelta())\`.
- Object parameters take an object or group name: Player, "Enemies".

## Placement (how add_scene_events targets the scene)
- One batch = one object with: event_script, placement_relation, placement_target_event_id, expected_event_source.
- placement_relation: insert_at_end | insert_before_event | insert_after_event | insert_as_sub_event | insert_and_replace_event | replace_entire_event_and_sub_events | replace_event_but_keep_existing_sub_events | delete_event.
- The three replace relations differ in what happens to the target's sub-events: replace_entire_event_and_sub_events drops them, replace_event_but_keep_existing_sub_events re-attaches them to the first replacement event, insert_and_replace_event replaces the event itself.
- For the replace relations, echo the target's current source (from read_events_source) in expected_event_source: the edit is refused when the target changed since you read it.
- Sub-events deeper than what read_events_source shows are collapsed as \`# ...\` markers: to edit them, target their nearest visible parent.

## What does not fit EventScript
- JavaScript code events are not authored in EventScript: use the run_script tool to run JavaScript (it can call the other tools), or ask the user to add a JS code event by hand.`;

const WORKED_EXAMPLES: Array<{| name: string, source: string |}> = [
  {
    name: 'Frame-rate independent movement and a collision',
    source: `always:
  SetX(Player, GetX(Player) + 250 * TimeDelta())
if Collision(Player, Spike):
  Delete(Player)`,
  },
  {
    name: 'Trigger-once shooting',
    source: `if KeyPressed("Space") and once:
  Create(Bullet, GetX(Player), GetY(Player), "Base layer")
  PlaySound("laser.wav")`,
  },
  {
    name: 'Spawning on a timer, resetting it',
    source: `if Timer(2, "SpawnTimer") and once:
  Create(Rock, Random(800), -50, "Base layer")
  ResetTimer("SpawnTimer")`,
  },
  {
    name: 'Else chains over the scene state',
    source: `if not DepartScene():
  SetNumberVariable(Score, =, Score + 1)
else if DepartScene():
  SetNumberVariable(Score, =, Score + 50)
  ResetTimer("RoundTimer")`,
  },
  {
    name: 'For-each iteration over instances',
    source: `for each Enemy:
  if Collision(Enemy, KillZone):
    Delete(Enemy)
    SetNumberVariable(Escaped, =, Escaped + 1)`,
  },
  {
    name: 'Iterating the children of a structure variable',
    source: `for each child in SaveData value Items:
  SetStringVariable(ItemName, =, Items)`,
  },
  {
    name: 'Loops, sub-events and a group',
    source: `group "Waves":
repeat 3 times:
  if Timer(1, "WaveTimer") and once:
    ResetTimer("WaveTimer")
    if not SceneVariableAsBoolean(BossAlive):
      Create(Enemy, Random(800), 0, "Base layer")
  always:
    SetNumberVariable(WaveProgress, =, WaveProgress + 1)`,
  },
  {
    name: 'Comments, anchors, disabled events and links',
    source: `comment "The setup below runs once at the start of the scene"
always: # event-3.1
  SetNumberVariable(Score, =, 0)
disabled always:
  Wait(1)
link "Shared enemy logic"`,
  },
];

const PACK_BODY = [
  'The full EventScript grammar, for surgical event edits with add_scene_events (the operational core above is the reminder; this is the reference).',
  GRAMMAR_REFERENCE,
  '## Worked examples (each parses exactly as shown)',
  ...WORKED_EXAMPLES.flatMap(example => [
    `### ${example.name}`,
    '```',
    example.source,
    '```',
  ]),
].join('\n\n');

/**
 * Register the pack as degradable knowledge: under a tight budget only its
 * first line remains, pointing at the `eventscript-authoring` skill.
 */
registerByokKnowledgeSection({
  id: 'eventscript-pack',
  title: 'EventScript full reference',
  priority: 200,
  budgetTokens: estimateByokTokens(PACK_BODY) + 50,
  degradable: true,
  build: () => PACK_BODY,
});

/** The worked examples, exposed for the parser conformance tests. */
export const getByokEventScriptPackExamples = (): Array<{|
  name: string,
  source: string,
|}> =>
  WORKED_EXAMPLES.map(example => ({
    name: example.name,
    source: example.source,
  }));
