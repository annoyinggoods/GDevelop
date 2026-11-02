/**
 * Generate the BYOK engine reference catalog from the extension-declaration
 * sources of the repository (Phase 7.2): every object, behavior, action,
 * condition, expression and effect declared in the JS extensions
 * (`Extensions/<name>/JsExtension.js`) and the C++ builtin extensions
 * (`Core/GDCore/Extensions/Builtin/<Name>Extension.cpp`) becomes an entry of
 * `src/AiGeneration/Byok/docs/engine-reference.json`, which the BYOK
 * `search_reference` tool queries so the agent does not have to carry the
 * catalog in its prompt.
 *
 * Run it whenever the engine metadata changes (and commit the refreshed
 * catalog):
 *
 *   cd newIDE/app/scripts
 *   node generate-byok-engine-reference.js
 *
 * The parsing is tolerant by design: a source that cannot be parsed is
 * logged and skipped, never fatal (the catalog stays usable without it).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseExtensionSource } = require('./byokEngineReferenceParser');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const extensionsRoot = path.join(repoRoot, 'Extensions');
const builtinRoot = path.join(
  repoRoot,
  'Core',
  'GDCore',
  'Extensions',
  'Builtin'
);
const outputPath = path.join(
  __dirname,
  '..',
  'src',
  'AiGeneration',
  'Byok',
  'docs',
  'engine-reference.json'
);

/** Walk the JsExtension.js files of the community extensions. */
const collectJsExtensionFiles = () => {
  const files = [];
  for (const entry of fs.readdirSync(extensionsRoot, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extensionsRoot, entry.name, 'JsExtension.js');
    if (fs.existsSync(candidate)) files.push(candidate);
  }
  return files.sort();
};

/** Walk the C++ builtin extension sources (top level and sub-folders). */
const collectBuiltinCppFiles = () => {
  const files = [];
  const walk = (directory, depth) => {
    for (const entry of fs.readdirSync(directory, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && depth === 0) {
        walk(path.join(directory, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.cpp')) continue;
      if (entry.name === 'AllBuiltinExtensions.h') continue;
      files.push(path.join(directory, entry.name));
    }
  };
  walk(builtinRoot, 0);
  return files.sort();
};

const generateEngineReference = () => {
  const entriesBySource = [];
  const allWarnings = [];

  for (const filePath of collectJsExtensionFiles()) {
    try {
      const source = fs.readFileSync(filePath, 'utf8');
      const { entries, warnings } = parseExtensionSource(source, {
        language: 'js',
        ownerFallback: path.basename(path.dirname(filePath)),
        sourceName: path.relative(repoRoot, filePath),
      });
      entriesBySource.push(entries);
      allWarnings.push(...warnings);
    } catch (error) {
      allWarnings.push(
        `${path.relative(repoRoot, filePath)}: skipped (${error.message})`
      );
    }
  }

  for (const filePath of collectBuiltinCppFiles()) {
    try {
      const source = fs.readFileSync(filePath, 'utf8');
      const { entries, warnings } = parseExtensionSource(source, {
        language: 'cpp',
        ownerFallback: `Builtin${path.basename(filePath, '.cpp')}`,
        sourceName: path.relative(repoRoot, filePath),
      });
      entriesBySource.push(entries);
      allWarnings.push(...warnings);
    } catch (error) {
      allWarnings.push(
        `${path.relative(repoRoot, filePath)}: skipped (${error.message})`
      );
    }
  }

  // Deduplicate (owner, kind, name): a name declared twice keeps its first
  // declaration, and the entries are sorted for a stable, diffable catalog.
  const uniqueEntries = new Map();
  for (const entries of entriesBySource) {
    for (const entry of entries) {
      const key = `${entry.owner}::${entry.kind}::${entry.name}`;
      if (!uniqueEntries.has(key)) uniqueEntries.set(key, entry);
    }
  }
  const catalog = Array.from(uniqueEntries.values()).sort((a, b) =>
    `${a.owner}::${a.kind}::${a.name}`.localeCompare(
      `${b.owner}::${b.kind}::${b.name}`
    )
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(catalog));

  const counts = {};
  for (const entry of catalog) {
    counts[entry.kind] = (counts[entry.kind] || 0) + 1;
  }
  console.log(
    `Engine reference written: ${catalog.length} entries (${JSON.stringify(
      counts
    )}) -> ${path.relative(repoRoot, outputPath)}`
  );
  if (allWarnings.length > 0) {
    console.log(
      `${allWarnings.length} warning(s) (tolerated, entries skipped):`
    );
    for (const warning of allWarnings.slice(0, 40)) console.log(`  ${warning}`);
    if (allWarnings.length > 40) {
      console.log(`  … and ${allWarnings.length - 40} more`);
    }
  }
};

generateEngineReference();
