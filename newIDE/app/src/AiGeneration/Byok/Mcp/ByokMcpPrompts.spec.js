// @flow
import { getByokMcpPrompt, listByokMcpPrompts } from './ByokMcpPrompts';

const makeSkills = () => [
  {
    name: 'build-workflow',
    description: 'The pipeline for building a game.',
    body: '1. Plan. 2. Build. 3. Verify.',
  },
  {
    name: 'extend-with-js',
    description: 'JavaScript and extensions.',
    body: 'Use JavaScript when…',
  },
];

describe('ByokMcpPrompts', () => {
  it('lists one prompt per skill with metadata only', () => {
    const prompts = listByokMcpPrompts(makeSkills());
    expect(prompts).toEqual([
      {
        name: 'build-workflow',
        description: 'The pipeline for building a game.',
      },
      { name: 'extend-with-js', description: 'JavaScript and extensions.' },
    ]);
    expect(JSON.stringify(prompts)).not.toContain('1. Plan');
  });

  it('returns the skill body as a user message', () => {
    const prompt = getByokMcpPrompt(makeSkills(), 'build-workflow');
    expect(prompt).toBeTruthy();
    expect(prompt?.messages).toHaveLength(1);
    expect(prompt?.messages[0].role).toBe('user');
    expect(prompt?.messages[0].content.type).toBe('text');
    expect(prompt?.messages[0].content.text).toContain('1. Plan');
  });

  it('answers null for an unknown prompt name', () => {
    expect(getByokMcpPrompt(makeSkills(), 'nope')).toBeNull();
  });

  it('answers empty lists for an empty library', () => {
    expect(listByokMcpPrompts([])).toEqual([]);
  });
});
