/**
 * Static, tolerant parser of the GDevelop extension-declaration sources,
 * used by `generate-byok-engine-reference.js` to build the engine reference
 * catalog queried by the BYOK `search_reference` tool (Phase 7.2).
 *
 * Two dialects are parsed:
 * - JavaScript (`Extensions/<name>/JsExtension.js`): `extension.addAction(...`,
 *   `.addParameter(...)` chains, `_('...')` translated strings.
 * - C++ (`Core/GDCore/Extensions/Builtin/*.cpp`): `extension.AddAction(...`,
 *   `.AddParameter(...)` chains, `_(`...`)` translated strings (including
 *   multi-line adjacent literals).
 *
 * The parser is deliberately regex-light and forgiving: an argument it
 * cannot reduce to a plain string is skipped, an entry with no parseable
 * name is skipped with a warning — a missed entry is much better than a
 * crashed or wrong generation. Pure functions only, so the Jest suite can
 * smoke-test it on fixture subsets.
 */

'use strict';

/**
 * Remove // and /* *​/ comments while preserving string literals (a `//`
 * inside a string — e.g. an URL — must not become a comment).
 */
const stripComments = (source) => {
  let result = '';
  let index = 0;
  const length = source.length;
  while (index < length) {
    const character = source[index];
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      result += character;
      index++;
      while (index < length) {
        const inner = source[index];
        result += inner;
        if (inner === '\\') {
          result += source[index + 1] || '';
          index += 2;
          continue;
        }
        index++;
        if (inner === quote) break;
      }
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      while (index < length && source[index] !== '\n') index++;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        index++;
      }
      index += 2;
      continue;
    }
    result += character;
    index++;
  }
  return result;
};

/**
 * Parse the argument list starting at `openParenIndex` ("(" expected there).
 * Returns the raw (trimmed) top-level arguments and the index right after
 * the matching closing paren — or null when the list is never closed.
 */
const parseArgumentList = (source, openParenIndex) => {
  if (source[openParenIndex] !== '(') return null;
  const args = [];
  // The initial paren is the first depth level and is not part of any arg.
  let depth = 1;
  let current = '';
  let index = openParenIndex + 1;
  const length = source.length;
  while (index < length) {
    const character = source[index];
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      current += character;
      index++;
      while (index < length) {
        const inner = source[index];
        current += inner;
        if (inner === '\\') {
          current += source[index + 1] || '';
          index += 2;
          continue;
        }
        index++;
        if (inner === quote) break;
      }
      continue;
    }
    if (character === '(' || character === '[' || character === '{') {
      depth++;
      current += character;
      index++;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      if (character === ')' && depth === 1) {
        // The closing paren matching the one we started from.
        if (current.trim() || args.length > 0) args.push(current.trim());
        return { args, endIndex: index + 1 };
      }
      depth--;
      current += character;
      index++;
      continue;
    }
    if (character === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      index++;
      continue;
    }
    current += character;
    index++;
  }
  return null;
};

const UNESCAPE_MAP = { n: '\n', t: '\t', r: '\r' };

/** Unescape the content of a string literal (no quotes included). */
const unescapeLiteralContent = (content) => {
  let result = '';
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (character !== '\\') {
      result += character;
      continue;
    }
    const next = content[index + 1] || '';
    result += UNESCAPE_MAP[next] !== undefined ? UNESCAPE_MAP[next] : next;
    index++;
  }
  return result;
};

/**
 * Reduce a raw argument to a plain string, or null when it is not one.
 * Accepted forms: `"..."`, `'...'`, `_("...")`, `_("..." "..." )`,
 * adjacent literals, and `+` concatenations of those (the C++ sources use
 * multi-line `_("a " "b")`, the JS sources sometimes `"a" + _("b")`).
 */
