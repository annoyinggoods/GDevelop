# GDevelop BYOK Project — Style Guide

This document describes the rules that already exist in this repository, plus the
additional rules we enforce for the BYOK project. **Every person or AI agent
working in this repository must follow it.** The companion document for AI agents
is [agents.md](agents.md); the project roadmap is [report.md](report.md) and
[Phase1.md](Phase1.md)–[Phase4.md](Phase4.md).

---

## 1. Project goal

Add a **BYOK (Bring Your Own Key)** feature to the GDevelop IDE: users can connect
their own OpenAI-compatible API endpoint (URL + API key), and the existing
"Ask AI" feature runs against that endpoint instead of GDevelop's hosted backend.

Hard constraints (from the product owner):

1. **As few changes to existing files as possible.** New code lives in its own
   files/folders so that future upstream updates to GDevelop are unlikely to
   break it.
2. OpenAI-compliant API: `GET /v1/models` to list models, `POST /v1/chat/completions`
   to chat.
3. The API key must be stored **encrypted** where the platform allows it.
4. AI settings: reasoning effort ("thought level"), context window (auto-detected
   from the server when possible, user-set otherwise), and a live token-window
   usage indicator in the active chat.
5. The feature is configured in its own **"BYOK" tab** in the Preferences dialog.
6. Desktop (Electron, Windows) is the primary target; the web build is best-effort.

## 2. Repository orientation

```
D:\Projects\GDevelop\
  newIDE\app\           ← the React IDE (this is where ~all BYOK code goes)
    src\AiGeneration\   ← existing "Ask AI" feature
    src\AiGeneration\Byok\   ← ALL new BYOK code lives here (created in Phase 1)
    src\MainFrame\Preferences\   ← preferences dialog + storage (2 small edits)
    src\EditorFunctions\         ← the AI tool registry (imported, never modified)
    src\Utils\GDevelopServices\  ← existing backend services (imported, never modified)
    src\locales\                 ← translation catalogs (never hand-edited)
  newIDE\electron-app\  ← the Electron main process (one small edit in Phase 3)
  REVIEW\               ← ALL project documentation lives here
```

## 3. Documentation rules

- **All documentation goes in `/REVIEW`.** Never create `.md` files anywhere else
  in the repository. The canonical set is:
  - `report.md` — repository map and overall plan (do not rewrite; append updates at the bottom if needed)
  - `Phase1.md` … `Phase4.md` — implementation phases with steps and acceptance criteria
  - `styleguide.md` (this file) and `agents.md`
  - `worklog.md` — mandatory action log (see section 8)
- Do not create new top-level documents without explicit approval from the user.
- Update a phase document only by appending dated notes (e.g. decisions taken
  during a step); never delete acceptance criteria that were already agreed.

## 4. Tech stack (what already exists — do not introduce alternatives)

| Concern | What the repo uses | Rule for BYOK |
|---|---|---|
| Language | JavaScript (not TypeScript) with **Flow** types | Add `// @flow` to every new file; type everything exported |
| Formatting | **Prettier 1.15.3** (`.prettierrc` in `newIDE\app`) | Run `npm run format` (or match existing style) before finishing |
| Linting | **ESLint**, warnings are errors (`--max-warnings=0`) | `npm run lint` must pass with zero warnings |
| Type checking | **Flow** (`flow-bin`) | `npm run flow` must pass; no new `$FlowFixMe` without a written reason |
| Tests | **Jest** via `react-app-rewired test --env=node` | Co-located `*.spec.js`; see section 6 |
| UI kit | Components in `src\UI\` (TextField, CompactSelectField, Text, Tabs, ColumnStackLayout, …) | Never add a competing UI library; always use `src\UI` components |
| i18n | **Lingui** (`<Trans>`, `` t`` `` from `@lingui/macro`) | Every user-visible string is wrapped; never edit files in `src\locales` by hand — untranslated strings fall back to English automatically |
| HTTP | **axios** for services (see `Utils\GDevelopServices\Generation.js`) | Use axios for BYOK calls, same style; streaming (later) would use `fetch` |
| Electron access | `optionalRequire('electron')` from `Utils\OptionalRequire.js` | Never `require('electron')` directly (breaks the web build) |
| Dates/time | Plain `Date` | No new date libraries |
| New npm dependencies | — | **Forbidden without explicit user approval** |

## 5. Code style rules

Follow the surrounding code first; these rules fill the gaps and the BYOK-specific
ones are **mandatory**:

### 5.1 Typing (Flow)

- First line of every new file: `// @flow`.
- Use **exact object types** `{| ... |}` for data shapes (the repo convention —
  see `PreferencesContext.js`), not loose `{...}` types, for anything we serialize
  or pass across module boundaries.
