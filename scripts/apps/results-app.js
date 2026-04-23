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
        deathRatePct: (c.deathRate * 100).toFixed(1),
        critsReceivedDetailed: (c.critsReceivedDetailed ?? []).map(fmtCrit)
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

    // Build a preview of what will happen, then show it for confirmation.
    const preview = this.engine.buildApplyPreview(this.results);
    if (!preview.length) {
      ui.notifications.warn("No actor-level results to apply.");
      return;
    }

    const confirmed = await ResultsApp._confirmApplyWithPreview(preview);
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

  /**
   * Preview dialog: shows the per-actor summary of wounds to apply and which
   * crit (if any) will be attached, then asks for confirmation.
   */
  static _confirmApplyWithPreview(preview) {
    const rows = preview.map(p => {
      const critLine = (p.avgCrits >= 1.0 && p.topCrit?.uuid)
        ? `<li class="sim-apply-crit">
             <i class="fas fa-skull"></i>
             Crit: <strong>${foundry.utils.escapeHTML(p.topCrit.name || "Unknown")}</strong>
             <span class="sim-apply-meta">(received ×${p.topCrit.count} over sim; avg ${p.avgCrits.toFixed(2)}/iter)</span>
           </li>`
        : `<li class="sim-apply-nocrit">
             No crit applied <span class="sim-apply-meta">(avg ${p.avgCrits.toFixed(2)}/iter, threshold 1.0)</span>
           </li>`;
      return `
        <div class="sim-apply-actor">
          <h4>${foundry.utils.escapeHTML(p.actorName)}</h4>
          <ul>
            <li>Wounds: <strong>${p.currentWounds} → ${p.newWounds}</strong>
              <span class="sim-apply-meta">(−${p.avgWounds})</span></li>
            ${critLine}
          </ul>
        </div>
      `;
    }).join("");

    const content = `
      <div class="sim-apply-preview">
        <p>${game.i18n.localize("WFRP4E_SIM.ApplyResults.Prompt")}</p>
        <div class="sim-apply-rows">${rows}</div>
      </div>
    `;

    return new Promise((resolve) => {
      new DialogV2({
        window: { title: game.i18n.localize("WFRP4E_SIM.ApplyResults.Title") },
        content,
        position: { width: 520 },
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

  static _confirmApply() {
    // Kept for backwards compatibility / simple path.
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

function fmtCrit(c) {
  const locKey = `WFRP4E_SIM.Location.${c.location}`;
  const sevKey = `WFRP4E_SIM.Severity.${c.severity}`;
  const locLabel = game.i18n.has(locKey) ? game.i18n.localize(locKey) : c.location;
  const sevLabel = game.i18n.has(sevKey) ? game.i18n.localize(sevKey) : c.severity;
  const condLabel = (c.conditions ?? [])
    .map(cond => cond.stacks > 1 ? `${cond.key} ×${cond.stacks}` : cond.key)
    .join(", ");
  return {
    ...c,
    locationLabel: locLabel,
    severityLabel: sevLabel,
    conditionsLabel: condLabel
  };
}
