// Run: node --test docs/js/*.test.js   (the directory form is broken on Node 24)
/* Tripwire on live.js's SQL.

   Predicate drift is the defect class this plan has hit seven times -- hero 4
   reading cube_code instead of the pre-filtered cube_code_h4, hero 2's exposure
   going service-weighted, hero 5 losing one side of its 1,000-service floor.
   Every one of those was caught by a human reading the notes, and none by a
   check: verify_explorer_parity.py holds its own hand-kept copy of the SQL and
   never reads live.js, so reverting hero 4 to the wrong table left both
   `node --test` and the parity gate green.

   These tests close that. They run live.js against a stub engine that RECORDS
   the SQL it is asked to run, so the assertions see the real composed
   statements -- WHERE clauses included -- rather than a regex over the file
   text. That covers the per-panel filter scoping with the same mechanism.

   Known weakness, recorded deliberately: this is a TEXT-level check. It proves a
   query still names the table and predicate its Gold mart requires; it cannot
   prove the query means the right thing. A statement that reads bw_sbmtd_sum and
   then divides by the wrong denominator passes here and would only be caught by
   verify_explorer_parity.py's value comparison. Making this a DuckDB round-trip
   was explicitly deferred -- Task 12 owns pipeline chaining. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "live.js"), "utf8");
const ALL = { state: "all", ruca: "all", spec: "all" };

/* A fresh instance per test. live.js holds module state -- the session cache for
   filter-independent queries and the state x specialty provider memo -- so one
   test must not inherit another's already-cached queries. */
function load() {
  const captured = [];
  let rows = () => [{}];
  const win = {
    MD: {
      engine: {
        loadTier: async () => {},
        query: async (sql) => { captured.push(sql); return rows(sql); },
      },
      guardrails: { RELIABLE: 30 },
    },
  };
  global.window = win;
  eval(SRC);
  return { live: win.MD.live, captured, setRows: (fn) => { rows = fn; } };
}

async function capture(filters) {
  const h = load();
  await h.live.viewFromQueries(filters || ALL);
  return h.captured;
}

/* Each entry: exactly one captured query must match ALL of its patterns. A swap
   that drops a mart predicate, or reads an unfiltered cube where a pre-filtered
   one is required, leaves zero matches. */
const REQUIRED = [
  ["hero 1 geographic premium (fixed basket, paid minus standardized)",
    [/FROM cube_dims/, /in_top50_basket/, /Tot_Mdcr_Stdzd_Amt_sum/]],
  ["hero 2 exposure (beneficiary-weighted, cohort grain h2)",
    [/bw_sbmtd_sum/, /bw_pymt_sum/, /grain = 'h2'/]],
  ["hero 4 markup (pre-filtered cube_code_h4)",
    [/FROM cube_code_h4/, /Tot_Mdcr_Alowd_Amt_sum/]],
  ["hero 5 site differential (>= 1000 services on both sides)",
    [/place_of_srvc='F'/, /place_of_srvc='O'/, /f_svcs >= 1000/, /o_svcs >= 1000/]],
  ["hero 3 Lorenz (drug-billing providers only)",
    [/FROM providers_drug/, /SUM\(Tot_Mdcr_Pymt_Amt_sum\) > 0/, /ROW_NUMBER\(\)/]],
  ["provider outlier table (top 200 by drug payment)",
    [/FROM providers_drug/, /LIMIT 200/]],
  ["participation scalars (provider grain h2p)", [/grain = 'h2p'/]],
];

test("every hero's query still carries its Gold mart's predicates", async () => {
  const sql = await capture();
  for (const [label, patterns] of REQUIRED) {
    const hits = sql.filter((s) => patterns.every((p) => p.test(s)));
    assert.equal(hits.length, 1,
      `${label}: expected exactly 1 matching query, got ${hits.length}`);
  }
});

test("hero 4 does not re-apply cube_code_h4's row-grain predicates", async () => {
  const sql = await capture();
  const h4 = sql.find((s) => /FROM cube_code_h4/.test(s));
  assert.ok(h4, "no query reads cube_code_h4");
  // R21: Tot_Srvcs >= 25 and provider_tier <> 'Other/Unknown' are baked into the
  // artifact at ROW grain. Re-applying either post-aggregation is a different
  // filter, which is the entire reason cube_code_h4 was built.
  assert.doesNotMatch(h4, /provider_tier\s*<>/);
  assert.doesNotMatch(h4, /Tot_Srvcs_sum\)\s*>=\s*25/);
  assert.doesNotMatch(h4, /\bHAVING\b/);
  // And the markup must not be computed from the unfiltered cube at all.
  assert.ok(!sql.some((s) => /FROM cube_code\b/.test(s) && /Tot_Mdcr_Alowd_Amt_sum/.test(s)),
    "markup computed from cube_code instead of cube_code_h4");
  // The row SET follows publish_dashboard.py: 6 shared E&M codes plus the 50
  // largest others ranked by MD/DO services, not by services summed over tiers.
  assert.match(h4, /Physician \(MD\/DO\)/);
  assert.match(h4, /LIMIT 50/);
});

