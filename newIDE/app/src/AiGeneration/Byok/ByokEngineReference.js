// @flow
import {
  registerByokKnowledgeSection,
  estimateByokTokens,
} from './Knowledge/ByokKnowledgeSections';
import { searchByokEventScriptExamples } from './ByokEventScriptExamples';

/**
 * The engine reference (Phase 7.2): every object, behavior, action,
 * condition, expression and effect of the engine, generated from the
 * extension-declaration sources by `scripts/generate-byok-engine-reference.js`
 * into `Byok/docs/engine-reference.json`. The agent queries it with the
 * `search_reference` tool instead of carrying the catalog in its prompt.
 */

export type ByokEngineReferenceEntry = {|
  kind: string,
  owner: string,
  name: string,
  description: string,
  parameters: Array<{| type: string, description: string |}>,
|};

/** How many search results one tool call may return. */
export const BYOK_ENGINE_REFERENCE_SEARCH_RESULT_CAP = 40;

/** The result kinds accepted by the search (and advertised in the schema). */
export const BYOK_ENGINE_REFERENCE_KINDS: Array<string> = [
  'object',
  'behavior',
  'action',
  'condition',
  'expression',
  'effect',
];

// The catalog is loaded lazily, once, and defensively: a missing or invalid
// file (an install without the generated asset) degrades to "unavailable"
// instead of crashing the chat. The loader is replaceable for tests.
let catalogCache: ?Array<ByokEngineReferenceEntry> = null;
let catalogLoadAttempted = false;
let catalogLoaderForTests: ?() => mixed = null;

const isCatalogEntry = (value: mixed): boolean => {
  if (!value || typeof value !== 'object') return false;
  const entry: Object = value;
  return (
    typeof entry.kind === 'string' &&
    typeof entry.owner === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.description === 'string'
  );
};

/** Replace the catalog source (tests). Pass null to restore the default. */
export const setByokEngineReferenceLoaderForTests = (
  loader: ?() => mixed
): void => {
  catalogLoaderForTests = loader;
  catalogCache = null;
  catalogLoadAttempted = false;
};

const loadCatalog = (): ?Array<ByokEngineReferenceEntry> => {
  if (catalogLoadAttempted) return catalogCache;
  catalogLoadAttempted = true;
  try {
    const loader =
      catalogLoaderForTests || (() => require('./docs/engine-reference.json'));
    const data = loader();
    if (Array.isArray(data)) {
      // Cast through any: the loader returns mixed wire data, and Flow
      // cannot see that isCatalogEntry narrows the elements.
      catalogCache = (data.filter(value => isCatalogEntry(value)): any).slice();
    }
  } catch (error) {
    console.error('Unable to load the BYOK engine reference:', error);
    catalogCache = null;
  }
  return catalogCache;
};

/** True once the generated catalog could be loaded (drives a prompt flag). */
export const isByokEngineReferenceAvailable = (): boolean =>
  loadCatalog() !== null;

/**
 * The raw catalog entries (the RAG corpus reads them, Phase 13.7); empty
 * when the catalog could not be loaded.
 */
export const getByokEngineReferenceEntries = (): Array<ByokEngineReferenceEntry> =>
  loadCatalog() || [];

export type ByokEngineReferenceSearch = {|
  // False when the catalog could not be loaded at all.
  available: boolean,
  entries: Array<ByokEngineReferenceEntry>,
  totalMatches: number,
  truncated: boolean,
  // The steering line shown to the model when results were truncated.
  steeringLine: string | null,
|};

/**
 * Search the catalog: name prefix matches first, then name substrings, then
 * description (and owner) substrings — plain scoring, no dependencies, no
 * embeddings (the corpus is a few thousand short entries). With an empty
 * query, every entry of the requested kind/owner is listed (up to the cap),
 * which answers "what behaviors exist?" style questions.
 */
