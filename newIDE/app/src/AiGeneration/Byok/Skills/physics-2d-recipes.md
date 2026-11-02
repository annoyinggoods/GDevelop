---
name: physics-2d-recipes
description: Recipes for the Physics 2 behavior (Box2D) — bodies, joints, forces vs impulses, and the default discipline for density/friction/restitution.
---

# Physics 2D recipes (Physics 2 behavior, Box2D)

## Bodies
- **Dynamic**: moves and is moved by forces (the player, crates). **Static**: never moves (the ground). **Kinematic**: moved only by events (moving platforms).
- Defaults are sane: change density/friction/restitution one property at a time (change_behavior_property), and verify in a preview after each change. Realistic densities matter only relative to each other.
- Bullet mode for fast projectiles, or they tunnel through thin walls.

## Forces vs impulses
- **Force**: continuous push applied every frame while a condition holds (a thruster). Scales with mass and time.
- **Impulse**: an instant kick (a jump, an explosion). One call, not per-frame.
- Applying a force every frame AND an impulse is almost always a bug — pick one per mechanic.

## Joints (12 types exist)
- Revolute (hinge — doors, wheels), Distance (rope-ish link), Prismatic (piston/slide), Weld (rigid glue), Wheel (suspension), Motor joint (constant-speed motion), Pulley, Rope, Gear, Mouse (drag with the pointer), Friction, target joints. search_reference "joint" lists them all with parameters.
- Breakable joints: compare joint reaction force in events and delete the joint past a threshold.

## Classic gotchas
- Scale: Box2D works in meters — the behavior converts pixels; keep `Gravity` negative on Y (e.g. -900) for downward gravity.
- Sleeping bodies: a body at rest stops being simulated until touched — expected, not a bug.
- Stacking instability: lower `max sub steps`/increase iteration settings only after simplifying shapes (convex, few vertices).

## Verify
- Gameplay test: step frames with gravity, assert the crate falls and lands on the static ground; apply an impulse, assert displacement; assert a joint constrains the relative motion.
