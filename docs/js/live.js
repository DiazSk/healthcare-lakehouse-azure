/* Live mode: swaps each panel's data source from the static payload to SQL.

   Every query below replicates its Gold mart's predicates exactly. Dropping one
   yields plausible-looking numbers that disagree with the validated payload, so
   treat pipeline/verify_explorer_parity.py as the spec for these WHERE clauses,
   and docs/js/live.test.js as the tripwire that notices when one goes missing.

   Three of those predicates are not WHERE clauses at all:
   - hero 4 reads cube_code_h4, which is pre-filtered at ROW grain to
     Tot_Srvcs >= 25 AND provider_tier <> 'Other/Unknown'. A post-aggregation
     HAVING over summed cells is a different filter and does not reproduce it.
   - hero 2's patient exposure is BENEFICIARY-weighted (bw_sbmtd_sum /
     bw_pymt_sum), not service-weighted. Using Tot_Sbmtd_Chrg/Tot_Mdcr_Pymt_Amt
     gives $260.60 for Dermatology against a published $184.68 -- 41% off and
     still plausible.
   - hero 2's cohort counts come from cohorts grain 'h2' (fact grain), not 'h2p'
     (provider grain), which gives Orthopedic Surgery 6 instead of 11 and so
     flips its guardrail badge from "thin" to "very-thin". */
