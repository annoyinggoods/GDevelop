// @flow
import { getByokGameDesignCoreText } from './ByokGameDesignPack';
import {
  getByokKnowledgeSections,
  estimateByokTokens,
  makeByokPromptContext,
} from './ByokKnowledgeSections';

describe('ByokGameDesignPack', () => {
  const pack = getByokKnowledgeSections().find(
    section => section.id === 'game-design-core'
  );

  it('is registered as knowledge after the core sections', () => {
    if (!pack) throw new Error('The game-design pack is not registered');
    expect(pack.degradable).toBe(true);
    expect(pack.priority).toBeGreaterThanOrEqual(200);
  });

  it('fits its own declared budget', () => {
    if (!pack) throw new Error('The game-design pack is not registered');
    expect(
      estimateByokTokens(
        pack.build(
          makeByokPromptContext({ toolNames: [], hasOpenedProject: true })
        )
      )
    ).toBeLessThanOrEqual(pack.budgetTokens);
  });

  it('carries the design-first content markers', () => {
    const text = getByokGameDesignCoreText();

    expect(text).toContain('core loop');
    expect(text).toContain('player verb');
    expect(text).toContain('feedback');
    expect(text).toContain('Tween');
    expect(text).toContain('Particle emitter');
    expect(text).toContain('camera actions');
    expect(text).toContain('introduce → combine → twist');
    expect(text).toContain('variables, never literals');
    expect(text).toContain('smallest playable slice');
  });

  it('cites no external source', () => {
    const text = getByokGameDesignCoreText();
    expect(text).not.toContain('http');
    expect(text).not.toContain('according to');
  });
});
