// @flow
import { enumerateEffectsMetadata } from '../../EffectsList/EnumerateEffects';
import {
  listAllExamples,
  getExample,
} from '../../Utils/GDevelopServices/Example';
import {
  getPublicAsset,
  listAllPublicAssets,
  listAllResources,
} from '../../Utils/GDevelopServices/Asset';
import {
  addAssetToProject,
  getRequiredExtensionsFromAsset,
} from '../../AssetStore/InstallAsset';
import { createNewResource } from '../../ResourcesList/ResourceSource';
import { applyResourceDefaults } from '../../ResourcesList/ResourceUtils';
import type { ByokExtraTool, ByokExtraToolResult } from './ByokExtraTools';

/**
 * The catalog tools: the static effect-type catalog (Phase 11) and the
 * public online catalogs (Phase 12) — starter templates (the examples
 * catalog), the object asset store and the resource store. The online
 * catalogs are auth-free public endpoints fetched once per session and
 * searched locally (D12-4: a self-contained scorer, deterministic and
 * unit-testable, no web-worker dependency). Public/free content only
 * (D12-2): private packs and purchased items need Shop authorization and
 * are deliberately not reachable here.
 */

const makeFailure = (message: string): ByokExtraToolResult => ({
  output: { success: false, message },
  didModifyProject: false,
});

// ---------------------------------------------------------------------------
// Phase 12: the public catalog fetchers (injectable, cached per session).
// ---------------------------------------------------------------------------

/** The catalog slice each fetcher returns (trimmed to what the tools use). */
export type ByokCatalogFetchers = {|
  listAllExamples: () => Promise<Array<Object>>,
  getExample: (header: Object) => Promise<Object>,
  listAllPublicAssets: () => Promise<Array<Object>>,
  getPublicAsset: (header: Object) => Promise<Object>,
  listAllResources: () => Promise<Array<Object>>,
|};

const defaultFetchers: ByokCatalogFetchers = {
  listAllExamples: async () => {
    const { exampleShortHeaders } = await listAllExamples();
    return exampleShortHeaders;
  },
  getExample: async header => getExample(header),
  listAllPublicAssets: async () => {
    const { publicAssetShortHeaders } = await listAllPublicAssets({
      environment: 'live',
    });
    return publicAssetShortHeaders;
  },
  getPublicAsset: async header =>
    getPublicAsset(header, { environment: 'live' }),
  listAllResources: async () => {
    const { resources, resourcesV2 } = await listAllResources({
      environment: 'live',
    });
    return [...(resources || []), ...(resourcesV2 || [])];
  },
};

let catalogFetchers: ByokCatalogFetchers = defaultFetchers;
const catalogCaches: { [string]: Promise<Array<Object>> } = {};

/** Swap the fetchers and clear the caches (tests inject fakes here). */
export const setByokCatalogFetchersForTests = (
  fetchers: ByokCatalogFetchers | null
): void => {
  catalogFetchers = fetchers || defaultFetchers;
  for (const key of Object.keys(catalogCaches)) {
    delete catalogCaches[key];
  }
};

/** One catalog, fetched once per session (failures are not cached). */
const fetchByokCatalog = (
  name: $Keys<ByokCatalogFetchers>
): Promise<Array<Object>> => {
  if (!catalogCaches[name]) {
    catalogCaches[name] = catalogFetchers[name]().catch(error => {
      delete catalogCaches[name];
      throw error;
    });
  }
  return catalogCaches[name];
};

const makeOfflineFailure = (catalogName: string): ByokExtraToolResult =>
  makeFailure(
    `The ${catalogName} could not be fetched (offline, or the GDevelop asset API is unreachable). This tool needs the network — retry, or continue from your own knowledge and say so.`
  );

const readNetworkError = (error: mixed): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// The local scorer (D12-4): substring pertinence, the UseSearchItem
// philosophy without the js-worker-search dependency.
// ---------------------------------------------------------------------------

