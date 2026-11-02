---
name: platformer-game
description: Build or tune a side-view platformer — player movement, jumping feel, platforms, hazards, checkpoints and level flow.
---

# Platformer games

## Setup
- Player object + **Platformer character** behavior: set `Max falling speed`, `Gravity`, `Jump speed` (via change_behavior_property, by name). Put the numbers in scene variables first so they can be tuned.
- Platforms: **Platform** behavior (`Platform type`: Normal, Jump-through, or Ladder). Jump-through platforms let the player jump up through and land on top.
- Camera: **Camera follow** action each frame (`Center camera on position`, with damping) — keep the player slightly off-center toward the movement direction.

## Feel checklist (do these by default)
- Coyote time: allow a jump ~0.1s after leaving a ledge (`Timer` + `once`).
- Jump buffering: if jump is pressed slightly before landing, jump on landing.
- Variable jump height: releasing the jump key early cuts upward velocity.
- Squash & stretch on land/jump (Tween scale), dust particles on landing.

## Hazards and deaths
- Kill on fall below `SceneWindowHeight() + margin` or on collision with hazard.
- Respawn at the last checkpoint (store x/y in scene variables when touching a checkpoint flag).
- Never just "restart the scene" silently: fade (opacity tween) then restart.

## Level flow
- Introduce one verb per screen: jump, then double jump/one-way platforms, then enemies, then combine.
- Place collectibles to teach the safe path; place hazards where the player already learned the move.
- Win condition: reach the flag/goal → show a win screen (scene or UI layer), then offer the next level.

## Verify
- Run a gameplay test: step frames, hold the jump key (`setKeyPressed("Space", true)`), assert the player gains height and lands; assert falling off the bottom respawns the player.
