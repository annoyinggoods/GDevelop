// @flow
import builtinSkillEntries from './Skills/ByokBuiltinSkills.generated';
import optionalRequire from '../../Utils/OptionalRequire';

/**
 * The BYOK skills system (Phase 7.6): progressive disclosure for unbounded
 * knowledge — the system prompt only ever carries the skills' metadata
 * (name + one-line description); the bodies are fetched on demand by the
 * `load_skill` tool and stay in the conversation afterwards.
 *
 * A skill is a Markdown file with a small frontmatter (`name`,
 * `description`, optional `tools`) and a body of instructions. The builtin
 * set ships with the app; desktop users can drop their own `.md` files into
 * the `byok-skills` folder of their user data (read through a tiny IPC on
 * the Electron side). A user skill overrides a builtin one of the same
 * name.
 */

/** Skills are compact by design: anything bigger is documentation, not a skill. */
export const BYOK_SKILL_MAX_CHARS = 32 * 1024;

const electron = optionalRequire('electron');
const ipcRenderer = electron ? electron.ipcRenderer : null;

export type ByokSkill = {|
  name: string,
  description: string,
  // Optional tool-subset hint (Phase 9 will scope tool exposure per skill).
  tools: Array<string>,
  body: string,
  // Where the skill comes from ("builtin:<file>" or "user:<file>").
  source: string,
|};

/**
 * Parse and validate one skill file. Returns the parsed skill, or an error
 * string (files are user-provided content: a broken file must be reported,
 * never crash the chat).
 */
export const parseByokSkill = (
  content: string,
  source: string
): {| skill: ByokSkill | null, error: string | null |} => {
  if (content.length > BYOK_SKILL_MAX_CHARS) {
    return {
      skill: null,
      error: `Skill "${source}" is larger than 32 KB — split it or trim it.`,
    };
  }

  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return {
      skill: null,
      error: `Skill "${source}" has no frontmatter (--- name: ...).`,
    };
  }
  const frontmatterEnd = normalized.indexOf('\n---', 4);
  if (frontmatterEnd === -1) {
    return {
      skill: null,
      error: `Skill "${source}" has an unterminated frontmatter.`,
    };
  }
  const frontmatter = normalized.slice(4, frontmatterEnd);
  const body = normalized
    .slice(frontmatterEnd + 4)
    .replace(/^\n+/, '')
    .trim();

  let name = '';
  let description = '';
  const tools: Array<string> = [];
  for (const line of frontmatter.split('\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key === 'name') name = value;
    if (key === 'description') description = value;
    if (key === 'tools') {
      for (const toolName of value.split(',')) {
        const trimmed = toolName.trim();
        if (trimmed) tools.push(trimmed);
      }
    }
  }

  if (!name) {
    return {
      skill: null,
      error: `Skill "${source}" has no name in its frontmatter.`,
    };
  }
  if (!description) {
    return {
      skill: null,
      error: `Skill "${source}" (${name}) has no description in its frontmatter.`,
    };
  }
  if (!body) {
    return {
      skill: null,
      error: `Skill "${source}" (${name}) has an empty body.`,
    };
  }

  return { skill: { name, description, tools, body, source }, error: null };
};

let builtinSkillsCache: ?Array<ByokSkill> = null;

/**
 * The builtin skills, parsed once. A broken builtin file is logged and
 * skipped (it must not take the whole skills system down).
 */
export const getByokBuiltinSkills = (): Array<ByokSkill> => {
  if (builtinSkillsCache) return builtinSkillsCache;
  const skills: Array<ByokSkill> = [];
  for (const entry of builtinSkillEntries) {
    const parsed = parseByokSkill(entry.content, `builtin:${entry.fileName}`);
    if (!parsed.skill) {
      console.error(`BYOK skills: ${parsed.error || 'unparseable skill'}`);
      continue;
    }
    skills.push(parsed.skill);
  }
  builtinSkillsCache = skills;
  return skills;
};

// The user-skills reader is injectable for tests; the default reads the
// files through the Electron IPC (and returns nothing on the web build).
let userSkillsLoader: ?() => Promise<
  Array<{| fileName: string, content: string |}>
> = null;

export const setByokUserSkillsLoaderForTests = (
  loader: ?() => Promise<Array<{| fileName: string, content: string |}>>
): void => {
  userSkillsLoader = loader;
};

const readByokUserSkills = async (): Promise<
  Array<{| fileName: string, content: string |}>
> => {
  if (userSkillsLoader) return userSkillsLoader();
  if (!ipcRenderer) return [];
  try {
    const files = await ipcRenderer.invoke('byok-read-user-skills');
    if (!Array.isArray(files)) return [];
    return files.filter(
      file =>
        file &&
        typeof file.fileName === 'string' &&
        typeof file.content === 'string'
    );
  } catch (error) {
    console.error('Unable to read the BYOK user skills:', error);
    return [];
  }
};

/**
 * All the usable skills: builtin first, then the user ones (a user skill
 * with the same name as a builtin replaces it).
 */
export const getByokSkills = async (): Promise<Array<ByokSkill>> => {
  const userFiles = await readByokUserSkills();
  const skillsByName: Map<string, ByokSkill> = new Map();
  for (const skill of getByokBuiltinSkills()) {
    skillsByName.set(skill.name, skill);
  }
  for (const file of userFiles) {
    const parsed = parseByokSkill(file.content, `user:${file.fileName}`);
    if (!parsed.skill) {
      console.error(`BYOK skills: ${parsed.error || 'unparseable skill'}`);
      continue;
    }
    skillsByName.set(parsed.skill.name, parsed.skill);
  }
  return Array.from(skillsByName.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
};

/**
 * The metadata-only view injected in every system prompt (the bodies stay
 * behind load_skill).
 */
export const listByokSkillMetadata = async (): Promise<
  Array<{| name: string, description: string |}>
> => {
  const skills = await getByokSkills();
  return skills.map(skill => ({
    name: skill.name,
    description: skill.description,
  }));
};

/** The skill of this name (user skills included), or null. */
export const findByNameokSkill = async (
  name: string
): Promise<ByokSkill | null> => {
  const skills = await getByokSkills();
  return skills.find(skill => skill.name === name) || null;
};

/**
 * The build-intent heuristic (Phase 8.3): a make/build/create verb in the
 * same sentence as a game word. Cheap and over-inclusive on purpose — the
 * auto-suggested build-workflow skill is only instructions (overridable in
 * the settings), and a false positive just loads a playbook the model can
 * ignore.
 */
const BYOK_BUILD_INTENT_PATTERN = /\b(?:make|build|create|develop|generate|design)\b[^.!?]{0,120}\b(?:game|platformer|shooter|rpg|arcade|runner|puzzler|top-down|beat-them-all)\b/i;

/** Whether the first user message looks like a game-build request. */
export const isByokBuildIntent = (text: string): boolean =>
  BYOK_BUILD_INTENT_PATTERN.test(text);