test("hero 2 exposure is beneficiary-weighted and reads the fact-grain cohort", async () => {
  const sql = await capture();
  const h2 = sql.find((s) => /bw_sbmtd_sum/.test(s));
  assert.ok(h2, "no query reads bw_sbmtd_sum");
  // R22: Tot_Sbmtd_Chrg_sum / Tot_Mdcr_Pymt_Amt_sum are service-weighted and give
  // Dermatology $260.60 against a published $184.68 -- 41% off, still plausible.
  assert.doesNotMatch(h2, /Tot_Sbmtd_Chrg_sum/);
  // R25: grain h2p gives Orthopedic Surgery 6, which crosses WEAK=11 and flips
  // the guardrail badge from "thin" to "very-thin".
  assert.doesNotMatch(h2, /grain = 'h2p'/);
});

test("each panel's query carries only the filters its chip discloses", async () => {
  const sql = await capture({ state: "NY", ruca: "Urban", spec: "Dermatology" });
  const geo = sql.find((s) => /in_top50_basket/.test(s));
  const h2 = sql.find((s) => /bw_sbmtd_sum/.test(s));
  const prov = sql.find((s) => /FROM providers_drug/.test(s) && /LIMIT 200/.test(s));

  // Hero 1: State + RUCA. cube_dims has a specialty column, so leaking `spec`
  // here is a live possibility, not a hypothetical.
  assert.match(geo, /state_abrvtn = 'NY'/);
  assert.match(geo, /ruca_bucket = 'Urban'/);
  assert.doesNotMatch(geo, /specialty =/);

  // Hero 2: Specialty only. A state predicate narrows the exposure while
  // `cohorts` grain h2 keeps a NATIONAL n_n (56 for NY x Dermatology), which
  // reads as reliable and hides the badge on a 2-cell cohort.
  assert.match(h2, /specialty = 'Dermatology'/);
  assert.doesNotMatch(h2, /state_abrvtn =/);
  assert.doesNotMatch(h2, /ruca_bucket =/);

  // Provider table: State + Specialty. providers_drug has no ruca column.
  assert.match(prov, /state_abrvtn = 'NY'/);
  assert.match(prov, /specialty = 'Dermatology'/);
  assert.doesNotMatch(prov, /ruca_bucket =/);

  // Heroes 4 and 5 and the J-code bar: cube_code/_h4 carry none of the three.
  for (const s of sql.filter((x) => /FROM cube_code/.test(x))) {
    assert.doesNotMatch(s, /state_abrvtn =|ruca_bucket =|specialty =/);
  }
});

test("filter values are escaped, not interpolated raw", async () => {
  const sql = await capture({ state: "all", ruca: "all", spec: "O'Brien Surgery" });
  const h2 = sql.find((s) => /bw_sbmtd_sum/.test(s));
  assert.match(h2, /specialty = 'O''Brien Surgery'/);
});

test("a specialty with no non-participating side is not counted as compared", async () => {
  const h = load();
  h.setRows((sql) => {
    if (!/bw_sbmtd_sum/.test(sql)) return [{}];
    return [
      { specialty: "Dermatology", exp_y: 184.69, exp_n: 41.8, n_y: 12158, n_n: 56 },
      // exp_n NULL means "no non-participating cohort". `exp_n - exp_y` coerces
      // null to 0 and yields a finite -1, which shipped 68 fabricated "-100%
      // exposure" rows and reported 104 compared specialties against 36.
      { specialty: "Allergy", exp_y: 100, exp_n: null, n_y: 500, n_n: null },
      { specialty: "Pathology", exp_y: 50, exp_n: null, n_y: 900, n_n: null },
    ];
  });
  const v = await h.live.viewFromQueries(ALL);
  assert.equal(v.nonpar.length, 1);
  assert.deepEqual(v.nonparStats, {
    specialties_compared: 1, positive: 0, negative: 1, measurable: 1,
    min_nonpar_providers: 30,
  });
});

test("credentials keeps one row per code and flags only the shared E&M set", async () => {
  const h = load();
  h.setRows((sql) => {
    if (!/FROM cube_code_h4/.test(sql)) return [{}];
    return [
      { hcpcs: "99213", provider_tier: "Physician (MD/DO)", markup: 2.062 },
      { hcpcs: "99213", provider_tier: "Nurse Practitioner", markup: 2.496 },
      { hcpcs: "J0178", provider_tier: "Physician (MD/DO)", markup: 1.05 },
      { hcpcs: "J0178", provider_tier: "Other/Unknown", markup: 9.99 },
    ];
  });
  const v = await h.live.viewFromQueries(ALL);
  assert.deepEqual(v.credentials.map((r) => [r.hcpcs, r.shared]),
    [["99213", true], ["J0178", false]]);
  assert.equal(v.credentials[0].md, 2.062);
  assert.equal(v.credentials[0].np, 2.496);
  // _svcs was a ranking key the SQL now owns. Static payload rows do not carry
  // it, so live rows must not either.
  assert.ok(!("_svcs" in v.credentials[0]));
  // An unrecognised tier is dropped, never mapped onto a key.
  assert.deepEqual(Object.keys(v.credentials[1]).sort(), ["desc", "hcpcs", "md", "shared"]);
});