export const scoreByokCatalogEntry = (
  entry: {|
    name: string,
    shortDescription?: string,
    tags?: Array<string>,
  |},
  terms: Array<string>
): number => {
  const name = entry.name.toLowerCase();
  const shortDescription = (entry.shortDescription || '').toLowerCase();
  const tags = (entry.tags || []).map(tag => tag.toLowerCase());
  let score = 0;
  for (const rawTerm of terms) {
    const term = rawTerm.toLowerCase().trim();
    if (!term) continue;
    if (name.includes(term)) score += 3;
    if (tags.some(tag => tag.includes(term))) score += 2;
    if (shortDescription.includes(term)) score += 1;
  }
  return score;
};

export const splitByokSearchTerms = (searchText: string): Array<string> =>
  searchText
    .toLowerCase()
    .split(/[\s,]+/)
    .map(term => term.trim())
    .filter(Boolean);

/**
 * Rank a catalog by the search terms: every entry with a positive score,
 * best first, ties by name (deterministic output — same query, same order).
 */
export const rankByokCatalogEntries = (
  entries: Array<Object>,
  searchText: string
): Array<{| entry: Object, score: number |}> =>
  entries
    .map(entry => ({
      entry,
      score: scoreByokCatalogEntry(
        {
          name: typeof entry.name === 'string' ? entry.name : '',
          shortDescription:
            typeof entry.shortDescription === 'string'
              ? entry.shortDescription
              : '',
          tags: Array.isArray(entry.tags) ? entry.tags : [],
        },
        splitByokSearchTerms(searchText)
      ),
    }))
    .filter(ranked => ranked.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.entry.name).localeCompare(String(b.entry.name))
    );

// ---------------------------------------------------------------------------
// get_game_starter_summary (Phase 12, step 12.1).
// ---------------------------------------------------------------------------

const STARTER_LIST_CAP = 80;
const STARTER_DESCRIPTION_CAP = 1200;

const compactStarterHeader = (header: Object) => ({
  slug: header.slug,
  name: header.name,
  shortDescription: header.shortDescription,
  tags: header.tags,
  difficultyLevel: header.difficultyLevel,
  license: header.license,
});

const makeGetGameStarterSummaryTool = (): ByokExtraTool => ({
  name: 'get_game_starter_summary',
  modifiesProject: false,
  run: async (args): Promise<ByokExtraToolResult> => {
    let starters: Array<Object>;
    try {
      starters = await fetchByokCatalog('listAllExamples');
    } catch (error) {
      return makeOfflineFailure('examples catalog');
    }

    const slug =
      typeof args.template_slug === 'string' ? args.template_slug.trim() : '';
    if (slug) {
      const header =
        starters.find(
          candidate =>
            typeof candidate.slug === 'string' &&
            candidate.slug.toLowerCase() === slug.toLowerCase()
        ) || null;
      if (!header) {
        const nearMisses = rankByokCatalogEntries(starters, slug)
          .slice(0, 5)
          .map(ranked => ranked.entry.slug);
        return makeFailure(
          `No starter template with slug "${slug}". ${
            nearMisses.length > 0
              ? `Close slugs: ${nearMisses.join(', ')}.`
              : ''
          } Call get_game_starter_summary without a slug to list templates.`
        );
      }
      try {
        const example = await catalogFetchers.getExample(header);
        const description: string =
          typeof example.description === 'string' ? example.description : '';
        return {
          output: {
            success: true,
            starter: {
              ...compactStarterHeader(header),
              description:
                description.length > STARTER_DESCRIPTION_CAP
                  ? `${description.slice(0, STARTER_DESCRIPTION_CAP)}…`
                  : description,
              authors: example.authors,
            },
            note:
              'Pass this slug to initialize_project (template_slug) to create the project from this starter.',
          },
          didModifyProject: false,
        };
      } catch (error) {
        return makeFailure(
          `The details of "${slug}" could not be fetched: ${readNetworkError(
            error
          )}. The slug itself is valid — initialize_project can still use it.`
        );
      }
    }

    const search =
      typeof args.search === 'string' && args.search.trim()
        ? args.search.trim()
        : '';
    const ranked = search
      ? rankByokCatalogEntries(starters, search)
      : starters.map(entry => ({ entry, score: 1 }));
    const shown = ranked.slice(0, STARTER_LIST_CAP).map(ranked => ranked.entry);
    return {
      output: {
        success: true,
        total: starters.length,
        starters: shown.map(compactStarterHeader),
        truncated: starters.length > shown.length,
        note: search
          ? 'Ranked by pertinence to the search. Pick one and pass its slug to initialize_project (template_slug), or get the full summary of one with template_slug.'
          : `Showing up to ${STARTER_LIST_CAP} of ${
              starters.length
            } starter templates — pass search to narrow by genre/mechanic, or template_slug for one full summary. The chosen slug goes to initialize_project (template_slug).`,
      },
      didModifyProject: false,
    };
  },
});