export const searchByokEngineReference = (options: {|
  query: string,
  kind?: string,
  owner?: string,
  limit?: number,
|}): ByokEngineReferenceSearch => {
  const catalog = loadCatalog();
  if (!catalog) {
    return {
      available: false,
      entries: [],
      totalMatches: 0,
      truncated: false,
      steeringLine: null,
    };
  }

  const limit = options.limit || BYOK_ENGINE_REFERENCE_SEARCH_RESULT_CAP;
  const query = options.query.trim().toLowerCase();
  const wantedKind = options.kind ? options.kind.toLowerCase() : null;
  const wantedOwner = options.owner ? options.owner.toLowerCase() : null;

  // The curated EventScript example bank (13.6) rides along as pseudo
  // entries: a query about a construct ("timer", "collision", "spawn")
  // returns the runnable example among the reference results, ready to
  // copy into add_scene_events.
  const exampleEntries: Array<ByokEngineReferenceEntry> = searchByokEventScriptExamples(
    query
  ).map(example => ({
    kind: 'example',
    owner: 'eventscript',
    name: example.id,
    description: `EventScript example — ${
      example.name
    } [tags: ${example.tags.join(', ')}]. Source:\n${example.source}`,
    parameters: [],
  }));

  const scored: Array<{|
    entry: ByokEngineReferenceEntry,
    score: number,
  |}> = [];
  const exampleIds = new Set(exampleEntries.map(entry => entry.name));
  for (const entry of [...exampleEntries, ...catalog]) {
    if (wantedKind && entry.kind.toLowerCase() !== wantedKind) continue;
    const owner = entry.owner.toLowerCase();
    if (wantedOwner && !owner.includes(wantedOwner)) continue;

    const name = entry.name.toLowerCase();
    const description = entry.description.toLowerCase();
    let score = 0;
    if (query) {
      if (name.startsWith(query)) score = 100;
      else if (name.includes(query)) score = 60;
      else if (description.includes(query)) score = 20;
      else if (owner.includes(query)) score = 10;
      else continue;
    } else if (exampleIds.has(entry.name)) {
      // An empty query lists a kind/owner — examples only appear when
      // explicitly asked for (kind: "example").
      if (wantedKind !== 'example') continue;
    }
    // The runnable examples outrank plain catalog entries at equal score:
    // they are what a struggling model needs first.
    const rankBoost = exampleIds.has(entry.name) ? 5 : 0;
    scored.push({ entry, score: score + rankBoost });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.entry.name.localeCompare(b.entry.name);
  });

  const totalMatches = scored.length;
  const entries = scored.slice(0, limit).map(scoredEntry => scoredEntry.entry);
  const truncated = totalMatches > entries.length;
  return {
    available: true,
    entries,
    totalMatches,
    truncated,
    steeringLine: truncated
      ? `Showing ${
          entries.length
        } of ${totalMatches} matches — narrow your query (or filter by kind/owner) to see more.`
      : null,
  };
};

// --- The always-on engine cheat-sheet --------------------------------------

const ENGINE_CHEAT_SHEET_BODY = `- Event anatomy: an event is conditions + actions; conditions filter the picked objects, actions apply to the picked ones. Once a condition without "once" is false, the actions do not run that frame.
- Object picking: conditions like "Player collides with Enemy" pick the Enemy instances in collision; a following action (Delete(Enemy)) applies to the picked instances only, unless you use "for each Enemy" or take a different object.
- TimeDelta() is the time in seconds since the last frame: multiply every movement/acceleration by TimeDelta() so the speed is frame-rate independent. Position += 250 * TimeDelta() means 250 pixels per second.
- Expressions are functions usable in any number/field: compute with them, never in your head. The most used (search_reference has them all, with parameters):
  lerp(a, b, t), clamp(value, min, max), min(a, b), max(a, b), abs(n), ceil(n), floor(n), round(n),
  sqrt(n), pow(base, exp), log(n), exp(n), sin(angle), cos(angle), tan(angle), atan2(y, x),
  Random(max), RandomInRange(min, max), RandomFloatInRange(min, max), RandomWithStep(min, max, step),
  DistanceBetweenPositions(x1, y1, x2, y2), AngleBetweenPositions(x1, y1, x2, y2),
  AngleDifference(a, b), XFromAngleAndDistance(x, angle, distance), YFromAngleAndDistance(y, angle, distance),
  TimeDelta(), SceneWindowWidth(), SceneWindowHeight(), MouseX(), MouseY(), ToDeg(rad), ToRad(deg).`;

/**
 * Register the engine cheat-sheet: the tiny, high-signal core (event
 * anatomy, picking, TimeDelta, the top expressions). Degradable since the
 * Phase 13.5 retrieval map — under budget pressure it collapses to its
 * first line, and the map's "search_reference" pointer carries the role;
 * the full catalog was always behind `search_reference` (progressive
 * disclosure).
 */
registerByokKnowledgeSection({
  id: 'engine-cheat-sheet',
  title: 'Engine cheat-sheet',
  priority: 120,
  budgetTokens: estimateByokTokens(
    `Engine cheat-sheet:\n${ENGINE_CHEAT_SHEET_BODY}`
  ),
  degradable: true,
  build: context => {
    const referenceLine = context.engineReferenceAvailable
      ? 'For anything else (every object, behavior, action, condition, expression and effect of the engine, with their exact parameter names), call the search_reference tool.'
      : 'The engine reference is not available in this environment: rely on the project snapshot and read tools to discover what exists.';
    return `Engine cheat-sheet:\n${ENGINE_CHEAT_SHEET_BODY}\n${referenceLine}`;
  },
});
