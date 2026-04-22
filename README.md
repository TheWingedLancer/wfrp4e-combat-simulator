# WFRP4e Combat Simulator

A FoundryVTT v13 module for Warhammer Fantasy Roleplay 4th Edition that runs Monte Carlo simulations of combat encounters.

Drop actors onto two or more sides, set your iteration count and victory condition, and the module will run the fight N times, returning per-combatant statistics and a predicted winner.

## Features

- **Drag-and-drop setup** — pull any Actor from the sidebar onto a side
- **Unlimited sides** — not just 2v2; model skirmishes, ambushes, three-way fights
- **Configurable victory conditions**: last side standing, incapacitation, rout, or fixed-round damage comparison
- **Faithful rules coverage**:
  - Core opposed tests, SL, damage, AP, hit locations
  - Advantage tracking
  - Talents & Traits (Hardy, Strike Mighty Blow, Armour, natural weapons)
  - Conditions (prone, stunned, bleeding, poisoned, ablaze, blinded, fatigued)
  - Fate / Fortune / Resolve / Resilience
  - Ranged combat with range bands
  - Spellcasting with CN targets and miscast detection
- **Distribution statistics** — mean, min, max, median, stddev for damage in/out and crits in/out
- **Opt-in actor updates** — after a sim, the GM is prompted whether to apply average damage to real sheets

## Install

Until the first release is tagged, install via manifest URL:

```
https://github.com/TheWingedLancer/wfrp4e-combat-simulator/releases/latest/download/module.json
```

## Usage

1. Enable the module in your world
2. Click the **swords** tool in the token scene controls, or the new **Open Combat Simulator** button in the Actors sidebar
3. Drag actors onto Side A, Side B, and any additional sides you create
4. Configure iterations, max rounds, victory condition, and starting range
5. Click **Run Simulation**
6. When prompted, choose whether to apply average damage back to the real actors

## API

The module exposes an API for macros:

```js
const mod = game.modules.get("wfrp4e-combat-simulator").api;
mod.open();  // opens the setup UI
```

Advanced users can instantiate `mod.SimulationEngine` directly with custom side/config objects to bypass the UI.

## How It Works

Each iteration:
1. Deep-clones every combatant's actor data into an isolated `Combatant` object
2. Rolls initiative, then processes turns in descending order
3. Each combatant's AI picks an action: melee, ranged, cast, move, or defend
4. Rolls are resolved through a local rules engine (not Foundry's chat pipeline — that would destroy performance at 1000+ iterations)
5. Wounds, crits, conditions, Fate burns, and advantage are tracked
6. When the victory condition triggers, the iteration ends

Statistics are accumulated across all iterations and summarized with distribution stats per combatant.

## Caveats

- The AI picks sensible defaults (best weapon, best damage spell, move to engage) but does not know about your table's house rules or specific tactical context
- Critical wounds are simulated by tracking the d100 *roll value*; the severity bucket is indicative but doesn't mechanically apply the crit table text
- Applying results to real actors is a one-way average-damage operation; undo before running live combat if you change your mind

## Author

Built by **TheWingedLancer** (Jeramie Brown) as part of a broader WFRP4e tooling stack. Companion modules: `wfrp4e-consumables-with-effects`, `wfrp4e-trapping-builder`.

## License

MIT
