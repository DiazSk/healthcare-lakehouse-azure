/* Panel renderers for the dashboard. Each render* takes a plain view object
   shaped like the contract in index.html's viewFromPayload() -- never the
   global payload -- so a later task can plug in live SQL results unchanged. */
(function (root) {
  "use strict";

  const { money, count, pct, inkOn, quantile } = root.MD.format;
  const { tokens, axisOpts, legendOpts, tooltipOpts, mount } = root.MD.charts;
  const { reliability, opacityFor } = root.MD.guardrails;
  const diverging = (t) => root.MD.format.diverging(t, tokens().div);
  const T = () => tokens();
  // diverging() returns "rgb(r,g,b)"; the guardrail opacity rides on top of it so
  // a thin cohort's bar is visibly weaker than a reliable one's.
  const withAlpha = (c, a) =>
    a >= 1 ? c : c.replace("rgb(", "rgba(").replace(")", `, ${a})`);

  /* ── tile-grid US map layout (row, col) — 50 states + DC ─────────────────── */
  const TILES = {
    AK:[1,1], ME:[1,11],
    VT:[2,10], NH:[2,11],
    WA:[3,1], ID:[3,2], MT:[3,3], ND:[3,4], MN:[3,5], WI:[3,6], MI:[3,7], NY:[3,9], MA:[3,10], RI:[3,11],
    OR:[4,1], NV:[4,2], WY:[4,3], SD:[4,4], IA:[4,5], IL:[4,6], IN:[4,7], OH:[4,8], PA:[4,9], NJ:[4,10], CT:[4,11],
    CA:[5,1], UT:[5,2], CO:[5,3], NE:[5,4], MO:[5,5], KY:[5,6], WV:[5,7], VA:[5,8], MD:[5,9], DE:[5,10],
    AZ:[6,2], NM:[6,3], KS:[6,4], AR:[6,5], TN:[6,6], NC:[6,7], SC:[6,8], DC:[6,9],
    OK:[7,4], LA:[7,5], MS:[7,6], AL:[7,7], GA:[7,8],
    HI:[8,1], TX:[8,4], FL:[8,9],
  };

  /* ── HERO 1 ─────────────────────────────────────────────────────────────── */
  function geoByState(geoRows, filters) {
    const acc = {};
    for (const r of geoRows) {
      if (filters.ruca !== "all" && r.ruca !== filters.ruca) continue;
      const a = acc[r.state] || (acc[r.state] = { premium: 0, pymt: 0, benes: 0 });
      a.premium += r.premium || 0;
      a.pymt += r.pymt || 0;
      a.benes += r.benes || 0;
    }
    return Object.entries(acc).map(([state, a]) => ({
      state, ...a, perBene: a.benes > 0 ? a.premium / a.benes : null,
    }));
  }


  function renderHero1(view, filters) {
    const rows = geoByState(view.geo, filters);
    // Scale only over states the map actually DRAWS. Territories like MP and FM are
    // in the data but not on the tile grid, and letting them set the bound
    // compressed every drawn state toward the neutral midpoint.
    const drawn = rows.filter(r => TILES[r.state] && r.perBene !== null);
    const absSorted = drawn.map(r => Math.abs(r.perBene)).sort((a, b) => a - b);
    // p95 rather than max: Alaska's geographic adjustment is a genuine outlier at
    // roughly twice the next state, so anchoring on it flattens the other fifty.
    // diverging() clamps, and the legend states the true range, so nothing is hidden.
    const bound = quantile(absSorted, 0.95) || 1;
    const lo = Math.min(...drawn.map(r => r.perBene));
    const hi = Math.max(...drawn.map(r => r.perBene));

    // tile map
    const byState = Object.fromEntries(rows.map(r => [r.state, r]));
    const map = document.getElementById("tilemap");
    map.innerHTML = "";
    for (const [st, [row, col]] of Object.entries(TILES)) {
      const r = byState[st];
      const d = document.createElement("div");
      d.className = "tile";
      d.style.gridRow = row; d.style.gridColumn = col;
      d.textContent = st;
      if (r && r.perBene !== null) {
        const bg = diverging(r.perBene / bound);
        d.style.background = bg;
        d.style.color = inkOn(bg);
        d.title = `${st} — geographic premium ${money(r.premium)} total, `
          + `${money(r.perBene, 2)} per beneficiary-proxy`;
      } else {
        d.style.background = "var(--plane)";
        d.style.color = "var(--ink-muted)";
        d.title = `${st} — no data for this filter`;
      }
      if (filters.state !== "all") d.classList.add(st === filters.state ? "sel" : "dim");
      map.appendChild(d);
    }
    document.getElementById("ramp").innerHTML =
      Array.from({ length: 21 }, (_, i) =>
        `<span style="background:${diverging(-1 + i / 10)}"></span>`).join("");
    document.getElementById("rampScale").textContent = hero1Ramp(drawn, bound, lo, hi);

    // tornado: extremes at both ends, by total premium
    const sorted = rows.slice().sort((a, b) => b.premium - a.premium);
    const top = sorted.slice(0, 10), bot = sorted.slice(-10).reverse();
    const pick = top.concat(bot).filter((v, i, a) =>
      a.findIndex(x => x.state === v.state) === i);
    pick.sort((a, b) => a.premium - b.premium);

    mount("cGeo", {
      type: "bar",
      data: {
        labels: pick.map(r => r.state),
        datasets: [{
          label: "Geographic premium",
          data: pick.map(r => r.premium),
          // Color encodes the sign, which is the point; it is not a series identity.
          backgroundColor: pick.map(r => diverging(r.premium >= 0 ? 0.75 : -0.75)),
          borderWidth: 0, borderRadius: 2,
        }],
      },
      options: {
        indexAxis: "y",
        plugins: {
          legend: legendOpts(false),
          title: { display: true, color: T().ink1, font: { size: 13, weight: "600" },
                   text: "Largest net senders and receivers", align: "start",
                   padding: { bottom: 10 } },
          tooltip: tooltipOpts({
            label: c => ` ${money(c.raw)} geographic premium`,
            afterLabel: c => {
              const r = pick[c.dataIndex];
              return `${money(r.pymt)} total Medicare paid`;
            },
          }),
        },
        scales: {
          x: axisOpts("Geographic premium (paid − standardized)", v => money(v, 0)),
          y: axisOpts(null, null, { grid: { display: false } }),
        },
      },
    });

    document.getElementById("h1read").textContent = hero1Read(sorted);
  }

  /* Every readout below is a pure function of the view so it can be tested at
     cohort counts the national payload never produces. Static mode always hands
     these panels the full national arrays, so only live mode reaches the 1- and
     0-cohort branches — but the branches are chosen from the data, not from the
     mode, because "which mode am I in" is not something a renderer should know.

     The templates were written against the static payload, where nonpar_stats
     and the kpi block are national regardless of filter. Live mode recomputes
     them per filter, which is more correct and which drove the originals into
     sentences they were never written for: hero 1 naming one state as both
     extremes with a $0.00 spread between them. */
  const POLICY = "Geographic adjustment is deliberate Medicare policy (wages and "
    + "rent differ); the magnitude is what is worth seeing.";

  function hero1Read(sorted) {
    if (!sorted.length) {
      return "No state matches this filter, so there is no geographic premium to read.";
    }
    if (sorted.length === 1) {
      // A spread needs two cohorts. Naming the same state as both extremes and
      // reporting $0.00 between them reads as a broken calculation.
      const one = sorted[0];
      return `Reading it: this filter selects a single cohort. ${one.state} bills `
        + `${money(Math.abs(one.premium))} ${one.premium >= 0 ? "more" : "less"} than the `
        + `geographically standardized amount for the same work`
        + `${Number.isFinite(one.perBene)
            ? ` — ${money(one.perBene, 2)} per beneficiary-proxy` : ""}. `
        + `Comparing states needs more than one selected, so there is no spread to rank. `
        + POLICY;
    }
    const mx = sorted[0], mn = sorted[sorted.length - 1];
    return `Reading it: ${mx.state} bills ${money(mx.premium)} more than the geographically `
      + `standardized amount for the same work, while ${mn.state} bills `
      + `${money(Math.abs(mn.premium))} less — a spread of `
      + `${money(mx.premium - mn.premium)} attributable to location, not medicine. `
      + POLICY;
  }

  function hero1Ramp(drawn, bound, lo, hi) {
    // lo/hi come from Math.min/max over `drawn`; at zero rows they are ±Infinity,
    // which money() renders as an em dash rather than "$Infinity".
    if (!drawn.length) return "no mapped state matches this filter";
    if (drawn.length === 1) {
      return `single cohort · ${money(lo, 2)} per beneficiary-proxy`;
    }
    return `scale ±${money(bound, 2)} per beneficiary-proxy · actual range `
      + `${money(lo, 2)} to ${money(hi, 2)} (beyond the scale is clamped)`;
  }

  /* ── HERO 2 ─────────────────────────────────────────────────────────────── */
  function renderHero2(view, filters) {
    const st = view.nonparStats;
    const hi = filters.spec === "all" ? null : filters.spec;
    // Specialties with a real non-par cohort, PLUS whichever one the filter
    // selected. Warn, never hide: filtering to Orthopedic Surgery must show its
    // +2,223% wearing a thin-sample badge, not silently drop the panel's only row.
    // The unselected exclusions are named in the caveat line under the chart.
    const ok = view.nonpar.filter(d => d.measurable || d.specialty === hi)
      .sort((a, b) => a.premium_pct - b.premium_pct);
    const forced = !!hi && view.nonpar.some(d => d.specialty === hi && !d.measurable);

    mount("cNonPar", {
      type: "bar",
      data: {
        labels: ok.map(d => d.specialty),
        datasets: [{
          label: "Patient exposure vs. participating peers",
          data: ok.map(d => d.premium_pct),
          backgroundColor: ok.map(d => hi && d.specialty !== hi
            ? T().grid
            : withAlpha(diverging(d.premium_pct > 0 ? 0.75 : -0.75),
                        opacityFor(reliability(Number(d.n_n))))),
          borderWidth: 0, borderRadius: 2,
        }],
      },
      options: {
        indexAxis: "y",
        plugins: {
          legend: legendOpts(false),
          title: { display: true, color: T().ink1, font: { size: 13, weight: "600" },
                   text: `Specialties with at least ${st.min_nonpar_providers} `
                     + `non-participating providers`
                     + (forced ? ` · plus ${hi}, faded as a thin sample` : ""),
                   align: "start", padding: { bottom: 10 } },
          tooltip: tooltipOpts({
            label: c => ` ${pct(c.raw)} ${c.raw < 0 ? "lower" : "higher"} patient exposure`,
            afterLabel: c => {
              const d = ok[c.dataIndex];
              return [`Participating: ${money(d.exp_y)} per beneficiary (${count(d.n_y)} providers)`,
                      `Non-participating: ${money(d.exp_n)} per beneficiary (${count(d.n_n)} providers)`];
            },
          }),
        },
        scales: {
          x: axisOpts("Non-participating exposure vs. participating", v => pct(v, 0)),
          y: axisOpts(null, null, { grid: { display: false },
               ticks: { color: T().muted, font: { size: 10.5 } } }),
        },
      },
    });

    // The denominators ARE the story, so they get their own chart rather than a
    // second axis. Log scale: the two cohorts differ by three orders of magnitude.
    const cohort = view.nonpar.slice()
      .sort((a, b) => (b.n_n || 0) - (a.n_n || 0)).slice(0, 12);
    mount("cNonParAbs", {
      type: "bar",
      data: {
        labels: cohort.map(d => d.specialty),
        datasets: [
          { label: "Participating providers", data: cohort.map(d => d.n_y),
            backgroundColor: T().s1, borderWidth: 0, borderRadius: 2 },
          { label: "Non-participating providers", data: cohort.map(d => d.n_n),
            backgroundColor: T().s2, borderWidth: 0, borderRadius: 2 },
        ],
      },
      options: {
        indexAxis: "y",
        plugins: {
          legend: legendOpts(true),
          title: { display: true, color: T().ink1, font: { size: 13, weight: "600" },
                   text: "Why the ratios are fragile: cohort sizes (log scale)",
                   align: "start", padding: { bottom: 10 } },
          tooltip: tooltipOpts({ label: c => ` ${c.dataset.label}: ${count(c.raw)}` }),
        },
        scales: {
          x: axisOpts("Distinct providers", v => count(v),
                      { type: "logarithmic", min: 1 }),
          y: axisOpts(null, null, { grid: { display: false },
               ticks: { color: T().muted, font: { size: 10.5 } } }),
        },
      },
    });

    document.getElementById("h2read").textContent = hero2Read(view);
    document.getElementById("h2caveat").textContent = hero2Caveat(view);
  }

  function hero2Read(view) {
    const st = view.nonparStats, k = view.kpi;
    // The national participation scalars are true at every filter, so they open
    // the sentence in all three branches.
    const national = `only ${count(k.nonpar_providers)} of ${count(k.n_providers)} providers `
      + `(${pct(k.nonpar_pct, 3)}) are non-participating`;
    if (!st.specialties_compared) {
      return `Reading it: ${national}. No specialty in this filter has providers on both `
        + `sides of that line, so there is nothing to compare here.`;
    }
    if (st.specialties_compared === 1) {
      // A distribution across a population of one is not a distribution, and the
      // national sentence explained a phenomenon with zero instances ("0 show
      // non-participating providers leaving patients with LESS exposure").
      const d = view.nonpar[0];
      const dir = d.premium_pct >= 0 ? "MORE" : "LESS";
      return `Reading it: ${national}. In ${d.specialty}, non-participating providers leave `
        + `patients with ${pct(Math.abs(d.premium_pct))} ${dir} exposure per beneficiary than `
        + `their participating peers — ${money(d.exp_n)} against ${money(d.exp_y)} — on `
        + `${count(d.n_n)} non-participating providers measured against ${count(d.n_y)} `
        + `participating ones.`;
    }
    return `Reading it: ${national}. Of ${st.specialties_compared} `
      + `specialties where both groups appear, ${st.negative} show non-participating providers `
      + `leaving patients with LESS exposure, not more — the opposite of the expected direction. `
      + `The likeliest explanation is case mix rather than generosity: the tiny non-par cohorts `
      + `bill a different, cheaper mix of procedures.`;
  }

  function hero2Caveat(view) {
    const st = view.nonparStats;
    if (!st.specialties_compared) return "";
    if (st.specialties_compared === 1) {
      const d = view.nonpar[0];
      if (d.measurable) {
        return `Why it is not badged: ${count(d.n_n)} non-participating providers is at or above `
          + `the ${count(st.min_nonpar_providers)} this dashboard treats as a stable denominator, `
          + `so the ratio is read as a measurement rather than an artifact.`;
      }
      // This is the canonical guardrail case (Orthopedic Surgery, n=11). The
      // number stays on screen, faded and badged -- suppressing it would hide the
      // very artifact this panel exists to name.
      return `Why it is badged: ${count(d.n_n)} non-participating providers is too small a `
        + `denominator for a stable ratio — a handful of unusual bills moves it by hundreds of `
        + `percent, which is why ${count(st.min_nonpar_providers)} is the floor for treating one `
        + `as a finding. It is shown faded and labelled rather than hidden, because the `
        + `denominator artifact is itself the point.`;
    }
    return `Why the threshold: all ${st.positive} specialties showing a positive premium rest on `
      + `11 or fewer non-participating providers. Orthopedic Surgery's apparent +2,223% is `
      + `11 providers measured against 20,699 — a denominator artifact, not a finding, which `
      + `is why only the ${st.measurable} specialties with at least `
      + `${st.min_nonpar_providers} non-par providers are charted.`;
  }

  /* ── HERO 3 ─────────────────────────────────────────────────────────────── */
  function renderHero3(view) {
    const pts = view.lorenz.map(p => ({ x: p.x, y: p.y }));
    mount("cLorenz", {
      type: "scatter",
      data: {
        datasets: [
          { label: "Actual distribution", data: pts, showLine: true, borderColor: T().s1,
            backgroundColor: T().s1, borderWidth: 2.2, pointRadius: 0, fill: false,
            tension: 0 },
          { label: "Perfect equality", data: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            showLine: true, borderColor: T().muted, borderWidth: 1.4,
            borderDash: [5, 4], pointRadius: 0, fill: false },
        ],
      },
      options: {
        plugins: {
          legend: legendOpts(true),
          title: { display: true, color: T().ink1, font: { size: 13, weight: "600" },
                   text: `Lorenz curve — Gini ${view.kpi.gini}`,
                   align: "start", padding: { bottom: 10 } },
          tooltip: tooltipOpts({
            label: c => ` ${pct(c.parsed.x)} of prescribers → ${pct(c.parsed.y)} of drug spend`,
          }),
        },
        scales: {
          x: axisOpts("Share of drug-billing providers, poorest to richest", v => pct(v, 0),
                      { min: 0, max: 1 }),
          y: axisOpts("Cumulative share of drug spend", v => pct(v, 0), { min: 0, max: 1 }),
        },
      },
    });

    const j = view.jcodeTop.slice(0, 15).slice().reverse();
    mount("cJcode", {
      type: "bar",
      data: {
        labels: j.map(d => d.hcpcs),
        datasets: [{ label: "National Medicare payment", data: j.map(d => d.pymt),
                     backgroundColor: T().s3, borderWidth: 0, borderRadius: 2 }],
      },
      options: {
        indexAxis: "y",
        plugins: {
          legend: legendOpts(false),
          title: { display: true, color: T().ink1, font: { size: 13, weight: "600" },
                   text: "Largest drug codes by Medicare payment",
                   align: "start", padding: { bottom: 10 } },
          tooltip: tooltipOpts({
            title: c => j[c[0].dataIndex].hcpcs,
            label: c => ` ${money(c.raw)}`,
            afterLabel: c => {
              const d = j[c.dataIndex];
              return [d.desc, `${count(d.providers)} providers`];
            },
          }),
        },
        scales: {
          x: axisOpts("Medicare payment", v => money(v, 0)),
          y: axisOpts(null, null, { grid: { display: false } }),
        },
      },
    });

    document.getElementById("h3read").textContent = hero3Read(view);
  }

  function hero3Read(view) {
    const k = view.kpi;
    if (!k.n_drug_providers) {
      return "No provider in this filter billed a drug code, so there is no concentration "
        + "to measure.";
    }
    const bits = [];
    if (Number.isFinite(k.lorenz_top1))
      bits.push(`the top 1% of prescribers account for ${pct(k.lorenz_top1)} of it`);
    if (Number.isFinite(k.lorenz_top10))
      bits.push(`the top 10% for ${pct(k.lorenz_top10)}`);
    // A cohort of one has no distribution, so the SQL returns no Gini for it.
    if (!Number.isFinite(k.gini)) {
      return `Reading it: ${count(k.n_drug_providers)} provider${k.n_drug_providers === 1
        ? "" : "s"} in this filter billed a drug code — too few for a concentration measure, `
        + `so no Gini is reported.`;
    }
    // "Extreme" is a claim about the number, and a narrower cohort can be far
    // more even than the national 0.906. Let the number pick its own adjective.
    const verdict = k.gini >= 0.8 ? "extreme concentration"
      : k.gini >= 0.5 ? "substantial concentration"
        : "a relatively even distribution";
    return `Reading it: across ${count(k.n_drug_providers)} providers who billed at least one `
      + `drug code, ${bits.join(", and ")}${bits.length ? ". " : ""}A Gini of ${k.gini} is `
      + `${verdict} — for scale, US household income sits near 0.49. Much of this is `
      + `structural: infusion-heavy specialties buy and bill expensive biologics, so a few `
      + `practices carry enormous drug volume legitimately.`;
  }

  /* ── HERO 4 ─────────────────────────────────────────────────────────────── */
  const TIER_LABELS = { md: "Physician (MD/DO)", np: "Nurse Practitioner",
                        pa: "Physician Assistant", spec: "Specialist" };
  function renderHero4(view) {
    const tiers = view.credentialTiers.filter(t => TIER_LABELS[t]);
    const rows = view.credentials.filter(d => d.shared)
      .filter(d => tiers.some(t => d[t] !== null && d[t] !== undefined))
      .sort((a, b) => a.hcpcs.localeCompare(b.hcpcs));
    const colors = { md: T().s1, np: T().s2, pa: T().s3, spec: T().s4 };

    mount("cCred", {
      type: "bar",
      data: {
        labels: rows.map(d => d.hcpcs),
        datasets: tiers.map(t => ({
          label: TIER_LABELS[t], data: rows.map(d => d[t]),
          backgroundColor: colors[t], borderWidth: 0, borderRadius: 2,
        })),
      },
      options: {
        plugins: {
          legend: legendOpts(true),
          title: { display: true, color: T().ink1, font: { size: 13, weight: "600" },
                   text: "Markup ratio on shared evaluation & management codes",
                   align: "start", padding: { bottom: 10 } },
          tooltip: tooltipOpts({
            title: c => {
              const d = rows[c[0].dataIndex];
              return `${d.hcpcs} — ${d.desc}`;
            },
            label: c => ` ${c.dataset.label}: ${c.raw === null ? "no data"
              : c.raw.toFixed(2) + "x allowed amount"}`,
          }),
        },
        scales: {
          x: axisOpts("HCPCS code", null, { grid: { display: false } }),
          y: axisOpts("Submitted charge ÷ Medicare allowed", v => v.toFixed(1) + "x",
                      { beginAtZero: true }),
        },
      },
    });

    const th = ["Code", "Description"].concat(tiers.map(t => TIER_LABELS[t]));
    document.getElementById("tCred").innerHTML =
      `<thead><tr>${th.map((h, i) =>
        `<th class="${i < 2 ? "l" : ""}" style="cursor:default">${h}</th>`).join("")}</tr></thead>`
      + `<tbody>${rows.map(d => `<tr><td class="l">${d.hcpcs}</td>`
        + `<td class="l">${d.desc.slice(0, 58)}</td>`
        + tiers.map(t => `<td>${d[t] === null || d[t] === undefined
          ? "—" : d[t].toFixed(2) + "x"}</td>`).join("") + `</tr>`).join("")}</tbody>`;

    // Rank tiers by their mean markup across the shared codes, rather than assuming
    // a direction. The data runs opposite to the intuition that physicians bill
    // highest: PAs and NPs submit the larger multiples on identical codes.
    const means = tiers.map(t => {
      const vals = rows.map(d => d[t]).filter(v => v !== null && v !== undefined);
      return { t, mean: vals.reduce((a, b) => a + b, 0) / (vals.length || 1), n: vals.length };
    }).filter(m => m.n).sort((a, b) => b.mean - a.mean);

    // Widest spread on a single code, whichever tiers form it.
    let widest = null;
    for (const d of rows) {
      const vals = tiers.map(t => ({ t, v: d[t] })).filter(x => x.v !== null && x.v !== undefined);
      if (vals.length < 2) continue;
      vals.sort((a, b) => b.v - a.v);
      const spread = vals[0].v - vals[vals.length - 1].v;
      if (!widest || spread > widest.spread)
        widest = { spread, d, hi: vals[0], lo: vals[vals.length - 1] };
    }

    document.getElementById("h4read").textContent = (means.length >= 2 && widest)
      ? `Reading it: the order runs opposite to the intuition that physicians bill the most. `
        + `Averaged across these six codes, ${TIER_LABELS[means[0].t]} submit the highest `
        + `multiple of the allowed amount (${means[0].mean.toFixed(2)}x) and `
        + `${TIER_LABELS[means[means.length - 1].t]} the lowest `
        + `(${means[means.length - 1].mean.toFixed(2)}x), with `
        + `${TIER_LABELS[means.find(m => m.t === "md") ? "md" : means[1].t]} at `
        + `${(means.find(m => m.t === "md") || means[1]).mean.toFixed(2)}x. The widest single-code `
        + `spread is ${widest.d.hcpcs}, where ${TIER_LABELS[widest.hi.t]} submit `
        + `${widest.hi.v.toFixed(2)}x against ${TIER_LABELS[widest.lo.t]} at `
        + `${widest.lo.v.toFixed(2)}x — ${widest.spread.toFixed(2)}x apart for identical work. `
        + `Medicare's allowed amount barely moves between tiers, so the gap is in what gets `
        + `asked for, not what gets paid. Credentials are parsed from a free-text CMS field, so `
        + `tier assignment is approximate.`
      : "Not enough overlapping tier coverage on the shared codes to compare.";
  }

  /* ── HERO 5 ─────────────────────────────────────────────────────────────── */
  function renderHero5(view) {
    const rows = view.siteScatter.filter(d => d.f_pymt !== null && d.o_pymt !== null);
    const lim = Math.max(...rows.flatMap(d => [d.f_pymt, d.o_pymt])) * 1.05 || 1;
    const maxV = Math.max(...rows.map(d => d.f_svcs || 0)) || 1;
    const ss = view.siteStats;

    mount("cSite", {
      type: "bubble",
      data: {
        datasets: [
          { label: "Procedure code (bubble = facility volume)",
            data: rows.map(d => ({ x: d.o_pymt, y: d.f_pymt,
              r: 4 + 14 * Math.sqrt((d.f_svcs || 0) / maxV) })),
            backgroundColor: T().s1 + "b0", borderColor: T().s1, borderWidth: 1 },
          { label: "Equal payment in both settings", type: "line",
            data: [{ x: 0, y: 0 }, { x: lim, y: lim }],
            borderColor: T().muted, borderWidth: 1.4, borderDash: [5, 4],
            pointRadius: 0, fill: false },
        ],
      },
      options: {
        plugins: {
          legend: legendOpts(true),
          title: { display: true, color: T().ink1, font: { size: 13, weight: "600" },
                   text: "The 60 highest-volume codes billed in both settings",
                   align: "start", padding: { bottom: 10 } },
          tooltip: tooltipOpts({
            title: c => c[0].datasetIndex === 0 ? rows[c[0].dataIndex].hcpcs : "",
            label: c => {
              if (c.datasetIndex !== 0) return "";
              const d = rows[c.dataIndex];
              return [` Facility: ${money(d.f_pymt)} per service`,
                      ` Office: ${money(d.o_pymt)} per service`,
                      ` Facility pays ${d.ratio === null ? "—"
                          : d.ratio.toFixed(2) + "x"} the office rate`,
                      ` ${count(d.f_svcs)} facility services`];
            },
            afterBody: c => c[0].datasetIndex === 0
              ? rows[c[0].dataIndex].desc.slice(0, 70) : "",
          }),
        },
        scales: {
          x: axisOpts("Office (non-facility) payment per service", v => money(v, 0),
                      { min: 0, max: lim }),
          y: axisOpts("Facility payment per service", v => money(v, 0), { min: 0, max: lim }),
        },
      },
    });

    // Both directions on one diverging axis -- showing only the positive tail is
    // how the original "savings" framing went wrong.
    const bar = view.siteBarNeg.slice(0, 8).concat(view.siteBarPos.slice(0, 8))
      .sort((a, b) => (a.savings || 0) - (b.savings || 0));
    mount("cSiteBar", {
      type: "bar",
      data: {
        labels: bar.map(d => d.hcpcs),
        datasets: [{
          label: "Facility minus office, times facility volume",
          data: bar.map(d => d.savings),
          backgroundColor: bar.map(d => diverging((d.savings || 0) >= 0 ? 0.75 : -0.75)),
          borderWidth: 0, borderRadius: 2,
        }],
      },
      options: {
        indexAxis: "y",
        plugins: {
          legend: legendOpts(false),
          title: { display: true, color: T().ink1, font: { size: 13, weight: "600" },
                   text: "Largest differentials, both directions",
                   align: "start", padding: { bottom: 10 } },
          tooltip: tooltipOpts({
            title: c => bar[c[0].dataIndex].hcpcs,
            label: c => ` ${c.raw >= 0 ? "Facility costs more: " : "Office costs more: "}`
              + `${money(Math.abs(c.raw))}`,
            afterLabel: c => bar[c.dataIndex].desc.slice(0, 70),
          }),
        },
        scales: {
          x: axisOpts("Facility premium (negative = office pays more)", v => money(v, 0)),
          y: axisOpts(null, null, { grid: { display: false } }),
        },
      },
    });

    document.getElementById("h5read").textContent =
      `Reading it: of ${count(ss.n_codes)} codes billed in both settings, `
      + `${count(ss.o_gt_f)} pay the physician MORE in an office and only `
      + `${count(ss.f_gt_o)} pay more in a facility — median facility rate is `
      + `${ss.median_ratio}x the office rate. Netted out, facility billing is `
      + `${money(Math.abs(ss.net))} ${ss.net < 0 ? "cheaper" : "dearer"} on the professional `
      + `fee alone.`;
    document.getElementById("h5caveat").textContent =
      `Why this is not a savings estimate: this dataset holds only the physician's `
      + `professional fee. When a procedure moves into a facility, Medicare pays the hospital `
      + `separately under the Outpatient Prospective Payment System, which is a different `
      + `dataset entirely. So the ${money(Math.abs(ss.net))} is where payment MOVED, not money `
      + `saved — a genuine site-neutral estimate requires joining OPPS data. The `
      + `${money(ss.pos)} facility-premium tail is real, but it is outweighed by the `
      + `${money(Math.abs(ss.neg))} pointing the other way.`;
  }

  /* ── detail table ───────────────────────────────────────────────────────── */
  const PROV_COLS = [
    { k: "npi", t: "NPI", l: true },
    { k: "specialty", t: "Specialty", l: true },
    { k: "state", t: "State", l: true },
    { k: "drug_pymt", t: "Drug payment", f: money },
    { k: "total_pymt", t: "Total payment", f: money },
    { k: "share", t: "Drug share", f: v => pct(v, 1) },
  ];
  function provRows(view, filters, state) {
    return view.providers.filter(r =>
      (filters.state === "all" || r.state === filters.state) &&
      (filters.spec === "all" || r.specialty === filters.spec)
    ).sort((a, b) => {
      const x = a[state.sort], y = b[state.sort];
      if (typeof x === "string") return x.localeCompare(y) * state.dir;
      return ((x ?? -Infinity) - (y ?? -Infinity)) * state.dir;
    });
  }
  function renderProviders(view, filters, state) {
    const rows = provRows(view, filters, state);
    const pages = Math.max(1, Math.ceil(rows.length / state.size));
    state.page = Math.min(state.page, pages - 1);
    const slice = rows.slice(state.page * state.size, (state.page + 1) * state.size);

    document.getElementById("tProv").innerHTML =
      `<thead><tr>${PROV_COLS.map(c =>
        `<th class="${c.l ? "l" : ""}" data-k="${c.k}">${c.t}`
        + `${state.sort === c.k ? (state.dir < 0 ? " ▼" : " ▲") : ""}</th>`).join("")}</tr></thead>`
      + (slice.length
        ? `<tbody>${slice.map(r => `<tr>${PROV_COLS.map(c =>
            `<td class="${c.l ? "l" : ""}">${c.f ? c.f(r[c.k]) : r[c.k] || "—"}</td>`
          ).join("")}</tr>`).join("")}</tbody>`
        : `<tbody><tr><td colspan="${PROV_COLS.length}" class="empty">`
          + `No providers match this filter.</td></tr></tbody>`);

    document.querySelectorAll("#tProv th").forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      if (state.sort === k) state.dir *= -1;
      // Live mode can return an empty cohort (a state x specialty nobody bills a
      // drug in); the static payload's 200 rows never could.
      else { state.dir = typeof (view.providers[0] || {})[k] === "string" ? 1 : -1;
             state.sort = k; }
      state.page = 0; renderProviders(view, filters, state);
    });

    document.getElementById("provPager").innerHTML = rows.length
      ? `<span>${count(rows.length)} providers · page ${state.page + 1} of ${pages}</span>`
        + `<button id="pPrev" ${state.page === 0 ? "disabled" : ""}>Previous</button>`
        + `<button id="pNext" ${state.page >= pages - 1 ? "disabled" : ""}>Next</button>`
      : "";
    const prev = document.getElementById("pPrev"), next = document.getElementById("pNext");
    if (prev) prev.onclick = () => { state.page--; renderProviders(view, filters, state); };
    if (next) next.onclick = () => { state.page++; renderProviders(view, filters, state); };
  }

  /* ── KPI ribbon, header, footer ─────────────────────────────────────────── */
  function renderStatics(payload) {
    const k = payload.kpi, m = payload.meta;
    const tiles = [
      ["Medicare paid", money(k.total_mdcr_pymt), `${m.data_year} professional fees`],
      ["Providers", count(k.n_providers), "distinct billing NPIs"],
      ["Procedure codes", count(k.n_hcpcs), "distinct HCPCS"],
      ["Drug-spend Gini", (k.gini ?? "—").toString(),
        `top 1% bill ${pct(k.lorenz_top1)} of it`],
      ["Non-participating", pct(k.nonpar_pct, 3),
        `${count(k.nonpar_providers)} of ${count(k.n_providers)} providers`],
      ["Facility pays less", `${count(payload.site_stats.o_gt_f)} / `
        + `${count(payload.site_stats.n_codes)}`, "codes, on the professional fee"],
    ];
    document.getElementById("kpis").innerHTML = tiles.map(([l, v, n]) =>
      `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div>`
      + `<div class="note">${n}</div></div>`).join("");

    document.getElementById("prov").innerHTML =
      `${count(m.source_rows)} claim rows · CMS ${m.data_year} · `
      + `<code>${m.cms_file}</code> · Gold layer rebuilt ${m.generated}`;
    document.getElementById("srcLink").href = m.cms_url;
    document.getElementById("foot").textContent =
      `Built by Zaid Shaikh. Pipeline: PySpark + Delta Lake (Bronze → Silver → Gold), `
      + `originally on Azure Databricks. Data rebuilt from the public CMS source on `
      + `${m.generated}.`;
  }

  root.MD = root.MD || {};
  root.MD.panels = {
    TILES, TIER_LABELS,
    renderKpis: renderStatics,   // alias: the ribbon and header render together
    renderHero1, renderHero2, renderHero3, renderHero4, renderHero5,
    renderProviders, renderStatics, geoByState,
    // Exported for docs/js/panels.test.js: these are the only DOM-free parts of
    // this module, and the 1- and 0-cohort prose is otherwise reachable only by a
    // human clicking through filters on a live page.
    readouts: { hero1Read, hero1Ramp, hero2Read, hero2Caveat, hero3Read },
  };
})(window);
