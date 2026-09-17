"""Unit tests for the explorer Parquet builder.

These run on small synthetic pyarrow tables, not the real 9.66M-row Gold layer,
so they are fast and need no pipeline run. Parity against the real data is a
separate verification step in Task 3.
"""

import sys
from pathlib import Path

import pyarrow as pa
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from build_explorer_data import resolve_top50_basket


def _fact(codes_and_volumes):
    """Build a minimal fact-shaped table: one row per (code, volume) pair."""
    codes, vols = zip(*codes_and_volumes)
    return pa.table({"hcpcs_cd": pa.array(codes), "Tot_Srvcs": pa.array(vols, pa.int64())})


def test_picks_the_50_largest_codes_by_summed_volume():
    # 60 codes; code "C00".."C59" with volume equal to its index.
    rows = [(f"C{i:02d}", i) for i in range(60)]
    basket = resolve_top50_basket(_fact(rows))
    assert len(basket) == 50
    # The ten smallest must be excluded.
    assert basket.isdisjoint({f"C{i:02d}" for i in range(10)})
    assert "C59" in basket


def test_sums_volume_across_rows_rather_than_taking_the_max():
    # "SPLIT" appears in three small rows that together outrank "BIG".
    rows = [("SPLIT", 40), ("SPLIT", 40), ("SPLIT", 40), ("BIG", 100)]
    rows += [(f"F{i:02d}", 1) for i in range(60)]
    basket = resolve_top50_basket(_fact(rows))
    assert "SPLIT" in basket, "volume must be summed per code, not compared per row"


def test_returns_all_codes_when_fewer_than_fifty_exist():
    basket = resolve_top50_basket(_fact([("A", 5), ("B", 3)]))
    assert basket == {"A", "B"}


def test_ignores_null_volumes_without_crashing():
    t = pa.table({"hcpcs_cd": pa.array(["A", "B"]),
                  "Tot_Srvcs": pa.array([None, 7], pa.int64())})
    basket = resolve_top50_basket(t)
    assert "B" in basket
