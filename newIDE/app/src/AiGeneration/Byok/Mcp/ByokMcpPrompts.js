// @flow

/**
 * The MCP `prompts` primitive (Phase 12, D12-6): the BYOK skill library
 * exposed as first-class MCP prompts, so an external agent can browse and
 * pull a skill's instructions without a tool call. Pure functions over the
 * skill list — the transport, the host and the protocol table stay in
 * their own modules (the Phase 10 layering).
 */

/** The skill slice the prompts surface needs (ByokSkill shaped). */
export type ByokMcpSkillLike = {|
  name: string,
  description: string,
  body: string,
|};

export type ByokMcpPromptDescriptor = {|
  name: string,
  description: string,
|};

export type ByokMcpGetPromptResult = {|
  description: string,
  messages: Array<{|
    role: 'user',
    content: {| type: 'text', text: string |},
  |}>,
|};

/** `prompts/list`: one prompt per skill, metadata only (bodies on demand). */
export const listByokMcpPrompts = (
  skills: Array<ByokMcpSkillLike>
): Array<ByokMcpPromptDescriptor> =>
  skills.map(skill => ({
    name: skill.name,
    description: skill.description,
  }));

/**
 * `prompts/get`: the skill body as a user message, ready to be injected by
 * the client. Unknown name → null (the protocol layer answers -32602).
 */
export const getByokMcpPrompt = (
  skills: Array<ByokMcpSkillLike>,
  name: string
): ByokMcpGetPromptResult | null => {
  const skill = skills.find(candidate => candidate.name === name) || null;
  if (!skill) return null;
  return {
    description: skill.description,
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: skill.body },
      },
    ],
  };
};
