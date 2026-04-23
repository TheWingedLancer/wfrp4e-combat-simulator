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

    // Build a fresh preview each click. This also performs the probabilistic
    // crit roll per actor - the roll is carried in the preview so that the
    // dialog display and the final apply stay in sync. Cancelling and
    // re-clicking Apply intentionally re-rolls (GMs can explore the distribution).
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
      // Pass the same preview we just showed so wounds and the rolled crit
      // match what the user saw. Re-fetching would produce a different roll.
      await this.engine.applyAverageResultsToActors(this.results, preview);
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
   * Preview dialog: for each combatant ENTRY (not merged by actor), shows
   * the rolled wound value with its distribution, then the rolled crit
   * bucket with its distribution. Both rolls are fresh per Apply click.
   * Cancel + re-click re-rolls; Confirm commits what you see.
   */
  static _confirmApplyWithPreview(preview) {
    const rows = preview.map(p => ResultsApp._renderPreviewRow(p)).join("");

    const content = `
      <div class="sim-apply-preview">
        <p>${game.i18n.localize("WFRP4E_SIM.ApplyResults.Prompt")}</p>
        <p class="sim-apply-reroll-hint">${game.i18n.localize("WFRP4E_SIM.ApplyResults.RerollHint")}</p>
        <div class="sim-apply-rows">${rows}</div>
      </div>
    `;

    return new Promise((resolve) => {
      new DialogV2({
        window: { title: game.i18n.localize("WFRP4E_SIM.ApplyResults.Title") },
        content,
        position: { width: 640 },
        buttons: [
          {
            action: "apply",
            label: game.i18n.localize("WFRP4E_SIM.ApplyResults.ConfirmThisRoll"),
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

  /**
   * Render a single combatant-entry card: name + summary line + wound
   * distribution + crit distribution.
   */
  static _renderPreviewRow(p) {
    const header = `
      <h4>${foundry.utils.escapeHTML(p.displayName ?? p.actorName)}</h4>
      <ul>
        <li>
          <i class="fas fa-heart"></i>
          Wounds: <strong>${p.currentWounds} → ${p.newWounds}</strong>
          <span class="sim-apply-meta">(−${p.rolledWounds} rolled)</span>
        </li>
      </ul>`;

    return `
      <div class="sim-apply-actor">
        ${header}
        ${ResultsApp._renderWoundDistribution(p)}
        ${ResultsApp._renderCritDistribution(p)}
      </div>
    `;
  }

  /**
   * Wound distribution section: a small histogram where each bar is one
   * observed per-iteration wound total, with the rolled sample highlighted.
   */
  static _renderWoundDistribution(p) {
    const dist = p.woundDistribution ?? [];
    if (!dist.length) {
      return `
        <div class="sim-apply-nocrits-ever">
          <i class="fas fa-shield-alt"></i>
          ${game.i18n.localize("WFRP4E_SIM.ApplyResults.NoWoundsEver")}
        </div>`;
    }

    const bars = dist.map(b => {
      const pct = b.percent.toFixed(1);
      const barWidth = Math.max(0.5, b.percent);
      const classes = [
        "sim-dist-row",
        "sim-dist-wound",
        b.isRolled ? "sim-dist-rolled" : ""
      ].filter(Boolean).join(" ");
      const marker = b.isRolled
        ? `<i class="fas fa-caret-right sim-dist-marker" title="${game.i18n.localize("WFRP4E_SIM.ApplyResults.RolledOutcome")}"></i>`
        : `<span class="sim-dist-marker-spacer"></span>`;
      return `
        <div class="${classes}">
          ${marker}
          <div class="sim-dist-label">${foundry.utils.escapeHTML(b.label)}</div>
          <div class="sim-dist-bar-wrap">
            <div class="sim-dist-bar" style="width: ${barWidth}%"></div>
          </div>
          <div class="sim-dist-stats">${b.count} · ${pct}%</div>
        </div>`;
    }).join("");

    const otherLine = p.woundOtherCount > 0
      ? `<div class="sim-dist-other">${game.i18n.format("WFRP4E_SIM.ApplyResults.OtherValues", { count: p.woundOtherCount })}</div>`
      : "";

    return `
      <div class="sim-dist-header">
        <span class="sim-dist-title">${game.i18n.localize("WFRP4E_SIM.ApplyResults.WoundDistribution")}</span>
        <span class="sim-apply-meta">(${p.woundTotalSamples} iterations)</span>
      </div>
      <div class="sim-dist-list">${bars}</div>
      ${otherLine}`;
  }

  /**
   * Crit distribution section (unchanged semantics from v0.1.11) - the
   * rolled bucket gets highlighted; buckets with no source UUID show an
   * amber warning.
   */
  static _renderCritDistribution(p) {
    const dist = p.critDistribution ?? [];
    const critBuckets = dist.filter(b => !b.isNoCrit);

    if (critBuckets.length === 0) {
      return `
        <div class="sim-apply-nocrits-ever">
          <i class="fas fa-shield-alt"></i>
          ${game.i18n.localize("WFRP4E_SIM.ApplyResults.NoCritsEver")}
        </div>`;
    }

    const bars = dist.map(b => {
      const pct = b.percent.toFixed(1);
      const barWidth = Math.max(0.5, b.percent);
      const classes = [
        "sim-dist-row",
        b.isRolled ? "sim-dist-rolled" : "",
        b.isNoCrit ? "sim-dist-nocrit" : "",
        !b.isApplicable ? "sim-dist-unapplicable" : ""
      ].filter(Boolean).join(" ");
      const marker = b.isRolled
        ? `<i class="fas fa-caret-right sim-dist-marker" title="${game.i18n.localize("WFRP4E_SIM.ApplyResults.RolledOutcome")}"></i>`
        : `<span class="sim-dist-marker-spacer"></span>`;
      const unapplicableFlag = (!b.isApplicable && !b.isNoCrit)
        ? ` <i class="fas fa-exclamation-triangle sim-dist-warning" title="${game.i18n.localize("WFRP4E_SIM.ApplyResults.NoSourceItem")}"></i>`
        : "";
      return `
        <div class="${classes}">
          ${marker}
          <div class="sim-dist-label">${foundry.utils.escapeHTML(b.label)}${unapplicableFlag}</div>
          <div class="sim-dist-bar-wrap">
            <div class="sim-dist-bar" style="width: ${barWidth}%"></div>
          </div>
          <div class="sim-dist-stats">${b.count} · ${pct}%</div>
        </div>`;
    }).join("");

    const rolled = dist.find(b => b.isRolled);
    let rolledSummary = "";
    if (rolled) {
      if (rolled.isNoCrit) {
        rolledSummary = `<i class="fas fa-check"></i> ${game.i18n.localize("WFRP4E_SIM.ApplyResults.RolledNoCrit")}`;
      } else if (!rolled.isApplicable) {
        rolledSummary = `<i class="fas fa-exclamation-triangle"></i> ${game.i18n.localize("WFRP4E_SIM.ApplyResults.Rolled")}: <strong>${foundry.utils.escapeHTML(rolled.label)}</strong> <span class="sim-apply-meta">${game.i18n.localize("WFRP4E_SIM.ApplyResults.NoSourceWarn")}</span>`;
      } else {
        rolledSummary = `<i class="fas fa-skull"></i> ${game.i18n.localize("WFRP4E_SIM.ApplyResults.Rolled")}: <strong>${foundry.utils.escapeHTML(rolled.label)}</strong>`;
      }
    }

    return `
      <div class="sim-dist-header">
        <span class="sim-dist-title">${game.i18n.localize("WFRP4E_SIM.ApplyResults.CritDistribution")}</span>
        <span class="sim-apply-meta">(avg ${p.avgCrits.toFixed(2)}/iter, ${p.totalWeight} samples)</span>
      </div>
      <div class="sim-dist-list">${bars}</div>
      <div class="sim-dist-rolled-summary">${rolledSummary}</div>`;
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
