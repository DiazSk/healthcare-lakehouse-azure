# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "marimo",
#     "duckdb",
#     "pandas",
#     "numpy",
#     "plotly",
# ]
# ///
"""Medicare Reimbursement Gap Analyzer — demo dashboard.

Runs offline with synthetic data — useful for portfolio reviewers who don't
have Azure access. The production sibling (`medicare_analytics_dashboard.py`)
reads the real Gold Delta tables via ``deltalake``.

Launch (interactive notebook):
    marimo edit medicare_demo_dashboard.py

Launch (web-app served):
    marimo run medicare_demo_dashboard.py --port 8501
"""

import marimo

__generated_with = "0.23.8"
app = marimo.App(width="full")


@app.cell
def _():
    import sys
    from pathlib import Path
    # Make `utils.*` importable when marimo runs this file directly.
    sys.path.insert(0, str(Path(__file__).resolve().parent))

    import marimo as mo
    import numpy as np
    import pandas as pd
    import duckdb
    import plotly.express as px
    import plotly.graph_objects as go

    from utils import synthetic, theme

    return duckdb, go, mo, np, pd, px, synthetic, theme


@app.cell
def _(mo):
    mo.md("""
    # 🏥 Medicare Reimbursement Gap Analyzer — *Demo*
    ### Interim marimo dashboard (Power BI is the long-term primary).

    9.66M provider-service rows from CMS, distilled into 5 hero insights.
    This **demo** runs on synthetic data so the visuals work without Azure
    access — the production sibling reads the real Gold Delta tables.
    """)
    return


@app.cell
def _(synthetic):
    # Generate Gold-shaped synthetic data. Reproducible (seed=42).
    dim_provider           = synthetic.dim_provider(n=1500)
    dim_hcpcs              = synthetic.dim_hcpcs()
    dim_geography          = synthetic.dim_geography()
    geo_arbitrage          = synthetic.hero_geo_arbitrage()
    non_par_premium        = synthetic.hero_non_par_premium()
    jcode_concentration    = synthetic.hero_jcode_concentration(n=2000)
    credentials_markup     = synthetic.hero_credentials_markup()
    site_neutral           = synthetic.hero_site_neutral()
    return (
        credentials_markup,
        dim_hcpcs,
        dim_provider,
        geo_arbitrage,
        jcode_concentration,
        non_par_premium,
        site_neutral,
    )


@app.cell
def _(dim_provider, mo):
    # ── Global filter bar ───────────────────────────────────────────────
    state_options    = sorted(dim_provider["state_abrvtn"].unique().tolist())
    specialty_options = sorted(dim_provider["specialty"].unique().tolist())
    ruca_options     = ["(All)", "Urban", "Large rural", "Small rural / isolated"]

    state_filter = mo.ui.multiselect(
        options=state_options, label="📍 States", value=[],
    )
    specialty_filter = mo.ui.multiselect(
        options=specialty_options, label="🏥 Specialties", value=[],
    )
    ruca_filter = mo.ui.dropdown(
        options=ruca_options, value="(All)", label="🌆 RUCA",
    )

    mo.hstack([state_filter, specialty_filter, ruca_filter], gap=2, justify="start")
    return ruca_filter, specialty_filter, state_filter


@app.cell
def _(dim_provider, mo, ruca_filter, specialty_filter, state_filter):
    # ── KPI ribbon (recomputed reactively from filters) ─────────────────
    df = dim_provider
    if state_filter.value:
        df = df[df["state_abrvtn"].isin(state_filter.value)]
    if specialty_filter.value:
        df = df[df["specialty"].isin(specialty_filter.value)]
    if ruca_filter.value != "(All)":
        df = df[df["ruca_bucket"] == ruca_filter.value]

    total_pymt = df["total_mdcr_pymt"].sum()
    total_svcs = int(df["total_services"].sum())
    n_npis     = df["npi"].nunique()
    non_par_pct = (1 - df["is_participating"].mean()) * 100 if len(df) else 0.0
    median_hcpcs = int(df["n_distinct_hcpcs"].median()) if len(df) else 0

    mo.md(
        f"""
        |  💵 Medicare Allowed  |  📦 Services  |  👤 Providers  |  🚩 Non-Par %  |  🧾 Median Codes / NPI  |
        |:---:|:---:|:---:|:---:|:---:|
        |  **${total_pymt/1e9:,.2f}B**  |  **{total_svcs:,}**  |  **{n_npis:,}**  |  **{non_par_pct:,.1f}%**  |  **{median_hcpcs}**  |
        """
    )
    return


