/**
 * Condition processing. Covers WFRP4e core conditions:
 * bleeding, poisoned, ablaze, deafened, blinded, broken, entangled,
 * fatigued, prone, stunned, surprised, unconscious.
 *
 * Stacked conditions are reduced by 1 per round (stunned, blinded, deafened,
 * broken, fatigued) unless the character takes the relevant recovery action.
 * Persistent conditions (bleeding, ablaze, poisoned, prone, entangled) require
 * an active effort to remove and are not auto-ticked.
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
    // Auto-ticking conditions - reduce by 1 stack per round.
    for (const key of ["stunned", "surprised", "blinded", "deafened", "broken", "fatigued"]) {
      if (combatant.hasCondition(key)) combatant.removeCondition(key, 1);
    }
  }

  blocksAction(combatant) {
    if (!combatant.isActive()) return true;
    // Stunned: cannot take any action while this condition is present.
    if (combatant.hasCondition("stunned")) return true;
    // Unconscious condition stack.
    if (combatant.hasCondition("unconscious")) return true;
    return false;
  }
}