test("viewFromQueries returns viewFromPayload's key set", async () => {
  const h = load();
  const v = await h.live.viewFromQueries(ALL);
  assert.deepEqual(Object.keys(v).sort(), [
    "credentialTiers", "credentials", "geo", "jcodeTop", "kpi", "lorenz",
    "nonpar", "nonparStats", "providers", "siteBarNeg", "siteBarPos",
    "siteScatter", "siteStats",
  ]);
});

test("a RUCA-only change re-queries nothing that cannot see RUCA", async () => {
  const h = load();
  await h.live.viewFromQueries(ALL);
  const first = h.captured.length;
  h.captured.length = 0;
  await h.live.viewFromQueries({ state: "all", ruca: "Urban", spec: "all" });
  const sql = h.captured;
  assert.ok(!sql.some((s) => /FROM cube_code_h4/.test(s)), "hero 4 re-queried");
  assert.ok(!sql.some((s) => /f_svcs >= 1000/.test(s)), "hero 5 re-queried");
  assert.ok(!sql.some((s) => /grain = 'h2p'/.test(s)), "participation re-queried");
  // providers_drug has no ruca column, so the ~170 ms provider grain is memoized
  // on state x specialty alone.
  assert.ok(!sql.some((s) => /FROM providers_drug/.test(s)),
    "provider grain re-queried on a RUCA-only change");
  assert.ok(sql.length < first, "nothing was saved");
});

/* ── render seam ───────────────────────────────────────────────────────────
   Two rules, both regressions that had already shipped once. The paint-queue
   rule was found by review on the running page; the rejection rule was
   introduced by the fix for the first one, because the swallow added for the
   fire-and-forget filter handlers also covered the toggle's awaited enable path
   -- so the toggle's catch never ran and the page read "Live — querying 9.66M
   rows in your browser" over static numbers. Both are unit-testable, and an
   error path only a human clicking can check is the same gap this file exists
   to close. */

test("seam: a superseded request keeps its paint and runs it against the newer view", async () => {
  const { renderSeam } = load().live;
  let release;
  const gate = new Promise((r) => { release = r; });
  let call = 0;
  const withView = renderSeam(async () => {
    call += 1;
    if (call === 1) await gate;          // the first request is the slow one
    return { id: call };
  });

  const painted = [];
  const slow = withView((v) => painted.push(["hero1", v.id]));
  const fast = withView((v) => painted.push(["hero2", v.id]));
  await fast;
  release();
  await slow;

  // Both panels painted, both from the NEWER view. Dropping the superseded
  // request's paint set left hero 1 stale with no error and no visual cue.
  assert.deepEqual(painted.sort(), [["hero1", 2], ["hero2", 2]]);
});

test("seam: a stale view never paints over a newer one", async () => {
  const { renderSeam } = load().live;
  let release;
  const gate = new Promise((r) => { release = r; });
  let call = 0;
  const withView = renderSeam(async () => {
    call += 1;
    if (call === 1) await gate;
    return { id: call };
  });
  const seen = [];
  const slow = withView((v) => seen.push(v.id));
  const fast = withView((v) => seen.push(v.id));
  await fast;
  release();
  await slow;
  assert.ok(!seen.includes(1), "the stale view reached a paint");
});

test("seam: a failing source rejects rather than swallowing", async () => {
  const { renderSeam } = load().live;
  const boom = new Error("tier 1 unavailable");
  const withView = renderSeam(async () => { throw boom; });
  // The toggle awaits this so its own catch can roll back to the summary.
  // Swallowing here is what let the page claim to be live over static data.
  await assert.rejects(() => withView(() => {
    throw new Error("paint must not run on a failed source");
  }), /tier 1 unavailable/);
});

test("seam: a pending paint survives a failed source and the next view satisfies it", async () => {
  const { renderSeam } = load().live;
  let fail = true;
  const withView = renderSeam(async () => {
    if (fail) throw new Error("transient");
    return { id: "recovered" };
  });
  const painted = [];
  await assert.rejects(() => withView((v) => painted.push(["hero1", v.id])));
  assert.deepEqual(painted, []);
  fail = false;
  await withView((v) => painted.push(["hero2", v.id]));
  assert.deepEqual(painted, [["hero1", "recovered"], ["hero2", "recovered"]]);
});
