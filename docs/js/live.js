/* Live mode: swaps each panel's data source from the static payload to SQL.

   Every query below replicates its Gold mart's predicates exactly. Dropping one
   yields plausible-looking numbers that disagree with the validated payload, so
   treat pipeline/verify_explorer_parity.py as the spec for these WHERE clauses.

   Two of those predicates are not WHERE clauses at all:
   - hero 4 reads cube_code_h4, which is pre-filtered at ROW grain to
     Tot_Srvcs >= 25 AND provider_tier <> 'Other/Unknown'. A post-aggregation
     HAVING over summed cells is a different filter and does not reproduce it.
   - hero 2's patient exposure is BENEFICIARY-weighted (bw_sbmtd_sum /
     bw_pymt_sum), not service-weighted. Using Tot_Sbmtd_Chrg/Tot_Mdcr_Pymt_Amt
     gives $260.60 for Dermatology against a published $184.68 -- 41% off and
     still plausible. */
(function (root) {
  "use strict";

  const E = root.MD.engine;
  const G = root.MD.guardrails;
  let _enabled = false;

  const isEnabled = () => _enabled;
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  // The publisher rounds these before they reach the page, and two renderers
  // interpolate them raw into prose ("Gini 0.906", "median 0.59x"). Round here
  // or live mode prints 0.9060147372593845.
  const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

  function where(filters, opts = {}) {
    const c = [];
    if (filters.state !== "all") c.push(`state_abrvtn = ${q(filters.state)}`);
    if (filters.ruca !== "all") c.push(`ruca_bucket = ${q(filters.ruca)}`);
    if (filters.spec !== "all") c.push(`specialty = ${q(filters.spec)}`);
    if (opts.basket) c.push("in_top50_basket");
    return c.length ? `WHERE ${c.join(" AND ")}` : "";
  }

  async function viewFromQueries(filters) {
    await E.loadTier(1);

    // Hero 1 -- fixed basket, paid minus standardized. Both predicates required.
    const geo = await E.query(`
      SELECT state_abrvtn AS state, ruca_bucket AS ruca,
             SUM(Tot_Mdcr_Pymt_Amt_sum) - SUM(Tot_Mdcr_Stdzd_Amt_sum) AS premium,
             SUM(Tot_Mdcr_Pymt_Amt_sum) AS pymt,
             SUM(Tot_Benes_sum) AS benes, SUM(Tot_Srvcs_sum) AS svcs
      FROM cube_dims ${where(filters, { basket: true })}
      GROUP BY 1, 2`);
    geo.forEach((r) => {
      r.prem_per_bene = r.benes > 0 ? r.premium / r.benes : null;
    });

    // Hero 2 -- beneficiary-weighted exposure, pivoted on participation. The
    // cohort counts come from grain 'h2' (fact grain), which is what the
    // published n_n values and therefore the guardrail badge are built on;
    // 'h2p' is provider grain and gives 6 for Orthopedic Surgery, not 11.
    const nonpar = await E.query(`
      WITH per AS (
        SELECT specialty, is_participating,
               SUM(bw_sbmtd_sum)  AS sbmtd,
               SUM(bw_pymt_sum)   AS pymt,
               SUM(Tot_Benes_sum) AS benes
        FROM cube_dims ${where(filters)} GROUP BY 1, 2
      ), exposure AS (
        SELECT specialty, is_participating,
               (sbmtd - pymt) / NULLIF(benes, 0) AS exp_per_bene
        FROM per
      )
      SELECT e.specialty,
             MAX(CASE WHEN is_participating THEN exp_per_bene END)      AS exp_y,
             MAX(CASE WHEN NOT is_participating THEN exp_per_bene END)  AS exp_n,
             MAX(CASE WHEN is_participating THEN c.n END)               AS n_y,
             MAX(CASE WHEN NOT is_participating THEN c.n END)           AS n_n
      FROM exposure e
      LEFT JOIN (SELECT k1 AS specialty, k2 AS par, SUM(n_providers) AS n
                 FROM cohorts WHERE grain = 'h2' GROUP BY 1, 2) c
        ON c.specialty = e.specialty
       AND c.par = CASE WHEN e.is_participating THEN 'True' ELSE 'False' END
      GROUP BY 1`);
    nonpar.forEach((r) => {
      // Both sides must exist. 68 of the 104 specialties have no non-par cohort
      // at all, and SQL NULL coerces to 0 in JS arithmetic -- `exp_n - exp_y`
      // would quietly yield premium_pct = -1 for every one of them, reporting 104
      // compared specialties and 99 negative against a published 36 and 31.
      r.premium_pct = Number.isFinite(r.exp_y) && Number.isFinite(r.exp_n) && r.exp_y > 0
        ? (r.exp_n - r.exp_y) / r.exp_y : null;
      r.measurable = (r.n_n || 0) >= G.RELIABLE;
    });
    // "Specialties where both groups appear" IS this filtered set, so the stats
    // below are counted over it, not over the 104 rows the pivot returns. The
    // unfiltered array reports 104 compared specialties against a published 36.
    const compared = nonpar.filter((r) => Number.isFinite(r.premium_pct))
                           .sort((a, b) => b.premium_pct - a.premium_pct);

    // Hero 4 -- cube_code_h4 already carries Tot_Srvcs >= 25 and the known-tier
    // restriction at row grain, so this query adds no predicates of its own.
    const credRows = await E.query(`
      SELECT hcpcs_cd AS hcpcs, provider_tier,
             SUM(Tot_Sbmtd_Chrg_sum) / NULLIF(SUM(Tot_Mdcr_Alowd_Amt_sum), 0) AS markup,
             SUM(Tot_Srvcs_sum) AS svcs
      FROM cube_code_h4
      GROUP BY 1, 2`);

    // Hero 5 -- >= 1000 services on BOTH sides, per the mart. `desc` is empty
    // because no tiered cube carries HCPCS descriptions, and hero 5's tooltips
    // call .slice() on it.
    const site = await E.query(`
      WITH per_code AS (
        SELECT hcpcs_cd AS hcpcs,
               SUM(CASE WHEN place_of_srvc='F' THEN Tot_Mdcr_Pymt_Amt_sum END) AS f_tot,
               SUM(CASE WHEN place_of_srvc='F' THEN Tot_Srvcs_sum END)         AS f_svcs,
               SUM(CASE WHEN place_of_srvc='O' THEN Tot_Mdcr_Pymt_Amt_sum END) AS o_tot,
               SUM(CASE WHEN place_of_srvc='O' THEN Tot_Srvcs_sum END)         AS o_svcs
        FROM cube_code GROUP BY 1
      )
      SELECT hcpcs, '' AS desc, f_tot / f_svcs AS f_pymt, o_tot / o_svcs AS o_pymt, f_svcs,
             (f_tot / f_svcs) / NULLIF(o_tot / o_svcs, 0) AS ratio,
             ((f_tot / f_svcs) - (o_tot / o_svcs)) * f_svcs AS savings
      FROM per_code WHERE f_svcs >= 1000 AND o_svcs >= 1000`);

    const kpi = (await E.query(`
      SELECT SUM(Tot_Mdcr_Pymt_Amt_sum) AS total_mdcr_pymt,
             SUM(Tot_Srvcs_sum) AS total_services
      FROM cube_dims ${where(filters)}`))[0];

    // Hero 2's reading line quotes the national participation scalars, which are
    // PROVIDER grain -- the one thing cohorts' 'h2p' exists for. Left unfiltered
    // on purpose: the sentence is a national claim and reads identically in
    // static mode, where no filter moves it either.
    const par = await E.query(`
      SELECT SUM(CASE WHEN k2 = 'False' THEN n_providers ELSE 0 END) AS nonpar_providers,
             SUM(CASE WHEN k2 = 'True'  THEN n_providers ELSE 0 END) AS par_providers,
             SUM(n_providers)                                        AS n_providers
      FROM cohorts WHERE grain = 'h2p'`);
    Object.assign(kpi, par[0], {
      nonpar_pct: par[0].n_providers > 0
        ? round(par[0].nonpar_providers / par[0].n_providers, 6) : null,
    });

    const view = {
      geo,
      nonpar: compared,
      nonparStats: {
        specialties_compared: compared.length,
        positive: compared.filter((r) => r.premium_pct > 0).length,
        negative: compared.filter((r) => r.premium_pct < 0).length,
        measurable: compared.filter((r) => r.measurable).length,
        min_nonpar_providers: G.RELIABLE,
      },
      credentials: reshapeCredentials(credRows),
      credentialTiers: ["md", "np", "pa", "spec"],
      siteScatter: site.slice().sort((a, b) => b.f_svcs - a.f_svcs).slice(0, 60),
      siteBarPos: site.slice().sort((a, b) => b.savings - a.savings).slice(0, 12),
      siteBarNeg: site.slice().sort((a, b) => a.savings - b.savings).slice(0, 12),
      siteStats: {
        n_codes: site.length,
        f_gt_o: site.filter((r) => r.ratio > 1).length,
        o_gt_f: site.filter((r) => r.ratio < 1).length,
        pos: site.filter((r) => r.savings > 0).reduce((a, r) => a + r.savings, 0),
        neg: site.filter((r) => r.savings < 0).reduce((a, r) => a + r.savings, 0),
        net: site.reduce((a, r) => a + r.savings, 0),
        median_ratio: round(median(site.map((r) => r.ratio)), 2),
      },
      // Populated by the tier-2 block below; declared here so the shape is
      // identical to viewFromPayload's even before that block runs.
      lorenz: [], jcodeTop: [], providers: [],
      kpi,
    };
    await addProviderGrain(view, filters);
    return view;
  }

  /* Hero 3's Lorenz curve and the provider table are the only things needing npi
     grain, so tier 2 (4.78 MB) loads here rather than with tier 1. Mutates `view`
     in place so the returned shape always matches viewFromPayload's. */
  async function addProviderGrain(view, filters) {
    await E.loadTier(2);
    const provFilter = [];
    if (filters.state !== "all") provFilter.push(`state_abrvtn = ${q(filters.state)}`);
    if (filters.spec !== "all") provFilter.push(`specialty = ${q(filters.spec)}`);
    const pw = provFilter.length ? `WHERE ${provFilter.join(" AND ")}` : "";

    /* The curve, its Gini and the two top-share scalars all come out of one
       ordered scan, downsampled to ~200 points IN SQL. Pulling all 221,364
       provider rows into JS to do this in a reduce -- the obvious shape, and what
       this function first did -- measured 2,418 ms per render, essentially all of
       it Arrow-to-JS object allocation. This is ~150 ms and returns the identical
       Gini to 14 significant figures. */
    const curve = await E.query(`
      WITH p AS (
        SELECT npi, SUM(Tot_Mdcr_Pymt_Amt_sum) AS drug_pymt
        FROM providers_drug ${pw}
        GROUP BY 1 HAVING SUM(Tot_Mdcr_Pymt_Amt_sum) > 0
      ), r AS MATERIALIZED (
        SELECT ROW_NUMBER() OVER (ORDER BY drug_pymt) AS rn,
               COUNT(*) OVER ()                       AS n,
               SUM(drug_pymt) OVER (ORDER BY drug_pymt ROWS UNBOUNDED PRECEDING)
                 / SUM(drug_pymt) OVER ()             AS y
        FROM p
      ), lagged AS (
        SELECT rn, n, y, LAG(y, 1, 0.0) OVER (ORDER BY rn) AS yprev FROM r
      )
      SELECT rn / CAST(n AS DOUBLE) AS x, y,
             (SELECT MAX(n) FROM r) AS n_drug_providers,
             -- Trapezoid rule over the FULL curve, not the downsample: every
             -- segment is 1/n wide, so the area collapses to SUM(y + yprev) / 2n
             -- and gini = 1 - 2 * area.
             (SELECT 1 - SUM(y + yprev) / MAX(n) FROM lagged WHERE rn >= 2) AS gini,
             -- Hero 3's reading line names both shares; without them the sentence
             -- collapses to "across N providers, . A Gini of ...".
             (SELECT 1 - MAX(CASE WHEN rn = CAST(FLOOR(0.99 * n) AS BIGINT) THEN y END)
              FROM r) AS lorenz_top1,
             (SELECT 1 - MAX(CASE WHEN rn = CAST(FLOOR(0.90 * n) AS BIGINT) THEN y END)
              FROM r) AS lorenz_top10
      FROM r
      WHERE (rn - 1) % GREATEST(1, CAST(FLOOR(n / 200.0) AS BIGINT)) = 0 OR rn = n
      ORDER BY rn`);

    const s = curve[0] || {};
    view.lorenz = curve.map((r) => ({ x: r.x, y: r.y }));
    view.kpi.n_drug_providers = s.n_drug_providers || 0;
    // A state x specialty with no drug billers at all is reachable (AA x
    // Dermatology). Gini is undefined there, and the chart title interpolates
    // this value raw -- "Gini —" is the codebase's convention for a missing
    // scalar, "Gini null" is a bug report.
    view.kpi.gini = round(s.gini, 3) ?? "—";
    view.kpi.lorenz_top1 = round(s.lorenz_top1, 5);
    view.kpi.lorenz_top10 = round(s.lorenz_top10, 5);

    view.providers = await E.query(`
      SELECT npi, specialty, state_abrvtn AS state,
             SUM(Tot_Mdcr_Pymt_Amt_sum) AS drug_pymt
      FROM providers_drug ${pw}
      GROUP BY 1, 2, 3 HAVING SUM(Tot_Mdcr_Pymt_Amt_sum) > 0
      ORDER BY drug_pymt DESC LIMIT 200`);

    // Hero 3's companion bar: largest drug codes by payment, from cube_code
    // (tier 1) since it needs no npi grain.
    view.jcodeTop = await E.query(`
      SELECT hcpcs_cd AS hcpcs, '' AS desc,
             SUM(Tot_Mdcr_Pymt_Amt_sum) AS pymt,
             SUM(Tot_Srvcs_sum) AS providers
      FROM cube_code WHERE is_drug
      GROUP BY 1 ORDER BY pymt DESC LIMIT 25`);
  }

  const SHARED_E_AND_M = ["99213", "99214", "99203", "99204", "99212", "99215"];
  const TIER_KEY = {
    "Physician (MD/DO)": "md", "Nurse Practitioner": "np",
    "Physician Assistant": "pa", Specialist: "spec",
  };

  function reshapeCredentials(rows) {
    const byCode = new Map();
    for (const r of rows) {
      const k = TIER_KEY[r.provider_tier];
      if (!k) continue;
      if (!byCode.has(r.hcpcs)) {
        byCode.set(r.hcpcs, {
          hcpcs: r.hcpcs, desc: "",
          shared: SHARED_E_AND_M.includes(r.hcpcs), _svcs: 0,
        });
      }
      const row = byCode.get(r.hcpcs);
      row[k] = r.markup;
      row._svcs += r.svcs || 0;
    }
    return [...byCode.values()];
  }

  function median(xs) {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  }

  async function enable() { _enabled = true; }
  function disable() { _enabled = false; }

  root.MD = root.MD || {};
  root.MD.live = { enable, disable, isEnabled, viewFromQueries };
})(window);
