// @flow

/**
 * Parse EventScript source (the syntax `read_events_source` returns and the
 * hosted agent's `event_script` field uses) into serialized gd events — the
 * JSON shape `unserializeFrom` consumes (`gd.Serializer` objects).
 *
 * The grammar is derived from the editor-side serializer
 * (`EventScriptRenderer.js`) and its conformance fixtures
 * (`EventScriptRenderer.fixtures.json`); the canonical parser lives in the
 * private GDevelop-services repository, so this one is written from the
 * renderer's rendering rules — anything the renderer emits must parse back.
 *
 * Hidden (code-only) instruction parameters are dropped by the renderer and
 * re-inserted here from the instruction metadata, exactly like the hosted
 * compilation does: without the refill, every parameter after the first
 * code-only slot would shift and the event would misbehave at runtime.
 */

/**
 * A parse failure pointing at the offending line, so a model can fix its
 * EventScript from the message alone.
 */
export type ByokEventScriptParseError = {|
  message: string,
  lineNumber: number,
  columnNumber: number,
  lineText: string,
|};

export type ByokEventScriptParseResult =
  | {| events: Array<Object> |}
  | {| error: ByokEventScriptParseError |};

/**
 * The instruction metadata the parameter refill needs: how the platform
 * declares the parameters of one instruction (condition or action). The
 * default provider reads libGD's MetadataProvider (the same source the
 * renderer uses); tests inject fakes.
 */
export type ByokInstructionMetadata = {|
  // False for unknown instructions (no metadata: parameters are kept as-is).
  isKnown: boolean,
  parameterCount: number,
  isParameterCodeOnly: (index: number) => boolean,
|};

export type ByokInstructionMetadataProvider = (
  kind: 'condition' | 'action',
  instructionType: string
) => ByokInstructionMetadata;

const makeUnknownInstructionMetadata = (): ByokInstructionMetadata => ({
  isKnown: false,
  parameterCount: 0,
  isParameterCodeOnly: () => false,
});

/**
 * The default metadata provider: libGD's platform metadata, read lazily so
 * importing this module never requires libGD to be loaded first (and unit
 * tests of the pure parsing rules can inject a fake).
 */
export const makeLibGdInstructionMetadataProvider = (): ByokInstructionMetadataProvider => (
  kind,
  instructionType
) => {
  const gd: libGDevelop = global.gd;
  if (!gd) return makeUnknownInstructionMetadata();

  const metadata =
    kind === 'condition'
      ? gd.MetadataProvider.getConditionMetadata(
          gd.JsPlatform.get(),
          instructionType
        )
      : gd.MetadataProvider.getActionMetadata(
          gd.JsPlatform.get(),
          instructionType
        );
  if (gd.MetadataProvider.isBadInstructionMetadata(metadata)) {
    return makeUnknownInstructionMetadata();
  }
  return {
    isKnown: true,
    parameterCount: metadata.getParametersCount(),
    isParameterCodeOnly: index =>
      index < metadata.getParametersCount() &&
      metadata.getParameter(index).isCodeOnly(),
  };
};

/** The internal failure carrying the position of the offending line. */
class ByokEventScriptSyntaxError {
  message: string;
  lineNumber: number;
  columnNumber: number;
  lineText: string;

  constructor(
    message: string,
    lineNumber: number,
    columnNumber: number,
    lineText: string
  ) {
    this.message = message;
    this.lineNumber = lineNumber;
    this.columnNumber = columnNumber;
    this.lineText = lineText;
  }
}

type ByokSourceLine = {|
  text: string,
  lineNumber: number,
|};

const INDENT_WIDTH = 2;

const ONCE_TYPE = 'BuiltinCommonInstructions::Once';
const OR_TYPE = 'BuiltinCommonInstructions::Or';
const AND_TYPE = 'BuiltinCommonInstructions::And';
const NOT_TYPE = 'BuiltinCommonInstructions::Not';

/**
 * Split the source into lines, normalizing line endings. Line numbers are
 * 1-based (what an editor or a model would count).
 */
const splitSourceLines = (source: string): Array<ByokSourceLine> => {
  return source.split(/\r?\n/).map((text, index) => ({
    text,
    lineNumber: index + 1,
  }));
};

/** Leading spaces of a statement line; -1 for blank or comment-only lines. */
const getLineIndent = (text: string): number => {
  const matches = /^ */.exec(text);
  return matches ? matches[0].length : 0;
};

const isSkippableLine = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed === '' || trimmed.startsWith('#');
};

