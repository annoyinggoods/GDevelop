---
name: build-workflow
description: The disciplined pipeline for building a whole game or a large feature from a request — brief, plan, scaffold, per-mechanic build+test loops, polish pass, verified handover. Load it when the user asks to make, build or create a game.
---

# The build workflow

When asked to build a game (or a large feature), run this pipeline — do not
improvise a different order.

## 1. Brief

- Extract the core loop (what the player does repeatedly), the verbs, the
  win and lose conditions, and the intended feel.
- Ambiguous scope? Ask ONE clarifying question before editing; otherwise
  pick the smallest playable interpretation and say so in the plan.
- Show the brief with `create_or_update_plan` before making any edit.

## 2. Plan and scaffold

- Write the plan as tasks (one mechanic per task) with
  `create_or_update_plan`; update the task statuses as you go.
- No project open? `initialize_project` — empty, or a template that truly
  fits (a platformer template for a platformer, not "something with a
  character").
- Declare the tunable numbers up front with `add_or_edit_variable` (speeds,
  scores, timers, spawn rates): numbers are tunables, not literals.

## 3. Per-mechanic loop — one mechanic at a time, never several at once

- When feasible, write the gameplay test FIRST (`run_gameplay_test` with
  the new source): a failing test that turns green is the strongest build
  signal.
- Build the mechanic: objects with `create_or_replace_object`, logic with
  `add_scene_events` in anchored batches (read the current source with
  `read_events_source` first).
- Run the test; fix until green. Then look at the result:
  `capture_preview_screenshot` (or `capture_scene_screenshot` while
  iterating in the editor) and judge the feel — fix what looks wrong.
- Mark the plan task done with a one-sentence progress note, then move on.

## 4. Polish pass

- Sweep the juice vocabulary (load the `juice-and-game-feel` skill): tween
  movement, squash and stretch, screen shake, particles, sounds, countdowns,
  win/lose staging.

## 5. Final verification and handover

- `start_preview`: the game boots. `read_preview_logs` +
  `get_runtime_errors`: clean. All gameplay tests green. One last
  screenshot, discussed.
- Claim done ONLY after this verification — the completion gate will nudge
  you once if you claim without it.
- Finish with: what was built, what to try first, and which variables to
  tweak.

## Scope rules

- One mechanic at a time; one scene's events per anchored batch.
- Ask when the request is ambiguous about scope; never delete the user's
  content without saying so first.
- Prefer a scout sub-agent (`run_explorer_agent`) for broad read-only
  sweeps; keep edits in the main conversation.
