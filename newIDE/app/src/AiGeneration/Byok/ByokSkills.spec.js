// @flow
import {
  BYOK_SKILL_MAX_CHARS,
  parseByokSkill,
  getByokBuiltinSkills,
  getByokSkills,
  findByNameokSkill,
  listByokSkillMetadata,
  setByokUserSkillsLoaderForTests,
} from './ByokSkills';

const makeSkillFile = (
  overrides: {
    name?: string,
    description?: string,
    body?: string,
    tools?: string,
  } = {}
) => {
  const {
    name = 'my-skill',
    description = 'A skill for tests.',
    body = 'Do the thing.\nThen verify it.',
    tools,
  } = overrides;
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    ...(tools ? [`tools: ${tools}`] : []),
    '---',
    '',
    body,
    '',
  ].join('\n');
};

describe('ByokSkills: parser', () => {
  it('parses a valid skill file', () => {
    const parsed = parseByokSkill(
      makeSkillFile({
        name: 'platformer-game',
        description: 'Platformer recipes.',
        tools: 'put_2d_instances, add_scene_events',
      }),
      'builtin:platformer-game.md'
    );
    const { skill } = parsed;
    if (!skill) throw new Error(parsed.error || 'unparseable skill');

    expect(skill.name).toBe('platformer-game');
    expect(skill.description).toBe('Platformer recipes.');
    expect(skill.tools).toEqual(['put_2d_instances', 'add_scene_events']);
    expect(skill.body).toContain('Do the thing.');
    expect(skill.source).toBe('builtin:platformer-game.md');
  });

  it('rejects a file without frontmatter', () => {
    const parsed = parseByokSkill('Just some text.', 'user:broken.md');
    expect(parsed.skill).toBe(null);
    expect(parsed.error).toContain('no frontmatter');
  });

  it('rejects an unterminated frontmatter', () => {
    const parsed = parseByokSkill('---\nname: broken\n', 'user:broken.md');
    expect(parsed.error).toContain('unterminated frontmatter');
  });

  it('rejects a skill without a name', () => {
    const content = makeSkillFile({ name: '' });
    const parsed = parseByokSkill(content, 'user:nameless.md');
    expect(parsed.error).toContain('no name');
  });

  it('rejects a skill without a description', () => {
    const content = makeSkillFile({ description: '' });
    const parsed = parseByokSkill(content, 'user:undescribed.md');
    expect(parsed.error).toContain('no description');
  });

  it('rejects a skill with an empty body', () => {
    const content = makeSkillFile({ body: '' });
    const parsed = parseByokSkill(content, 'user:empty.md');
    expect(parsed.error).toContain('empty body');
  });

  it('rejects a skill above the size cap', () => {
    const hugeBody = 'x'.repeat(BYOK_SKILL_MAX_CHARS + 1);
    const parsed = parseByokSkill(
      makeSkillFile({ body: hugeBody }),
      'user:huge.md'
    );
    expect(parsed.error).toContain('32 KB');
    expect(BYOK_SKILL_MAX_CHARS).toBe(32 * 1024);
  });

  it('handles CRLF line endings', () => {
    const { skill } = parseByokSkill(
      makeSkillFile().replace(/\n/g, '\r\n'),
      'user:crlf.md'
    );
    if (!skill) throw new Error('unparseable skill');
    expect(skill.name).toBe('my-skill');
  });
});

describe('ByokSkills: registry', () => {
  afterEach(() => {
    setByokUserSkillsLoaderForTests(null);
  });

  it('parses the shipped starter set', () => {
    const skills = getByokBuiltinSkills();
    const names = skills.map(skill => skill.name);

    // The phase-mandated starter set, all parseable.
    for (const name of [
      'platformer-game',
      'top-down-shooter',
      'puzzle-grid',
      'hud-and-menus',
      'save-system',
      'juice-and-game-feel',
      'physics-2d-recipes',
      '3d-scene-basics',
      'js-custom-rendering',
      'eventscript-authoring',
      'gameplay-testing',
    ]) {
      expect(names).toContain(name);
    }
    // Names are unique (the generator would emit duplicates otherwise).
    expect(new Set(names).size).toBe(names.length);
  });

  it('merges user skills over builtin ones (same name = override)', async () => {
    setByokUserSkillsLoaderForTests(async () => [
      {
        fileName: 'platformer-game.md',
        content: makeSkillFile({
          name: 'platformer-game',
          description: 'My own platformer recipe.',
        }),
      },
      {
        fileName: 'my-notes.md',
        content: makeSkillFile({ name: 'my-notes' }),
      },
    ]);

    const skills = await getByokSkills();
    expect(
      skills.filter(skill => skill.name === 'platformer-game')
    ).toHaveLength(1);
    const platformer = await findByNameokSkill('platformer-game');
    expect(platformer && platformer.description).toBe(
      'My own platformer recipe.'
    );
    expect(platformer && platformer.source).toBe('user:platformer-game.md');

    // The builtin-only name still resolves.
    const gameplay = await findByNameokSkill('gameplay-testing');
    expect(gameplay && gameplay.source.startsWith('builtin:')).toBe(true);

    // Unknown names resolve to null.
    expect(await findByNameokSkill('no-such-skill')).toBe(null);
  });

  it('skips broken user files without losing the builtin set', async () => {
    setByokUserSkillsLoaderForTests(async () => [
      {
        fileName: 'broken.md',
        content: 'no frontmatter here',
      },
    ]);
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const skills = await getByokSkills();
    expect(skills.length).toBe(getByokBuiltinSkills().length);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('exposes the metadata-only view for the prompt appendix', async () => {
    const metadata = await listByokSkillMetadata();
    expect(metadata.length).toBeGreaterThan(0);
    for (const entry of metadata) {
      expect(typeof entry.name).toBe('string');
      expect(entry.description).not.toBe('');
      // Metadata only: never the bodies.
      expect(entry).not.toHaveProperty('body');
    }
  });
});