/** Strip the trailing `# event-N.M` id annotation the renderer appends. */
const stripIdAnnotation = (text: string): string => {
  return text.replace(/\s+#\s*event-[\d.]+\s*$/, '');
};

/** Strip the trailing `:` of a header line (must be present). */
const stripTrailingColon = (text: string): string => {
  if (!text.endsWith(':')) {
    return text;
  }
  return text.slice(0, -1);
};

/**
 * Read the content of a double-quoted EventScript string literal
 * (group "…", comment "…", link "…"), unescaping \\, \" and \n — the exact
 * inverse of the renderer's escapeStringLiteral.
 */
const parseStringLiteral = (text: string): string => {
  let content = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character !== '\\') {
      content += character;
      index++;
      continue;
    }
    // An escape: \n, \" or \\ (anything else is kept verbatim, lenient).
    const nextCharacter = text[index + 1];
    if (nextCharacter === 'n') content += '\n';
    else if (nextCharacter === '"' || nextCharacter === '\\') {
      content += nextCharacter;
    } else content += character + (nextCharacter || '');
    index += 2;
  }
  return content;
};

/**
 * Parse the quoted literal of a standalone statement (`group "…"`,
 * `comment "…"`, `link "…"`) — everything after the keyword, which must be
 * one quoted literal spanning the rest of the line.
 */
const parseStandaloneQuotedArgument = (
  keyword: string,
  statementText: string,
  line: ByokSourceLine
): string => {
  const afterKeyword = statementText.slice(keyword.length).trim();
  if (!afterKeyword.startsWith('"') || !afterKeyword.endsWith('"')) {
    throw new ByokEventScriptSyntaxError(
      `The ${keyword} statement expects a double-quoted text, e.g. ${keyword} "My text".`,
      line.lineNumber,
      statementText.length,
      line.text
    );
  }
  if (afterKeyword.length < 2) {
    throw new ByokEventScriptSyntaxError(
      `The ${keyword} statement expects a double-quoted text.`,
      line.lineNumber,
      statementText.length,
      line.text
    );
  }
  return parseStringLiteral(afterKeyword.slice(1, -1));
};

/**
 * Reverse of the renderer's escapeParameterValue: parameters have their real
 * newlines escaped to the two characters \n (the only escape the renderer
 * applies to parameter values — see the grammar note in
 * EventScriptRenderer.js).
 */
const unescapeParameterValue = (value: string): string => {
  return value.split('\\n').join('\n');
};

/**
 * Find the index of the closing parenthesis matching the one at openIndex,
 * skipping string literals (a quote after a backslash never closes the
 * literal). Returns -1 when unmatched.
 */
const findMatchingParen = (text: string, openIndex: number): number => {
  let depth = 0;
  let inString = false;
  for (let index = openIndex; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (character === '\\') index++;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '(') depth++;
    else if (character === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
};

/**
 * Split a text on the top-level occurrences of a keyword (like ' and ' or
 * ' index '), ignoring everything inside parentheses and string literals.
 * Returns [before, after] of the LAST occurrence, or null when absent —
 * parsing loop clauses from the end is easiest on the last match (the
 * header grammar orders its clauses).
 */
const splitOnLastTopLevelKeyword = (
  text: string,
  keyword: string
): [string, string] | null => {
  let depth = 0;
  let inString = false;
  let lastIndex = -1;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (character === '\\') index++;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (
      depth === 0 &&
      text.startsWith(keyword, index) &&
      index > lastIndex
    ) {
      lastIndex = index;
    }
  }
  if (lastIndex === -1) return null;
  return [text.slice(0, lastIndex), text.slice(lastIndex + keyword.length)];
};

/**
 * Split a text on every top-level occurrence of a separator (',' or '
 * and '), ignoring parentheses and string literals.
 */
const splitOnTopLevelSeparator = (
  text: string,
  separator: string
): Array<string> => {
  const parts: Array<string> = [];
  let depth = 0;
  let inString = false;
  let partStart = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (character === '\\') index++;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (depth === 0 && text.startsWith(separator, index)) {
      parts.push(text.slice(partStart, index));
      partStart = index + separator.length;
      index += separator.length - 1;
    }
  }
  parts.push(text.slice(partStart));
  return parts;
};

/** True when the text is wrapped in one top-level parenthesized group. */
const isParenthesizedGroup = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return false;
  return findMatchingParen(trimmed, 0) === trimmed.length - 1;
};

/**
 * Re-insert the code-only (hidden) parameter slots the renderer drops, and
 * pad the trailing optional slots the renderer trims: the serialized
 * parameters array must line up with the metadata positions for the event
 * to run correctly. Extra arguments beyond the declared parameters are
 * appended (stale-project parity with the renderer).
 */
