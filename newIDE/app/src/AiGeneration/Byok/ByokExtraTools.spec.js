// @flow
import {
  findByNameokExtraTool,
  getByokExtraTools,
  type ByokExtraToolCollaborators,
} from './ByokExtraTools';
import { BYOK_ONLY_TOOL_NAMES } from './ByokToolSchema';

const gd: libGDevelop = global.gd;

const makeCollaborators = (project: any): ByokExtraToolCollaborators => ({
  getProject: () => project,
  onSceneEventsModifiedOutsideEditor: (jest.fn(): any),
});

describe('getByokExtraTools / findByNameokExtraTool', () => {
  it('registers the local event-writing tools and the Phase 6 perception tools', () => {
    const names = getByokExtraTools().map(tool => tool.name);
    expect(names).toContain('add_scene_events');
    expect(names).toContain('generate_events');
    expect(names).toContain('capture_scene_screenshot');
    expect(names).toContain('capture_preview_screenshot');
    expect(names).toContain('start_preview');
    expect(names).toContain('stop_preview');
    expect(names).toContain('read_preview_logs');
    expect(names).toContain('get_runtime_errors');
    expect(names).toContain('inspect_runtime_state');
    expect(names).toContain('run_gameplay_test');
  });

  it('finds a tool by name and returns null for the others', () => {
    expect(findByNameokExtraTool('add_scene_events')).not.toBeNull();
    expect(findByNameokExtraTool('generate_events')).not.toBeNull();
    expect(findByNameokExtraTool('describe_instances')).toBeNull();
    expect(findByNameokExtraTool('run_script')).toBeNull();
  });
});

describe('add_scene_events interception tool', () => {
  let project: any;

  beforeEach(() => {
    project = gd.ProjectHelper.createNewGDJSProject();
    project.insertNewLayout('TestScene', 0);
  });

  afterEach(() => {
    project.delete();
  });

  const runTool = async (args: Object, collaborators: any) => {
    const tool = findByNameokExtraTool('add_scene_events');
    if (!tool) throw new Error('add_scene_events tool not found');
    return tool.run(args, collaborators);
  };

  it('applies the batches locally and reports a project modification', async () => {
    const collaborators = makeCollaborators(project);
    const result = await runTool(
      {
        scene_name: 'TestScene',
        event_batches: [
          {
            event_script: 'always:\n  Wait(1)',
            placement_relation: 'insert_at_end',
          },
        ],
      },
      collaborators
    );

    expect(result.output.success).toBe(true);
    expect(result.didModifyProject).toBe(true);
    expect(
      collaborators.onSceneEventsModifiedOutsideEditor
    ).toHaveBeenCalledTimes(1);
  });

  it('degrades a wrong argument shape into a failure output, never a crash', async () => {
    const collaborators = makeCollaborators(project);

    const noScene = await runTool({}, collaborators);
    expect(noScene.output.success).toBe(false);

    const noBatches = await runTool({ scene_name: 'TestScene' }, collaborators);
    expect(noBatches.output.success).toBe(false);
    expect(noBatches.didModifyProject).toBe(false);

    const badBatches = await runTool(
      { scene_name: 'TestScene', event_batches: 'not-an-array' },
      collaborators
    );
    expect(badBatches.output.success).toBe(false);
  });

  it('answers generate_events identically (the hosted alias)', async () => {
    const collaborators = makeCollaborators(project);
    const tool = findByNameokExtraTool('generate_events');
    if (!tool) throw new Error('generate_events tool not found');

    const result = await tool.run(
      {
        scene_name: 'TestScene',
        event_batches: [
          {
            event_script: 'always:\n  Wait(3)',
            placement_relation: 'insert_at_end',
          },
        ],
      },
      collaborators
    );

    expect(result.output.success).toBe(true);
    expect(result.didModifyProject).toBe(true);
  });
});

describe('BYOK-only tools are all intercepted', () => {
  it('finds an interception for every BYOK_ONLY_TOOL_NAME', () => {
    // The validator skips the registry check for these names — this is the
    // counterpart guarantee: they exist because ByokExtraTools runs them.
    for (const name of BYOK_ONLY_TOOL_NAMES) {
      expect(findByNameokExtraTool(name)).not.toBeNull();
    }
  });
});

