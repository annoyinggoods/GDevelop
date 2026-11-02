---
name: game-code-authoring
description: Writing and managing the game code folder (<GameName>Code/ next to the project) — plain JavaScript files that ship in previews and exports, load in a deterministic order, and publish through the GameCode.* namespace. Load it when the task needs real runtime code (custom rendering, algorithms, direct engine API) that events cannot express well.
---

# Authoring game code (the `<GameName>Code/` folder)

## When game code is the right answer

- Keep events (add_scene_events) for ordinary gameplay logic: they stay
  inspectable by the read tools and by the user.
- Reach for a game code file when logic outgrows events: math-heavy
  algorithms, custom rendering, per-frame systems, direct `gdjs` runtime
  API, or porting an existing JavaScript library.

## The five tools

1. `list_game_code_files` — the folder's files in load order, each with its
   size and its `GameCode.*` namespace. Call it first.
2. `read_game_code_file` — one file's source plus its namespace and
   prologue.
3. `write_game_code_file` — create or replace one file. It registers the
   file in the export carrier automatically, so it ships in previews and
   exports with no extra step.
4. `delete_game_code_file` — remove a file and drop it from the export
   carrier.
5. `reload_game_code` — push changed files into the running preview of this
   chat.

## The taxonomy (folders are namespaces)

- The folder is `<project>/<GameName>Code/`; every tool path is relative to
  it and confined to it (`character/spawn.js`, never `..` or absolute
  paths).
- Load order is deterministic: folder root first, then `core/`, then every
  other folder alphabetically, alphabetical inside each.
- `core/` is a boot-order marker, NOT a namespace level: `core/boot.js`
  publishes `GameCode.boot`, not `GameCode.core.boot`.

## The namespace convention

- Files are classic scripts: no `import`/`export` (an ES module can never
  be unloaded from a running page). They run after the engine, against the
  `gdjs` runtime.
- Each file publishes `GameCode.<folder>.<name>`: `character/spawn.js` →
  `GameCode.character.spawn`; a root file `main.js` → `GameCode.main`.
- Open every file with its defensive prologue (the tools return it), then
  assign into the namespace: `GameCode.character.spawn = { spawn };`.
- Keep files small and single-purpose; a file is capped at 262144 bytes.

## Discipline

- List before writing, and read a file before rewriting it — the write
  replaces the whole content.
- After writes, verify like everything else: start a preview, read the
  logs, and call `reload_game_code` to hot-swap changed files. Deletions
  need a preview restart (the reload hard-reloads for them).
- Use `GameCode.*` from events via expression parameters, and document the
  entry points of a file in a short header comment.
