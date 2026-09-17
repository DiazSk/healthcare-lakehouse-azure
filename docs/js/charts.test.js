// Run: node --test docs/js/*.test.js   (the directory form is broken on Node 24)
/* Tripwire on axisOpts' tick-formatter guard.

   axisOpts used to unconditionally set `ticks: { ..., callback: fmt }`. When
   fmt is null -- every category axis with no value formatter: state codes,
   drug HCPCS codes, credential-markup HCPCS codes, site-differential HCPCS
   codes -- that does NOT fall back to Chart.js's own tick formatter. It
   explicitly overrides it with null; Chart.js's callCallback(null, ...)
   returns undefined for every tick, and the axis draws no labels at all.
   Reproduced live on cGeo, cJcode, cCred and cSiteBar (four of the eight
   findings-page charts), and inherited identically by explore.js.

   cNonPar/cNonParAbs happened to be fine: their `extra` argument supplies its
   own `ticks: {...}`, which Object.assign replaces wholesale, so they never
   reached the broken branch. That's also why this needs a test at the
   Object.assign boundary, not just at the two obviously-broken shapes. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "charts.js"), "utf8");

// charts.js touches Chart.defaults at IIFE-call time; readTokens()/mount()
// touch getComputedStyle/document/Chart's constructor, but this file never
// calls either, so only the load-time reference needs stubbing.
function load() {
  global.Chart = { defaults: { font: {} } };
  const win = {};
  global.window = win;
  eval(SRC);
  delete global.Chart;
  return win.MD.charts;
}

test("axisOpts sets no tick callback when no formatter is given", () => {
  const { axisOpts } = load();
  const opts = axisOpts(null, null, {});
  assert.ok(!("callback" in opts.ticks),
    "a null formatter must not become a tick callback -- Chart.js needs the key absent, not null, to use its own default");
});

test("axisOpts sets the tick callback when a formatter is given", () => {
  const { axisOpts } = load();
  const fmt = (v) => `${v}x`;
  const opts = axisOpts("Title", fmt);
  assert.equal(opts.ticks.callback, fmt);
});

test("an extra.ticks override still replaces ticks wholesale", () => {
  // Pins the accidental-correctness path (cNonPar/cNonParAbs) so a future
  // refactor of the Object.assign shape doesn't silently change it.
  const { axisOpts } = load();
  const opts = axisOpts(null, null, { ticks: { color: "red" } });
  assert.deepEqual(opts.ticks, { color: "red" });
});
