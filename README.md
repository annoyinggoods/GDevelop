# GDevelop — BYOK fork

This repository is a fork of [GDevelop](https://github.com/4ian/GDevelop), the full-featured, no-code, open-source game development software.
Its substantial additions are a complete **Bring-Your-Own-Key (BYOK)** implementation of the "Ask AI" agent — the AI chat runs against *your* OpenAI-compatible endpoint, on *your* machine, with *your* key — and a set of asset, build and event-quality tools built on top of it.
Everything else (the editor, the GDJS game engine, the C++ Core, the extensions ecosystem) is upstream GDevelop, kept in sync by regular merges (latest: upstream `4d867e222b`, merged 2026-11-02).
The fork's own code lives in `newIDE/app/src/AiGeneration/Byok/` and `newIDE/app/src/Fork/`, with the Electron-side pieces in `newIDE/electron-app/app/`.

## Why this might matter to you

If you make games with GDevelop and pay for an AI subscription somewhere else, this fork lets the built-in AI assistant use that subscription instead of GDevelop's hosted service.
You point it at any OpenAI-compatible endpoint — OpenAI, OpenRouter, Azure OpenAI, Groq, DeepSeek, a local Ollama or LM Studio server — pick the model you want per chat, and the agent keeps working while the whole conversation stays on your machine.
Nothing you type, and no key you paste, is sent to GDevelop's servers: the agent loop, the tools and the game edits all run inside the editor.
You also get an MCP endpoint, so the AI agents you already use (Claude Code, Cursor, your own scripts) can read and edit your GDevelop project directly, and a handful of build-time and asset-management improvements that the upstream editor does not have yet.

## Why this fork exists: BYOK has been asked for upstream, repeatedly, and never shipped

The request is not ours — it comes from the GDevelop community, and it is still open upstream.
[Issue #7932 — "Feature Request: BYOK (Bring Your Own Key/Model) support for GDevelop AI Agent"](https://github.com/4ian/GDevelop/issues/7932) was opened in October 2025 and is **still open**; the maintainer [answered it asking for use cases](https://github.com/4ian/GDevelop/issues/7932), and several users spelled out exactly why they need it (using an OpenRouter key to test models on demand, running a local model for privacy and zero marginal cost, and not being blocked when the official server is unavailable).
[Issue #8854 — "BYOK (Bring Your Own Key/Model) support for GDevelop AI Agent"](https://github.com/4ian/GDevelop/issues/8854), opened in July 2026, is a second, independent request that is also still open.
Two community contributors have already tried to implement it upstream: [PR #8606](https://github.com/4ian/GDevelop/pull/8606) ("Add BYOK custom AI provider support for Ask AI", closed by its author) and [PR #8986](https://github.com/4ian/GDevelop/pull/8986) ("Bring Your Own Key (BYOK) & local/custom model support", closed by its author without a maintainer decision).
As of upstream `4d867e222b` the upstream tree contains **no BYOK implementation at all** (zero matching files), the feature is not part of any official release, and it is not advertised on the official website.
This fork exists to make it real: the implementation below was written from scratch, is tested end to end, and is offered to everyone who needs it.

## What is implemented here

### A client-side AI agent loop (the core of the fork)

Upstream runs the agent server-side, which is exactly why it needs your key on their servers.
This fork re-implements the loop locally in `newIDE/app/src/AiGeneration/Byok/ByokOrchestrator.js`: it composes the system prompt once per chat and reuses it byte-identically (so provider prompt caching keeps working across a long build session), sends the request to your endpoint, parses the tool calls, executes them through the **same tool registry the hosted agent uses** (`src/EditorFunctions/`), feeds the results back, and repeats until the model stops.
The chat UI, the message types and the tool implementations are reused rather than forked, so the two agents behave the same way — only the transport changes.
A project snapshot rides its own synthetic trailing user message instead of being folded into the last one, which keeps the transcript strictly append-only and therefore cache-friendly.

### Any OpenAI-compatible provider, with per-chat routing

`ByokModelRouter.js` resolves the endpoint, model and reasoning effort for each turn: providers are declared once in Preferences (endpoint URL, model list, per-model temperature / max tokens / context window), and each chat can override the provider, the model and the effort through dropdowns in the chat header.
Two routing profiles — a "default strong" and a "default fast" pair — are stored per provider and migrated by `migrateByokRoutingProfiles` when the settings shape changes.
`ByokCapabilities.js` probes what an endpoint actually supports (tools, vision, reasoning effort) instead of assuming, and `ByokBenchmark.js` runs a built-in four-task benchmark against a provider so you can compare models before committing to one.

### Keys encrypted at rest, per provider

API keys are never stored in plain text: the renderer hands them to the Electron main (`ByokSafeStorage.js`), which encrypts them with the OS key store via `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux) and hands back only ciphertext.
`ByokKeyStorage.js` keeps one encrypted slot per provider, so switching providers never clobbers a key, and removing a provider does not wipe the shared legacy slot.

### The agent writes real events — locally, in plain EventScript

`ByokEventScriptParser.js` implements the full EventScript grammar (conditions, actions, `if` / `else` / `while` / `repeat` / `for-each` / groups, local variables, `await`, string-aware top-level splitting) and `ByokLocalEventWriter.js` turns the parsed batch into real `gd.EventsList` objects.
The write is **all-or-nothing**: the whole batch is validated against a real event list *before* anything is modified, so a rejected batch leaves the project untouched and returns a positioned, model-fixable error plus a targeted retry hint.
Upstream's newer JavaScript code events (`js """…"""`) are supported, and a set of canonical examples is shipped in `Byok/docs/eventscript-examples.json` and round-tripped through the real writer by the specs.

### Tool parity with the hosted agent, with on-demand discovery

`ByokToolSchema.js` exposes **75 dispatchable tools**, of which **28** are advertised inline on every turn (the rest are discovered through the `search_tools` meta-tool, which keeps the billed tool list small without hiding capability).
`ByokExtraTools.js` intercepts the tools that only make sense against GDevelop's backend and implements them locally instead.
The tool surface covers scenes, objects, instances, variables, behaviors, effects, sprites, extensions, external events and external layouts, resources, the asset store, the debugger and the fork's own asset/build tools.
Because upstream shipped its own extension tools with the same names but a different argument shape, this fork's variants live in a separate `_BYOK` namespace (`create_extension_BYOK` and friends) so a name can never reach the wrong implementation.

### Perception: the agent can see your running game

`ByokPreviewSession.js` captures the open preview window as a base64 PNG and replays it to the provider as an image part, so the agent can check what it just changed instead of guessing.
Images are stored in the BYOK image store and replayed monotonically, so an image never reappears earlier in the transcript (which would break provider-side caching).

### Debugger and runtime tools

`ByokDebuggerTools.js` talks to the preview session's TARGETED debugger channel: `read_runtime_details` (inspect variables, scenes and instances as the game runs), `control_runtime` (pause, resume, step) and `profile_runtime` (wait for pushed profiler output).
The dumps are capped with an honest truncation report rather than silently truncated, and the tools honour the `scene_name` and `variable_paths` arguments they advertise.

### Durable chat history that survives a restart

`ByokChatPersistence.js` and `ByokChatStore.js` save each BYOK chat as a Markdown transcript with image sidecars, through Electron IPC files or IndexedDB depending on the platform.
Writes are atomic (unique temp file + rename, with cleanup on failure), a quarantine path keeps a corrupt chat from taking the store down with it, and a 200 MB quota bounds the folder.
A versioned `index.json` means the steady-state save path and the rail's actions read **zero** chat content — only the metadata — and a reconcile pass adopts legacy or unseen files and drops stale entries.

### Long conversations: compaction, stall watchdog, loop guards

`ByokCompactor.js` compacts the transcript when it approaches the model's context limit, preserving a designated block and dropping in a documented order, with a round-based fallback boundary so a single mega-turn build chat (one user message, fifty-plus tool rounds) can still be compacted.
`ByokLoopGuards.js` detects an alternating cycle and rolls back an unexecuted batch instead of letting the agent repeat itself, and the stall watchdog turns a silent hang into a visible notice row in the chat.
Error codes are distinct (`byok-context-full`, `byok-repeated-tool-call-loop`, `byok-too-many-tool-rounds`, `byok-empty-answer`) and are mapped to the right user-facing recovery text in `AiRequestErrorRow.js`.

### An MCP server, so any external agent can drive GDevelop

`electron-app/app/ByokMcpServer.js` runs a loopback HTTP endpoint inside the Electron main process: a bearer token, an ephemeral port, a discovery file in the user-data folder, focused-window routing, second-instance refusal and a 150-second forward timeout.
`newIDE/app/src/AiGeneration/Byok/Mcp/` holds the renderer side — the protocol core pinned to MCP revision `2026-07-28`, the tool mapping and the read-only / read-write access gate, and a serialized tool host with an activity ring.
`newIDE/app/scripts/gdevelop-mcp-stdio.js` is the zero-dependency stdio adapter, so a zero-config MCP client can find the endpoint on its own.
Skills are exposed as MCP prompts, notes and docs as `gdevelop://` resources, and a project mutation lock serializes the chat's tool batches against MCP calls so the two cannot edit the project at the same time.

### On-device retrieval (RAG) over the GDevelop documentation

`newIDE/app/src/AiGeneration/Byok/Rag/` builds a local corpus — the whole `gdevelop5` wiki, minified by the committed generator (`Byok/docs/gdevelop-docs/MinifiedDocs.generated.js`, 601 of 601 pages, 2.2 MB) plus the engine reference — into about 4,000 chunks (4,024 in the shipped bundle) held in a deterministic in-process index with base64 vectors, and searches it hybrid-wise (lexical + semantic) through the `search_knowledge` tool.
The embedder is lazy-loaded (`@huggingface/transformers`), so nothing is downloaded until you opt in; the ranking is source-weighted so curated tiers outrank raw wiki prose, and the corpus is checked by a 30-query evaluation set.
A prebuilt index can be downloaded and verified by sha256, and Qdrant is available as an optional backend (`ByokQdrant.js`) that this fork can install and drive itself.

### Game code on disk

`Byok/GameCode/` lets the agent write ordinary JavaScript files into `<project>/<GameName>Code/`.
The rules are pure and pinned by specs: the files may never leave that folder, they load in a defined order, they publish into a folder-derived namespace (`GameCode.character.spawn`), and because the exporter copies resources flat, the hot reload computes the exact exported name instead of guessing it.
The agent can also read, list and update those files through tools.

### Attachments

`ByokAttachments.js` adds the "+" button to the chat: text files are sniffed (extension plus a NUL-byte check), capped at 100 KB and injected as a fenced block; images go through the BYOK image store and are replayed as `image_url` parts.
Chips show what is attached, the menu is gated by what the provider supports, and the whole path is compaction-aware.

### Prompt composition, skills and knowledge

`ByokPrompts.js` composes the system prompt (currently version `byok-v18`) from a retrieval map, a machine-checked task catalog, the EventScript syntax block, and the knowledge sections.
`Byok/Knowledge/` holds the generated sections, `Byok/Skills/` the built-in skills, and user-written skills are read from `<userData>/byok-skills` by `electron-app/app/ByokUserSkills.js`.
The prompt budget is measured by a spec on every change (currently ~12.7k tokens for `byok-v18`: ~6.6k of prompt plus ~6.1k of tool schemas, against a 15k hard cap), and the specs fail if a section grows past its share.

### Asset store search and real installs

`ByokCatalogTools.js` gives the agent `get_game_starter_summary` (the real public examples catalog instead of the model's memory), `search_object_asset_store` and `search_resource_store` over the auth-free public catalogs with a self-contained scorer, and a real install path: an "add an enemy" request fetches the asset, resolves its required extensions and registers it in the project.

### Fork: tagged assets, with a virtual tree

`newIDE/app/src/Fork/AssetPipeline/` adds tags to the project resources (they ride the existing resource metadata, so there is no second source of truth), a many-to-many virtual tree with an "Untagged" bucket, an Assets view hosted in the resources panel, a tag editor in the properties panel, auto-registration of files dropped into the project folder, name-based aliases with Monaco completions in the code editor, and hot reload — a changed asset refreshes both the editor and the running preview.
The agent can use `list_assets` and `set_asset_tags` on the same model.

### Fork: build-time asset compression

`newIDE/app/src/Fork/AssetBuild/` plans an optimization pass (extension-driven, per-kind, in-place for the same format, with explicit reasoned skips) and `electron-app/app/ForkAssetOptimizer.js` applies it — with `sharp` and `ffmpeg-static` — to the **export copy only**, never to the project's originals.
The applier writes to a temp file and renames, so a failure leaves the file exactly as it was exported, and a before/after report shows what was saved.
The agent can read that report (`report_asset_optimization`) and change the settings (`set_asset_optimization_settings`) without ever touching the project's serialized state.

### Fork: event-sheet guardrails

`newIDE/app/src/Fork/Guardrails/` is a pure rule engine with four rules (stable ids, ancestor-stack recursion, disabled-subtree silencing, never mutating) that flags common event-sheet mistakes — for example an event that fires once inside a loop whose guard is re-checked every iteration.
The badges render inline in the event sheet, the rules can be muted individually or globally, and the filters are applied at render time so toggling a rule never rebuilds the tree.
The agent can run the same checks over a scene through the read-only `scan_scene_events` tool.

### Fork: sprite-sheet import

`newIDE/app/src/Fork/SpriteSheet/` plans an exact-tiling slice (rows × columns with margin slack) and refuses before any write when the grid does not divide evenly; the frames land in the project's assets folder, the registrations happen through the same import path the agent uses, and a failure rolls the registrations back.
`electron-app/app/ForkSpriteSheet.js` does the confined slicing with `sharp`, the sprite editor gains an "Import sprite sheet" button, and the import dialog shows a live canvas preview of the slices.
The agent can trigger it too, through the approval-gated `import_sprite_sheet` tool.

### External events and external layouts redraw live

When the agent writes to an external layout or an external events sheet, the open editor for that item now refreshes: the `onExternalLayoutModifiedOutsideEditor` and `onExternalEventsModifiedOutsideEditor` notifications fan out through the main frame to the external editor containers, so the change is visible immediately instead of on the next manual reload.

## Building the app from this repository

### Requirements

- **Node.js 20+** with npm (CI builds on Node 20).
- A C++ toolchain is *not* required: the prebuilt `libGD` WASM (the engine's Core bindings) is downloaded, not compiled.

### One-click build (recommended)

Double-click **`Build GDevelop App.cmd`** at the root of the repository, or run it from a terminal:

```sh
node newIDE/scripts/build-desktop-app.js
```

The installer and a portable zip are left in `newIDE/electron-app/dist`.
Useful options: `--dev` (development build), `--web` (web app only, no desktop packaging), `--skip-app-build` (package the IDE that is already built), `--skip-install` (never run `npm install`), `--portable` (build without code signing), `--dry-run` (print the commands without running them) and `--open-folder`.
The script gives its Node processes `--max-old-space-size=12288`, because the production build of the IDE does not fit in Node's default heap.

### Manual build

```sh
# 1. The IDE (renderer + build pipeline)
cd newIDE/app
npm install --ignore-scripts
npx patch-package
npm run make-version-metadata
npm run build-theme-resources
cd scripts && node import-libGD.js && cd ..   # run from newIDE/app/scripts: its paths are relative to that folder

# 2. The desktop shell
cd ../electron-app
npm install --ignore-scripts
cd app && npm install --ignore-scripts && cd ..

# 3. Restore the lockfiles the installs always dirty (run from newIDE/electron-app)
git checkout -- package-lock.json app/package-lock.json ../app/package-lock.json
```

Then, from `newIDE/app`:

```sh
npm start          # development build of the IDE (webpack dev server)
npm run build      # production build of the IDE
```

And to package the desktop app, from `newIDE/electron-app`:

```sh
npm run build
```

### Checks

From `newIDE/app`:

```sh
npm test -- --watchAll=false   # the Jest suite
npm run lint                   # ESLint, zero warnings allowed
npm run flow                   # Flow type check
npm run check-format           # Prettier
```

From `newIDE/electron-app`: `npm run check-format` (the Electron main process has no test runner).

---

# Original GDevelop README

![GDevelop logo](https://raw.githubusercontent.com/4ian/GDevelop/master/newIDE/GDevelop%20banner.png "GDevelop logo")

GDevelop is a **full-featured, no-code, open-source** game development software. You can build **2D, 3D and multiplayer games** for mobile (iOS, Android), desktop and the web. GDevelop is designed to be fast and incredibly intuitive: make games using an easy-to-understand yet powerful event-based system and modular behaviors. Create with AI that assists or builds alongside you.

![The GDevelop editor when editing a game level](https://raw.githubusercontent.com/4ian/GDevelop/master/newIDE/GDevelop%20screenshot.png "The GDevelop editor when editing a 3D game level")

![The GDevelop editor when editing a game level](./newIDE/GDevelop%202D%20screenshot.png "The GDevelop editor when editing a 2D game level")

## Getting started

| ❔ I want to...                                   | 🚀 What to do                                                                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🎮 Use GDevelop to make games                     | Go to [GDevelop homepage](https://gdevelop.io) to download the app!                                                                                               |
| ⚙️ Create/improve an extension                    | Read about [creating an extension](https://wiki.gdevelop.io/gdevelop5/extensions/create), with no-code or code.                                                   |
| 🧑‍💻 Contribute to the editor or game engine        | Follow this [README](newIDE/README.md).                                                                                                                           |
| 👾 Create or sell a game template                 | Submit a [free example or a paid template on the Asset Store](https://wiki.gdevelop.io/gdevelop5/community/guide-for-submitting-an-example/).                     |
| 🎨 Share or sell an asset pack                    | Submit a [free or paid asset pack on the Asset Store](https://wiki.gdevelop.io/gdevelop5/community/sell-asset-pack-store).                                        |
| 🌐 Help translate GDevelop                        | Go on the [GDevelop project on Crowdin](https://crowdin.com/project/gdevelop) or translate [in-app tutorials](https://github.com/GDevelopApp/GDevelop-tutorials). |
| 👥 Get online game services or commercial support | See offers for [professionals, teams or individual creators](https://gdevelop.io/pricing).                                                                        |

> Are you interested in contributing to GDevelop for the first time? Take a look at the list of **[good first issues](https://github.com/4ian/GDevelop/issues?q=is%3Aissue+is%3Aopen+label%3A%22%F0%9F%91%8Cgood+first+issue%22)**, **[good first contributions](https://github.com/4ian/GDevelop/discussions/categories/good-first-contribution)** or the **["🏐 not too hard" cards](https://trello.com/b/qf0lM7k8/gdevelop-roadmap?menu=filter&filter=label:Not%20too%20hard%20%E2%9A%BD%EF%B8%8F)** on the Roadmap.

## Games made with GDevelop

- Find GDevelop games on [gd.games](https://gd.games), the gaming platform for games powered by GDevelop.
- See the [showcase of games](https://gdevelop.io/games) created with GDevelop and published on Steam, iOS (App Store), Android (Google Play), Itch.io, Newgrounds, CrazyGames, Poki...

[![Some games made with GDevelop](https://raw.githubusercontent.com/4ian/GDevelop/master/newIDE/GDevelop%20games.png "Some games made with GDevelop")](https://gdevelop.io/games)

## Technical architecture

GDevelop is composed of an **editor**, a **game engine**, an **ecosystem** of extensions as well as **online services** and commercial support.

| Directory     | ℹ️ Description                                                                                                                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Core`        | Core classes, describing the structure of a game and tools to implement the IDE and work with GDevelop games.                                                                                                                                                                                            |
| `GDJS`        | The game engine, written in TypeScript, using PixiJS and Three.js for 2D and 3D rendering (WebGL), powering all GDevelop games.                                                                                                                                                                          |
| `GDevelop.js` | Bindings of `Core`, `GDJS` and `Extensions` to JavaScript (with WebAssembly), used by the IDE.                                                                                                                                                                                                           |
| `newIDE`      | The game editor, written in JavaScript with React, Electron, PixiJS and Three.js.                                                                                                                                                                                                                        |
| `Extensions`  | Built-in extensions for the game engine, providing objects, behaviors and new features. For example, this includes the physics engines running in WebAssembly (Box2D or Jolt Physics for 3D). All the [official and experimental extensions are on this repository](https://github.com/GDevelopApp/GDevelop-extensions). [Community extensions are available here](https://github.com/GDevelopApp/GDevelop-community-list). |

To learn more about GDevelop Architecture, read the [architecture overview here](Core/GDevelop-Architecture-Overview.md).

Pre-generated documentation of the game engine is [available here](https://docs.gdevelop.io).

Status of the tests and builds: [![macOS and Linux build status](https://circleci.com/gh/4ian/GDevelop.svg?style=shield)](https://app.circleci.com/pipelines/github/4ian/GDevelop) [![Fast tests status](https://gdevelop.semaphoreci.com/badges/GDevelop/branches/master.svg?style=shields)](https://gdevelop.semaphoreci.com/projects/GDevelop) [![Windows Build status](https://ci.appveyor.com/api/projects/status/84uhtdox47xp422x/branch/master?svg=true)](https://ci.appveyor.com/project/4ian/gdevelop/branch/master) [![https://good-labs.github.io/greater-good-affirmation/assets/images/badge.svg](https://good-labs.github.io/greater-good-affirmation/assets/images/badge.svg)](https://good-labs.github.io/greater-good-affirmation)

## Links

### Community

- [GDevelop forums](https://forum.gdevelop.io) and [Discord chat](https://discord.gg/gdevelop).
- [GDevelop homepage](https://gdevelop.io).
- [GDevelop wiki (documentation)](https://wiki.gdevelop.io/gdevelop5/start).
- Help translate GDevelop in your language: [GDevelop project on Crowdin](https://crowdin.com/project/gdevelop).
- Open-source [extensions (official or experimental)](https://github.com/GDevelopApp/GDevelop-extensions), [community extensions](https://github.com/GDevelopApp/GDevelop-community-list), [examples](https://github.com/GDevelopApp/GDevelop-examples), [tutorials](https://github.com/GDevelopApp/GDevelop-tutorials) are on GitHub.

### Development Roadmap

- [GDevelop Roadmap on Trello.com](https://trello.com/b/qf0lM7k8/gdevelop-roadmap), for a global view of the features that could be added. Please vote and comment here for new features/requests.
- [GitHub issue page](https://github.com/4ian/GDevelop/issues), for technical issues and bugs.
- [Github discussions](https://github.com/4ian/GDevelop/discussions) to talk about new features and ideas.

## License

- The Core library, the native and HTML5 game engines, the IDE, and all extensions (respectively `Core`, `GDJS`, `newIDE` and `Extensions` folders) are under the **MIT license**.
- The name, GDevelop, and its logo are the exclusive property of Florian Rival.

Games exported with GDevelop are based on the GDevelop game engine (see `Core` and `GDJS` folders): this engine is distributed under the MIT license so that you can **distribute, sell or do anything** with the games you created with GDevelop. In particular, you are not forced to make your game open-source.

[node.js]: https://nodejs.org

## Star History

Help us spread the word about GDevelop by starring the repository on GitHub!

[![Star History Chart](https://api.star-history.com/svg?repos=4ian/gdevelop&type=Date)](https://star-history.com/#4ian/gdevelop&Date)
