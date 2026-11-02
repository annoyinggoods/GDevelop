---
name: juice-and-game-feel
description: Add game feel to an existing mechanic — screen shake, hit-stop, particles, tweens, flashes and sound, with restraint.
---

# Juice and game feel

## Order of impact (cheapest first)
1. **Sound** — one clean effect per event changes perception instantly.
2. **Tween** — scale/position/opacity easing on the acting object (impact: fast-in, slow-out).
3. **Flash** — blink the object white/red for 2-3 frames on hit (opacity tween or animation).
4. **Particles** — a short burst (Particle emitter, `destroy when out of lifetime`) at the impact point.
5. **Screen shake** — small camera offset decaying over ~0.2s; scale the amplitude with the damage.
6. **Hit-stop** — freeze the action 40-80ms on heavy hits (pause + timer, or scale `TimeDelta` to 0 for the duration).

## Mapping to GDevelop
- Shake: camera actions with a decaying offset (`CameraX() + RandomInRange(-Amp, Amp)`, Amp in a variable that decays each frame by `TimeDelta()`).
- Tweens: the **Tween** behavior (`tweenObjectPosition/Scale/Opacity`, easing names like "easeOutCubic"); or manual `lerp` in events.
- Particles: one emitter object per effect, started on demand, deleted when done.
- Hit-stop: store a `FreezeTimer`, set it on impact, and skip gameplay updates while it is > 0.

## Restraint rules
- 2-3 effects per impactful event, not 10. Everything shaking at once is noise.
- Feedback must mirror magnitude: a light tap (small shake, quiet sound), a boss hit (bigger everything).
- Sound first, always: silent feedback reads as broken.
- Never shake or flash longer than the event it celebrates.

## Verify
- Gameplay test: trigger the mechanic, assert the effects exist (object counts for particles), assert the shake amplitude decays to 0, assert gameplay resumes after hit-stop.