const refillInstructionParameters = (
  parsedArguments: Array<string>,
  metadata: ByokInstructionMetadata
): Array<string> => {
  if (!metadata.isKnown) return parsedArguments;

  const parameters: Array<string> = [];
  let argumentIndex = 0;
  for (let index = 0; index < metadata.parameterCount; index++) {
    if (metadata.isParameterCodeOnly(index)) {
      parameters.push('');
      continue;
    }
    parameters.push(parsedArguments[argumentIndex] || '');
    argumentIndex++;
  }
  for (; argumentIndex < parsedArguments.length; argumentIndex++) {
    parameters.push(parsedArguments[argumentIndex]);
  }
  return parameters;
};

/**
 * Drop the trailing empty arguments the renderer trims when it serializes
 * (middle empties are meaningful: Unknown(A, , B)); an explicit empty-string
 * literal "" is a real operand and kept.
 */
const trimTrailingEmptyArguments = (
  argumentsList: Array<string>
): Array<string> => {
  const trimmed = argumentsList.slice();
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') {
    trimmed.pop();
  }
  return trimmed;
};

/**
 * Parse a `Type(args)` call into its serialized instruction pieces: the
 * type name and the raw (refilled) parameter values. Awaited actions set
 * `awaited` (serialized as the `await` attribute of the type element).
 */
const parseInstructionCall = (
  callText: string,
  line: ByokSourceLine,
  kind: 'condition' | 'action',
  metadataProvider: ByokInstructionMetadataProvider
): {| type: string, parameters: Array<string> |} => {
  const trimmed = callText.trim();
  const openIndex = trimmed.indexOf('(');
  if (openIndex === -1) {
    throw new ByokEventScriptSyntaxError(
      `Expected ${kind} as Type(arguments), e.g. Timer(2, "SpawnTimer").`,
      line.lineNumber,
      1,
      line.text
    );
  }
  const typeName = trimmed.slice(0, openIndex).trim();
  if (!/^[A-Za-z0-9_]+(::[A-Za-z0-9_]+)*$/.test(typeName)) {
    throw new ByokEventScriptSyntaxError(
      `"${typeName}" is not a valid ${kind} type name.`,
      line.lineNumber,
      1,
      line.text
    );
  }
  const closeIndex = findMatchingParen(trimmed, openIndex);
  if (closeIndex === -1 || closeIndex !== trimmed.length - 1) {
    throw new ByokEventScriptSyntaxError(
      `The ${kind} "${typeName}" has unclosed parentheses.`,
      line.lineNumber,
      openIndex + 1,
      line.text
    );
  }

  const argumentsText = trimmed.slice(openIndex + 1, closeIndex);
  const trimmedArguments = trimTrailingEmptyArguments(
    splitOnTopLevelSeparator(argumentsText, ',').map(argument =>
      argument.trim()
    )
  );
  const parsedArguments = trimmedArguments.map(unescapeParameterValue);

  const metadata = metadataProvider(kind, typeName);
  return {
    type: typeName,
    parameters: refillInstructionParameters(parsedArguments, metadata),
  };
};

/**
 * Parse one condition expression (as found inside `if …`, or as an operand
 * of a composition) into a serialized condition.
 */
const parseSingleCondition = (
  conditionText: string,
  line: ByokSourceLine,
  metadataProvider: ByokInstructionMetadataProvider
): Object => {
  const trimmed = conditionText.trim();
  if (trimmed === '') {
    throw new ByokEventScriptSyntaxError(
      'An empty condition was found where one was expected.',
      line.lineNumber,
      1,
      line.text
    );
  }

  // `once` (and its inverted form through the not-branch below).
  if (trimmed === 'once') {
    return {
      type: { value: ONCE_TYPE },
      parameters: [],
    };
  }

  // Inversion prefix: flips the flag of whatever follows (a call, a
  // composition or `once`).
  if (trimmed.startsWith('not ')) {
    const inner = parseSingleCondition(
      trimmed.slice('not '.length),
      line,
      metadataProvider
    );
    const innerType = inner.type;
    return {
      ...inner,
      type: {
        value: innerType.value,
        inverted: !innerType.inverted,
      },
    };
  }

  // Parenthesized group: an explicit AND of its content — unwrap a single
  // condition, keep the composition for several.
  if (isParenthesizedGroup(trimmed)) {
    const innerConditions = parseConditionsList(
      trimmed.slice(1, -1),
      line,
      metadataProvider
    );
    if (innerConditions.length === 1) return innerConditions[0];
    return {
      type: { value: AND_TYPE },
      parameters: [],
      subInstructions: innerConditions,
    };
  }

  // Compositions Or(…), And(…) and Not(…) — the renderer emits their short
  // names, mapped back to the builtin type they serialize as.
  const compositionShortNames = [
    ['Or(', OR_TYPE],
    ['And(', AND_TYPE],
    ['Not(', NOT_TYPE],
  ];
  const composition = compositionShortNames.find(([shortName]) =>
    trimmed.startsWith(shortName)
  );
  if (composition) {
    const compositionType = composition[1];
    const openIndex = composition[0].length - 1;
    const closeIndex = findMatchingParen(trimmed, openIndex);
    if (closeIndex !== trimmed.length - 1) {
      throw new ByokEventScriptSyntaxError(
        `The ${composition[0].slice(
          0,
          -1
        )} composition has unclosed parentheses.`,
        line.lineNumber,
        1,
        line.text
      );
    }
    const operandsText = trimmed.slice(openIndex + 1, closeIndex);
    const subInstructions = splitOnTopLevelSeparator(operandsText, ',')
      .map(operand => operand.trim())
      .filter(operand => operand !== '')
      .map(operand => parseSingleCondition(operand, line, metadataProvider));
    return {
      type: { value: compositionType },
      parameters: [],
      subInstructions,
    };
  }

  const call = parseInstructionCall(
    trimmed,
    line,
    'condition',
    metadataProvider
  );
  return {
    type: { value: call.type },
    parameters: call.parameters,
  };
};

