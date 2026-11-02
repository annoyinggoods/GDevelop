// @flow
import { type AiRequestMessage } from '../../Utils/GDevelopServices/Generation';

/**
 * The context compaction (Phase 9.2): at ~75% of the model's window, the
 * oldest half of the transcript is summarized through the user's own
 * endpoint, a preserved block of durable facts is prepended, and the
 * expensive payloads go first — all old images (but the latest one), then
 * tool outputs older than the last few turns (one-line summaries). The
 * `byok-context-full` dead-end becomes a recoverable event.
 *
 * The module is a pure function over the transcript: the live sources of
 * the preserved block (project notes, plan, fresh snapshot, …) are built by
 * the orchestrator and passed in as text, and the summarizer (one extra
 * chat-completions call, `fast` profile) is injected so tests can mock it.
 */

/** Compaction triggers at this share of the context window. */
export const BYOK_COMPACTION_CONTEXT_RATIO = 0.75;

/** The user/assistant turns kept verbatim at the end of the transcript. */
export const BYOK_COMPACTION_KEEP_LAST_TURNS = 10;

/** Tool outputs older than the last this-many turns become one-liners. */
export const BYOK_COMPACTION_KEEP_LAST_TOOL_TURNS = 6;

/** Images kept through compaction: only the latest one of the chat. */
export const BYOK_IMAGES_KEPT_THROUGH_COMPACTION = 1;

/** The summarizer output cap (≈600 tokens at the 4-chars/token rule). */
export const BYOK_COMPACTION_SUMMARY_MAX_CHARS = 2400;

/** The one-line preview length of a dropped tool output. */
const TOOL_SUMMARY_PREVIEW_CHARS = 120;

const isUserTurnStart = (message: AiRequestMessage): boolean =>
  message.type === 'message' &&
  message.role === 'user' &&
  !(message: any).byokCompactionSynthetic;

const carriesToolCalls = (message: AiRequestMessage): boolean => {
  if (message.type !== 'message' || message.role !== 'assistant') {
    return false;
  }
  return message.content.some(item => item.type === 'function_call');
};

/**
 * The transcript index where the last `keepCount` TOOL ROUNDS begin (a
 * round is an assistant message carrying tool calls).
 *
 * The turn-based windows above collapse on the flagship single mega-turn
 * (one user message, dozens of tool rounds — the documented 50-100-round
 * build shape): with one or two user turns there is no index to cut at, so
 * compaction bailed out entirely and the chat dead-ended at
 * `byok-context-full` with most of the transcript mechanically compactable.
 * The tool-output trim only needs a ROUND boundary, so it gets one.
 */
export const findKeptToolRoundsStartIndex = (
  transcript: Array<AiRequestMessage>,
  keepCount: number
): number => {
  const roundStartIndices: Array<number> = [];
  for (let index = 0; index < transcript.length; index++) {
    if (carriesToolCalls(transcript[index])) roundStartIndices.push(index);
  }
  if (roundStartIndices.length <= keepCount) return 0;
  return roundStartIndices[roundStartIndices.length - keepCount];
};

/**
 * The two user-role messages a compaction prepends carry this BYOK-local
 * flag: they must not count as conversation turns (turn counting that
 * includes them makes every later compaction re-summarize the summary —
 * the churn of a compaction that cannot create headroom).
 */
export const makeByokCompactionSyntheticMessage = (
  text: string
): AiRequestMessage =>
  (({
    type: 'message',
    status: 'completed',
    role: 'user',
    content: [
      {
        type: 'user_request',
        status: 'completed',
        text,
      },
    ],
    byokCompactionSynthetic: true,
  }: any): AiRequestMessage);

/**
 * The transcript index where the last `keepCount` turns begin (a turn
 * starts at each user message). Returns 0 when the transcript has fewer
 * turns — nothing is old enough to compact.
 */
export const findKeptTurnsStartIndex = (
  transcript: Array<AiRequestMessage>,
  keepCount: number
): number => {
  const turnStartIndices: Array<number> = [];
  for (let index = 0; index < transcript.length; index++) {
    if (isUserTurnStart(transcript[index])) turnStartIndices.push(index);
  }
  if (turnStartIndices.length <= keepCount) return 0;
  return turnStartIndices[turnStartIndices.length - keepCount];
};

/** The one-line summary replacing an old tool output (its id stays valid). */
export const summarizeToolOutput = (output: string): string => {
  const preview = output.slice(0, TOOL_SUMMARY_PREVIEW_CHARS);
  return JSON.stringify({
    summarized: true,
    message: `[older tool output summarized — first characters: ${preview}]`,
  });
};

