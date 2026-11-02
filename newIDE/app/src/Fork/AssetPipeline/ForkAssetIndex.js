// @flow

/**
 * Phase 17.2 — the OPTIONAL sidecar index (D17-2/D17-8).
 *
 * `assets-index.json` is a CACHE, never an authority: the resource metadata
 * inside the project file is the truth. The index exists only to avoid
 * re-parsing every resource's metadata on a big project; any disagreement
 * resolves to metadata (`mergeForkAssetIndexWithMetadata`).
 *
 * Defensive like the game-code manifest (ByokGameCodeManifest.js): a
 * versioned shape, every field validated, a truncated, hand-edited or
 * future-version file degrades to "no index" and is rebuilt on the next
 * write.
 */

/** Bump when the shape below changes incompatibly. */
export const FORK_ASSET_INDEX_VERSION = 1;

/** The sidecar file name, inside the project folder. */
export const FORK_ASSET_INDEX_FILE_NAME = 'assets-index.json';

export type ForkAssetIndexEntry = {|
  +name: string,
  +kind: string,
  +file: string,
  +tags: Array<string>,
|};

export type ForkAssetIndex = {|
  +version: number,
  +entries: Array<ForkAssetIndexEntry>,
|};

export const makeForkAssetIndex = (options?: {|
  entries?: Array<ForkAssetIndexEntry>,
|}): ForkAssetIndex => ({
  version: FORK_ASSET_INDEX_VERSION,
  entries: (options && options.entries) || [],
});

/**
 * Insert or replace one entry, keyed by resource name. The entry list
 * stays sorted by name (stable, display- and diff-friendly).
 */
export const upsertForkAssetIndexEntry = (
  index: ForkAssetIndex,
  entry: ForkAssetIndexEntry
): ForkAssetIndex => {
  const keptEntries = index.entries.filter(
    existing => existing.name !== entry.name
  );
  const entries = keptEntries.concat([entry]);
  entries.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
  return { ...index, entries };
};

export const removeForkAssetIndexEntry = (
  index: ForkAssetIndex,
  name: string
): ForkAssetIndex => ({
  ...index,
  entries: index.entries.filter(existing => existing.name !== name),
});

export const findForkAssetIndexEntry = (
  index: ForkAssetIndex,
  name: string
): ?ForkAssetIndexEntry =>
  index.entries.find(entry => entry.name === name) || null;

export const serializeForkAssetIndex = (index: ForkAssetIndex): string =>
  JSON.stringify(index, null, 2);

/**
 * Parse an index, or report why it is unusable. Every field is checked:
 * the file lives on disk next to the project, where a crashed write or a
 * curious user can leave anything.
 */
export const parseForkAssetIndex = (
  text: string
): {| ok: true, index: ForkAssetIndex |} | {| ok: false, error: string |} => {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: 'The asset index is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'The asset index is not an object.' };
  }
  if (parsed.version !== FORK_ASSET_INDEX_VERSION) {
    return {
      ok: false,
      error: `The asset index has version ${
        parsed.version === undefined ? 'none' : parsed.version
      } (expected ${FORK_ASSET_INDEX_VERSION}).`,
    };
  }
  if (!Array.isArray(parsed.entries)) {
    return { ok: false, error: 'The asset index has no entries list.' };
  }

  // A hand-edited file can carry a duplicated name: last one wins, so the
  // shape stays a function of the text.
  const entriesByName: Map<string, ForkAssetIndexEntry> = new Map();
  for (const rawEntry of parsed.entries) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      return { ok: false, error: 'An asset index entry is not an object.' };
    }
    if (typeof rawEntry.name !== 'string' || !rawEntry.name) {
      return { ok: false, error: 'An asset index entry has no name.' };
    }
    if (!Array.isArray(rawEntry.tags)) {
      return {
        ok: false,
        error: 'An asset index entry has no tags list.',
      };
    }
    entriesByName.set(rawEntry.name, {
      name: rawEntry.name,
      kind: typeof rawEntry.kind === 'string' ? rawEntry.kind : '',
      file: typeof rawEntry.file === 'string' ? rawEntry.file : '',
      tags: rawEntry.tags.filter((tag: mixed) => typeof tag === 'string'),
    });
  }

  return {
    ok: true,
    index: makeForkAssetIndex({
      entries: Array.from(entriesByName.values()),
    }),
  };
};

/**
 * Parse, degrading to a FRESH index. Used on the read path, where a broken
 * sidecar must not stop the feature: metadata is re-read instead.
 */
export const parseForkAssetIndexOrEmpty = (text: string): ForkAssetIndex => {
  const parsed = parseForkAssetIndex(text || '');
  if (!parsed.ok) return makeForkAssetIndex();
  return parsed.index;
};

export type ForkAssetIndexResourceSnapshot = {|
  +name: string,
  +kind: string,
  +file: string,
  /** The tags read from the resource's METADATA (the authority). */
  +tags: Array<string>,
|};

/**
 * Re-align the index with the resources as the project model sees them.
 * Whatever the index claims, the snapshot wins: entries are rebuilt from
 * it, entries for resources that no longer exist are dropped, and entries
 * are ordered by resource name. This is the whole cache discipline in one
 * function — the index may lag, it may never lead.
 */
export const mergeForkAssetIndexWithMetadata = (
  index: ForkAssetIndex,
  resources: $ReadOnlyArray<ForkAssetIndexResourceSnapshot>
): ForkAssetIndex => {
  // The passed index is deliberately unread here: no field of it can
  // survive into the result. The snapshots are the whole truth, so the
  // merged index is exactly one entry per snapshot, ordered by name —
  // stale entries (removed resources, old tags) cannot linger.
  const entries: Array<ForkAssetIndexEntry> = resources.map(resource => ({
    name: resource.name,
    kind: resource.kind,
    file: resource.file,
    tags: resource.tags,
  }));
  entries.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
  return { ...index, entries };
};
