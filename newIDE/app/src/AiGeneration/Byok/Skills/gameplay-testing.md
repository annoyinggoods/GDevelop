---
name: gameplay-testing
description: Use the gameplay-test harness — step frames, simulate input, assert state, and turn failures into fixes via the executed source.
---

# Gameplay testing

## The harness (the `source` of run_gameplay_test)
The source is an async script driving a live preview:

- `await harness.stepFrames(30)` — advance the game deterministically (always await).
- `await harness.stepUntil(() => condition, { maxFrames: 300 })` — advance until true; returns false when `maxFrames` is hit (a silently-false step is a failed wait, not a pass).
- `harness.setKeyPressed("Space", true)` / `false` — press and release (GDevelop key names: "Left", "Space", "a"; or Web names: "ArrowLeft").
- `harness.setMousePosition(x, y, layerName)` — pointer position in scene coordinates; `harness.releaseAllInputs()` between phases.
- `harness.assert(condition, "message")` — a failed assertion fails the test and returns the frame.
- Helpers: `harness.stepUntilObjectIsStable(...)`, `harness.setGameResolutionSize(w, h)`.

## A good test
- Arrange: set variables/positions. Act: press keys, step frames. Assert: one clear expectation per assert, with a message that says what was expected.
- Read the game state through the objects/variables the events touch (object variables, scene variables) — not through internals.

## Failure discipline
- A failing run returns the assertion message, console logs, final state and a screenshot: read them before touching the events.
- The executed source is returned on failure — the line number points at the failing assert; repair and re-run the same test name.
- A "paused" status means the preview window was not visible (not a game bug): ask the user to keep it visible.

## Verify the verifier
- A test that cannot fail is not a test: first write it to fail on the current build (or assert the opposite), then make it green.
