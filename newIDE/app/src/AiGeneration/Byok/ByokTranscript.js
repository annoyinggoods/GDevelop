// @flow
import {
  type AiRequest,
  type AiRequestContextStats,
  type AiRequestFunctionCallOutput,
  type AiRequestMessage,
} from '../../Utils/GDevelopServices/Generation';
import {
  type ByokUserContentItem,
  type ByokImageInfo,
} from './ByokImageContent';
import {
  type ByokChatCompletionResponse,
  type ByokChatMessage,
  type ByokToolCall,
} from './ByokTypes';

/**
 * Translate between the OpenAI chat-completions messages (what the user's
 * endpoint speaks) and the internal transcript items (`AiRequestMessage`,
 * what the existing chat UI renders and `AiRequestUtils.js` walks).
 * The internal shapes are the ones of `Generation.js`: assistant messages
 * with an `output_text` / `function_call` content array, user messages with
 * a `user_request` content, and standalone `function_call_output` messages
 * for the tool results.
 *
 * Tool results may carry images (screenshot tools): the ids are stored on
 * the output item and materialized at replay time as a following `user`
 * message with `image_url` content parts — the OpenAI-compatible way to
 * show a tool result image to the model.
 */

/**
 * A function_call_output that references images by id (the base type is
 * inexact upstream, so this is a local extension of it).
 */
export type ByokFunctionCallOutputWithImages = AiRequestFunctionCallOutput & {
  images?: Array<string>,
};

/**
 * Map a chat-completions response to one assistant transcript message. The
 * content array holds an `output_text` item when the model answered with
 * text (skipped when empty), and one `function_call` item per tool call
 * asked by the model. (The content items are the subset of
 * `AiRequestAssistantMessage['content']` this mapper produces — the
 * `reasoning` variant only exists on hosted transcripts. The array is
 * typed any: Flow cannot prove the exact-variant compatibility.)
 */
export const byokResponseToAssistantMessage = (
  response: ByokChatCompletionResponse
): AiRequestMessage => {
  const choice = response.choices[0];
  const message = choice ? choice.message : null;

  // Array<any>: the pushed items are valid AiRequestAssistantMessage
  // content, but Flow cannot prove the exact-variant compatibility.
  const content: Array<any> = [];

  const text =
    message && typeof message.content === 'string' ? message.content : null;
  if (text) {
    content.push({
      type: 'output_text',
      status: 'completed',
      text,
      annotations: [],
    });
  }

  const toolCalls: Array<ByokToolCall> =
    message && message.tool_calls ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    content.push({
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    });
  }

  return {
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content,
  };
};

/**
 * Map a tool result (already serialized to a JSON string, like
 * `getFunctionCallOutputsFromEditorFunctionCallResults` does) to the
 * standalone transcript message that carries it — optionally referencing
 * the images the result produced (see byokMessagesForTranscriptItem).
 */
export const byokToolResultToFunctionCallOutput = (
  callId: string,
  resultJsonString: string,
  images?: Array<string>
): AiRequestMessage => {
  // Built through any: the images extension is not on the upstream
  // AiRequestFunctionCallOutput type (it is a BYOK-local field).
  const output: any = {
    type: 'function_call_output',
    call_id: callId,
    output: resultJsonString,
  };
  if (images && images.length > 0) output.images = images;
  return output;
};

/**
 * The image ids referenced by a transcript, in order — the basis of the
 * latest-N eviction rule. Both referencing message kinds count: tool outputs
 * (screenshots) and user messages (the "+" attach button, Phase 13.3).
 */
export const getByokTranscriptImageIds = (
  messages: Array<AiRequestMessage>
): Array<string> => {
  const imageIds: Array<string> = [];
  for (const message of messages) {
    if (isByokNoticeMessage(message)) continue;
    const images = (message: any).images;
    if (!Array.isArray(images)) continue;
    for (const imageId of images) {
      if (typeof imageId === 'string') imageIds.push(imageId);
    }
  }
  return imageIds;
};

/**
 * The ids that survive eviction when only the latest `keepCount` images of
 * a chat are re-sent (0 or less keeps none — `slice(-0)` would keep them
 * all, the classic negative-zero trap).
 */
export const getByokSurvivingImageIds = (
  messages: Array<AiRequestMessage>,
  keepCount: number
): Set<string> => {
  if (keepCount <= 0) return new Set();
  const imageIds = getByokTranscriptImageIds(messages);
  return new Set(imageIds.slice(-keepCount));
};

