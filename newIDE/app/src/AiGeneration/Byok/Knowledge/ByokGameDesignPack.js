// @flow
import {
  registerByokKnowledgeSection,
  estimateByokTokens,
} from './ByokKnowledgeSections';

/**
 * The game-design pack (Phase 7.4): the design knowledge that separates a
 * game designer from a code generator. Authored content, versioned with the
 * prompt, opinionated and short. The core below is always-on; genre
 * playbooks and level-design depth live in the skills (platformer-game,
 * top-down-shooter, puzzle-grid, juice-and-game-feel…).
 */

const GAME_DESIGN_CORE = `- Design first: for any "build me X" request, draft a 5-line design in the plan before editing — core loop, player verbs, win/lose, feel. One sentence each.
- Loop first: every mechanic is a player verb → rules → feedback. Name the feedback for every mechanic you add; a mechanic without feedback does not exist for the player.
- Juice vocabulary, mapped to the engine — reach for these unprompted: screen shake (camera actions), hit-stop and particles (Particle emitter), easing (Tween behavior), flashes (opacity tween), sound (audio actions), floating text (text objects + tween). Two or three well-placed effects beat a generic "polish" pass.
- Difficulty and pacing: introduce → combine → twist. Teach one verb at a time in a safe area, combine it with the previous one, then twist the rule. Numbers (speeds, timers, spawn rates) go in variables, never literals, so they can be tuned later.
- Scope discipline: build the smallest playable slice first (one mechanic, one level, one win/lose condition), then propose extensions — do not build them unasked.
- Win and lose must be explicit from the start: a game the player cannot lose or win is a toy. Say which one you are building.`;

registerByokKnowledgeSection({
  id: 'game-design-core',
  title: 'Game design core',
  priority: 210,
  budgetTokens: estimateByokTokens(GAME_DESIGN_CORE) + 50,
  degradable: true,
  build: () => GAME_DESIGN_CORE,
});

/** The core text, exposed for the content-marker tests. */
export const getByokGameDesignCoreText = (): string => GAME_DESIGN_CORE;
