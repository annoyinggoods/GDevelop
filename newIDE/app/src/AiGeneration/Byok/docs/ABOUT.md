# About the bundled GDevelop documentation subset

The Markdown files under `gdevelop-docs/` are a curated subset of the
official GDevelop documentation, copied from the
[GDevelopApp/GDevelop-documentation](https://github.com/GDevelopApp/GDevelop-documentation)
repository so the BYOK agent can answer documentation questions offline
(replacing the hosted agent's server-side docs tools).

**License:** the GDevelop documentation states, in its `mkdocs.yml` and site
footer: *"Except where otherwise noted, content on this documentation is
licensed under the following license: CC Attribution-Share Alike 4.0
International"*. These files are therefore redistributed here under
**CC BY-SA 4.0**, with this notice as attribution. Keep this file and its
license statement when the subset is refreshed.

**Curated subset (15 pages, verified against the upstream tree on
2026-09-22):**

- `events/index.md`, `events/async.md`, `events/callback-variables.md`
- `events/standard/index.md`, `events/else/index.md`,
  `events/while/index.md`, `events/repeat/index.md`,
  `events/foreach/index.md`, `events/foreach-child-variable/index.md`,
  `events/group/index.md`, `events/link/index.md`,
  `events/functions/index.md`, `events/expressions/index.md`
- `events/js-code/index.md`, `events/object-picking/index.md`

(the phase plan called for `js-code.md`, `expressions.md` and
`object-picking.md`; upstream reorganized them as `events/<topic>/index.md`
pages — same content, recorded per the "docs drift" rule in AGENTS.md §8.)

Refresh by re-copying the pages above from a newer upstream checkout and
updating the date. Images are intentionally not bundled. The generated
`engine-reference.json` next to this folder is a separate artifact (see
`scripts/generate-byok-engine-reference.js`), built from the GDevelop source
code (MIT).
