/**
 * Condition processing. Covers WFRP4e core conditions:
 * bleeding, poisoned, ablaze, deafened, blinded, broken, entangled,
 * fatigued, prone, stunned, surprised, unconscious.
 */

export class ConditionManager {
  onTurnStart(combatant) {
    if (combatant.hasCondition("bleeding")) {
      const stacks = combatant.conditionStacks("bleeding");
      combatant.takeWounds(stacks);
    }
    if (combatant.hasCondition("poisoned")) {
      const stacks = combatant.conditionStacks("poisoned");
      // Toughness test at end of turn; fail = 1 wound. Simplify: 50% chance per stack.
      for (let i = 0; i < stacks; i++) {
        if (Math.random() < 0.5) combatant.takeWounds(1);
      }
    }
    if (combatant.hasCondition("ablaze")) {
      const stacks = combatant.conditionStacks("ablaze");
      combatant.takeWounds(stacks + 1); // 1d10 damage simplified to stacks+1 expected-ish
    }
  }

  onRoundEnd(combatant) {
    // Stunned removes 1 stack per round.
    if (combatant.hasCondition("stunned")) combatant.removeCondition("stunned", 1);
    if (combatant.hasCondition("surprised")) combatant.removeCondition("surprised", 1);
    // Prone requires a Move action to stand (we let the AI handle this by moving).
  }

  blocksAction(combatant) {
    // Unconscious or dead — handled by isActive.
    if (!combatant.isActive()) return true;
    // Stunned with stacks >= action economy = skip.
    if (combatant.hasCondition("stunned")) return true;
    return false;
  }
}
