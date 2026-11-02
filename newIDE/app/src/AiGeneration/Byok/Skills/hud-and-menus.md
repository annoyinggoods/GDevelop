---
name: hud-and-menus
description: Build HUDs, pause screens and main menus — UI layers, anchoring, binding text to variables, and scene-flow wiring.
---

# HUD and menus

## Layers are the separation of concerns
- Put all HUD/menu objects on a dedicated layer (usually "UI"): the camera never moves it, and it can have its own base size/ambient light.
- Menus that must pause the game: pause the scene (`Pause scene`) and open the menu scene on top, or stop player input while the menu layer is active.

## HUD that stays put
- Anchor HUD elements to the window edge (`Change position` from window corner expressions, or the **Anchor Point** behavior) so resizing the window keeps the layout.
- Bind displays to variables every frame (or when they change): `Set text of ScoreLabel := ToString(Score)`. Avoid string-building every frame for long texts — update only when the variable changed (`and once` + a "dirty" flag).

## Menus
- A main menu scene: title, Play, Options, Quit. Buttons = objects + `Cursor is on object` + `Mouse button pressed` (or touch), with hover feedback (tween scale/color).
- Pause menu: Resume, Restart, Main menu. Restart must reset the run's variables explicitly.
- Keyboard/gamepad navigation: track a selected index variable, move with Up/Down `and once`, confirm with the action key.

## Feels-finished checklist
- Transitions: fade in/out (tween a fullscreen black rectangle's opacity) between scenes.
- The HUD never overlaps critical gameplay (check the safe area on small windows).
- Menus are navigable with the keyboard alone.

## Verify
- Gameplay test: assert the score label text changes after the score variable changes; assert pausing stops movement (step frames, assert position unchanged).
