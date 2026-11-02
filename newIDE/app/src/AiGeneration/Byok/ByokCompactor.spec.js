// @flow
import type { AiRequestMessage } from '../../Utils/GDevelopServices/Generation';
import {
  BYOK_COMPACTION_CONTEXT_RATIO,
  compactByokTranscript,
  findKeptTurnsStartIndex,
  findKeptToolRoundsStartIndex,
  summarizeToolOutput,
} from './ByokCompactor';

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

const toolOutput = (
  callId: string,
  output: string,
  images?: Array<string>
): any => {
  const message: any = {
    type: 'function_call_output',
    call_id: callId,
    output,
  };
  if (images) message.images = images;
  return message;
};

const assistantToolCall = (
  callId: string,
  output: string,
  images?: Array<string>
): Array<AiRequestMessage> => [
  {
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [
      {
        type: 'function_call',
        status: 'completed',
        call_id: callId,
        name: 'capture_scene_screenshot',
        arguments: '{}',
      },
    ],
  },
  toolOutput(callId, output, images),
];

/** A transcript with `turnCount` user turns of two messages each. */
const makeTranscript = (turnCount: number): Array<AiRequestMessage> => {
  const transcript: Array<AiRequestMessage> = [];
  for (let index = 0; index < turnCount; index++) {
    transcript.push(userMessage(`request ${index}`));
    transcript.push(assistantText(`answer ${index}`));
  }
  return transcript;
};

describe('ByokCompactor: trigger', () => {
  it('triggers at 0.75 of the window (the shared threshold)', () => {
    expect(BYOK_COMPACTION_CONTEXT_RATIO).toBe(0.75);
  });

  it('does nothing when the transcript is all-recent turns', async () => {
    const summarizer = (jest.fn(): any);
    const outcome = await compactByokTranscript({
      transcript: makeTranscript(5),
      summarizer,
      preservedBlockText: 'preserved',
    });
    expect(outcome).toBe(null);
    expect(summarizer).not.toHaveBeenCalled();
  });

  it('compacts only the region older than the keep window', async () => {
    const summarizer = (jest.fn(): any).mockResolvedValue(
      'the old turns, summarized'
    );
    const outcome = await compactByokTranscript({
      transcript: makeTranscript(14),
      summarizer,
      preservedBlockText: 'preserved',
      keepLastTurns: 10,
    });
    expect(outcome).not.toBe(null);
    if (!outcome) return;
    // 4 old turns × 2 messages summarized; the 10 recent turns stay.
    expect(outcome.summarizedMessageCount).toBe(8);
    const serialized = JSON.stringify(outcome.transcript);
    for (let index = 4; index < 14; index++) {
      expect(serialized).toContain(`request ${index}`);
    }
    expect(serialized).not.toContain('request 3');
    expect(serialized).toContain('the old turns, summarized');
  });
});