// ---------------------------------------------------------------------------
// search_object_asset_store / search_resource_store (Phase 12, step 12.2).
// ---------------------------------------------------------------------------

const ASSET_RESULTS_CAP = 10;

const compactAssetHeader = (header: Object) => ({
  id: header.id,
  name: header.name,
  objectType: header.objectType,
  tags: header.tags,
  width: header.width,
  height: header.height,
  dominantColors: (header.dominantColors || []).slice(0, 3),
  previewImageUrls: (header.previewImageUrls || []).slice(0, 1),
  shortDescription: header.shortDescription,
});

const makeSearchObjectAssetStoreTool = (): ByokExtraTool => ({
  name: 'search_object_asset_store',
  modifiesProject: false,
  run: async (args): Promise<ByokExtraToolResult> => {
    const searchTerms =
      typeof args.search_terms === 'string' ? args.search_terms.trim() : '';
    if (!searchTerms) {
      return makeFailure('The "search_terms" to search for are required.');
    }
    let assets: Array<Object>;
    try {
      assets = await fetchByokCatalog('listAllPublicAssets');
    } catch (error) {
      return makeOfflineFailure('asset store catalog');
    }

    const objectTypeFilter =
      typeof args.object_type === 'string' && args.object_type
        ? args.object_type.toLowerCase()
        : null;
    const tagFilters = Array.isArray(args.tags)
      ? args.tags.map((tag: any) => String(tag).toLowerCase())
      : [];
    const candidates = assets.filter(header => {
      if (
        objectTypeFilter &&
        String(header.objectType || '').toLowerCase() !== objectTypeFilter
      ) {
        return false;
      }
      const headerTags = (header.tags || []).map((tag: any) =>
        String(tag).toLowerCase()
      );
      if (tagFilters.some(tag => !headerTags.includes(tag))) return false;
      return true;
    });

    const ranked = rankByokCatalogEntries(candidates, searchTerms).slice(
      0,
      ASSET_RESULTS_CAP
    );
    return {
      output: {
        success: true,
        results: ranked.map(ranked => compactAssetHeader(ranked.entry)),
        note:
          ranked.length === 0
            ? 'No public asset matched. Try other terms (e.g. "platform character", "explosion").'
            : 'Public/free assets only. To add one to the game, call create_or_replace_object with search_terms (it installs the best match automatically).',
      },
      didModifyProject: false,
    };
  },
});

