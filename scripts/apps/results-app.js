/**
 * ResultsApp - displays simulation outcomes.
 */

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

export class ResultsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({ results, config, engine } = {}) {
    super();
    this.results = results;
    this.config = config;
    this.engine = engine;
    this.applied = false; // track so the user can't apply twice
  }

  static DEFAULT_OPTIONS = {
    id: "wfrp4e-combat-simulator-results",
    classes: ["wfrp4e", "wfrp4e-sim", "wfrp4e-sim-results"],
    tag: "div",
    window: {
      title: "WFRP4E_SIM.ResultsTitle",
      icon: "fas fa-scroll",
      resizable: true
    },
    position: {
      width: 900,
      height: 720
    },
    actions: {
      exportJson: ResultsApp.#onExportJson,
      applyToActors: ResultsApp.#onApplyToActors,
      closeResults: ResultsApp.#onClose
    }
  };

  static PARTS = {
    body: {
      template: "modules/wfrp4e-combat-simulator/templates/results.hbs",
      scrollable: [".results-scroll"]
    }
  };

  async _prepareContext(options) {
    const r = this.results;
    const sidesWithCombatants = {};
    for (const [cid, c] of Object.entries(r.perCombatant)) {
      sidesWithCombatants[c.sideId] ??= { id: c.sideId, name: c.sideName, combatants: [] };
      sidesWithCombatants[c.sideId].combatants.push({
        ...c,
        woundsInflicted: fmtDist(c.woundsInflicted),
        woundsReceived: fmtDist(c.woundsReceived),
        criticalsInflicted: fmtDist(c.criticalsInflicted),
        criticalsReceived: fmtDist(c.criticalsReceived),
        avgCriticalRollInflicted: c.avgCriticalRollInflicted.toFixed(1),
        avgCriticalRollReceived: c.avgCriticalRollReceived.toFixed(1),
        deathRatePct: (c.deathRate * 100).toFixed(1)
      });
    }

    const sidesArr = Object.values(sidesWithCombatants);

    // Side totals.
    for (const s of sidesArr) {
      s.winRatePct = ((r.sides[s.id]?.winRate ?? 0) * 100).toFixed(1);
      s.wins = r.sides[s.id]?.wins ?? 0;
    }

    return {
      iterations: r.iterations,
      sides: sidesArr,
      predictedWinner: r.predictedWinner,
      predictedWinnerPct: r.predictedWinner ? (r.predictedWinner.winRate * 100).toFixed(1) : null,
      avgRounds: r.avgRounds.toFixed(2),
      drawRatePct: (r.drawRate * 100).toFixed(1),
      config: this.config,
      canApply: !!this.engine && !this.applied && game.user.isGM,
      applied: this.applied
    };
  }

  static async #onExportJson(event, target) {
    const data = JSON.stringify(this.results, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wfrp4e-sim-results-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  static async #onApplyToActors(event, target) {
    if (this.applied || !this.engine) return;

    // Confirm before applying.
    const confirmed = await ResultsApp._confirmApply();
    if (!confirmed) return;

    try {
      target.disabled = true;
      target.textContent = game.i18n.localize("WFRP4E_SIM.ApplyingResults");
      await this.engine.applyAverageResultsToActors(this.results);
      this.applied = true;
      this.render();
    } catch (err) {
      console.error("WFRP4e Combat Simulator | Apply failed", err);
      ui.notifications.error(`Apply failed: ${err.message}`);
      if (target) {
        target.disabled = false;
        target.textContent = game.i18n.localize("WFRP4E_SIM.ApplyResults.Apply");
      }
    }
  }

  static #onClose() { this.close(); }

  static _confirmApply() {
    return new Promise((resolve) => {
      new DialogV2({
        window: { title: game.i18n.localize("WFRP4E_SIM.ApplyResults.Title") },
        content: `<p>${game.i18n.localize("WFRP4E_SIM.ApplyResults.Prompt")}</p>`,
        buttons: [
          {
            action: "apply",
            label: game.i18n.localize("WFRP4E_SIM.ApplyResults.Apply"),
            icon: "fas fa-heart-broken",
            callback: () => resolve(true)
          },
          {
            action: "cancel",
            label: game.i18n.localize("Cancel"),
            icon: "fas fa-times",
            default: true,
            callback: () => resolve(false)
          }
        ],
        close: () => resolve(false)
      }).render(true);
    });
  }
}

function fmtDist(d) {
  if (!d) return { mean: "0", min: "0", max: "0", median: "0", stddev: "0" };
  return {
    mean: d.mean.toFixed(2),
    min: d.min.toFixed(0),
    max: d.max.toFixed(0),
    median: d.median.toFixed(1),
    stddev: d.stddev.toFixed(2)
  };
}
