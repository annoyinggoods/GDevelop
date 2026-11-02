---
name: eventscript-authoring
description: Author EventScript reliably — full grammar reminders, placement targets, expected source and repair loops for add_scene_events.
---

# EventScript authoring

## Workflow (the one that never fails)
1. `read_events_source` on the scene — get the exact current source with `# event-N.M` anchors.
2. Write batches from what it shows: `event_script` + `placement_relation` + `placement_target_event_id`.
3. For replace relations, echo the target's current source in `expected_event_source`. Changed since read? The edit is refused — re-read, re-apply.

## Grammar quick reference
- Headers end with `:`: `always:`, `if Cond() and Cond():`, `else:`, `else if Cond():`, `while Cond():`, `repeat 5 times:`, `for each Enemy:`, `for each child in Var value Key:`, `group "Name":`.
- `not` inverts; `Or(a, b)` composes; `and once:` triggers once; `disabled ` prefix disables the event.
- Actions are indented lines: `Delete(Enemy)`, `await Wait(1)` waits before the next line.
- Strings are double-quoted, escapes with backslash: "He said \"hi\"".
- Empty body: `pass`. Comments: `comment "text"`. Links: `link "Scene"`.

## Placement relations
- `insert_at_end` (scene level), `insert_before_event` / `insert_after_event` (siblings), `insert_as_sub_event` (child of the target), `insert_and_replace_event`, `replace_entire_event_and_sub_events`, `delete_event` (no script needed).
- Prefer targeted relations over replacing the whole scene: smaller diffs, fewer conflicts.

## Repair loop
- A refused batch says what and where it failed: fix the quoted line and re-send the batch. Re-read after two failures — the scene probably changed.
- Unknown instruction or parameter name? `search_reference` has every action/condition/expression with its exact parameters. Never guess a name.

## Verify
- After writing: `read_events_source` (or a gameplay test) to confirm the events read and behave as intended.
