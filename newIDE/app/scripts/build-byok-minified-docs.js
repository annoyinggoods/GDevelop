/**
 * The minified-docs pipeline (Phase 14.2, D14-2): minifies the whole
 * `gdevelop5` wiki (`DOCs/docs/gdevelop5`, all ~601 .md pages) into the
 * committed artifact `src/AiGeneration/Byok/docs/gdevelop-docs/
 * MinifiedDocs.generated.js`, organized by category (top-level folder),
 * so the model can discover and read the whole wiki offline with RAG off.
 *
 * Maintainer-run only; nothing here enters the app bundle. The minification
 * itself is LLM work performed OUTSIDE this script — per the owner's
 * 2026-09-27 order, by parallel coding agents (waves of <= 5) rather than
 * one cheap-endpoint call per page. This script is therefore the
 * deterministic bookkeeper of that flow:
 *
 *   plan      walk the wiki, bin-pack the pages into balanced batches, and
 *             write build/byok-minified-docs/plan.json (one entry per page:
 *             absolute file, wiki path, category, measured source size).
 *   prompt    print the per-page minification contract (the exact text the
 *             agents — or any future one-call-per-page runner — must
 *             follow), plus the JSON schema of the per-page output files.
 *   assemble  read the per-page JSON files the agents wrote under
 *             build/byok-minified-docs/batches/<batch-id>/<NNN>.json (one
 *             object each, NN = the page's index in the batch listing),
 *             validate every entry (shape, expected paths, compression
 *             band, tag whitelist, engine-token sanity pass), and emit the
 *             generated module. `--dry-run` validates only.
 *
 * ENGINE-TOKEN SANITY PASS (deterministic, no LLM): every backtick-quoted
 * span of a minified body that looks like a single engine call —
 * `Name(` or `Name(args…` — must exist in the bundled engine reference
 * (`Byok/docs/engine-reference.json`, all kinds) or in the explicit
 * allowlist below, else the build fails naming the page and token. This
 * catches hallucinated engine names while never flagging prose, JSON keys
 * or JS snippets (they are not single backticked CamelCase calls). The
 * allowlist documents every false positive found across the whole wiki:
 * the gamepad helpers MovementX/MovementY, the save-state parameter label
 * "Profile(s)", and the TimeFormatter expression SecondsToHHMMSS000
 * (each with the full rationale at the constant below).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_DOCS_ROOT = path.join(REPO_ROOT, 'DOCs', 'docs', 'gdevelop5');
const DEFAULT_WORK_DIR = path.join(
  REPO_ROOT,
  'newIDE',
  'app',
  'build',
  'byok-minified-docs'
);
const DEFAULT_ARTIFACT = path.join(
  REPO_ROOT,
  'newIDE',
  'app',
  'src',
  'AiGeneration',
  'Byok',
  'docs',
  'gdevelop-docs',
  'MinifiedDocs.generated.js'
);

/** Pages whose strippable source is under this are listed as stubs (kept). */
const STUB_SOURCE_BYTES = 120;

/** Bin-packing target: source bytes (after stripping) per agent batch. */
const DEFAULT_BATCH_TARGET_BYTES = 150 * 1024;

/** The overall corpus compression band (D14-2): output/source must land here. */
const COMPRESSION_BAND = { min: 0.35, max: 0.65 };

/** Documented false positives of the engine-token pass (see header). */
const ENGINE_TOKEN_ALLOWLIST = [
  // Gamepad helper expressions used by the community gamepad docs; the
  // shipped engine reference names the underlying expressions differently.
  'MovementX',
  'MovementY',
  // "Profile(s) to save/load" — a save-state parameter LABEL in the docs
  // ("one or more profiles"), not an engine call.
  'Profile',
  // TimeFormatter expression documented upstream as
  // `TimeFormatter::SecondsToHHMMSS000(number)`; the generated engine
  // reference indexes it under its sentence label, so the CamelCase name
  // is not in the name set.
  'SecondsToHHMMSS000',
];

/**
 * The per-page minification contract — the single source of truth shared by
 * the parallel agents and any future one-call-per-page runner. `prompt`
 * prints it verbatim; the batch prompts embed it.
 */
