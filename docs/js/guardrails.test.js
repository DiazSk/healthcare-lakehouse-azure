// Run: node --test docs/js/
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

global.window = {};
eval(fs.readFileSync(path.join(__dirname, "guardrails.js"), "utf8"));
const G = global.window.MD.guardrails;

test("thresholds match the static publisher", () => {
  // pipeline/publish_dashboard.py uses MIN_NONPAR_PROVIDERS = 30; the two
  // surfaces must not disagree about what counts as reliable.
  assert.equal(G.RELIABLE, 30);
  assert.equal(G.WEAK, 11);   // CMS's own beneficiary suppression floor
});

test("classifies by cohort size", () => {
  assert.equal(G.reliability(30), "ok");
  assert.equal(G.reliability(1000), "ok");
  assert.equal(G.reliability(29), "thin");
  assert.equal(G.reliability(11), "thin");
  assert.equal(G.reliability(10), "very-thin");
  assert.equal(G.reliability(1), "very-thin");
  assert.equal(G.reliability(0), "very-thin");
});

test("the Orthopedic Surgery artifact is flagged, not hidden", () => {
  // The canonical case: +2,223% on 11 non-participating providers.
  assert.equal(G.reliability(11), "thin");
  assert.match(G.badgeText(11), /n=11/);
});

test("reliable cohorts get no badge", () => {
  assert.equal(G.badgeText(30), "");
  assert.equal(G.badgeText(862), "");
});

test("very thin cohorts name the CMS floor", () => {
  assert.match(G.badgeText(4), /n=4/);
  assert.match(G.badgeText(4), /suppression floor/i);
});

test("opacity de-emphasises without hiding", () => {
  assert.equal(G.opacityFor("ok"), 1);
  assert.equal(G.opacityFor("thin"), 0.55);
  assert.equal(G.opacityFor("very-thin"), 0.4);
  // Never zero: the number must always remain visible.
  assert.ok(G.opacityFor("very-thin") > 0);
});

test("missing cohort size is treated as unreliable, not reliable", () => {
  assert.equal(G.reliability(null), "very-thin");
  assert.equal(G.reliability(undefined), "very-thin");
  assert.equal(G.reliability(NaN), "very-thin");
});

test("badgeText renders n=0 for all missing cohort values, never the literal type names", () => {
  // Reverting to global isFinite() must fail this test. A SQL LEFT JOIN that finds
  // no matching cohort row yields null, so this is a real case.
  const nullBadge = G.badgeText(null);
  const undefBadge = G.badgeText(undefined);
  const nanBadge = G.badgeText(NaN);

  assert.match(nullBadge, /n=0/);
  assert.doesNotMatch(nullBadge, /null/i);

  assert.match(undefBadge, /n=0/);
  assert.doesNotMatch(undefBadge, /undefined/i);

  assert.match(nanBadge, /n=0/);
  assert.doesNotMatch(nanBadge, /nan/i);
});

// applyBadge DOM tests

function elStub() {
  return {
    textContent: "",
    hidden: false,
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
  };
}

test("applyBadge on thin cohort sets badge text and visibility", () => {
  const el = elStub();
  G.applyBadge(el, 11);
  assert.match(el.textContent, /n=11/);
  assert.equal(el.attrs["data-reliability"], "thin");
  assert.equal(el.hidden, false);
});

test("applyBadge fixes stale-badge regression: re-rendering a thin cohort to reliable clears the badge", () => {
  // Mutation to one-way if (level === "ok") el.hidden = true; would fail this test.
  // This is the regression that happens when a provider filter changes from 11 to 500.
  const el = elStub();

  // First render: thin cohort
  G.applyBadge(el, 11);
  assert.match(el.textContent, /n=11/);
  assert.equal(el.attrs["data-reliability"], "thin");
  assert.equal(el.hidden, false);

  // Re-render on same element: now reliable (500 providers)
  G.applyBadge(el, 500);
  assert.equal(el.textContent, "");  // Badge text must be cleared
  assert.equal(el.attrs["data-reliability"], "ok");
  assert.equal(el.hidden, true);  // Must be hidden, not left visible from before
});

test("applyBadge on very-thin cohort sets badge and wording", () => {
  const el = elStub();
  G.applyBadge(el, 5);
  assert.match(el.textContent, /n=5/);
  assert.match(el.textContent, /suppression floor/i);
  assert.equal(el.attrs["data-reliability"], "very-thin");
  assert.equal(el.hidden, false);
});

test("applyBadge on null element does not throw", () => {
  assert.doesNotThrow(() => {
    G.applyBadge(null, 5);
  });
});

test("applyBadge hidden flag must reset in both directions (reliable to thin and back)", () => {
  // One-way mutations break different directions. Going reliable->thin tests that
  // the function can set hidden=false after it was true.
  const el = elStub();

  // First: reliable (sets hidden=true)
  G.applyBadge(el, 500);
  assert.equal(el.hidden, true);
  assert.equal(el.textContent, "");

  // Then: thin (must set hidden=false, not leave it true)
  G.applyBadge(el, 11);
  assert.equal(el.hidden, false, "hidden must reset to false for thin cohort");
  assert.match(el.textContent, /n=11/, "badge text must appear for thin cohort");
  assert.equal(el.attrs["data-reliability"], "thin");
});

test("applyBadge consistency: data-reliability always matches reliability(n)", () => {
  const testCases = [30, 11, 5, 50, 1, 0];
  for (const n of testCases) {
    const el = elStub();
    G.applyBadge(el, n);
    assert.equal(el.attrs["data-reliability"], G.reliability(n),
      `mismatch for n=${n}: badge says ${el.attrs["data-reliability"]} but reliability says ${G.reliability(n)}`);
  }
});
