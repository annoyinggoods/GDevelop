/**
 * The prebuilt RAG index bundle builder (Phase 14.4, D14-3): builds the
 * on-device index over the bundled corpus with a real embedder and wraps
 * it as the single-file artifact behind the RAG tab's "Prebuilt index"
 * card — so users skip the ~30-minute first build. Maintainer-run only:
 * nothing here enters the app bundle; the artifact is uploaded by the
 * owner to the fork's GitHub Releases (usertasks Task 17.2).
 *
 * The artifact is the app's OWN serialized index — the exact payload the
 * in-process store persists as `index.json` (`serializeByokRagIndex`) —
 * plus an envelope: embedder identity + pinned dtype, and a sha256 of the
 * index payload for integrity. The future import path re-verifies by
 * re-stringifying `bundle.index` (JSON.parse preserves key order, so the
 * canonical string is reproducible), comparing hashes, then handing the
 * index to `deserializeByokRagIndex` and the in-process store (or a
 * Qdrant upload).
 *
 * Parity contract: the app embeds on WASM where the transformers.js
 * device default is dtype `q8` (`model_quantized.onnx`). This script pins
 * `dtype: 'q8'` and mirrors the app embedder call shape exactly (mean
 * pooling, normalize, re-normalized unit vectors) — same inputs, same
 * vectors. The corpus is built by the real `buildByokRagCorpus` (loaded
 * through the app's own Babel config, never re-implemented here), so the
 * manifest corpus hash is the app's own determinism hash.
 *
 * Re-run whenever the corpus (`ByokRagCorpus`) or the embedder changes;
 * the manifest records the corpus hash and the app refuses mismatches
 * (D14-3), so building "early" (before Phase 14.2/14.3 land) only means
 * regenerating the artifact then.
 *
 * Usage (from `newIDE/app`):
 *   node scripts/byok-embedder/build-byok-rag-bundle.js
 *     [--embedder Xenova/all-MiniLM-L6-v2]
 *     [--models-dir <dir>]  HF repo layout under <dir>, i.e.
 *                           <dir>/Xenova/all-MiniLM-L6-v2/{config.json,
 *                           tokenizer.json,tokenizer_config.json,
 *                           onnx/model_quantized.onnx} — a bare .onnx
 *                           file is not enough.
 *     [--cache-dir <dir>]   model download cache
 *                           (default: ~/.cache/byok-transformers)
 *     [--out <file>]        (default build/byok-rag-bundle/<name>.json)
 *     [--skip-verification] skip the reload + spot-check pass
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE_FORMAT_VERSION = 1;
const BUNDLE_KIND = 'byok-rag-bundle';
/** Pinned to match the app's WASM device default (see header). */
const PINNED_DTYPE = 'q8';

/**
 * Fixed spot-check queries, one per corpus source family — run against
 * the RELOADED artifact so the verification exercises the exact bytes
 * a user would download.
 */
const SPOT_CHECK_QUERIES = [
  'timer action',
  'collision between two objects',
  'sprite animation',
  'physics forces',
  'platformer game',
  'save system',
  'change scene',
  'camera position',
];

/** sha256 (hex) of the canonical index payload. Pure. */
const computeIndexSha256 = indexJsonString =>
  crypto
    .createHash('sha256')
    .update(indexJsonString, 'utf8')
    .digest('hex');

/**
 * The bundle envelope around a serialized index. Pure: `index` is the
 * `ByokRagSerializedIndex` object, `embedder` the catalog meta (the dtype
 * is pinned here, not taken from the caller).
 */
const buildBundleEnvelope = ({ index, embedder, createdIso }) => ({
  bundle: BUNDLE_KIND,
  formatVersion: BUNDLE_FORMAT_VERSION,
  created: createdIso,
  embedder: {
    id: embedder.id,
    dimensions: embedder.dimensions,
    approximateDownloadMegabytes: embedder.approximateDownloadMegabytes,
    dtype: PINNED_DTYPE,
  },
  index,
  integrity: { indexSha256: computeIndexSha256(JSON.stringify(index)) },
});