@app.cell
def _(mo):
    mo.md("""
    ---
    ## 🗺️ Hero #1 — The Geographic Arbitrage
    """)
    return


@app.cell
def _(geo_arbitrage, mo, px, theme):
    # Aggregate to state level (sum across RUCA buckets) for the choropleth.
    by_state = (
        geo_arbitrage.groupby("state_abrvtn", as_index=False)
        .agg(
            total_geo_premium=("total_geo_premium", "sum"),
            total_benes_proxy=("total_benes_proxy", "sum"),
        )
    )
    by_state["geo_premium_per_bene"] = by_state["total_geo_premium"] / by_state["total_benes_proxy"]

    fig = px.choropleth(
        by_state,
        locations="state_abrvtn",
        locationmode="USA-states",
        color="geo_premium_per_bene",
        color_continuous_scale=theme.DIVERGING_SCALE,
        color_continuous_midpoint=0,
        scope="usa",
        labels={"geo_premium_per_bene": "$ / beneficiary"},
        hover_data={"total_geo_premium": ":,.0f"},
    )
    theme.apply_theme(fig, title="Geographic premium per beneficiary (Pymt − Stdzd, top-50 HCPCS basket)")
    mo.ui.plotly(fig)
    return (by_state,)


@app.cell
def _(by_state, mo, px, theme):
    # Tornado bar: top 10 + bottom 10 states by per-bene premium.
    top   = by_state.nlargest(10, "geo_premium_per_bene")
    bot   = by_state.nsmallest(10, "geo_premium_per_bene")
    combo = (
        # Sort so positives stack at top and negatives at bottom of bar chart.
        # px.bar with orientation='h' ascending order = bottom-to-top visually.
        # We want most-positive at top → sort ascending here, then reverse y category order.
        # Easier: just concat and sort once.
        # (top + bot together = 20 bars)
        # Use total_geo_premium for absolute dollar context.
        # Color-coded by sign via DIVERGING_SCALE.
        (top._append(bot) if hasattr(top, "_append") else __import__("pandas").concat([top, bot]))
        .sort_values("geo_premium_per_bene")
    )
    fig2 = px.bar(
        combo,
        x="geo_premium_per_bene",
        y="state_abrvtn",
        orientation="h",
        color="geo_premium_per_bene",
        color_continuous_scale=theme.DIVERGING_SCALE,
        color_continuous_midpoint=0,
        labels={"geo_premium_per_bene": "$ / beneficiary", "state_abrvtn": "State"},
    )
    fig2.update_layout(yaxis={"categoryorder": "total ascending"})
    theme.apply_theme(fig2, title="Top 10 net receivers vs bottom 10 net senders")
    mo.ui.plotly(fig2)
    return


@app.cell
def _(mo):
    mo.md("""
    ---
    ## 📋 Hero #2 — The Non-Participating Premium
    """)
    return


@app.cell
def _(go, mo, non_par_premium, theme):
    # Slope chart: each specialty is one line from (x=Y) to (x=N).
    top12 = non_par_premium.nlargest(12, "non_par_premium_pct")

    fig3 = go.Figure()
    for _, row in top12.iterrows():
        fig3.add_trace(go.Scatter(
            x=["Participating (Y)", "Non-Par (N)"],
            y=[row["exposure_par_Y"], row["exposure_par_N"]],
            mode="lines+markers+text",
            name=row["specialty"],
            text=[None, row["specialty"]],
            textposition="middle right",
            line=dict(width=2),
            marker=dict(size=8),
            hovertemplate=(
                f"<b>{row['specialty']}</b><br>"
                f"Y exposure: $%{{y:.2f}}<br>"
                f"+{row['non_par_premium_pct']*100:.1f}%<extra></extra>"
            ),
        ))
    fig3.update_layout(showlegend=False, xaxis_title=None, yaxis_title="Patient exposure ($/bene)")
    theme.apply_theme(fig3, title="Patient out-of-pocket exposure: assignment vs non-par (top 12 specialties)")
    mo.ui.plotly(fig3)
    return


