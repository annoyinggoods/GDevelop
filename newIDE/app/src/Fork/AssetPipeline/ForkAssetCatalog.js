// @flow

/**
 * Phase 17.5 — the resource-name catalog (D17-6).
 *
 * The runtime resolves assets by RESOURCE NAME, never by file path
 * (GDJS ResourceLoader / sound tools / image manager), and the exported
 * game has no module system — so the clean authoring syntax the fork
 * teaches is name-based calls with Monaco completions, never ES `import`
 * or `@assets/` specifiers (both are explicitly out: Phase 17 §1.3/§5).
 *
 * This module builds, from the project, the authoritative
 * `{ name, kind, file, tags }` list (the SimplifiedProject mapping shape)
 * and renders two artifacts from it: a Monaco `addExtraLib` declaration
 * and a compact knowledge block for the AI.
 */

import { getForkResourceTags } from './ForkAssetTagStore';

export type ForkAssetCatalogEntry = {|
  +name: string,
  +kind: string,
  +file: string,
  +tags: Array<string>,
|};

/** A cap so a pathological project cannot flood the editor or the prompt. */
export const FORK_ASSET_KNOWLEDGE_MAX_ENTRIES = 120;

/**
 * The catalog of a project's resources, in the project's own order
 * (the resources-manager enumeration). Names are unique per project and
 * case-sensitive; tags are the canonical read-side form.
 */
export const buildForkAssetCatalog = (
  project: any
): Array<ForkAssetCatalogEntry> => {
  if (!project || typeof project.getResourcesManager !== 'function') {
    return [];
  }
  const resourcesManager = project.getResourcesManager();
  return resourcesManager
    .getAllResourceNames()
    .toJSArray()
    .map(resourceName => {
      const resource = resourcesManager.getResource(resourceName);
      return {
        name: resourceName,
        kind: typeof resource.getKind === 'function' ? resource.getKind() : '',
        file: typeof resource.getFile === 'function' ? resource.getFile() : '',
        tags: getForkResourceTags(resource),
      };
    });
};

/** The stable virtual file name of the fork asset declarations. */
export const FORK_ASSET_COMPLETION_FILE_PATH = 'fork-asset-catalog.d.ts';

export type ForkAssetCompletionEntry = {|
  +content: string,
  +filePath: string,
|};

/**
 * The declarations fed to `monaco.languages.typescript.javascriptDefaults
 * .addExtraLib(content, filePath)`: one `forkAssets` object whose QUOTED
 * property keys are the resource names (names with slashes, dots or spaces
 * stay valid), each documented with its kind and tags. Typing
 * `forkAssets.` (or the name inside a string being completed) surfaces the
 * names — name-based, never an import or a module specifier.
 */
export const buildForkAssetCompletionEntries = (
  catalog: $ReadOnlyArray<ForkAssetCatalogEntry>
): Array<ForkAssetCompletionEntry> => {
  const seenNames: Set<string> = new Set<string>();
  const lines: Array<string> = [];
  for (const entry of catalog) {
    // Defensive: a name that is not a plain printable string cannot be a
    // property key.
    if (typeof entry.name !== 'string' || !entry.name.trim()) continue;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(entry.name)) continue;
    // Completion entries are deduped by name.
    if (seenNames.has(entry.name)) continue;
    seenNames.add(entry.name);
    const tagsPart =
      entry.tags.length > 0 ? ` — tags: ${entry.tags.join(', ')}` : '';
    lines.push(
      `  /** ${entry.kind}${tagsPart} */`,
      `  readonly ${JSON.stringify(entry.name)}: string;`
    );
  }

  const content = [
    '/**',
    ' * The assets of this project, addressed by RESOURCE NAME.',
    ' * Example (audio): gdjs.evtTools.sound.playSoundOnChannel(runtimeScene, forkAssets["player/jump"], 1, false, 100, 1)',
    ' * Names containing slashes are resource NAMES, not paths.',
    ' * Assets are never referenced with an ES import or a file path.',
    ' */',
    'declare const forkAssets: {',
    ...lines,
    '};',
    '',
  ].join('\n');

  return [{ content, filePath: FORK_ASSET_COMPLETION_FILE_PATH }];
};

const knowledgeLineForKind = (
  kind: string,
  entries: $ReadOnlyArray<ForkAssetCatalogEntry>
): string => {
  const names = entries.map(
    entry =>
      entry.name + (entry.tags.length > 0 ? ` (${entry.tags.join(', ')})` : '')
  );
  return `- ${kind}: ${names.join(', ')}`;
};

/**
 * A compact multi-line block of the available asset names for the AI:
 * grouped by kind, tags in parens, capped at a sane size with an honest
 * overflow line (the catalog itself stays complete — the cap is
 * presentation only).
 */
export const buildForkAssetKnowledgeBlock = (
  catalog: $ReadOnlyArray<ForkAssetCatalogEntry>
): string => {
  if (catalog.length === 0) {
    return 'No resources are registered in this project yet.';
  }

  const byKind: Map<string, Array<ForkAssetCatalogEntry>> = new Map();
  for (const entry of catalog) {
    const kind = entry.kind || 'unknown';
    const existing = byKind.get(kind) || [];
    existing.push(entry);
    byKind.set(kind, existing);
  }

  const lines: Array<string> = [
    'Assets (by resource NAME, never a file path):',
  ];
  let listed = 0;
  const kinds = Array.from(byKind.keys()).sort();
  for (const kind of kinds) {
    const entries = byKind.get(kind) || [];
    const remaining = FORK_ASSET_KNOWLEDGE_MAX_ENTRIES - listed;
    if (remaining <= 0) {
      lines.push(
        `… and ${catalog.length - listed} more (ask list_assets for the rest)`
      );
      break;
    }
    const capped = entries.slice(0, remaining);
    lines.push(knowledgeLineForKind(kind, capped));
    listed += capped.length;
  }
  if (listed < catalog.length) {
    lines.push(
      `… and ${catalog.length - listed} more (ask list_assets for the rest)`
    );
  }
  return lines.join('\n');
};

// The completion feed: the module the editor hook reads. Whoever has the
// project (the Assets view, the AI tools) registers the catalog here; the
// hook stays project-free, matching LocalCodeEditorAutocompletions (which
// receives only `monaco`).
let currentCompletionEntries: Array<ForkAssetCompletionEntry> = [];

export const setForkAssetCompletionCatalog = (
  catalog: $ReadOnlyArray<ForkAssetCatalogEntry>
): void => {
  currentCompletionEntries = buildForkAssetCompletionEntries(catalog);
};

export const clearForkAssetCompletionCatalog = (): void => {
  currentCompletionEntries = [];
};

export const getForkAssetCompletionEntries = (): Array<ForkAssetCompletionEntry> =>
  currentCompletionEntries;

/** Build from the project and register in one call (the view's refresh). */
export const updateForkAssetCompletionCatalogFromProject = (
  project: any
): void => {
  setForkAssetCompletionCatalog(buildForkAssetCatalog(project));
};
