// @flow

/**
 * Phase 17.2 — the tag writer (D17-2).
 *
 * The ONLY module that writes tags into the project model: it goes through
 * `resource.setMetadata` with the Step 17.1 pure read/write, and NEVER
 * touches the resource's file, kind or name.
 *
 * Flagging "project modified" is deliberately the CALLER's job, so the two
 * kinds of consumer stay one call away instead of dragging React or the
 * BYOK executor in here:
 * - UI callers call `UnsavedChangesContext.triggerUnsavedChanges()` when a
 *   result reports `didChangeMetadata`;
 * - the BYOK adapter sets `didModifyProject: true` the same way.
 */

import {
  normalizeForkAssetTag,
  parseForkAssetTags,
  serializeForkAssetTags,
  type ForkAssetTagRefusalReason,
} from './ForkAssetTags';

export type ForkResourceTagsRefusal = {|
  +input: string,
  +reason: ForkAssetTagRefusalReason,
|};

export type ForkResourceTagsResult = {|
  /** The canonical tags now stored on the resource. */
  +tags: Array<string>,
  /** The tags that were refused, with their reason (empty when all ok). */
  +refusedTags: Array<ForkResourceTagsRefusal>,
  /** Whether the metadata string actually changed (false = no-op write). */
  +didChangeMetadata: boolean,
|};

/** Read a resource's tags (empty for anything unreadable). */
export const getForkResourceTags = (resource: any): Array<string> => {
  if (!resource || typeof resource.getMetadata !== 'function') return [];
  return parseForkAssetTags(resource.getMetadata() || '');
};

/**
 * Set the full tag list of one resource. Every requested tag must survive
 * `normalizeForkAssetTag`; the refused ones are reported (never silently
 * dropped) and simply not written. Writing is metadata-only.
 */
export const setForkResourceTags = (options: {|
  +resource: any,
  +tags: $ReadOnlyArray<string>,
|}): ForkResourceTagsResult => {
  const { resource, tags } = options;

  const canonicalTags: Array<string> = [];
  const refusedTags: Array<ForkResourceTagsRefusal> = [];
  for (const input of tags) {
    const normalized = normalizeForkAssetTag(input);
    if (normalized.ok) {
      canonicalTags.push(normalized.tag);
      continue;
    }
    refusedTags.push({
      input: typeof input === 'string' ? input : String(input),
      reason: normalized.reason,
    });
  }

  // De-duplicate the canonical list, preserving order (a repeated tag in a
  // batch edit is a no-op, not an error).
  const uniqueTags: Array<string> = Array.from(new Set<string>(canonicalTags));

  const previousMetadata =
    resource && typeof resource.getMetadata === 'function'
      ? resource.getMetadata() || ''
      : '';
  const nextMetadata = serializeForkAssetTags(previousMetadata, uniqueTags);
  if (resource && typeof resource.setMetadata === 'function') {
    resource.setMetadata(nextMetadata);
  }

  const didChangeMetadata = nextMetadata !== previousMetadata;
  if (didChangeMetadata) notifyForkAssetTagChanges();

  return {
    tags: uniqueTags,
    refusedTags,
    didChangeMetadata,
  };
};

export type ForkResourceTagsBatchEdit = {|
  +resource: any,
  +tags: $ReadOnlyArray<string>,
|};

export type ForkResourceTagsBatchResult = {|
  +results: Array<ForkResourceTagsResult>,
  +didChangeAnyMetadata: boolean,
|};

// The tag-change notification: whoever writes tags through this store
// (the chip editor, the AI tools) publishes here, so the Assets view can
// re-render its tree without polling. Plain listeners, no React.
const tagChangeListeners: Set<() => void> = new Set();

export const subscribeForkAssetTagChanges = (
  listener: () => void
): (() => void) => {
  tagChangeListeners.add(listener);
  return () => {
    tagChangeListeners.delete(listener);
  };
};

const notifyForkAssetTagChanges = (): void => {
  tagChangeListeners.forEach(listener => listener());
};

/**
 * Apply a batch of tag edits to a project's resources. Each edit is
 * independent (one refusal does not block the others); the overall flag
 * tells the caller whether to flag the project modified.
 */
export const applyForkAssetTagsToProject = (
  project: any,
  edits: $ReadOnlyArray<ForkResourceTagsBatchEdit>
): ForkResourceTagsBatchResult => {
  const results = edits.map(edit => setForkResourceTags(edit));
  const didChangeAnyMetadata = results.some(result => result.didChangeMetadata);
  return { results, didChangeAnyMetadata };
};
