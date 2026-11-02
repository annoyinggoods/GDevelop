// @flow
/**
 * Phase 18.2 — the events-tree wiring guard.
 *
 * `buildEventsTreeData` is internal to `EventsTree/index.js` (not exported,
 * and the tree itself needs the whole editor to render), so the integration
 * is pinned by SOURCE-level assertions on the exact call sites — the fork
 * module's behaviour itself is spec-proven in ForkGuardrailRules.spec.js.
 * If any wiring line is removed or renamed, this spec goes red.
 */
// Node built-ins through require (the carrier-spec pattern) so Flow resolves
// them, and __dirname under a FlowFixMe (a Node global jest provides).
// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const fs = require('fs');
// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const path = require('path');

const readSource = (relativePath: string): string =>
  // $FlowFixMe[cannot-resolve-name] - a Node global, used by this spec only.
  fs.readFileSync(path.join(__dirname, relativePath), 'utf8');

describe('the events tree guardrail wiring', () => {
  const indexSource = readSource('../../EventsSheet/EventsTree/index.js');
  const sortableTreeSource = readSource(
    '../../EventsSheet/EventsTree/SortableEventsTree.js'
  );
  const eventRendererSource = readSource(
    '../../EventsSheet/EventsTree/Renderers/EventRenderer.js'
  );

  it('imports the fork rule engine and badge into the tree module', () => {
    expect(indexSource).toContain(
      "from '../../Fork/Guardrails/ForkGuardrailRules'"
    );
    expect(indexSource).toContain('analyzeEventGuardrails');
    expect(indexSource).toContain(
      "import ForkGuardrailBadge from '../../Fork/Guardrails/ForkGuardrailBadge'"
    );
  });

  it('computes the guardrails per event with the ancestor stack', () => {
    expect(indexSource).toContain('analyzeEventGuardrails({');
    expect(indexSource).toContain('ancestors,');
    expect(indexSource).toContain('indexInList: i,');
    // The recursion threads the ancestor chain, exactly as specified.
    expect(indexSource).toContain(
      'ancestors.concat({ event, indexInList: i })'
    );
    // The node carries the field beside isValidElseEvent, and the synthetic
    // bottom-buttons/tutorial/empty-state nodes get the empty filler.
    expect(indexSource).toContain('guardrails,');
    expect(indexSource.match(/guardrails: \[\]/g) || []).toHaveLength(3);
  });

  it('renders the badge before the event component and forwards the field', () => {
    // One render site decorates every event type.
    expect(indexSource).toContain(
      '<ForkGuardrailBadge diagnostics={props.guardrails} />'
    );
    // Forwarded to the event renderers, the way isValidElseEvent is.
    expect(indexSource).toContain('guardrails={props.guardrails}');
    // Passed from the node to EventContainer by _renderEvent.
    expect(indexSource).toContain('guardrails={guardrails}');
  });

  it('types the new node field and the renderer props field', () => {
    expect(sortableTreeSource).toContain(
      'guardrails: $ReadOnlyArray<ForkGuardrailEventDiagnostic>'
    );
    expect(eventRendererSource).toContain(
      'guardrails?: $ReadOnlyArray<ForkGuardrailEventDiagnostic>'
    );
  });

  it('adds no CSS class or stylesheet for the badge (inline styles only)', () => {
    // The badge renders nothing but inline styles — the upstream CSS files
    // must be untouched by this feature (A18-5).
    const badgeSource = readSource('./ForkGuardrailBadge.js');
    expect(badgeSource).not.toContain('className');
    expect(badgeSource).not.toContain('.css');
  });
});