const MINIFICATION_CONTRACT = [
  'Minify ONE documentation page of the GDevelop wiki into structured JSON.',
  '',
  'KEEP (verbatim or near-verbatim):',
  '- every "Rule:", "Note:", "Warning:", "Tip:" constraint line — keep the constraint text itself',
  '- exact parameter, property, option and expression names (keep them in `backticks` when the source has them so)',
  '- exact UI labels the reader must find in the editor',
  '- code blocks, event-sheet examples and parameter tables: keep them whole (trim only obviously redundant repeated rows), never rewrite their content',
  '- section headings, compacted (drop decorative suffixes)',
  '',
  'DROP:',
  '- narrative/marketing/tutorial prose, introductions and summaries-of-the-obvious',
  '- images, videos, emojis, "See also" link lists, breadcrumbs, HTML comments',
  '- whole paragraphs that only restate what a kept line already says',
  '',
  'TARGET SIZE: the body+summary together should be roughly 40-60% of the source length (frontmatter, images and link-only lines do not count as source). A page that is mostly code/tables may stay near 90%; a prose page may go to 25%. Never sacrifice a KEEP rule to hit the band.',
  '',
  'NEVER invent engine, action, condition, expression, behavior or object names that are not in the source. Never alter code.',
  '',
  'TYPOS: keep the source spelling verbatim, INCLUDING a typo in upstream prose. Two waves normalized "Triggred Once" and "Returns a Hash a MD5" against this rule, so the contract now says so explicitly: this artifact is a faithful reduction of a specific commit of the wiki, and a silent spelling fix makes the minified text impossible to diff against its source. A prose typo is a wiki bug to report upstream, not something to repair here.',
  '',
  'OUTPUT per page: { "path": given, "title": from frontmatter or first heading, "summary": "1-2 sentences (max 40 words) on what this page covers", "body": "the minified markdown (no frontmatter, no title heading)", "suggestedTags": ["0-4 short lowercase topical tags"] }',
].join('\n');

const BATCH_JSON_SCHEMA_NOTE = [
  'Per-page output: one JSON object per page, written to the given output path',
  '(build/byok-minified-docs/batches/<batch-id>/<NN>.json — NN = the page index,',
  'zero-padded). Fields: path (copy the given wiki path EXACTLY), title, summary,',
  'body, suggestedTags. UTF-8, standard JSON (double quotes, escaped newlines).',
].join(' ');

// --- Pure helpers (all covered by ByokMinifiedDocsPipeline.spec.js) --------

/** The wiki-relative path of a file (`extensions/health/index.md`). */
const normalizeWikiPath = (absoluteFilePath, docsRoot) =>
  absoluteFilePath
    .slice(docsRoot.length + 1)
    .split(path.sep)
    .join('/');

/**
 * The category of a wiki path: the top-level folder, or `general` for the
 * handful of root pages (documented; the mkdocs nav mixes them in anyway).
 */
const categoryOfWikiPath = wikiPath => {
  const slash = wikiPath.indexOf('/');
  return slash === -1 ? 'general' : wikiPath.slice(0, slash);
};

/**
 * The measurable source of a page: frontmatter, image lines, HTML comments
 * and link-only lines stripped — this is the denominator of the compression
 * ratio (agents must not "compress" what is not content).
 */
const stripFrontmatterAndNoise = markdown => {
  const withoutFrontmatter = markdown.replace(
    /^---\r?\n[\s\S]*?\r?\n---\r?\n/,
    ''
  );
  return withoutFrontmatter
    .split('\n')
    .filter(line => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line))
    .filter(line => !/^\s*\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*$/.test(line))
    .filter(line => !/^\s*<!--/.test(line))
    .join('\n')
    .trim();
};

