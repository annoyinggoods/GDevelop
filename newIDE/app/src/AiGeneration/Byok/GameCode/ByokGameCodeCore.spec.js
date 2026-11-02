// @flow

/**
 * The Phase 15.1 pure rules. These are the specs the whole feature rests
 * on: the confinement (A15-3), the load order (D15-3a / A15-1), the
 * namespace (D15-12) and the exported script names the hot reload fetches.
 */

import {
  BYOK_GAME_CODE_MAX_FILE_BYTES,
  BYOK_GAME_CODE_MAX_PATH_LENGTH,
  BYOK_GAME_CODE_NAMESPACE_ROOT,
  computeByokGameCodeExportedScriptNames,
  getByokGameCodeFolderName,
  getByokGameCodeNamespaceExpression,
  getByokGameCodeNamespacePrologue,
  getByokGameCodeNamespaceSegments,
  getByokGameCodeProjectRelativeFilePath,
  getByokGameCodeResourceName,
  normalizeByokGameCodeRelativePath,
  orderByokGameCodeRelativePaths,
} from './ByokGameCodeCore';

describe('getByokGameCodeFolderName', () => {
  it('derives <GameName>Code from the project name', () => {
    expect(getByokGameCodeFolderName('My Awesome Game')).toBe(
      'My Awesome GameCode'
    );
  });

  it('sanitizes a project name that would escape the project folder', () => {
    // A project name is user text; a separator in it would put the game
    // code folder outside the project folder.
    expect(getByokGameCodeFolderName('../../etc')).not.toContain('/');
    expect(getByokGameCodeFolderName('..\\..\\etc')).not.toContain('\\');
    expect(getByokGameCodeFolderName('a/b')).not.toContain('/');
  });

  it('falls back to GameCode when the name sanitizes away to nothing', () => {
    expect(getByokGameCodeFolderName('')).toBe('GameCode');
    expect(getByokGameCodeFolderName('   ')).toBe('GameCode');
    expect(getByokGameCodeFolderName('///')).toBe('GameCode');
  });

  it('always ends with the Code suffix', () => {
    expect(getByokGameCodeFolderName('Platformer')).toMatch(/Code$/);
  });
});

