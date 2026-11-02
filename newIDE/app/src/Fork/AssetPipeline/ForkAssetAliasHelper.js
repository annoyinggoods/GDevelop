// @flow

/**
 * Phase 17.5 — the name-based alias convention and its resolver (D17-6).
 *
 * The exported game has no module system (classic `<script>` tags, window
 * globals), so an ES `import` in game code is a parse-time SyntaxError
 * that kills the whole file, and `@assets/...` is an unresolvable
 * specifier. Assets are addressed by RESOURCE NAME through the loader —
 * `play('player/jump')` works because the resource is NAMED that. The
 * resolver below validates a written name against the catalog BEFORE it
 * is emitted into game code.
 */

import type { ForkAssetCatalogEntry } from './ForkAssetCatalog';

/** The convention text taught next to the completions (and to the AI). */
export const FORK_ASSET_ALIAS_DOC: string = [
  'Assets are addressed by RESOURCE NAME, never by file path.',
  "A slash in a name is part of the name: play('player/jump') works when the resource is NAMED 'player/jump'.",
  'Do not use ES import statements or @assets/ specifiers: the exported game has no module system, and an import is a SyntaxError that kills the whole script.',
  'Use the project resource names exposed as completions (forkAssets["…"]) or the asset catalog.',
].join('\n');

/** How many near-miss suggestions a refusal carries. */
export const FORK_ASSET_ALIAS_MAX_SUGGESTIONS = 5;

export type ForkAssetAliasResolution =
  | {| ok: true, name: string, entry: ForkAssetCatalogEntry |}
  | {| ok: false, reason: string, suggestions: Array<string> |};

/**
 * The closest candidates for a miss: names the written text starts with
 * first, then names containing it, then names it contains — capped.
 */
export const suggestForkAssetNames = (
  catalog: $ReadOnlyArray<ForkAssetCatalogEntry>,
  writtenName: string
): Array<string> => {
  const needle = writtenName.toLowerCase();
  const startsWith: Array<string> = [];
  const contains: Array<string> = [];
  const containedIn: Array<string> = [];
  for (const entry of catalog) {
    const haystack = entry.name.toLowerCase();
    if (haystack.startsWith(needle)) startsWith.push(entry.name);
    else if (haystack.includes(needle)) contains.push(entry.name);
    else if (needle.includes(haystack)) containedIn.push(entry.name);
  }
  const all = startsWith.concat(contains).concat(containedIn);
  const unique: Array<string> = Array.from(new Set<string>(all));
  return unique.slice(0, FORK_ASSET_ALIAS_MAX_SUGGESTIONS);
};

/**
 * Validate a name the AI (or a user) wrote against the catalog. An exact
 * match — including a slash-path that IS a resource name — resolves;
 * anything else is refused with a clear reason and the closest candidates,
 * so a typo never silently ships as a broken runtime reference.
 */
export const resolveForkAssetReference = (options: {|
  catalog: $ReadOnlyArray<ForkAssetCatalogEntry>,
  writtenName: mixed,
|}): ForkAssetAliasResolution => {
  const { catalog, writtenName } = options;
  if (typeof writtenName !== 'string' || !writtenName.trim()) {
    return {
      ok: false,
      reason: 'The asset reference is empty.',
      suggestions: [],
    };
  }
  const trimmed = writtenName.trim();
  const entry = catalog.find(candidate => candidate.name === trimmed);
  if (entry) {
    return { ok: true, name: trimmed, entry };
  }
  const suggestions = suggestForkAssetNames(catalog, trimmed);
  return {
    ok: false,
    reason: [
      `No asset named "${trimmed}" exists in this project.`,
      'Assets are addressed by RESOURCE NAME, never by file path.',
    ].join(' '),
    suggestions,
  };
};