/**
 * The monotonic survival rule of the append-only replay (Phase 14.1): every
 * image survives EXCEPT the ids an explicit eviction dropped. Unlike the
 * latest-N window above, new images never retroactively evict older ones —
 * a mid-transcript message must never change between requests, or the
 * provider prefix cache is re-busted on every capture.
 */
export const getByokSurvivingImageIdsExcluding = (
  messages: Array<AiRequestMessage>,
  evictedImageIds: Set<string>
): Set<string> => {
  const surviving: Set<string> = new Set();
  for (const imageId of getByokTranscriptImageIds(messages)) {
    if (!evictedImageIds.has(imageId)) surviving.add(imageId);
  }
  return surviving;
};

/**
 * The images of one output item that the replay should materialize, with a
 * placeholder note for the evicted ones.
 */
const getByokImagePartsForOutput = (
  images: Array<string>,
  options: {|
    imagesEnabled: boolean,
    survivingImageIds: Set<string>,
    getImage: (id: string) => ?ByokImageInfo,
  |}
): Array<ByokUserContentItem> => {
  const parts: Array<ByokUserContentItem> = [];
  for (const imageId of images) {
    if (!options.imagesEnabled) continue;
    if (!options.survivingImageIds.has(imageId)) continue;
    const image = options.getImage(imageId);
    if (!image) continue;
    parts.push({
      type: 'image_url',
      image_url: { url: image.dataUrl },
    });
  }
  return parts;
};

/**
 * Map the text typed by the user to the OpenAI message of the request body.
 * (The system prompt of the orchestrator is a separate `system` message,
 * built by the loop in Phase 4 — not folded into the user message.)
 */
export const userRequestToByokMessage = (text: string): ByokChatMessage => ({
  role: 'user',
  content: text,
});

/**
 * A BYOK-local transcript row for orchestrator notices (Phase 9): the stall
 * watchdog's in-chat message (9.1), the "Context summarized" compaction row
 * (9.2), the rate-limit backoff line (9.7). It renders as a subtle info row
 * in the chat UI and is NEVER replayed to the model — it is not part of the
 * conversation, only of what the user sees.
 */
export type ByokNoticeKind =
  | 'stall'
  | 'context-summarized'
  | 'rate-limited'
  | 'snapshot-stale';

export type ByokNoticeMessage = {|
  type: 'byok_notice',
  status: 'completed',
  noticeKind: ByokNoticeKind,
  text: string,
|};

export const isByokNoticeMessage = (message: any): boolean =>
  message && message.type === 'byok_notice';

export const makeByokNotice = (
  noticeKind: ByokNoticeKind,
  text: string
): ByokNoticeMessage => ({
  type: 'byok_notice',
  status: 'completed',
  noticeKind,
  text,
});

/**
 * Map one internal transcript item to the OpenAI messages of the request
 * body. Tool outputs referencing images add a following `user` message
 * carrying `[tool result image]` plus the surviving image parts (older
 * images get a one-line placeholder, per the eviction rule) — with images
 * disabled, no part is ever emitted. Notice rows replay to nothing.
 */