/**
 * Parse a conditions expression — conditions of a list are an implicit AND,
 * joined by ` and ` at the top level.
 */
const parseConditionsList = (
  conditionsText: string,
  line: ByokSourceLine,
  metadataProvider: ByokInstructionMetadataProvider
): Array<Object> => {
  if (conditionsText.trim() === '') return [];
  return splitOnTopLevelSeparator(conditionsText, ' and ')
    .map(conditionText => conditionText.trim())
    .filter(conditionText => conditionText !== '')
    .map(conditionText =>
      parseSingleCondition(conditionText, line, metadataProvider)
    );
};

/**
 * Parse one action line: `Type(args)`, optionally `await Type(args)`.
 */
const parseActionLine = (
  actionText: string,
  line: ByokSourceLine,
  metadataProvider: ByokInstructionMetadataProvider
): Object => {
  const trimmed = actionText.trim();
  const awaited = trimmed.startsWith('await ');
  const callText = awaited ? trimmed.slice('await '.length) : trimmed;
  const call = parseInstructionCall(callText, line, 'action', metadataProvider);
  const type: Object = { value: call.type };
  if (awaited) type.await = true;
  return {
    type,
    parameters: call.parameters,
  };
};

const VARIABLE_TYPES = ['number', 'string', 'boolean', 'structure', 'array'];

/**
 * Convert a JSON value (the right-hand side of a `local` declaration) to
 * the serialized fields of a gd variable.
 */
const serializeLocalVariableValue = (
  value: mixed
): {| type: string, value?: string, children?: Object |} => {
  if (typeof value === 'number') {
    return { type: 'number', value: String(value) };
  }
  if (typeof value === 'boolean') {
    return { type: 'boolean', value: value ? 'true' : 'false' };
  }
  if (Array.isArray(value)) {
    const children: Object = {};
    value.forEach((item, index) => {
      children[String(index)] = serializeLocalVariableValue(item);
    });
    return { type: 'array', children };
  }
  if (value && typeof value === 'object') {
    const children: Object = {};
    for (const childName of Object.keys(value)) {
      children[childName] = serializeLocalVariableValue(value[childName]);
    }
    return { type: 'structure', children };
  }
  // null and undefined behave like empty strings (a fresh variable).
  return { type: 'string', value: typeof value === 'string' ? value : '' };
};

/**
 * Parse a `local <type> Name = <JSON>` declaration into its serialized
 * event-variable shape.
 */
