// @flow
import { getByokMathPhysicsCoreText } from './ByokMathPhysicsPack';
import {
  getByokKnowledgeSections,
  estimateByokTokens,
  makeByokPromptContext,
} from './ByokKnowledgeSections';

describe('ByokMathPhysicsPack', () => {
  const pack = getByokKnowledgeSections().find(
    section => section.id === 'math-physics-core'
  );

  it('is registered as knowledge after the core sections', () => {
    if (!pack) throw new Error('The math/physics pack is not registered');
    expect(pack.degradable).toBe(true);
    expect(pack.priority).toBeGreaterThanOrEqual(200);
  });

  it('fits its own declared budget', () => {
    if (!pack) throw new Error('The math/physics pack is not registered');
    expect(
      estimateByokTokens(
        pack.build(
          makeByokPromptContext({ toolNames: [], hasOpenedProject: true })
        )
      )
    ).toBeLessThanOrEqual(pack.budgetTokens);
  });

  it('carries the never-compute-in-your-head and TimeDelta rules', () => {
    const text = getByokMathPhysicsCoreText();

    expect(text).toContain('Never compute geometry or arithmetic in your head');
    expect(text).toContain('TimeDelta()');
    expect(text).toContain('Frame-rate independence');
    expect(text).toContain('DEGREES');
    expect(text).toContain('90° is DOWN');
    expect(text).toContain('AngleBetweenPositions');
    expect(text).toContain('RandomFloatInRange');
    expect(text).toContain('run_script');
  });

  it('names the physics systems and their parameter discipline', () => {
    const text = getByokMathPhysicsCoreText();

    expect(text).toContain('Box2D');
    expect(text).toContain('12 joint types');
    expect(text).toContain('Platformer behavior');
    expect(text).toContain('change_behavior_property');
    expect(text).toContain('Jolt');
  });
});
