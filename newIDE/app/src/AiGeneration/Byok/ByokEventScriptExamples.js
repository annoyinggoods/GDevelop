// @flow

/**
 * The curated EventScript example bank (Phase 13.6): runnable, tagged
 * examples generated into `docs/eventscript-examples.json` by
 * `scripts/generate-byok-eventscript-examples.js`. Two consumers:
 * - `search_reference` merges the examples into its results (the model gets
 *   a source it can copy verbatim into add_scene_events);
 * - the local event writer attaches the example most relevant to a rejected
 *   batch as a `retryHint` (the error class → example map lives here).
 */

/** One curated example of the bank. */
export type ByokEventScriptExample = {|
  id: string,
  name: string,
  tags: Array<string>,
  source: string,
|};

/** The retryHint of a rejected event batch: the example to copy. */
export type ByokEventScriptRetryHint = {|
  exampleId: string,
  exampleName: string,
  source: string,
|};

let cachedExamples: Array<ByokEventScriptExample> | null = null;

const isValidExample = (entry: any): boolean =>
  !!entry &&
  typeof entry === 'object' &&
  typeof entry.id === 'string' &&
  !!entry.id &&
  typeof entry.name === 'string' &&
  typeof entry.source === 'string' &&
  Array.isArray(entry.tags);

/**
 * The bank, loaded lazily and defensively (the JSON is generated content —
 * a corrupted or missing file degrades to "no examples", never a crash).
 */
export const getByokEventScriptExamples = (): Array<ByokEventScriptExample> => {
  if (cachedExamples) return cachedExamples;
  const examples: Array<ByokEventScriptExample> = [];
  try {
    // $FlowFixMe[unsupported-syntax]
    const raw = require('./docs/eventscript-examples.json');
    if (raw && Array.isArray(raw.examples)) {
      for (const entry of raw.examples) {
        if (isValidExample(entry)) {
          examples.push({
            id: entry.id,
            name: entry.name,
            source: entry.source,
            tags: entry.tags.filter(
              (tag: any) => typeof tag === 'string' && !!tag
            ),
          });
        }
      }
    }
  } catch (error) {
    // No bank in this environment: the callers degrade gracefully.
  }
  cachedExamples = examples;
  return examples;
};

/** True when the example bank could be loaded. */
export const isByokEventScriptExamplesAvailable = (): boolean =>
  getByokEventScriptExamples().length > 0;

/** The example of this id, or null. */
export const findByNameokEventScriptExample = (
  id: string
): ?ByokEventScriptExample =>
  getByokEventScriptExamples().find(example => example.id === id) || null;

/**
 * Search the bank: tag hits and name/word matches score, exact id wins.
 * Used by the engine-reference merge (so search_reference returns the
 * examples among its entries).
 */
export const searchByokEventScriptExamples = (
  query: string
): Array<ByokEventScriptExample> => {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) return [];
  const terms = trimmedQuery.split(/\s+/).filter(term => !!term);
  const scored: Array<{|
    example: ByokEventScriptExample,
    score: number,
  |}> = [];
  for (const example of getByokEventScriptExamples()) {
    const haystack = `${example.id} ${example.name} ${example.tags.join(
      ' '
    )}`.toLowerCase();
    let score = 0;
    if (example.id === trimmedQuery) score += 1000;
    let matchedTerms = 0;
    for (const term of terms) {
      if (haystack.includes(term)) matchedTerms++;
    }
    score += matchedTerms * 20;
    if (terms.length > 1 && matchedTerms === terms.length) score += 30;
    if (score > 0) scored.push({ example, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || (a.example.id < b.example.id ? -1 : 1)
  );
  return scored.map(entry => entry.example);
};

/**
 * The error class → example id map of the writer's retryHint (13.6): given
 * a rejection message (and the offending line when the parser gave one),
 * pick the example whose construct the failing script was reaching for —
 * the model gets a targeted, complete, runnable correction instead of the
 * bare syntax complaint.
 */
export const pickByokEventScriptRetryHintId = (
  message: string,
  offendingLine: string
): ?string => {
  const text = `${message}\n${offendingLine}`.toLowerCase();
  const has = (needle: string): boolean => text.includes(needle);
  // Ordered: the more specific constructs first.
  if (has('scene(') || has('change the scene') || has('another scene')) {
    return 'scene-switch';
  }
  if (has('timer') || has('resettimer')) return 'timer-spawn';
  if (has('foreach') || has('for each')) return 'for-each-enemy';
  if (has('repeat') || has('while ') || has('group ')) {
    return 'loops-groups-waves';
  }
  if (has('child') || has('structure')) return 'structure-children';
  if (
    has('animationspeedscale') ||
    has('changeanimation') ||
    has('animation')
  ) {
    return 'animation-speed-boost';
  }
  if (has('collision') || has('variable') || has('score')) {
    return 'collision-counter';
  }
  if (has('create(') || has('spawn')) return 'timer-spawn';
  if (has('keypressed') || has('playsound')) return 'trigger-once-shooting';
  if (has('comment') || has('link ') || has('disabled')) {
    return 'comments-anchors-disabled';
  }
  if (has('timedelta') || has('setx')) return 'movement-and-collision';
  if (has('else')) return 'else-chain';
  // The default correction: the most canonical complete example.
  return 'collision-counter';
};

/** The full retryHint of a rejection, or null when the bank is unavailable. */
export const makeByokEventScriptRetryHint = (
  message: string,
  offendingLine: string
): ?ByokEventScriptRetryHint => {
  const exampleId = pickByokEventScriptRetryHintId(message, offendingLine);
  if (!exampleId) return null;
  const example = findByNameokEventScriptExample(exampleId);
  if (!example) return null;
  return {
    exampleId: example.id,
    exampleName: example.name,
    source: example.source,
  };
};
