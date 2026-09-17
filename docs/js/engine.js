/* DuckDB-WASM lifecycle. Nothing here knows about panels or charts.

   Pinned to 1.32.0: npm's `latest` tag points at a dev prerelease (1.33.1-dev57.0).
   The `eh` bundle is mandatory -- GitHub Pages cannot set COOP/COEP headers, so
   SharedArrayBuffer is unavailable and the multithreaded build cannot initialise.

   Loaded by dynamic import() rather than a script tag, because DuckDB ships as an
   ES module. That means explore mode does not work over file:// -- an accepted,
   handled path: status() returns "unavailable" and the page stays on the static
   payload. */
(function (root) {
  "use strict";

  const VERSION = "1.32.0";
  const CDN = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${VERSION}/dist`;
  const BUNDLE = {
    mainModule: `${CDN}/duckdb-eh.wasm`,
    mainWorker: `${CDN}/duckdb-browser-eh.worker.js`,
  };
  // duckdb-browser.mjs (the package's "module" entry) has a bare `import ...
  // from "apache-arrow"` specifier, which a raw browser import() cannot resolve
  // without an import map. jsdelivr's package-root `+esm` endpoint rewrites that
  // to an absolute URL for us -- confirmed by diffing its output against
  // dist/duckdb-browser.mjs, which it wraps verbatim. Binary assets (wasm,
  // worker) stay pinned to the plain `dist/` path above.
  const ESM_ENTRY = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${VERSION}/+esm`;

  // Tiered so a visitor who only reads the narrative downloads nothing.
  // Tier 1 also carries cube_code_h4 (the fourth committed Parquet beyond the
  // other three small cubes) -- it belongs with the always-loaded cubes, not
  // behind tier 2/3.
  const TIERS = {
    1: ["cube_dims", "cube_code", "cube_code_h4", "cohorts"],
    2: ["providers_drug"],
    3: ["cube_full", "providers"],
  };

  let _status = "idle";
  let _db = null;
  let _conn = null;
  let _bootPromise = null;
  const _tierPromises = {};
  const _loaded = new Set();
  const _progress = [];

  function isSupported() {
    return typeof WebAssembly === "object" && typeof Worker === "function"
      // DuckDB arrives via dynamic import() of a cross-origin ES module, which
      // file:// blocks outright. Reporting false here makes the toggle explain
      // itself immediately instead of after a multi-second boot timeout.
      && location.protocol !== "file:";
  }

  // An un-awaited boot()/loadTier() would otherwise surface as an
  // unhandledrejection. Swallow it on an internal branch only -- the promise we
  // hand back still rejects, so failure stays visible to whoever awaits it.
  function latch(p) {
    p.catch(() => {});
    return p;
  }

  const status = () => _status;
  const onProgress = (cb) => _progress.push(cb);
  const emit = (phase, loaded, total) =>
    _progress.forEach((cb) => cb({ phase, loaded, total }));

  function boot() {
    if (_bootPromise) return _bootPromise;
    if (!isSupported()) {
      _status = "unavailable";
      return latch(Promise.reject(
        new Error("WebAssembly, Web Workers or a non-file:// origin unavailable")));
    }
    _status = "booting";
    emit("engine", 0, 1);
    _bootPromise = latch((async () => {
      const duckdb = await import(ESM_ENTRY);
      // `new Worker(crossOriginURL)` is blocked outright (not just by CORS) --
      // browsers only allow same-origin worker scripts. The standard duckdb-wasm
      // workaround is a same-origin Blob shim that importScripts() the real,
      // cross-origin worker file; importScripts is permitted cross-origin.
      const workerShim = URL.createObjectURL(
        new Blob([`importScripts("${BUNDLE.mainWorker}");`], { type: "text/javascript" })
      );
      const worker = new Worker(workerShim);
      const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
      _db = new duckdb.AsyncDuckDB(logger, worker);
      await _db.instantiate(BUNDLE.mainModule);
      _conn = await _db.connect();
      _status = "ready";
      emit("engine", 1, 1);
    })().catch((err) => {
      _status = "unavailable";
      _bootPromise = null;      // allow a later retry
      throw err;
    }));
    return _bootPromise;
  }

  /* Re-entrant on purpose. The `_loaded` set only helps AFTER a load finishes, so
     two overlapping loadTier(1) calls -- exactly what the live toggle and
     viewFromQueries produce -- each downloaded all four Parquet files (7.7 MB
     instead of 3.87) and raced CREATE OR REPLACE TABLE on one connection. Latch
     the in-flight promise per tier, the way boot() latches _bootPromise. */
  function loadTier(n) {
    const names = TIERS[n];
    if (!names) return latch(Promise.reject(new Error(`no such tier: ${n}`)));
    if (names.every((t) => _loaded.has(t))) return Promise.resolve();
    if (_tierPromises[n]) return _tierPromises[n];
    _tierPromises[n] = latch(load(n, names).catch((err) => {
      _tierPromises[n] = null;  // allow a later retry
      throw err;
    }));
    return _tierPromises[n];
  }

  async function load(n, names) {
    await boot();

    // Tier 3 is registered rather than copied: DuckDB range-reads only the row
    // groups and columns a query touches, so a 52 MB pair of files costs a few
    // MB to use.
    const remote = n === 3;
    let done = 0;
    for (const name of names) {
      if (_loaded.has(name)) { done += 1; continue; }
      emit(`data:${name}`, done, names.length);
      const url = new URL(`data/${name}.parquet`, document.baseURI).href;
      await _conn.query(
        remote
          ? `CREATE OR REPLACE VIEW ${name} AS SELECT * FROM read_parquet('${url}')`
          : `CREATE OR REPLACE TABLE ${name} AS SELECT * FROM read_parquet('${url}')`
      );
      _loaded.add(name);
      done += 1;
      emit(`data:${name}`, done, names.length);
    }
  }

  async function query(sql) {
    if (_status !== "ready") await boot();
    const result = await _conn.query(sql);
    // Arrow -> plain objects. Two integer shapes have to be narrowed here:
    // BigInt breaks JSON and Chart.js, and SUM() over a BIGINT column widens to
    // HUGEINT, which Arrow hands back as a Decimal -- a Uint32Array subclass
    // whose toString is correct but whose arithmetic and toLocaleString are not
    // (`0 + benes` string-concatenates; count(benes) prints "824,724,417,0,0,0").
    // Measured against SUM(Tot_Benes_sum): it poisons hero 1's per-beneficiary
    // scale and every cohort count that reaches a tooltip.
    return result.toArray().map((row) => {
      const out = {};
      for (const [k, v] of Object.entries(row.toJSON())) {
        out[k] = typeof v === "bigint" || ArrayBuffer.isView(v) ? Number(v) : v;
      }
      return out;
    });
  }

  root.MD = root.MD || {};
  root.MD.engine = { isSupported, status, boot, loadTier, query, onProgress };
})(window);