- Export types from the module that owns the data (BYOK types live in
  `Byok\ByokTypes.js`).
- No `any` in new code. Where the old code forces it (e.g. tool outputs typed
  `any`), contain it at the boundary and convert to a typed shape immediately.
- Optional values use the Flow maybe syntax `?string` / `?number`.

### 5.2 Naming and files

- Components: PascalCase file and name (`ByokSettingsTab.js`).
- Pure logic modules: camelCase (`ByokUsageTracker.js`).
- Constants: UPPER_SNAKE_CASE (`DEFAULT_BYOK_CONTEXT_WINDOW`).
- Tests sit next to the code: `ByokUsageTracker.spec.js`.
- CSS: never inline big styles; use `.module.css` next to the component if needed.
- localStorage keys are prefixed `gd-` (existing convention).

### 5.3 Readability (BYOK project rule — enforced in code review)

The existing repo mixes styles; for BYOK code we require the readable end:

- **No nested loops.** If you need two dimensions, extract the inner loop into a
  named helper function.
- **No nested ifs.** Use guard clauses / early returns:
  ```js
  // Bad:
  if (config) { if (config.enabled) { if (config.key) { ... } } }
  // Good:
  if (!config) return null;
  if (!config.enabled) return null;
  if (!config.key) return null;
  ...
  ```
- **Longer but readable beats short but clever.** No one-letter variables, no
  chained ternaries, no "clever" one-liners, no arrow-function golf.
- A function does one thing. If you need "and" to describe it, split it.
- Comments explain **why**, not what the next line does. Copy the tone of
  existing comments (e.g. `PreferencesContext.js`: "Store as object in case we
  need to add options.").
- Never write comments that talk to a reviewer ("this fixes the bug from…").

### 5.4 Error handling

- Follow the existing service style: validate responses, throw errors with
  messages a user can understand; catch at the UI boundary and display inline.
- Never let an API key appear in an error message, a `console.*` call, or a
  network log.

## 6. Testing rules

- **Every function must have a corresponding test.** Pure helpers get plain unit
  tests; React components get at least a render smoke test; thin wiring (a line
  that calls another tested function) is tested through the function it calls.
- Tests are co-located: `SameNameAsModule.spec.js`.
- The default Jest environment is **node**. If a test needs the DOM (rendering
  components), add `@jest-environment jsdom` in a docblock at the top of the file
  (see `src\UI\DragAndDrop\TouchDragDelay.spec.js` for an example).
- Write test data with small `makeXxx()` factory helpers, exactly like
  `AiRequestUtils.spec.js` does — don't build giant inline literals.
- Run the suite from `newIDE\app`:

  ```
  cd D:\Projects\GDevelop\newIDE\app
  npm test          # watch mode; use `npm test -- --watchAll=false` for a single run
  npm run lint
  npm run flow
  npm run check-format
  ```

  (This checkout uses npm — `package-lock.json` is present. Upstream CI may use
  yarn; if a script name differs, check `package.json` first and note it in the
  worklog.)

## 7. Subagent guidance (for AI-assisted development)

- **Maximum 5 subagents dispatched at the same time.** The provider rate-limits
  beyond that. If more are needed, run them in waves of ≤ 5.
- This is a **Windows 11** machine with the classic Command Prompt as shell.
  Unix commands (`ls`, `head`, `tail`, `grep`, `cat`) do **not** work. Use `dir`,
  `findstr`, `type`, or — better — the dedicated file tools (Read/Glob/Grep).
- Exploration/mapping agents are **read-only**: they must never edit files.
- Subagent prompts must be self-contained: give each agent the absolute repo
  path, the exact question, and require `file:line` evidence in the answer.
- Collect and consolidate subagent findings yourself; never forward raw agent
  output to the user without reading it.

## 8. Worklog protocol (mandatory)

Every working session in this repository ends with an entry in
`/REVIEW/worklog.md`. **An entry is only valid if it contains all five of these
items — missing any one of them means the run failed:**

1. **Date** of the work.
2. **Brief description** of the actions taken.
3. **Bugs found** (or explicitly "none").
4. **Issues found** — anything surprising, blocked, or worth knowing later
   (or explicitly "none").
5. **Full list of files worked on** — every file created, modified, or read for
   the task (for read-only mapping sessions, list the key files read).

Rules:

- **Subagents never write worklog entries.** The orchestrating agent writes one
  consolidated entry covering its own work and the work it delegated to
  subagents.
- One entry per session, newest at the top, using the template at the top of
  `worklog.md`.
- If you skipped a planned step or an AC failed, that goes under "Issues found" —
  an honest failed check beats a silent pass.

---

*Last updated: 2026-09-13.*
