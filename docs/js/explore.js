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

  async function run() {
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
      status.textContent = `Query failed: ${err.message}`;
      return;
    }
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

  function renderChart(data, rows, cols, m) {
    const T = C().tokens();
    const top = data.slice(0, 25).reverse();
    C().mount("pChart", {
      type: "bar",
      data: {
        labels: top.map((r) => String(r[rows]).slice(0, 28)),
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
        if (!dim) { sel.innerHTML = '<option value="all">(all)</option>'; return; }
        const vals = await E().query(
          `SELECT DISTINCT ${dim} AS v FROM cube_full WHERE ${dim} IS NOT NULL ORDER BY 1 LIMIT 500`);
        sel.innerHTML = '<option value="all">(all)</option>' +
          vals.map((r) => `<option value="${r.v}">${r.v}</option>`).join("");
      };
      await run();
    } catch (err) {
      status.textContent = `Could not load the query engine: ${err.message}`;
    }
  }

  root.MD = root.MD || {};
  root.MD.explore = { DIMENSIONS, MEASURES, buildSql, run };
  // Guarded so this file stays node-loadable for docs/js/explore.test.js, which
  // stubs window without a document.
  if (typeof document !== "undefined") {
    if (document.readyState !== "loading") init();
    else document.addEventListener("DOMContentLoaded", init);
  }
})(typeof window !== "undefined" ? window : globalThis);
