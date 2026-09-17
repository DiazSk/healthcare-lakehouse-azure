// Run: node --test docs/js/*.test.js   (the directory form is broken on Node 24)
/* Tests for the "Reading it" readouts.

   These templates were written against the static payload, where nonpar_stats
   and the kpi block are national regardless of filter. Live mode recomputes them
   per filter -- more correct -- which drove them into sentences nobody had
   written: hero 1 naming one state as both extremes with a $0.00 spread between
   them, hero 2 explaining a phenomenon with zero instances across "1
   specialties", hero 3 claiming "extreme concentration" for any Gini at all.
   All three shipped to the public site, and two review passes missed them
   because both checked values and badges, never the prose under a narrow filter.

   Two jobs here:
   1. PIN the national strings against docs/data.json. Static mode's prose is
      quoted by the README and the article draft; it must not drift.
   2. Exercise the 1-cohort and 0-cohort branches, which only a human clicking
      through filters on a live page could otherwise reach.

   panels.js needs a Chart global at load (charts.js writes Chart.defaults), but
   the readouts themselves are DOM-free, which is why they are exported. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

global.window = {};
global.Chart = { defaults: { font: {}, animation: false, maintainAspectRatio: false } };
for (const f of ["format.js", "guardrails.js", "charts.js", "panels.js"]) {
  eval(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const P = global.window.MD.panels;
const R = P.readouts;
const DATA = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data.json"), "utf8"));
const NO_FILTER = { state: "all", ruca: "all", spec: "all" };

// The same shape index.html's viewFromPayload() builds, for the keys these
// readouts touch.
const nationalView = () => ({
  geo: DATA.geo,
  nonpar: DATA.nonpar,
  nonparStats: DATA.nonpar_stats,
  kpi: DATA.kpi,
});

// What renderHero1 hands hero1Read: states aggregated, then sorted by premium.
const nationalSorted = () => P.geoByState(DATA.geo, NO_FILTER)
  .slice().sort((a, b) => b.premium - a.premium);

/* ── hero 1 ──────────────────────────────────────────────────────────────── */

test("hero 1 national prose is unchanged", () => {
  assert.equal(R.hero1Read(nationalSorted()),
    "Reading it: NY bills $205.9M more than the geographically standardized amount for "
    + "the same work, while OH bills $39.8M less — a spread of $245.7M attributable to "
    + "location, not medicine. Geographic adjustment is deliberate Medicare policy "
    + "(wages and rent differ); the magnitude is what is worth seeing.");
});

test("hero 1 at a single cohort does not name one state as both extremes", () => {
  // State=AK + RUCA=Large rural on the live site produced: "AK bills $2.5M more …
  // while AK bills $2.5M less — a spread of $0.00", which reads as a broken
  // calculation.
  const s = R.hero1Read([{ state: "AK", premium: 2500000, perBene: 25.9 }]);
  assert.match(s, /single cohort/);
  assert.match(s, /AK bills \$2\.5M more/);
  assert.match(s, /\$25\.90 per beneficiary-proxy/);
  assert.doesNotMatch(s, /\$0\.00/);
  assert.doesNotMatch(s, /while/);
  assert.doesNotMatch(s, /spread of/);
  assert.equal(s.match(/AK/g).length, 1, "the state is named more than once");
});

test("hero 1 at a single cohort reports the sign of a negative premium", () => {
  const s = R.hero1Read([{ state: "OH", premium: -39800000, perBene: -6.89 }]);
  assert.match(s, /OH bills \$39\.8M less/);
  assert.doesNotMatch(s, /-\$39\.8M (more|less)/);
});

test("hero 1 at a single cohort omits a missing per-beneficiary figure", () => {
  const s = R.hero1Read([{ state: "MP", premium: 1000, perBene: null }]);
  assert.doesNotMatch(s, /per beneficiary-proxy/);
  assert.doesNotMatch(s, /—\s*\./);
});

test("hero 1 with no cohort says so instead of rendering an empty line", () => {
  assert.equal(R.hero1Read([]),
    "No state matches this filter, so there is no geographic premium to read.");
});

test("hero 1's ramp chip degrades at one and zero cohorts", () => {
  assert.equal(R.hero1Ramp([], 1, Infinity, -Infinity),
    "no mapped state matches this filter");
  assert.equal(R.hero1Ramp([{}], 25.9, 25.9, 25.9),
    "single cohort · $25.90 per beneficiary-proxy");
  // The national form is unchanged.
  assert.equal(R.hero1Ramp([{}, {}], 10.65, -6.89, 24.07),
    "scale ±$10.65 per beneficiary-proxy · actual range -$6.89 to $24.07 "
    + "(beyond the scale is clamped)");
});

/* ── hero 2 ──────────────────────────────────────────────────────────────── */

