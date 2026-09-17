/* Small-sample guardrails.

   Free slicing can manufacture the artifacts the static panels were rewritten to
   remove -- filter hero 2 to Orthopedic Surgery and the "+2,223% premium" (n=11)
   reappears. The approved behaviour is warn, never hide: the number always
   renders, wearing a badge that names its cohort size. */
(function (root) {
  "use strict";

  // Matches MIN_NONPAR_PROVIDERS in pipeline/publish_dashboard.py. If you change
  // one, change both, or the static and live surfaces will disagree.
  const RELIABLE = 30;
  // CMS suppresses provider-service rows under 11 beneficiaries; borrowing the
  // same floor keeps the language familiar to anyone who knows the dataset.
  const WEAK = 11;

  function reliability(n) {
    if (!Number.isFinite(n)) return "very-thin";
    if (n >= RELIABLE) return "ok";
    if (n >= WEAK) return "thin";
    return "very-thin";
  }

  function badgeText(n) {
    const level = reliability(n);
    if (level === "ok") return "";
    const shown = Number.isFinite(n) ? n : 0;
    return level === "thin"
      ? `n=${shown} · thin sample`
      : `n=${shown} · below CMS's suppression floor`;
  }

  const OPACITY = { ok: 1, thin: 0.55, "very-thin": 0.4 };
  const opacityFor = (level) => OPACITY[level] ?? 1;

  function applyBadge(el, n) {
    if (!el) return;
    const level = reliability(n);
    el.textContent = badgeText(n);
    el.setAttribute("data-reliability", level);
    el.hidden = level === "ok";
  }

  root.MD = root.MD || {};
  root.MD.guardrails = { RELIABLE, WEAK, reliability, badgeText, opacityFor, applyBadge };
})(typeof window !== "undefined" ? window : globalThis);