(function (root) {
  "use strict";

  // Read the sibling modules through a getter rather than at load time, so this
  // file is loadable under node with both stubbed (docs/js/live.test.js) and so
  // script order is not a landmine.
  const E = () => root.MD.engine;
  const G = () => root.MD.guardrails;
  let _enabled = false;

  const isEnabled = () => _enabled;
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  // The publisher rounds these before they reach the page, and two renderers
  // interpolate them raw into prose ("Gini 0.906", "median 0.59x"). Round here
  // or live mode prints 0.9060147372593845.
  const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

  /* Each panel gets ONLY the predicates its chip discloses. Scoping every query
     to all three filters looks harmless and is not: hero 2's cohort counts come
     from `cohorts` grain 'h2', which is specialty x participation with no state
     or RUCA dimension, so a state-filtered exposure ratio carried a NATIONAL
     n_n -- 56 for NY x Dermatology, which reads as reliable, hides the badge and
     leaves a 2-cell cohort presented at full opacity as a finding. There is no
     state x specialty cohort grain to fix that with, which is the same reason
     R24 refused to wire badgeH1. */
  const COLUMN = { state: "state_abrvtn", ruca: "ruca_bucket", spec: "specialty" };
  function where(filters, dims, opts) {
    const c = dims
      .filter((d) => filters[d] !== "all")
      .map((d) => `${COLUMN[d]} = ${q(filters[d])}`);
    if (opts && opts.basket) c.push("in_top50_basket");
    return c.length ? `WHERE ${c.join(" AND ")}` : "";
  }

  /* Session cache for the queries that take no filters at all. Heroes 4 and 5
     and the J-code bar read cube_code / cube_code_h4, which carry no state,
     ruca or specialty column; the participation scalars are national by design.
     Promise-valued so two overlapping first calls share one query, and evicted
     on failure so a transient error is retried. */
  const _session = new Map();
  function once(key, run) {
    if (!_session.has(key)) {
      _session.set(key, run().catch((err) => { _session.delete(key); throw err; }));
    }
    return _session.get(key);
  }

  async function viewFromQueries(filters) {
    await E().loadTier(1);

    // Hero 1 -- fixed basket, paid minus standardized. Both predicates required.
    // Scope: State + RUCA, per its chip. cube_dims has a specialty column, so
    // adding `spec` here silently specialty-filters a panel labelled as not
    // responding to specialty.
    const geo = await E().query(`
      SELECT state_abrvtn AS state, ruca_bucket AS ruca,
             SUM(Tot_Mdcr_Pymt_Amt_sum) - SUM(Tot_Mdcr_Stdzd_Amt_sum) AS premium,
             SUM(Tot_Mdcr_Pymt_Amt_sum) AS pymt,
             SUM(Tot_Benes_sum) AS benes, SUM(Tot_Srvcs_sum) AS svcs
      FROM cube_dims ${where(filters, ["state", "ruca"], { basket: true })}
      GROUP BY 1, 2`);
    geo.forEach((r) => {
      r.prem_per_bene = r.benes > 0 ? r.premium / r.benes : null;
    });

    // Hero 2 -- beneficiary-weighted exposure, pivoted on participation.
    // Scope: Specialty only, per its chip and its cohort grain.
    const nonpar = await E().query(`
      WITH per AS (
        SELECT specialty, is_participating,
               SUM(bw_sbmtd_sum)  AS sbmtd,
               SUM(bw_pymt_sum)   AS pymt,
               SUM(Tot_Benes_sum) AS benes
        FROM cube_dims ${where(filters, ["spec"])} GROUP BY 1, 2
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
      r.measurable = (r.n_n || 0) >= G().RELIABLE;
    });
    // "Specialties where both groups appear" IS this filtered set, so the stats
    // below are counted over it, not over the 104 rows the pivot returns. The
    // unfiltered array reports 104 compared specialties against a published 36.
    const compared = nonpar.filter((r) => Number.isFinite(r.premium_pct))
                           .sort((a, b) => b.premium_pct - a.premium_pct);

    const credRows = await once("credentials", credentialCells);
    const site = await once("site", siteCells);
    // Hero 2's reading line quotes the national participation scalars, which are
    // PROVIDER grain -- the one thing cohorts' 'h2p' exists for. National on
    // purpose: the sentence is a national claim and reads identically in static
    // mode, where no filter moves it either.
    const par = await once("participation", () => E().query(`
      SELECT SUM(CASE WHEN k2 = 'False' THEN n_providers ELSE 0 END) AS nonpar_providers,
             SUM(CASE WHEN k2 = 'True'  THEN n_providers ELSE 0 END) AS par_providers,
             SUM(n_providers)                                        AS n_providers
      FROM cohorts WHERE grain = 'h2p'`));

    // Nothing renders these two: renderStatics takes the raw snake_case DATA and
    // runs once from init(). They exist as the console hook the notes named for
    // verifying the live KPI against 93,719,556,238.83, so they carry the whole
    // filter set.
    const kpi = (await E().query(`
      SELECT SUM(Tot_Mdcr_Pymt_Amt_sum) AS total_mdcr_pymt,
             SUM(Tot_Srvcs_sum) AS total_services
      FROM cube_dims ${where(filters, ["state", "ruca", "spec"])}`))[0];
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
        min_nonpar_providers: G().RELIABLE,
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

  /* Hero 4 -- cube_code_h4 already carries Tot_Srvcs >= 25 and the known-tier
     restriction at row grain, so this query adds no predicates of its own. It
     does restrict the row SET the way publish_dashboard.py does: the six shared
     E&M codes plus the 50 largest others by MD/DO service volume. Verified to be
     the same 56 codes as the static payload's `credentials`. Reading all 4,544
     codes to render 6 was the largest tier-1 query at 67 ms; this is 185 cells. */
  const SHARED_E_AND_M = ["99213", "99214", "99203", "99204", "99212", "99215"];
  const TIER_KEY = {
    "Physician (MD/DO)": "md", "Nurse Practitioner": "np",
    "Physician Assistant": "pa", Specialist: "spec",
  };

  function credentialCells() {
    const shared = SHARED_E_AND_M.map(q).join(", ");
    return E().query(`
      WITH cells AS (
        SELECT hcpcs_cd AS hcpcs, provider_tier,
               SUM(Tot_Sbmtd_Chrg_sum) / NULLIF(SUM(Tot_Mdcr_Alowd_Amt_sum), 0) AS markup,
               SUM(Tot_Srvcs_sum) AS svcs
        FROM cube_code_h4
        GROUP BY 1, 2
      ), top_rest AS (
        -- publish_dashboard.py ranks the non-shared codes by Physician_MD_DO_svcs,
        -- not by services summed across tiers; ranking on the sum picks a
        -- different 50.
        SELECT hcpcs FROM cells
        WHERE provider_tier = 'Physician (MD/DO)' AND hcpcs NOT IN (${shared})
        ORDER BY svcs DESC LIMIT 50
      )
      SELECT hcpcs, provider_tier, markup FROM cells
      WHERE hcpcs IN (${shared}) OR hcpcs IN (SELECT hcpcs FROM top_rest)`);
  }

  /* Hero 5 -- >= 1000 services on BOTH sides, per the mart. `desc` is empty
     because no tiered cube carries HCPCS descriptions, and hero 5's tooltips
     call .slice() on it. */
  function siteCells() {
    return E().query(`
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
  }

  /* Hero 3's Lorenz curve and the provider table are the only things needing npi
     grain, so tier 2 (4.78 MB) loads here rather than with tier 1. Mutates `view`
     in place so the returned shape always matches viewFromPayload's.

     Memoized on state x specialty, the only two filters providers_drug carries:
     a RUCA-only change would otherwise redo ~170 ms of provider work it cannot
     affect. Only the newest pair is kept -- the payload is small but a per-pair
     map would be unbounded (61 states x 37 specialties). */
  let _provKey = null;
  let _provPromise = null;

  async function addProviderGrain(view, filters) {
    const key = `${filters.state}|${filters.spec}`;
    if (key !== _provKey) {
      _provKey = key;
      _provPromise = providerGrain(filters).catch((err) => {
        if (_provKey === key) { _provKey = null; _provPromise = null; }
        throw err;
      });
    }
    const g = await _provPromise;
    view.lorenz = g.lorenz;
    view.providers = g.providers;
    view.jcodeTop = g.jcodeTop;
    Object.assign(view.kpi, g.kpi);
  }

  async function providerGrain(filters) {
    await E().loadTier(2);
    const pw = where(filters, ["state", "spec"]);

    /* The curve, its Gini and the two top-share scalars all come out of one
       ordered scan, downsampled to ~200 points IN SQL. Pulling all 221,364
       provider rows into JS to do this in a reduce -- the obvious shape, and what
       this function first did -- measured 2,418 ms per render, essentially all of
       it Arrow-to-JS object allocation. This is ~150 ms and returns the identical
       Gini to 14 significant figures. */
    const curve = await E().query(`
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
    return {
      lorenz: curve.map((r) => ({ x: r.x, y: r.y })),
      kpi: {
        n_drug_providers: s.n_drug_providers || 0,
        // A state x specialty with no drug billers at all is reachable (AA x
        // Dermatology). Gini is undefined there, and the chart title
        // interpolates this value raw -- "Gini —" is the codebase's convention
        // for a missing scalar, "Gini null" is a bug report.
        gini: round(s.gini, 3) ?? "—",
        lorenz_top1: round(s.lorenz_top1, 5),
        lorenz_top10: round(s.lorenz_top10, 5),
      },
      providers: await E().query(`
        SELECT npi, specialty, state_abrvtn AS state,
               SUM(Tot_Mdcr_Pymt_Amt_sum) AS drug_pymt
        FROM providers_drug ${pw}
        GROUP BY 1, 2, 3 HAVING SUM(Tot_Mdcr_Pymt_Amt_sum) > 0
        ORDER BY drug_pymt DESC LIMIT 200`),
      // Hero 3's companion bar: largest drug codes by payment, from cube_code
      // (tier 1) since it needs no npi grain -- and no filters, so it is shared
      // across every cohort. That is why hero 3's chip overstates slightly: the
      // Lorenz curve responds to State and Specialty, this bar cannot, because
      // cube_code has neither column.
      jcodeTop: await once("jcode", () => E().query(`
        SELECT hcpcs_cd AS hcpcs, '' AS desc,
               SUM(Tot_Mdcr_Pymt_Amt_sum) AS pymt,
               SUM(Tot_Srvcs_sum) AS providers
        FROM cube_code WHERE is_drug
        GROUP BY 1 ORDER BY pymt DESC LIMIT 25`)),
    };
  }

  function reshapeCredentials(rows) {
    const byCode = new Map();
    for (const r of rows) {
      const k = TIER_KEY[r.provider_tier];
      if (!k) continue;
      if (!byCode.has(r.hcpcs)) {
        byCode.set(r.hcpcs, {
          hcpcs: r.hcpcs, desc: "",
          shared: SHARED_E_AND_M.includes(r.hcpcs),
        });
      }
      byCode.get(r.hcpcs)[k] = r.markup;
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
})(typeof window !== "undefined" ? window : globalThis);
