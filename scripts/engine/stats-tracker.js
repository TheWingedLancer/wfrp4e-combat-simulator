/**
 * StatsTracker
 *
 * Accumulates per-iteration combat outcomes and produces the aggregate
 * summary: per-participant means, min/max/median/stddev, and side win rates.
 */

export class StatsTracker {
  constructor(sides) {
    this.sides = sides;

    // For every individual combatant entry (by entry.id — stable across iterations),
    // a raw-samples array of per-iteration tallies.
    this.perCombatant = {};
    for (const side of sides) {
      for (const entry of side.combatants) {
        this.perCombatant[entry.id] = {
          entryId: entry.id,
          actorId: entry.actorId,
          name: entry.name,
          sideId: side.id,
          sideName: side.name,
          woundsInflicted: [],
          woundsReceived: [],
          criticalsInflicted: [],
          criticalsReceived: [],
          criticalRolls: [],   // all crit d100 results this combatant inflicted
          critRollsReceived: [],
          critDetailsReceived: [], // full crit objects received
          miscasts: [],
          killsInflicted: [],
          diedInIter: []
        };
      }
    }

    // Side win counters.
    this.sideWins = {};
    this.draws = 0;

    // Combat length samples.
    this.roundsPerCombat = [];

    // Temporary per-iteration accumulator reset on each iteration.
    this._currentIterAcc = null;
  }

  recordIteration(outcome) {
    // The engine has already called recordAttack/Damage/Critical/Miscast during
    // the iteration, populating _currentIterAcc. Just flush it to permanent
    // records and reset for the next iteration.
    this._flushCurrentIteration(outcome);
  }

  // Called by the engine during an iteration:
  recordAttack(attacker, defender) {
    this._ensureAcc();
    // Nothing stored per-attack unless we care about attack count later.
  }

  recordDamage(attacker, defender, wounds) {
    this._ensureAcc();
    this._bumpAcc(attacker.id, "woundsInflicted", wounds);
    this._bumpAcc(defender.id, "woundsReceived", wounds);
  }

  recordCritical(attacker, defender, critRoll) {
    this._ensureAcc();
    // critRoll can be either a bare number (legacy) or a full crit object.
    const rollNum = typeof critRoll === "number" ? critRoll : critRoll?.result ?? 0;
    const critObj = typeof critRoll === "number"
      ? { result: critRoll, location: "body", name: "", description: "", conditions: [] }
      : critRoll;

    this._bumpAcc(attacker.id, "criticalsInflicted", 1);
    this._bumpAcc(defender.id, "criticalsReceived", 1);
    this._pushAcc(attacker.id, "criticalRolls", rollNum);
    this._pushAcc(defender.id, "critRollsReceived", rollNum);
    this._pushAcc(defender.id, "critDetailsReceived", critObj);
  }

  recordMiscast(caster) {
    this._ensureAcc();
    this._bumpAcc(caster.id, "miscasts", 1);
  }

  _ensureAcc() {
    if (!this._currentIterAcc) this._startIterAccumulator();
  }

  _startIterAccumulator() {
    this._currentIterAcc = {};
    for (const id of Object.keys(this.perCombatant)) {
      this._currentIterAcc[id] = {
        woundsInflicted: 0,
        woundsReceived: 0,
        criticalsInflicted: 0,
        criticalsReceived: 0,
        criticalRolls: [],
        critRollsReceived: [],
        critDetailsReceived: [],
        miscasts: 0
      };
    }
    return this._currentIterAcc;
  }

  _bumpAcc(id, key, amount) {
    if (!this._currentIterAcc || !this._currentIterAcc[id]) return;
    this._currentIterAcc[id][key] += amount;
  }

  _pushAcc(id, key, value) {
    if (!this._currentIterAcc || !this._currentIterAcc[id]) return;
    this._currentIterAcc[id][key].push(value);
  }

