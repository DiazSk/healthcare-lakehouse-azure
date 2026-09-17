#!/usr/bin/env python
"""Export the Gold layer to Parquet for Power BI Desktop (Import mode).

Power BI Desktop cannot read Delta without a connector, but it reads Parquet
natively via Get Data > Parquet. This flattens each Gold Delta table into one
Parquet file, casting DECIMAL to float64 because Power BI's Parquet reader
handles high-precision decimals inconsistently.

Output goes to powerbi/data/, which is gitignored -- fact_provider_service alone
is ~9.66M rows. Regenerate it locally rather than committing it.

Usage:  python pipeline/export_powerbi.py
"""

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
os.environ.setdefault("LAKEHOUSE_LOCAL_ROOT", str(REPO / "data"))
os.environ["DATA_LOADER_STRICT"] = "1"
sys.path.insert(0, str(REPO / "dashboard"))

import pandas as pd  # noqa: E402

from utils import data_loader as dl  # noqa: E402

OUT = REPO / "powerbi" / "data"
TABLES = {
    "dim_provider": dl.load_dim_provider,
    "dim_hcpcs": dl.load_dim_hcpcs,
    "dim_geography": dl.load_dim_geography,
    "fact_provider_service": dl.load_fact_provider_service,
    "gold_hero_geo_arbitrage": dl.load_hero_geo_arbitrage,
    "gold_hero_non_par_premium": dl.load_hero_non_par_premium,
    "gold_hero_jcode_concentration": dl.load_hero_jcode_concentration,
    "gold_hero_credentials_markup": dl.load_hero_credentials_markup,
    "gold_hero_site_neutral": dl.load_hero_site_neutral,
}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    for name, loader in TABLES.items():
        df = loader()
        if df.empty:
            raise SystemExit(f"FAIL: {name} is empty — run pipeline/run_local.py first.")
        # Decimal columns arrive as Python objects; Power BI wants plain numerics.
        for col in df.columns:
            if df[col].dtype == object:
                sample = df[col].dropna().head(1)
                if len(sample) and hasattr(sample.iloc[0], "as_tuple"):
                    df[col] = pd.to_numeric(df[col], errors="coerce")
        path = OUT / f"{name}.parquet"
        df.to_parquet(path, index=False, compression="snappy")
        mb = path.stat().st_size / 1e6
        total += mb
        print(f"  {name:<32} {len(df):>9,} rows  {mb:>8.1f} MB")
    print(f"\nWrote {len(TABLES)} Parquet files to {OUT.relative_to(REPO)} "
          f"({total:.0f} MB total)")
    print("Next: Power BI Desktop > Get Data > Parquet, then follow powerbi/BUILD_GUIDE.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