const parseLocalVariableLine = (
  statementText: string,
  line: ByokSourceLine
): Object => {
  const matches = /^local (\S+) (\S+) = ([\s\S]+)$/.exec(statementText);
  if (!matches) {
    throw new ByokEventScriptSyntaxError(
      'Malformed local variable declaration — expected: local number Count = 3.',
      line.lineNumber,
      1,
      line.text
    );
  }
  const variableType = matches[1];
  const variableName = matches[2];
  if (!VARIABLE_TYPES.includes(variableType)) {
    throw new ByokEventScriptSyntaxError(
      `Unknown local variable type "${variableType}" — expected one of: ${VARIABLE_TYPES.join(
        ', '
      )}.`,
      line.lineNumber,
      1,
      line.text
    );
  }

  let parsedValue: mixed = null;
  try {
    parsedValue = JSON.parse(matches[3]);
  } catch (error) {
    throw new ByokEventScriptSyntaxError(
      `The value of the local variable "${variableName}" is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      line.lineNumber,
      1,
      line.text
    );
  }
  return {
    name: variableName,
    ...serializeLocalVariableValue(parsedValue),
  };
};

/**
 * Extract a clause whose value is a single word (an index/value/key name, a
 * limit number): anchored at the end of the head text, like the renderer
 * emits it. Returns [headWithoutClause, clauseValue] or null.
 */
const extractEndAnchoredWordClause = (
  head: string,
  keyword: string
): [string, string] | null => {
  const matches = new RegExp(` ${keyword} (\\S+)$`).exec(head);
  if (!matches) return null;
  return [head.slice(0, matches.index), matches[1]];
};

/**
 * Extract the trailing ` if <conditions>` clause of a loop header: its value
 * can contain spaces (a conditions expression), so it is found with a
 * top-level scan (parentheses and string literals ignored) instead of a
 * regex. Returns [headWithoutClause, conditionsText] or null.
 */
const extractEndAnchoredIfClause = (head: string): [string, string] | null => {
  const split = splitOnLastTopLevelKeyword(head, ' if ');
  if (!split) return null;
  const [before, after] = split;
  // Everything after the last top-level ` if ` is the clause (the renderer
  // always puts it last), so this split is the anchored one.
  return [before, after];
};

const parseRepeatHeader = (
  statementText: string,
  line: ByokSourceLine,
  metadataProvider: ByokInstructionMetadataProvider
): Object => {
  let head = statementText;
  const ifSplit = extractEndAnchoredIfClause(head);
  let ifClause = '';
  if (ifSplit) {
    head = ifSplit[0];
    ifClause = ifSplit[1];
  }
  const indexSplit = extractEndAnchoredWordClause(head, 'index');
  let indexClause = '';
  if (indexSplit) {
    head = indexSplit[0];
    indexClause = indexSplit[1];
  }
  if (!head.endsWith(' times')) {
    throw new ByokEventScriptSyntaxError(
      'Malformed repeat statement — expected: repeat 5 times (or: repeat 5 times index I if Condition()).',
      line.lineNumber,
      1,
      line.text
    );
  }
  const event: Object = {
    type: 'BuiltinCommonInstructions::Repeat',
    repeatExpression: head.slice('repeat '.length, -' times'.length).trim(),
    conditions: parseConditionsList(ifClause, line, metadataProvider),
  };
  if (indexClause) event.loopIndexVariable = indexClause;
  return event;
};

const parseWhileHeader = (
  statementText: string,
  line: ByokSourceLine,
  metadataProvider: ByokInstructionMetadataProvider
): Object => {
  let head = statementText;
  const ifSplit = extractEndAnchoredIfClause(head);
  let ifClause = '';
  if (ifSplit) {
    head = ifSplit[0];
    ifClause = ifSplit[1];
  }
  const indexSplit = extractEndAnchoredWordClause(head, 'index');
  let indexClause = '';
  if (indexSplit) {
    head = indexSplit[0];
    indexClause = indexSplit[1];
  }
  const event: Object = {
    type: 'BuiltinCommonInstructions::While',
    whileConditions: parseConditionsList(
      head.slice('while '.length).trim(),
      line,
      metadataProvider
    ),
    conditions: parseConditionsList(ifClause, line, metadataProvider),
  };
  if (indexClause) event.loopIndexVariable = indexClause;
  return event;
};

const parseForEachHeader = (
  statementText: string,
  line: ByokSourceLine,
  metadataProvider: ByokInstructionMetadataProvider
): Object => {
  let head = statementText;
  const ifSplit = extractEndAnchoredIfClause(head);
  let ifClause = '';
  if (ifSplit) {
    head = ifSplit[0];
    ifClause = ifSplit[1];
  }
  const indexSplit = extractEndAnchoredWordClause(head, 'index');
  let indexClause = '';
  if (indexSplit) {
    head = indexSplit[0];
    indexClause = indexSplit[1];
  }
  const limitSplit = extractEndAnchoredWordClause(head, 'limit');
  let limitClause = '';
  if (limitSplit) {
    head = limitSplit[0];
    limitClause = limitSplit[1];
  }
  // ` order by <expression> asc|desc` — extracted last: by then it is the
  // only clause left, so a plain end-anchored regex is unambiguous.
  const event: Object = {
    type: 'BuiltinCommonInstructions::ForEach',
    object: head.slice('for each '.length).trim(),
    conditions: parseConditionsList(ifClause, line, metadataProvider),
  };
  const orderMatch = / order by (.*) (asc|desc)$/.exec(head);
  if (orderMatch) {
    event.orderBy = orderMatch[1].trim();
    event.order = orderMatch[2];
    event.object = head.slice('for each '.length, orderMatch.index).trim();
  }
  if (limitClause) event.limit = limitClause;
  if (indexClause) event.loopIndexVariable = indexClause;
  return event;
};

const parseForEachChildHeader = (
  statementText: string,
  line: ByokSourceLine,
  metadataProvider: ByokInstructionMetadataProvider
): Object => {
  let head = statementText;
  const ifSplit = extractEndAnchoredIfClause(head);
  let ifClause = '';
  if (ifSplit) {
    head = ifSplit[0];
    ifClause = ifSplit[1];
  }
  const indexSplit = extractEndAnchoredWordClause(head, 'index');
  let indexClause = '';
  if (indexSplit) {
    head = indexSplit[0];
    indexClause = indexSplit[1];
  }
  const keySplit = extractEndAnchoredWordClause(head, 'key');
  let keyClause = '';
  if (keySplit) {
    head = keySplit[0];
    keyClause = keySplit[1];
  }
  const valueSplit = extractEndAnchoredWordClause(head, 'value');
  let valueClause = '';
  if (valueSplit) {
    head = valueSplit[0];
    valueClause = valueSplit[1];
  }
  const event: Object = {
    type: 'BuiltinCommonInstructions::ForEachChildVariable',
    iterableVariableName: head.slice('for each child in '.length).trim(),
    conditions: parseConditionsList(ifClause, line, metadataProvider),
  };
  event.valueIteratorVariableName = valueClause;
  event.keyIteratorVariableName = keyClause;
  if (indexClause) event.loopIndexVariable = indexClause;
  return event;
};

/**
 * The classification of one statement (an event header, or an own-body line
 * of the event above it).
 */
type ByokStatementKind =
  | 'standard-if'
  | 'standard-always'
  | 'else'
  | 'else-if'
  | 'while'
  | 'repeat'
  | 'for-each'
  | 'for-each-child'
  | 'group'
  | 'comment'
  | 'link'
  | 'js-code'
  | 'local-variable'
  | 'action'
  | 'pass';

/**
 * Whether a statement opens a JavaScript code fence: `js """` or
 * `js(<objects>) """` (the objects are the instances the code can use).
 */
const isJsCodeHeader = (statementText: string): boolean =>
  /^js(\([^)]*\))?\s*"""$/.test(statementText.trim());

const classifyStatement = (statementText: string): ByokStatementKind => {
  if (statementText === 'always') return 'standard-always';
  if (statementText === 'else') return 'else';
  if (statementText === 'pass') return 'pass';
  if (statementText.startsWith('else if ')) return 'else-if';
  if (statementText.startsWith('if ')) return 'standard-if';
  if (statementText.startsWith('while ')) return 'while';
  if (statementText.startsWith('repeat ')) return 'repeat';
  if (statementText.startsWith('for each child in ')) return 'for-each-child';
  if (statementText.startsWith('for each ')) return 'for-each';
  if (statementText.startsWith('group ')) return 'group';
  if (statementText.startsWith('comment ')) return 'comment';
  if (statementText.startsWith('link ')) return 'link';
  // A JavaScript code event: `js """` or `js(<objects>) """`, opening a
  // fence whose code lines are read until the closing `"""`.
  if (isJsCodeHeader(statementText)) return 'js-code';
  if (statementText.startsWith('local ')) return 'local-variable';
  return 'action';
};

/**
 * Build the event object of one header statement (without its body).
 * Standalone statements (comment, link) are marked so the caller can reject
 * a body under them.
 */
const parseEventHeader = (
  kind: ByokStatementKind,
  statementText: string,
  line: ByokSourceLine,
  metadataProvider: ByokInstructionMetadataProvider
): {| event: Object, isStandalone: boolean |} => {
  if (kind === 'comment') {
    return {
      event: {
        type: 'BuiltinCommonInstructions::Comment',
        comment: parseStandaloneQuotedArgument('comment', statementText, line),
      },
      isStandalone: true,
    };
  }
  if (kind === 'link') {
    return {
      event: {
        type: 'BuiltinCommonInstructions::Link',
        target: parseStandaloneQuotedArgument('link', statementText, line),
      },
      isStandalone: true,
    };
  }
  if (kind === 'group') {
    return {
      event: {
        type: 'BuiltinCommonInstructions::Group',
        name: parseStandaloneQuotedArgument('group', statementText, line),
      },
      isStandalone: false,
    };
  }
  if (kind === 'js-code') {
    const parameterObjects = parseJsCodeParameterObjects(statementText);
    return {
      event: {
        type: 'BuiltinCommonInstructions::JsCode',
        // The code is read from the lines of the fence (see parseJsCodeBody).
        inlineCode: '',
        parameterObjects,
        useStrict: true,
        eventsSheetExpanded: false,
      },
      isStandalone: false,
    };
  }
  if (kind === 'standard-always') {
    return {
      event: {
        type: 'BuiltinCommonInstructions::Standard',
        conditions: [],
      },
      isStandalone: false,
    };
  }
  if (kind === 'standard-if') {
    return {
      event: {
        type: 'BuiltinCommonInstructions::Standard',
        conditions: parseConditionsList(
          statementText.slice('if '.length),
          line,
          metadataProvider
        ),
      },
      isStandalone: false,
    };
  }
  if (kind === 'else') {
    return {
      event: {
        type: 'BuiltinCommonInstructions::Else',
        conditions: [],
      },
      isStandalone: false,
    };
  }
  if (kind === 'else-if') {
    return {
      event: {
        type: 'BuiltinCommonInstructions::Else',
        conditions: parseConditionsList(
          statementText.slice('else if '.length),
          line,
          metadataProvider
        ),
      },
      isStandalone: false,
    };
  }
  if (kind === 'while') {
    return {
      event: parseWhileHeader(statementText, line, metadataProvider),
      isStandalone: false,
    };
  }
  if (kind === 'repeat') {
    return {
      event: parseRepeatHeader(statementText, line, metadataProvider),
      isStandalone: false,
    };
  }
  if (kind === 'for-each') {
    return {
      event: parseForEachHeader(statementText, line, metadataProvider),
      isStandalone: false,
    };
  }
  return {
    event: parseForEachChildHeader(statementText, line, metadataProvider),
    isStandalone: false,
  };
};

/**
 * The objects of a `js(<objects>) """` header: the instances the code
 * can use. Empty when the header has no parenthesis.
 */
const parseJsCodeParameterObjects = (statementText: string): string => {
  const match = /^js\(([^)]*)\)\s*"""$/.exec(statementText.trim());
  return match ? match[1].trim() : '';
};

/**
 * Read the code of a JavaScript code event: the lines of the fence, until
 * the closing `"""`. The code is taken verbatim (the renderer keeps it
 * character for character), with the line endings normalized to LF.
 */
const parseJsCodeBody = (
  lines: Array<ByokSourceLine>,
  startIndex: number,
  headerLine: ByokSourceLine
): {| inlineCode: string, nextIndex: number |} => {
  // The renderer re-indents the code of the event by the indentation of the
  // event itself, so the code is stored relative to the fence: the common
  // indentation of the header is removed from every line.
  const baseIndent = getLineIndent(headerLine.text);
  const codeLines: Array<string> = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (line.text.trim() === '"""') {
      return { inlineCode: codeLines.join('\n'), nextIndex: index + 1 };
    }
    const text = line.text;
    codeLines.push(
      baseIndent > 0 && text.startsWith(' '.repeat(baseIndent))
        ? text.slice(baseIndent)
        : text
    );
    index++;
  }
  throw new ByokEventScriptSyntaxError(
    'This JavaScript code event is never closed: the `"""` that ends it is missing.',
    headerLine.lineNumber,
    1,
    headerLine.text
  );
};

