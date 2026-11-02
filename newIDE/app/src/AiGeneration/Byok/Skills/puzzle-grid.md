---
name: puzzle-grid
description: Build grid-based puzzles (match, Sokoban, 2048-like) — grid state in variables, input rules, move validation and win/lose detection.
---

# Grid puzzles

## State lives in variables, not instances
- Model the board as a 2D structure variable (`Board` with `x,y` children) or an array with `width*height` children. Instances are only a *view* of the variable state.
- One helper "redraw" pass: after each move, update the instances from the variables (or one instance per cell positioned via `CellWidth() * x`).

## Moves and rules
- Read input once per press (`KeyPressed(...) and once`), not per frame.
- Validate before applying: compute the target cell, check bounds and occupancy in the variables, then commit. Never move instances first and "fix" later.
- Match-3: fill empties with `RandomInRange`, scan for runs of 3+ in rows and columns, remove, apply gravity, refill, repeat until stable. Cap cascade loops (`repeat` with a bound) to avoid infinite loops.

## Win/lose detection
- Win: a variable predicate over the board (all gems cleared, score ≥ target, one cell contains the tile). Check after each committed move, not every frame.
- Lose: no valid moves remain (scan), or a move counter/timeout hits zero. Detect deadlocks explicitly — a puzzle the player cannot lose is a toy.

## Feel
- Tween every move (position/lerp), pop matches with scale+opacity tweens, add a subtle sound per match tier.
- Show the move count/score as text bound to the variable (`SetText` each redraw).

## Verify
- Gameplay test: simulate a fixed input sequence, assert the board variables (not just instances) after N moves; assert a known winning sequence wins.
