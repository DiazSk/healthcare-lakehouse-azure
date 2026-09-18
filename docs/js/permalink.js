/* URL-hash state, so a filtered view can be shared or bookmarked.

   Uses replaceState rather than assigning location.hash: assigning would push a
   history entry per filter change and trap the visitor's Back button.

   No onChange export: replaceState creates no history entries, so there is no
   back/forward navigation to produce a hashchange, and nothing here needs to
   react to one -- every caller reads the hash once, at boot. */
(function (root) {
  "use strict";

  function read() {
    const raw = location.hash.replace(/^#/, "");
    if (!raw) return {};
    const out = {};
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
    return out;
  }

  function write(state) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(state)) {
      if (v !== null && v !== undefined && v !== "" && v !== "all") params.set(k, v);
    }
    const hash = params.toString();
    history.replaceState(null, "", hash ? `#${hash}` : location.pathname);
  }

  root.MD = root.MD || {};
  root.MD.permalink = { read, write };
})(window);
