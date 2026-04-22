/**
 * Simulation Engine
 *
 * Runs N independent combat iterations between two or more sides.
 * Each iteration clones combatant state, executes rounds until a victory
 * condition is met, and records per-combatant statistics.
 *
 * Design notes:
 * - Actor data is deep-cloned per iteration; real actor documents are never mutated.
 * - Rolls use the wfrp4e system's dice.js where practical, but we bypass chat
 *   output by calling the low-level roll functions and evaluating Roll instances
 *   directly. For 1000+ iterations, posting chat messages would destroy Foundry.
 * - The AI module decides each combatant's action per round (best weapon, best
 *   spell, optimal range).
 */

import { CombatantAI } from "./combatant-ai.js";
import { StatsTracker } from "./stats-tracker.js";
import { Combatant } from "./combatant.js";
import { ConditionManager } from "./condition-manager.js";
import { resolveOpposedTest, resolveDamage, rollCriticalWound } from "./rules.js";

export class SimulationEngine {
  constructor({ sides, config }) {
    this.sides = sides;
    this.config = config;
    this.iterations = config.iterations;
    this.maxRounds = config.maxRounds;
    this.victoryCondition = config.victoryCondition;
    this.startingRange = config.startingRange;
    this.stats = new StatsTracker(sides);
  }

  /**
   * Run all iterations.
   * @param {(progress:number)=>void} onProgress
   * @returns {Promise<object>} Aggregated results.
   */
  async run(onProgress) {
    // Yield periodically so Foundry UI stays responsive.
    const batchSize = Math.max(1, Math.floor(this.iterations / 100));

    for (let i = 0; i < this.iterations; i++) {
      const outcome = await this._runOneCombat(i);
      this.stats.recordIteration(outcome);

      if (i % batchSize === 0) {
        onProgress?.(i / this.iterations);
        await new Promise(r => setTimeout(r, 0)); // yield to UI
      }
    }

    onProgress?.(1);
    return this.stats.summarize(this.iterations);
  }

  async _runOneCombat(iterationIndex) {
    // Clone combatants.
    const combatants = [];
    for (const side of this.sides) {
      for (const entry of side.combatants) {
        const actor = game.actors.get(entry.actorId);
        if (!actor) continue;
        combatants.push(new Combatant({
          entryId: entry.id,
          sideId: side.id,
          sideName: side.name,
          actor,
          startingRange: this.startingRange
        }));
      }
    }

    if (combatants.length < 2) {
      return { rounds: 0, winner: null, combatants: [] };
    }

    const conditionManager = new ConditionManager();
    const ai = new CombatantAI();

    let round = 0;
    let winner = null;

    while (round < this.maxRounds) {
      round++;

      // Initiative order (Initiative + agility bonus; tie-break on SB).
      const order = this._rollInitiativeOrder(combatants);

      for (const combatant of order) {
        if (!combatant.isActive()) continue;

        // Start-of-turn conditions (bleeding, poisoned, etc.)
        conditionManager.onTurnStart(combatant);
        if (!combatant.isActive()) continue;

        // Skip-turn conditions (stunned, prone-no-action).
        if (conditionManager.blocksAction(combatant)) continue;

        // Choose + execute action.
        const enemies = combatants.filter(c => c.sideId !== combatant.sideId && c.isActive());
        if (enemies.length === 0) break;

        const action = ai.chooseAction(combatant, enemies, combatants);
        if (action) {
          await this._executeAction(combatant, action, combatants);
        }
      }

      // End of round: tick bleeding/regeneration/etc.
      for (const c of combatants) {
        if (c.isActive()) conditionManager.onRoundEnd(c);
      }

      // Victory check.
      winner = this._checkVictory(combatants, round);
      if (winner) break;
    }

    if (!winner) winner = this._resolveTimeoutWinner(combatants);

    return {
      rounds: round,
      winner,
      combatants: combatants.map(c => c.snapshotStats())
    };
  }

  _rollInitiativeOrder(combatants) {
    return [...combatants]
      .filter(c => c.isActive())
      .map(c => {
        const init = c.characteristic("i");
        const agility = c.characteristic("ag");
        const roll = Math.floor(Math.random() * 10) + 1 + init + Math.floor(agility / 10);
        return { c, roll };
      })
      .sort((a, b) => b.roll - a.roll)
      .map(x => x.c);
  }

  async _executeAction(actor, action, allCombatants) {
    switch (action.type) {
      case "melee":
      case "ranged":
        await this._resolveAttack(actor, action, allCombatants);
        break;
      case "cast":
        await this._resolveSpell(actor, action, allCombatants);
        break;
      case "move":
        // range adjustment only
        if (action.target && action.newRange) {
          actor.setRangeTo(action.target, action.newRange);
        }
        break;
      case "defend":
        actor.setDefending(true);
        break;
      case "dodge":
        actor.setDodging(true);
        break;
      default:
        break;
    }
  }

