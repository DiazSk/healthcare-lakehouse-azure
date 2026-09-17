#!/usr/bin/env python
"""Aggregate the local Gold tables into docs/data.json for the static dashboard.

The Gold marts are too big to embed raw -- gold_hero_jcode_concentration and
dim_provider are both ~1M rows -- so this is where the dashboard's data budget is
enforced: every table is either small enough to ship whole, or reduced to the
specific shape a chart needs (a downsampled curve, a top-N slice, a scalar).

Reads through dashboard/utils/data_loader.py so the marimo app and the static
dashboard share one loader. DATA_LOADER_STRICT=1 is set here deliberately: that
module's default behaviour is to swallow load failures and return an empty
DataFrame, which would publish an empty dashboard rather than fail.

Usage:  python pipeline/publish_dashboard.py
"""

import json
import math
import os
import sys
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
os.environ.setdefault("LAKEHOUSE_LOCAL_ROOT", str(REPO / "data"))
os.environ["DATA_LOADER_STRICT"] = "1"
sys.path.insert(0, str(REPO / "dashboard"))

import pandas as pd  # noqa: E402

from utils import data_loader as dl  # noqa: E402

OUT = REPO / "docs" / "data.json"
CMS_FILE = "MUP_PHY_R25_P05_V20_D23_Prov_Svc.csv"
CMS_URL = ("https://data.cms.gov/provider-summary-by-type-of-service/"
           "medicare-physician-other-practitioners/"
           "medicare-physician-other-practitioners-by-provider-and-service")
LORENZ_POINTS = 200
# A specialty needs a real non-participating cohort before its premium means
# anything. Below this, the ratio is denominator noise: Orthopedic Surgery's
# headline +2,223% rests on 11 non-par providers against 20,699 participating.
MIN_NONPAR_PROVIDERS = 30
INDEX = REPO / "docs" / "index.html"


def num(v):
    """Decimal/NumPy/NaN -> plain JSON number or None."""
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if not math.isfinite(f) else f


def rnd(v, places=2):
    f = num(v)
    return None if f is None else round(f, places)


def require(df: pd.DataFrame, name: str, *columns: str) -> pd.DataFrame:
    """Fail loudly on an empty or unexpectedly-shaped table."""
    if df is None or df.empty:
        raise SystemExit(
            f"FAIL: Gold table '{name}' is empty. Run pipeline/run_local.py first."
        )
    missing = [c for c in columns if c not in df.columns]
    if missing:
        raise SystemExit(
            f"FAIL: '{name}' missing columns {missing}. Present: {list(df.columns)}"
        )
    print(f"  {name:<32} {len(df):>9,} rows")
    return df


def gini_from_lorenz(x, y) -> float:
    """Gini = 1 - 2 * area under the Lorenz curve (trapezoidal, full resolution)."""
    area = 0.0
    for i in range(1, len(x)):
        area += (x[i] - x[i - 1]) * (y[i] + y[i - 1]) / 2.0
    return 1.0 - 2.0 * area


def downsample(df: pd.DataFrame, n: int) -> pd.DataFrame:
    """Even stride, always keeping the first and last row."""
    if len(df) <= n:
        return df
    idx = [round(i * (len(df) - 1) / (n - 1)) for i in range(n)]
    return df.iloc[sorted(set(idx))]


def fact_row_count() -> int:
    """Exact fact-table row count, read from the Delta log rather than the data.

    Delta records num_records per file in the transaction log, so this is a
    metadata-only read -- no reason to scan 9.6M rows to print one number.
    """
    from deltalake import DeltaTable

    root = os.environ["LAKEHOUSE_LOCAL_ROOT"].rstrip("/")
    actions = DeltaTable(f"{root}/gold/fact_provider_service/").get_add_actions(flatten=True)
    return int(sum(actions.column("num_records").to_pylist()))