  _flushCurrentIteration(outcome) {
    const acc = this._currentIterAcc ?? this._startIterAccumulator();

    for (const [id, tally] of Object.entries(acc)) {
      const rec = this.perCombatant[id];
      rec.woundsInflicted.push(tally.woundsInflicted);
      rec.woundsReceived.push(tally.woundsReceived);
      rec.criticalsInflicted.push(tally.criticalsInflicted);
      rec.criticalsReceived.push(tally.criticalsReceived);
      rec.criticalRolls.push(...tally.criticalRolls);
      rec.critRollsReceived.push(...tally.critRollsReceived);
      rec.critDetailsReceived.push(...tally.critDetailsReceived);
      rec.miscasts.push(tally.miscasts);

      // Did this combatant die this iteration? Check snapshot by combatant id.
      const snap = outcome.combatants.find(c => c.id === id);
      rec.diedInIter.push(snap && !snap.alive ? 1 : 0);
    }

    this.roundsPerCombat.push(outcome.rounds);

    if (outcome.winner && outcome.winner !== "draw") {
      this.sideWins[outcome.winner] = (this.sideWins[outcome.winner] ?? 0) + 1;
    } else {
      this.draws++;
    }

    this._currentIterAcc = null;
  }

  summarize(totalIterations) {
    const perCombatant = {};
    for (const [id, rec] of Object.entries(this.perCombatant)) {
      perCombatant[id] = {
        entryId: id,
        actorId: rec.actorId,
        name: rec.name,
        sideId: rec.sideId,
        sideName: rec.sideName,
        woundsInflicted: distStats(rec.woundsInflicted),
        woundsReceived: distStats(rec.woundsReceived),
        criticalsInflicted: distStats(rec.criticalsInflicted),
        criticalsReceived: distStats(rec.criticalsReceived),
        avgCriticalRollInflicted: mean(rec.criticalRolls),
        avgCriticalRollReceived: mean(rec.critRollsReceived),
        critsReceivedDetailed: summarizeCritsReceived(rec.critDetailsReceived),
        miscasts: distStats(rec.miscasts),
        deathRate: mean(rec.diedInIter)
      };
    }

    // Per-side win rates and predicted winner.
    const sideStats = {};
    let winner = null;
    let winnerRate = 0;
    for (const side of this.sides) {
      const wins = this.sideWins[side.id] ?? 0;
      const rate = wins / totalIterations;
      sideStats[side.id] = {
        id: side.id,
        name: side.name,
        wins,
        winRate: rate
      };
      if (rate > winnerRate) {
        winnerRate = rate;
        winner = side;
      }
    }

    return {
      iterations: totalIterations,
      perCombatant,
      sides: sideStats,
      draws: this.draws,
      drawRate: this.draws / totalIterations,
      avgRounds: mean(this.roundsPerCombat),
      predictedWinner: winner ? {
        id: winner.id,
        name: winner.name,
        winRate: winnerRate
      } : null
    };
  }
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

function distStats(arr) {
  if (!arr.length) return { mean: 0, min: 0, max: 0, median: 0, stddev: 0, samples: 0 };
  return {
    mean: mean(arr),
    min: Math.min(...arr),
    max: Math.max(...arr),
    median: median(arr),
    stddev: stddev(arr),
    samples: arr.length
  };
}

/**
 * Group identical crits (same location + same numeric roll) so the display
 * can show frequencies rather than a wall of duplicates.
 * Sorts by frequency descending, then by severity descending.
 */
function summarizeCritsReceived(details) {
  if (!details?.length) return [];
  const buckets = new Map();
  for (const c of details) {
    const key = `${c.location}:${c.result}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        count: 0,
        location: c.location,
        result: c.result,
        name: c.name,
        description: c.description,
        severity: c.severity,
        conditions: c.conditions ?? []
      });
    }
    buckets.get(key).count++;
  }
  return [...buckets.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.result - a.result;
  });
}
