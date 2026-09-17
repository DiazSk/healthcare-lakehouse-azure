#!/usr/bin/env python
"""Build the tiered Parquet query surface for the interactive dashboard.

Reads the local Gold Delta tables and emits six Parquet files into docs/data/.
See context/specs/2026-09-17-interactive-dashboard-design.md for the tier design.

Usage:  .venv-local/bin/python pipeline/build_explorer_data.py
"""

from __future__ import annotations

import pyarrow as pa
import pyarrow.compute as pc

# Hero 1 compares states over a FIXED basket of procedures so the comparison is
# apples-to-apples. Same rule as notebooks/04_gold_hero_marts.ipynb cell 3:
# the 50 codes with the largest total service volume, resolved once.
BASKET_SIZE = 50


def resolve_top50_basket(table: pa.Table) -> set[str]:
    """The BASKET_SIZE codes with the largest SUM(Tot_Srvcs).

    Volume is summed per code across rows -- comparing row-level volumes would
    pick different codes and silently change hero 1's numbers.
    """
    by_code = table.select(["hcpcs_cd", "Tot_Srvcs"]).group_by("hcpcs_cd").aggregate(
        [("Tot_Srvcs", "sum")]
    )
    ranked = by_code.sort_by([("Tot_Srvcs_sum", "descending")])
    return set(ranked.slice(0, BASKET_SIZE)["hcpcs_cd"].to_pylist())


import os
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "docs" / "data"

# The fixed dimension set. in_top50_basket is a real grouping dimension, not a
# post-hoc filter: cube_dims has no hcpcs_cd, so once aggregated it could not
# otherwise distinguish basket rows from the rest.
DIMS = [
    "specialty", "provider_tier", "state_abrvtn", "ruca_bucket", "is_rural",
    "is_participating", "is_drug", "place_of_srvc", "in_top50_basket", "hcpcs_cd",
]

MEASURES = [
    ("Tot_Benes", "sum"),
    ("Tot_Srvcs", "sum"),
    ("Tot_Sbmtd_Chrg", "sum"),
    ("Tot_Mdcr_Alowd_Amt", "sum"),
    ("Tot_Mdcr_Pymt_Amt", "sum"),
    ("Tot_Mdcr_Stdzd_Amt", "sum"),
]

# Exact distinct-provider counts, at the grains the panel guardrails need.
# The cubes drop npi, and summing a per-cell count across cells would
# over-count any provider billing in more than one cell -- so these are
# precomputed instead of derived.
COHORT_GRAINS = {
    "h1": ["state_abrvtn", "ruca_bucket", "in_top50_basket"],
    "h2": ["specialty", "is_participating"],
    "h4": ["hcpcs_cd", "provider_tier"],
    "h5": ["hcpcs_cd", "place_of_srvc"],
}

_MONEY_SUFFIXES = ("Chrg_sum", "Amt_sum")


def tighten(table: pa.Table) -> pa.Table:
    """Cast to the compact on-disk types the browser reads."""
    fields = []
    for f in table.schema:
        if pa.types.is_string(f.type):
            fields.append(pa.field(f.name, pa.dictionary(pa.int32(), pa.string())))
        elif f.name.endswith(_MONEY_SUFFIXES):
            # Money is float64 deliberately: float32 cube rows sum to $124.61 error
            # vs. exact published totals; float64 is exact.
            fields.append(pa.field(f.name, pa.float64()))
        elif f.name.endswith("_sum") or f.name == "n_providers":
            fields.append(pa.field(f.name, pa.int64()))
        else:
            fields.append(f)
    return table.cast(pa.schema(fields))


def build_cube(fact: pa.Table, dims: list[str]) -> pa.Table:
    """Group the fact to `dims` and sum every measure."""
    return tighten(fact.group_by(list(dims)).aggregate(MEASURES))


def build_cohorts(fact: pa.Table, dim_provider: pa.Table) -> pa.Table:
    """Long/narrow exact distinct-provider counts: grain, k1, k2, k3, n_providers.

    h1/h4/h5 key on CLAIM attributes (state x rurality, code x tier, code x
    place) where one provider legitimately appears in several cells, so they
    are counted from the fact table with count_distinct(npi). h2 keys on
    `is_participating`, a PROVIDER attribute, so it is counted from
    dim_provider (one row per NPI) instead -- count_distinct(npi) there is
    equivalent to COUNT(*), but harmless to keep for one code path.

    Ruling R7: the published hero 2 *exposure* figures (docs/data.json) come
    from the fact-level is_participating flag (04_gold_hero_marts.ipynb cell
    5), while its published *provider count* (1,130) comes from
    dim_provider's first(ignorenulls=True) pick per NPI. Those two are at
    different grains and can legitimately disagree -- ~522 providers have
    both True and False rows in the fact table, and dim_provider arbitrarily
    picks one. That inconsistency already ships live (dashboard, README,
    article draft at 1,130 / 0.096%), so h2 reproduces it deliberately rather
    than reconciling it to a single grain.
    """
    rows = []
    for grain, keys in COHORT_GRAINS.items():
        source = dim_provider if grain == "h2" else fact
        counted = source.select(keys + ["npi"]).group_by(keys).aggregate(
            [("npi", "count_distinct")]
        )
        data = counted.to_pydict()
        for i in range(counted.num_rows):
            rows.append({
                "grain": grain,
                "k1": str(data[keys[0]][i]),
                "k2": str(data[keys[1]][i]) if len(keys) > 1 else None,
                "k3": str(data[keys[2]][i]) if len(keys) > 2 else None,
                "n_providers": data["npi_count_distinct"][i],
            })
    return tighten(pa.Table.from_pylist(rows))


