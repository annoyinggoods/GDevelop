// @flow
// Smoke tests for the generator's parser (scripts/byokEngineReferenceParser.js),
// run on fixture subsets — one small JS extension shape and one C++ builtin
// shape — per Phase 7.2.
import {
  parseExtensionSource,
  unquoteArgument,
  parseArgumentList,
} from '../../../scripts/byokEngineReferenceParser';

const FAKE_JS_EXTENSION = `
module.exports = {
  createExtension: function (_, gd) {
    const extension = new gd.PlatformExtension();
    extension
      .setExtensionInformation(
        'FakeExt',
        _('Fake extension'),
        _('A fixture extension.'),
        'Someone',
        'MIT'
      );
    extension
      .addBehavior(
        'FakeBehavior',
        _('Fake behavior'),
        'FakeObject',
        _('Does something useful to objects, with a long enough description.'),
        '',
        'res/fake.svg',
        'FakeBehavior',
        new gd.Behavior(),
        new gd.BehaviorsSharedData()
      )
      .addParameter('object', _('Object'), '', false);
    extension
      .addAction(
        'DoSomething',
        _('Do something'),
        _('Do something nice to _PARAM0_'),
        _('Fake'),
        'res/fake.svg'
      )
      .addParameter('object', _('Object'), '', false)
      .addParameter('string', _('The name'), 'FakeObject');
    extension
      .addExpressionAndConditionAndAction(
        'number',
        'FakeValue',
        _('Fake value'),
        _('the fake value of _PARAM0_'),
        _('the fake value of _PARAM0_ to _PARAM1__PARAM2_'),
        _('Fake'),
        'res/fake.svg'
      )
      .addParameter('object', _('Object'), '', false);
  }
};
`;

const FAKE_BUILTIN_CPP = `
#include "AllBuiltinExtensions.h"

void GD_CORE_API
BuiltinExtensionsImplementer::ImplementsFakeExtension(
    gd::PlatformExtension& extension) {
  extension.SetExtensionInformation(
      "BuiltinFake",
      _("Fake tools"),
      "Fake builtin instructions.",
      "Someone",
      "Open source (MIT License)")
      .SetShortDescription("Fake short description.");

  extension
      .AddExpression("FakeRandom",
                     _("Fake random"),
                     _("Random fake number"),
                     "",
                     "res/dice-6.svg")
      .AddParameter("expression", _("Maximum value"))
      .AddParameter("expression", _("Minimum value"));

  extension
      .AddObject<gd::ObjectConfiguration>("FakeObject",
                     _("Fake object"),
                     _("A fake object with a long description for tests."),
                     "res/fake.png",
                     "Fake");
}
`;

describe('byokEngineReferenceParser', () => {
  it('reduces string and translation-wrapped arguments to plain strings', () => {
    expect(unquoteArgument(`'Fake'`)).toBe('Fake');
    expect(unquoteArgument(`_("Multi line " "adjacent literal.")`)).toBe(
      'Multi line adjacent literal.'
    );
    expect(unquoteArgument(`"with \\"escapes\\" inside"`)).toBe(
      'with "escapes" inside'
    );
    expect(unquoteArgument('gd.ParameterOptions.makeNewOptions()')).toBe(null);
    expect(unquoteArgument('42')).toBe(null);
    expect(unquoteArgument('')).toBe(null);
  });

  it('parses a balanced argument list with nested calls', () => {
    const parsed = parseArgumentList(`('a', _('b c'), new Foo())`, 0);
    if (!parsed) throw new Error('The list did not parse');
    expect(parsed.args).toEqual([`'a'`, `_('b c')`, 'new Foo()']);
  });

  it('returns null for an unterminated argument list', () => {
    expect(parseArgumentList(`('a', 'b'`, 0)).toBe(null);
  });

  it('parses a fixture JS extension into entries with parameters', () => {
    const { entries, owner, warnings } = parseExtensionSource(
      FAKE_JS_EXTENSION,
      { language: 'js', ownerFallback: 'FakeExt', sourceName: 'fake.js' }
    );

    expect(warnings).toEqual([]);
    expect(owner).toBe('FakeExt');

    const behavior = entries.find(entry => entry.kind === 'behavior');
    expect(behavior && behavior.name).toBe('FakeBehavior');
    expect(behavior && behavior.description).toContain('Does something useful');
    expect(behavior && behavior.parameters).toEqual([
      { type: 'object', description: 'Object' },
    ]);

    const action = entries.find(
      entry => entry.kind === 'action' && entry.name === 'DoSomething'
    );
    expect(action && action.description).toContain('Do something nice');

    // One declaration, three entry kinds.
    const valueEntries = entries.filter(entry => entry.name === 'FakeValue');
    expect(valueEntries.map(entry => entry.kind).sort()).toEqual([
      'action',
      'condition',
      'expression',
    ]);
    expect(valueEntries[0].owner).toBe('FakeExt');
  });

  it('parses a fixture C++ builtin extension into entries', () => {
    const { entries, owner } = parseExtensionSource(FAKE_BUILTIN_CPP, {
      language: 'cpp',
      ownerFallback: 'BuiltinFake',
      sourceName: 'fake.cpp',
    });

    expect(owner).toBe('BuiltinFake');

    const expression = entries.find(
      entry => entry.kind === 'expression' && entry.name === 'FakeRandom'
    );
    expect(expression && expression.description).toBe('Random fake number');
    expect(expression && expression.parameters).toEqual([
      { type: 'expression', description: 'Maximum value' },
      { type: 'expression', description: 'Minimum value' },
    ]);

    const object = entries.find(entry => entry.kind === 'object');
    expect(object && object.name).toBe('FakeObject');
    expect(object && object.description).toContain('long description');
  });

  it('tolerates a broken source: skipped entries, no crash', () => {
    const { entries, warnings } = parseExtensionSource(
      `extension.addAction('Name', _('A sentence that is long enough.')`,
      { language: 'cpp', ownerFallback: 'Broken', sourceName: 'broken.cpp' }
    );
    expect(entries).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