describe('normalizeByokGameCodeRelativePath (A15-3 confinement)', () => {
  it('accepts a nested path and returns it normalized', () => {
    expect(normalizeByokGameCodeRelativePath('character/spawn.js')).toEqual({
      ok: true,
      relativePath: 'character/spawn.js',
    });
  });

  it('normalizes backslashes to the single canonical separator', () => {
    // `character\spawn.js` is the same file as `character/spawn.js` on
    // Windows: one spelling per file is what keeps the resource registry
    // and the manifest consistent.
    expect(normalizeByokGameCodeRelativePath('character\\spawn.js')).toEqual({
      ok: true,
      relativePath: 'character/spawn.js',
    });
  });

  it('drops empty and "." segments so there is one spelling per file', () => {
    expect(normalizeByokGameCodeRelativePath('./character//spawn.js')).toEqual({
      ok: true,
      relativePath: 'character/spawn.js',
    });
  });

  it('refuses a backslash traversal', () => {
    const result = normalizeByokGameCodeRelativePath('..\\..\\secrets.js');
    expect(result.ok).toBe(false);
  });

  it('refuses a parent traversal at any depth', () => {
    expect(normalizeByokGameCodeRelativePath('../secrets.js').ok).toBe(false);
    expect(
      normalizeByokGameCodeRelativePath('character/../../secrets.js').ok
    ).toBe(false);
    expect(normalizeByokGameCodeRelativePath('a/b/../../../c.js').ok).toBe(
      false
    );
  });

  it('refuses absolute paths', () => {
    expect(normalizeByokGameCodeRelativePath('/etc/passwd.js').ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath('C:/Windows/x.js').ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath('c:secrets.js').ok).toBe(false);
  });

  it('refuses a NUL byte anywhere in the path', () => {
    const nul = String.fromCharCode(0);
    expect(normalizeByokGameCodeRelativePath('spawn.js' + nul).ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath(nul + 'spawn.js').ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath('sp' + nul + 'awn.js').ok).toBe(
      false
    );
  });

  it('refuses an empty or non-string path', () => {
    expect(normalizeByokGameCodeRelativePath('').ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath('///').ok).toBe(false);
    // The model can send anything, so the gate takes `mixed` and refuses
    // it itself rather than trusting its caller.
    expect(normalizeByokGameCodeRelativePath(null).ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath(undefined).ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath(42).ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath({}).ok).toBe(false);
  });

  it('refuses Windows device names, which are real files with odd behaviour', () => {
    expect(normalizeByokGameCodeRelativePath('NUL.js').ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath('con.js').ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath('character/LPT1.js').ok).toBe(
      false
    );
    // A name that merely STARTS with a reserved name is fine.
    expect(normalizeByokGameCodeRelativePath('nullify.js')).toEqual({
      ok: true,
      relativePath: 'nullify.js',
    });
  });

  it('refuses names Windows cannot store', () => {
    expect(normalizeByokGameCodeRelativePath(' spawn.js').ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath('spawn.js ').ok).toBe(false);
    // A trailing dot is stripped by Windows, so the file the exporter later
    // looks for would not be the file that was written.
    expect(normalizeByokGameCodeRelativePath('trailing./spawn.js').ok).toBe(
      false
    );
    expect(normalizeByokGameCodeRelativePath('spawn.*.js').ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath('a<b.js').ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath('a|b.js').ok).toBe(false);
  });

  it('refuses anything that is not a .js file', () => {
    expect(normalizeByokGameCodeRelativePath('notes.txt').ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath('spawn').ok).toBe(false);
    expect(normalizeByokGameCodeRelativePath('.js').ok).toBe(false);
  });

  it('refuses absurdly long paths and segments', () => {
    expect(normalizeByokGameCodeRelativePath('a'.repeat(3000) + '.js').ok).toBe(
      false
    );
    expect(
      normalizeByokGameCodeRelativePath('spawn' + 'a'.repeat(300) + '.js').ok
    ).toBe(false);
  });

  it('accepts the longest valid path and refuses one character more', () => {
    // The longest path that is BOTH within the cap and a legal file name is
    // 1023 characters: three 255-character segments, three separators and a
    // 255-character `.js` file name. One character more is refused.
    const longestValid =
      'a'.repeat(255) +
      '/' +
      'b'.repeat(255) +
      '/' +
      'c'.repeat(255) +
      '/' +
      'd'.repeat(252) +
      '.js';
    expect(longestValid.length).toBe(BYOK_GAME_CODE_MAX_PATH_LENGTH - 1);
    expect(normalizeByokGameCodeRelativePath(longestValid).ok).toBe(true);
    expect(normalizeByokGameCodeRelativePath('e/' + longestValid).ok).toBe(
      false
    );
  });

  it('carries an actionable error for every refusal', () => {
    const result = normalizeByokGameCodeRelativePath('../x.js');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/escapes the game code/i);
  });
});

