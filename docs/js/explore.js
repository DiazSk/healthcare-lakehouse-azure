/* Pivot builder over the full cube.

   Uses cube_full (tier 3, 18.88 MB) as a registered VIEW, so DuckDB range-reads only
   the row groups a query touches instead of downloading the file. Locally, Python's
   http.server ignores Range and reads the whole file -- slower there than on
   GitHub Pages, which serves 206 partial responses. That is expected, not a bug.

   Sibling modules are read through getter functions rather than destructured at
   IIFE time, the same reason live.js does it: this file has to stay loadable under
   node with window.MD stubbed (docs/js/explore.test.js), and script order should
   not be a landmine. */
(function (root) {
  "use strict";

  const E = () => root.MD.engine;
  const F = () => root.MD.format;
  const C = () => root.MD.charts;

  const DIMENSIONS = [
    { key: "specialty", label: "Specialty" },
    { key: "state_abrvtn", label: "State" },
    { key: "provider_tier", label: "Credential tier" },
    { key: "ruca_bucket", label: "Rurality (RUCA)" },
    { key: "hcpcs_cd", label: "Procedure code" },
    { key: "place_of_srvc", label: "Place of service" },
    { key: "is_participating", label: "Participating" },
    { key: "is_drug", label: "Drug code" },
    { key: "is_rural", label: "Rural" },
  ];

  // Ratios are SUM/SUM, never AVG(ratio) -- see powerbi/MEASURES.md.
  const MEASURES = [
    { key: "paid",   label: "Medicare paid",     sql: "SUM(Tot_Mdcr_Pymt_Amt_sum)", format: (v) => F().money(v) },
    { key: "sbmtd",  label: "Submitted charges", sql: "SUM(Tot_Sbmtd_Chrg_sum)",    format: (v) => F().money(v) },
    { key: "alowd",  label: "Medicare allowed",  sql: "SUM(Tot_Mdcr_Alowd_Amt_sum)", format: (v) => F().money(v) },
    { key: "svcs",   label: "Services",          sql: "SUM(Tot_Srvcs_sum)",          format: (v) => F().count(v) },
    { key: "benes",  label: "Beneficiary proxy", sql: "SUM(Tot_Benes_sum)",          format: (v) => F().count(v) },
    // `ratio: true` marks the two measures where SUM/SUM can divide two tiny
    // numbers at a fine grain (one rare procedure code, a near-zero allowed
    // amount) and produce an arithmetically correct but startling-looking
    // value. buildSql carries the row's service volume alongside those two
    // ONLY -- see the ratio branch below -- so the table can show the
    // denominator instead of hiding the row. Additive measures have no
    // equivalent failure mode and get no extra column.
    { key: "markup", label: "Markup ratio", ratio: true,
      sql: "SUM(Tot_Sbmtd_Chrg_sum) / NULLIF(SUM(Tot_Mdcr_Alowd_Amt_sum), 0)",
      format: (v) => (v == null ? "—" : v.toFixed(2) + "x") },
    { key: "rate",   label: "Payment rate", ratio: true,
      sql: "SUM(Tot_Mdcr_Pymt_Amt_sum) / NULLIF(SUM(Tot_Mdcr_Alowd_Amt_sum), 0)",
      format: (v) => F().pct(v, 1) },
    { key: "geoprem", label: "Geographic premium",
      sql: "SUM(Tot_Mdcr_Pymt_Amt_sum) - SUM(Tot_Mdcr_Stdzd_Amt_sum)", format: (v) => F().money(v) },
  ];

  const qlit = (v) => `'${String(v).replace(/'/g, "''")}'`;

  function buildSql({ rows, cols, measure, filters }) {
    const m = MEASURES.find((x) => x.key === measure);
    const group = cols ? `${rows}, ${cols}` : rows;
    const where = (filters || [])
      .filter((f) => f.dim && f.val && f.val !== "all")
      .map((f) => `${f.dim} = ${qlit(f.val)}`);
    // Never a floor (this project renders thin samples with a badge, it does
    // not suppress them -- hero 2's badgeH2 is the precedent). Instead, a
    // ratio measure carries its own denominator's volume along for display.
    const volume = m.ratio ? ",\n             SUM(Tot_Srvcs_sum) AS _svcs" : "";
    return `
      SELECT ${group},
             ${m.sql} AS value${volume}
      FROM cube_full
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      GROUP BY ${group}
      ORDER BY value DESC NULLS LAST
      LIMIT 200`.trim();
  }

  function fill(sel, items, allowNone) {
    sel.innerHTML = (allowNone ? '<option value="">(none)</option>' : "") +
      items.map((d) => `<option value="${d.key ?? d}">${d.label ?? d}</option>`).join("");
  }

  // Monotonic request counter, the same shape live.js's renderSeam uses for the
  // findings page (see its "a stale view never paints over a newer one" tests).
  // The explorer has one paint target rather than six, so a bare counter check
  // before painting is enough -- no pending-paint queue needed.
  let _seq = 0;

  async function run() {
    const seq = ++_seq;
    const rows = document.getElementById("pRows").value;
    const cols = document.getElementById("pCols").value;
    const measure = document.getElementById("pMeasure").value;
    const filters = [{
      dim: document.getElementById("pFilterDim").value,
      val: document.getElementById("pFilterVal").value,
    }];
    const status = document.getElementById("pStatus");
    status.textContent = "Querying…";

    const t0 = performance.now();
    let data;
    try {
      data = await E().query(buildSql({ rows, cols, measure, filters }));
    } catch (err) {
      if (seq !== _seq) return; // a newer request already resolved
      status.textContent = `Query failed: ${err.message}`;
      return;
    }
    if (seq !== _seq) return; // superseded -- a newer run() already painted

    const ms = Math.round(performance.now() - t0);
    status.textContent = `${F().count(data.length)} groups in ${ms} ms`;

    const m = MEASURES.find((x) => x.key === measure);
    renderTable(data, rows, cols, m);
    renderChart(data, rows, cols, m);
  }

  // Column defs carry their own alignment rather than inferring it from
  // position ("everything but the last is a label"), which broke the moment a
  // ratio measure added a second numeric column after the value column.
  function tableColumns(rows, cols, m) {
    return [
      { label: rows, numeric: false, render: (r) => r[rows] },
      cols ? { label: cols, numeric: false, render: (r) => r[cols] } : null,
      { label: m.label, numeric: true, render: (r) => m.format(r.value) },
      // Never labelled as providers -- see the static disclaimer under the
      // table. This is SUM(Tot_Srvcs_sum) at whatever grain is selected.
      m.ratio ? { label: "Services at this grain", numeric: true,
                  render: (r) => F().count(r._svcs) } : null,
    ].filter(Boolean);
  }

  function renderTable(data, rows, cols, m) {
    const columns = tableColumns(rows, cols, m);
    document.getElementById("pTable").innerHTML =
      `<thead><tr>${columns.map((c) =>
        `<th class="${c.numeric ? "" : "l"}">${c.label}</th>`).join("")}</tr></thead>`
      + `<tbody>${data.slice(0, 200).map((r) =>
          `<tr>${columns.map((c) =>
            `<td class="${c.numeric ? "" : "l"}">${c.render(r)}</td>`).join("")}</tr>`
        ).join("")}</tbody>`;
  }

  // With a column dimension set, cube_full legitimately returns several rows
  // per `rows` value (one per cols value), so the top-25 slice can contain the
  // same rows label repeated at different heights with nothing to tell them
  // apart. Budget the existing 28-char cap across both values rather than
  // labelling with `rows` alone and leaving `cols` invisible.
  function chartLabel(r, rows, cols) {
    if (!cols) return String(r[rows]).slice(0, 28);
    const budget = Math.floor((28 - 3) / 2); // " · " separator takes 3
    return `${String(r[rows]).slice(0, budget)} · ${String(r[cols]).slice(0, budget)}`;
  }

  function renderChart(data, rows, cols, m) {
    const T = C().tokens();
    const top = data.slice(0, 25).reverse();
    C().mount("pChart", {
      type: "bar",
      data: {
        labels: top.map((r) => chartLabel(r, rows, cols)),
        datasets: [{
          label: m.label, data: top.map((r) => r.value),
          backgroundColor: T.s1, borderWidth: 0, borderRadius: 2,
        }],
      },
      options: {
        // Horizontal once labels are many -- vertical ticks become unreadable.
        indexAxis: top.length > 8 ? "y" : "x",
        plugins: {
          legend: C().legendOpts(false),
          tooltip: C().tooltipOpts({ label: (c) => ` ${m.format(c.raw)}` }),
        },
        scales: {
          x: C().axisOpts(m.label, (v) => m.format(v)),
          y: C().axisOpts(null, null, { grid: { display: false } }),
        },
      },
    });
  }

  async function init() {
    C().readTokens();
    fill(document.getElementById("pRows"), DIMENSIONS);
    fill(document.getElementById("pCols"), DIMENSIONS, true);
    fill(document.getElementById("pMeasure"), MEASURES);
    fill(document.getElementById("pFilterDim"), DIMENSIONS, true);
    document.getElementById("pRun").onclick = run;
    document.getElementById("theme").onclick = () => {
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
      C().readTokens();
      run();
    };

    const status = document.getElementById("pStatus");
    if (!E().isSupported()) {
      status.textContent = "This browser cannot run the query engine. "
        + "The findings page works without it.";
      return;
    }
    E().onProgress(({ phase, loaded, total }) => {
      status.textContent = `loading ${phase} (${loaded}/${total})…`;
    });
    try {
      await E().loadTier(3);
      // Populate filter values from the data itself rather than hardcoding.
      document.getElementById("pFilterDim").onchange = async (ev) => {
        const dim = ev.target.value;
        const sel = document.getElementById("pFilterVal");
        // Option(), not template-string markup: values come from a SELECT
        // DISTINCT over the dataset, and the DOM API sets text/value as data
        // rather than parsing them as HTML, so there is nothing to escape.
        sel.innerHTML = "";
        sel.appendChild(new Option("(all)", "all"));
        if (!dim) return;
        const vals = await E().query(
          `SELECT DISTINCT ${dim} AS v FROM cube_full WHERE ${dim} IS NOT NULL ORDER BY 1 LIMIT 500`);
        vals.forEach((r) => sel.appendChild(new Option(String(r.v), r.v)));
      };
      await run();
    } catch (err) {
      status.textContent = `Could not load the query engine: ${err.message}`;
    }
    initSql();
  }

  const SQL_MAX_ROWS = 5000;
  const SQL_TIMEOUT_MS = 5000;

  const SQL_EXAMPLES = [
    {
      label: "Top specialties by markup",
      sql: `SELECT specialty,
       SUM(Tot_Sbmtd_Chrg_sum) / SUM(Tot_Mdcr_Alowd_Amt_sum) AS markup,
       SUM(Tot_Srvcs_sum) AS services
FROM cube_full
GROUP BY 1
HAVING SUM(Tot_Srvcs_sum) > 100000
ORDER BY markup DESC
LIMIT 20`,
    },
    {
      label: "Facility vs office, one code",
      sql: `SELECT place_of_srvc,
       SUM(Tot_Mdcr_Pymt_Amt_sum) / SUM(Tot_Srvcs_sum) AS pymt_per_service,
       SUM(Tot_Srvcs_sum) AS services
FROM cube_full
WHERE hcpcs_cd = '66984'
GROUP BY 1`,
    },
    {
      label: "Geographic premium by state",
      sql: `SELECT state_abrvtn,
       SUM(Tot_Mdcr_Pymt_Amt_sum) - SUM(Tot_Mdcr_Stdzd_Amt_sum) AS geo_premium
FROM cube_full
WHERE in_top50_basket
GROUP BY 1
ORDER BY geo_premium DESC`,
    },
  ];

  // Fix round 1 (Task 10 review F1/F2): isReadOnly and wrapForCap each did
  // their own ad-hoc trimming and disagreed with each other -- isReadOnly
  // false-rejected a semicolon that was really inside a string literal
  // (SELECT ';' AS x), and wrapForCap left a trailing comment in place before
  // stripping the semicolon, so a comment at the very end of the query ate
  // the cap wrapper's closing paren. Both now go through one normalize().
  function stripComments(text) {
    return text.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }

  // SQL escapes a quote inside a string literal by doubling it (''). Blanking
  // a literal to a same-shaped stand-in is for SCANNING only -- it is never
  // sent to DuckDB -- so a semicolon or comment marker inside user data is
  // never mistaken for SQL syntax.
  function blankStrings(text) {
    return text.replace(/'(?:[^']|'')*'/g, "''");
  }

  // The text DuckDB will actually run: comments and a single trailing
  // semicolon removed. Comments carry no semantic meaning, so dropping them
  // changes nothing DuckDB would execute, and it's what makes the cap
  // wrapper's closing paren safe from a trailing "-- comment".
  function normalize(text) {
    return stripComments(text).trim().replace(/;\s*$/, "").trim();
  }

  /* DuckDB-WASM is sandboxed in the browser, so this is UX rather than security:
     it turns "why did nothing happen" into a clear message. */
  function isReadOnly(text) {
    const real = normalize(text);
    if (!/^(select|with)\b/i.test(real)) return false;
    // Scan a string-blanked copy for a stacked statement so a semicolon
    // inside a literal is never counted as one (e.g. SELECT ';' AS x).
    return !blankStrings(real).includes(";");
  }

  // Wraps the query so DuckDB pushes the LIMIT down instead of the browser
  // materialising every row before we slice it -- SELECT * FROM cube_full is
  // 863,230 rows and would otherwise freeze the tab. A CTE body may itself
  // start with WITH, so this nests fine for queries that already do. Uses
  // the same normalize() as isReadOnly -- never the string-blanked copy --
  // so the query DuckDB runs still has its real string contents.
  function wrapForCap(text) {
    return `WITH __sql_box AS (${normalize(text)}) SELECT * FROM __sql_box LIMIT ${SQL_MAX_ROWS + 1}`;
  }

  async function runSql(text) {
    if (!isReadOnly(text)) {
      return { rows: [], ms: 0, error: "Only SELECT and WITH queries are allowed here." };
    }
    const t0 = performance.now();
    try {
      const rows = await Promise.race([
        E().query(wrapForCap(text)),
        // ponytail: Promise.race abandons the wait, it does not cancel the
        // query -- DuckDB keeps running it in the worker. The LIMIT pushdown
        // above is what actually keeps a runaway query cheap; this timeout is
        // only a backstop so a slow query doesn't hang the status line.
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(
            `Query exceeded ${SQL_TIMEOUT_MS / 1000}s — try narrowing it with a WHERE clause.`)),
            SQL_TIMEOUT_MS)),
      ]);
      return { rows, ms: Math.round(performance.now() - t0), error: null };
    } catch (err) {
      return { rows: [], ms: Math.round(performance.now() - t0), error: err.message };
    }
  }

  function renderSqlTable(rows) {
    const el = document.getElementById("sqlTable");
    if (!rows.length) { el.innerHTML = ""; return; }
    const cols = Object.keys(rows[0]);
    const shown = rows.slice(0, SQL_MAX_ROWS);
    const fmt = (v) =>
      v === null || v === undefined ? "—"
      : typeof v === "number" ? (Number.isInteger(v) ? F().count(v) : v.toFixed(2))
      : String(v);
    el.innerHTML =
      `<thead><tr>${cols.map((c) => `<th class="l">${c}</th>`).join("")}</tr></thead>`
      + `<tbody>${shown.map((r) =>
          `<tr>${cols.map((c) => {
            const v = r[c];
            const num = typeof v === "number";
            return `<td class="${num ? "" : "l"}">${fmt(v)}</td>`;
          }).join("")}</tr>`).join("")}</tbody>`;
  }

  function initSql() {
    const box = document.getElementById("sqlText");
    const status = document.getElementById("sqlStatus");
    box.value = SQL_EXAMPLES[0].sql;

    document.getElementById("sqlExamples").innerHTML = SQL_EXAMPLES.map((ex, i) =>
      `<button class="toggle" data-ex="${i}" type="button">${ex.label}</button>`).join("");
    document.querySelectorAll("#sqlExamples button").forEach((b) => {
      b.onclick = () => { box.value = SQL_EXAMPLES[+b.dataset.ex].sql; };
    });

    document.getElementById("sqlRun").onclick = async () => {
      status.textContent = "Running…";
      const { rows, ms, error } = await runSql(box.value);
      if (error) {
        status.textContent = error;      // DuckDB's messages are good; show them verbatim
        renderSqlTable([]);
        return;
      }
      const over = rows.length > SQL_MAX_ROWS;
      const capped = over ? ` (showing the first ${F().count(SQL_MAX_ROWS)})` : "";
      status.textContent = `${F().count(over ? SQL_MAX_ROWS : rows.length)} rows in ${ms} ms${capped}`;
      renderSqlTable(rows);
    };
  }

  root.MD = root.MD || {};
  // chartLabel is exported for docs/js/explore.test.js, the same reason
  // live.js exports renderSeam: a pure helper worth a direct unit test even
  // though callers outside this file only need buildSql/run.
  // wrapForCap is exported alongside isReadOnly for the same reason as
  // chartLabel above: pure string logic worth testing directly from node.
  root.MD.explore = {
    DIMENSIONS, MEASURES, buildSql, run, chartLabel, runSql, isReadOnly, wrapForCap,
  };
  // Guarded so this file stays node-loadable for docs/js/explore.test.js, which
  // stubs window without a document.
  if (typeof document !== "undefined") {
    if (document.readyState !== "loading") init();
    else document.addEventListener("DOMContentLoaded", init);
  }
})(typeof window !== "undefined" ? window : globalThis);
