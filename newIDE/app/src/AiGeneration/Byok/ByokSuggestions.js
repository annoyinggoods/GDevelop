// @flow
import {
  type AiRequestMessage,
  type AiRequestSuggestions,
} from '../../Utils/GDevelopServices/Generation';
import {
  type ByokChatCompletionResponse,
  type ByokChatMessage,
} from './ByokTypes';
import { BYOK_SUGGESTIONS_COUNT, BYOK_FEEDBACK_CAPACITY } from './ByokTypes';

/**
 * The local suggestions & feedback (Phase 9.6): the hosted loop's follow-up
 * chips and thumbs, BYOK-owned. The chips come from ONE extra `fast`-profile
 * call after a chat goes ready (opt-in: the tokens are the user's), and are
 * attached to the last assistant message with the exact
 * `AiRequestSuggestions` shape the existing chat UI already renders. The
 * ratings stay in localStorage — nothing is ever sent anywhere — capped,
 * with a JSON export for prompt iteration.
 */

const SUGGESTION_SYSTEM_PROMPT =
  'You suggest short follow-up messages the user of a game-creation AI chat could send next. ' +
  'Answer with a JSON array of objects {"title": "<2-5 words>", "suggestedMessage": "<one short sentence>"}. ' +
  `Give exactly ${BYOK_SUGGESTIONS_COUNT} suggestions, nothing else in the answer.`;

