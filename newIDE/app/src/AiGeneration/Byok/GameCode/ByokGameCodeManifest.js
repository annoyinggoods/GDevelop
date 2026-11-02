// @flow

/**
 * Phase 15.1 — the `gamecode.json` manifest.
 *
 * The file on disk is the source of truth (D15-1), so this manifest is
 * only an INDEX: it records what BYOK believes it registered in the project
 * model (the resource name, the file size, the content hash and the name
 * the exporter will give the file) so that a later run can tell "the file
 * changed" from "the file is new" from "the registry drifted", without
 * re-reading every file.
 *
 * It is deliberately defensive. A truncated, hand-edited or future-version
 * manifest must degrade to "no manifest" rather than brick the feature —
 * every consumer treats it as a cache, never as an authority.
 */

import xxhashjs from 'xxhashjs';
import {
  BYOK_GAME_CODE_CARRIER_EXTENSION_NAME,
  orderByokGameCodeRelativePaths,
} from './ByokGameCodeCore';

/** Bump when the shape below changes incompatibly. */
export const BYOK_GAME_CODE_MANIFEST_VERSION = 1;

export type ByokGameCodeManifestEntry = {|
  relativePath: string,
  resourceName: string,
  sizeBytes: number,
  /** xxhash32 of the content, as the hot reload computes it. */
  contentHash: number,
  /**
   * The `<script src>` this file gets in the exported game, or null when a
   * foreign resource makes it unknowable (see ByokGameCodeCore).
   */
  exportedScriptName: string | null,
|};

export type ByokGameCodeManifest = {|
  version: number,
  folderName: string,
  carrierExtensionName: string,
  entries: Array<ByokGameCodeManifestEntry>,
|};

/** The hash the hot reload compares, so the two agree by construction. */
export const getByokGameCodeContentHash = (content: string): number =>
  xxhashjs.h32(content, 0xabcd).toNumber();

export const makeByokGameCodeManifest = (options?: {|
  folderName?: string,
  carrierExtensionName?: string,
  entries?: Array<ByokGameCodeManifestEntry>,
|}): ByokGameCodeManifest => ({
  version: BYOK_GAME_CODE_MANIFEST_VERSION,
  folderName: (options && options.folderName) || '',
  carrierExtensionName:
    (options && options.carrierExtensionName) ||
    BYOK_GAME_CODE_CARRIER_EXTENSION_NAME,
  entries: (options && options.entries) || [],
});

/** One entry, with the list rebuilt in D15-3a load order. */
export const upsertByokGameCodeManifestEntry = (
  manifest: ByokGameCodeManifest,
  entry: ByokGameCodeManifestEntry
): ByokGameCodeManifest => {
  const keptEntries = manifest.entries.filter(
    existing => existing.relativePath !== entry.relativePath
  );
  const orderedPaths = orderByokGameCodeRelativePaths(
    keptEntries.concat([entry]).map(existing => existing.relativePath)
  );
  const byPath = new Map(
    keptEntries
      .concat([entry])
      .map(existing => [existing.relativePath, existing])
  );
  return {
    ...manifest,
    entries: orderedPaths.map(relativePath => {
      const found = byPath.get(relativePath);
      return found || entry;
    }),
  };
};

export const removeByokGameCodeManifestEntry = (
  manifest: ByokGameCodeManifest,
  relativePath: string
): ByokGameCodeManifest => ({
  ...manifest,
  entries: manifest.entries.filter(
    entry => entry.relativePath !== relativePath
  ),
});

export const findByokGameCodeManifestEntry = (
  manifest: ByokGameCodeManifest,
  relativePath: string
): ?ByokGameCodeManifestEntry =>
  manifest.entries.find(entry => entry.relativePath === relativePath) || null;

/** The manifest paths in D15-3a load order. */
export const getByokGameCodeManifestOrder = (
  manifest: ByokGameCodeManifest
): Array<string> =>
  orderByokGameCodeRelativePaths(
    manifest.entries.map(entry => entry.relativePath)
  );

export const serializeByokGameCodeManifest = (
  manifest: ByokGameCodeManifest
): string => JSON.stringify(manifest, null, 2);

/**
 * Parse a manifest, or report why it is unusable.
 *
 * Every field is checked: the manifest is a file on disk that a user (or a
 * crashed write) can leave malformed, and a permissive parse is how a stale
 * entry would end up re-registering a resource that no longer exists.
 */
export const parseByokGameCodeManifest = (
  text: string
):
  | {| ok: true, manifest: ByokGameCodeManifest |}
  | {| ok: false, error: string |} => {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: 'The game code manifest is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'The game code manifest is not an object.' };
  }
  if (parsed.version !== BYOK_GAME_CODE_MANIFEST_VERSION) {
    return {
      ok: false,
      error: `The game code manifest has version ${
        parsed.version === undefined ? 'none' : parsed.version
      } (expected ${BYOK_GAME_CODE_MANIFEST_VERSION}).`,
    };
  }
  if (!Array.isArray(parsed.entries)) {
    return { ok: false, error: 'The game code manifest has no entries list.' };
  }

  const entries = [];
  for (const rawEntry of parsed.entries) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      return {
        ok: false,
        error: 'A game code manifest entry is not an object.',
      };
    }
    if (typeof rawEntry.relativePath !== 'string' || !rawEntry.relativePath) {
      return {
        ok: false,
        error: 'A game code manifest entry has no relative path.',
      };
    }
    entries.push({
      relativePath: rawEntry.relativePath,
      resourceName:
        typeof rawEntry.resourceName === 'string' ? rawEntry.resourceName : '',
      sizeBytes:
        typeof rawEntry.sizeBytes === 'number' ? rawEntry.sizeBytes : 0,
      contentHash:
        typeof rawEntry.contentHash === 'number' ? rawEntry.contentHash : 0,
      exportedScriptName:
        typeof rawEntry.exportedScriptName === 'string'
          ? rawEntry.exportedScriptName
          : null,
    });
  }

  return {
    ok: true,
    manifest: makeByokGameCodeManifest({
      folderName:
        typeof parsed.folderName === 'string' ? parsed.folderName : '',
      carrierExtensionName:
        typeof parsed.carrierExtensionName === 'string'
          ? parsed.carrierExtensionName
          : BYOK_GAME_CODE_CARRIER_EXTENSION_NAME,
      entries,
    }),
  };
};

/**
 * Parse, degrading to a FRESH manifest. Used on the read path, where a
 * broken manifest must not stop the feature: the next write rebuilds it.
 */
export const parseByokGameCodeManifestOrEmpty = (
  text: string,
  folderName: string
): ByokGameCodeManifest => {
  const parsed = parseByokGameCodeManifest(text || '');
  if (!parsed.ok) return makeByokGameCodeManifest({ folderName });
  return parsed.manifest;
};
