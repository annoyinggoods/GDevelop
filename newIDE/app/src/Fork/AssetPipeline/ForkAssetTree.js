// @flow

/**
 * Phase 17.1 — the virtual tag tree (D17-3/D17-4).
 *
 * A PURE builder over plain entries: root -> tag folders -> assets, where
 * an asset appears under EVERY tag it carries (many-to-many) and untagged
 * assets land in a dedicated bucket so nothing is unreachable. Folders are
 * alphabetical with the "Untagged" bucket last, assets alphabetical inside
 * their folder — DISPLAY order only: tags are cosmetic and never influence
 * load order, resource names or export naming (the opposite of the
 * game-code folder tree, whose paths are behavior-bearing).
 */

import { normalizeForkAssetTag } from './ForkAssetTags';

/** The pseudo-folder holding assets without tags (kept reachable). */
export const FORK_ASSET_UNTAGGED_BUCKET_NAME = 'Untagged';

export type ForkAssetTreeEntry = {|
  +name: string,
  +tags: $ReadOnlyArray<string>,
|};

export type ForkAssetTreeAssetItem = {|
  +kind: 'asset',
  /** The resource name (unique per project, case-sensitive). */
  +name: string,
|};

export type ForkAssetTreeTagItem = {|
  +kind: 'tag',
  /** The canonical tag, or the Untagged pseudo-tag. */
  +tagName: string,
  +name: string,
  +children: Array<ForkAssetTreeAssetItem>,
|};

export type ForkAssetTreeItem = ForkAssetTreeTagItem | ForkAssetTreeAssetItem;

const compareAssetNames = (left: string, right: string): number => {
  const lowerLeft = left.toLowerCase();
  const lowerRight = right.toLowerCase();
  if (lowerLeft < lowerRight) return -1;
  if (lowerRight < lowerLeft) return 1;
  return 0;
};

const compareTagItems = (
  left: ForkAssetTreeTagItem,
  right: ForkAssetTreeTagItem
): number => {
  // The Untagged bucket is deliberately LAST, so it never competes with a
  // real tag for the alphabetical position.
  const leftIsUntagged = left.tagName === '';
  const rightIsUntagged = right.tagName === '';
  if (leftIsUntagged !== rightIsUntagged) return leftIsUntagged ? 1 : -1;
  return compareAssetNames(left.name, right.name);
};

/**
 * Build the virtual tree. `tagOf` overrides how an entry's tags are read
 * (defaults to the entry's own `tags`); a stored tag that fails
 * normalization is skipped rather than crashing the tree.
 */
export const buildForkAssetTree = (options: {|
  resources: $ReadOnlyArray<ForkAssetTreeEntry>,
  tagOf?: (entry: ForkAssetTreeEntry) => $ReadOnlyArray<string>,
|}): Array<ForkAssetTreeTagItem> => {
  const { resources } = options;
  const tagOf = options.tagOf || ((entry: ForkAssetTreeEntry) => entry.tags);

  const assetNamesByTag: Map<string, Array<string>> = new Map<
    string,
    Array<string>
  >();
  const untaggedAssetNames: Array<string> = [];
  const seenAssetNames: Set<string> = new Set<string>();

  for (const entry of resources) {
    // Resource names are unique and case-sensitive: "Hero.png" and
    // "hero.png" are two distinct assets. A duplicated input entry is
    // ignored (the first one wins).
    if (seenAssetNames.has(entry.name)) continue;
    seenAssetNames.add(entry.name);

    const normalizedTags = normalizeStoredTags(tagOf(entry));
    if (normalizedTags.length === 0) {
      untaggedAssetNames.push(entry.name);
      continue;
    }
    for (const tag of normalizedTags) {
      const existing = assetNamesByTag.get(tag) || [];
      existing.push(entry.name);
      assetNamesByTag.set(tag, existing);
    }
  }

  const tagItems: Array<ForkAssetTreeTagItem> = Array.from(
    assetNamesByTag.entries()
  ).map(([tagName, assetNames]) => ({
    kind: 'tag',
    tagName,
    name: tagName,
    children: assetNames
      .sort(compareAssetNames)
      .map(assetName => ({ kind: 'asset', name: assetName })),
  }));
  if (untaggedAssetNames.length > 0) {
    tagItems.push({
      kind: 'tag',
      // The empty string is the internal marker for the pseudo-tag; the
      // display name carries the bucket label.
      tagName: '',
      name: FORK_ASSET_UNTAGGED_BUCKET_NAME,
      children: untaggedAssetNames
        .sort(compareAssetNames)
        .map(assetName => ({ kind: 'asset', name: assetName })),
    });
  }

  return tagItems.sort(compareTagItems);
};

/** Tags of one entry, canonically normalized, invalid ones skipped. */
const normalizeStoredTags = (tags: $ReadOnlyArray<string>): Array<string> => {
  const normalized: Array<string> = [];
  for (const tag of tags) {
    const result = normalizeForkAssetTag(tag);
    if (result.ok) normalized.push(result.tag);
  }
  return normalized;
};