const makeSearchResourceStoreTool = (): ByokExtraTool => ({
  name: 'search_resource_store',
  modifiesProject: false,
  run: async (args): Promise<ByokExtraToolResult> => {
    const searchTerms =
      typeof args.search_terms === 'string' ? args.search_terms.trim() : '';
    if (!searchTerms) {
      return makeFailure('The "search_terms" to search for are required.');
    }
    const kindFilter =
      args.resource_type === 'audio' || args.resource_type === 'font'
        ? args.resource_type
        : null;
    let resources: Array<Object>;
    try {
      resources = await fetchByokCatalog('listAllResources');
    } catch (error) {
      return makeOfflineFailure('resource store catalog');
    }

    const candidates = kindFilter
      ? resources.filter(resource => resource.type === kindFilter)
      : resources;
    const ranked = rankByokCatalogEntries(candidates, searchTerms).slice(
      0,
      ASSET_RESULTS_CAP
    );
    return {
      output: {
        success: true,
        results: ranked.map(ranked => ({
          name: ranked.entry.name,
          type: ranked.entry.type,
          url: ranked.entry.url,
          tags: ranked.entry.tags,
          license: ranked.entry.license,
        })),
        note:
          ranked.length === 0
            ? 'No public resource matched. Try other terms.'
            : 'Audio and font resources with a direct public url. Install one with import_project_resources (entries: [{source: url, kind}]).',
      },
      didModifyProject: false,
    };
  },
});

// ---------------------------------------------------------------------------
// The headless install collaborators the registry tools call (D12-3):
// create_or_replace_object's search path and the resource search path.
// ---------------------------------------------------------------------------

export type ByokAssetInstallCollaborators = {|
  project: any,
  ensureExtensionInstalled: (options: {|
    extensionName: string,
  |}) => Promise<void>,
|};

/**
 * The BYOK implementation of the registry's `searchAndInstallAsset`
 * dependency: local search over the public catalog → the best header →
 * `getPublicAsset` → required extensions ensured (the name-only hook) →
 * `addAssetToProject` (the exact install path of the asset store dialog).
 */
export const byokSearchAndInstallAsset = async (
  options: {|
    objectsContainer: any,
    objectName: string,
    objectType: string | null,
    searchTerms: string,
    +description?: string,
    +exactOrPartialAssetId?: string | null,
  |},
  collaborators: ByokAssetInstallCollaborators
): Promise<Object> => {
  const { project, ensureExtensionInstalled } = collaborators;
  let assets: Array<Object>;
  try {
    assets = await fetchByokCatalog('listAllPublicAssets');
  } catch (error) {
    return {
      status: 'error',
      message: `the asset store catalog could not be fetched (${readNetworkError(
        error
      )})`,
      createdObjects: [],
      assetShortHeader: null,
      isTheFirstOfItsTypeInProject: false,
    };
  }

  const header = options.exactOrPartialAssetId
    ? assets.find(
        asset =>
          typeof asset.id === 'string' &&
          asset.id.includes(options.exactOrPartialAssetId || '')
      ) || null
    : (() => {
        const objectTypeFiltered = options.objectType
          ? assets.filter(
              asset =>
                String(asset.objectType || '').toLowerCase() ===
                options.objectType?.toLowerCase()
            )
          : assets;
        const pool =
          objectTypeFiltered.length > 0 ? objectTypeFiltered : assets;
        const ranked = rankByokCatalogEntries(
          pool,
          options.searchTerms || options.objectName || ''
        );
        return ranked.length > 0 ? ranked[0].entry : null;
      })();
  if (!header) {
    return {
      status: 'nothing-found',
      message: `no public asset matched "${options.searchTerms}"`,
      createdObjects: [],
      assetShortHeader: null,
      isTheFirstOfItsTypeInProject: false,
    };
  }

  try {
    const asset = await catalogFetchers.getPublicAsset(header);
    for (const requiredExtension of getRequiredExtensionsFromAsset(asset)) {
      await ensureExtensionInstalled({
        extensionName: requiredExtension.extensionName,
      });
    }
    const output = await addAssetToProject({
      asset,
      project,
      objectsContainer: options.objectsContainer,
      requestedObjectName: options.objectName,
    });
    return {
      status: 'asset-installed',
      message: `asset "${header.name}" installed`,
      createdObjects: output.createdObjects,
      assetShortHeader: header,
      isTheFirstOfItsTypeInProject: false,
    };
  } catch (error) {
    return {
      status: 'error',
      message: `the asset "${
        header.name
      }" could not be installed (${readNetworkError(error)})`,
      createdObjects: [],
      assetShortHeader: header,
      isTheFirstOfItsTypeInProject: false,
    };
  }
};