@app.cell
def _(mo):
    mo.md("""
    ---
    ## 💊 Hero #3 — J-Code Concentration (Lorenz curve)
    """)
    return


@app.cell
def _(go, jcode_concentration, mo, np, theme):
    # Lorenz curve + diagonal reference line.
    lc = jcode_concentration.sort_values("cum_share_providers")
    # Approximate Gini via trapezoidal AUC.
    # NumPy 2.0 renamed `trapz` → `trapezoid`; support both:
    _trapezoid = getattr(np, "trapezoid", None) or getattr(np, "trapz", None)
    auc = float(_trapezoid(lc["cum_share_drug"], lc["cum_share_providers"]))
    gini = 1 - 2 * auc

    fig4 = go.Figure()
    fig4.add_trace(go.Scatter(
        x=lc["cum_share_providers"], y=lc["cum_share_drug"],
        mode="lines", name="Drug revenue",
        line=dict(color=theme.COLORS["primary"], width=3),
        fill="tozeroy", fillcolor="rgba(2,132,199,0.10)",
    ))
    fig4.add_trace(go.Scatter(
        x=[0, 1], y=[0, 1],
        mode="lines", name="Perfect equality",
        line=dict(color=theme.COLORS["muted"], width=1, dash="dash"),
    ))
    fig4.update_layout(
        xaxis_title="Cumulative share of providers (sorted by drug revenue)",
        yaxis_title="Cumulative share of drug revenue",
    )
    theme.apply_theme(fig4, title=f"Drug-revenue concentration — Gini = {gini:.3f}")
    mo.ui.plotly(fig4)
    return


@app.cell
def _(dim_hcpcs, mo, px, theme):
    drug_codes = dim_hcpcs[dim_hcpcs["is_drug"]].nlargest(10, "national_mdcr_pymt")
    fig5 = px.treemap(
        drug_codes,
        path=["hcpcs_cd"],
        values="national_mdcr_pymt",
        color="national_mdcr_pymt",
        color_continuous_scale=theme.SEQUENTIAL_SCALE,
        hover_data={"hcpcs_desc": True},
    )
    theme.apply_theme(fig5, title="Top J-codes by national Medicare spend")
    mo.ui.plotly(fig5)
    return


@app.cell
def _(mo):
    mo.md("""
    ---
    ## 🎓 Hero #4 — Credentials Markup Cliff
    """)
    return


@app.cell
def _(credentials_markup, mo, pd, px, theme):
    # Unpivot the wide credentials table into long form for grouped bar plotting.
    em_codes = credentials_markup[credentials_markup["is_shared_e_and_m"]]
    tiers = ["Physician (MD/DO)", "Nurse Practitioner", "Physician Assistant", "Specialist"]
    rows = []
    for _, r in em_codes.iterrows():
        for t in tiers:
            rows.append({
                "hcpcs_cd": r["hcpcs_cd"],
                "hcpcs_desc": r["hcpcs_desc"],
                "provider_tier": t,
                "markup_ratio": r[f"{t}_markup"],
                "services":     r[f"{t}_svcs"],
            })
    long_df = pd.DataFrame(rows)

    fig6 = px.bar(
        long_df,
        x="hcpcs_cd",
        y="markup_ratio",
        color="provider_tier",
        barmode="group",
        color_discrete_sequence=theme.CATEGORICAL_PALETTE,
        labels={"markup_ratio": "Markup ratio (Sbmtd ÷ Allowed)", "hcpcs_cd": "HCPCS code"},
        hover_data={"hcpcs_desc": True, "services": ":,.0f"},
    )
    theme.apply_theme(fig6, title="Same code, same Medicare payment — wildly different chargemaster (shared E&M codes)")
    mo.ui.plotly(fig6)
    return


@app.cell
def _(mo):
    mo.md("""
    ---
    ## 🏥 Hero #5 — The Facility Flip (Site-Neutral Simulation)
    """)
    return