  async _resolveAttack(attacker, action, allCombatants) {
    const target = action.target;
    const weapon = action.weapon;

    const opposed = resolveOpposedTest({
      attacker,
      defender: target,
      weapon,
      actionType: action.type
    });

    this.stats.recordAttack(attacker, target);

    if (opposed.attackerWins && opposed.damageDealt > 0) {
      const damageResult = resolveDamage({
        attacker,
        defender: target,
        weapon,
        sl: opposed.winnerSL,
        hitLocation: opposed.hitLocation
      });

      target.takeWounds(damageResult.woundsDealt);
      this.stats.recordDamage(attacker, target, damageResult.woundsDealt);

      // Critical wound?
      if (damageResult.triggeredCritical) {
        const critRoll = rollCriticalWound(damageResult.hitLocation);
        target.addCriticalWound(critRoll);
        this.stats.recordCritical(attacker, target, critRoll.result);

        // Fate burn to survive death-triggering crits.
        if (target.isDead() && target.hasFate()) {
          target.spendFate();
          target.revive(1);
        }
      }

      // Advantage gain.
      attacker.addAdvantage(1);
      target.setAdvantage(0);
    } else if (!opposed.attackerWins) {
      target.addAdvantage(1);
      attacker.setAdvantage(0);
    }
  }

  async _resolveSpell(caster, action, allCombatants) {
    const spell = action.spell;
    const target = action.target;

    // Channel or cast?
    const cn = spell.system?.cn?.value ?? 0;
    const language = caster.getSkill("Language (Magick)");
    const testTarget = (caster.characteristic("wp") ?? 30) + (language?.advances ?? 0) * 5;

    const roll = Math.floor(Math.random() * 100) + 1;
    const sl = this._calcSL(roll, testTarget);
    const success = sl >= 0 && sl >= cn;

    if (!success) {
      // Miscast check on doubles.
      if (this._isDouble(roll)) {
        this.stats.recordMiscast(caster);
      }
      caster.setAdvantage(0);
      return;
    }

    // Damage spell?
    const damage = spell.system?.damage?.value ?? 0;
    if (damage > 0 && target) {
      const totalDamage = damage + sl;
      const ap = target.getArmourAt("body");
      const tb = target.characteristic("tb");
      const wounds = Math.max(0, totalDamage - ap - tb);

      this.stats.recordAttack(caster, target);
      if (wounds > 0) {
        target.takeWounds(wounds);
        this.stats.recordDamage(caster, target, wounds);
      }
    }
    caster.addAdvantage(1);
  }

  _calcSL(roll, target) {
    const rollTens = Math.floor(roll / 10);
    const targetTens = Math.floor(target / 10);
    if (roll === 1) return targetTens; // auto success
    if (roll >= 96) return -targetTens - 1; // auto fumble
    return targetTens - rollTens;
  }

  _isDouble(n) {
    if (n < 10) return n === 0;
    const s = String(n);
    return s[0] === s[1] || (s.length === 3 && s === "100");
  }

  _checkVictory(combatants, roundsElapsed) {
    const sides = {};
    for (const c of combatants) {
      sides[c.sideId] ??= { id: c.sideId, name: c.sideName, active: 0 };
      if (c.isActive()) sides[c.sideId].active++;
    }
    const activeSides = Object.values(sides).filter(s => s.active > 0);

    switch (this.victoryCondition) {
      case "lastStanding":
      case "incapacitation":
        if (activeSides.length <= 1) {
          return activeSides[0]?.id ?? "draw";
        }
        break;
      case "rout":
        for (const side of Object.values(sides)) {
          const total = combatants.filter(c => c.sideId === side.id).length;
          const ratio = side.active / total;
          if (ratio < 0.5 && total > 1) {
            // route side (simplified rout trigger)
            const survivors = activeSides.filter(s => s.id !== side.id);
            if (survivors.length === 1) return survivors[0].id;
          }
        }
        break;
      case "fixedRounds":
        if (roundsElapsed >= this.maxRounds) {
          return this._resolveTimeoutWinner(combatants);
        }
        break;
    }
    return null;
  }

  _resolveTimeoutWinner(combatants) {
    // Highest aggregate remaining wounds wins.
    const totals = {};
    for (const c of combatants) {
      totals[c.sideId] ??= { id: c.sideId, wounds: 0 };
      totals[c.sideId].wounds += Math.max(0, c.currentWounds());
    }
    const sorted = Object.values(totals).sort((a, b) => b.wounds - a.wounds);
    if (sorted.length === 0) return "draw";
    if (sorted[0].wounds === sorted[1]?.wounds) return "draw";
    return sorted[0].id;
  }

  /**
   * Apply averaged damage back to real actors.
   * Called only when the GM opts in. If multiple combatant entries reference the
   * same underlying actor (e.g., a horde), their average damage is summed —
   * which matches what the actor would experience collectively as "one actor".
   * In practice this is rare for PCs; for NPC hordes the GM typically wants the
   * worst-case aggregate.
   */
  async applyAverageResultsToActors(results) {
    // Sum average damage per actor id.
    const byActor = {};
    for (const stats of Object.values(results.perCombatant)) {
      byActor[stats.actorId] ??= { wounds: 0, crits: 0 };
      byActor[stats.actorId].wounds += stats.woundsReceived.mean;
      byActor[stats.actorId].crits += stats.criticalsReceived.mean;
    }

    for (const [actorId, agg] of Object.entries(byActor)) {
      const actor = game.actors.get(actorId);
      if (!actor) continue;

      const avgWoundsReceived = Math.round(agg.wounds);
      const currentWounds = actor.system.status.wounds.value;
      const newWounds = Math.max(0, currentWounds - avgWoundsReceived);

      await actor.update({ "system.status.wounds.value": newWounds });

      // Apply average critical wounds (rounded down).
      const avgCrits = Math.floor(agg.crits);
      for (let i = 0; i < avgCrits; i++) {
        try {
          await actor.addCondition?.("bleeding", 1);
        } catch (err) {
          // no-op
        }
      }
    }
    ui.notifications.info(game.i18n.localize("WFRP4E_SIM.AppliedResults"));
  }
}
