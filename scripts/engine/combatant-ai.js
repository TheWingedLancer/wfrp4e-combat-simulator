/**
 * CombatantAI - default action-selection logic.
 *
 * Heuristics:
 *  - If engaged, attack with best-damage melee weapon.
 *  - If caster with a damage spell and sufficient WP, cast it.
 *  - If has ranged weapon and an enemy is not engaged, shoot.
 *  - If out of range, move closer.
 *  - If heavily wounded (<=25% wounds), consider defending.
 */

export class CombatantAI {
  chooseAction(self, enemies, allCombatants) {
    if (!enemies.length) return null;

    const target = this._chooseTarget(self, enemies);
    const weapons = self.getWeapons();
    const spells = self.getSpells();

    const meleeWeapons = weapons.filter(w => this._isMelee(w));
    const rangedWeapons = weapons.filter(w => this._isRanged(w));

    const currentRange = self.rangeTo(target);
    const engaged = currentRange === "engaged";

    // Low wounds: defensive posture (but still attack).
    const lowHealth = self.currentWounds() <= Math.ceil(self.state.maxWounds * 0.25);

    // Caster logic: prefer damaging spells if available and WP is high.
    if (spells.length > 0 && self.characteristic("wp") >= 35) {
      const damageSpell = this._bestDamageSpell(spells);
      if (damageSpell) {
        return { type: "cast", spell: damageSpell, target };
      }
    }

    // Engaged - melee.
    if (engaged && meleeWeapons.length > 0) {
      const weapon = this._bestWeapon(self, meleeWeapons);
      return { type: "melee", weapon, target, defending: lowHealth };
    }

    // Ranged enemy not engaged.
    if (!engaged && rangedWeapons.length > 0) {
      const weapon = this._bestWeapon(self, rangedWeapons);
      return { type: "ranged", weapon, target };
    }

    // Move to close.
    if (!engaged && meleeWeapons.length > 0) {
      const nextRange = this._closeOneStep(currentRange);
      return { type: "move", target, newRange: nextRange };
    }

    // Has melee weapon but currently only has ranged situation and no ammo? Default: defend.
    if (meleeWeapons.length === 0 && rangedWeapons.length === 0) {
      // Unarmed - use trait weapon if any, else defend.
      const weaponTrait = self.items.find(i => i.type === "trait" && /weapon/i.test(i.name));
      if (weaponTrait) {
        const pseudo = {
          id: weaponTrait.id,
          name: weaponTrait.name,
          type: "weapon",
          system: {
            damage: { value: parseInt(weaponTrait.system?.specification?.value ?? 0) || 0 },
            weaponGroup: { value: "basic" },
            qualities: { value: [] },
            flaws: { value: [] },
            equipped: { value: true }
          }
        };
        return { type: "melee", weapon: pseudo, target };
      }
      return { type: "defend" };
    }

    // Fall-through: attack with whatever we have.
    const fallbackWeapon = this._bestWeapon(self, weapons);
    return { type: engaged ? "melee" : "ranged", weapon: fallbackWeapon, target };
  }

  _chooseTarget(self, enemies) {
    // Prefer lowest current wounds (easy kill), break ties by highest advantage threat.
    return [...enemies].sort((a, b) => {
      if (a.currentWounds() !== b.currentWounds()) return a.currentWounds() - b.currentWounds();
      return (b.characteristic("ws") ?? 0) - (a.characteristic("ws") ?? 0);
    })[0];
  }

  _bestWeapon(self, weapons) {
    const sb = self.bonus("s");
    return [...weapons].sort((a, b) => {
      const da = (a.system?.damage?.value ?? 0) + sb;
      const db = (b.system?.damage?.value ?? 0) + sb;
      return db - da;
    })[0];
  }

  _bestDamageSpell(spells) {
    return [...spells]
      .filter(s => (s.system?.damage?.value ?? 0) > 0)
      .sort((a, b) => (b.system?.damage?.value ?? 0) - (a.system?.damage?.value ?? 0))[0] ?? null;
  }

  _isMelee(weapon) {
    const group = weapon.system?.weaponGroup?.value;
    const rangedGroups = ["bow", "crossbow", "blackpowder", "engineering", "sling", "throwing", "entangling"];
    return !rangedGroups.includes(group);
  }

  _isRanged(weapon) {
    return !this._isMelee(weapon);
  }

  _closeOneStep(range) {
    const order = ["extreme", "long", "medium", "short", "engaged"];
    const idx = order.indexOf(range);
    if (idx === -1) return "engaged";
    return order[Math.min(order.length - 1, idx + 1)];
  }
}