describe('load_skill interception tool', () => {
  const runLoad = async (args: Object) => {
    const tool = findByNameokExtraTool('load_skill');
    if (!tool) throw new Error('load_skill tool not found');
    return tool.run(args, makeCollaborators(null));
  };

  it('returns the body of a shipped skill', async () => {
    const result = await runLoad({ name: 'platformer-game' });

    expect(result.output.success).toBe(true);
    expect(result.output.skill.name).toBe('platformer-game');
    expect(result.output.skill.body).toContain('Platformer');
    expect(result.didModifyProject).toBe(false);
  });

  it('lists the available skills on an unknown name', async () => {
    const result = await runLoad({ name: 'no-such-skill' });

    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('no-such-skill');
    expect(result.output.message).toContain('platformer-game');
  });

  it('rejects a missing name without crashing', async () => {
    const result = await runLoad({});

    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('"name"');
  });
});

describe('search_docs / read_doc interception tools', () => {
  const runDocsTool = async (name: string, args: Object) => {
    const tool = findByNameokExtraTool(name);
    if (!tool) throw new Error(`${name} tool not found`);
    return tool.run(args, makeCollaborators(null));
  };

  it('search_docs finds the object-picking page', async () => {
    const result = await runDocsTool('search_docs', {
      query: 'object picking',
    });

    expect(result.output.success).toBe(true);
    expect(result.output.pages.join('\n')).toContain(
      'events/object-picking/index.md'
    );
  });

  it('read_doc returns a bundled page, capped', async () => {
    const result = await runDocsTool('read_doc', {
      page: 'events/object-picking/index.md',
    });

    expect(result.output.success).toBe(true);
    expect(result.output.page).toBe('events/object-picking/index.md');
    expect(result.output.content.length).toBeGreaterThan(0);
  });

  it('read_doc refuses a missing page without the online toggle', async () => {
    const result = await runDocsTool('read_doc', {
      page: 'events/never-bundled.md',
    });

    expect(result.output.success).toBe(false);
    expect(result.output.content).toContain('online docs expansion');
  });

  it('read_doc stays offline-first even when the online toggle is on', async () => {
    const tool = findByNameokExtraTool('read_doc');
    if (!tool) throw new Error('read_doc tool not found');
    // A bundled page is served directly: no fetch is attempted, whatever
    // the collaborators allow (the online fetch itself is covered by
    // ByokDocs.spec.js with an injected fetcher).
    const result = await tool.run(
      { page: 'events/index.md' },
      { ...makeCollaborators(null), onlineDocsEnabled: true }
    );
    expect(result.output.success).toBe(true);
    expect(result.output.page).toBe('events/index.md');
  });
});

