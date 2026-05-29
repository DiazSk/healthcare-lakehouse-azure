# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "marimo",
#     "duckdb",
#     "pandas",
#     "numpy",
#     "plotly",
#     "deltalake>=0.18",
#     "pyarrow>=15.0",
#     "python-dotenv",
# ]
# ///
"""Medicare Reimbursement Gap Analyzer — analytics dashboard.

Reads the real Gold Delta tables from ADLS Gen2 via the ``deltalake`` library.
No Databricks SQL warehouse required (saves DBUs vs. that connector path).

Prereqs:
1. Populate the Gold layer by running the PySpark notebooks in ``notebooks/``.
2. Set ``AZURE_CLIENT_SECRET`` (and the other four AZURE_* vars) in ``.env``
   at the repo root.

Launch (from repo root):
    marimo edit dashboard/medicare_analytics_dashboard.py
    marimo run  dashboard/medicare_analytics_dashboard.py --port 8501
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

    from utils import data_loader, theme

    return data_loader, duckdb, go, mo, np, pd, px, theme


@app.cell
def _(mo):
    mo.md("""
    # 🏥 Medicare Reimbursement Gap Analyzer
    ### Real CMS 2023 data · interim marimo dashboard

    Live read from Gold Delta tables on ADLS Gen2 — no Databricks SQL
    endpoint required. **Power BI is the long-term primary**; this dashboard
    is the secondary/interim service while that build is in flight.
    """)
    return


@app.cell
def _(data_loader):
    # Load all Gold tables. Each loader returns an empty DataFrame on failure
    # (missing creds, table not yet written) — we render a banner if so.
    dim_provider           = data_loader.load_dim_provider()
    dim_hcpcs              = data_loader.load_dim_hcpcs()
    dim_geography          = data_loader.load_dim_geography()
    geo_arbitrage          = data_loader.load_hero_geo_arbitrage()
    non_par_premium        = data_loader.load_hero_non_par_premium()
    jcode_concentration    = data_loader.load_hero_jcode_concentration()
    credentials_markup     = data_loader.load_hero_credentials_markup()
    site_neutral           = data_loader.load_hero_site_neutral()

    gold_is_empty = all(df.empty for df in [
        dim_provider, geo_arbitrage, non_par_premium, jcode_concentration,
        credentials_markup, site_neutral,
    ])
    return (
        credentials_markup,
        dim_geography,
        dim_hcpcs,
        dim_provider,
        geo_arbitrage,
        gold_is_empty,
        jcode_concentration,
        non_par_premium,
        site_neutral,
    )


@app.cell
def _(gold_is_empty, mo):
    banner = (
        mo.md(
            """
            > ## ⚠️  Awaiting Gold layer
            >
            > None of the Gold tables loaded. This is expected if:
            > 1. The PySpark notebooks (`notebooks/01_…04_…`) haven't been run yet.
            > 2. `AZURE_CLIENT_SECRET` is missing or stale in `.env`.
            > 3. The Databricks workspace storage account isn't reachable from this machine.
            >
            > Once Gold is populated and `.env` is set, restart this dashboard.
            > In the meantime, the **demo dashboard** (`medicare_demo_dashboard.py`)
            > runs on synthetic data with no Azure dependency.
            """
        )
        if gold_is_empty
        else mo.md("")
    )
    banner
    return


@app.cell
def _(dim_provider, mo):
    # Global filter bar — gracefully empty if dim_provider didn't load.
    state_options    = sorted(dim_provider["state_abrvtn"].dropna().unique().tolist()) if not dim_provider.empty else []
    specialty_options = sorted(dim_provider["specialty"].dropna().unique().tolist())  if not dim_provider.empty else []
    ruca_options     = ["(All)", "Urban", "Large rural", "Small rural / isolated"]

    state_filter     = mo.ui.multiselect(options=state_options,     label="📍 States",      value=[])
    specialty_filter = mo.ui.multiselect(options=specialty_options, label="🏥 Specialties", value=[])
    ruca_filter      = mo.ui.dropdown(   options=ruca_options,      label="🌆 RUCA",        value="(All)")

    mo.hstack([state_filter, specialty_filter, ruca_filter], gap=2, justify="start")
    return ruca_filter, specialty_filter, state_filter


@app.cell
def _(dim_provider, mo, ruca_filter, specialty_filter, state_filter):
    df = dim_provider
    if not df.empty:
        if state_filter.value:
            df = df[df["state_abrvtn"].isin(state_filter.value)]
        if specialty_filter.value:
            df = df[df["specialty"].isin(specialty_filter.value)]
        if ruca_filter.value != "(All)":
            df = df[df["ruca_bucket"] == ruca_filter.value]

    if df.empty:
        kpi_view = mo.md("_KPIs unavailable — Gold layer not yet populated._")
    else:
        total_pymt   = float(df["total_mdcr_pymt"].sum())
        total_svcs   = int(df["total_services"].sum())
        n_npis       = int(df["npi"].nunique())
        non_par_pct  = (1 - df["is_participating"].mean()) * 100
        median_codes = int(df["n_distinct_hcpcs"].median())
        kpi_view = mo.md(
            f"""
            |  💵 Medicare Allowed  |  📦 Services  |  👤 Providers  |  🚩 Non-Par %  |  🧾 Median Codes / NPI  |
            |:---:|:---:|:---:|:---:|:---:|
            |  **${total_pymt/1e9:,.2f}B**  |  **{total_svcs:,}**  |  **{n_npis:,}**  |  **{non_par_pct:,.1f}%**  |  **{median_codes}**  |
            """
        )
    kpi_view
    return


@app.cell
def _(mo):
    mo.md("""
    ---
    ## 🗺️ Hero #1 — Geographic Arbitrage
    """)
    return


@app.cell
def _(geo_arbitrage, mo, px, theme):
    if geo_arbitrage.empty:
        view = mo.md("_Awaiting `gold_hero_geo_arbitrage` …_")
    else:
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
        view = mo.ui.plotly(fig)
    view
    return


@app.cell
def _(geo_arbitrage, mo, pd, px, theme):
    if geo_arbitrage.empty:
        view2 = mo.md("")
    else:
        by_state2 = (
            geo_arbitrage.groupby("state_abrvtn", as_index=False)
            .agg(
                total_geo_premium=("total_geo_premium", "sum"),
                total_benes_proxy=("total_benes_proxy", "sum"),
            )
        )
        by_state2["geo_premium_per_bene"] = by_state2["total_geo_premium"] / by_state2["total_benes_proxy"]
        top10 = by_state2.nlargest(10, "geo_premium_per_bene")
        bot10 = by_state2.nsmallest(10, "geo_premium_per_bene")
        combo = pd.concat([top10, bot10]).sort_values("geo_premium_per_bene")

        fig2 = px.bar(
            combo,
            x="geo_premium_per_bene", y="state_abrvtn", orientation="h",
            color="geo_premium_per_bene",
            color_continuous_scale=theme.DIVERGING_SCALE,
            color_continuous_midpoint=0,
            labels={"geo_premium_per_bene": "$ / beneficiary", "state_abrvtn": "State"},
        )
        fig2.update_layout(yaxis={"categoryorder": "total ascending"})
        theme.apply_theme(fig2, title="Top 10 net receivers vs bottom 10 net senders")
        view2 = mo.ui.plotly(fig2)
    view2
    return


@app.cell
def _(mo):
    mo.md("""
    ---
    ## 📋 Hero #2 — Non-Participating Premium
    """)
    return


@app.cell
def _(go, mo, non_par_premium, theme):
    if non_par_premium.empty:
        view3 = mo.md("_Awaiting `gold_hero_non_par_premium` …_")
    else:
        top12 = non_par_premium.dropna(subset=["non_par_premium_pct"]).nlargest(12, "non_par_premium_pct")
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
            ))
        fig3.update_layout(showlegend=False, yaxis_title="Patient exposure ($/bene)")
        theme.apply_theme(fig3, title="Patient out-of-pocket: assignment vs non-par (top 12 specialties)")
        view3 = mo.ui.plotly(fig3)
    view3
    return


@app.cell
def _(mo):
    mo.md("""
    ---
    ## 💊 Hero #3 — J-Code Concentration
    """)
    return


@app.cell
def _(go, jcode_concentration, mo, np, theme):
    if jcode_concentration.empty:
        view4 = mo.md("_Awaiting `gold_hero_jcode_concentration` …_")
    else:
        lc = jcode_concentration.sort_values("cum_share_providers").dropna(subset=["cum_share_drug"])
        # NumPy 2.0 renamed `trapz` → `trapezoid`; support both:
        _trapezoid = getattr(np, "trapezoid", None) or getattr(np, "trapz", None)
        auc  = float(_trapezoid(lc["cum_share_drug"].astype(float), lc["cum_share_providers"].astype(float)))
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
        view4 = mo.ui.plotly(fig4)
    view4
    return


@app.cell
def _(dim_hcpcs, mo, px, theme):
    if dim_hcpcs.empty:
        view5 = mo.md("")
    else:
        drug_codes = dim_hcpcs[dim_hcpcs["is_drug"] == True].nlargest(25, "national_mdcr_pymt")
        if drug_codes.empty:
            view5 = mo.md("")
        else:
            fig5 = px.treemap(
                drug_codes,
                path=["hcpcs_cd"],
                values="national_mdcr_pymt",
                color="national_mdcr_pymt",
                color_continuous_scale=theme.SEQUENTIAL_SCALE,
                hover_data={"hcpcs_desc": True},
            )
            theme.apply_theme(fig5, title="Top 25 J-codes by national Medicare spend")
            view5 = mo.ui.plotly(fig5)
    view5
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
    if credentials_markup.empty:
        view6 = mo.md("_Awaiting `gold_hero_credentials_markup` …_")
    else:
        em = credentials_markup[credentials_markup.get("is_shared_e_and_m", False) == True]
        if em.empty:
            em = credentials_markup.head(6)  # fallback if flag column absent

        tiers = ["Physician (MD/DO)", "Nurse Practitioner", "Physician Assistant", "Specialist"]
        rows = []
        for _, r in em.iterrows():
            for t in tiers:
                markup_col = f"{t}_markup"
                svcs_col   = f"{t}_svcs"
                if markup_col in r and pd.notna(r[markup_col]):
                    rows.append({
                        "hcpcs_cd": r["hcpcs_cd"],
                        "hcpcs_desc": r.get("hcpcs_desc", ""),
                        "provider_tier": t,
                        "markup_ratio": float(r[markup_col]),
                        "services":     int(r[svcs_col]) if svcs_col in r and pd.notna(r[svcs_col]) else 0,
                    })
        long_df = pd.DataFrame(rows)
        if long_df.empty:
            view6 = mo.md("_No credential markup rows met the threshold._")
        else:
            fig6 = px.bar(
                long_df, x="hcpcs_cd", y="markup_ratio", color="provider_tier",
                barmode="group",
                color_discrete_sequence=theme.CATEGORICAL_PALETTE,
                labels={"markup_ratio": "Markup ratio (Sbmtd ÷ Allowed)", "hcpcs_cd": "HCPCS code"},
                hover_data={"hcpcs_desc": True, "services": ":,.0f"},
            )
            theme.apply_theme(fig6, title="Same code, same Medicare payment — wildly different chargemaster")
            view6 = mo.ui.plotly(fig6)
    view6
    return


@app.cell
def _(mo):
    mo.md("""
    ---
    ## 🏥 Hero #5 — Site-Neutral Simulation
    """)
    return


@app.cell
def _(go, mo, site_neutral, theme):
    if site_neutral.empty:
        view7 = mo.md("_Awaiting `gold_hero_site_neutral` …_")
    else:
        sn = site_neutral.dropna(subset=["F_pymt", "O_pymt"])
        if sn.empty:
            view7 = mo.md("_No site-neutral rows passed the volume threshold._")
        else:
            fig7 = go.Figure()
            fig7.add_trace(go.Scatter(
                x=sn["O_pymt"], y=sn["F_pymt"],
                mode="markers+text",
                marker=dict(
                    size=(sn["F_svcs"] / sn["F_svcs"].max() * 60 + 12),
                    color=sn["site_ratio"],
                    colorscale=[[0, theme.COLORS["primary"]], [1, theme.COLORS["anomaly"]]],
                    cmin=1.0, cmax=float(sn["site_ratio"].max()),
                    colorbar=dict(title="F / O ratio"),
                    line=dict(color=theme.COLORS["surface"], width=1),
                ),
                text=sn["hcpcs_cd"],
                textposition="top center",
                textfont=dict(size=10, color=theme.COLORS["muted"]),
                hovertemplate=(
                    "<b>%{text}</b><br>"
                    "Office: $%{x:.2f}<br>"
                    "Facility: $%{y:.2f}<br><extra></extra>"
                ),
            ))
            max_v = float(max(sn["O_pymt"].max(), sn["F_pymt"].max())) * 1.05
            fig7.add_trace(go.Scatter(
                x=[0, max_v], y=[0, max_v], mode="lines",
                line=dict(color=theme.COLORS["muted"], dash="dash", width=1),
                showlegend=False, hoverinfo="skip",
            ))
            fig7.update_layout(
                xaxis_title="Office payment ($)", yaxis_title="Facility payment ($)",
                xaxis=dict(rangemode="tozero"), yaxis=dict(rangemode="tozero"),
            )
            theme.apply_theme(fig7, title="Same HCPCS, two settings — Facility (F) vs Office (O)")

            savings = float(sn["site_neutral_savings"].clip(lower=0).sum())
            view7 = mo.vstack([
                mo.ui.plotly(fig7),
                mo.md(
                    f"### 💡 Simulated **site-neutral savings**: "
                    f"**${savings/1e9:,.2f}B** if F-billed services paid at O rates."
                ),
            ])
    view7
    return


@app.cell
def _(mo):
    mo.md("""
    ---
    ## 🔍 Provider Outlier Explorer
    """)
    return


@app.cell
def _(dim_provider, duckdb, jcode_concentration, mo, ruca_filter, specialty_filter, state_filter):
    if dim_provider.empty:
        view8 = mo.md("_Awaiting `dim_provider` …_")
    else:
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

        view8 = mo.ui.dataframe(base.head(100))
    view8
    return


@app.cell
def _(mo):
    mo.md("""
    ---
    ## 📚 Methodology

    - **Dataset:** CMS *Medicare Physician & Other Practitioners by Provider and Service*, 2023 release (~9.66M rows, 28 columns).
    - **Architecture:** Bronze (raw JSON) → Silver (typed Delta, DECIMAL-precision) → Gold (3 dims + narrow fact + 5 hero marts), all in PySpark on Azure Databricks → ADLS Gen2.
    - **This dashboard:** reads Gold Delta tables directly via the `deltalake` Python library — no Databricks SQL endpoint required.
    - **Primary BI:** Power BI (in development). This marimo app is the interim secondary service.

    🔗 GitHub: see project README · Built with marimo + deltalake + Plotly
    """)
    return


if __name__ == "__main__":
    app.run()
