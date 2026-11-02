---
name: 3d-scene-basics
description: Work with 3D in GDevelop — 3D objects, the Z axis, 3D camera, lighting and the Physics 3D (Jolt) behavior.
---

# 3D scene basics

## The Z axis
- 3D adds Z (elevation). X/Y stay the screen plane; Z grows "into" the scene depending on the camera. Never reuse 2D depth intuition — read positions from describe_instances.
- 3D objects: **3D box** and **3D model** (Base3DBehavior gives position/size/rotation including Z, plus scale and flips on all axes).

## Camera
- First person: attach the camera to a character (CameraX/Y/Z actions + angle). Third person: offset the camera behind the player, optionally orbit with mouse movement.
- Layers can be 3D: `runtimeScene.getLayer("UI").getRenderer().getThreeScene()` is the three.js scene (renderer access is version-dependent — prefer actions).

## Lighting and materials
- Directional/ambient/hemisphere lights are scene effects (search_reference "light"): one directional light for the sun, low ambient so shadows are not flat black.
- Fog and skybox are layer/scene effects — cheap atmosphere wins.

## Physics 3D (Jolt)
- The **Physics 3D** behavior supports rigid bodies, a character mode (capsule controller — use it for players, not manual Z math) and a car mode.
- Same discipline as 2D physics: defaults first, change one property at a time, verify in a preview. Gravity is a 3D vector.
- Collision shapes follow the object; keep shapes simple (boxes, spheres, capsules) — mesh-accurate shapes are expensive and wobbly.

## Verify
- Gameplay test: step frames, assert Z changed after a jump, assert the character does not fall through the floor (Z stays above the ground plane).
