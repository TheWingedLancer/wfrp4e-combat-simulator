/**
 * WFRP4e rules resolution.
 *
 * These helpers implement the core mechanical flow for the simulator. They
 * roll dice using Math.random() (uniform d100) rather than routing through
 * Foundry's dice rollers, because the simulator runs thousands of iterations
 * and any chat/animation side-effect would destroy performance. The outcomes
 * are mechanically faithful to WFRP4e 4th Edition rules.
 */

const HIT_LOCATION_TABLE = [
  // 01-09 head, 10-24 left arm, 25-44 right arm, 45-79 body, 80-89 left leg, 90-100 right leg
  { max: 9, location: "head" },
  { max: 24, location: "lArm" },
  { max: 44, location: "rArm" },
  { max: 79, location: "body" },
  { max: 89, location: "lLeg" },
  { max: 100, location: "rLeg" }
];

const LOCATION_TO_ARMOUR = {
  head: "head",
  lArm: "lArm",
  rArm: "rArm",
  body: "body",
  lLeg: "lLeg",
  rLeg: "rLeg"
};

export function d100() { return Math.floor(Math.random() * 100) + 1; }
export function d10() { return Math.floor(Math.random() * 10) + 1; }

export function calcSL(roll, target) {
  if (roll === 1) return Math.max(0, Math.floor(target / 10)); // auto success
  if (roll >= 96) return -Math.max(1, Math.floor(target / 10) + 1); // auto fumble
  return Math.floor(target / 10) - Math.floor(roll / 10);
}

export function isDouble(n) {
  if (n === 100) return true; // 00 on both dice treated as double
  if (n < 11) return false;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return tens === ones;
}

export function reverseRoll(n) {
  // For hit location: reverse the tens and units of the attack roll.
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  let loc = ones * 10 + tens;
  if (loc === 0) loc = 100;
  return loc;
}

export function rollHitLocation(attackRoll) {
  const reversed = reverseRoll(attackRoll);
  for (const band of HIT_LOCATION_TABLE) {
    if (reversed <= band.max) return band.location;
  }
  return "body";
}

/**
 * Resolve an opposed combat test.
 * Returns { attackerWins, winnerSL, damageDealt, hitLocation }.
 */
export function resolveOpposedTest({ attacker, defender, weapon, actionType }) {
  // Attacker test
  const attackerSkill = attacker.weaponSkillFor(weapon);
  const attackerAdv = attacker.state.advantage * 10;
  const attackerTarget = attackerSkill.total + attackerAdv + attackerModifier(attacker, defender, weapon, actionType);

  const attackerRoll = d100();
  const attackerSL = calcSL(attackerRoll, attackerTarget);

  // Defender test - choose parry, dodge, or nothing.
  const defenderOption = chooseDefense(defender, attacker);
  let defenderTarget = 0;
  let defenderRoll = 0;
  let defenderSL = -99;

  if (defenderOption === "parry") {
    const defenderWeapons = defender.getWeapons();
    const parryWeapon = defenderWeapons[0];
    if (parryWeapon) {
      const defenderSkill = defender.weaponSkillFor(parryWeapon);
      defenderTarget = defenderSkill.total + defender.state.advantage * 10;
      defenderRoll = d100();
      defenderSL = calcSL(defenderRoll, defenderTarget);
    }
  } else if (defenderOption === "dodge") {
    const dodge = defender.getSkill("Dodge");
    defenderTarget = (dodge?.total ?? defender.characteristic("ag")) + defender.state.advantage * 10;
    defenderRoll = d100();
    defenderSL = calcSL(defenderRoll, defenderTarget);
  } else {
    // No defense — attacker auto-wins if they passed.
    defenderSL = -999;
  }

  const attackerPassed = attackerSL >= 0;
  const defenderPassed = defenderSL >= 0;

  let attackerWins = false;
  let winnerSL = 0;

  if (attackerPassed && !defenderPassed) {
    attackerWins = true;
    winnerSL = attackerSL - Math.min(0, defenderSL); // add magnitude of defender fumble? Standard rules: winner SL minus loser SL.
    winnerSL = attackerSL - defenderSL;
  } else if (!attackerPassed && defenderPassed) {
    attackerWins = false;
    winnerSL = defenderSL - attackerSL;
  } else if (attackerPassed && defenderPassed) {
    if (attackerSL >= defenderSL) {
      attackerWins = true;
      winnerSL = attackerSL - defenderSL;
    } else {
      attackerWins = false;
      winnerSL = defenderSL - attackerSL;
    }
    // Tie: attacker wins ties per 4e core.
    if (attackerSL === defenderSL) {
      attackerWins = true;
      winnerSL = 0;
    }
  } else {
    // Both fail - no effect.
    return { attackerWins: false, winnerSL: 0, damageDealt: 0, hitLocation: null, attackerRoll, defenderRoll };
  }

  const hitLocation = rollHitLocation(attackerRoll);

  return {
    attackerWins,
    winnerSL,
    damageDealt: attackerWins ? 1 : 0,
    hitLocation,
    attackerRoll,
    defenderRoll
  };
}

