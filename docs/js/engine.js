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

  /* Arrow -> plain objects. Three numeric shapes are narrowed here so no caller
     has to know about any of them:

     - BigInt (a BIGINT column) breaks JSON and Chart.js.
     - SUM() over a BIGINT widens to HUGEINT, which Arrow returns as a Decimal:
       a Uint32Array subclass holding 128-bit limbs. Its toString is right, but
       its arithmetic and toLocaleString are not -- measured on
       SUM(Tot_Benes_sum), `0 + benes` string-concatenates to "029586728" and
       count(benes) prints "824,724,417,0,0,0", which poisoned hero 1's
       per-beneficiary colour scale and every cohort count in a tooltip.
     - A DECIMAL(p,s) column carries a scale Arrow does not apply, so reading the
       limbs alone turns 123.45 into 12345 and a bare SQL `1.5` into 15. Nothing
       in the seven committed artifacts is a scaled decimal, but Task 10 adds a
       visitor-writable SQL box, which makes both that and values past 2^53
       reachable by design -- hence the scale comes off the schema rather than
       being assumed to be zero.

     Deliberately conservative in two directions: a typed array on a field with
     no scale (BLOB, Binary) passes through untouched rather than becoming NaN,
     and an integer past 2^53 degrades to the nearest double instead of throwing,
     because Arrow's own conversion throws there and that would abort a whole
     view into the toggle's "unavailable" path. */
  function decimalToNumber(limbs, scale) {
    let n = 0n;
    for (let i = limbs.length - 1; i >= 0; i -= 1) {
      n = (n << 32n) | BigInt(limbs[i] >>> 0);
    }
    // Two's complement: the high bit of the top limb is the sign.
    if (limbs[limbs.length - 1] & 0x80000000) n -= 1n << BigInt(32 * limbs.length);
    return scale > 0 ? Number(n) / 10 ** scale : Number(n);
  }

  function narrowerFor(field) {
    const type = field && field.type;
    const scale = type && typeof type.scale === "number" ? type.scale : null;
    if (scale === null) return (v) => (typeof v === "bigint" ? Number(v) : v);
    return (v) => {
      if (ArrayBuffer.isView(v)) return decimalToNumber(v, scale);
      if (typeof v === "bigint") return Number(v);
      return v;
    };
  }

  async function query(sql) {
    if (_status !== "ready") await boot();
    const result = await _conn.query(sql);
    const fields = result.schema.fields;
    const narrow = fields.map(narrowerFor);
    return result.toArray().map((row) => {
      const json = row.toJSON();
      const out = {};
      fields.forEach((f, i) => { out[f.name] = narrow[i](json[f.name]); });
      return out;
    });
  }

  root.MD = root.MD || {};
  root.MD.engine = { isSupported, status, boot, loadTier, query, onProgress };
})(window);
