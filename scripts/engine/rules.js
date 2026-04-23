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

/**
 * Parse a wfrp4e weapon's damage into a numeric base. The system may prepare
 * `damage.value` to a number, but in many cases — especially for just-cloned
 * item data or older templates — `damage.value` is a string like "SB + 4" or
 * "SB+4" or "4". This helper handles all of those, plus the `meleeValue` /
 * `rangedValue` resolved fields that appear on prepared weapon data.
 */
function parseWeaponDamage(weapon, attacker) {
  const sys = weapon.system ?? {};
  const dmg = sys.damage ?? {};
  const sb = attacker.bonus("s");
  const candidates = [
    dmg.meleeValue,
    dmg.rangedValue,
    dmg.current,
    dmg.value
  ];
  for (const c of candidates) {
    if (typeof c === "number" && !Number.isNaN(c)) return c;
    if (typeof c === "string" && c.trim()) {
      const parsed = evalDamageExpr(c, sb);
      if (parsed !== null) return parsed;
    }
  }
  return 0;
}

/** Evaluate "SB + 4", "4", "SB+3", "3+SB" into a number. Returns null on failure. */
function evalDamageExpr(expr, sb) {
  if (!expr) return null;
  // Normalise: strip whitespace, upper-case.
  const s = String(expr).replace(/\s+/g, "").toUpperCase();
  // Pure integer
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  // SB + n or n + SB, with optional sign
  const plus = s.split("+");
  if (plus.length === 2) {
    const a = plus[0] === "SB" ? sb : (/^-?\d+$/.test(plus[0]) ? parseInt(plus[0], 10) : null);
    const b = plus[1] === "SB" ? sb : (/^-?\d+$/.test(plus[1]) ? parseInt(plus[1], 10) : null);
    if (a !== null && b !== null) return a + b;
  }
  // SB - n
  if (s.includes("-")) {
    const minus = s.split("-");
    if (minus.length === 2) {
      const a = minus[0] === "SB" ? sb : (/^-?\d+$/.test(minus[0]) ? parseInt(minus[0], 10) : null);
      const b = minus[1] === "SB" ? sb : (/^-?\d+$/.test(minus[1]) ? parseInt(minus[1], 10) : null);
      if (a !== null && b !== null) return a - b;
    }
  }
  // Just "SB"
  if (s === "SB") return sb;
  return null;
}

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
  const sb = attacker.bonus("s");
  // parseWeaponDamage handles "SB+4" strings, meleeValue/rangedValue fields,
  // and raw numerics. It already folds SB in when the expression uses SB,
  // so we don't add sb again below when the string-form is in play.
  const parsedDamage = parseWeaponDamage(weapon, attacker);

  // Weapon flags
  const flags = weaponQualities(weapon);

  // If the raw damage.value was a *pure numeric* on an item that the system
  // hadn't prepared (rare, but possible for freshly-created items), we add SB
  // when the weapon uses SB. The parser already added SB for "SB+X" forms.
  // Heuristic: if damage.value is a string containing "SB", we trust the parse;
  // otherwise we add SB for melee weapons that use it.
  const rawDamageStr = String(weapon.system?.damage?.value ?? "");
  const alreadyIncludesSB = /SB/i.test(rawDamageStr);
  const weaponDamage = (!alreadyIncludesSB && flags.usesSB !== false)
    ? parsedDamage + sb
    : parsedDamage;

  const slDamage = Math.max(0, sl);
  let totalDamage = weaponDamage + slDamage;

  // Strike Mighty Blow: +1 damage per talent rank
  if (attacker.hasTalent("Strike Mighty Blow")) totalDamage += 1;

  // Defender mitigation.
  const tb = defender.bonus("t");
  const ap = defender.getArmourAt(hitLocation);
  let mitigation = tb + ap;

  // Hardy: +TB additional wounds absorption
  if (defender.hasTalent("Hardy")) mitigation += defender.bonus("t");

  let wounds = Math.max(0, totalDamage - mitigation);
  if (!Number.isFinite(wounds)) wounds = 0;

  // Critical trigger: reducing defender to 0 or below wounds, or Impale quality.
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
 * Location -> wfrp4e critical table key mapping.
 * The wfrp4e core exposes these standard tables; GMs can install Up in Arms
 * or other supplements that register alternative tables via modules.
 */