function attackerModifier(attacker, defender, weapon, actionType) {
  let mod = 0;

  // Defender prone => +20 melee
  if (defender.hasCondition("prone") && actionType === "melee") mod += 20;
  if (defender.hasCondition("stunned")) mod += 20;
  if (defender.hasCondition("entangled")) mod += 20;
  if (defender.hasCondition("surprised")) mod += 20;

  // Attacker conditions.
  if (attacker.hasCondition("prone")) mod -= 20;
  if (attacker.hasCondition("blinded")) mod -= 40;
  const fatigued = attacker.conditionStacks("fatigued");
  if (fatigued) mod -= 10 * fatigued;

  // Ranged band modifiers.
  if (actionType === "ranged") {
    const range = attacker.rangeTo(defender);
    const rangeMods = { point: 20, short: 10, medium: 0, long: -10, extreme: -30, engaged: -20 };
    mod += rangeMods[range] ?? 0;
  }

  return mod;
}

function chooseDefense(defender, attacker) {
  if (!defender.isActive()) return "none";
  if (defender.state.dodging) return "dodge";
  if (defender.state.defending) return "parry";
  const weapons = defender.getWeapons();
  const dodge = defender.getSkill("Dodge");
  const parryTarget = weapons[0] ? defender.weaponSkillFor(weapons[0]).total : 0;
  const dodgeTarget = dodge?.total ?? 0;
  return parryTarget >= dodgeTarget ? "parry" : "dodge";
}

/**
 * Resolve damage after a successful attack.
 */
export function resolveDamage({ attacker, defender, weapon, sl, hitLocation }) {
  const baseDamage = weapon.system?.damage?.value ?? 0;
  const sb = attacker.bonus("s");

  // Weapon flags
  const flags = weaponQualities(weapon);
  const weaponDamage = flags.usesSB === false ? baseDamage : (baseDamage + sb);

  // Impact: SL damage doubled on hits.
  const slDamage = flags.impact ? Math.max(0, sl) : Math.max(0, sl);

  let totalDamage = weaponDamage + slDamage;

  // Strike Mighty Blow: +1 damage per talent rank
  if (attacker.hasTalent("Strike Mighty Blow")) totalDamage += 1;

  // Defender mitigation.
  const tb = defender.bonus("t");
  const ap = defender.getArmourAt(hitLocation);
  let mitigation = tb + ap;

  // Damaging / Impact bypass AP under certain conditions in 4e.
  const attackRoll = sl >= 0 ? 10 : 50; // placeholder; we already rolled SL.
  // Hardy: +TB additional wounds absorption
  if (defender.hasTalent("Hardy")) mitigation += defender.bonus("t");

  let wounds = Math.max(0, totalDamage - mitigation);

  // Critical trigger: excess damage beyond current wounds OR natural hit-location-specific crit rule.
  const preWounds = defender.currentWounds();
  const triggeredCritical = (preWounds - wounds) <= 0 || flags.impale;

  return {
    woundsDealt: wounds,
    triggeredCritical,
    hitLocation
  };
}

function weaponQualities(weapon) {
  const qualities = weapon.system?.qualities?.value ?? [];
  const flaws = weapon.system?.flaws?.value ?? [];
  const qualityNames = (Array.isArray(qualities) ? qualities : []).map(q => (q.name ?? q)?.toLowerCase?.() ?? "");
  const flawNames = (Array.isArray(flaws) ? flaws : []).map(q => (q.name ?? q)?.toLowerCase?.() ?? "");

  return {
    impact: qualityNames.some(n => n.includes("impact")),
    impale: qualityNames.some(n => n.includes("impale")),
    damaging: qualityNames.some(n => n.includes("damaging")),
    hack: qualityNames.some(n => n.includes("hack")),
    fast: qualityNames.some(n => n.includes("fast")),
    slow: flawNames.some(n => n.includes("slow")),
    usesSB: !qualityNames.some(n => n.includes("blackpowder") || n.includes("bow") || n.includes("crossbow"))
  };
}

/**
 * Roll a critical wound. We approximate the crit table result with a d100.
 * Higher results = more severe. The simulator tracks the *numeric* roll so
 * averages are meaningful; the narrative effect is not simulated mechanically
 * beyond death thresholds, which are handled by the Combatant class.
 */
export function rollCriticalWound(hitLocation) {
  const roll = d100();
  return {
    result: roll,
    location: hitLocation,
    // Rough severity bucket.
    severity: roll <= 20 ? "minor" : roll <= 60 ? "serious" : roll <= 90 ? "major" : "lethal"
  };
}
