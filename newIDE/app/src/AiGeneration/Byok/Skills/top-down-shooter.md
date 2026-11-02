---
name: top-down-shooter
description: Build or tune a top-down shooter/twin-stick game — 8-direction movement, aiming, projectiles, enemy waves and hit feedback.
---

# Top-down shooters

## Setup
- Player: **Top-down movement** behavior (acceleration/damping for weight). Keep `Rotate with movement` off if the player aims independently.
- Aiming: point at the mouse (`Set angle toward position`, MouseX()/MouseY()) or at the nearest enemy (`NearestEnemyX()`-style expressions from search_reference).
- Bullets: one Bullet object with the **Bullet/physics-free** movement (speed in a variable), created at the muzzle position, deleted when out of the window or on collision.

## Enemy waves
- Spawn from off-screen points with `Timer` + `RandomInRange`, scaling count with elapsed time (difficulty curve: introduce → combine → twist).
- Enemy AI in tiers: (1) walk toward player, (2) keep distance and shoot, (3) charge with telegraph (flash before dashing). Telegraphing is what makes it fair.
- Object pools are unnecessary: creating/deleting is fine at this scale; cap simultaneous enemies with a variable.

## Hit feedback (per hit, not per wave)
- Flash the shooter white (opacity or a `Flash/Tween`), small particles at the impact, screen shake scaled to damage, one-shot sound.
- Enemies: health in an object variable; damage = subtract, compare, delete; spawn a short "pop" (particles + tween scale) on death.

## Player death and restart
- Health with brief invulnerability after a hit (Timer + opacity blink) — instant restart loops feel unfair without it.
- Game over: show score, offer restart. Restart resets variables explicitly (do not rely on scene defaults).

## Verify
- Gameplay test: simulate movement + shooting, assert bullets are deleted on collision, assert enemy count decreases on hit, assert player death triggers the game-over state.
