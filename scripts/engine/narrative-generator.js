/**
 * Narrative Generator
 *
 * Produces a two-part post-sim narrative:
 *  1. Clinical summary - deterministic, extracted from results. Always
 *     available and shown even if the AI call fails or is unconfigured.
 *  2. Evocative flavor paragraph - Claude API call over the briefing,
 *     weaves prose around the clinical numbers. Requires an Anthropic
 *     API key in module settings.
 *
 * Separation of concerns: _extractBriefing never calls the API and is the
 * single source of truth for "what did this sim actually say". _generateFlavor
 * is the side-effectful AI enrichment; failure there falls back silently.
 */

const MODULE_ID = "wfrp4e-combat-simulator";

export class NarrativeGenerator {
  constructor(results) {
    this.results = results;
  }

  /**
   * Build the clinical briefing. Pure function over results - no network,
   * no randomness, no side effects. This IS the clinical summary shown in
   * the UI; it's also the grounding context for the AI flavor call.
   *
   * Returns a structured object of statistical facts suitable for display
   * or for passing to an LLM as grounding context.
   */
  extractBriefing() {
    const r = this.results;
    const sides = Object.values(r.sides);

    // Side rollup: win rate, top damage dealer, biggest victim.
    const sideSummaries = sides.map(side => {
      const combatants = Object.values(r.perCombatant)
        .filter(c => c.sideId === side.id);

      const sorted = (key) => [...combatants].sort((a, b) =>
        (b[key]?.mean ?? 0) - (a[key]?.mean ?? 0)
      );

      const topDealer = sorted("woundsInflicted")[0];
      const topVictim = sorted("woundsReceived")[0];
      const topDier = [...combatants].sort((a, b) =>
        (b.deathRate ?? 0) - (a.deathRate ?? 0)
      )[0];

      return {
        id: side.id,
        name: side.name,
        winRate: side.winRate,
        wins: side.wins,
        combatantCount: combatants.length,
        topDealer: topDealer ? {
          name: topDealer.name,
          avgWounds: topDealer.woundsInflicted?.mean ?? 0,
          avgCrits: topDealer.criticalsInflicted?.mean ?? 0
        } : null,
        topVictim: topVictim ? {
          name: topVictim.name,
          avgWounds: topVictim.woundsReceived?.mean ?? 0,
          avgCrits: topVictim.criticalsReceived?.mean ?? 0,
          deathRate: topVictim.deathRate ?? 0
        } : null,
        mostLikelyToFall: topDier && topDier.deathRate > 0 ? {
          name: topDier.name,
          deathRate: topDier.deathRate
        } : null
      };
    });

    // Overall combat signature.
    const allCombatants = Object.values(r.perCombatant);
    const totalAvgCrits = allCombatants.reduce(
      (s, c) => s + (c.criticalsInflicted?.mean ?? 0), 0
    );
    const totalAvgMiscasts = allCombatants.reduce(
      (s, c) => s + (c.miscasts?.mean ?? 0), 0
    );

    // Decisiveness: how lopsided was the outcome?
    const sortedByWinRate = [...sideSummaries].sort((a, b) => b.winRate - a.winRate);
    const winRateGap = sortedByWinRate.length >= 2
      ? sortedByWinRate[0].winRate - sortedByWinRate[1].winRate
      : 1;
    const decisiveness =
      winRateGap >= 0.75 ? "overwhelming" :
      winRateGap >= 0.50 ? "decisive" :
      winRateGap >= 0.20 ? "clear" :
      winRateGap >= 0.10 ? "marginal" :
      "a toss-up";

    // Average fight length categorization.
    const rounds = r.avgRounds ?? 0;
    const paceLabel =
      rounds <= 3 ? "brief" :
      rounds <= 6 ? "standard" :
      rounds <= 10 ? "drawn-out" :
      "protracted";

    return {
      iterations: r.iterations,
      avgRounds: rounds,
      paceLabel,
      drawRate: r.drawRate ?? 0,
      predictedWinner: r.predictedWinner,
      decisiveness,
      winRateGap,
      sides: sideSummaries,
      signature: {
        critsPerIteration: totalAvgCrits,
        miscastsPerIteration: totalAvgMiscasts,
        critsSignificant: totalAvgCrits >= 0.5,
        miscastsPresent: totalAvgMiscasts > 0.05
      }
    };
  }

