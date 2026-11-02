---
name: save-system
description: Save and restore game progress — what to save, storage actions, versioned schemas, and safe loading with defaults.
---

# Save systems

## Decide what is worth saving
- Progress (level reached, unlocks), player state (position, health, inventory), settings (volume, language). Transient state (paused menu open, in-flight tweens) is not.
- Keep the save small and boring: numbers, strings and structures — no instances, no object references.

## Write it
- Use the storage actions (`Storage`: write a structure variable to a named group in the app storage; the localStorage-style backend is handled by the engine).
- One root structure per save slot (`Save1` containing `level`, `player`, `settings`), written on: checkpoint reached, level completed, and app close (`Quit`-adjacent event) — never only on app close.
- Include `saveVersion` (a number) at the root, today.

## Read it safely
- After loading, treat every field as optional: `VariableChildExists(Save1, "level")` before reading, else apply the default. A save from an older build must not crash the game.
- Migration: if `saveVersion < current`, apply field-by-field fixes and bump the version, then immediately write back.
- Corruption handling: wrap load results in sanity checks (level ≥ 0, health in range); on nonsense, start fresh rather than glitching.

## Verify
- Gameplay test: set state, save, mutate the state, load, assert the state matches the pre-save values.
- Manually test the "no save exists" path — first launch must never read empty strings as numbers.
