// @flow
import {
  assistantMessageToByokMessage,
  byokMessagesForTranscriptItem,
  byokResponseToAssistantMessage,
  byokToolResultToFunctionCallOutput,
  createByokAiRequestShell,
  getByokSurvivingImageIds,
  getByokSurvivingImageIdsExcluding,
  getByokTranscriptImageIds,
  isByokNoticeMessage,
  makeByokNotice,
  userRequestToByokMessage,
} from './ByokTranscript';
import { getFunctionCallsToProcess } from '../AiRequestUtils';
import { type AiRequestMessage } from '../../Utils/GDevelopServices/Generation';
import {
  type ByokChatCompletionResponse,
  type ByokToolCall,
} from './ByokTypes';

const makeToolCall = (
  id: string,
  name: string,
  args?: string
): ByokToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: args || '{}' },
});

const makeResponse = (
  content?: string | null,
  toolCalls?: Array<ByokToolCall>
): ByokChatCompletionResponse => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: content === undefined ? 'Done!' : content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const makeUserRequestMessage = (text: string): AiRequestMessage => ({
  type: 'message',
  status: 'completed',
  role: 'user',
  content: [{ type: 'user_request', status: 'completed', text }],
});

describe('byokResponseToAssistantMessage', () => {
  it('maps a response with text and 2 tool calls to one assistant message with 3 content items', () => {
    const message = byokResponseToAssistantMessage(
      makeResponse('Let me check.', [
        makeToolCall('call-1', 'describe_instances', '{"scene_name":"Scene"}'),
        makeToolCall('call-2', 'read_scene_events'),
      ])
    );

    expect(message.type).toBe('message');
    expect(message.status).toBe('completed');
    if (message.type !== 'message' || message.role !== 'assistant') {
      throw new Error('Expected an assistant message');
    }
    expect(message.content).toHaveLength(3);
    expect(message.content[0]).toEqual({
      type: 'output_text',
      status: 'completed',
      text: 'Let me check.',
      annotations: [],
    });
    expect(message.content[1]).toEqual({
      type: 'function_call',
      status: 'completed',
      call_id: 'call-1',
      name: 'describe_instances',
      arguments: '{"scene_name":"Scene"}',
    });
    expect(message.content[2]).toEqual({
      type: 'function_call',
      status: 'completed',
      call_id: 'call-2',
      name: 'read_scene_events',
      arguments: '{}',
    });
  });

  it('skips the output_text item when the model answers with no text', () => {
    const message = byokResponseToAssistantMessage(
      makeResponse(null, [makeToolCall('call-1', 'create_scene')])
    );
    if (message.type !== 'message') throw new Error('Expected a message');
    expect(message.content).toHaveLength(1);
    expect(message.content[0].type).toBe('function_call');
  });

  it('maps a text-only response to a single output_text item', () => {
    const message = byokResponseToAssistantMessage(makeResponse('Done!'));
    if (message.type !== 'message') throw new Error('Expected a message');
    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toEqual({
      type: 'output_text',
      status: 'completed',
      text: 'Done!',
      annotations: [],
    });
  });

  it('maps an empty response to an assistant message with no content', () => {
    const message = byokResponseToAssistantMessage(makeResponse(null));
    if (message.type !== 'message') throw new Error('Expected a message');
    expect(message.content).toEqual([]);
  });
});

describe('byokToolResultToFunctionCallOutput', () => {
  it('maps a tool result to a standalone function_call_output message', () => {
    expect(
      byokToolResultToFunctionCallOutput(
        'call-1',
        '{"success":true,"message":"Created."}'
      )
    ).toEqual({
      type: 'function_call_output',
      call_id: 'call-1',
      output: '{"success":true,"message":"Created."}',
    });
  });
});

describe('userRequestToByokMessage', () => {
  it('maps the user text to a user message', () => {
    expect(userRequestToByokMessage('Create a scene')).toEqual({
      role: 'user',
      content: 'Create a scene',
    });
  });
});