describe('orderByokGameCodeRelativePaths (D15-3a)', () => {
  it('puts the folder root and core/ first, then the other groupings', () => {
    expect(
      orderByokGameCodeRelativePaths([
        'enemy/spawn.js',
        'character/spawn.js',
        'core/boot.js',
        'main.js',
      ])
    ).toEqual([
      'core/boot.js',
      'main.js',
      'character/spawn.js',
      'enemy/spawn.js',
    ]);
  });

  it('sorts files alphabetically inside a grouping', () => {
    expect(
      orderByokGameCodeRelativePaths([
        'character/zombie.js',
        'character/hero.js',
        'character/attack.js',
      ])
    ).toEqual([
      'character/attack.js',
      'character/hero.js',
      'character/zombie.js',
    ]);
  });

  it('sorts the tier-2 groupings alphabetically among themselves', () => {
    expect(
      orderByokGameCodeRelativePaths([
        'lava/burn.js',
        'floor/collision.js',
        'enemy/spawn.js',
        'character/hero.js',
      ])
    ).toEqual([
      'character/hero.js',
      'enemy/spawn.js',
      'floor/collision.js',
      'lava/burn.js',
    ]);
  });

  it('is deterministic and total whatever order the input arrives in', () => {
    const paths = [
      'zeta.js',
      'core/a.js',
      'core/b.js',
      'alpha.js',
      'enemy/z.js',
      'enemy/a.js',
      'character/m.js',
    ];
    const expected = [
      'alpha.js',
      'core/a.js',
      'core/b.js',
      'zeta.js',
      'character/m.js',
      'enemy/a.js',
      'enemy/z.js',
    ];
    // Every rotation of the input must produce the SAME order: that is what
    // "total" means here, and what stops a filesystem's listing order from
    // leaking into the game's boot order.
    for (let shift = 0; shift < paths.length; shift++) {
      const rotated = paths.slice(shift).concat(paths.slice(0, shift));
      expect(orderByokGameCodeRelativePaths(rotated)).toEqual(expected);
    }
  });

  it('orders mixed case deterministically', () => {
    const first = orderByokGameCodeRelativePaths(['B.js', 'a.js', 'C.js']);
    const second = orderByokGameCodeRelativePaths(['C.js', 'B.js', 'a.js']);
    expect(first).toEqual(second);
    expect(first).toEqual(['B.js', 'C.js', 'a.js']);
  });

  it('handles deeply nested and mixed-tier paths', () => {
    expect(
      orderByokGameCodeRelativePaths([
        'character/hero/attack.js',
        'core/boot/early.js',
        'core/late.js',
        'z.js',
      ])
    ).toEqual([
      'core/boot/early.js',
      'core/late.js',
      'z.js',
      'character/hero/attack.js',
    ]);
  });

  it('returns an empty array for an empty listing', () => {
    expect(orderByokGameCodeRelativePaths([])).toEqual([]);
  });
});

describe('D15-12 folder-derived namespace', () => {
  it('maps a grouping file to its dotted namespace', () => {
    expect(getByokGameCodeNamespaceSegments('character/spawn.js')).toEqual([
      'character',
      'spawn',
    ]);
    expect(getByokGameCodeNamespaceExpression('character/spawn.js')).toBe(
      BYOK_GAME_CODE_NAMESPACE_ROOT + '.character.spawn'
    );
  });

  it('maps a root file to the root namespace', () => {
    expect(getByokGameCodeNamespaceSegments('main.js')).toEqual(['main']);
    expect(getByokGameCodeNamespaceExpression('main.js')).toBe(
      BYOK_GAME_CODE_NAMESPACE_ROOT + '.main'
    );
  });

  it('does not nest inside the core/ marker folder', () => {
    expect(getByokGameCodeNamespaceSegments('core/boot.js')).toEqual(['boot']);
    expect(getByokGameCodeNamespaceExpression('core/boot.js')).toBe(
      BYOK_GAME_CODE_NAMESPACE_ROOT + '.boot'
    );
  });

  it('creates the namespace defensively so order never blocks a load', () => {
    expect(getByokGameCodeNamespacePrologue('main.js')).toBe(
      'GameCode = window.GameCode || {};'
    );
    expect(getByokGameCodeNamespacePrologue('character/spawn.js')).toBe(
      'GameCode = window.GameCode || {};\n' +
        'GameCode.character = GameCode.character || {};'
    );
  });

  it('creates every grouping on the way to a deeply nested file', () => {
    expect(getByokGameCodeNamespacePrologue('character/hero/attack.js')).toBe(
      'GameCode = window.GameCode || {};\n' +
        'GameCode.character = GameCode.character || {};\n' +
        'GameCode.character.hero = GameCode.character.hero || {};'
    );
  });
});