const unquoteArgument = (raw) => {
  const literals = [];
  let rest = '';
  let index = 0;
  const length = raw.length;
  while (index < length) {
    const character = raw[index];
    if (character === '"' || character === "'") {
      const quote = character;
      let content = '';
      index++;
      while (index < length) {
        const inner = raw[index];
        if (inner === '\\') {
          content += raw[index + 1] || '';
          index += 2;
          continue;
        }
        index++;
        if (inner === quote) break;
        content += inner;
      }
      literals.push(unescapeLiteralContent(content));
      rest += ' ';
      continue;
    }
    // Skip the translation wrapper and concatenation operator characters.
    if (character === '_' || character === '(' || character === ')' || character === '+') {
      rest += ' ';
      index++;
      continue;
    }
    if (/\s/.test(character)) {
      rest += ' ';
      index++;
      continue;
    }
    // Any other character (an identifier, a number, a function call…)
    // means this argument is not a plain string.
    rest += character;
    index++;
  }
  if (literals.length === 0) return null;
  if (rest.replace(/\s/g, '').length > 0) return null;
  return literals.join('');
};

const unquoteOrNull = (args, index) =>
  index < args.length ? unquoteArgument(args[index]) : null;

/**
 * The description of an entry. Instructions (actions, conditions,
 * expressions) have a stable sentence position; behaviors, objects and
 * effects do not (the description position varies across metadata
 * versions), so their longest string argument wins — tolerant by design.
 */
const pickDescription = (args, preferredIndex, longestOnly) => {
  const preferred = unquoteOrNull(args, preferredIndex);
  if (!longestOnly) {
    if (preferred && preferred.length >= 8) return preferred;
  }
  let longest = preferred || '';
  for (let index = 1; index < Math.min(args.length, 8); index++) {
    const candidate = unquoteOrNull(args, index);
    if (candidate && candidate.length > longest.length) longest = candidate;
  }
  return longest || preferred || '';
};

