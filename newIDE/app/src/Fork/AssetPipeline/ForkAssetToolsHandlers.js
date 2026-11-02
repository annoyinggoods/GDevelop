// @flow

/**
 * Phase 17.7 — the feature-side handlers the BYOK tools delegate to
 * (`list_assets` / `set_asset_tags`, D17-10).
 *
 * Both are total: they answer with a value and never throw, so a tool
 * adapter can hand the result straight to the model. Tag membership is
 * the SAME canonical read the Step 17.1 tree uses, and the writes go
 * through the Step 17.2 store (metadata-only, refusals explicit, the
 * project-modified flagging left to the caller exactly as in the store).
 */

import { getForkResourceTags, setForkResourceTags } from './ForkAssetTagStore';
import { normalizeForkAssetTag } from './ForkAssetTags';
import { buildForkAssetCatalog } from './ForkAssetCatalog';

export type ForkPipelineAsset = {|
  +name: string,
  +kind: string,
  +file: string,
  +tags: Array<string>,
|};

export type ForkPipelineListResult =
  | {| ok: true, assets: Array<ForkPipelineAsset>, matchedCount: number |}
  | {| ok: false, error: string |};

/**
 * The project's assets, optionally filtered: `tag` keeps exactly the
 * assets whose tags include it (the same membership the Step 17.1 tree
 * groups by); `untaggedOnly` keeps the assets with zero tags; neither
 * returns everything. Sorted by name. Never throws.
 */
export const listForkPipelineAssets = (options: {|
  project: any,
  tag?: string,
  untaggedOnly?: boolean,
|}): ForkPipelineListResult => {
  const { project } = options;
  if (!project || typeof project.getResourcesManager !== 'function') {
    return { ok: false, error: 'No project is open.' };
  }
  try {
    const rawTag = typeof options.tag === 'string' ? options.tag : '';
    const tag = rawTag.trim() ? normalizeForkAssetTag(rawTag) : null;
    if (tag && !tag.ok) {
      return {
        ok: false,
        error: `The tag filter "${rawTag}" is not a valid tag.`,
      };
    }

    const catalog = buildForkAssetCatalog(project);
    const wantedTag = tag && tag.ok ? tag.tag : null;
    const matching = catalog
      .filter(entry => {
        if (options.untaggedOnly) return entry.tags.length === 0;
        if (!wantedTag) return true;
        return entry.tags.includes(wantedTag);
      })
      .sort((left, right) => {
        if (left.name < right.name) return -1;
        if (left.name > right.name) return 1;
        return 0;
      });

    return {
      ok: true,
      assets: matching.map(entry => ({
        name: entry.name,
        kind: entry.kind,
        file: entry.file,
        tags: entry.tags,
      })),
      matchedCount: matching.length,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Listing the assets failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};

export type ForkPipelineSetTagsResult =
  | {| ok: true, updated: Array<{| name: string, tags: Array<string> |}> |}
  | {|
      ok: false,
      error: string,
      invalidTags?: Array<string>,
      unknownAssets?: Array<string>,
    |};

/**
 * Set the tags of one or more assets, atomically: every tag must pass
 * `normalizeForkAssetTag` and every name must exist, or the WHOLE call is
 * refused (no partial write). `set` replaces, `merge` unions, `remove`
 * removes the given tags, `clear` empties whatever `tags` says. Writes go
 * through the Step 17.2 store (metadata-only). Never throws.
 */
export const setForkPipelineAssetTags = (options: {|
  project: any,
  assetNames: Array<string>,
  tags: Array<string>,
  mode: 'set' | 'merge' | 'remove' | 'clear',
|}): ForkPipelineSetTagsResult => {
  const { project } = options;
  if (!project || typeof project.getResourcesManager !== 'function') {
    return { ok: false, error: 'No project is open.' };
  }
  try {
    // Validate the tags first — the whole call is refused on any invalid
    // one, listing them all.
    const invalidTags: Array<string> = [];
    const canonicalTags: Array<string> = [];
    const inputTags = options.mode === 'clear' ? [] : options.tags || [];
    for (const inputTag of inputTags) {
      const normalized = normalizeForkAssetTag(inputTag);
      if (!normalized.ok) {
        invalidTags.push(
          typeof inputTag === 'string' ? inputTag : String(inputTag)
        );
        continue;
      }
      if (!canonicalTags.includes(normalized.tag)) {
        canonicalTags.push(normalized.tag);
      }
    }
    if (invalidTags.length > 0) {
      return {
        ok: false,
        error: `These tags are not valid (lowercase, no slashes, no control characters): ${invalidTags.join(
          ', '
        )}.`,
        invalidTags,
      };
    }

    // Then the asset names — same atomicity.
    const resourcesManager = project.getResourcesManager();
    const unknownAssets: Array<string> = [];
    for (const assetName of options.assetNames || []) {
      if (!resourcesManager.hasResource(assetName)) {
        unknownAssets.push(assetName);
      }
    }
    if (unknownAssets.length > 0) {
      return {
        ok: false,
        error: `These assets do not exist in the project: ${unknownAssets.join(
          ', '
        )}.`,
        unknownAssets,
      };
    }

    const updated: Array<{| name: string, tags: Array<string> |}> = [];
    for (const assetName of options.assetNames || []) {
      const resource = resourcesManager.getResource(assetName);
      const currentTags = getForkResourceTags(resource);
      let nextTags: Array<string>;
      if (options.mode === 'set') {
        nextTags = canonicalTags;
      } else if (options.mode === 'merge') {
        nextTags = currentTags.concat(
          canonicalTags.filter(tag => !currentTags.includes(tag))
        );
      } else if (options.mode === 'remove') {
        nextTags = currentTags.filter(tag => !canonicalTags.includes(tag));
      } else {
        nextTags = [];
      }
      setForkResourceTags({ resource, tags: nextTags });
      updated.push({ name: assetName, tags: getForkResourceTags(resource) });
    }

    return { ok: true, updated };
  } catch (error) {
    return {
      ok: false,
      error: `Setting the asset tags failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};