const LOCATION_TO_CRIT_TABLE = {
  head: "crithead",
  body: "critbody",
  lArm: "critarm",
  rArm: "critarm",
  lLeg: "critleg",
  rLeg: "critleg"
};

/**
 * Conditions that appear commonly in the wfrp4e crit table text.
 * Keyed by the word as it appears in the description; value is the
 * canonical condition id recognised by ConditionManager.
 */
const CRIT_CONDITION_PATTERNS = [
  { regex: /\bbleeding\b/i,    key: "bleeding",    captureStacks: /bleeding\s*\+?(\d+)/i },
  { regex: /\bstunned\b/i,     key: "stunned",     captureStacks: /stunned\s*\+?(\d+)/i },
  { regex: /\bprone\b/i,       key: "prone",       captureStacks: null },
  { regex: /\bblinded\b/i,     key: "blinded",     captureStacks: /blinded\s*\+?(\d+)/i },
  { regex: /\bdeafened\b/i,    key: "deafened",    captureStacks: /deafened\s*\+?(\d+)/i },
  { regex: /\bfatigued\b/i,    key: "fatigued",    captureStacks: /fatigued\s*\+?(\d+)/i },
  { regex: /\bentangled\b/i,   key: "entangled",   captureStacks: null },
  { regex: /\bbroken\b/i,      key: "broken",      captureStacks: /broken\s*\+?(\d+)/i },
  { regex: /\bablaze\b/i,      key: "ablaze",      captureStacks: null },
  { regex: /\bunconscious\b/i, key: "unconscious", captureStacks: null }
];

/**
 * Roll a critical wound against the wfrp4e system's crit table.
 * Falls back to a severity-only result if the system tables are unavailable
 * (e.g., user is running the bare system without the core module installed).
 *
 * Returns:
 *   {
 *     result: number,         // d100 roll
 *     location: string,       // hit location key
 *     tableKey: string,       // crithead / critbody / etc.
 *     name: string,           // short name of the crit (e.g. "Minor Head Wound")
 *     description: string,    // narrative text / effect
 *     extraWounds: number,    // additional wounds dealt by the crit entry
 *     conditions: Array<{key, stacks}>,
 *     severity: string        // rough bucket (minor|serious|major|lethal)
 *   }
 */
export function rollCriticalWound(hitLocation) {
  const roll = d100();
  const tableKey = LOCATION_TO_CRIT_TABLE[hitLocation] ?? "critbody";

  let name = "";
  let description = "";
  let extraWounds = 0;
  let conditions = [];

  const tables = game?.wfrp4e?.tables;
  if (tables && typeof tables.rollTable === "function") {
    try {
      // Pass the pre-rolled d100 as a forced roll so our random sequence is
      // honoured, rather than having the system re-roll internally.
      const res = tables.rollTable(tableKey, { roll });
      if (res) {
        name = res.name ?? res.title ?? "";
        description = stripHTML(res.description ?? res.text ?? res.result ?? "");
        // Many crit entries include a "Wounds: X" field or parse-able marker.
        extraWounds = Number(res.wounds?.value ?? res.extraWounds ?? 0) || 0;
        conditions = extractConditionsFromText(description);
      }
    } catch (err) {
      // Table not installed, or unexpected shape - fall through to bucket-only.
      console.warn("WFRP4e Combat Simulator | crit table roll failed, using severity bucket only", err);
    }
  }

  return {
    result: roll,
    location: hitLocation,
    tableKey,
    name,
    description,
    extraWounds,
    conditions,
    severity: roll <= 20 ? "minor" : roll <= 60 ? "serious" : roll <= 90 ? "major" : "lethal"
  };
}

function stripHTML(str) {
  if (!str) return "";
  return String(str).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function extractConditionsFromText(text) {
  if (!text) return [];
  const found = [];
  const seen = new Set();
  for (const pat of CRIT_CONDITION_PATTERNS) {
    if (!pat.regex.test(text)) continue;
    if (seen.has(pat.key)) continue;
    seen.add(pat.key);
    let stacks = 1;
    if (pat.captureStacks) {
      const m = text.match(pat.captureStacks);
      if (m && Number.isFinite(Number(m[1]))) stacks = Number(m[1]);
    }
    found.push({ key: pat.key, stacks });
  }
  return found;
}
