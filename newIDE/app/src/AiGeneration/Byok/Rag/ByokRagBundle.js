// @flow
import {
  BYOK_RAG_BUNDLE_FORMAT_VERSION,
  BYOK_RAG_BUNDLE_KIND,
  BYOK_RAG_BUNDLE_REPO,
  BYOK_RAG_BUNDLE_SNAPSHOT_SUFFIX,
  BYOK_RAG_BUNDLE_TAG_PREFIX,
  BYOK_RAG_EMBEDDERS,
  type ByokRagBundleManifest,
} from './ByokRagTypes';

/**
 * The prebuilt-bundle validation (Phase 14.4, D14-3): everything pure that
 * stands between a downloaded release asset and the imported index. The
 * envelope must be structurally valid, the embedder must be one this app
 * knows (dimensions checked against the catalog), and the corpus the
 * vectors were built over must be the corpus this app ships — a mismatch
 * is REFUSED with an offer to rebuild locally, never silently served
 * (stale vectors would retrieve wrong chunks). The sha256 of the index
 * payload is verified by the Electron main (node crypto) before the
 * renderer ever sees the bundle.
 */

/** The outcome of validating a raw (parsed) bundle envelope. */
export type ByokRagBundleValidation =
  | {| ok: true, bundle: ByokRagBundleManifest |}
  | {| ok: false, error: string |};

/** Structural validation of the envelope (untrusted downloaded data). */
export const validateByokRagBundleEnvelope = (
  raw: any
): ByokRagBundleValidation => {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'The bundle is not a JSON object.' };
  }
  if (raw.bundle !== BYOK_RAG_BUNDLE_KIND) {
    return {
      ok: false,
      error: `Not a ${BYOK_RAG_BUNDLE_KIND} file (found "${String(
        raw.bundle
      )}").`,
    };
  }
  if (raw.formatVersion !== BYOK_RAG_BUNDLE_FORMAT_VERSION) {
    return {
      ok: false,
      error: `The bundle format version ${
        raw.formatVersion
      } is not supported (this app reads ${BYOK_RAG_BUNDLE_FORMAT_VERSION}) — update the app or pick another release.`,
    };
  }
  const embedder = raw.embedder;
  if (
    !embedder ||
    typeof embedder.id !== 'string' ||
    typeof embedder.dimensions !== 'number' ||
    typeof embedder.dtype !== 'string'
  ) {
    return {
      ok: false,
      error: 'The bundle manifest is missing the embedder identity.',
    };
  }
  const catalogEntry = BYOK_RAG_EMBEDDERS.find(
    entry => entry.id === embedder.id
  );
  if (!catalogEntry) {
    return {
      ok: false,
      error: `The bundle was built with the unknown embedder "${
        embedder.id
      }" — rebuild the index locally instead.`,
    };
  }
  if (catalogEntry.dimensions !== embedder.dimensions) {
    return {
      ok: false,
      error: `The bundle embedder declares ${
        embedder.dimensions
      } dimensions, the catalog says ${
        catalogEntry.dimensions
      } — rebuild locally.`,
    };
  }
  const integrity = raw.integrity;
  if (
    !integrity ||
    typeof integrity.indexSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(integrity.indexSha256)
  ) {
    return {
      ok: false,
      error: 'The bundle integrity hash is missing or malformed.',
    };
  }
  if (!raw.index || typeof raw.index !== 'object' || !raw.index.manifest) {
    return {
      ok: false,
      error: 'The bundle carries no index payload.',
    };
  }
  return { ok: true, bundle: raw };
};

/**
 * The compatibility of a valid bundle with THIS app installation: the
 * chosen embedder must match (the query side embeds with it), and the
 * bundle's corpus hash must equal the hash of the corpus this app would
 * build (a mismatch means the bundled docs/engine data is stale — rebuild
 * locally, D14-3).
 */
export const checkByokRagBundleCompatibility = (
  bundle: ByokRagBundleManifest,
  expectations: {|
    embedderId: string,
    corpusHash: string,
  |}
): ByokRagBundleValidation => {
  if (bundle.embedder.id !== expectations.embedderId) {
    return {
      ok: false,
      error: `The bundle was built with the embedder "${
        bundle.embedder.id
      }", but this setup uses "${
        expectations.embedderId
      }" — switch the embedder in the picker and download again, or rebuild locally.`,
    };
  }
  if (bundle.index.manifest.corpusHash !== expectations.corpusHash) {
    return {
      ok: false,
      error:
        'The bundled corpus is older than this app version (docs or engine data changed) — rebuild the index locally.',
    };
  }
  return { ok: true, bundle };
};

/** One asset of a GitHub release, as the RAG tab needs it. */
export type ByokRagBundleAsset = {|
  name: string,
  sizeBytes: number,
  downloadUrl: string,
|};

/** The GitHub releases API URL of the bundle repo (owner Task 17.2). */
export const makeByokRagBundleReleasesApiUrl = (): string =>
  `https://api.github.com/repos/${BYOK_RAG_BUNDLE_REPO}/releases?per_page=30`;

/** One bundle release, distilled from the GitHub API response. */
export type ByokRagBundleReleaseInfo = {|
  tag: string,
  indexAsset: ?ByokRagBundleAsset,
  snapshotAsset: ?ByokRagBundleAsset,
|};

/**
 * Pick the bundle release and its assets from GitHub releases (untrusted
 * API data): the newest release whose tag carries the bundle prefix; its
 * index asset is the `byok-rag-bundle-*.json` file, the snapshot asset the
 * Qdrant variant. Returns null when no bundle release exists.
 */
export const parseByokRagBundleReleaseInfo = (
  releases: any
): ?ByokRagBundleReleaseInfo => {
  if (!Array.isArray(releases)) return null;
  const bundleReleases = releases
    .filter(
      release =>
        release &&
        typeof release.tag_name === 'string' &&
        release.tag_name.startsWith(BYOK_RAG_BUNDLE_TAG_PREFIX) &&
        !release.draft
    )
    // Numeric-aware tag ordering (audit011026 B-RAG-8): lexicographic
    // order would rank "...-v9" above "...-v10" forever.
    .sort((a, b) => {
      const numericSuffix = (tag: string): number => {
        const match = tag.match(/(\d+)$/);
        return match ? parseInt(match[1], 10) : -1;
      };
      const numericDifference =
        numericSuffix(String(b.tag_name)) - numericSuffix(String(a.tag_name));
      if (numericDifference !== 0) return numericDifference;
      return String(b.tag_name).localeCompare(String(a.tag_name));
    });
  const newest = bundleReleases[0];
  if (!newest || !Array.isArray(newest.assets)) return null;
  const assets: Array<ByokRagBundleAsset> = newest.assets
    .filter(
      (asset: any) =>
        asset &&
        typeof asset.name === 'string' &&
        typeof asset.browser_download_url === 'string'
    )
    .map((asset: any) => ({
      name: asset.name,
      sizeBytes: typeof asset.size === 'number' ? asset.size : 0,
      downloadUrl: asset.browser_download_url,
    }));
  const indexAsset =
    assets.find(
      asset =>
        asset.name.startsWith('byok-rag-bundle-') &&
        asset.name.endsWith('.json') &&
        !asset.name.includes(BYOK_RAG_BUNDLE_SNAPSHOT_SUFFIX)
    ) || null;
  const snapshotAsset =
    assets.find(asset =>
      asset.name.includes(BYOK_RAG_BUNDLE_SNAPSHOT_SUFFIX)
    ) || null;
  return { tag: newest.tag_name, indexAsset, snapshotAsset };
};
