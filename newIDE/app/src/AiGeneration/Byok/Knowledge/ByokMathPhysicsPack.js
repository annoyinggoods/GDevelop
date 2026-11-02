// @flow
import {
  registerByokKnowledgeSection,
  estimateByokTokens,
} from './ByokKnowledgeSections';

/**
 * The math/physics pack (Phase 7.5): the prompt-level fix for the
 * documented LLM failure modes — mental arithmetic, angle conventions,
 * frame-rate dependence, and invented physics parameters. The core is
 * always-on; the deep recipes (Box2D joints, Platformer tuning, Jolt 3D)
 * live in the physics-2d-recipes and 3d-scene-basics skills.
 */

const MATH_PHYSICS_CORE = `- Never compute geometry or arithmetic in your head: use expressions (lerp, clamp, AngleBetweenPositions, DistanceBetweenPositions, XFromAngleAndDistance…) or compute inside run_script. Mental math is how positions end up off-screen.
- Frame-rate independence: multiply every movement, acceleration and timer by TimeDelta(). Position += 250 * TimeDelta() means "250 pixels per second"; without TimeDelta() the speed depends on the player's framerate.
- Angles are DEGREES, 0° points right (positive X), and angles grow CLOCKWISE on screen (because the Y axis points down): 90° is DOWN, 270° is UP. This is the classic trip-up — when a direction looks inverted, it usually is the Y axis.
- Vectors: to move toward a target, use XFromAngleAndDistance/YFromAngleAndDistance with AngleBetweenPositions, or lerp for smooth interpolation. To normalize a direction, divide by DistanceBetweenPositions (guard against 0).
- Probability: RandomInRange(min, max) for integers, RandomFloatInRange(min, max) for continuous rolls. Weighted tables belong in a structure variable, not in nested ifs.
- Physics engines compute the physics for you — never hand-integrate velocity/acceleration in events unless the object has no physics behavior.
- Box2D 2D (Physics 2 behavior): 12 joint types exist (revolute, distance, prismatic, wheel, motor…), forces vs impulses are different actions, and density/friction/restitution have sane defaults — change one property at a time and verify in a preview.
- Platformer characters (Platformer behavior): gravity, max falling speed, jump speed and slope behavior are named parameters of the behavior — set them with change_behavior_property, never by moving the object manually.
- 3D (Physics 3D behavior, Jolt): rigid bodies, character and car modes exist; 3D positions add the Z axis (Z is elevation, not "up" in the property names — read the parameter descriptions with search_reference).`;

registerByokKnowledgeSection({
  id: 'math-physics-core',
  title: 'Math and physics rules',
  priority: 220,
  budgetTokens: estimateByokTokens(MATH_PHYSICS_CORE) + 50,
  degradable: true,
  build: () => MATH_PHYSICS_CORE,
});

/** The core text, exposed for the content-marker tests. */
export const getByokMathPhysicsCoreText = (): string => MATH_PHYSICS_CORE;
