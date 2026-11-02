---
name: extend-with-js
description: Authoring JavaScript in a GDevelop project — events-based extension authoring (custom functions, objects, behaviors) including JS inside them, and where real runtime code belongs (the game code folder). Load it when the task needs real code, custom objects/behaviors, or reusable functions.
---

# Extending a game with JS and extensions

## When JS beats events

- Use events first: they are inspected by the read tools, refactored by
  renames, and visible to the player-facing tooling.
- Reach for a GAME CODE FILE when: math-heavy logic (vectors,
  interpolation), DOM/platform access, or porting an existing algorithm —
  see load_skill("game-code-authoring") (the `<GameName>Code/` folder and
  its write_game_code_file tool).
- Reach for an EXTENSION when logic must be REUSED (a custom behavior, a
  custom object, a shared action/expression) — `create_extension_BYOK` then
  `create_custom_function_BYOK` / `create_custom_object_BYOK` /
  `create_custom_behavior_BYOK`.

## JS code events (the limit of EventScript)

- JS code events exist in the editor, but EventScript CANNOT author them:
  the grammar has no JsCode event, so `add_scene_events` will refuse one.
  To run JavaScript right now, use the run_script tool (it can call the
  other tools); for code that must ship with the game, write a game code
  file (`write_game_code_file`, load_skill("game-code-authoring")).
- Extension function bodies are events too: author them in EventScript —
  there is no JS-code-event syntax for them either.

## Extension authoring pipeline

1. `create_extension_BYOK` — the container (its name is the namespace).
2. Add the parts:
   - `create_custom_function_BYOK` for free actions/conditions/expressions;
   - `create_custom_behavior_BYOK` for attachable state + per-frame logic;
   - `create_custom_object_BYOK` for reusable composed objects.
3. Author the BODIES as EventScript (`event_script` argument). Behavior
   lifecycle names matter: `onCreated`, `onDestroyed`, `doStepPreEvents`…
   run at the right engine moments.
4. In functions, read the parameters in order (object lists, expressions);
   give each a `description` so the sentence in the events editor reads
   well (`sentence` with `_PARAM0_` placeholders).
5. Regeneration is automatic after your batch — but verify: read the
   function back, then exercise it (preview or gameplay test).

## Copying instead of writing from scratch

- `create_extension_BYOK` with `duplicated_extension_name` copies an
  extension (its functions, objects and behaviors come along, renamed
  after the new one).
- `create_custom_function_BYOK` with `duplicated_function_name` copies a
  function of the same scope, with its parameters and its events (do not
  pass `parameters` with it).
- `create_custom_object_BYOK` / `create_custom_behavior_BYOK` with
  `duplicated_custom_object_name` / `duplicated_custom_behavior_name` copy
  an existing one; add `duplicated_from_extension_name` when it lives in
  another extension.
- An "Expression" says what it returns with `expression_type`
  ("number" or "string"); an "ActionWithOperator" says which
  "Expression" it changes with `getter_name`.
- `change_custom_object_BYOK` with `fit_area_to_children` fits the area of a
  custom object to its children, moving them: `min_at_origin` puts their
  minimum corner at (0;0;0), `centered_on_origin` puts their center there
  (what a turret or anything spinning around itself needs).

## Discipline

- `find_extension_usages_BYOK` before any delete or rename; deletes are refused
  while used unless you pass `delete_even_if_used: true` (say so to the
  user before passing it).
- One extension per concern; name it after the mechanic, not the author.
- Properties are the extension's tunables: create them with
  `changed_properties`, read them in the function bodies.
- Verify JS like everything else: `start_preview`,
  `read_preview_logs`/`get_runtime_errors` for exceptions, and a gameplay
  test for behavior.
