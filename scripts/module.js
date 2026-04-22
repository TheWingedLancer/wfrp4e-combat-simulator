/**
 * WFRP4e Combat Simulator
 * Monte Carlo combat simulation for Warhammer Fantasy Roleplay 4th Edition.
 */

import { CombatSimulatorApp } from "./apps/combat-simulator-app.js";
import { SimulationEngine } from "./engine/simulation-engine.js";
import { CombatantAI } from "./engine/combatant-ai.js";
import { ResultsApp } from "./apps/results-app.js";

const MODULE_ID = "wfrp4e-combat-simulator";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);

  // Expose API for macros and other modules.
  game.modules.get(MODULE_ID).api = {
    open: () => new CombatSimulatorApp().render(true),
    SimulationEngine,
    CombatantAI,
    ResultsApp
  };

  // Module settings.
  game.settings.register(MODULE_ID, "defaultIterations", {
    name: "WFRP4E_SIM.Settings.DefaultIterations.Name",
    hint: "WFRP4E_SIM.Settings.DefaultIterations.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 1000,
    range: { min: 10, max: 10000, step: 10 }
  });

  game.settings.register(MODULE_ID, "maxRounds", {
    name: "WFRP4E_SIM.Settings.MaxRounds.Name",
    hint: "WFRP4E_SIM.Settings.MaxRounds.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 20,
    range: { min: 5, max: 100, step: 1 }
  });

  game.settings.register(MODULE_ID, "suppressChatMessages", {
    name: "WFRP4E_SIM.Settings.SuppressChat.Name",
    hint: "WFRP4E_SIM.Settings.SuppressChat.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);
  if (!game.wfrp4e) {
    ui.notifications.error("WFRP4e Combat Simulator requires the wfrp4e system.");
  }
});

/**
 * Add a scene control button for GMs.
 * v13: controls is an object keyed by control name; tools is an object keyed by tool name.
 */
Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControls = controls.tokens;
  if (!tokenControls?.tools) return;

  tokenControls.tools["wfrp4e-combat-sim"] = {
    name: "wfrp4e-combat-sim",
    title: "WFRP4E_SIM.OpenSimulator",
    icon: "fas fa-swords",
    order: Object.keys(tokenControls.tools).length,
    button: true,
    visible: game.user.isGM,
    onChange: () => {
      const existing = foundry.applications.instances.get("wfrp4e-combat-simulator");
      if (existing) existing.close();
      else game.modules.get(MODULE_ID).api.open();
    }
  };
});

/**
 * Add a button to the Actors sidebar. Inserts into the same action group
 * as Foundry's native "Create Actor" / "Create Folder" buttons so it
 * inherits the native button appearance.
 */
Hooks.on("renderActorDirectory", (app, html) => {
  if (!game.user.isGM) return;

  const root = html instanceof HTMLElement ? html : html[0];
  if (!root) return;
  if (root.querySelector(".wfrp4e-sim-open")) return;

  // v13 sidebar: directory-header > .action-buttons contains the create buttons.
  // Fallbacks handle older layouts where the directory-header itself is the host.
  const actionGroup =
    root.querySelector(".directory-header .action-buttons") ??
    root.querySelector(".header-actions") ??
    root.querySelector(".directory-header");

  if (!actionGroup) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wfrp4e-sim-open";
  btn.innerHTML = `<i class="fas fa-swords"></i> ${game.i18n.localize("WFRP4E_SIM.OpenSimulator")}`;
  btn.addEventListener("click", () => game.modules.get(MODULE_ID).api.open());
  actionGroup.appendChild(btn);
});