export const byokMessagesForTranscriptItem = (
  aiRequestMessage: AiRequestMessage,
  options?: {|
    imagesEnabled?: boolean,
    survivingImageIds?: Set<string>,
    getImage?: (id: string) => ?ByokImageInfo,
  |}
): Array<ByokChatMessage> => {
  if (isByokNoticeMessage(aiRequestMessage)) return [];

  const imagesEnabled = options ? options.imagesEnabled !== false : true;
  const survivingImageIds =
    options && options.survivingImageIds
      ? options.survivingImageIds
      : new Set(getByokTranscriptImageIds([aiRequestMessage]));
  const getImage =
    options && options.getImage ? options.getImage : (id: string) => null;

  if (aiRequestMessage.type === 'function_call_output') {
    const messages: Array<ByokChatMessage> = [
      {
        role: 'tool',
        content: aiRequestMessage.output,
        tool_call_id: aiRequestMessage.call_id,
      },
    ];
    const images = (aiRequestMessage: any).images;
    if (!images || !Array.isArray(images) || images.length === 0) {
      return messages;
    }

    const parts = getByokImagePartsForOutput(images, {
      imagesEnabled,
      survivingImageIds,
      getImage,
    });
    if (!imagesEnabled) return messages;

    const noteLines: Array<string> = ['[tool result image]'];
    for (const imageId of images) {
      if (survivingImageIds.has(imageId)) continue;
      noteLines.push(
        `[screenshot ${imageId} removed to save context — call the capture tool again if needed]`
      );
    }
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: noteLines.join('\n') }, ...parts],
    });
    return messages;
  }

  // A user message with attached images (the "+" button, Phase 13.3) is
  // replayed as a multi-part content: the typed text plus the surviving
  // image parts — the same OpenAI vision format the tool outputs use.
  // Evicted attachments leave a placeholder note (mirroring the tool-output
  // branch) so the model knows an image it references is gone instead of
  // silently seeing text-only.
  if (aiRequestMessage.type === 'message' && aiRequestMessage.role === 'user') {
    const images = (aiRequestMessage: any).images;
    if (Array.isArray(images) && images.length > 0 && imagesEnabled) {
      const text = aiRequestMessage.content
        .filter(item => item.type === 'user_request')
        .map(item => item.text)
        .join(' ');
      const parts = getByokImagePartsForOutput(images, {
        imagesEnabled,
        survivingImageIds,
        getImage,
      });
      const noteLines: Array<string> = [text];
      for (const imageId of images) {
        if (survivingImageIds.has(imageId)) continue;
        noteLines.push(
          `[attachment ${imageId} removed to save context — attach it again if needed]`
        );
      }
      return [
        {
          role: 'user',
          content: [{ type: 'text', text: noteLines.join('\n') }, ...parts],
        },
      ];
    }
  }

  return [assistantMessageToByokMessage(aiRequestMessage)];
};

/**
 * Rebuild a single OpenAI message out of an internal transcript item
 * (images are never materialized here — see byokMessagesForTranscriptItem
 * for the image-aware replay):
 * - a user message becomes a `user` message;
 * - an assistant message becomes an `assistant` message, with its text
 *   and/or its tool calls;
 * - a `function_call_output` becomes a `tool` message carrying the result
 *   of the tool call identified by `tool_call_id`.
 */
export const assistantMessageToByokMessage = (
  aiRequestMessage: AiRequestMessage
): ByokChatMessage => {
  if (aiRequestMessage.type === 'function_call_output') {
    return {
      role: 'tool',
      content: aiRequestMessage.output,
      tool_call_id: aiRequestMessage.call_id,
    };
  }

  if (aiRequestMessage.role === 'user') {
    const text = aiRequestMessage.content
      .filter(item => item.type === 'user_request')
      .map(item => item.text)
      .join(' ');
    return { role: 'user', content: text };
  }

  const contentItems = aiRequestMessage.content;
  const text = contentItems
    .filter(item => item.type === 'output_text')
    .map(item => item.text)
    .join('\n');

  const toolCalls: Array<ByokToolCall> = [];
  for (const item of contentItems) {
    if (item.type !== 'function_call') continue;
    toolCalls.push({
      id: item.call_id,
      type: 'function',
      function: {
        name: item.name,
        arguments: item.arguments,
      },
    });
  }

  if (toolCalls.length === 0) {
    return { role: 'assistant', content: text || null };
  }
  return { role: 'assistant', content: text || null, tool_calls: toolCalls };
};

/**
 * The id of a BYOK transcript message (Phase 8.6): `<chat id>-m<n>`, unique
 * per chat and stable across forks (a fork's copied items keep their
 * original ids — the fork UI targets them).
 */
export const makeByokMessageId = (chatId: string, index: number): string =>
  `${chatId}-m${index}`;

/**
 * The minimal `AiRequest` a BYOK chat starts from: the same shape the chat
 * UI and `AiRequestUtils.js` consume, with an empty transcript. The
 * `orchestrator` mode is what the chat UI keys its plan component on (see
 * ChatMessages.js) — without it, the plan tool's output renders as raw JSON.
 * Phase 4's store builds on this (ids prefixed `byok-`).
 */
export const createByokAiRequestShell = (
  id: string,
  contextStats?: AiRequestContextStats
): AiRequest => {
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    userId: '',
    status: 'working',
    mode: 'orchestrator',
    error: null,
    output: [],
    contextStats: contextStats || null,
  };
};