/**
 * The BYOK implementation of the registry's `searchAndInstallResources`
 * dependency: search the public resource store, then register each hit by
 * its direct public URL — the resource-store convention
 * (`setFile(url)` + `setOrigin('gdevelop-asset-store', url)`, nothing is
 * downloaded; resources are fetched at preview/export like any URL
 * resource).
 */
type ByokResourceInstallEntryResult = {|
  resourceName: string,
  resourceKind: string,
  status:
    | 'resource-installed'
    | 'nothing-found'
    | 'resource-already-exists'
    | 'error',
  error?: string,
|};

export const byokSearchAndInstallResources = async (
  options: {|
    resources: Array<{| resourceName: string, resourceKind: string |}>,
  |},
  collaborators: {| project: any |}
): Promise<Object> => {
  const { project } = collaborators;
  const resourcesManager = project.getResourcesManager();
  let catalog: Array<Object>;
  try {
    catalog = await fetchByokCatalog('listAllResources');
  } catch (error) {
    return {
      results: options.resources.map(resource => ({
        resourceName: resource.resourceName,
        resourceKind: resource.resourceKind,
        status: 'error',
        error: `the resource store catalog could not be fetched (${readNetworkError(
          error
        )})`,
      })),
    };
  }

  const results: Array<ByokResourceInstallEntryResult> = [];
  for (const requested of options.resources) {
    if (resourcesManager.hasResource(requested.resourceName)) {
      results.push({
        resourceName: requested.resourceName,
        resourceKind: requested.resourceKind,
        status: 'resource-already-exists',
      });
      continue;
    }
    const ranked = rankByokCatalogEntries(
      catalog.filter(resource => resource.type === requested.resourceKind),
      requested.resourceName
    );
    const hit = ranked.length > 0 ? ranked[0].entry : null;
    if (!hit || typeof hit.url !== 'string' || !hit.url) {
      results.push({
        resourceName: requested.resourceName,
        resourceKind: requested.resourceKind,
        status: 'nothing-found',
      });
      continue;
    }
    const resource = createNewResource(requested.resourceKind);
    if (!resource) {
      results.push({
        resourceName: requested.resourceName,
        resourceKind: requested.resourceKind,
        status: 'error',
        error: `unknown resource kind "${requested.resourceKind}"`,
      });
      continue;
    }
    resource.setName(requested.resourceName);
    resource.setFile(hit.url);
    resource.setOrigin('gdevelop-asset-store', hit.url);
    applyResourceDefaults(project, resource);
    resourcesManager.addResource(resource);
    resource.delete();
    results.push({
      resourceName: requested.resourceName,
      resourceKind: requested.resourceKind,
      status: 'resource-installed',
    });
  }
  return { results };
};

/**
 * Compact one effect property of the PropertiesEditor schema: the editor's
 * Field carries accessors and UI concerns; the model needs the name, the
 * value type, the default and the visibility flags only.
 */
const compactEffectProperty = (field: Object): Object => ({
  name: field.name,
  type: field.valueType,
  defaultValue: field.defaultValue,
  description:
    typeof field.getDescription === 'function'
      ? field.getDescription()
      : undefined,
  choices:
    typeof field.getChoices === 'function' && field.getChoices()
      ? field.getChoices()
      : undefined,
  isAdvanced: field.visibility === 'advanced',
  isDeprecated: field.visibility === 'deprecated',
});

/**
 * Flatten the PropertiesEditor schema into plain properties: grouped
 * properties arrive wrapped in section fields (a `children` array) — a
 * UI concern the model does not need, so the children are merged in.
 */
export const flattenByokEffectProperties = (
  schema: Array<Object>
): Array<Object> => {
  const properties: Array<Object> = [];
  for (const field of schema) {
    if (field && Array.isArray(field.children)) {
      properties.push(...flattenByokEffectProperties(field.children));
      continue;
    }
    properties.push(compactEffectProperty(field));
  }
  return properties;
};

