// Run: node --test docs/js/*.test.js   (the directory form is broken on Node 24)
/* Tripwire on explore.js's SQL builder.

   Task 8's review found that untested SQL let a known-wrong table name pass every
   check (see live.test.js's header). buildSql is the equivalent risk here: it is
   the only thing standing between a visitor's pivot choice and a query DuckDB
   actually runs, and a slipped AVG(ratio) or an unescaped filter value would look
   fine until read closely. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "explore.js"), "utf8");

// window with no `document` -- explore.js guards its own auto-init on that, so
// eval()ing the source must not throw and must not try to touch the DOM.
function load() {
  const win = { MD: {} };
  global.window = win;
  eval(SRC);
  return win.MD.explore;
}

test("buildSql reads FROM cube_full", () => {
  const { buildSql } = load();
  const sql = buildSql({ rows: "specialty", cols: "", measure: "paid", filters: [] });
  assert.match(sql, /FROM cube_full/);
});

test("a plain measure's aggregate appears in the SELECT", () => {
  const { buildSql } = load();
  const sql = buildSql({ rows: "specialty", cols: "", measure: "paid", filters: [] });
  assert.match(sql, /SUM\(Tot_Mdcr_Pymt_Amt_sum\) AS value/);
});

test("ratio measures are SUM/SUM, never AVG(ratio)", () => {
  const { buildSql, MEASURES } = load();
  for (const key of ["markup", "rate"]) {
    const sql = buildSql({ rows: "specialty", cols: "", measure: key, filters: [] });
    assert.doesNotMatch(sql, /AVG\(/i, `${key} must not average a ratio`);
    const m = MEASURES.find((x) => x.key === key);
    assert.match(m.sql, /^SUM\(.*\) \/ NULLIF\(SUM\(.*\), 0\)$/,
      `${key}'s sql must be SUM(...)/NULLIF(SUM(...),0)`);
  }
});

test("no cols selected groups by rows alone", () => {
  const { buildSql } = load();
  const sql = buildSql({ rows: "specialty", cols: "", measure: "paid", filters: [] });
  assert.match(sql, /GROUP BY specialty\s*$/m);
});

test("cols selected groups by both rows and cols", () => {
  const { buildSql } = load();
  const sql = buildSql({ rows: "specialty", cols: "state_abrvtn", measure: "paid", filters: [] });
  assert.match(sql, /GROUP BY specialty, state_abrvtn/);
  assert.match(sql, /SELECT specialty, state_abrvtn,/);
});

test("a filter value containing an apostrophe is escaped", () => {
  const { buildSql } = load();
  const sql = buildSql({
    rows: "specialty", cols: "", measure: "paid",
    filters: [{ dim: "specialty", val: "O'Brien" }],
  });
  assert.match(sql, /specialty = 'O''Brien'/);
});

test("ratio measures carry a service-volume column; additive measures do not", () => {
  const { buildSql } = load();
  // Fix round 1: a ratio measure at a fine grain can legitimately divide two
  // tiny sums (one rare procedure code, a near-zero allowed amount) into a
  // huge but correct value. The project's rule is explain, never suppress
  // (hero 2's badgeH2 precedent), so the row's service volume rides along.
  for (const key of ["markup", "rate"]) {
    const sql = buildSql({ rows: "hcpcs_cd", cols: "", measure: key, filters: [] });
    assert.match(sql, /SUM\(Tot_Srvcs_sum\) AS _svcs/, `${key} must carry _svcs`);
  }
  // Additive measures have no such failure mode and must not gain the column.
  for (const key of ["paid", "sbmtd", "alowd", "svcs", "benes", "geoprem"]) {
    const sql = buildSql({ rows: "specialty", cols: "", measure: key, filters: [] });
    assert.doesNotMatch(sql, /_svcs/, `${key} must not carry _svcs`);
  }
});

test("only markup and rate are flagged as ratio measures", () => {
  const { MEASURES } = load();
  const ratioKeys = MEASURES.filter((m) => m.ratio).map((m) => m.key).sort();
  assert.deepEqual(ratioKeys, ["markup", "rate"]);
});

test("a filter of 'all' or an empty dim is dropped, not turned into a WHERE clause", () => {
  const { buildSql } = load();
  const sql = buildSql({
    rows: "specialty", cols: "", measure: "paid",
    filters: [{ dim: "state_abrvtn", val: "all" }, { dim: "", val: "NY" }],
  });
  assert.doesNotMatch(sql, /WHERE/);
});
