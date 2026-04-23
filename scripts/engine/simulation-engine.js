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
import { applyCritEffectsToCombatant } from "./effect-applier.js";

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
    // Yield to the UI periodically so Foundry stays responsive. For small
    // iteration counts, yield rarely; for large ones, yield ~100 times total.
    const yieldInterval = Math.max(5, Math.floor(this.iterations / 100));

    for (let i = 0; i < this.iterations; i++) {
      const outcome = await this._runOneCombat(i);
      this.stats.recordIteration(outcome);

      if (i % yieldInterval === 0) {
        onProgress?.(i / this.iterations);
        await new Promise(r => setTimeout(r, 0));
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
        const critRoll = await rollCriticalWound(damageResult.hitLocation);
        target.addCriticalWound(critRoll);
        this.stats.recordCritical(attacker, target, critRoll);

        // Apply extra wounds from the crit table entry (some entries deal
        // additional damage beyond the initial hit).
        if (critRoll.extraWounds > 0) {
          target.takeWounds(critRoll.extraWounds);
          this.stats.recordDamage(attacker, target, critRoll.extraWounds);
        }

        // Apply crippling effect conditions (bleeding, stunned, prone, etc.)
        for (const { key, stacks } of (critRoll.conditions ?? [])) {
          if (key === "unconscious") {
            target.state.unconscious = true;
          } else {
            target.addCondition(key, stacks);
          }
        }

        // Apply durational Active Effects + narrative text penalties
        // (e.g. -10 WS until healed) so subsequent rounds in this iteration
        // see the degraded combatant.
        if (critRoll.item) {
          try {
            applyCritEffectsToCombatant(target, attacker, critRoll.item, critRoll.description);
          } catch (err) {
            console.warn("WFRP4e Combat Simulator | effect applier failed", err);
          }
        }

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
   * Build a preview of what applyAverageResultsToActors would apply.
   * Safe to call without mutating anything - used by the results UI to show
   * a dry-run dialog before committing.
   *
   * Probabilistic crit sampling (v0.1.11): each click produces a fresh roll
   * across the observed crit distribution plus a "No crit" bucket whose
   * weight equals the number of iterations in which the combatant received
   * zero crits. The rolled bucket is what will actually be applied if the
   * user confirms - preview and apply share the same roll.
   *
   * Returns an array of {
   *   actorId, actorName, avgWounds, currentWounds, newWounds, avgCrits,
   *   critDistribution: [{ label, count, percent, crit, isRolled, isNoCrit }, ...],
   *   rolledCrit: {name, uuid, ...} | null,    // the crit to apply, or null
   *   rolledBucketIndex, totalWeight
   * }
   */
  buildApplyPreview(results) {
    const byActor = this._aggregateByActor(results);
    const preview = [];
    for (const [actorId, agg] of Object.entries(byActor)) {
      const actor = game.actors.get(actorId);
      if (!actor) continue;
      const avgWounds = Math.round(agg.wounds);
      const currentWounds = actor.system?.status?.wounds?.value ?? 0;
      const newWounds = Math.max(0, currentWounds - avgWounds);

      // Build and sample the bucket distribution.
      const sample = this._sampleCritDistribution(agg);

      preview.push({
        actorId,
        actorName: actor.name,
        avgWounds,
        currentWounds,
        newWounds,
        avgCrits: agg.avgCrits,
        critDistribution: sample.distribution,
        rolledCrit: sample.rolledCrit,
        rolledBucketIndex: sample.rolledBucketIndex,
        totalWeight: sample.totalWeight,
        rollValue: sample.rollValue
      });
    }
    return preview;
  }

  /**
   * Apply averaged wounds plus a probabilistically-sampled crit back to real
   * actors. The crit to apply (or none) must already have been rolled by
   * buildApplyPreview - pass that preview in so preview and apply agree.
   *
   *  - Subtracts rounded average Wounds from each actor's current Wounds.
   *  - If the pre-rolled bucket for that actor carries a crit, attaches it
   *    to the actor as an embedded Item (so Active Effects transfer via
   *    wfrp4e's normal item flow).
   *
   * If multiple combatant entries reference the same underlying actor
   * (e.g. a horde of clones), their wounds are summed and a single unified
   * crit distribution is sampled across all of them.
   *
   * @param {object} results - the aggregated sim results
   * @param {Array}  preview - the array returned by buildApplyPreview;
   *                           must be the exact object shown to the user
   */
  async applyAverageResultsToActors(results, preview) {
    let appliedCount = 0;
    let critAppliedCount = 0;

    for (const row of preview) {
      const actor = game.actors.get(row.actorId);
      if (!actor) continue;

      // Wounds.
      if (row.avgWounds > 0) {
        // Re-read current Wounds in case the sheet changed since preview
        // was built, but honor the preview's avgWounds value so the user
        // sees consistent numbers.
        const currentWounds = actor.system?.status?.wounds?.value ?? 0;
        const newWounds = Math.max(0, currentWounds - row.avgWounds);
        await actor.update({ "system.status.wounds.value": newWounds });
        appliedCount++;
      }

      // Pre-rolled crit (if the "No crit" bucket lost the roll, rolledCrit is null).
      if (row.rolledCrit?.uuid) {
        try {
          const sourceItem = await fromUuid(row.rolledCrit.uuid);
          if (sourceItem) {
            const itemData = sourceItem.toObject();
            await actor.createEmbeddedDocuments("Item", [itemData]);
            critAppliedCount++;
          }
        } catch (err) {
          console.warn(`WFRP4e Combat Simulator | failed to apply crit to ${actor.name}`, err);
        }
      }
    }

    ui.notifications.info(
      game.i18n.format("WFRP4E_SIM.AppliedResultsDetail", {
        actors: appliedCount,
        crits: critAppliedCount
      })
    );
  }

  /**
   * Given an aggregate (wounds + crit buckets + zero-crit iteration count),
   * build the full bucket list and draw one unified sample. The weights are
   * the raw observed counts from the sim (pure frequency weighting, no
   * severity boost). The "No crit" bucket is just another bucket with
   * weight = iterations-where-this-actor-received-zero-crits.
   *
   * Returns:
   *   distribution: [{ label, count, percent (0..100), crit, isRolled, isNoCrit }]
   *   rolledBucketIndex: int
   *   rolledCrit: the crit object for the rolled bucket, or null if "No crit"
   *   rollValue: the random draw (for debugging / replay)
   *   totalWeight: sum of all bucket weights
   */
  _sampleCritDistribution(agg) {
    const critBuckets = [...agg.critBuckets.values()]
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return (b.result ?? 0) - (a.result ?? 0);
      });

    const buckets = critBuckets.map(c => ({
      label: c.name || `${c.location} ${c.result}`,
      count: c.count,
      crit: c,
      isNoCrit: false
    }));

    // Append the "No crit" bucket - summed zero-crit iterations across every
    // combatant entry that maps to this actor (handles duplicate entries).
    const noCritWeight = agg.zeroCritIterations ?? 0;
    buckets.push({
      label: "No crit",
      count: noCritWeight,
      crit: null,
      isNoCrit: true
    });

    const totalWeight = buckets.reduce((s, b) => s + b.count, 0);

    // Degenerate case: zero total weight (no iterations or no data).
    // Force the "No crit" bucket as the rolled outcome so nothing gets applied.
    if (totalWeight <= 0) {
      const distribution = buckets.map((b, i) => ({
        label: b.label,
        count: b.count,
        percent: 0,
        crit: b.crit,
        isRolled: b.isNoCrit,
        isNoCrit: b.isNoCrit,
        // "No crit" is always applicable (it's a no-op by design); crit
        // buckets are applicable only if we have a source UUID to clone.
        isApplicable: b.isNoCrit || !!b.crit?.uuid
      }));
      return {
        distribution,
        rolledBucketIndex: buckets.length - 1,
        rolledCrit: null,
        rollValue: 0,
        totalWeight: 0
      };
    }

    // Unified roll across all buckets (Strategy A).
    const rollValue = Math.random() * totalWeight;
    let cumulative = 0;
    let rolledIndex = buckets.length - 1; // fallback
    for (let i = 0; i < buckets.length; i++) {
      cumulative += buckets[i].count;
      if (rollValue < cumulative) {
        rolledIndex = i;
        break;
      }
    }

    const distribution = buckets.map((b, i) => ({
      label: b.label,
      count: b.count,
      percent: (b.count / totalWeight) * 100,
      crit: b.crit,
      isRolled: i === rolledIndex,
      isNoCrit: b.isNoCrit,
      // Crit buckets without a source UUID can't be attached to the actor
      // (this happens when the async fallback path in rules.js produced the
      // crit without a table item reference). The bucket still counts for
      // sampling, but the UI should warn and the apply step should no-op.
      isApplicable: b.isNoCrit || !!b.crit?.uuid
    }));

    return {
      distribution,
      rolledBucketIndex: rolledIndex,
      rolledCrit: buckets[rolledIndex].crit,
      rollValue,
      totalWeight
    };
  }

  /**
   * Aggregate per-actor totals across all combatant entries that reference
   * the same actor. For duplicate entries (hordes), wounds are summed, crit
   * counts are summed across buckets keyed by name (or location:result), and
   * the zero-crit-iteration counts are summed as well.
   *
   * Returns: {
   *   [actorId]: {
   *     wounds:              summed mean wounds received,
   *     avgCrits:            summed mean crits received per iteration
   *                          (informational only; sampling uses raw counts),
   *     critBuckets:         Map<key, { count, name, location, result, uuid, ... }>,
   *     zeroCritIterations:  total count of iterations (across all entries)
   *                          in which this actor's entry received zero crits
   *   }
   * }
   */
  _aggregateByActor(results) {
    const byActor = {};
    for (const stats of Object.values(results.perCombatant)) {
      const bucket = byActor[stats.actorId] ??= {
        wounds: 0,
        avgCrits: 0,
        critBuckets: new Map(), // key -> {count, name, location, uuid, ...}
        zeroCritIterations: 0
      };
      bucket.wounds += stats.woundsReceived?.mean ?? 0;
      bucket.avgCrits += stats.criticalsReceived?.mean ?? 0;
      bucket.zeroCritIterations += stats.iterationsWithZeroCritsReceived ?? 0;

      for (const c of stats.critsReceivedDetailed ?? []) {
        // critsReceivedDetailed is pre-bucketed by location:result in the
        // stats tracker; key by name when present (crit names are unique
        // per entry in wfrp4e), falling back to location:result.
        const key = c.name || `${c.location}:${c.result}`;
        const existing = bucket.critBuckets.get(key);
        if (existing) existing.count += c.count;
        else bucket.critBuckets.set(key, { ...c });
      }
    }

    return byActor;
  }
}