describe('assistantMessageToByokMessage', () => {
  it('rebuilds an assistant message with its tool calls (call_ids preserved)', () => {
    const assistantMessage = byokResponseToAssistantMessage(
      makeResponse('Checking.', [
        makeToolCall('call-1', 'describe_instances', '{"scene_name":"Scene"}'),
      ])
    );

    expect(assistantMessageToByokMessage(assistantMessage)).toEqual({
      role: 'assistant',
      content: 'Checking.',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'describe_instances',
            arguments: '{"scene_name":"Scene"}',
          },
        },
      ],
    });
  });

  it('rebuilds a tool result as a tool message with tool_call_id', () => {
    const output = byokToolResultToFunctionCallOutput(
      'call-1',
      '{"success":true}'
    );

    expect(assistantMessageToByokMessage(output)).toEqual({
      role: 'tool',
      content: '{"success":true}',
      tool_call_id: 'call-1',
    });
  });

  it('rebuilds a user request as a user message', () => {
    expect(
      assistantMessageToByokMessage(makeUserRequestMessage('Make a game'))
    ).toEqual({ role: 'user', content: 'Make a game' });
  });

  it('replays a multi-part user message as one user message with the texts joined', () => {
    const multiPartUserMessage: AiRequestMessage = {
      type: 'message',
      status: 'completed',
      role: 'user',
      content: [
        { type: 'user_request', status: 'completed', text: 'Add a player' },
        { type: 'user_request', status: 'completed', text: 'and an enemy' },
      ],
    };

    expect(assistantMessageToByokMessage(multiPartUserMessage)).toEqual({
      role: 'user',
      content: 'Add a player and an enemy',
    });
  });

  it('drops reasoning items when replaying an assistant message', () => {
    // Hosted transcripts carry `reasoning` items: sending them back as
    // content would be a real (and costly) bug.
    const assistantMessageWithReasoning: AiRequestMessage = {
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        // $FlowFixMe[incompatible-type] - reasoning items only exist on
        // hosted transcripts.
        {
          type: 'reasoning',
          status: 'completed',
          summary: { text: 'Thinking...', type: 'summary_text' },
        },
        {
          type: 'output_text',
          status: 'completed',
          text: 'The answer.',
          annotations: [],
        },
        {
          type: 'function_call',
          status: 'completed',
          call_id: 'call-1',
          name: 'describe_instances',
          arguments: '{}',
        },
      ],
    };

    const byokMessage = assistantMessageToByokMessage(
      assistantMessageWithReasoning
    );
    expect(byokMessage.role).toBe('assistant');
    if (byokMessage.role !== 'assistant') throw new Error('Expected assistant');
    expect(byokMessage.content).toBe('The answer.');
    expect(byokMessage.tool_calls).toEqual([
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'describe_instances', arguments: '{}' },
      },
    ]);
  });

  it('uses null content for an assistant message with only tool calls', () => {
    const assistantMessage = byokResponseToAssistantMessage(
      makeResponse(null, [makeToolCall('call-1', 'create_scene')])
    );

    const byokMessage = assistantMessageToByokMessage(assistantMessage);
    expect(byokMessage.role).toBe('assistant');
    if (byokMessage.role !== 'assistant') throw new Error('Expected assistant');
    expect(byokMessage.content).toBe(null);
  });
});

