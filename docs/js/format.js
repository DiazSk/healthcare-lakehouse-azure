/* Pure formatting and colour helpers. No DOM, no globals beyond window.MD.
   Classic script on purpose: ES modules are CORS-blocked over file://, and
   docs/index.html must keep opening straight from disk. */
(function (root) {
  "use strict";

  function money(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    const a = Math.abs(v), s = v < 0 ? "-$" : "$";
    if (a >= 1e9) return s + (a / 1e9).toFixed(digits ?? 2) + "B";
    if (a >= 1e6) return s + (a / 1e6).toFixed(digits ?? 1) + "M";
    if (a >= 1e3) return s + (a / 1e3).toFixed(digits ?? 1) + "K";
    return s + a.toFixed(2);
  }

  function count(v) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function pct(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    return (v * 100).toFixed(d ?? 1) + "%";
  }

  function hex2rgb(h) {
    h = h.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
            parseInt(h.slice(4, 6), 16)];
  }

  // t in [-1, 1]; clamped, never extrapolated past the end stops.
  function diverging(t, stopHexes) {
    const stops = stopHexes.map(hex2rgb);
    const p = (Math.max(-1, Math.min(1, t)) + 1) / 2 * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(p)), f = p - i;
    const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  // Relative luminance decides label ink, so tile text stays legible at both extremes.
  function inkOn(rgb) {
    const [r, g, b] = rgb.match(/\d+/g).map(Number).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0b0b0b" : "#ffffff";
  }

  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))];
  }

  root.MD = root.MD || {};
  root.MD.format = { money, count, pct, hex2rgb, diverging, inkOn, quantile };
})(typeof window !== "undefined" ? window : globalThis);