describe('ByokCompactor: drop order', () => {
  it('drops all images but the latest one, newest kept regardless of place', async () => {
    const transcript: Array<AiRequestMessage> = [
      userMessage('go'),
      ...assistantToolCall('call-1', 'shot', ['img-1']),
      ...assistantToolCall('call-2', 'shot', ['img-2']),
      userMessage('mid'),
      ...assistantToolCall('call-3', 'shot', ['img-3']),
      userMessage('recent'),
      assistantText('done'),
    ];
    const summarizer = (jest.fn(): any).mockResolvedValue('summary');
    const outcome = await compactByokTranscript({
      transcript,
      summarizer,
      preservedBlockText: '',
      keepLastTurns: 1,
    });
    expect(outcome).not.toBe(null);
    if (!outcome) return;
    expect(outcome.droppedImageCount).toBe(2);

    const survivingImageIds: Array<string> = [];
    for (const message of outcome.transcript) {
      const images = (message: any).images;
      if (Array.isArray(images)) survivingImageIds.push(...images);
    }
    // The latest image of the chat (img-3) survives.
    expect(survivingImageIds).toEqual(['img-3']);
    // The input transcript was not mutated (the images ride the tool
    // outputs, two messages after their assistants).
    const originalImages = ((transcript[2]: any).images: Array<string>);
    expect(originalImages).toEqual(['img-1']);
  });

  it('summarizes tool outputs older than the tool-output window into one-liners', async () => {
    const transcript: Array<AiRequestMessage> = [];
    for (let index = 0; index < 14; index++) {
      transcript.push(userMessage(`turn ${index}`));
      transcript.push(
        ...assistantToolCall(
          `call-${index}`,
          `A very long tool output for turn ${index}.`.repeat(10)
        )
      );
    }
    const summarizer = (jest.fn(): any).mockResolvedValue('summary');
    const outcome = await compactByokTranscript({
      transcript,
      summarizer,
      preservedBlockText: '',
      keepLastTurns: 10,
      keepLastToolTurns: 3,
    });
    expect(outcome).not.toBe(null);
    if (!outcome) return;
    // Every tool output older than the last 3 turns becomes a one-liner
    // (14 turns − 3 recent = 11), while the pair (call + output) stays
    // protocol-valid.
    expect(outcome.summarizedToolOutputCount).toBe(11);

    let oneLineCount = 0;
    for (const message of outcome.transcript) {
      if (
        message.type === 'function_call_output' &&
        message.output.startsWith('{"summarized":true')
      ) {
        oneLineCount++;
      }
    }
    expect(oneLineCount).toBe(11);
    // The old turns were ALSO summarized into one message.
    expect(summarizer).toHaveBeenCalledTimes(1);
  });

  it('compacts a single mega-turn build chat (one user message, many tool rounds)', async () => {
    // The flagship build shape: ONE user request, then dozens of tool
    // rounds. With no turn boundary the compaction used to bail out
    // entirely (keptTurnsStart === 0), so the chat dead-ended at
    // byok-context-full with most of the transcript still compactable.
    const transcript: Array<AiRequestMessage> = [
      userMessage('build me a game'),
    ];
    for (let index = 0; index < 12; index++) {
      transcript.push(
        ...assistantToolCall(
          `call-${index}`,
          `A very long tool output for round ${index}.`.repeat(10)
        )
      );
    }
    const summarizer = (jest.fn(): any).mockResolvedValue('summary');
    const outcome = await compactByokTranscript({
      transcript,
      summarizer,
      preservedBlockText: '',
      keepLastTurns: 10,
      keepLastToolTurns: 3,
    });
    expect(outcome).not.toBe(null);
    if (!outcome) return;
    // 12 rounds − 3 kept recent = 9 outputs become one-liners.
    expect(outcome.summarizedToolOutputCount).toBe(9);
    // No turn boundary means no summarizable text region: the pass is a
    // tool-output-only trim (the summarizer is never called).
    expect(summarizer).not.toHaveBeenCalled();
    expect(outcome.summaryText).toBe('');
    // Every tool_call still has its output — the pass must never split a
    // protocol pair.
    const callIds: Set<string> = new Set();
    for (const message of outcome.transcript) {
      if (message.type === 'message' && message.role === 'assistant') {
        for (const item of message.content) {
          if (item.type === 'function_call') callIds.add(item.call_id);
        }
      }
    }
    const outputIds: Set<string> = new Set();
    for (const message of outcome.transcript) {
      if (message.type === 'function_call_output')
        outputIds.add(message.call_id);
    }
    expect(outputIds.size).toBe(callIds.size);
    for (const callId of callIds) expect(outputIds.has(callId)).toBe(true);
  });

  it('still bails out when there is neither a turn nor a round to trim', async () => {
    const transcript: Array<AiRequestMessage> = [userMessage('hello')];
    transcript.push(...assistantToolCall('call-0', 'A short output.'));
    const summarizer = (jest.fn(): any).mockResolvedValue('summary');
    const outcome = await compactByokTranscript({
      transcript,
      summarizer,
      preservedBlockText: '',
      keepLastTurns: 10,
      keepLastToolTurns: 3,
    });
    expect(outcome).toBe(null);
  });

  it('findKeptToolRoundsStartIndex marks the 3rd-from-last tool round', () => {
    const transcript: Array<AiRequestMessage> = [];
    for (let index = 0; index < 5; index++) {
      transcript.push(...assistantToolCall(`call-${index}`, `output ${index}`));
    }
    // 5 rounds (each round is 2 messages: the call, then its output), keep
    // 2 → the window starts at the 3rd-from-last round (message index 6).
    expect(findKeptToolRoundsStartIndex(transcript, 2)).toBe(6);
    // Fewer rounds than the window: nothing old enough.
    expect(findKeptToolRoundsStartIndex(transcript, 5)).toBe(0);
  });
});