/** Parse the events of one depth level until a line is shallower. */
const parseEventsList = (
  lines: Array<ByokSourceLine>,
  startIndex: number,
  depth: number,
  metadataProvider: ByokInstructionMetadataProvider
): {| events: Array<Object>, nextIndex: number |} => {
  const events: Array<Object> = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (isSkippableLine(line.text)) {
      index++;
      continue;
    }
    const indent = getLineIndent(line.text);
    if (indent < depth) break;
    if (indent > depth) {
      throw new ByokEventScriptSyntaxError(
        `This line is indented ${indent} spaces, expected ${depth} (two per level).`,
        line.lineNumber,
        indent + 1,
        line.text
      );
    }

    const statementText = stripTrailingColon(
      stripIdAnnotation(line.text).trim()
    );
    // The renderer prefixes disabled events with `disabled ` — strip it and
    // set the serialized flag.
    const isDisabled = statementText.startsWith('disabled ');
    const headerText = isDisabled
      ? statementText.slice('disabled '.length)
      : statementText;
    const kind = classifyStatement(headerText);
    if (!isEventHeaderKind(kind)) {
      throw new ByokEventScriptSyntaxError(
        `"${headerText}" is not an event statement — expected one of: if …:, always:, else:, else if …:, while …:, repeat … times:, for each …:, for each child in …:, group "…":, comment "…", link "…", js """…""".`,
        line.lineNumber,
        1,
        line.text
      );
    }
    const { event, isStandalone } = parseEventHeader(
      kind,
      headerText,
      line,
      metadataProvider
    );
    if (isDisabled) event.disabled = true;
    events.push(event);
    index++;

    // A JavaScript code event has no sub-events: its body is the fence of
    // code, read until the closing `"""`.
    if (kind === 'js-code') {
      const { inlineCode, nextIndex } = parseJsCodeBody(lines, index, line);
      event.inlineCode = inlineCode;
      index = nextIndex;
      continue;
    }

    if (isStandalone) {
      const followUp = index < lines.length ? lines[index] : null;
      if (
        followUp &&
        !isSkippableLine(followUp.text) &&
        getLineIndent(followUp.text) > depth
      ) {
        throw new ByokEventScriptSyntaxError(
          'comment and link events cannot have a body.',
          followUp.lineNumber,
          getLineIndent(followUp.text) + 1,
          followUp.text
        );
      }
      continue;
    }

    index = parseEventBody(lines, index, depth, event, metadataProvider);
  }
  return { events, nextIndex: index };
};

