---
name: js-custom-rendering
description: Custom rendering with JS — accessing the PixiJS/three.js objects behind GDevelop objects, layers and effects, with the churn-risk discipline.
---

# JS custom rendering

## Risk discipline first
- Everything below touches renderer internals: verify against the **bundled runtime version**, expect API changes between engine updates, and wrap risky access in feature checks (`if (!object.getRendererObject) return;`).
- Use events for gameplay; use this only for what events genuinely cannot do (custom shaders, procedural meshes, exotic blend effects).

## PixiJS (2D)
- `runtimeScene.getRenderer().getPIXIRenderer()` is the renderer; each object instance exposes `getRendererObject()` (a PIXI.DisplayObject).
- Common moves: set `tint`/`alpha`, swap `texture` from the runtime texture cache, add custom PIXI filters to the object or to a layer's container.
- Layer access: `runtimeScene.getLayer("Base layer").getRenderer().getRendererContainer()` groups that layer's objects.

## three.js (3D)
- `object.get3DRendererObject()` is the three.js Object3D of a 3D object instance; `runtimeScene.getLayer(name).getRenderer().getThreeScene()` is the scene.
- Common moves: swap materials for effects, attach lightweight custom geometry, animate shader uniforms each frame (guard the uniform exists).

## Rules that keep it maintainable
- One JS code event (or run_script) per effect, clearly commented, never interleaved with the event-sheet logic.
- Cache lookups once per frame; do not walk the scene graph per object per frame in JS when an event could pass the picked objects.
- Always keep an events-only fallback path so the game still runs if the renderer code throws.

## Verify
- After any custom rendering change: capture a screenshot and compare against the expected look; check the preview console for renderer warnings.