test("hero 2 national prose is unchanged", () => {
  const v = nationalView();
  assert.equal(R.hero2Read(v),
    "Reading it: only 1,130 of 1,175,213 providers (0.096%) are non-participating. Of 36 "
    + "specialties where both groups appear, 31 show non-participating providers leaving "
    + "patients with LESS exposure, not more — the opposite of the expected direction. The "
    + "likeliest explanation is case mix rather than generosity: the tiny non-par cohorts "
    + "bill a different, cheaper mix of procedures.");
  assert.equal(R.hero2Caveat(v),
    "Why the threshold: all 5 specialties showing a positive premium rest on 11 or fewer "
    + "non-participating providers. Orthopedic Surgery's apparent +2,223% is 11 providers "
    + "measured against 20,699 — a denominator artifact, not a finding, which is why only "
    + "the 7 specialties with at least 30 non-par providers are charted.");
});

// The canonical guardrail case, as the live view returns it for one specialty.
const orthoView = () => {
  const d = DATA.nonpar.find(r => r.specialty === "Orthopedic Surgery");
  return {
    nonpar: [d],
    nonparStats: { specialties_compared: 1, positive: 1, negative: 0, measurable: 0,
      min_nonpar_providers: 30 },
    kpi: DATA.kpi,
  };
};

test("hero 2 at one specialty describes that specialty, not a distribution of one", () => {
  const s = R.hero2Read(orthoView());
  assert.doesNotMatch(s, /Of 1 specialties/);
  assert.doesNotMatch(s, /\b0 show\b/);
  // It must not keep asserting a population-level explanation with no instances.
  assert.doesNotMatch(s, /the opposite of the expected direction/);
  assert.match(s, /In Orthopedic Surgery/);
  assert.match(s, /2223\.2% MORE exposure/);
  assert.match(s, /11 non-participating providers measured against 20,699/);
  // The national scalars stay true at every filter and still open the sentence.
  assert.match(s, /only 1,130 of 1,175,213 providers \(0\.096%\)/);
});

test("hero 2's caveat at one thin specialty explains the badge, not a chart threshold", () => {
  const s = R.hero2Caveat(orthoView());
  // The national wording claimed "only the 0 specialties with at least 30 … are
  // charted" while one was in fact charted, faded.
  assert.doesNotMatch(s, /are charted/);
  assert.match(s, /Why it is badged/);
  assert.match(s, /11 non-participating providers/);
  assert.match(s, /30 is the floor/);
  assert.match(s, /shown faded and labelled rather than hidden/);
});

test("hero 2's caveat at one reliable specialty says why it is NOT badged", () => {
  const d = DATA.nonpar.find(r => r.specialty === "Dermatology");
  const v = { nonpar: [d], kpi: DATA.kpi,
    nonparStats: { specialties_compared: 1, positive: 0, negative: 1, measurable: 1,
      min_nonpar_providers: 30 } };
  assert.match(R.hero2Caveat(v), /Why it is not badged/);
  assert.match(R.hero2Read(v), /In Dermatology.*LESS exposure/);
});

test("hero 2 with nothing to compare says so and drops the caveat", () => {
  const v = { nonpar: [], kpi: DATA.kpi,
    nonparStats: { specialties_compared: 0, positive: 0, negative: 0, measurable: 0,
      min_nonpar_providers: 30 } };
  assert.match(R.hero2Read(v), /No specialty in this filter has providers on both sides/);
  assert.equal(R.hero2Caveat(v), "");
});

/* ── hero 3 ──────────────────────────────────────────────────────────────── */

test("hero 3 national prose is unchanged", () => {
  assert.equal(R.hero3Read(nationalView()),
    "Reading it: across 221,364 providers who billed at least one drug code, the top 1% of "
    + "prescribers account for 48.9% of it, and the top 10% for 86.6%. A Gini of 0.906 is "
    + "extreme concentration — for scale, US household income sits near 0.49. Much of this "
    + "is structural: infusion-heavy specialties buy and bill expensive biologics, so a few "
    + "practices carry enormous drug volume legitimately.");
});

test("hero 3 with no drug billers says so instead of reporting em dashes", () => {
  const v = { kpi: { n_drug_providers: 0, gini: "—", lorenz_top1: null, lorenz_top10: null } };
  assert.equal(R.hero3Read(v),
    "No provider in this filter billed a drug code, so there is no concentration to measure.");
});

test("hero 3 with a cohort too small for a Gini does not print one", () => {
  const v = { kpi: { n_drug_providers: 1, gini: "—", lorenz_top1: null, lorenz_top10: null } };
  const s = R.hero3Read(v);
  assert.match(s, /1 provider in this filter billed a drug code/);
  assert.match(s, /no Gini is reported/);
  assert.doesNotMatch(s, /—x|Gini of —/);
  assert.doesNotMatch(s, /extreme concentration/);
});

test("hero 3 lets the Gini pick its own adjective", () => {
  const at = (gini) => R.hero3Read({ kpi: { n_drug_providers: 353, gini,
    lorenz_top1: 0.4, lorenz_top10: 0.8 } });
  assert.match(at(0.905), /is extreme concentration/);
  assert.match(at(0.62), /is substantial concentration/);
  // The national sentence would have called this "extreme concentration" too.
  assert.match(at(0.31), /is a relatively even distribution/);
  assert.doesNotMatch(at(0.31), /extreme/);
});