/** The digest of the old region the summarizer call receives. */
const buildOldRegionDigest = (
  oldMessages: Array<AiRequestMessage>,
  toolNameByCallId: Map<string, string>
): string => {
  const lines: Array<string> = [];
  for (const message of oldMessages) {
    if (message.type === 'function_call_output') {
      lines.push(`[tool result for ${message.call_id}: ${message.output}]`);
      continue;
    }
    if (message.type !== 'message') continue;
    if (message.role === 'user') {
      const text = message.content
        .filter(item => item.type === 'user_request')
        .map(item => item.text)
        .join(' ');
      if (text) lines.push(`User: ${text}`);
      continue;
    }
    if (message.role !== 'assistant') continue;
    for (const item of message.content) {
      if (item.type === 'output_text' && item.text) {
        lines.push(`Assistant: ${item.text}`);
      } else if (item.type === 'function_call') {
        const toolName = toolNameByCallId.get(item.call_id) || item.name;
        lines.push(`Assistant called ${toolName} with ${item.arguments}`);
      }
    }
  }
  return lines.join('\n');
};

/**
 * The image ids of the transcript, in order (the ByokTranscript reader —
 * re-implemented here on the compacted shapes so the compactor stays the
 * single owner of the drop order).
 */
const collectImageIds = (message: AiRequestMessage): Array<string> => {
  // Both referencing kinds count (tool outputs, and the user messages'
  // attached images since Phase 13.3): an old attachment is exactly the kind
  // of expensive payload the drop order exists for.
  if (message.type !== 'function_call_output') {
    const isUserMessage = message.type === 'message' && message.role === 'user';
    if (!isUserMessage) return [];
  }
  const images = (message: any).images;
  if (!Array.isArray(images)) return [];
  return images.filter((imageId: any) => typeof imageId === 'string');
};

export type ByokCompactionOutcome = {|
  /** The compacted transcript (a new array; the input is never mutated). */
  transcript: Array<AiRequestMessage>,
  /** What the summarizer call produced ('' when there was nothing to summarize). */
  summaryText: string,
  /** True when the summarizer call failed and the mechanical digest was used. */
  summarizerFailed: boolean,
  droppedImageCount: number,
  summarizedToolOutputCount: number,
  summarizedMessageCount: number,
|};

/**
 * Compact a transcript. Returns null when there is nothing to do: fewer
 * user turns than the keep window means the transcript is already "all
 * recent". The drop order is fixed: images first (all but the chat's latest
 * one), then old tool outputs (one-liners), and only the remaining old
 * user/assistant content goes through the summarizer.
 */
