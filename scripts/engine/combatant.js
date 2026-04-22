/**
 * Combatant - a per-iteration mutable wrapper around an Actor's data.
 * NEVER mutates the real Actor document.
 */

export class Combatant {
  constructor({ entryId, sideId, sideName, actor, startingRange }) {
    this.id = entryId ?? foundry.utils.randomID();
    this.sideId = sideId;
    this.sideName = sideName;
    this.actorId = actor.id;
    this.actorName = actor.name;
    this.actorType = actor.type;

    // Deep clone relevant system data.
    const system = foundry.utils.deepClone(actor.system ?? {});
    this.system = system;

    // Items: deep clone as plain objects, preserving system subtree.
    this.items = actor.items.map(i => ({
      id: i.id,
      name: i.name,
      type: i.type,
      system: foundry.utils.deepClone(i.system ?? {})
    }));

    // Initialise dynamic combat state. Use MAX wounds, not saved current wounds,
    // so every iteration starts each combatant fresh.
    const maxW = system?.status?.wounds?.max ?? system?.status?.wounds?.value ?? 1;
    this.state = {
      currentWounds: maxW,
      maxWounds: maxW,
      advantage: 0,
      fate: system?.status?.fate?.value ?? 0,
      fortune: system?.status?.fortune?.value ?? 0,
      resilience: system?.status?.resilience?.value ?? 0,
      resolve: system?.status?.resolve?.value ?? 0,
      criticalWounds: [],
      conditions: {},
      defending: false,
      dodging: false,
      dead: false,
      unconscious: false,
      // Per-enemy range tracking for ranged combat.
      rangeTo: {}, // targetCombatantId -> "engaged"|"short"|"medium"|"long"|"extreme"
      startingRange
    };
  }

  /* ---------------------------------- */
  /*  Queries                           */
  /* ---------------------------------- */

  characteristic(abbrev) {
    const c = this.system?.characteristics?.[abbrev];
    if (!c) return 0;
    return (c.value ?? 0) + (c.modifier ?? 0);
  }

  bonus(abbrev) {
    return Math.floor(this.characteristic(abbrev) / 10);
  }

  getSkill(name) {
    const skill = this.items.find(i => i.type === "skill" && i.name === name);
    if (!skill) return null;
    const char = skill.system?.characteristic?.value ?? "ws";
    const advances = skill.system?.advances?.value ?? 0;
    return {
      name: skill.name,
      characteristic: char,
      advances,
      total: this.characteristic(char) + advances
    };
  }

  weaponSkillFor(weapon) {
    const groupKey = weapon.system?.weaponGroup?.value;
    // System-defined skill name mapping if available.
    const skillName = game.wfrp4e?.config?.weaponGroups?.[groupKey];
    if (skillName) {
      const skill = this.getSkill(`Melee (${skillName})`) ?? this.getSkill(`Ranged (${skillName})`);
      if (skill) return skill;
    }
    // Fallback: use raw WS/BS.
    const isRanged = weapon.system?.weaponGroup?.value && ["bow", "crossbow", "blackpowder", "engineering", "sling", "throwing", "entangling"].includes(weapon.system.weaponGroup.value);
    return { total: this.characteristic(isRanged ? "bs" : "ws"), characteristic: isRanged ? "bs" : "ws", advances: 0, name: "" };
  }

  getWeapons() {
    const weapons = this.items.filter(i => i.type === "weapon");
    // For creatures, weapons are typically always "available" - no equipped flag semantics.
    if (this.actorType === "creature" || this.actorType === "vehicle") return weapons;
    return weapons.filter(i => {
      const eq = i.system?.equipped;
      if (typeof eq === "object" && eq !== null) return !!eq.value;
      return !!eq;
    });
  }

  getSpells() {
    return this.items.filter(i => i.type === "spell");
  }

  hasTalent(name) {
    return this.items.some(i => i.type === "talent" && i.name.toLowerCase() === name.toLowerCase());
  }