describe('round-trip and compatibility with the transcript helpers', () => {
  it('is compatible with getFunctionCallsToProcess (the shell + mapped response)', () => {
    const aiRequest = createByokAiRequestShell('byok-chat-1');
    const assistantMessage = byokResponseToAssistantMessage(
      makeResponse('Placing instances.', [
        makeToolCall('call-1', 'put_2d_instances', '{"scene_name":"Scene"}'),
      ])
    );
    aiRequest.output = [
      makeUserRequestMessage('Add a player'),
      assistantMessage,
    ];

    const callsToProcess = getFunctionCallsToProcess({
      aiRequest,
      editorFunctionCallResults: null,
    });
    expect(callsToProcess).toHaveLength(1);
    expect(callsToProcess[0].call_id).toBe('call-1');
    expect(callsToProcess[0].name).toBe('put_2d_instances');
    expect(callsToProcess[0].arguments).toBe('{"scene_name":"Scene"}');
  });

  it('stops returning calls once their output is in the transcript', () => {
    const aiRequest = createByokAiRequestShell('byok-chat-1');
    const assistantMessage = byokResponseToAssistantMessage(
      makeResponse(null, [makeToolCall('call-1', 'create_scene')])
    );
    aiRequest.output = [
      assistantMessage,
      byokToolResultToFunctionCallOutput('call-1', '{"success":true}'),
    ];

    expect(
      getFunctionCallsToProcess({
        aiRequest,
        editorFunctionCallResults: null,
      })
    ).toEqual([]);
  });

  it('round-trips a full transcript through the Byok message mapping', () => {
    const transcript: Array<AiRequestMessage> = [
      makeUserRequestMessage('Create a scene'),
      byokResponseToAssistantMessage(
        makeResponse('On it.', [makeToolCall('call-1', 'create_scene')])
      ),
      byokToolResultToFunctionCallOutput('call-1', '{"success":true}'),
      byokResponseToAssistantMessage(makeResponse('Scene created!')),
    ];

    const byokMessages = transcript.map(message =>
      assistantMessageToByokMessage(message)
    );
    expect(byokMessages).toEqual([
      { role: 'user', content: 'Create a scene' },
      {
        role: 'assistant',
        content: 'On it.',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'create_scene', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: '{"success":true}', tool_call_id: 'call-1' },
      { role: 'assistant', content: 'Scene created!' },
    ]);
  });
});

describe('createByokAiRequestShell', () => {
  it('creates a working AiRequest with an empty transcript', () => {
    const aiRequest = createByokAiRequestShell('byok-chat-1');

    expect(aiRequest.id).toBe('byok-chat-1');
    expect(aiRequest.status).toBe('working');
    expect(aiRequest.error).toBe(null);
    expect(aiRequest.output).toEqual([]);
    expect(aiRequest.contextStats).toBe(null);
    expect(typeof aiRequest.createdAt).toBe('string');
    expect(aiRequest.createdAt).toBe(aiRequest.updatedAt);
  });

  it('sets the orchestrator mode, which the chat UI gates its plan component on', () => {
    const aiRequest = createByokAiRequestShell('byok-chat-1');
    expect(aiRequest.mode).toBe('orchestrator');
  });

  it('accepts initial context stats', () => {
    const aiRequest = createByokAiRequestShell('byok-chat-1', {
      totalTokens: 150,
      usedPercentage: 0.02,
    });
    expect(aiRequest.contextStats).toEqual({
      totalTokens: 150,
      usedPercentage: 0.02,
    });
  });
});