/**
 * Parse the own-body lines (local variables, actions, pass) and the
 * sub-events of one event, filling the serialized event object.
 */
const parseEventBody = (
  lines: Array<ByokSourceLine>,
  startIndex: number,
  eventDepth: number,
  event: Object,
  metadataProvider: ByokInstructionMetadataProvider
): number => {
  const bodyDepth = eventDepth + INDENT_WIDTH;
  const variables: Array<Object> = [];
  const actions: Array<Object> = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (isSkippableLine(line.text)) {
      index++;
      continue;
    }
    const indent = getLineIndent(line.text);
    if (indent <= eventDepth) break;
    if (indent !== bodyDepth) {
      throw new ByokEventScriptSyntaxError(
        `This line is indented ${indent} spaces, expected ${bodyDepth} (one level under its event).`,
        line.lineNumber,
        indent + 1,
        line.text
      );
    }

    const statementText = stripTrailingColon(
      stripIdAnnotation(line.text).trim()
    );
    const kind = classifyStatement(statementText);
    if (kind === 'local-variable') {
      variables.push(parseLocalVariableLine(statementText, line));
      index++;
      continue;
    }
    if (kind === 'pass') {
      index++;
      continue;
    }
    if (isEventHeaderKind(kind)) {
      const subEvents = parseEventsList(
        lines,
        index,
        bodyDepth,
        metadataProvider
      );
      event.events = (event.events || []).concat(subEvents.events);
      index = subEvents.nextIndex;
      continue;
    }
    actions.push(parseActionLine(statementText, line, metadataProvider));
    index++;
  }

  if (variables.length > 0) event.variables = variables;
  if (actions.length > 0) event.actions = actions;
  return index;
};