  hasTrait(name) {
    return this.items.some(i => i.type === "trait" && i.name.toLowerCase() === name.toLowerCase());
  }

  getArmourAt(location = "body") {
    let ap = 0;
    for (const item of this.items) {
      if (item.type !== "armour") continue;
      const equipped = item.system?.worn?.value ?? item.system?.equipped?.value;
      if (!equipped) continue;
      const locations = item.system?.maxAP ?? item.system?.currentAP ?? {};
      const apAtLoc = locations[location]?.value ?? locations[location];
      if (typeof apAtLoc === "number") ap += apAtLoc;
    }
    // Traits: Armour (X) adds AP everywhere.
    const armourTrait = this.items.find(i => i.type === "trait" && /^armour/i.test(i.name));
    if (armourTrait) {
      const val = parseInt(armourTrait.system?.specification?.value ?? armourTrait.name.match(/\d+/)?.[0] ?? 0);
      if (!Number.isNaN(val)) ap += val;
    }
    return ap;
  }

  currentWounds() { return this.state.currentWounds; }

  isActive() {
    return !this.state.dead && !this.state.unconscious && this.state.currentWounds > 0;
  }

  isDead() { return this.state.dead; }

  hasFate() { return this.state.fate > 0; }

  /* ---------------------------------- */
  /*  Mutations                         */
  /* ---------------------------------- */

  takeWounds(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return;
    this.state.currentWounds -= n;
    if (this.state.currentWounds <= 0) {
      const tb = this.bonus("t");
      // Reduced to 0: unconscious. Beyond -TB: dead.
      if (this.state.currentWounds < -tb) {
        this.state.dead = true;
      } else {
        this.state.unconscious = true;
      }
    }
  }

  addCriticalWound(crit) {
    this.state.criticalWounds.push(crit);
    // Each crit beyond TB causes death (WFRP4e p.164).
    const tb = this.bonus("t");
    if (this.state.criticalWounds.length > tb) {
      if (this.hasFate()) {
        // Fate can be burned to survive (handled by engine).
      } else {
        this.state.dead = true;
      }
    }
  }

  spendFate() { if (this.state.fate > 0) this.state.fate--; }
  spendFortune() { if (this.state.fortune > 0) this.state.fortune--; }
  spendResolve() { if (this.state.resolve > 0) this.state.resolve--; }
  spendResilience() { if (this.state.resilience > 0) this.state.resilience--; }

  revive(wounds = 1) {
    this.state.dead = false;
    this.state.unconscious = false;
    this.state.currentWounds = Math.max(wounds, 1);
  }

  addAdvantage(n = 1) {
    this.state.advantage = Math.min(10, Math.max(0, this.state.advantage + n));
  }

  setAdvantage(n) { this.state.advantage = Math.max(0, n); }

  setDefending(v) { this.state.defending = v; }
  setDodging(v) { this.state.dodging = v; }

  addCondition(name, stacks = 1) {
    this.state.conditions[name] = (this.state.conditions[name] ?? 0) + stacks;
  }

  removeCondition(name, stacks = 1) {
    if (!this.state.conditions[name]) return;
    this.state.conditions[name] -= stacks;
    if (this.state.conditions[name] <= 0) delete this.state.conditions[name];
  }

  hasCondition(name) { return (this.state.conditions[name] ?? 0) > 0; }
  conditionStacks(name) { return this.state.conditions[name] ?? 0; }

  setRangeTo(target, range) { this.state.rangeTo[target.id] = range; }
  rangeTo(target) { return this.state.rangeTo[target.id] ?? this.state.startingRange; }

  snapshotStats() {
    return {
      id: this.id,
      actorId: this.actorId,
      name: this.actorName,
      sideId: this.sideId,
      currentWounds: this.state.currentWounds,
      maxWounds: this.state.maxWounds,
      alive: this.isActive(),
      criticalWoundsTaken: this.state.criticalWounds.length,
      fateRemaining: this.state.fate
    };
  }
}