/** The string arguments that follow an instruction entry, as parameters. */
const parseChainedParameters = (source, searchStartIndex) => {
  const parameters = [];
  let cursor = searchStartIndex;
  for (;;) {
    const chainMatch = /^\s*\.\s*(?:add|Add)(?:CodeOnly)?Parameter\s*\(/.exec(
      source.slice(cursor, cursor + 80)
    );
    if (!chainMatch) break;
    const openParenIndex = cursor + chainMatch[0].length - 1;
    const parsed = parseArgumentList(source, openParenIndex);
    if (!parsed) break;
    const type = unquoteOrNull(parsed.args, 0) || '';
    const description = unquoteOrNull(parsed.args, 1) || '';
    parameters.push({ type, description });
    cursor = parsed.endIndex;
  }
  return { parameters, endIndex: cursor };
};

/**
 * Parse one extension source into reference entries.
 * `options`: { language: 'js' | 'cpp', ownerFallback: string, sourceName }.
 * Returns { entries, owner } — entries carry
 * {kind, owner, name, description, parameters}.
 */
const parseExtensionSource = (source, options) => {
  const isCpp = options.language === 'cpp';
  const clean = stripComments(source);
  const warnings = [];
  const entries = [];

  // The extension name: the first argument of the information call.
  let owner = null;
  const infoCall = isCpp
    ? /SetExtensionInformation\s*\(/.exec(clean)
    : /setExtensionInformation\s*\(/.exec(clean);
  if (infoCall) {
    const parsed = parseArgumentList(clean, infoCall.index + infoCall[0].length - 1);
    if (parsed) {
      owner = unquoteOrNull(parsed.args, 0);
    }
  }
  if (!owner) owner = options.ownerFallback || 'Unknown';

  // The entry-declaring calls, in one tolerant scan.
  const kindByMethod = {
    addAction: 'action',
    addCondition: 'condition',
    addExpression: 'expression',
    addStrExpression: 'expression',
    addBehavior: 'behavior',
    addObject: 'object',
    addEffect: 'effect',
    addScopedAction: 'action',
    addScopedCondition: 'condition',
    AddAction: 'action',
    AddCondition: 'condition',
    AddExpression: 'expression',
    AddStrExpression: 'expression',
    AddBehavior: 'behavior',
    AddObject: 'object',
    AddEffect: 'effect',
    AddDuplicatedAction: 'action',
    AddDuplicatedCondition: 'condition',
    AddDuplicatedExpression: 'expression',
    AddExpressionAndCondition: 'instruction-pair',
    addExpressionAndCondition: 'instruction-pair',
    AddExpressionAndConditionAndAction: 'instruction-triplet',
    addExpressionAndConditionAndAction: 'instruction-triplet',
  };
  const callPattern = new RegExp(
    `\\.\\s*(${Object.keys(kindByMethod)
      .map((name) => name.replace(/</g, '<'))
      .join('|')})(<[^>(]*>)?\\s*\\(`,
    'g'
  );

  let match;
  while ((match = callPattern.exec(clean))) {
    const methodName = match[1];
    const kind = kindByMethod[methodName];
    const openParenIndex = callPattern.lastIndex - 1;
    const parsed = parseArgumentList(clean, openParenIndex);
    if (!parsed) {
      warnings.push(`${options.sourceName}: unterminated ${methodName} call`);
      continue;
    }
    // Continue the scan after the chained parameters of this entry.
    const chain = parseChainedParameters(clean, parsed.endIndex);
    callPattern.lastIndex = Math.max(parsed.endIndex, chain.endIndex);

    const args = parsed.args;
    // Instruction triplets/pairs are declared as (type, name, …): their
    // name sits in argument 1, every other form starts with the name.
    const isInstructionGroup =
      kind === 'instruction-triplet' || kind === 'instruction-pair';
    const name = unquoteOrNull(args, isInstructionGroup ? 1 : 0);
    if (!name) {
      warnings.push(`${options.sourceName}: ${methodName} without a parseable name`);
      continue;
    }

    const pushEntry = (entryKind, entryName, description) => {
      if (!description) {
        warnings.push(
          `${options.sourceName}: ${entryKind} ${entryName} without a parseable description`
        );
      }
      entries.push({
        kind: entryKind,
        owner,
        name: entryName,
        description: description || '',
        parameters: chain.parameters,
      });
    };

    if (kind === 'instruction-triplet') {
      // (type, name, full label, condition sentence, action sentence, group, icon)
      pushEntry('condition', name, unquoteOrNull(args, 3) || unquoteOrNull(args, 2) || '');
      pushEntry('action', name, unquoteOrNull(args, 4) || unquoteOrNull(args, 2) || '');
      pushEntry('expression', name, unquoteOrNull(args, 2) || '');
      continue;
    }
    if (kind === 'instruction-pair') {
      // (type, name, full label, condition sentence, action sentence, group, icon)
      pushEntry('condition', name, unquoteOrNull(args, 3) || unquoteOrNull(args, 2) || '');
      pushEntry('action', name, unquoteOrNull(args, 4) || unquoteOrNull(args, 2) || '');
      continue;
    }
    if (kind === 'action' || kind === 'condition' || kind === 'expression') {
      // (name, label, sentence, group, icon) — the sentence is arg 2
      // (C++ and JS share this shape). Expressions: the label is the
      // human name and the sentence the description; same index.
      const duplicated = methodName.startsWith('AddDuplicated');
      pushEntry(
        kind,
        name,
        duplicated
          ? `Same as the ${kind} "${unquoteOrNull(args, 2) || ''}".`
          : pickDescription(args, 2, false)
      );
      continue;
    }
    // Behaviors, objects and effects: the description position varies with
    // the metadata version — use the longest string argument.
    pushEntry(kind, name, pickDescription(args, 2, true));
  }

  return { entries, owner, warnings };
};

module.exports = {
  stripComments,
  parseArgumentList,
  unquoteArgument,
  parseExtensionSource,
};
