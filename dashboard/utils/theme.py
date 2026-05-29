"""Color tokens + Plotly layout defaults — match `context/ui-context.md`.

Every chart in the marimo dashboards goes through `apply_theme(fig)` so the
visual language is consistent with the upcoming Power BI report.
"""

from __future__ import annotations

import plotly.graph_objects as go


COLORS = {
    "bg":       "#F8FAFC",   # Page background
    "surface":  "#FFFFFF",   # Card / chart canvas
    "text":     "#0F172A",   # Primary text
    "muted":    "#64748B",   # Axis labels, subtext
    "primary":  "#0284C7",   # Main accent — chart bars, KPI underlines
    "savings":  "#059669",   # Positive / savings (green)
    "anomaly":  "#E11D48",   # Warning / anomaly (red)
    "neutral":  "#A23B72",   # Secondary accent for category encoding
    "warm":     "#F18F01",   # Tertiary accent
}

# Diverging palette for choropleth / tornado charts (red → white → green).
DIVERGING_SCALE = [
    [0.0,  COLORS["anomaly"]],
    [0.5,  COLORS["surface"]],
    [1.0,  COLORS["savings"]],
]

# Sequential palette for non-diverging quantities.
SEQUENTIAL_SCALE = [
    [0.0, COLORS["surface"]],
    [1.0, COLORS["primary"]],
]

# Ordered palette for credential tiers / categorical specialty bars.
CATEGORICAL_PALETTE = [
    COLORS["primary"],
    COLORS["neutral"],
    COLORS["warm"],
    COLORS["anomaly"],
    COLORS["savings"],
]


def apply_theme(fig: go.Figure, title: str | None = None) -> go.Figure:
    """Apply the shared layout and return the figure (in-place)."""
    fig.update_layout(
        paper_bgcolor=COLORS["bg"],
        plot_bgcolor=COLORS["surface"],
        font=dict(
            family="Inter, Segoe UI, -apple-system, BlinkMacSystemFont, sans-serif",
            color=COLORS["text"],
            size=13,
        ),
        title=dict(text=title, font=dict(size=18, color=COLORS["text"])) if title else None,
        margin=dict(l=40, r=20, t=50 if title else 20, b=40),
        hoverlabel=dict(bgcolor=COLORS["surface"], font_color=COLORS["text"]),
        legend=dict(bgcolor=COLORS["surface"], bordercolor=COLORS["muted"], borderwidth=0),
        xaxis=dict(gridcolor="#E2E8F0", zerolinecolor="#E2E8F0", color=COLORS["muted"]),
        yaxis=dict(gridcolor="#E2E8F0", zerolinecolor="#E2E8F0", color=COLORS["muted"]),
    )
    return fig