describe('computeByokGameCodeExportedScriptNames', () => {
  it('uses the file name when there is no collision', () => {
    expect(
      computeByokGameCodeExportedScriptNames(
        ['main.js', 'character/hero.js'],
        []
      )
    ).toEqual([
      { relativePath: 'main.js', scriptName: 'main.js' },
      { relativePath: 'character/hero.js', scriptName: 'hero.js' },
    ]);
  });

  it('suffixes our OWN duplicate base names in load order', () => {
    // The exporter copies resources flat and renames on collision, so the
    // second `spawn.js` ships as `spawn2.js`. We know the order, so we know
    // which one keeps the name.
    expect(
      computeByokGameCodeExportedScriptNames(
        ['character/spawn.js', 'enemy/spawn.js', 'main.js', 'spawn.js'],
        []
      )
    ).toEqual([
      { relativePath: 'character/spawn.js', scriptName: 'spawn.js' },
      { relativePath: 'enemy/spawn.js', scriptName: 'spawn2.js' },
      { relativePath: 'main.js', scriptName: 'main.js' },
      { relativePath: 'spawn.js', scriptName: 'spawn3.js' },
    ]);
  });

  it('skips a suffix a previous file already took', () => {
    // Faithful to NewNameGenerator: a file literally named `spawn2.js`
    // collides on the FULL name, so it is suffixed from ITS base name
    // (`spawn2` -> `spawn22.js`), not from the base name of the file that
    // took `spawn2.js`. This mirrors what the exporter actually emits.
    expect(
      computeByokGameCodeExportedScriptNames(
        ['a/spawn.js', 'b/spawn.js', 'spawn2.js', 'c/spawn.js'],
        []
      ).map(entry => entry.scriptName)
    ).toEqual(['spawn.js', 'spawn2.js', 'spawn22.js', 'spawn3.js']);
  });

  it('reports the WHOLE set as unknown when a foreign resource claims a name', () => {
    // The exporter walks the whole project, so which of the two keeps
    // `spawn.js` is not ours to decide. Guessing would fetch a URL that
    // 404s, so the caller hard-reloads instead.
    expect(
      computeByokGameCodeExportedScriptNames(
        ['character/spawn.js', 'enemy/spawn.js', 'main.js'],
        ['spawn.js']
      )
    ).toEqual([
      { relativePath: 'character/spawn.js', scriptName: null },
      { relativePath: 'enemy/spawn.js', scriptName: null },
      { relativePath: 'main.js', scriptName: null },
    ]);
  });

  it('does not mistake a foreign name that merely shares a prefix', () => {
    expect(
      computeByokGameCodeExportedScriptNames(['spawn.js'], ['spawn.js.map'])[0]
        .scriptName
    ).toBe('spawn.js');
  });

  it('returns an empty list for an empty project', () => {
    expect(computeByokGameCodeExportedScriptNames([], [])).toEqual([]);
  });
});

describe('registry names', () => {
  it('keys a resource by its path inside the game code folder', () => {
    expect(
      getByokGameCodeResourceName('character/spawn.js', 'MyGameCode')
    ).toBe('MyGameCode/character/spawn.js');
  });

  it('points a resource at the file relative to the project folder', () => {
    expect(
      getByokGameCodeProjectRelativeFilePath('main.js', 'MyGameCode')
    ).toBe('MyGameCode/main.js');
  });
});

describe('the size cap', () => {
  it('is above any hand-written script and finite', () => {
    expect(BYOK_GAME_CODE_MAX_FILE_BYTES).toBeGreaterThan(16 * 1024);
    expect(BYOK_GAME_CODE_MAX_FILE_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });
});
