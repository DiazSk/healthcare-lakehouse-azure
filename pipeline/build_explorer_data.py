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
