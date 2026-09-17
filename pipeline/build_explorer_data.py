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


def build_cohorts(fact: pa.Table) -> pa.Table:
    """Long/narrow exact distinct-provider counts: grain, k1, k2, k3, n_providers."""
    rows = []
    for grain, keys in COHORT_GRAINS.items():
        counted = fact.select(keys + ["npi"]).group_by(keys).aggregate(
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