/** The page title: the frontmatter title, else the first level-1 heading. */
const titleOfMarkdown = markdown => {
  const frontmatterTitle = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (frontmatterTitle) {
    const match = frontmatterTitle[0].match(/^title:\s*(.+)$/m);
    if (match) return match[1].replace(/["']/g, '').trim();
  }
  const heading = markdown.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : '';
};

/**
 * The engine-token sanity pass: every backticked span (<= 60 chars) shaped
 * like a single engine call — `Name(` or `Name(args` — becomes a candidate.
 * Pure and deterministic.
 */
const extractEngineCallTokens = text => {
  const tokens = new Set();
  const spans = text.match(/`[^`\n]{1,60}`/g) || [];
  for (const span of spans) {
    const inner = span.slice(1, -1).trim();
    const match = inner.match(/^([A-Z][A-Za-z0-9]{2,})\(/);
    if (match) tokens.add(match[1]);
  }
  return Array.from(tokens).sort();
};

/**
 * The unknown engine tokens across all minified bodies: a token is known
 * when it is an engine-reference name or an allowlisted false positive.
 */
const findUnknownEngineTokens = (bodiesByPath, engineNames, allowlist) => {
  const known = new Set([...engineNames, ...allowlist]);
  const unknown = [];
  for (const pagePath of Object.keys(bodiesByPath).sort()) {
    for (const token of extractEngineCallTokens(bodiesByPath[pagePath])) {
      if (!known.has(token)) unknown.push({ pagePath, token });
    }
  }
  return unknown;
};

/**
 * The tag whitelist: every folder segment of every wiki path, plus the
 * 2d/3d heuristic facets. LLM-suggested tags outside this set are dropped.
 */
const buildTagWhitelist = wikiPaths => {
  const whitelist = new Set(['2d', '3d']);
  for (const wikiPath of wikiPaths) {
    const segments = wikiPath.split('/');
    segments.pop();
    for (const segment of segments) whitelist.add(segment.toLowerCase());
  }
  return whitelist;
};

/** The deterministic tags of one entry: folder facets + 2d/3d + allowed LLM tags. */
const deterministicTagsOf = (wikiPath, suggestedTags, whitelist) => {
  const tags = new Set();
  const segments = wikiPath.split('/');
  segments.pop();
  for (const segment of segments) tags.add(segment.toLowerCase());
  const content = `${wikiPath}`.toLowerCase();
  // The 3d heuristic: any `3d` in the path (scene3d, jump3d, physics3d…)
  // marks a 3D page — the folder taxonomy spells it into the names.
  // audit011026 B-SCRIPT-11: symmetric heuristics — a 2d-named page gets
  // the 2d facet the same way a 3d-named one gets 3d (the LLM-suggested
  // route was the only 2d source before, and it rarely suggested it).
  if (content.includes('3d')) {
    tags.add('3d');
  }
  if (content.includes('2d')) {
    tags.add('2d');
  }
  for (const tag of suggestedTags) {
    const normalized = String(tag)
      .toLowerCase()
      .trim();
    if (whitelist.has(normalized)) tags.add(normalized);
  }
  return Array.from(tags).sort();
};

/**
 * Walk the wiki and return the page inventory, sorted by size (big first —
 * the bin-packing prefers starting with the heavy items).
 */
const listWikiPages = docsRoot => {
  const pages = [];
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const entryPath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      const markdown = fs.readFileSync(entryPath, 'utf8');
      const sourceBytes = Buffer.byteLength(
        stripFrontmatterAndNoise(markdown),
        'utf8'
      );
      pages.push({
        file: entryPath,
        wikiPath: normalizeWikiPath(entryPath, docsRoot),
        category: categoryOfWikiPath(normalizeWikiPath(entryPath, docsRoot)),
        sourceBytes,
        stub: sourceBytes < STUB_SOURCE_BYTES,
        fallbackTitle: titleOfMarkdown(markdown),
      });
    }
  };
  walk(docsRoot);
  pages.sort(
    (a, b) =>
      b.sourceBytes - a.sourceBytes ||
      // Byte-wise, NOT localeCompare: the batch plan is documented as
      // reproducible, and a host-locale comparator reorders same-size pages
      // differently on different machines — so two agents building the same
      // commit could pick different pages for the same batch
      // (audit100226 SCRIPT-5).
      (a.wikiPath < b.wikiPath ? -1 : a.wikiPath > b.wikiPath ? 1 : 0)
  );
  return pages;
};

/**
 * Bin-pack the pages into agent batches: biggest-first greedy packing under
 * a per-batch byte target, order stable for reproducible plans.
 */
const buildBatchPlan = (pages, targetBytes) => {
  const batches = [];
  for (const page of pages) {
    const lastBatch = batches[batches.length - 1];
    if (
      lastBatch &&
      lastBatch.sourceBytes + page.sourceBytes <= targetBytes &&
      lastBatch.pages.length < 40
    ) {
      lastBatch.pages.push(page);
      lastBatch.sourceBytes += page.sourceBytes;
      continue;
    }
    batches.push({ sourceBytes: page.sourceBytes, pages: [page] });
  }
  return batches.map((batch, index) => ({
    id: `batch-${String(index).padStart(3, '0')}`,
    sourceBytes: batch.sourceBytes,
    pages: batch.pages,
  }));
};

/**
 * Validate one parsed batch-output file against the plan: shape, expected
 * paths (order-free but exact), non-empty fields, per-page compression
 * band (warnings), and overall-band + engine-token checks the caller runs
 * across all batches at once. Returns entries with deterministic tags and
 * measured ratios attached.
 */
const validateMinifiedBatch = (batchOutput, plannedPages) => {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(batchOutput)) {
    return {
      ok: false,
      errors: ['The batch output is not a JSON array.'],
      warnings,
      entries: [],
    };
  }
  const plannedByPath = new Map(
    plannedPages.map(page => [page.wikiPath, page])
  );
  const seenPaths = new Set();
  const entries = [];
  for (const raw of batchOutput) {
    if (!raw || typeof raw !== 'object') {
      errors.push('An entry is not an object.');
      continue;
    }
    const pagePath = raw.path;
    if (typeof pagePath !== 'string' || !plannedByPath.has(pagePath)) {
      errors.push(
        `Unexpected or unknown page path: ${JSON.stringify(pagePath)}`
      );
      continue;
    }
    if (seenPaths.has(pagePath)) {
      errors.push(`Duplicate entry for ${pagePath}.`);
      continue;
    }
    seenPaths.add(pagePath);
    const planned = plannedByPath.get(pagePath);
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    const body = typeof raw.body === 'string' ? raw.body.trim() : '';
    const suggestedTags = Array.isArray(raw.suggestedTags)
      ? raw.suggestedTags
      : [];
    if (!title) errors.push(`${pagePath}: missing title`);
    if (!summary) errors.push(`${pagePath}: missing summary`);
    if (!body && !planned.stub) errors.push(`${pagePath}: empty body`);
    const outputBytes = Buffer.byteLength(`${summary}\n${body}`, 'utf8');
    const ratio =
      planned.sourceBytes > 0 ? outputBytes / planned.sourceBytes : 1;
    if (!planned.stub && ratio > 0.9) {
      warnings.push(
        `${pagePath}: compression ratio ${ratio.toFixed(2)} (above 0.9)`
      );
    }
    if (ratio < 0.15 && !planned.stub) {
      warnings.push(
        `${pagePath}: compression ratio ${ratio.toFixed(2)} (below 0.15)`
      );
    }
    entries.push({
      path: pagePath,
      title,
      category: planned.category,
      summary,
      body,
      tags: suggestedTags,
      ratio,
    });
  }
  for (const page of plannedPages) {
    if (!seenPaths.has(page.wikiPath)) {
      errors.push(`Missing entry for ${page.wikiPath}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, entries };
};

/** The generated module text (the BundledDocs.generated.js pattern). */
const emitGeneratedModule = entries => {
  const lines = [
    '// @flow',
    '//',
    '// GENERATED by scripts/build-byok-minified-docs.js — do not edit by hand.',
    '// The whole gdevelop5 wiki minified (Phase 14.2, D14-2): one entry per',
    '// page, organized by category (top-level folder). Generated data —',
    '// validated once by the pipeline, still treated as untrusted by',
    '// ByokMinifiedDocs.js (same pattern as BundledDocs.generated.js).',
    '',
    'export type ByokMinifiedDocPage = {|',
    '  path: string,',
    '  title: string,',
    '  category: string,',
    '  summary: string,',
    '  body: string,',
    '  tags: Array<string>,',
    '|};',
    '',
    'const byokMinifiedDocPages: Array<ByokMinifiedDocPage> = [',
  ];
  for (const entry of entries) {
    lines.push(`  {`);
    lines.push(`    path: ${JSON.stringify(entry.path)},`);
    lines.push(`    title: ${JSON.stringify(entry.title)},`);
    lines.push(`    category: ${JSON.stringify(entry.category)},`);
    lines.push(`    summary: ${JSON.stringify(entry.summary)},`);
    lines.push(`    body: ${JSON.stringify(entry.body)},`);
    lines.push(`    tags: ${JSON.stringify(entry.tags)},`);
    lines.push(`  },`);
  }
  lines.push('];', '', 'export default byokMinifiedDocPages;', '');
  return lines.join('\n');
};

// --- Subcommands -------------------------------------------------------------

const runPlan = options => {
  const pages = listWikiPages(options.docsRoot);
  const batches = buildBatchPlan(pages, options.batchTargetBytes);
  fs.mkdirSync(options.workDir, { recursive: true });
  fs.writeFileSync(
    path.join(options.workDir, 'plan.json'),
    JSON.stringify(
      {
        docsRoot: options.docsRoot,
        pageCount: pages.length,
        stubCount: pages.filter(page => page.stub).length,
        batches: batches.map(batch => ({
          id: batch.id,
          sourceBytes: batch.sourceBytes,
          pages: batch.pages.map(page => ({
            file: page.file,
            wikiPath: page.wikiPath,
            category: page.category,
            sourceBytes: page.sourceBytes,
            stub: page.stub,
          })),
        })),
      },
      null,
      2
    )
  );
  console.log(`Planned ${pages.length} pages into ${batches.length} batches.`);
  console.log(
    `Stubs (source < ${STUB_SOURCE_BYTES} bytes): ${
      pages.filter(page => page.stub).length
    }`
  );
  console.log(`Plan written to ${path.join(options.workDir, 'plan.json')}`);
};

const runPrompt = () => {
  console.log(MINIFICATION_CONTRACT);
  console.log(`\nBatch output file: ${BATCH_JSON_SCHEMA_NOTE}`);
};

const runAssemble = async options => {
  const planPath = path.join(options.workDir, 'plan.json');
  if (!fs.existsSync(planPath)) {
    throw new Error(
      `No plan.json under ${options.workDir} — run "plan" first.`
    );
  }
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const engineNames = require('../src/AiGeneration/Byok/docs/engine-reference.json').map(
    entry => entry.name
  );
  const whitelist = buildTagWhitelist(
    plan.batches.flatMap(batch => batch.pages.map(page => page.wikiPath))
  );

  const allEntries = [];
  const warnings = [];
  const errors = [];
  let missingPages = 0;
  for (const batch of plan.batches) {
    const batchDir = path.join(options.workDir, 'batches', batch.id);
    const batchEntries = [];
    for (let index = 0; index < batch.pages.length; index++) {
      const pageFile = path.join(
        batchDir,
        `${String(index).padStart(2, '0')}.json`
      );
      if (!fs.existsSync(pageFile)) {
        missingPages++;
        errors.push(`Missing page output: ${pageFile}`);
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(pageFile, 'utf8'));
      } catch (error) {
        errors.push(`${pageFile}: invalid JSON (${error.message})`);
        continue;
      }
      batchEntries.push(parsed);
    }
    if (batchEntries.length === 0) continue;
    const outcome = validateMinifiedBatch(batchEntries, batch.pages);
    errors.push(...outcome.errors.map(text => `${batch.id}: ${text}`));
    warnings.push(...outcome.warnings.map(text => `${batch.id}: ${text}`));
    allEntries.push(...outcome.entries);
  }
  if (missingPages > 0) {
    console.error(`${missingPages} page file(s) missing — cannot assemble.`);
  }

  const bodiesByPath = {};
  for (const entry of allEntries) {
    bodiesByPath[entry.path] = `${entry.summary}\n${entry.body}`;
    entry.tags = deterministicTagsOf(entry.path, entry.tags, whitelist);
  }
  const unknownTokens = findUnknownEngineTokens(
    bodiesByPath,
    engineNames,
    ENGINE_TOKEN_ALLOWLIST
  );
  for (const { pagePath, token } of unknownTokens) {
    errors.push(`Unknown engine token \`${token}(\` in ${pagePath}`);
  }

  // audit011026 B-SCRIPT-6: a plain codepoint compare — localeCompare is
  // ICU-dependent and a different ICU build could reorder the entries,
  // turning a regeneration into a huge spurious diff.
  allEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totalSource = plan.batches.reduce(
    (sum, batch) =>
      sum +
      batch.pages.reduce((pageSum, page) => pageSum + page.sourceBytes, 0),
    0
  );
  const totalOutput = allEntries.reduce(
    (sum, entry) =>
      sum + Buffer.byteLength(`${entry.summary}\n${entry.body}`, 'utf8'),
    0
  );
  const overallRatio = totalSource > 0 ? totalOutput / totalSource : 1;
  if (
    allEntries.length === plan.pageCount &&
    (overallRatio < COMPRESSION_BAND.min || overallRatio > COMPRESSION_BAND.max)
  ) {
    errors.push(
      `Overall compression ratio ${overallRatio.toFixed(2)} outside the [${
        COMPRESSION_BAND.min
      }, ${COMPRESSION_BAND.max}] band.`
    );
  }

  console.log(`Entries: ${allEntries.length} / ${plan.pageCount} pages`);
  console.log(
    `Overall compression: ${totalOutput} / ${totalSource} bytes = ${overallRatio.toFixed(
      2
    )}`
  );
  console.log(
    `Warnings: ${warnings.length}${warnings.length ? '' : ' (clean)'}`
  );
  for (const warning of warnings.slice(0, 40)) console.log(`  warn ${warning}`);
  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s):`);
    for (const error of errors.slice(0, 60)) console.error(`  ${error}`);
    throw new Error('The minified-docs build failed validation.');
  }

  if (options.dryRun) {
    console.log('Dry run: validation passed, no artifact written.');
    return;
  }
  // The committed artifact must pass `npm run check-format` like every
  // other src file: format it with the project's own prettier.
  const prettier = require('prettier');
  // Same options as the project's .prettierrc (check-format reads them
  // from the file; the API call must pass them explicitly).
  const artifactText = prettier.format(emitGeneratedModule(allEntries), {
    parser: 'babylon',
    singleQuote: true,
    trailingComma: 'es5',
  });
  fs.writeFileSync(options.artifact, artifactText);
  console.log(`Artifact written: ${options.artifact}`);
};

const readArgs = argv => {
  const args = {
    command: argv[2] || 'plan',
    docsRoot: DEFAULT_DOCS_ROOT,
    workDir: DEFAULT_WORK_DIR,
    artifact: DEFAULT_ARTIFACT,
    batchTargetBytes: DEFAULT_BATCH_TARGET_BYTES,
    dryRun: false,
  };
  if (!['plan', 'prompt', 'assemble', 'validate'].includes(args.command)) {
    throw new Error(
      `Unknown command "${args.command}" (plan|prompt|assemble|validate).`
    );
  }
  if (args.command === 'validate') {
    args.command = 'assemble';
    args.dryRun = true;
  }
  for (let index = 3; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--docs-root') args.docsRoot = path.resolve(value);
    else if (flag === '--work-dir') args.workDir = path.resolve(value);
    else if (flag === '--artifact') args.artifact = path.resolve(value);
    else if (flag === '--batch-target-kb') {
      args.batchTargetBytes = Number(value) * 1024;
    } else if (flag === '--dry-run') {
      args.dryRun = true;
      continue;
    } else {
      throw new Error(`Unknown or malformed argument: ${flag}`);
    }
    index++;
  }
  return args;
};

const main = async () => {
  const args = readArgs(process.argv);
  if (args.command === 'plan') return runPlan(args);
  if (args.command === 'prompt') return runPrompt();
  return runAssemble(args);
};

if (require.main === module) {
  main().catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  COMPRESSION_BAND,
  ENGINE_TOKEN_ALLOWLIST,
  MINIFICATION_CONTRACT,
  STUB_SOURCE_BYTES,
  buildBatchPlan,
  buildTagWhitelist,
  categoryOfWikiPath,
  deterministicTagsOf,
  emitGeneratedModule,
  extractEngineCallTokens,
  findUnknownEngineTokens,
  normalizeWikiPath,
  stripFrontmatterAndNoise,
  titleOfMarkdown,
  validateMinifiedBatch,
};
