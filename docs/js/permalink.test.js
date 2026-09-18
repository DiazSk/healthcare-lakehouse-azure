// Run: node --test docs/js/*.test.js   (the directory form is broken on Node 24)
/* permalink.js is pure string/state logic over location.hash and
   history.replaceState -- both stubbed here so the round-trip and omission
   rules are checked directly, rather than trusting them by inspection. This
   project has been bitten repeatedly by untested string construction (see
   live.test.js, explore.test.js's header). */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function load(initialHash) {
  const loc = { hash: initialHash || "", pathname: "/docs/index.html" };
  global.location = loc;
  global.history = {
    replaceState(_state, _title, url) {
      if (url.startsWith("#")) loc.hash = url;
      else loc.hash = ""; // a bare pathname clears the hash, same as a real URL
    },
  };
  global.window = {};
  eval(fs.readFileSync(path.join(__dirname, "permalink.js"), "utf8"));
  return global.window.MD.permalink;
}

test("exports only read and write -- no onChange", () => {
  const P = load();
  assert.deepEqual(Object.keys(P).sort(), ["read", "write"]);
});

test("read parses an absent hash as {}", () => {
  const P = load("");
  assert.deepEqual(P.read(), {});
});

test("read parses a populated hash", () => {
  const P = load("#state=CA&ruca=Urban&live=1");
  assert.deepEqual(P.read(), { state: "CA", ruca: "Urban", live: "1" });
});

test("write -> read round-trips", () => {
  const P = load();
  P.write({ state: "CA", ruca: "Urban", live: "1" });
  assert.deepEqual(P.read(), { state: "CA", ruca: "Urban", live: "1" });
});

test("write omits 'all' and empty-string values from the hash", () => {
  const P = load();
  P.write({ state: "CA", ruca: "all", spec: "", live: "" });
  const hash = global.location.hash;
  assert.match(hash, /state=CA/);
  assert.doesNotMatch(hash, /ruca/);
  assert.doesNotMatch(hash, /spec/);
  assert.doesNotMatch(hash, /live/);
});

test("write({}) produces no bare '#'", () => {
  const P = load("#state=CA");
  P.write({});
  assert.equal(global.location.hash, "");
});
