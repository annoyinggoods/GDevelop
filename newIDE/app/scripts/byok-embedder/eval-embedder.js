/**
 * The embedder eval runner (Phase 14.5; the embedder-agnostic half of the
 * Phase 14.3 plan — the finetuned model itself is owner-deferred): scores
 * an embedder's retrieval quality Node-side, top-3 hit rate over the
 * shared 24-query set (`src/AiGeneration/Byok/evals/byok-rag-eval-queries.json`,
 * the same set the Jest gate uses) or an owner-provided query file
 * (`--queries <file.json>`, the Task 17.1 holdout shape:
 * `[{query, expectedSource, expectedHint?}]` — `docs-min` is a valid
 * expected source for wiki-targeted queries).
 *
 * The corpus, index build and search are the REAL app modules (loaded
 * through the app's own Babel config, never re-implemented), so the
 * numbers include the source-weighted hybrid ranking exactly as shipped.
 *
 * Usage (from `newIDE/app`):
 *   node scripts/byok-embedder/eval-embedder.js hashing
 *     (CI parity: the deterministic hashing test embedder, no downloads)
 *   node scripts/byok-embedder/eval-embedder.js Xenova/all-MiniLM-L6-v2
 *     [--models-dir <dir> | --cache-dir <dir>]
 *   node scripts/byok-embedder/eval-embedder.js <embedder> --queries <file>
 *
 * CI never downloads models: only the `hashing` mode runs in CI.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PINNED_DTYPE = 'q8';
const RESULT_LIMIT = 3;

const readArgs = argv => {
  const args = { embedderId: argv[2] || 'hashing' };
  for (let index = 3; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--queries') args.queriesFile = path.resolve(value);
    else if (flag === '--models-dir') args.modelsDir = path.resolve(value);
    else if (flag === '--cache-dir') args.cacheDir = path.resolve(value);
    else {
      throw new Error(`Unknown or malformed argument: ${flag}`);
    }
    index++;
  }
  return args;
};

/** The deterministic hashing embedder (CI parity, zero downloads). */
const makeHashingEmbedder = async hashingModule => {
  const embedder = hashingModule.makeByokHashingEmbedderForTests(128);
  return { id: embedder.id, embed: embedder.embed };
};

/** A real transformers.js embedder, pinned to the app's WASM dtype. */
const makeRealEmbedder = async (transformers, embedderId, args) => {
  if (args.modelsDir) {
    transformers.env.localModelPath = args.modelsDir;
  } else {
    transformers.env.cacheDir =
      args.cacheDir || path.join(os.homedir(), '.cache', 'byok-transformers');
  }
  const extractor = await transformers.pipeline('feature-extraction', embedderId, {
    dtype: PINNED_DTYPE,
  });
  const embed = async texts => {
    const vectors = [];
    for (const text of texts) {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      const data = output.data;
      if (!(data instanceof Float32Array)) {
        throw new Error('The embedder returned an unexpected output.');
      }
      const vector = data.slice();
      let sumOfSquares = 0;
      for (let index = 0; index < vector.length; index++) {
        sumOfSquares += vector[index] * vector[index];
      }
      const norm = Math.sqrt(sumOfSquares);
      if (norm > 0) {
        for (let index = 0; index < vector.length; index++) {
          vector[index] /= norm;
        }
      }
      vectors.push(vector);
    }
    return vectors;
  };
  return { id: embedderId, embed };
};

const runEval = async ({ embedder, queries }) => {
  const { buildByokRagIndex } = require('../../src/AiGeneration/Byok/Rag/ByokRagIndex');
  const {
    searchByokRagKnowledge,
  } = require('../../src/AiGeneration/Byok/Rag/ByokRagSearch');

  const index = await buildByokRagIndex({
    embedderId: embedder.id,
    embed: embedder.embed,
    backend: 'in-process',
  });
  const deps = { index, embedder };

  const results = [];
  for (const expected of queries) {
    // eslint-disable-next-line no-await-in-loop
    const result = await searchByokRagKnowledge({
      query: expected.query,
      deps,
      limit: RESULT_LIMIT,
    });
    const isHit = result.hits.some(hit => {
      const sourceMatches = hit.chunk.source === expected.expectedSource;
      const hintMatches =
        !expected.expectedHint ||
        hit.chunk.text.includes(expected.expectedHint) ||
        hit.chunk.title.includes(expected.expectedHint);
      return sourceMatches && hintMatches;
    });
    results.push({ ...expected, isHit, hits: result.hits });
  }
  const hitCount = results.filter(result => result.isHit).length;
  return { results, hitCount, total: results.length };
};

const printReport = ({ embedderId, results, hitCount, total, corpusChunks }) => {
  console.log(`\nEmbedder: ${embedderId} · corpus chunks: ${corpusChunks}`);
  for (const result of results) {
    const marker = result.isHit ? 'hit ' : 'MISS';
    const top = result.hits
      .slice(0, 3)
      .map(hit => `${hit.chunk.source}:${hit.chunk.title}`)
      .join(' | ');
    console.log(`  ${marker}  "${result.query}" → ${top}`);
  }
  const rate = ((hitCount / total) * 100).toFixed(0);
  console.log(`\nTop-3 hit rate: ${hitCount}/${total} (${rate}%)`);
};

const main = async () => {
  const args = readArgs(process.argv);
  require('@babel/register')({});
  globalThis.self = globalThis;
  const editorFunctionsPath = require.resolve('../../src/EditorFunctions');
  const stubModule = new (require('module')).Module(editorFunctionsPath);
  stubModule.loaded = true;
  stubModule.exports = { editorFunctions: {}, editorFunctionsWithoutProject: {} };
  require.cache[editorFunctionsPath] = stubModule;

  const queries = args.queriesFile
    ? JSON.parse(fs.readFileSync(args.queriesFile, 'utf8'))
    : require('../../src/AiGeneration/Byok/evals/byok-rag-eval-queries.json');
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error('The query set is empty or malformed.');
  }
  // audit011026 B-SCRIPT-7: every holdout entry is shape-checked — a
  // typo'd field used to score as a silent MISS or crash opaquely.
  for (const [index, entry] of queries.entries()) {
    if (
      !entry ||
      typeof entry.query !== 'string' ||
      !entry.query.trim() ||
      typeof entry.expectedSource !== 'string' ||
      !entry.expectedSource
    ) {
      throw new Error(
        `Query #${index} is malformed: every entry needs "query" and "expectedSource" strings.`
      );
    }
  }

  let embedder;
  if (args.embedderId === 'hashing') {
    const hashing = require('../../src/AiGeneration/Byok/Rag/ByokRagEmbedder');
    embedder = await makeHashingEmbedder(hashing);
  } else {
    const transformers = require('@huggingface/transformers');
    embedder = await makeRealEmbedder(transformers, args.embedderId, args);
  }

  console.log(
    `Building the index with ${embedder.id} over the full corpus… (${queries.length} queries)`
  );
  const { results, hitCount, total } = await runEval({ embedder, queries });
  const { buildByokRagCorpus } = require('../../src/AiGeneration/Byok/Rag/ByokRagCorpus');
  const corpusChunks = (await buildByokRagCorpus({})).length;
  printReport({
    embedderId: embedder.id,
    results,
    hitCount,
    total,
    corpusChunks,
  });
};

if (require.main === module) {
  main().catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = { makeHashingEmbedder, makeRealEmbedder, runEval, printReport };
