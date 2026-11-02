/**
 * @jest-environment jsdom
 */
// @flow
import type { AiRequestMessage } from '../../Utils/GDevelopServices/Generation';
import {
  attachByokSuggestions,
  buildByokSuggestionMessages,
  exportByokFeedbackJson,
  fetchByokSuggestions,
  listByokFeedback,
  parseByokSuggestions,
  recordByokFeedback,
  resetByokFeedbackForTests,
} from './ByokSuggestions';
import { BYOK_FEEDBACK_CAPACITY } from './ByokTypes';

const userMessage = (text: string): AiRequestMessage => ({
  type: 'message',
  status: 'completed',
  role: 'user',
  content: [{ type: 'user_request', status: 'completed', text }],
});

const assistantText = (text: string): AiRequestMessage => ({
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [
    { type: 'output_text', status: 'completed', text, annotations: [] },
  ],
});

const makeResponse = (content: string): any => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

describe('ByokSuggestions: the suggestion call', () => {
  it('is skipped entirely when the toggle is off (no call, no chips)', async () => {
    const callModel = (jest.fn(): any);
    const suggestions = await fetchByokSuggestions({
      enabled: false,
      transcript: [userMessage('make a game')],
      callModel,
    });
    expect(suggestions).toBe(null);
    expect(callModel).not.toHaveBeenCalled();
  });

  it('builds the prompt from the chat tail and parses the chips', async () => {
    const callModel = (jest.fn(): any).mockResolvedValue(
      makeResponse(
        '```json\n[{"title": "Add a score", "suggestedMessage": "Add a score displayed on screen"}, {"title": "Add sound", "suggestedMessage": "Add sound effects"}, {"title": "More levels", "suggestedMessage": "Create a second level"}]\n```'
      )
    );
    const transcript = [userMessage('make a game'), assistantText('Done!')];
    const suggestions = await fetchByokSuggestions({
      enabled: true,
      transcript,
      callModel,
    });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(suggestions).not.toBe(null);
    expect(suggestions && suggestions.suggestions).toHaveLength(3);
    expect(suggestions && suggestions.suggestions[0].title).toBe('Add a score');
    expect(
      suggestions && typeof suggestions.explanationMessage === 'string'
    ).toBe(true);
  });

  it('degrades to null on a failing or unusable suggestion call', async () => {
    const failing = await fetchByokSuggestions({
      enabled: true,
      transcript: [userMessage('hello')],
      callModel: async () => {
        throw new Error('overloaded');
      },
    });
    expect(failing).toBe(null);

    const unusable = await fetchByokSuggestions({
      enabled: true,
      transcript: [userMessage('hello')],
      callModel: async () => makeResponse('I cannot suggest anything.'),
    });
    expect(unusable).toBe(null);
  });
});

describe('ByokSuggestions: the suggestion shape', () => {
  it('matches what the chat UI expects (title + suggestedMessage)', () => {
    const parsed = parseByokSuggestions(
      makeResponse(
        '[{"title": "t", "suggestedMessage": "m"}, {"title": "t2", "suggestedMessage": "m2", "extra": 1}]'
      )
    );
    expect(parsed && parsed.suggestions).toEqual([
      { title: 't', suggestedMessage: 'm' },
      { title: 't2', suggestedMessage: 'm2' },
    ]);
  });

  it('caps titles, message lengths and the suggestion count', () => {
    const many = [];
    for (let index = 0; index < 8; index++) {
      many.push(
        `{"title": "${'t'.repeat(
          80
        )}${index}", "suggestedMessage": "${'m'.repeat(400)}"}`
      );
    }
    const parsed = parseByokSuggestions(makeResponse(`[${many.join(',')}]`));
    expect(parsed && parsed.suggestions.length).toBeLessThanOrEqual(3);
    const first = parsed && parsed.suggestions[0];
    expect(first && first.title.length).toBeLessThanOrEqual(60);
    expect(first && first.suggestedMessage.length).toBeLessThanOrEqual(300);
  });

  it('returns null on malformed JSON or missing fields', () => {
    expect(parseByokSuggestions(makeResponse('[{broken'))).toBe(null);
    expect(parseByokSuggestions(makeResponse('[{"title": 1}]'))).toBe(null);
    expect(parseByokSuggestions(makeResponse('[]'))).toBe(null);
  });
});

describe('ByokSuggestions: attaching the chips', () => {
  it('attaches to the last assistant message', () => {
    const transcript = [userMessage('hi'), assistantText('done')];
    const attached = attachByokSuggestions(transcript, {
      explanationMessage: 'What next?',
      suggestions: [{ title: 't', suggestedMessage: 'm' }],
    });
    expect(attached).toBe(true);
    const lastAssistant = transcript[transcript.length - 1];
    expect(((lastAssistant: any).suggestions: any).suggestions).toHaveLength(1);
  });

  it('returns false on a transcript without an assistant message', () => {
    const transcript = [userMessage('hi')];
    expect(
      attachByokSuggestions(transcript, {
        explanationMessage: '',
        suggestions: [],
      })
    ).toBe(false);
  });
});

describe('ByokSuggestions: the local feedback store', () => {
  beforeEach(() => {
    resetByokFeedbackForTests();
  });

  it('records ratings locally with a timestamp, never sending anything', () => {
    recordByokFeedback({ chatId: 'c1', messageId: 'm1', rating: 'like' });
    const entries = listByokFeedback();
    expect(entries).toHaveLength(1);
    expect(entries[0].chatId).toBe('c1');
    expect(entries[0].rating).toBe('like');
    expect(entries[0].timestamp).toBeTruthy();
  });

  it('drops the oldest entries beyond the capacity', () => {
    for (let index = 0; index < BYOK_FEEDBACK_CAPACITY + 10; index++) {
      recordByokFeedback({
        chatId: 'c',
        messageId: `m-${index}`,
        rating: 'dislike',
      });
    }
    const entries = listByokFeedback();
    expect(entries).toHaveLength(BYOK_FEEDBACK_CAPACITY);
    expect(entries[0].messageId).toBe('m-10');
    expect(entries[entries.length - 1].messageId).toBe(
      `m-${BYOK_FEEDBACK_CAPACITY + 9}`
    );
  });

  it('exports pretty-printed JSON', () => {
    recordByokFeedback({ chatId: 'c1', messageId: 'm1', rating: 'like' });
    const exported = JSON.parse(exportByokFeedbackJson());
    expect(exported.feedback).toHaveLength(1);
    expect(exported.exportedAt).toBeTruthy();
  });
});

describe('ByokSuggestions: the prompt builder', () => {
  it('carries the chat tail and skips notice rows', () => {
    const transcript: Array<AiRequestMessage> = [
      userMessage('hello'),
      (({
        type: 'byok_notice',
        status: 'completed',
        noticeKind: 'stall',
        text: 'nag',
      }: any): AiRequestMessage),
      assistantText('the answer'),
    ];
    const messages = buildByokSuggestionMessages({ transcript });
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    const prompt = messages[1].content;
    expect(prompt).toContain('User: hello');
    expect(prompt).toContain('Assistant: the answer');
    expect(prompt).not.toContain('nag');
  });
});
