// @flow

/**
 * Phase 17.1 — the pure tag model over the resource metadata (D17-2/D17-3).
 *
 * Tags ride the existing per-resource metadata JSON string (the same place
 * `resourceCustomProperties` and `localFilePath` already live — see
 * ResourcesList/ResourceUtils.js `updateResourceJsonMetadata`), so they
 * serialize with the project file and need no Core change. Every function
 * here is pure: no project, no filesystem, no React.
 *
 * The merge discipline: writing tags never clobbers the other metadata
 * keys. A metadata string that is not JSON at all round-trips UNTOUCHED by
 * a no-op write (an empty tag list); writing actual tags to it replaces it
 * with fresh JSON, exactly what `updateResourceJsonMetadata` does upstream.
 */

/** The metadata JSON key holding the resource's tags. */
export const FORK_ASSET_TAGS_METADATA_KEY = 'tags';

/** A tag is a short human word, not a sentence. */
export const FORK_ASSET_MAX_TAG_LENGTH = 64;

/** The stable refusal reasons of `normalizeForkAssetTag`. */
export type ForkAssetTagRefusalReason =
  | 'not-a-string'
  | 'empty'
  | 'control-characters'
  | 'path-separator'
  | 'too-long';

export type ForkAssetTagNormalization =
  | {| ok: true, tag: string |}
  | {| ok: false, reason: ForkAssetTagRefusalReason |};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_PATTERN = /[\u0000-\u001f\u007f]/;
const PATH_SEPARATORS_PATTERN = /[\\/]/;

/**
 * Validate and canonicalize one tag: lowercase, trimmed, and refused —
 * loudly, with a machine-readable reason — when it is empty, carries
 * control characters, a path separator (a tag is not a path) or is absurdly
 * long. The refusal is explicit so the UI and the AI tools can surface it
 * instead of silently dropping input.
 */
export const normalizeForkAssetTag = (
  input: mixed
): ForkAssetTagNormalization => {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'not-a-string' };
  }
  const tag = input.trim().toLowerCase();
  if (!tag) {
    return { ok: false, reason: 'empty' };
  }
  if (CONTROL_CHARACTERS_PATTERN.test(tag)) {
    return { ok: false, reason: 'control-characters' };
  }
  if (PATH_SEPARATORS_PATTERN.test(tag)) {
    return { ok: false, reason: 'path-separator' };
  }
  if (tag.length > FORK_ASSET_MAX_TAG_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }
  return { ok: true, tag };
};

/**
 * Best-effort cleanup of tags read back from a stored metadata blob (which
 * a user can hand-edit in the project file): lowercase and trim what can be
 * normalized, SKIP what cannot (an invalid stored tag must never crash the
 * tree — it is cosmetic data), and de-duplicate preserving order.
 */
export const normalizeStoredForkAssetTags = (
  rawTags: $ReadOnlyArray<mixed>
): Array<string> => {
  const seen: Set<string> = new Set<string>();
  const tags: Array<string> = [];
  for (const rawTag of rawTags) {
    const normalized = normalizeForkAssetTag(rawTag);
    if (!normalized.ok) continue;
    if (seen.has(normalized.tag)) continue;
    seen.add(normalized.tag);
    tags.push(normalized.tag);
  }
  return tags;
};

/** The metadata JSON parsed as an object, or null when it is not one. */
const parseMetadataObject = (metadata: string): ?Object => {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (error) {
    // Not JSON: treated as "no tags" (and preserved by no-op writes).
  }
  return null;
};

/**
 * Read the tags of a resource metadata string. Anything unusable — not
 * JSON, not an object, a `tags` key that is not an array — reads as "no
 * tags"; invalid individual entries are skipped by
 * `normalizeStoredForkAssetTags`.
 */
export const parseForkAssetTags = (metadata: string): Array<string> => {
  const metadataObject = parseMetadataObject(metadata);
  if (!metadataObject) return [];
  const rawTags = metadataObject[FORK_ASSET_TAGS_METADATA_KEY];
  if (!Array.isArray(rawTags)) return [];
  return normalizeStoredForkAssetTags(rawTags);
};

/**
 * Write the tags into a resource metadata string WITHOUT disturbing the
 * other keys (`resourceCustomProperties`, `localFilePath`, …). Returns the
 * new metadata string; the caller owns calling `resource.setMetadata`.
 *
 * A non-JSON metadata round-trips untouched when there is nothing to write
 * (an empty tag list is a no-op); writing real tags to it replaces it with
 * fresh JSON — the documented `updateResourceJsonMetadata` convention.
 */
export const serializeForkAssetTags = (
  metadata: string,
  tags: $ReadOnlyArray<string>
): string => {
  const metadataObject = parseMetadataObject(metadata);
  if (!metadataObject) {
    if (tags.length === 0) return metadata;
    return JSON.stringify({ [FORK_ASSET_TAGS_METADATA_KEY]: tags });
  }
  return JSON.stringify({
    ...metadataObject,
    [FORK_ASSET_TAGS_METADATA_KEY]: tags,
  });
};

// Inexact on purpose: callers pass their richer entry shapes (the Assets
// view's `{name, tags}`), and only `tags` is read here.
export type ForkAssetTagVocabularyEntry = {
  +tags: $ReadOnlyArray<string>,
  ...
};

/**
 * The sorted set of tags present in a list of entries (the tag picker's
 * vocabulary). Read-side normalization applies, so the vocabulary only
 * ever contains canonical tags.
 */
export const collectForkAssetTagVocabulary = (
  entries: $ReadOnlyArray<ForkAssetTagVocabularyEntry>
): Array<string> => {
  const vocabulary: Set<string> = new Set<string>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const normalized = normalizeForkAssetTag(tag);
      if (normalized.ok) vocabulary.add(normalized.tag);
    }
  }
  return Array.from(vocabulary).sort();
};