/**
 * Compact one enumerated effect: type (the string the change_*_effects
 * tools consume as effect_type), naming/description, the platform flags
 * and the property schemas with their defaults.
 */
export const compactEffectMetadata = (metadata: Object): Object => ({
  type: metadata.type,
  fullName: metadata.fullName,
  description: metadata.description,
  notWorkingForObjects: metadata.isMarkedAsNotWorkingForObjects,
  only2D: metadata.isMarkedAsOnlyWorkingFor2D,
  only3D: metadata.isMarkedAsOnlyWorkingFor3D,
  properties: flattenByokEffectProperties(metadata.parametersSchema),
});

/**
 * The effect-type filter of `list_effects`: `'2d'`/`'3d'` keep the effects
 * that can run on that kind of layer, `'object'` keeps the ones that can
 * be applied to objects. Anything else (including no filter) returns all.
 */
export const doesEffectMatchFilter = (
  metadata: Object,
  filter: string | null
): boolean => {
  if (filter === '2d') return !metadata.isMarkedAsOnlyWorkingFor3D;
  if (filter === '3d') return !metadata.isMarkedAsOnlyWorkingFor2D;
  if (filter === 'object') return !metadata.isMarkedAsNotWorkingForObjects;
  return true;
};

export const listByokEffects = (
  project: any,
  filter: string | null
): Array<Object> =>
  enumerateEffectsMetadata(project)
    .filter(metadata => doesEffectMatchFilter(metadata, filter))
    .map(compactEffectMetadata);

/**
 * How many effects one `list_effects` call returns. The unfiltered stock
 * catalog is at/over the tool-output cap, so the list is capped explicitly
 * with an honest total rather than cut mid-JSON by the generic cap
 * (audit100226 TOOL-4).
 */
export const BYOK_EFFECTS_LIST_CAP = 30;

const makeListEffectsTool = (): ByokExtraTool => ({
  name: 'list_effects',
  modifiesProject: false,
  run: async (args, collaborators): Promise<ByokExtraToolResult> => {
    const project = collaborators.getProject();
    if (!project) {
      return makeFailure('No project is open — open or create one first.');
    }
    const filter =
      typeof args.filter === 'string' && args.filter ? args.filter : null;
    const allEffects = listByokEffects(project, filter);
    // The full stock catalog (~46 effects with their property schemas)
    // serialized to ≈21-22k chars, at/over the 20k tool cap: the array was
    // cut mid-JSON and the usage note — which explains how to feed
    // changed_effects — was lost with it (audit100226 TOOL-4). Capped
    // explicitly, with an honest count so the model can narrow with
    // `filter` instead of guessing.
    const effects = allEffects.slice(0, BYOK_EFFECTS_LIST_CAP);
    const truncated = allEffects.length > effects.length;
    return {
      output: {
        success: true,
        effects,
        totalEffectCount: allEffects.length,
        truncated,
        ...(truncated
          ? {
              note: `Showing the first ${effects.length} of ${
                allEffects.length
              } effects. Pass a filter ("2d", "3d", "object") to narrow the list, or ask for a specific effect by name. These "type" strings and property defaults are what change_object_properties_effects and change_scene_properties_layers_effects_groups expect in changed_effects (effect_type + changed_properties property_name/new_value).`,
            }
          : {
              note:
                'These "type" strings and property defaults are what change_object_properties_effects and change_scene_properties_layers_effects_groups expect in changed_effects (effect_type + changed_properties property_name/new_value).',
            }),
      },
      didModifyProject: false,
    };
  },
});

/** The catalog tools (a fresh read, like ByokExtraTools). */
export const getByokCatalogTools = (): Array<ByokExtraTool> => [
  makeListEffectsTool(),
  makeGetGameStarterSummaryTool(),
  makeSearchObjectAssetStoreTool(),
  makeSearchResourceStoreTool(),
];