describe('update_project_notes interception tool', () => {
  // The node test environment has no localStorage: give the notes a
  // minimal in-memory one (the real storage paths are exercised in
  // ByokProjectNotes.spec.js, which runs under jsdom).
  if (typeof (global: any).localStorage === 'undefined') {
    const backing: Map<string, string> = new Map();
    (global: any).localStorage = {
      getItem: (key: string) => (backing.has(key) ? backing.get(key) : null),
      setItem: (key: string, value: string) => {
        backing.set(key, String(value));
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
      clear: () => {
        backing.clear();
      },
    };
  }
  const runNotesTool = async (args: Object, identifier: string | null) => {
    const tool = findByNameokExtraTool('update_project_notes');
    if (!tool) throw new Error('update_project_notes tool not found');
    return tool.run(args, {
      ...makeCollaborators(null),
      getProjectNotesIdentifier: () => identifier,
    });
  };

  beforeEach(() => {
    (global: any).localStorage.clear();
  });

  it('merges the provided fields into the persisted notes', async () => {
    const first = await runNotesTool(
      { conventions: 'Use "mob_" prefixes.' },
      'file-id-notes'
    );
    expect(first.output.success).toBe(true);
    expect(first.didModifyProject).toBe(false);

    const second = await runNotesTool(
      { inProgress: 'Level 3 boss.' },
      'file-id-notes'
    );
    expect(second.output.success).toBe(true);
    expect(second.output.notes.conventions).toBe('Use "mob_" prefixes.');
    expect(second.output.notes.inProgress).toBe('Level 3 boss.');

    // The notes are persisted: a fresh call reads them back.
    const third = await runNotesTool({}, 'file-id-notes');
    expect(third.output.notes.conventions).toBe('Use "mob_" prefixes.');
    expect(third.output.notes.inProgress).toBe('Level 3 boss.');
  });

  it('answers with a failure while no project is open', async () => {
    const result = await runNotesTool({ conventions: 'x' }, null);
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('No project is open');
  });
});

describe('read_project_notes interception tool (Phase 12)', () => {
  // Same in-memory localStorage as the update tool above (node env).
  if (typeof (global: any).localStorage === 'undefined') {
    const backing: Map<string, string> = new Map();
    (global: any).localStorage = {
      getItem: (key: string) => (backing.has(key) ? backing.get(key) : null),
      setItem: (key: string, value: string) => {
        backing.set(key, String(value));
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
      clear: () => {
        backing.clear();
      },
    };
  }
  const runReadNotesTool = async (identifier: string | null) => {
    const tool = findByNameokExtraTool('read_project_notes');
    if (!tool) throw new Error('read_project_notes tool not found');
    return tool.run(
      {},
      {
        ...makeCollaborators(null),
        getProjectNotesIdentifier: () => identifier,
      }
    );
  };

  beforeEach(() => {
    (global: any).localStorage.clear();
  });

  it('reads back what update_project_notes wrote (same project)', async () => {
    const updateTool = findByNameokExtraTool('update_project_notes');
    if (!updateTool) throw new Error('update_project_notes tool not found');
    await updateTool.run(
      { conventions: 'Use "mob_" prefixes.', decisions: 'Pixel-art only.' },
      {
        ...makeCollaborators(null),
        getProjectNotesIdentifier: () => 'file-id-read',
      }
    );

    const result = await runReadNotesTool('file-id-read');
    expect(result.output.success).toBe(true);
    expect(result.didModifyProject).toBe(false);
    expect(result.output.notes.conventions).toBe('Use "mob_" prefixes.');
    expect(result.output.notes.decisions).toBe('Pixel-art only.');
  });

  it('succeeds with a clear message on empty notes', async () => {
    const result = await runReadNotesTool('file-id-empty');
    expect(result.output.success).toBe(true);
    expect(result.output.message).toContain('empty');
  });

  it('fails while no project is open, and stays per-project isolated', async () => {
    const noProject = await runReadNotesTool(null);
    expect(noProject.output.success).toBe(false);
    expect(noProject.output.message).toContain('No project is open');

    const otherProject = await runReadNotesTool('file-id-other');
    expect(otherProject.output.success).toBe(true);
    expect(otherProject.output.notes.conventions).toBe('');
  });
});

describe('search_reference interception tool', () => {
  const runSearch = async (args: Object) => {
    const tool = findByNameokExtraTool('search_reference');
    if (!tool) throw new Error('search_reference tool not found');
    return tool.run(args, makeCollaborators(null));
  };

  it('answers a query with compacted entries against the real catalog', async () => {
    const result = await runSearch({ query: 'lerp', kind: 'expression' });

    expect(result.output.success).toBe(true);
    expect(result.didModifyProject).toBe(false);
    expect(result.output.entries.length).toBeGreaterThan(0);
    expect(result.output.entries[0].name).toBe('lerp');
    // Compacted: an entry never carries a huge description.
    for (const entry of result.output.entries) {
      expect(entry.description.length).toBeLessThanOrEqual(201);
    }
  });

  it('reports an empty match set as a success with guidance', async () => {
    const result = await runSearch({
      query: 'zzz-no-such-instruction-zzz',
    });

    expect(result.output.success).toBe(true);
    expect(result.output.entries).toEqual([]);
    expect(result.output.message).toContain('No entry matched');
  });

  it('degrades a wrong argument shape into a search, never a crash', async () => {
    const result = await runSearch({ query: 42, kind: { nested: true } });

    expect(result.output.success).toBe(true);
    expect(Array.isArray(result.output.entries)).toBe(true);
  });
});