  /**
   * Render the clinical summary as plain HTML prose. Deterministic;
   * doesn't touch the network. This is the "clinical" half of the
   * mixed-tone display.
   */
  renderClinicalSummary(briefing) {
    const b = briefing;
    const winner = b.predictedWinner;
    const pct = (x) => Math.round((x ?? 0) * 100);

    // Opening sentence.
    let parts = [];
    if (winner) {
      parts.push(
        `Across ${b.iterations} iterations, ` +
        `<strong>${escapeHTML(winner.name)}</strong> won ${pct(winner.winRate)}% of engagements` +
        `${b.winRateGap > 0 ? ` &mdash; a ${b.decisiveness} result` : ""}.`
      );
    } else {
      parts.push(`Across ${b.iterations} iterations, no side held a consistent advantage.`);
    }

    // Pacing.
    parts.push(
      `The fight typically resolved in ${b.avgRounds.toFixed(1)} rounds (${b.paceLabel}).` +
      (b.drawRate > 0.05 ? ` Draws occurred in ${pct(b.drawRate)}% of runs.` : "")
    );

    // Per-side headliners.
    const sideLines = b.sides.map(side => {
      const bits = [];
      if (side.topDealer) {
        bits.push(
          `<strong>${escapeHTML(side.topDealer.name)}</strong> dealt the most damage (` +
          `${side.topDealer.avgWounds.toFixed(1)} wounds/iter)`
        );
      }
      if (side.mostLikelyToFall) {
        bits.push(
          `<strong>${escapeHTML(side.mostLikelyToFall.name)}</strong> fell in ` +
          `${pct(side.mostLikelyToFall.deathRate)}% of runs`
        );
      }
      if (!bits.length) return null;
      return `<em>${escapeHTML(side.name)}:</em> ${bits.join("; ")}.`;
    }).filter(Boolean);

    // Combat signature flags.
    const sigFlags = [];
    if (b.signature.critsSignificant) {
      sigFlags.push(`critical wounds were common (avg ${b.signature.critsPerIteration.toFixed(2)}/iter)`);
    }
    if (b.signature.miscastsPresent) {
      sigFlags.push(`miscasts occurred (avg ${b.signature.miscastsPerIteration.toFixed(2)}/iter)`);
    }
    if (sigFlags.length) {
      parts.push(`Of note: ${sigFlags.join("; ")}.`);
    }

    const main = `<p>${parts.join(" ")}</p>`;
    const sides = sideLines.length
      ? `<ul class="sim-narrative-sides">${sideLines.map(l => `<li>${l}</li>`).join("")}</ul>`
      : "";
    return main + sides;
  }

  /**
   * Call the Anthropic API to produce an evocative flavor paragraph.
   * Returns { text } on success, { error } on any failure. Never throws.
   *
   * The briefing is passed as grounding context; the prompt is constrained
   * to prevent Claude from inventing combatants or numbers not in the data.
   */
  async generateFlavor(briefing, { apiKey, model }) {
    if (!apiKey) {
      return { error: "no-api-key" };
    }

    const userPrompt = this._buildUserPrompt(briefing);
    const systemPrompt = this._buildSystemPrompt();

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: model || "claude-sonnet-4-5",
          max_tokens: 400,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }]
        })
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        return {
          error: `api-${response.status}`,
          detail: errText.slice(0, 200)
        };
      }

      const data = await response.json();
      // Messages API returns {content: [{type:"text", text:"..."}]}
      const textBlocks = (data.content ?? [])
        .filter(b => b.type === "text")
        .map(b => b.text);
      const text = textBlocks.join("\n").trim();
      if (!text) return { error: "empty-response" };
      return { text };
    } catch (err) {
      return { error: "network", detail: err?.message ?? String(err) };
    }
  }

  _buildSystemPrompt() {
    return (
      "You are a Warhammer Fantasy Roleplay 4th Edition GM writing a flavor paragraph to set the mood for a combat encounter. " +
      "You will be given a statistical briefing of a Monte Carlo simulation of the fight. " +
      "Write a single paragraph of 2 to 4 sentences in an evocative GM voice, grounded in the specific numbers and names provided. " +
      "Rules:\n" +
      "- Reference only combatants, sides, wound counts, death rates, and fight pacing that appear in the briefing.\n" +
      "- Do NOT invent new named combatants, crit descriptions, or numbers.\n" +
      "- Do NOT use em-dashes; prefer commas or periods.\n" +
      "- Do NOT begin with filler like 'In this fight' or 'The simulation shows'.\n" +
      "- Prefer specific, physical imagery over generic adventure-book prose.\n" +
      "- The tone should match the gritty low-magic feel of WFRP4e (the Old World, not high fantasy).\n" +
      "- Return ONLY the paragraph itself. No headers, no prefaces, no post-script."
    );
  }

  _buildUserPrompt(briefing) {
    // Pass the briefing as structured JSON inside a fenced block, plus
    // a small hand-written gloss so Claude doesn't have to re-derive
    // the key callouts.
    const callouts = [];
    if (briefing.predictedWinner) {
      callouts.push(
        `Predicted winner: ${briefing.predictedWinner.name} ` +
        `(${Math.round(briefing.predictedWinner.winRate * 100)}% win rate).`
      );
    }
    callouts.push(`Decisiveness: ${briefing.decisiveness}.`);
    callouts.push(`Combat pace: ${briefing.paceLabel} (${briefing.avgRounds.toFixed(1)} rounds average).`);

    for (const side of briefing.sides) {
      if (side.topDealer) {
        callouts.push(
          `On ${side.name}, the heaviest hitter was ${side.topDealer.name} ` +
          `(${side.topDealer.avgWounds.toFixed(1)} wounds dealt per iteration).`
        );
      }
      if (side.mostLikelyToFall && side.mostLikelyToFall.deathRate > 0.1) {
        callouts.push(
          `On ${side.name}, ${side.mostLikelyToFall.name} fell in ` +
          `${Math.round(side.mostLikelyToFall.deathRate * 100)}% of iterations.`
        );
      }
    }

    if (briefing.signature.critsSignificant) {
      callouts.push("Critical wounds were a significant factor.");
    }
    if (briefing.signature.miscastsPresent) {
      callouts.push("Spellcasting carried miscast risk.");
    }

    return (
      "Write the flavor paragraph for this combat.\n\n" +
      "Key callouts:\n" +
      callouts.map(c => `- ${c}`).join("\n") +
      "\n\nFull briefing JSON (for reference; do not cite raw JSON in your prose):\n" +
      "```json\n" +
      JSON.stringify(briefing, null, 2) +
      "\n```"
    );
  }
}

/**
 * Minimal HTML escape for narrative rendering. Match the style used elsewhere
 * in the module (foundry.utils.escapeHTML isn't reliably available in every
 * Foundry context, so we do it locally).
 */
function escapeHTML(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
