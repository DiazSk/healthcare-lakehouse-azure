# Medicare Reimbursement Gap Analyzer — Marimo Dashboard

Interactive Python web dashboard for the CMS *Medicare Physician & Other Practitioners by Provider and Service* dataset.

> **This is the secondary / interim viz layer.** Power BI is the long-term primary dashboard. This marimo app exists to give a runnable interactive view of the 5 hero insights while the Power BI build is in flight — and to serve as a portfolio-friendly demo that anyone with Python can launch in two commands.

## What's in here

| File | Purpose |
|---|---|
| `medicare_demo_dashboard.py` | Runs on **synthetic** Gold-shaped data. No Azure auth needed. Use for portfolio reviews and offline smoke tests. |
| `medicare_analytics_dashboard.py` | Reads the **real Gold Delta tables** from ADLS Gen2 via `deltalake`. Requires `.env` auth and a populated Gold layer. |
| `utils/theme.py` | Color tokens + Plotly layout — matches `context/ui-context.md` so the Power BI report and marimo dashboard share a visual language. |
| `utils/data_loader.py` | `deltalake` → pandas loaders, one per Gold table. Gracefully returns empty DataFrames if Gold isn't reachable. |
| `utils/synthetic.py` | NumPy/pandas generators that mimic Gold table schemas — keeps the demo's chart code identical to the analytics version. |

## Sections (both dashboards)

1. KPI ribbon — Medicare allowed $, total services, unique NPIs, non-par share, median codes/NPI
2. Hero #1 — Geographic arbitrage (choropleth + tornado)
3. Hero #2 — Non-participating premium (slope chart)
4. Hero #3 — J-code concentration (Lorenz curve + drug treemap)
5. Hero #4 — Credentials markup cliff (grouped bar over shared E&M codes)
6. Hero #5 — Site-neutral simulation (45° dot-plot + savings KPI)
7. Provider outlier explorer (interactive table, filterable)

## Quickstart

```bash
# 1. Install deps (from repo root)
pip install -r ../requirements.txt

# 2. Demo (no Azure needed)
marimo edit medicare_demo_dashboard.py        # interactive notebook UI
# OR
marimo run medicare_demo_dashboard.py --port 8501   # headless web app

# 3. Analytics (real Gold tables)
#    Prereq: populate Gold by running the PySpark notebooks in ../notebooks/.
#    Prereq: copy ../.env.example to ../.env and fill in AZURE_CLIENT_SECRET.
marimo edit medicare_analytics_dashboard.py
```

## Data flow

```
ADLS Gen2 (Gold container)
     │
     │  deltalake.DeltaTable(uri, storage_options={...sp creds...})
     ▼
pandas DataFrame (cached in dashboard/utils/data_loader.py)
     │
     │  duckdb.sql("SELECT ...") for reactive filtering
     ▼
plotly chart  →  mo.ui.plotly  →  marimo cell render
```

No Spark, no Databricks SQL warehouse, no cost when idle. All the heavy
lifting (Bronze→Silver→Gold) is already complete in `../notebooks/`.

## Authentication

The analytics dashboard authenticates to ADLS Gen2 using the same Service Principal that the PySpark notebooks use, but the secret value is read **locally** from `../.env` (gitignored) rather than from the Databricks Key Vault scope (which is unreachable outside Databricks).

Required env vars in `.env`:

```
AZURE_STORAGE_ACCOUNT=sthealthcareplatdev
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=<rotated-SP-client-secret>
```

The rotated secret should NEVER be committed. `.env` is in `.gitignore`. Run `git check-ignore -v .env` to verify before pushing.

## Theme

The color tokens in `utils/theme.py` mirror `context/ui-context.md`:

| Token | Hex | Use |
|---|---|---|
| `bg` | `#F8FAFC` | Page background |
| `surface` | `#FFFFFF` | Chart canvas |
| `text` | `#0F172A` | Primary text |
| `primary` | `#0284C7` | Default chart accent |
| `savings` | `#059669` | Positive / net-sender / savings |
| `anomaly` | `#E11D48` | Anomaly / net-receiver / warning |

Every Plotly figure goes through `theme.apply_theme(fig)` so the visual language is identical across all sections and matches the upcoming Power BI report.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Analytics dashboard renders the "Awaiting Gold layer" banner | Gold tables haven't been written yet, or `AZURE_CLIENT_SECRET` is missing/stale. Run `notebooks/01_…04_…` first. |
| `marimo: command not found` | `pip install -r requirements.txt` in your venv. |
| `deltalake` import error | Demo dashboard still works without it (soft import in `data_loader.py`). For analytics, `pip install deltalake>=0.18`. |
| Charts render but are blank | Filter selections returned an empty DataFrame — clear filters from the global bar. |