def inject_into_index(payload: str) -> None:
    """Inline the payload into docs/index.html between its sentinels.

    The dashboard ships as ONE self-contained file so it opens from disk, an email
    attachment, or GitHub Pages with no server and no fetch (a file:// fetch would
    be blocked by CORS). docs/data.json is kept alongside it as the canonical,
    reusable extract.
    """
    if not INDEX.exists():
        print(f"  (no {INDEX.name} to inject into)")
        return
    html = INDEX.read_text()
    start, end = "/*DATA_START*/", "/*DATA_END*/"
    i, j = html.find(start), html.find(end)
    if i == -1 or j == -1:
        raise SystemExit(f"FAIL: sentinels {start}/{end} not found in {INDEX.name}")
    INDEX.write_text(html[: i + len(start)] + payload + html[j:])
    print(f"Injected {len(payload) / 1024:.1f} KB into {INDEX.name} "
          f"({INDEX.stat().st_size / 1024:.1f} KB total)")


def main() -> int:
    print("Loading Gold tables:")
    geo = require(dl.load_hero_geo_arbitrage(), "gold_hero_geo_arbitrage",
                  "state_abrvtn", "ruca_bucket", "total_geo_premium", "total_pymt")
    nonpar = require(dl.load_hero_non_par_premium(), "gold_hero_non_par_premium",
                     "specialty", "non_par_premium_pct")
    jcode = require(dl.load_hero_jcode_concentration(), "gold_hero_jcode_concentration",
                    "npi", "drug_mdcr_pymt", "cum_share_providers", "cum_share_drug")
    cred = require(dl.load_hero_credentials_markup(), "gold_hero_credentials_markup",
                   "hcpcs_cd", "is_shared_e_and_m")
    site = require(dl.load_hero_site_neutral(), "gold_hero_site_neutral",
                   "hcpcs_cd", "F_pymt", "O_pymt", "site_neutral_savings")
    dprov = require(dl.load_dim_provider(), "dim_provider",
                    "npi", "specialty", "state_abrvtn", "total_mdcr_pymt")
    dhcpcs = require(dl.load_dim_hcpcs(), "dim_hcpcs",
                     "hcpcs_cd", "is_drug", "national_mdcr_pymt")
    dgeo = require(dl.load_dim_geography(), "dim_geography",
                   "state_abrvtn", "n_providers", "total_mdcr_pymt")

    for frame in (geo, nonpar, jcode, cred, site, dprov, dhcpcs, dgeo):
        for c in frame.columns:
            if frame[c].dtype == object and len(frame) and isinstance(
                frame[c].iloc[0], (int, float)
            ):
                continue

    out: dict = {}

    # ── meta ────────────────────────────────────────────────────────────────
    out["meta"] = {
        "cms_file": CMS_FILE,
        "cms_url": CMS_URL,
        "data_year": 2023,
        "generated": date.today().isoformat(),
        "source_rows": fact_row_count(),
    }

    # ── Hero 1: geographic arbitrage (state x RUCA, ships whole) ────────────
    geo = geo.copy()
    geo["_prem"] = geo["total_geo_premium"].map(num)
    geo["_pymt"] = geo["total_pymt"].map(num)
    geo["_benes"] = geo.get("total_benes_proxy", pd.Series([None] * len(geo))).map(num)
    geo["_svcs"] = geo.get("total_services", pd.Series([None] * len(geo))).map(num)
    out["geo"] = [
        {
            "state": r["state_abrvtn"], "ruca": r["ruca_bucket"],
            "premium": rnd(r["_prem"]), "pymt": rnd(r["_pymt"]),
            "benes": rnd(r["_benes"], 0), "svcs": rnd(r["_svcs"], 0),
            "prem_per_bene": rnd(r.get("geo_premium_per_bene"), 4),
        }
        for _, r in geo.iterrows()
        if isinstance(r["state_abrvtn"], str) and len(r["state_abrvtn"]) == 2
    ]

    # ── Hero 2: non-participating premium (per specialty, ships whole) ──────
    np_rows = []
    for _, r in nonpar.iterrows():
        pct = num(r["non_par_premium_pct"])
        if pct is None or not r["specialty"]:
            continue
        np_rows.append({
            "specialty": r["specialty"],
            "premium_pct": rnd(pct, 5),
            "exp_y": rnd(r.get("exposure_par_Y")),
            "exp_n": rnd(r.get("exposure_par_N")),
            "n_y": rnd(r.get("n_providers_Y"), 0),
            "n_n": rnd(r.get("n_providers_N"), 0),
            "pymt_y": rnd(r.get("total_mdcr_pymt_Y")),
            "pymt_n": rnd(r.get("total_mdcr_pymt_N")),
        })
    for d in np_rows:
        d["measurable"] = (d["n_n"] or 0) >= MIN_NONPAR_PROVIDERS
    np_rows.sort(key=lambda d: d["premium_pct"], reverse=True)
    out["nonpar"] = np_rows
    out["nonpar_stats"] = {
        "specialties_compared": len(np_rows),
        "positive": sum(1 for d in np_rows if d["premium_pct"] > 0),
        "negative": sum(1 for d in np_rows if d["premium_pct"] < 0),
        "measurable": sum(1 for d in np_rows if d["measurable"]),
        "min_nonpar_providers": MIN_NONPAR_PROVIDERS,
    }

    # ── Hero 3: Lorenz curve + Gini ─────────────────────────────────────────
    lz = jcode[["cum_share_providers", "cum_share_drug"]].copy()
    lz["x"] = lz["cum_share_providers"].map(num)
    lz["y"] = lz["cum_share_drug"].map(num)
    lz = lz.dropna(subset=["x", "y"]).sort_values("x")
    # Gini from the FULL curve, then downsample only what gets drawn.
    gini = gini_from_lorenz(lz["x"].tolist(), lz["y"].tolist())
    small = downsample(lz, LORENZ_POINTS)
    out["lorenz"] = [{"x": round(r.x, 5), "y": round(r.y, 5)}
                     for r in small.itertuples()]

    top_pct = {}
    for frac in (0.01, 0.05, 0.10):
        cut = lz[lz["x"] >= 1.0 - frac]
        if not cut.empty:
            top_pct[f"top{int(frac * 100)}"] = round(1.0 - float(cut["y"].iloc[0]), 5)

    out["jcode_top"] = [
        {"hcpcs": r["hcpcs_cd"],
         "desc": (r.get("hcpcs_desc") or "")[:90],
         "pymt": rnd(r["national_mdcr_pymt"]),
         "providers": rnd(r.get("n_providers"), 0)}
        for _, r in dhcpcs[dhcpcs["is_drug"] == True]  # noqa: E712
            .assign(_p=lambda d: d["national_mdcr_pymt"].map(num))
            .nlargest(25, "_p").iterrows()
    ]

    # ── Hero 4: credentials markup cliff ────────────────────────────────────
    TIERS = {
        "md": "Physician_MD_DO_markup",
        "np": "Nurse_Practitioner_markup",
        "pa": "Physician_Assistant_markup",
        "spec": "Specialist_markup",
    }
    present = {k: v for k, v in TIERS.items() if v in cred.columns}
    if not present:
        raise SystemExit(f"FAIL: no tier markup columns in credentials mart. "
                         f"Present: {list(cred.columns)}")
    cred = cred.copy()
    cred["_svcs"] = cred.get(
        "Physician_MD_DO_svcs", pd.Series([0] * len(cred))
    ).map(lambda v: num(v) or 0)

    def cred_row(r):
        row = {"hcpcs": r["hcpcs_cd"],
               "desc": (r.get("hcpcs_desc") or "")[:90],
               "shared": bool(r["is_shared_e_and_m"])}
        row.update({k: rnd(r.get(col), 3) for k, col in present.items()})
        return row

    shared = cred[cred["is_shared_e_and_m"] == True]  # noqa: E712
    rest = cred[cred["is_shared_e_and_m"] != True].nlargest(50, "_svcs")  # noqa: E712
    out["credentials"] = [cred_row(r) for _, r in shared.iterrows()] + \
                         [cred_row(r) for _, r in rest.iterrows()]
    out["credential_tiers"] = list(present.keys())

    # ── Hero 5: site-neutral counterfactual ─────────────────────────────────
    site = site.copy()
    site["_sav"] = site["_sav"] if "_sav" in site else site["site_neutral_savings"].map(num)
    site["_ratio"] = site["site_ratio"].map(num)
    site["_svcs"] = site["F_svcs"].map(lambda v: num(v) or 0)
    pos = float(site.loc[site["_sav"] > 0, "_sav"].sum())
    neg = float(site.loc[site["_sav"] < 0, "_sav"].sum())

    def site_row(r):
        return {"hcpcs": r["hcpcs_cd"], "desc": (r.get("hcpcs_desc") or "")[:90],
                "f_pymt": rnd(r["F_pymt"]), "o_pymt": rnd(r["O_pymt"]),
                "f_svcs": rnd(r["_svcs"], 0), "ratio": rnd(r["_ratio"], 3),
                "savings": rnd(r["_sav"])}

    # Scatter shows the HIGHEST-VOLUME codes, not the extremes -- the mainstream
    # pattern is the finding, and ranking by savings would show only the tails.
    out["site_scatter"] = [site_row(r) for _, r in site.nlargest(60, "_svcs").iterrows()]
    # Bars show both directions, because 830 of 972 codes point the other way.
    out["site_bar_pos"] = [site_row(r) for _, r in site.nlargest(12, "_sav").iterrows()]
    out["site_bar_neg"] = [site_row(r) for _, r in site.nsmallest(12, "_sav").iterrows()]
    out["site_stats"] = {
        "n_codes": int(len(site)),
        "f_gt_o": int((site["_ratio"] > 1).sum()),
        "o_gt_f": int((site["_ratio"] < 1).sum()),
        "pos": round(pos, 2), "neg": round(neg, 2), "net": round(pos + neg, 2),
        "median_ratio": rnd(site["_ratio"].median(), 3),
    }

    # ── Detail table: top drug-dependent providers ──────────────────────────
    jd = jcode.copy()
    jd["_drug"] = jd["drug_mdcr_pymt"].map(num)
    jd["_share"] = jd["drug_share"].map(num)
    dep = jd[(jd["_share"].notna()) & (jd["_share"] > 0.60)].nlargest(200, "_drug")
    out["providers"] = [
        {"npi": str(r["npi"]), "specialty": r.get("specialty") or "",
         "state": r.get("state_abrvtn") or "",
         "drug_pymt": rnd(r["_drug"]), "total_pymt": rnd(r["total_mdcr_pymt"]),
         "share": rnd(r["_share"], 4)}
        for _, r in dep.iterrows()
    ]

    # ── KPI ribbon ──────────────────────────────────────────────────────────
    dgeo = dgeo.copy()
    dgeo["_pymt"] = dgeo["total_mdcr_pymt"].map(num)
    dgeo["_prov"] = dgeo["n_providers"].map(num)
    med_premium = sorted(d["premium_pct"] for d in np_rows)
    # Participation is counted on dim_provider (one row per NPI) rather than summed
    # out of the pivot, which would double-count anyone billing in two specialties.
    n_par = int((dprov["is_participating"] == True).sum())   # noqa: E712
    n_nonpar = int((dprov["is_participating"] == False).sum())  # noqa: E712

    out["kpi"] = {
        "total_mdcr_pymt": round(float(dgeo["_pymt"].fillna(0).sum()), 2),
        "n_providers": int(len(dprov)),
        "n_hcpcs": int(len(dhcpcs)),
        "n_geographies": int(len(dgeo)),
        "gini": round(gini, 4),
        "nonpar_providers": n_nonpar,
        "par_providers": n_par,
        "nonpar_pct": round(n_nonpar / len(dprov), 6) if len(dprov) else None,
        "median_non_par_premium_pct": (
            round(med_premium[len(med_premium) // 2], 5) if med_premium else None
        ),
        "drug_dependent_providers": int((jd["_share"] > 0.60).sum()),
        "n_drug_providers": int(jd["_drug"].notna().sum()),
        **({"lorenz_" + k: v for k, v in top_pct.items()}),
    }

    OUT.parent.mkdir(exist_ok=True)
    payload = json.dumps(out, separators=(",", ":"))
    OUT.write_text(payload)
    kb = OUT.stat().st_size / 1024
    print(f"\nWrote {OUT.relative_to(REPO)} — {kb:.1f} KB")
    for key in out:
        v = out[key]
        print(f"  {key:<18} {len(v) if isinstance(v, list) else 'obj'}")
    if kb > 400:
        print(f"\nWARNING: {kb:.0f} KB exceeds the 400 KB budget.")
    inject_into_index(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
