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

/* ── chart labels with a column dimension set (F1) ─────────────────────────
   Reproduced live: rows=specialty, cols=state_abrvtn, measure=paid returned
   25 bars with only 11 unique labels -- the same specialty repeated once per
   state, indistinguishable on the chart even though the table (which renders
   rows/cols as separate columns) was correct. */
test("chart label is rows alone when no column dimension is set", () => {
  const { chartLabel } = load();
  const label = chartLabel({ specialty: "Cardiology", value: 1 }, "specialty", "");
  assert.equal(label, "Cardiology");
});

test("chart label qualifies with cols so repeated rows values are distinguishable", () => {
  const { chartLabel } = load();
  const a = chartLabel({ specialty: "Internal Medicine", state_abrvtn: "NY", value: 1 },
    "specialty", "state_abrvtn");
  const b = chartLabel({ specialty: "Internal Medicine", state_abrvtn: "CA", value: 2 },
    "specialty", "state_abrvtn");
  assert.notEqual(a, b);
  assert.match(a, /NY/);
  assert.match(b, /CA/);
});

/* ── run()'s stale-response guard ──────────────────────────────────────────
   Fix round 2, F2: run() paints unconditionally when its query resolves, so a
   slow response landing after a faster, newer one used to overwrite the
   table with stale data. The fix is the same monotonic-counter shape as
   live.js's renderSeam. Exercising it needs a minimal DOM, since run() (unlike
   live.js's pure viewFromQueries) reads/writes elements directly -- so this
   loader stubs just enough of `document` for run() and its two renderers to
   complete without touching a real browser. isSupported() is false so init()
   bails out immediately after wiring pRun/theme, and never calls run() or
   registers pFilterDim.onchange itself; the test calls run() directly. */
function loadWithDom() {
  const els = {
    pRows: { value: "specialty" }, pCols: { value: "" }, pMeasure: { value: "paid" },
    pFilterDim: { value: "" }, pFilterVal: { value: "" },
    pStatus: { textContent: "" }, pTable: { innerHTML: "" },
    pChart: {}, pRun: {}, theme: {},
  };
  const resolvers = [];
  const win = {
    MD: {
      engine: {
        isSupported: () => false,
        query: () => new Promise((resolve) => resolvers.push(resolve)),
      },
      format: { money: (v) => String(v), count: (v) => String(v), pct: (v) => String(v) },
      charts: {
        readTokens: () => {}, tokens: () => ({ s1: "x" }),
        axisOpts: () => ({}), legendOpts: () => ({}), tooltipOpts: () => ({}),
        mount: () => {},
      },
    },
  };
  global.window = win;
  global.document = { getElementById: (id) => els[id] };
  eval(SRC);
  // NOT deleted here -- run() is called after loadWithDom() returns and still
  // needs `document` to exist. Each test deletes it in a `finally`, so a
  // later plain load() (which expects `typeof document === "undefined"`)
  // never inherits it.
  return { run: win.MD.explore.run, els, resolvers };
}

test("a slow query resolving after a fast one does not paint", async () => {
  const { run, els, resolvers } = loadWithDom();
  try {
    els.pRows.value = "specialty";
    const slow = run();                    // request #1: resolves last
    els.pRows.value = "state_abrvtn";
    const fast = run();                    // request #2: resolves first

    resolvers[1]([{ state_abrvtn: "NY", value: 2 }]);
    await fast;
    resolvers[0]([{ specialty: "Cardiology", value: 1 }]);
    await slow;

    assert.match(els.pTable.innerHTML, /NY/);
    assert.doesNotMatch(els.pTable.innerHTML, /Cardiology/);
  } finally {
    delete global.document;
  }
});

test("a slow query that errors after a fast success does not overwrite the status line", async () => {
  const { run, els, resolvers } = loadWithDom();
  try {
    const slow = run();                    // request #1: rejects last
    const fast = run();                    // request #2: resolves first

    resolvers[1]([{ specialty: "Cardiology", value: 1 }]);
    await fast;
    const statusAfterFast = els.pStatus.textContent;
    resolvers[0](Promise.reject(new Error("boom")));
    await slow;

    assert.equal(els.pStatus.textContent, statusAfterFast);
  } finally {
    delete global.document;
  }
});

/* Task 10: the SQL box. isReadOnly and wrapForCap are the two pieces of string
   logic standing between a visitor's free-form query and what DuckDB actually
   runs -- see the controller notes' item 4 (stacked statements) and item 3
   (the row cap must bound the fetch, not just the render). */

test("isReadOnly accepts a bare SELECT and a bare WITH", () => {
  const { isReadOnly } = load();
  assert.equal(isReadOnly("SELECT 1"), true);
  assert.equal(isReadOnly("WITH x AS (SELECT 1) SELECT * FROM x"), true);
});

test("isReadOnly accepts a single trailing semicolon", () => {
  const { isReadOnly } = load();
  assert.equal(isReadOnly("SELECT 1;"), true);
  assert.equal(isReadOnly("SELECT 1;\n"), true);
});

test("isReadOnly rejects a stacked statement after a valid one", () => {
  const { isReadOnly } = load();
  assert.equal(isReadOnly("SELECT 1; DROP TABLE cube_full"), false);
});

test("isReadOnly rejects anything not starting with SELECT/WITH", () => {
  const { isReadOnly } = load();
  assert.equal(isReadOnly("DROP TABLE cube_full"), false);
  assert.equal(isReadOnly("DELETE FROM cube_full"), false);
});

test("isReadOnly strips line and block comments before checking", () => {
  const { isReadOnly } = load();
  assert.equal(isReadOnly("-- comment\nSELECT 1"), true);
  assert.equal(isReadOnly("/* comment */ SELECT 1"), true);
  // A comment cannot be used to hide a stacked statement.
  assert.equal(isReadOnly("SELECT 1; /* comment */ DROP TABLE cube_full"), false);
});

test("wrapForCap wraps a plain SELECT in a LIMIT-ed CTE", () => {
  const { wrapForCap } = load();
  const sql = wrapForCap("SELECT * FROM cube_full");
  assert.match(sql, /^WITH __sql_box AS \(SELECT \* FROM cube_full\) SELECT \* FROM __sql_box LIMIT 5001$/);
});

test("wrapForCap nests a query that already starts with WITH", () => {
  const { wrapForCap } = load();
  const sql = wrapForCap("WITH x AS (SELECT 1 AS v) SELECT * FROM x");
  assert.match(sql, /^WITH __sql_box AS \(WITH x AS \(SELECT 1 AS v\) SELECT \* FROM x\) SELECT \* FROM __sql_box LIMIT 5001$/);
});

test("wrapForCap drops a trailing semicolon before wrapping", () => {
  const { wrapForCap } = load();
  const sql = wrapForCap("SELECT 1;");
  assert.doesNotMatch(sql, /;\)/);
  assert.match(sql, /^WITH __sql_box AS \(SELECT 1\) SELECT \* FROM __sql_box LIMIT 5001$/);
});