describe('ByokCompactor: the summarizer call', () => {
  it('caps the summarizer output', async () => {
    const transcript = makeTranscript(12);
    const summarizer = (jest.fn(): any).mockResolvedValue('x'.repeat(10000));
    const outcome = await compactByokTranscript({
      transcript,
      summarizer,
      preservedBlockText: '',
      summaryMaxChars: 100,
    });
    expect(outcome && outcome.summaryText.length).toBe(100);
  });

  it('degrades to the mechanical digest when the summarizer call fails', async () => {
    const transcript = makeTranscript(12);
    const summarizer = (jest.fn(): any).mockRejectedValue(
      new Error('overloaded')
    );
    const outcome = await compactByokTranscript({
      transcript,
      summarizer,
      preservedBlockText: '',
    });
    expect(outcome && outcome.summarizerFailed).toBe(true);
    expect(outcome && outcome.summaryText).toContain('request 0');
    // The transcript still got compacted: the chat continues.
    expect(outcome && outcome.transcript.length > 0).toBe(true);
  });

  it('keeps the tool-call pairs in place and summarizes only the text', async () => {
    const transcript: Array<AiRequestMessage> = [
      userMessage('look'),
      ...assistantToolCall('call-x', 'the screenshot'),
      userMessage('a'),
      assistantText('b'),
      userMessage('c'),
      assistantText('d'),
    ];
    const summarizer = (jest.fn(): any).mockResolvedValue('summary');
    const outcome = await compactByokTranscript({
      transcript,
      summarizer,
      preservedBlockText: '',
      keepLastTurns: 2,
    });
    expect(outcome).not.toBe(null);
    if (!outcome) return;

    // The digest carries the old text (the user request), never the
    // tool-call pair (which stays in the transcript, protocol-valid).
    const digest = summarizer.mock.calls[0][0];
    expect(digest).toContain('User: look');
    expect(digest).not.toContain('capture_scene_screenshot');
    const serialized = JSON.stringify(outcome.transcript);
    expect(serialized).toContain('capture_scene_screenshot');
    expect(serialized).toContain('call-x');
    expect(serialized).not.toContain('"look"');
    expect(serialized).not.toContain('User: look');
  });
});

describe('ByokCompactor: the compacted prefix', () => {
  it('prepends the summary and the preserved block, then the kept turns', async () => {
    const transcript = makeTranscript(12);
    const summarizer = (jest.fn(): any).mockResolvedValue('old stuff');
    const outcome = await compactByokTranscript({
      transcript,
      summarizer,
      preservedBlockText: 'PRESERVED BLOCK',
    });
    expect(outcome).not.toBe(null);
    if (!outcome) return;

    const firstText = (((outcome.transcript[0]: any).content: any)[0]: any)
      .text;
    expect(firstText).toContain('summarized');
    expect(firstText).toContain('old stuff');
    const secondText = (((outcome.transcript[1]: any).content: any)[0]: any)
      .text;
    expect(secondText).toContain('Preserved context');
    expect(secondText).toContain('PRESERVED BLOCK');
    // No summary block when there was nothing to summarize (kept everything).
    const noOldTurns = await compactByokTranscript({
      transcript: makeTranscript(1),
      summarizer,
      preservedBlockText: 'kept',
      keepLastTurns: 5,
    });
    expect(noOldTurns).toBe(null);
  });
});

describe('ByokCompactor: helpers', () => {
  it('findKeptTurnsStartIndex marks the 10th-from-last user message', () => {
    const transcript = makeTranscript(12);
    // 12 turns → the kept region starts at turn index 2 (0-based).
    expect(findKeptTurnsStartIndex(transcript, 10)).toBe(4);
    expect(findKeptTurnsStartIndex(makeTranscript(5), 10)).toBe(0);
  });

  it('summarizeToolOutput keeps a bounded preview', () => {
    const summary = summarizeToolOutput('y'.repeat(5000));
    expect(summary.length).toBeLessThan(300);
    expect(summary).toContain('summarized');
  });
});

describe('compaction churn guard (audit011026 B-CORE-5)', () => {
  const makeTurn = (index: number): any => ({
    type: 'message',
    status: 'completed',
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: [
      index % 2 === 0
        ? { type: 'user_request', status: 'completed', text: `turn ${index}` }
        : { type: 'output_text', status: 'completed', text: `ok ${index}` },
    ],
  });
  const makeTranscript = (turnPairs: number): Array<any> => {
    const transcript: Array<any> = [];
    for (let index = 0; index < turnPairs * 2; index++) {
      transcript.push(makeTurn(index));
    }
    return transcript;
  };

  it('tags its synthetic head messages so they do not count as turns, and a just-compacted transcript is not re-compactable', async () => {
    // 12 user turns, keep 10: the first 2 turns get summarized.
    const transcript = makeTranscript(12);
    const outcome = await compactByokTranscript({
      transcript,
      summarizer: async digest => `SUMMARY(${digest.slice(0, 10)})`,
      preservedBlockText: 'PRESERVED',
      keepLastTurns: 10,
      keepLastToolTurns: 6,
    });
    expect(outcome).not.toBeNull();
    const compacted = (outcome: any).transcript;
    expect((compacted[0]: any).byokCompactionSynthetic).toBe(true);
    expect((compacted[1]: any).byokCompactionSynthetic).toBe(true);
    // The synthetic messages must not count as turns: the compacted
    // transcript holds exactly the 10 kept turns, so compacting it again
    // immediately (the churn) finds nothing older than the window.
    expect(findKeptTurnsStartIndex(compacted, 10)).toBe(0);
    const secondOutcome = await compactByokTranscript({
      transcript: compacted,
      summarizer: async digest => digest,
      preservedBlockText: 'PRESERVED',
      keepLastTurns: 10,
      keepLastToolTurns: 6,
    });
    expect(secondOutcome).toBeNull();
  });
});