def write_parquet(table: pa.Table, path: Path) -> int:
    """Write with the standard compact options; return bytes written."""
    import pyarrow.parquet as pq

    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(
        table, path, compression="zstd", compression_level=19, use_dictionary=True
    )
    return os.path.getsize(path)


import sys

# Reuse the dashboard's loader so the marimo app, the static publisher and this
# builder all read the Gold layer through one code path.
os.environ.setdefault("LAKEHOUSE_LOCAL_ROOT", str(REPO / "data"))
os.environ["DATA_LOADER_STRICT"] = "1"   # never silently publish an empty file
sys.path.insert(0, str(REPO / "dashboard"))

FACT_COLUMNS = [
    "npi", "specialty", "provider_tier", "state_abrvtn", "ruca_bucket", "is_rural",
    "is_participating", "hcpcs_cd", "is_drug", "place_of_srvc",
    "Tot_Benes", "Tot_Srvcs", "Tot_Sbmtd_Chrg", "Tot_Mdcr_Alowd_Amt",
    "Tot_Mdcr_Pymt_Amt", "Tot_Mdcr_Stdzd_Amt",
    # Needed to replicate hero 1's predicate: it excludes rows with no
    # standardized amount, because Geo_Premium is meaningless without one.
    # On the 2023 vintage, 0 of 9,660,252 rows are null here, so this column
    # is currently a no-op filter target -- kept because a future CMS vintage
    # could introduce nulls and silently change hero 1's numbers.
    "Avg_Mdcr_Stdzd_Amt",
]


def load_fact() -> pa.Table:
    """The Gold fact table as pyarrow, with in_top50_basket attached."""
    from utils import data_loader as dl

    df = dl.load_fact_provider_service()
    if df.empty:
        raise SystemExit("FAIL: fact_provider_service is empty. Run pipeline/run_local.py first.")
    fact = pa.Table.from_pandas(df[FACT_COLUMNS], preserve_index=False)
    basket = resolve_top50_basket(fact)
    flag = pc.is_in(fact["hcpcs_cd"], value_set=pa.array(sorted(basket)))
    return fact.append_column("in_top50_basket", flag)


def load_dim_provider() -> pa.Table:
    """The Gold dim_provider table as pyarrow -- one row per NPI.

    Needed only for cohort grain h2 (see build_cohorts): is_participating is
    a provider attribute, and dim_provider is where the Gold marts resolve it
    to a single value per NPI.
    """
    from utils import data_loader as dl

    df = dl.load_dim_provider()
    if df.empty:
        raise SystemExit("FAIL: dim_provider is empty. Run pipeline/run_local.py first.")
    return pa.Table.from_pandas(
        df[["npi", "specialty", "is_participating"]], preserve_index=False
    )


def main() -> int:
    fact = load_fact()
    dim_provider = load_dim_provider()
    print(f"fact: {fact.num_rows:,} rows")

    dims_no_code = [d for d in DIMS if d != "hcpcs_cd"]
    code_dims = ["hcpcs_cd", "provider_tier", "place_of_srvc", "is_drug"]
    prov_dims = ["npi", "specialty", "state_abrvtn", "provider_tier",
                 "is_participating", "is_drug"]

    artifacts = {
        # Tier 1 -- loaded on "Explore" click.
        "cube_dims": build_cube(fact, dims_no_code),
        "cube_code": build_cube(fact, code_dims),
        "cohorts": build_cohorts(fact, dim_provider),
        # Tier 2 -- loaded when hero 3 is filtered (its Lorenz needs npi grain).
        "providers_drug": build_cube(
            fact.filter(pc.equal(fact["is_drug"], True)), prov_dims
        ),
        # Tier 3 -- range-read by the explorer page only.
        "cube_full": build_cube(fact, DIMS),
        "providers": build_cube(fact, prov_dims),
    }

    total = 0
    for name, table in artifacts.items():
        written = write_parquet(table, OUT_DIR / f"{name}.parquet")
        total += written
        print(f"  {name:<18} {table.num_rows:>9,} rows  {written / 1e6:>7.2f} MB")
    print(f"\nTotal {total / 1e6:.1f} MB in {OUT_DIR.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
