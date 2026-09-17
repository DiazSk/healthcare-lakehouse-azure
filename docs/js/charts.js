/* Chart.js scaffolding shared by both pages. Reads theme values from CSS custom
   properties so one theme toggle repaints every chart. */
(function (root) {
  "use strict";

  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.animation = false;          // many charts on one page
  Chart.defaults.maintainAspectRatio = false;

  const css = (k) =>
    getComputedStyle(document.documentElement).getPropertyValue(k).trim();

  let T = {};

  function readTokens() {
    T = {
      ink1: css("--ink-1"), ink2: css("--ink-2"), muted: css("--ink-muted"),
      grid: css("--grid"), axis: css("--axis"), surface: css("--surface-1"),
      s1: css("--series-1"), s2: css("--series-2"),
      s3: css("--series-3"), s4: css("--series-4"),
      critical: css("--critical"),
      div: [css("--div-neg2"), css("--div-neg1"), css("--div-mid"),
            css("--div-pos1"), css("--div-pos2")],
    };
    return T;
  }

  const tokens = () => T;

  function axisOpts(title, fmt, extra) {
    return Object.assign({
      title: title
        ? { display: true, text: title, color: T.ink2, font: { size: 11.5 } }
        : undefined,
      grid: { color: T.grid, drawTicks: false },
      border: { color: T.axis },
      ticks: { color: T.muted, font: { size: 11 }, callback: fmt },
    }, extra || {});
  }

  const legendOpts = (show) => ({
    display: !!show, position: "top", align: "end",
    labels: {
      color: T.ink2, boxWidth: 11, boxHeight: 11, usePointStyle: true,
      pointStyle: "rectRounded", font: { size: 12 },
    },
  });

  const tooltipOpts = (cb) => ({
    backgroundColor: T.surface, titleColor: T.ink1, bodyColor: T.ink2,
    borderColor: T.axis, borderWidth: 1, padding: 10, displayColors: true,
    callbacks: cb || {},
  });

  const charts = {};

  function mount(id, cfg) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), cfg);
    return charts[id];
  }

  root.MD = root.MD || {};
  root.MD.charts = { readTokens, tokens, axisOpts, legendOpts, tooltipOpts, mount, charts };
})(window);