describe('byokMessagesForTranscriptItem (image replay)', () => {
  const makeImageOutput = (callId: string, imageIds: Array<string>): any => ({
    type: 'function_call_output',
    call_id: callId,
    output: JSON.stringify({ success: true, image: imageIds[0] }),
    images: imageIds,
  });

  const makeImageRegistry = () => {
    const images = {
      'img-1': {
        id: 'img-1',
        dataUrl: 'data:image/jpeg;base64,AAA',
        width: 1024,
        height: 1024,
        approxTokens: 1337,
      },
      'img-2': {
        id: 'img-2',
        dataUrl: 'data:image/jpeg;base64,BBB',
        width: 1024,
        height: 1024,
        approxTokens: 1337,
      },
    };
    const imagesById: any = images;
    return (id: string) => imagesById[id] || null;
  };

  it('emits a tool message followed by a user message with the image part', () => {
    const messages: Array<any> = byokMessagesForTranscriptItem(
      makeImageOutput('call-1', ['img-1']),
      {
        imagesEnabled: true,
        survivingImageIds: new Set(['img-1']),
        getImage: makeImageRegistry(),
      }
    );

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('tool');
    expect(messages[1].role).toBe('user');
    expect(Array.isArray(messages[1].content)).toBe(true);
    expect(messages[1].content[0]).toEqual({
      type: 'text',
      text: '[tool result image]',
    });
    expect(messages[1].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,AAA' },
    });
  });

  it('replaces evicted images by a placeholder line and sends no part', () => {
    const messages: Array<any> = byokMessagesForTranscriptItem(
      makeImageOutput('call-1', ['img-1']),
      {
        imagesEnabled: true,
        survivingImageIds: new Set(),
        getImage: makeImageRegistry(),
      }
    );

    expect(messages).toHaveLength(2);
    expect(messages[1].content).toHaveLength(1);
    expect(messages[1].content[0].text).toContain('removed to save context');
  });

  it('sends no image part when images are disabled', () => {
    const messages: Array<any> = byokMessagesForTranscriptItem(
      makeImageOutput('call-1', ['img-1']),
      {
        imagesEnabled: false,
        survivingImageIds: new Set(['img-1']),
        getImage: makeImageRegistry(),
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('tool');
  });

  it('keeps plain tool outputs as a single tool message', () => {
    const messages = byokMessagesForTranscriptItem(
      {
        type: 'function_call_output',
        call_id: 'call-2',
        output: '{"success":true}',
      },
      {
        imagesEnabled: true,
        survivingImageIds: new Set(),
        getImage: makeImageRegistry(),
      }
    );
    expect(messages).toHaveLength(1);
  });
});

describe('getByokTranscriptImageIds / getByokSurvivingImageIds', () => {
  const makeTranscript = (): Array<any> => [
    {
      type: 'message',
      status: 'completed',
      role: 'user',
      content: [{ type: 'user_request', status: 'completed', text: 'hi' }],
    },
    makeImageOutputForSurviving('call-1', ['img-1']),
    makeImageOutputForSurviving('call-2', ['img-2', 'img-3']),
  ];

  const makeImageOutputForSurviving = (
    callId: string,
    imageIds: Array<string>
  ): any => ({
    type: 'function_call_output',
    call_id: callId,
    output: '{}',
    images: imageIds,
  });

  it('collects the image ids in order', () => {
    expect(getByokTranscriptImageIds(makeTranscript())).toEqual([
      'img-1',
      'img-2',
      'img-3',
    ]);
  });

  it('keeps the latest N and none when N is zero (the slice(-0) trap)', () => {
    const transcript = makeTranscript();
    expect(getByokSurvivingImageIds(transcript, 2)).toEqual(
      new Set(['img-2', 'img-3'])
    );
    expect(getByokSurvivingImageIds(transcript, 1)).toEqual(new Set(['img-3']));
    expect(getByokSurvivingImageIds(transcript, 0)).toEqual(new Set());
  });
});

describe('byokToolResultToFunctionCallOutput with images', () => {
  it('stores the image references on the output item', () => {
    const message: any = byokToolResultToFunctionCallOutput(
      'call-1',
      '{"success":true}',
      ['img-9']
    );
    expect(message.images).toEqual(['img-9']);
  });

  it('omits the field when there is no image', () => {
    const message: any = byokToolResultToFunctionCallOutput(
      'call-1',
      '{"success":true}'
    );
    expect(message.images).toBeUndefined();
  });

  // ---- Phase 9: the byok_notice transcript rows ----
  describe('byok notice rows', () => {
    it('replay to nothing (they are never sent to any model)', () => {
      const notice = ((makeByokNotice(
        'stall',
        'No activity for 90s.'
      ): any): AiRequestMessage);
      expect(byokMessagesForTranscriptItem(notice)).toEqual([]);
    });

    it('are recognized by the type guard and carry kind + text', () => {
      const notice = makeByokNotice(
        'context-summarized',
        'Context summarized.'
      );
      expect(isByokNoticeMessage(notice)).toBe(true);
      expect(isByokNoticeMessage({ type: 'message', role: 'user' })).toBe(
        false
      );
      expect(notice.noticeKind).toBe('context-summarized');
      expect(notice.status).toBe('completed');
    });

    it('do not break the surviving-image computation', () => {
      const notice = ((makeByokNotice(
        'rate-limited',
        'waiting'
      ): any): AiRequestMessage);
      expect(getByokTranscriptImageIds([notice])).toEqual([]);
    });
  });
});

describe('user message attached images (Phase 13.3)', () => {
  const makeAttachedUserMessage = (
    text: string,
    imageIds: Array<string>
  ): any => ({
    type: 'message',
    status: 'completed',
    role: 'user',
    content: [{ type: 'user_request', status: 'completed', text }],
    images: imageIds,
  });

  const makeImageRegistry = () => {
    const images: any = {
      'img-1': {
        id: 'img-1',
        dataUrl: 'data:image/png;base64,AAA',
        width: 512,
        height: 512,
        approxTokens: 334,
      },
    };
    return (id: string) => images[id] || null;
  };

  it('replays as a multi-part user message with the image parts', () => {
    const messages: Array<any> = byokMessagesForTranscriptItem(
      makeAttachedUserMessage('What is on this picture?', ['img-1']),
      {
        imagesEnabled: true,
        survivingImageIds: new Set(['img-1']),
        getImage: makeImageRegistry(),
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[0].content[0]).toEqual({
      type: 'text',
      text: 'What is on this picture?',
    });
    expect(messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAA' },
    });
  });

  it('degrades to the plain text message when images are disabled', () => {
    const messages: Array<any> = byokMessagesForTranscriptItem(
      makeAttachedUserMessage('Describe it', ['img-1']),
      {
        imagesEnabled: false,
        survivingImageIds: new Set(['img-1']),
        getImage: makeImageRegistry(),
      }
    );

    expect(messages).toHaveLength(1);
    expect(typeof messages[0].content).toBe('string');
    expect(messages[0].content).toBe('Describe it');
  });

  it('counts toward the transcript image ids (the eviction rule)', () => {
    const transcript: Array<AiRequestMessage> = [
      makeAttachedUserMessage('Hello', ['img-1']),
    ];
    expect(getByokTranscriptImageIds(transcript)).toEqual(['img-1']);
    expect(getByokSurvivingImageIds(transcript, 1)).toEqual(new Set(['img-1']));
    expect(getByokSurvivingImageIds(transcript, 0)).toEqual(new Set());
  });

  it('a user message without images replays as plain text', () => {
    const messages: Array<any> = byokMessagesForTranscriptItem({
      type: 'message',
      status: 'completed',
      role: 'user',
      content: [
        { type: 'user_request', status: 'completed', text: 'Plain message' },
      ],
    });
    expect(messages).toEqual([{ role: 'user', content: 'Plain message' }]);
  });
});

describe('getByokSurvivingImageIdsExcluding (audit011026 B-CORE-4)', () => {
  const makeImageTranscript = (ids: Array<string>): Array<any> =>
    ids.map(id => ({
      type: 'function_call_output',
      call_id: `call-${id}`,
      output: '{}',
      images: [id],
    }));

  it('keeps every image until an explicit eviction names it (no sliding window)', () => {
    const transcript = makeImageTranscript(['img-1', 'img-2', 'img-3']);
    // The old latest-2 window would have dropped img-1 here; the monotonic
    // rule keeps all three — a new capture must never rewrite old messages.
    expect(getByokSurvivingImageIdsExcluding(transcript, new Set())).toEqual(
      new Set(['img-1', 'img-2', 'img-3'])
    );
  });

  it('drops exactly the evicted ids', () => {
    const transcript = makeImageTranscript(['img-1', 'img-2', 'img-3']);
    expect(
      getByokSurvivingImageIdsExcluding(transcript, new Set(['img-1']))
    ).toEqual(new Set(['img-2', 'img-3']));
  });
});

describe('user-message image replay placeholders (audit011026 B-UI-12)', () => {
  const makeUserMessageWithImages = (images: Array<string>): any => ({
    type: 'message',
    status: 'completed',
    role: 'user',
    content: [{ type: 'user_request', status: 'completed', text: 'See these' }],
    images,
  });

  it('notes evicted attachments instead of silently dropping them', () => {
    const messages: Array<any> = byokMessagesForTranscriptItem(
      makeUserMessageWithImages(['img-a', 'img-b']),
      {
        imagesEnabled: true,
        survivingImageIds: new Set(['img-b']),
        getImage: (id: string) =>
          ({
            id,
            dataUrl: `data:${id}`,
            width: 1,
            height: 1,
            approxTokens: 1,
          }: any),
      }
    );
    const textPart = messages[0].content.find(
      (part: any) => part.type === 'text'
    );
    expect(textPart.text).toContain(
      '[attachment img-a removed to save context'
    );
    expect(textPart.text).not.toContain('img-b removed');
  });
});