export const compactByokTranscript = async ({
  transcript,
  summarizer,
  preservedBlockText,
  keepLastTurns = BYOK_COMPACTION_KEEP_LAST_TURNS,
  keepLastToolTurns = BYOK_COMPACTION_KEEP_LAST_TOOL_TURNS,
  summaryMaxChars = BYOK_COMPACTION_SUMMARY_MAX_CHARS,
}: {|
  transcript: Array<AiRequestMessage>,
  summarizer: (digest: string) => Promise<string>,
  preservedBlockText: string,
  keepLastTurns?: number,
  keepLastToolTurns?: number,
  summaryMaxChars?: number,
|}): Promise<?ByokCompactionOutcome> => {
  const turnsStart = findKeptTurnsStartIndex(transcript, keepLastTurns);

  // The tool-output window prefers a turn boundary, but falls back to a
  // ROUND boundary when the chat is one big user turn (see
  // findKeptToolRoundsStartIndex).
  const toolTurnsStart = findKeptTurnsStartIndex(transcript, keepLastToolTurns);
  const toolRoundsStart = findKeptToolRoundsStartIndex(
    transcript,
    keepLastToolTurns
  );
  const toolTrimStart =
    toolTurnsStart > 0
      ? toolTurnsStart
      : toolRoundsStart > 0
      ? toolRoundsStart
      : 0;

  // Count the outputs this pass would actually SHORTEN: one that is
  // already a one-liner is left alone (summarizeToolOutput is a no-op on
  // it). Without this, a just-compacted transcript would keep returning a
  // non-null outcome that changes nothing, re-entering compaction every
  // round — the churn the B-CORE-5 fix closed.
  let trimmableToolOutputCount = 0;
  for (let index = 0; index < transcript.length; index++) {
    const message = transcript[index];
    if (message.type !== 'function_call_output') continue;
    if (index >= toolTrimStart) continue;
    if (summarizeToolOutput(message.output) === message.output) continue;
    trimmableToolOutputCount++;
  }

  // Nothing to summarize AND nothing to trim: there is genuinely nothing
  // this pass could reclaim.
  if (turnsStart === 0 && trimmableToolOutputCount === 0) return null;

  // Without a turn boundary there is no old region to summarize, so the
  // pass is a tool-output-only trim: a keptTurnsStart of -1 puts NO message
  // in the summarize region (index < -1 is never true), which keeps the
  // protocol pairs intact and simply turns the old bulky outputs into
  // one-liners.
  const keptTurnsStart = turnsStart === 0 ? -1 : turnsStart;

  // The latest image of the whole chat survives; every older one goes.
  const allImageIds: Array<string> = [];
  for (const message of transcript) {
    allImageIds.push(...collectImageIds(message));
  }
  const survivingImageIds = new Set(
    allImageIds.slice(-BYOK_IMAGES_KEPT_THROUGH_COMPACTION)
  );

  // call_id → tool name, so the digest and the one-liners can name the tool.
  const toolNameByCallId: Map<string, string> = new Map();
  for (const message of transcript) {
    if (message.type !== 'message' || message.role !== 'assistant') continue;
    for (const item of message.content) {
      if (item.type === 'function_call') {
        toolNameByCallId.set(item.call_id, item.name);
      }
    }
  }

  let droppedImageCount = 0;
  let summarizedToolOutputCount = 0;
  const summarizedMessages: Array<AiRequestMessage> = [];
  const keptMessages: Array<AiRequestMessage> = [];

  // Assistant messages carrying tool calls stay WITH their outputs (the
  // OpenAI protocol pairs them; splitting a pair across the summary
  // boundary would send orphan tool messages). They are compacted in
  // place: the outputs become one-liners, the call stays.

  for (let index = 0; index < transcript.length; index++) {
    const message = transcript[index];

    // The tool-output trim is INDEPENDENT of the keep window: an output
    // older than the tool-output window becomes a one-liner even when its
    // turn is recent enough to be kept (bulky payloads go first).
    const isOldToolOutput =
      message.type === 'function_call_output' && index < toolTrimStart;

    // The recent turns are kept verbatim; everything before them sheds its
    // images and its bulky tool payloads.
    const inTrimRegion = index < keptTurnsStart;
    if (!inTrimRegion && !isOldToolOutput) {
      keptMessages.push(message);
      continue;
    }

    const images = collectImageIds(message);
    let effectiveMessage = message;
    if (images.length > 0) {
      const surviving = images.filter(imageId =>
        survivingImageIds.has(imageId)
      );
      droppedImageCount += images.length - surviving.length;
      // The input messages are never mutated: images are dropped on a copy.
      effectiveMessage = { ...message };
      if (surviving.length === 0) {
        delete (effectiveMessage: any).images;
      } else {
        (effectiveMessage: any).images = surviving;
      }
    }

    if (isOldToolOutput) {
      summarizedToolOutputCount++;
      const outputMessage: any = effectiveMessage;
      keptMessages.push(
        (({
          ...effectiveMessage,
          output: summarizeToolOutput(outputMessage.output),
        }: any): AiRequestMessage)
      );
      continue;
    }

    // A tool call + its outputs are compacted in place (one-liner outputs
    // when they are older than the tool-output window), never summarized
    // away: the protocol needs the pair, the model needs the answer.
    if (carriesToolCalls(effectiveMessage)) {
      keptMessages.push(effectiveMessage);
      continue;
    }
    if (effectiveMessage.type === 'function_call_output') {
      // A recent-enough tool output: kept whole (its call stays too).
      keptMessages.push(effectiveMessage);
      continue;
    }

    // The old user requests and plain assistant text: what the summarizer
    // call condenses.
    summarizedMessages.push(effectiveMessage);
  }

  // The summarizer turns the old region into a short digest. A failing
  // summarizer call degrades to the mechanical digest: compaction must
  // never take the chat down.
  let summaryText = '';
  let summarizerFailed = false;
  if (summarizedMessages.length > 0) {
    const digest = buildOldRegionDigest(summarizedMessages, toolNameByCallId);
    try {
      summaryText = (await summarizer(digest)).slice(0, summaryMaxChars);
    } catch (error) {
      summarizerFailed = true;
      summaryText = digest.slice(0, summaryMaxChars);
    }
  }

  const compactedTranscript: Array<AiRequestMessage> = [];
  if (summaryText) {
    compactedTranscript.push(
      makeByokCompactionSyntheticMessage(
        `[Earlier conversation summarized to save context — the summary below replaces the original messages]\n${summaryText}`
      )
    );
  }
  if (preservedBlockText) {
    compactedTranscript.push(
      makeByokCompactionSyntheticMessage(
        `[Preserved context — keep following it]\n${preservedBlockText}`
      )
    );
  }
  compactedTranscript.push(...keptMessages);

  return {
    transcript: compactedTranscript,
    summaryText,
    summarizerFailed,
    droppedImageCount,
    summarizedToolOutputCount,
    summarizedMessageCount: summarizedMessages.length,
  };
};