/** The artifact file name for a corpus hash + embedder id. Pure. */
const makeBundleFileName = (corpusHash, embedderId) =>
  `byok-rag-bundle-f${BUNDLE_FORMAT_VERSION}-${String(embedderId)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')}-${corpusHash}.json`;

const readArgs = argv => {
  const args = {};
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--skip-verification') {
      args.skipVerification = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === '--embedder') args.embedder = value;
    else if (flag === '--models-dir') args.modelsDir = value;
    else if (flag === '--cache-dir') args.cacheDir = value;
    else if (flag === '--out') args.out = value;
    else {
      throw new Error(`Unknown or malformed argument: ${flag}`);
    }
    index++;
  }
  return args;
};

/** The app-parity embed function over a loaded transformers.js extractor. */
const makeEmbedFunction = (extractor, expectedDimensions) => async texts => {
  const vectors = [];
  for (const text of texts) {
    const output = await extractor(text, {
      pooling: 'mean',
      normalize: true,
    });
    const data = output.data;
    if (!(data instanceof Float32Array)) {
      throw new Error('The embedder returned an unexpected output.');
    }
    if (data.length !== expectedDimensions) {
      throw new Error(
        `The embedder returned ${
          data.length
        } dimensions, expected ${expectedDimensions}.`
      );
    }
    // Mirror ByokRagEmbedder: copy, then normalize to unit length (cosine
    // becomes a plain dot product at search time).
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

const printProgress = (() => {
  let lastReported = -1;
  return ({ progress, stage }) => {
    const percent = Math.floor(progress * 100);
    if (percent >= lastReported + 5 || percent === 100) {
      lastReported = percent;
      process.stdout.write(`\r[${stage}] ${percent}%   `);
      if (percent === 100) process.stdout.write('\n');
    }
  };
})();

const main = async () => {
  const args = readArgs(process.argv);

  // Load the real src modules through the app's own Babel config — the
  // corpus builder, the index build and the serialization are NEVER
  // re-implemented here (the manifest hash is the app's own).
  require('@babel/register')({});
  // The corpus closure imports the knowledge sections, which import the
  // tool schemas, which iterate the EditorFunctions registry at load time.
  // The registry itself (and its whole browser-side dependency subtree) is
  // irrelevant to the corpus — stub it before anything requires it.
  globalThis.self = globalThis;
  const editorFunctionsPath = require.resolve('../../src/EditorFunctions');
  const stubModule = new (require('module')).Module(editorFunctionsPath);
  stubModule.loaded = true;
  stubModule.exports = {
    editorFunctions: {},
    editorFunctionsWithoutProject: {},
  };
  require.cache[editorFunctionsPath] = stubModule;
  const {
    buildByokRagIndex,
    serializeByokRagIndex,
    deserializeByokRagIndex,
    searchByokRagIndex,
  } = require('../../src/AiGeneration/Byok/Rag/ByokRagIndex');
  const {
    BYOK_RAG_DEFAULT_EMBEDDER_ID,
    getByokRagEmbedderInfo,
  } = require('../../src/AiGeneration/Byok/Rag/ByokRagTypes');

  const embedderId = args.embedder || BYOK_RAG_DEFAULT_EMBEDDER_ID;
  const embedderInfo = getByokRagEmbedderInfo(embedderId);
  if (!embedderInfo) {
    throw new Error(`Unknown embedder "${embedderId}".`);
  }

  const transformers = require('@huggingface/transformers');
  if (args.modelsDir) {
    transformers.env.localModelPath = path.resolve(args.modelsDir);
    console.log(`Loading models from ${transformers.env.localModelPath}`);
  } else {
    const cacheDir =
      args.cacheDir || path.join(os.homedir(), '.cache', 'byok-transformers');
    transformers.env.cacheDir = cacheDir;
    console.log(`Model cache: ${cacheDir}`);
  }

  console.log(
    `Loading ${embedderId} (dtype ${PINNED_DTYPE}, ${
      embedderInfo.approximateDownloadMegabytes
    } MB, ${embedderInfo.dimensions} dims)…`
  );
  const extractor = await transformers.pipeline(
    'feature-extraction',
    embedderId,
    { dtype: PINNED_DTYPE }
  );

  console.log('Building the corpus and embedding the chunks…');
  const index = await buildByokRagIndex({
    embedderId,
    embed: makeEmbedFunction(extractor, embedderInfo.dimensions),
    backend: 'in-process',
    onProgress: printProgress,
  });

  const serialized = serializeByokRagIndex(index);
  const bundle = buildBundleEnvelope({
    index: serialized,
    embedder: {
      id: embedderId,
      dimensions: embedderInfo.dimensions,
      approximateDownloadMegabytes: embedderInfo.approximateDownloadMegabytes,
    },
    createdIso: new Date().toISOString(),
  });

  // Integrity sanity: the hash must survive a JSON round-trip, because
  // this is exactly how the importer will recompute it.
  const roundTrip = JSON.parse(JSON.stringify(bundle));
  if (
    computeIndexSha256(JSON.stringify(roundTrip.index)) !==
    bundle.integrity.indexSha256
  ) {
    throw new Error(
      'The index payload hash did not survive a JSON round-trip.'
    );
  }

  const outPath = path.resolve(
    args.out ||
      path.join(
        __dirname,
        '..',
        '..',
        'build',
        'byok-rag-bundle',
        makeBundleFileName(index.manifest.corpusHash, embedderId)
      )
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(bundle));

  const sourceCounts = index.chunks.reduce((counts, chunk) => {
    counts[chunk.source] = (counts[chunk.source] || 0) + 1;
    return counts;
  }, {});
  const megabytes = fs.statSync(outPath).size / (1024 * 1024);
  console.log(`\nBundle written: ${outPath}`);
  console.log(
    `  ${index.chunks.length} chunks (${Object.entries(sourceCounts)
      .map(([source, count]) => `${source}: ${count}`)
      .join(', ')})`
  );
  console.log(`  corpus hash: ${index.manifest.corpusHash}`);
  console.log(`  index sha256: ${bundle.integrity.indexSha256}`);
  console.log(`  size: ${megabytes.toFixed(1)} MB`);

  if (!args.skipVerification) {
    console.log('\nVerifying the WRITTEN artifact (reload + spot checks)…');
    const reloaded = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const stored = deserializeByokRagIndex(reloaded.index);
    if (!stored || stored.chunks.length !== index.chunks.length) {
      throw new Error('The reloaded artifact failed to deserialize.');
    }
    let misses = 0;
    for (const query of SPOT_CHECK_QUERIES) {
      const [queryVector] = await makeEmbedFunction(
        extractor,
        embedderInfo.dimensions
      )([query]);
      const hits = searchByokRagIndex(stored, queryVector, 3);
      if (hits.length === 0) misses++;
      console.log(`  "${query}"`);
      for (const hit of hits) {
        console.log(
          `    ${hit.score.toFixed(3)}  ${hit.chunk.source}  ${hit.chunk.title}`
        );
      }
    }
    if (misses > 0) {
      throw new Error(`${misses} spot-check query(es) returned no hits.`);
    }
    console.log('Verification passed: the artifact retrieves as built.');
  }

  console.log(
    `\nNext: upload to the fork's GitHub Releases (tag byok-rag-bundle-v${BUNDLE_FORMAT_VERSION}, usertasks Task 17.2). The manifest keys the artifact to ${embedderId} @ ${PINNED_DTYPE} + corpus ${
      index.manifest.corpusHash
    } — regenerate on either change.`
  );
};

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_KIND,
  SPOT_CHECK_QUERIES,
  computeIndexSha256,
  buildBundleEnvelope,
  makeBundleFileName,
};
