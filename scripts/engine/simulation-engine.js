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
      // Successful damage spell always does at least 1 wound - TB + AP
      // can't fully negate a spell that landed and carried damage.
      const wounds = Math.max(1, totalDamage - ap - tb);

      this.stats.recordAttack(caster, target);
      target.takeWounds(wounds);
      this.stats.recordDamage(caster, target, wounds);
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
   * Probabilistic sampling (v0.1.11 crits, v0.1.12 wounds): each click
   * produces two fresh rolls per combatant entry:
   *
   *  1. Wound sample: one of the per-iteration wound totals drawn uniformly
   *     at random (every iteration's wound-sum is equally likely).
   *  2. Crit sample: one bucket from the observed crit distribution plus
   *     a "No crit" bucket weighted by zero-crit iterations.
   *
   * Each combatant entry (not each actor) gets its own preview row. If the
   * same source actor appears multiple times in the sim (duplicate entries),
   * each one rolls independently and Apply writes them in sequence to the
   * same sheet.
   *
   * Returns an array of {
   *   entryId, actorId, actorName, displayName,
   *   rolledWounds, currentWounds, newWounds,
   *   woundDistribution: [{ label, value, count, percent, isRolled }],
   *   woundOtherCount, woundTotalSamples,
   *   avgCrits,
   *   critDistribution: [{ label, count, percent, crit, isRolled, isNoCrit, isApplicable }],
   *   rolledCrit, rolledBucketIndex, totalWeight, rollValue
   * }
   */
  buildApplyPreview(results) {
    const entries = this._aggregateByEntry(results);
    const preview = [];

    // Track the wound-running-total per actor so multiple entries that
    // share an actor compute sequential newWounds values in the preview
    // (matching what will actually happen at Apply time). Without this,
    // four goblin rows would all show "currentWounds -> currentWounds - X"
    // but the actual apply would stack, confusing the user.
    const projectedWoundsByActor = {};

    for (const entry of entries) {
      const actor = game.actors.get(entry.actorId);
      if (!actor) continue;

      const woundSample = this._sampleWoundDistribution(entry.woundSamples);
      const critSample = this._sampleCritDistribution(entry);

      const baseWounds = projectedWoundsByActor[entry.actorId]
        ?? actor.system?.status?.wounds?.value
        ?? 0;
      const newWounds = Math.max(0, baseWounds - woundSample.rolledValue);
      projectedWoundsByActor[entry.actorId] = newWounds;

      preview.push({
        entryId: entry.entryId,
        actorId: entry.actorId,
        actorName: actor.name,
        displayName: entry.displayName,
        rolledWounds: woundSample.rolledValue,
        currentWounds: baseWounds,
        newWounds,
        woundDistribution: woundSample.distribution,
        woundOtherCount: woundSample.otherCount,
        woundTotalSamples: woundSample.totalSamples,
        avgCrits: entry.avgCrits,
        critDistribution: critSample.distribution,
        rolledCrit: critSample.rolledCrit,
        rolledBucketIndex: critSample.rolledBucketIndex,
        totalWeight: critSample.totalWeight,
        rollValue: critSample.rollValue
      });
    }

    return preview;
  }

  /**
   * Apply probabilistically-sampled wounds and crits back to real actors.
   * Both rolls (wounds and crit) are pre-computed by buildApplyPreview -
   * pass that preview in so on-screen values and applied values agree.
   *
   *  - Subtracts the rolled wound sample from each actor's current Wounds.
   *  - If the pre-rolled crit bucket carries a source item, attaches it
   *    to the actor as an embedded Item (wfrp4e handles Active Effects
   *    via its own item transfer flow).
   *
   * Multiple entries sharing the same actor apply sequentially: each row
   * re-reads current Wounds from the sheet, subtracts its rolled sample,
   * writes. This means row N sees the effect of rows 0..N-1. Intentional.
   *
   * @param {object} results - the aggregated sim results
   * @param {Array}  preview - the array returned by buildApplyPreview;
   *                           must be the exact object shown to the user
   */
  async applyAverageResultsToActors(results, preview) {
    let woundAppliedCount = 0;
    let critAppliedCount = 0;

    for (const row of preview) {
      const actor = game.actors.get(row.actorId);
      if (!actor) continue;

      // Wounds. Re-read current Wounds from the actor so sequential
      // same-actor rows stack correctly. rolledWounds can legitimately be
      // 0, in which case we skip the update entirely.
      if (row.rolledWounds > 0) {
        const currentWounds = actor.system?.status?.wounds?.value ?? 0;
        const newWounds = Math.max(0, currentWounds - row.rolledWounds);
        await actor.update({ "system.status.wounds.value": newWounds });
        woundAppliedCount++;
      }

      // Pre-rolled crit (if the "No crit" bucket won, rolledCrit is null;
      // if the rolled bucket has no source uuid, we can't attach and skip).
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
        actors: woundAppliedCount,
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
   * Draw one per-iteration wound sample at random from the observed
   * distribution. Each iteration is weighted equally (every sample has
   * 1/N chance, where N = iterations). The returned distribution groups
   * identical wound totals into buckets so the UI can render them as bars
   * the same way crits are rendered - sorted by frequency desc, capped at
   * a readable number of rows so heavy-spread distributions don't explode
   * the dialog height.
   *
   * Returns:
   *   distribution: [{ label, value, count, percent, isRolled }]
   *   otherCount:   number of samples collapsed into "... N other values"
   *                 when the distinct-value count exceeds the display cap
   *   rolledValue:  the actual wound number to apply (0 is valid)
   *   rollIndex:    which iteration's sample was drawn (for debugging)
   *   totalSamples: count of source samples
   */
  _sampleWoundDistribution(samples, displayCap = 10) {
    if (!samples?.length) {
      return {
        distribution: [],
        otherCount: 0,
        rolledValue: 0,
        rollIndex: -1,
        totalSamples: 0
      };
    }

    // Bucket identical sample values.
    const valueCounts = new Map();
    for (const v of samples) {
      valueCounts.set(v, (valueCounts.get(v) ?? 0) + 1);
    }

    // Draw one iteration uniformly at random.
    const rollIndex = Math.floor(Math.random() * samples.length);
    const rolledValue = samples[rollIndex];

    // Sort buckets: frequency desc, then value desc (big hits rise on ties).
    const allBuckets = [...valueCounts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return b.value - a.value;
      });

    // Ensure the rolled bucket is always visible. If it would be truncated,
    // bump displayCap by 1 to make room for it. Rare but important for
    // UX - the user must see the rolled bar highlighted.
    let effectiveCap = displayCap;
    const rolledIdx = allBuckets.findIndex(b => b.value === rolledValue);
    if (rolledIdx >= effectiveCap) effectiveCap = rolledIdx + 1;

    const shown = allBuckets.slice(0, effectiveCap);
    const hidden = allBuckets.slice(effectiveCap);
    const otherCount = hidden.reduce((s, b) => s + b.count, 0);

    const totalSamples = samples.length;
    const distribution = shown.map(b => ({
      value: b.value,
      label: `${b.value} ${b.value === 1 ? "wound" : "wounds"}`,
      count: b.count,
      percent: (b.count / totalSamples) * 100,
      isRolled: b.value === rolledValue
    }));

    return {
      distribution,
      otherCount,
      rolledValue,
      rollIndex,
      totalSamples
    };
  }

 If the
   * same source actor appears as multiple entries on the sides (e.g. four
   * goblins all instantiated from one Goblin actor), each entry becomes
   * its own preview row. All rows that share an actor will Apply to the
   * same underlying actor sheet in sequence at confirm time, so a single
   * source actor can legitimately accrue multiple wound writes and multiple
   * embedded crit items from one Apply click.
   *
   * Also assigns disambiguating display names when duplicates exist
   * ("Goblin", "Goblin (2)", "Goblin (3)"...) so the preview rows are
   * visually distinct.
   *
   * Returns an array of {
   *   entryId,                 // stable sim-only id for the entry
   *   actorId,                 // underlying real-actor id (may repeat)
   *   displayName,             // disambiguated for UI
   *   woundSamples: number[],  // one sample per iteration
   *   critBuckets: Map,        // crit-name -> {count, uuid, ...}
   *   zeroCritIterations: int, // iterations this entry received zero crits
   *   avgCrits: number         // informational, for the header meta line
   * }
   */
  _aggregateByEntry(results) {
    const entries = [];

    // First pass: count entries per actor so we can disambiguate names.
    const actorEntryCount = {};
    const actorEntrySeen = {};
    for (const stats of Object.values(results.perCombatant)) {
      actorEntryCount[stats.actorId] = (actorEntryCount[stats.actorId] ?? 0) + 1;
    }

    for (const stats of Object.values(results.perCombatant)) {
      actorEntrySeen[stats.actorId] = (actorEntrySeen[stats.actorId] ?? 0) + 1;
      const ordinal = actorEntrySeen[stats.actorId];
      const total = actorEntryCount[stats.actorId];
      const displayName = total > 1 ? `${stats.name} (${ordinal})` : stats.name;

      const critBuckets = new Map();
      for (const c of stats.critsReceivedDetailed ?? []) {
        const key = c.name || `${c.location}:${c.result}`;
        critBuckets.set(key, { ...c });
      }

      entries.push({
        entryId: stats.entryId,
        actorId: stats.actorId,
        displayName,
        woundSamples: stats.woundsReceivedSamples ?? [],
        critBuckets,
        zeroCritIterations: stats.iterationsWithZeroCritsReceived ?? 0,
        avgCrits: stats.criticalsReceived?.mean ?? 0
      });
    }

    return entries;
  }
}
