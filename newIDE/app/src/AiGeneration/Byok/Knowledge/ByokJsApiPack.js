// @flow
import {
  registerByokKnowledgeSection,
  estimateByokTokens,
} from './ByokKnowledgeSections';

/**
 * The JS API pack (Phase 7.5): what JavaScript can touch in GDevelop, for
 * the run_script tool and JS code events. Churn risk is real (renderer
 * internals are version-dependent), so the pack opens with the "prefer
 * events" warning and keeps the deep signatures in the js-custom-rendering
 * skill.
 */

const JS_API_CORE = `- Prefer events. Reach for JavaScript only when events are clearly worse (complex data transforms, procedural content, per-frame math over many instances). Renderer internals are version-dependent: code that touches them can break with an engine update.
- In a JS code event, the scope gives you: \`runtimeScene\` (the gdjs.RuntimeScene), \`objects\` (the object lists of the event, as arrays of RuntimeObject), and the global \`gdjs\`.
- In an extension function (event function or behavior): \`eventsFunctionContext.getObjects("ObjectName")\` returns the object lists, \`eventsFunctionContext.getArgument("ArgName")\` the arguments; a behavior function has \`this.owner\` (the object it is attached to).
- The engine helpers live under \`gdjs.evtTools\`: common, string, object, camera, input, sound, storage, variable, window, network — the same implementations the built-in actions call.
- Renderer access (at your own risk): \`object.getRendererObject()\` is the PixiJS display object of an object instance, \`object.get3DRendererObject()\` the three.js one for 3D objects, and \`runtimeScene.getLayer("UI").getRenderer().getThreeScene()\` the three.js scene of a 3D layer.
- Signatures: the js-custom-rendering skill for the render-time API, and search_reference for the action/expression equivalents of what you want to do.
- Docs: [docs: events/js-code/index.md] covers JS code events — search_docs and read_doc can fetch it offline.`;

registerByokKnowledgeSection({
  id: 'js-api-core',
  title: 'JavaScript in GDevelop',
  priority: 230,
  budgetTokens: estimateByokTokens(JS_API_CORE) + 50,
  degradable: true,
  build: () => JS_API_CORE,
});

/** The core text, exposed for the content-marker tests. */
export const getByokJsApiCoreText = (): string => JS_API_CORE;