/** True when the statement kind starts a new (sub-)event. */
const isEventHeaderKind = (kind: ByokStatementKind): boolean => {
  if (kind === 'comment') return true;
  if (kind === 'link') return true;
  if (kind === 'standard-if') return true;
  if (kind === 'standard-always') return true;
  if (kind === 'else') return true;
  if (kind === 'else-if') return true;
  if (kind === 'while') return true;
  if (kind === 'repeat') return true;
  if (kind === 'for-each') return true;
  if (kind === 'for-each-child') return true;
  if (kind === 'js-code') return true;
  return kind === 'group';
};

/**
 * Parse EventScript source into serialized events. Returns the events, or
 * one positioned error a model can fix its source from.
 */
export const parseByokEventScript = (
  source: string,
  options?: {|
    metadataProvider?: ByokInstructionMetadataProvider,
  |}
): ByokEventScriptParseResult => {
  const metadataProvider =
    (options && options.metadataProvider) ||
    makeLibGdInstructionMetadataProvider();

  try {
    const lines = splitSourceLines(source);
    const { events } = parseEventsList(lines, 0, 0, metadataProvider);
    return { events };
  } catch (error) {
    if (error instanceof ByokEventScriptSyntaxError) {
      return {
        error: {
          message: error.message,
          lineNumber: error.lineNumber,
          columnNumber: error.columnNumber,
          lineText: error.lineText,
        },
      };
    }
    return {
      error: {
        message: error instanceof Error ? error.message : String(error),
        lineNumber: 1,
        columnNumber: 1,
        lineText: source.split(/\r?\n/)[0] || '',
      },
    };
  }
};
