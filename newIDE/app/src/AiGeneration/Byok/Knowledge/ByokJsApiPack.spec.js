// @flow
import { getByokJsApiCoreText } from './ByokJsApiPack';
import {
  getByokKnowledgeSections,
  estimateByokTokens,
  makeByokPromptContext,
} from './ByokKnowledgeSections';

describe('ByokJsApiPack', () => {
  const pack = getByokKnowledgeSections().find(
    section => section.id === 'js-api-core'
  );

  it('is registered as knowledge after the core sections', () => {
    if (!pack) throw new Error('The JS API pack is not registered');
    expect(pack.degradable).toBe(true);
    expect(pack.priority).toBeGreaterThanOrEqual(200);
  });

  it('fits its own declared budget', () => {
    if (!pack) throw new Error('The JS API pack is not registered');
    expect(
      estimateByokTokens(
        pack.build(
          makeByokPromptContext({ toolNames: [], hasOpenedProject: true })
        )
      )
    ).toBeLessThanOrEqual(pack.budgetTokens);
  });

  it('carries the JS scopes and the churn warning', () => {
    const text = getByokJsApiCoreText();

    expect(text).toContain('Prefer events');
    expect(text).toContain('runtimeScene');
    expect(text).toContain('eventsFunctionContext.getObjects');
    expect(text).toContain('eventsFunctionContext.getArgument');
    expect(text).toContain('this.owner');
    expect(text).toContain('gdjs.evtTools');
    expect(text).toContain('getRendererObject()');
    expect(text).toContain('get3DRendererObject()');
    expect(text).toContain('getThreeScene()');
  });
});
