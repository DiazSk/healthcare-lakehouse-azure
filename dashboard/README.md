# marimo dashboard

A reactive Python dashboard over the Gold layer, for exploring the data interactively.

> **This is the secondary surface.** The primary, published dashboard is the static
> [`docs/index.html`](../docs/index.html) — a single self-contained file with no runtime,
> served at
> [diazsk.github.io/healthcare-lakehouse-azure](https://diazsk.github.io/healthcare-lakehouse-azure/).
> Use this marimo app when you want to slice the data yourself in Python rather than read
> a finished narrative.

## What's in here

| File | Purpose |
|---|---|
| `medicare_analytics_dashboard.py` | Reads the **real Gold Delta tables** — local filesystem by default, ADLS Gen2 if configured. |
| `utils/data_loader.py` | `deltalake` → pandas loaders, one per Gold table. Set `DATA_LOADER_STRICT=1` to raise on failure instead of returning empty frames. |
| `utils/theme.py` | Color tokens + Plotly layout defaults, applied to every figure. |

## Quickstart

Requires a populated Gold layer. From the repo root:

```bash
./pipeline/download.sh          # 3.06 GB public CMS source
python pipeline/run_local.py    # build Bronze → Silver → Gold, ~4 min
```

Then:

```bash
LAKEHOUSE_LOCAL_ROOT="$PWD/data" marimo edit dashboard/medicare_analytics_dashboard.py
# or headless:
LAKEHOUSE_LOCAL_ROOT="$PWD/data" marimo run dashboard/medicare_analytics_dashboard.py --port 8501
```

## Data flow

```
data/gold/  (or abfss://gold@… when LAKEHOUSE_LOCAL_ROOT is unset)
     │
     │  deltalake.DeltaTable(path)  — no Spark, no SQL warehouse
     ▼
pandas DataFrame  (cached in utils/data_loader.py)
     │
     │  duckdb.sql("SELECT …") for reactive filtering
     ▼
plotly figure  →  mo.ui.plotly  →  marimo cell
```

## Authentication

**None locally.** With `LAKEHOUSE_LOCAL_ROOT` set, the loader reads the filesystem
directly — no credential is involved.

To point it at a live ADLS Gen2 account instead, leave that variable unset and supply
`AZURE_STORAGE_ACCOUNT`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`
in a gitignored `../.env`. Verify with `git check-ignore -v .env` before pushing. The
original project's Azure subscription is retired, so this path is unused today.

## Theme

| Token | Hex | Use |
|---|---|---|
| `bg` | `#F8FAFC` | Page background |
| `surface` | `#FFFFFF` | Chart canvas |
| `text` | `#0F172A` | Primary text |
| `primary` | `#0284C7` | Default chart accent |
| `savings` | `#059669` | Positive / net-sender |
| `anomaly` | `#E11D48` | Anomaly / net-receiver |

Every figure goes through `theme.apply_theme(fig)`.

Note these are **not** the same tokens as the published dashboard, which uses a separately
CVD-validated palette with a dark mode. The two surfaces are intentionally allowed to
diverge; `docs/index.html` is the one tuned for accessibility.

## A caveat on framing

The chart *framing* in this marimo app predates the analysis, and unlike
`docs/index.html` it has not been brought in line. Two of the five original
hypotheses were refuted once the real numbers came in; the published dashboard
reports them as refuted, with minimum-cohort thresholds and the professional-fee-only
caveat. This app still presents the original directional framing.

**Treat `docs/index.html` as the correct interpretation.** See the findings table in the
[root README](../README.md#what-the-data-actually-showed).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Awaiting Gold layer" banner | `LAKEHOUSE_LOCAL_ROOT` isn't set, or the Gold layer hasn't been built. Run `pipeline/run_local.py`. |
| `marimo: command not found` | `pip install -r ../requirements-local.txt` in your venv, plus `marimo`. |
| `deltalake` import error | `pip install 'deltalake>=0.18,<1.0'`. Versions ≥1.0 changed the API this loader targets. |
| Loaders silently return nothing | By design — `data_loader` degrades to empty frames so the UI doesn't crash. Set `DATA_LOADER_STRICT=1` to see the real error. |
| Charts render blank | A filter selection returned an empty frame; clear the global filter bar. |