@app.cell
def _(go, mo, site_neutral, theme):
    # 45° dot-plot: x = office payment, y = facility payment, size = facility volume.
    fig7 = go.Figure()
    fig7.add_trace(go.Scatter(
        x=site_neutral["O_pymt"], y=site_neutral["F_pymt"],
        mode="markers+text",
        marker=dict(
            size=site_neutral["F_svcs"] / site_neutral["F_svcs"].max() * 60 + 12,
            color=site_neutral["site_ratio"],
            colorscale=[[0, theme.COLORS["primary"]], [1, theme.COLORS["anomaly"]]],
            cmin=1.0, cmax=site_neutral["site_ratio"].max(),
            colorbar=dict(title="F / O ratio"),
            line=dict(color=theme.COLORS["surface"], width=1),
        ),
        text=site_neutral["hcpcs_cd"],
        textposition="top center",
        textfont=dict(size=10, color=theme.COLORS["muted"]),
        hovertemplate=(
            "<b>%{text}</b><br>"
            "Office pymt: $%{x:.2f}<br>"
            "Facility pymt: $%{y:.2f}<br>"
            "<extra></extra>"
        ),
    ))
    # 45° identity line.
    max_v = float(max(site_neutral["O_pymt"].max(), site_neutral["F_pymt"].max())) * 1.05
    fig7.add_trace(go.Scatter(
        x=[0, max_v], y=[0, max_v],
        mode="lines", name="Identity",
        line=dict(color=theme.COLORS["muted"], dash="dash", width=1),
        showlegend=False, hoverinfo="skip",
    ))
    fig7.update_layout(
        xaxis_title="Office payment ($)", yaxis_title="Facility payment ($)",
        xaxis=dict(rangemode="tozero"), yaxis=dict(rangemode="tozero"),
    )
    theme.apply_theme(fig7, title="Same HCPCS, two settings — Facility (F) vs Office (O) Medicare payment")
    mo.ui.plotly(fig7)

    total_savings = float(site_neutral["site_neutral_savings"].clip(lower=0).sum())
    mo.md(
        f"### 💡 Simulated **site-neutral savings**: "
        f"**${total_savings/1e9:,.2f}B** if F-billed services paid at O rates."
    )
    return


@app.cell
def _(mo):
    mo.md("""
    ---
    ## 🔍 Provider Outlier Explorer
    """)
    return


@app.cell
def _(duckdb, mo, ruca_filter, specialty_filter, state_filter):
    # Join providers to drug-share, then filter to current selection.
    base = duckdb.sql("""
        SELECT
            p.npi,
            p.display_name,
            p.specialty,
            p.state_abrvtn,
            p.ruca_bucket,
            p.is_participating,
            p.provider_tier,
            p.total_mdcr_pymt,
            p.total_services,
            j.drug_share,
            j.is_drug_dependent
        FROM dim_provider p
        LEFT JOIN jcode_concentration j USING (npi)
        ORDER BY p.total_mdcr_pymt DESC
    """).df()

    if state_filter.value:
        base = base[base["state_abrvtn"].isin(state_filter.value)]
    if specialty_filter.value:
        base = base[base["specialty"].isin(specialty_filter.value)]
    if ruca_filter.value != "(All)":
        base = base[base["ruca_bucket"] == ruca_filter.value]

    mo.ui.dataframe(base.head(100))
    return


@app.cell
def _(mo):
    mo.md("""
    ---
    ## 📚 Methodology

    - **Dataset:** CMS *Medicare Physician & Other Practitioners by Provider
      and Service*, 2023 release. ~9.66M rows, 28 columns. Suppressed at
      source for <11-beneficiary cells.
    - **Architecture:** Bronze (raw JSON) → Silver (typed Delta) → Gold
      (star schema + 5 hero marts), all in Databricks PySpark on Azure
      ADLS Gen2. See `notebooks/` for the PySpark code.
    - **This demo:** synthetic data only — for the real numbers run
      `medicare_analytics_dashboard.py` after the Gold tables are populated.
    - **Primary dashboard:** Power BI — this marimo dashboard is the
      secondary / interim viz service.

    🔗 [GitHub repo](https://github.com/) · 🤖 Built with marimo + Plotly
    """)
    return


if __name__ == "__main__":
    app.run()