/** The chat tail the suggestion call sees (text only, cheap). */
export const buildByokSuggestionMessages = ({
  transcript,
  tailMessageCount = 12,
}: {|
  transcript: Array<AiRequestMessage>,
  tailMessageCount?: number,
|}): Array<ByokChatMessage> => {
  const lines: Array<string> = [];
  for (const message of transcript.slice(-tailMessageCount)) {
    if (((message: any).type: string) === 'byok_notice') continue;
    if (message.type === 'function_call_output') {
      lines.push(`[tool result: ${message.output.slice(0, 200)}]`);
      continue;
    }
    if (message.role === 'user') {
      const text = message.content
        .filter(item => item.type === 'user_request')
        .map(item => item.text)
        .join(' ');
      if (text) lines.push(`User: ${text}`);
      continue;
    }
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter(item => item.type === 'output_text')
      .map(item => item.text)
      .join(' ');
    if (text) lines.push(`Assistant: ${text}`);
  }

  return [
    { role: 'system', content: SUGGESTION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Here is the end of the chat:\n${lines.join(
        '\n'
      )}\n\nSuggest the ${BYOK_SUGGESTIONS_COUNT} follow-ups now.`,
    },
  ];
};

const MAX_SUGGESTION_TITLE_CHARS = 60;
const MAX_SUGGESTION_MESSAGE_CHARS = 300;

/**
 * Parse the suggestion call's answer into the `AiRequestSuggestions` shape
 * the chat UI renders, or null when the answer is unusable. Titles and
 * messages are capped; at most BYOK_SUGGESTIONS_COUNT suggestions survive.
 */
export const parseByokSuggestions = (
  response: ByokChatCompletionResponse
): ?AiRequestSuggestions => {
  const choice = response.choices[0];
  const message = choice ? choice.message : null;
  const text =
    message && typeof message.content === 'string' ? message.content : '';
  if (!text.trim()) return null;

  // The model may wrap the JSON array in prose or code fences: take the
  // first [...] span.
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;

  let parsed: mixed = null;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const suggestions: Array<{
    title: string,
    suggestedMessage: string,
  }> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const record: Object = entry;
    if (
      typeof record.title !== 'string' ||
      typeof record.suggestedMessage !== 'string'
    ) {
      continue;
    }
    suggestions.push({
      title: record.title.slice(0, MAX_SUGGESTION_TITLE_CHARS),
      suggestedMessage: record.suggestedMessage.slice(
        0,
        MAX_SUGGESTION_MESSAGE_CHARS
      ),
    });
    if (suggestions.length >= BYOK_SUGGESTIONS_COUNT) break;
  }
  if (suggestions.length === 0) return null;

  return {
    explanationMessage: 'What next?',
    suggestions,
  };
};

export type ByokSuggestionCaller = ({|
  messages: Array<ByokChatMessage>,
|}) => Promise<ByokChatCompletionResponse>;

/**
 * Fetch the follow-up suggestions for a finished chat and return them in
 * the UI shape, or null (caller decided off, the endpoint failed, or the
 * answer was unusable — suggestions are best-effort by design).
 */
export const fetchByokSuggestions = async ({
  enabled,
  transcript,
  callModel,
}: {|
  enabled: boolean,
  transcript: Array<AiRequestMessage>,
  callModel: ByokSuggestionCaller,
|}): Promise<?AiRequestSuggestions> => {
  if (!enabled) return null;
  if (transcript.length === 0) return null;

  try {
    const response = await callModel({
      messages: buildByokSuggestionMessages({ transcript }),
    });
    return parseByokSuggestions(response);
  } catch (error) {
    console.info('BYOK suggestions: the suggestion call failed.', error);
    return null;
  }
};

/**
 * Attach suggestions to the last assistant message of the transcript (the
 * field the chat UI already renders). Returns true when attached.
 */
export const attachByokSuggestions = (
  transcript: Array<AiRequestMessage>,
  suggestions: AiRequestSuggestions
): boolean => {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const message = transcript[index];
    if (message.type !== 'message' || message.role !== 'assistant') continue;
    (message: any).suggestions = suggestions;
    return true;
  }
  return false;
};

// ---- Local feedback (thumbs up/down), a prompt-iteration signal only ----

const BYOK_FEEDBACK_STORAGE_ITEM = 'gd-byok-feedback';

export type ByokFeedbackEntry = {|
  chatId: string,
  messageId: string,
  rating: 'like' | 'dislike',
  timestamp: string,
|};

/** All stored feedback, oldest first (untrusted data is dropped). */
export const listByokFeedback = (): Array<ByokFeedbackEntry> => {
  try {
    const raw = localStorage.getItem(BYOK_FEEDBACK_STORAGE_ITEM);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: Array<ByokFeedbackEntry> = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const record: Object = entry;
      if (
        typeof record.chatId !== 'string' ||
        typeof record.messageId !== 'string' ||
        (record.rating !== 'like' && record.rating !== 'dislike') ||
        typeof record.timestamp !== 'string'
      ) {
        continue;
      }
      entries.push({
        chatId: record.chatId,
        messageId: record.messageId,
        rating: record.rating,
        timestamp: record.timestamp,
      });
    }
    return entries;
  } catch (error) {
    console.error('Unable to read the BYOK feedback store:', error);
    return [];
  }
};

/**
 * Store one rating locally. When the store is full, the oldest entries are
 * dropped first — it is an iteration signal, not an archive.
 */
export const recordByokFeedback = (entry: {|
  chatId: string,
  messageId: string,
  rating: 'like' | 'dislike',
|}): void => {
  try {
    const entries = listByokFeedback();
    entries.push({ ...entry, timestamp: new Date().toISOString() });
    const capped = entries.slice(-BYOK_FEEDBACK_CAPACITY);
    localStorage.setItem(BYOK_FEEDBACK_STORAGE_ITEM, JSON.stringify(capped));
  } catch (error) {
    console.error('Unable to store the BYOK feedback:', error);
  }
};

/** The feedback store as pretty-printed JSON (the settings export button). */
export const exportByokFeedbackJson = (): string =>
  JSON.stringify(
    { exportedAt: new Date().toISOString(), feedback: listByokFeedback() },
    null,
    2
  );

/** Test-only: wipe the feedback store. */
export const resetByokFeedbackForTests = (): void => {
  try {
    localStorage.removeItem(BYOK_FEEDBACK_STORAGE_ITEM);
  } catch (error) {
    // Ignore: nothing to wipe.
  }
};
