#!/usr/bin/env python
"""Prove the Parquet cubes reproduce the validated static payload.

The static docs/data.json came from the Gold MARTS, which apply filters. A cube
query that omits one produces plausible numbers that are quietly wrong. This
script runs the live SQL against the cubes and compares to data.json.

Usage:  .venv-local/bin/python pipeline/verify_explorer_parity.py
"""

import json
import sys
from pathlib import Path

import duckdb

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "docs" / "data"
PAYLOAD = json.loads((REPO / "docs" / "data.json").read_text())

con = duckdb.connect()
for name in ("cube_dims", "cube_code", "cohorts", "providers_drug"):
    con.execute(
        f"CREATE VIEW {name} AS SELECT * FROM read_parquet('{DATA / (name + '.parquet')}')"
    )

failures = []


def check(label, got, want, tol=0.01):
    ok = abs(float(got) - float(want)) <= tol
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: got {got:,.2f} want {want:,.2f}")
    if not ok:
        failures.append(label)


# KPI: total Medicare paid, unfiltered.
check(
    "total medicare paid",
    con.execute("SELECT SUM(Tot_Mdcr_Pymt_Amt_sum) FROM cube_dims").fetchone()[0],
    PAYLOAD["kpi"]["total_mdcr_pymt"],
)

# Hero 1: NY geographic premium. Requires BOTH the basket restriction and the
# paid-minus-standardized definition.
ny_static = sum(r["premium"] for r in PAYLOAD["geo"] if r["state"] == "NY")
check(
    "hero1 NY geo premium",
    con.execute("""
        SELECT SUM(Tot_Mdcr_Pymt_Amt_sum) - SUM(Tot_Mdcr_Stdzd_Amt_sum)
        FROM cube_dims WHERE state_abrvtn = 'NY' AND in_top50_basket
    """).fetchone()[0],
    ny_static,
    # Ruling A: measured divergence is $0.30, caused by the Gold mart's own
    # DECIMAL(18,2) casting -- not predicate drift. 1.00 catches real drift
    # while tolerating that cast; the brief's 1000.0 was 3 orders too loose.
    tol=1.00,
)

# Hero 2: non-participating provider count.
check(
    "hero2 non-par providers",
    con.execute("""
        SELECT SUM(n_providers) FROM cohorts
        WHERE grain = 'h2' AND k2 = 'False'
    """).fetchone()[0],
    PAYLOAD["kpi"]["nonpar_providers"],
    tol=0.5,
)

# Hero 5: how many codes pay the physician less in a facility.
check(
    "hero5 office-cheaper codes",
    con.execute("""
        WITH per_code AS (
            SELECT hcpcs_cd,
                   SUM(CASE WHEN place_of_srvc='F' THEN Tot_Mdcr_Pymt_Amt_sum END) AS f_pymt,
                   SUM(CASE WHEN place_of_srvc='F' THEN Tot_Srvcs_sum END)         AS f_svcs,
                   SUM(CASE WHEN place_of_srvc='O' THEN Tot_Mdcr_Pymt_Amt_sum END) AS o_pymt,
                   SUM(CASE WHEN place_of_srvc='O' THEN Tot_Srvcs_sum END)         AS o_svcs
            FROM cube_code GROUP BY hcpcs_cd
        )
        SELECT COUNT(*) FROM per_code
        WHERE f_svcs >= 1000 AND o_svcs >= 1000
          AND (f_pymt / f_svcs) < (o_pymt / o_svcs)
    """).fetchone()[0],
    PAYLOAD["site_stats"]["o_gt_f"],
    # Ruling R8: tol=5 is the mart's own tie count (972 - 830 - 137 = 5), not
    # an arbitrary bump. The mart computes its F/O per-service averages as a
    # weighted average of the row-level Avg_Mdcr_Pymt_Amt, cast through
    # DECIMAL(18,2) at each step; for 5 codes that double-rounding collapses
    # the true difference to identical cents (site_ratio exactly 1.0), and
    # publish_dashboard.py excludes ties from both f_gt_o and o_gt_f. Our
    # cube sums exact float64 totals with no intermediate rounding, so it
    # resolves 3 of those 5 near-ties (81003, J7328, J2001) to the
    # office-cheaper side instead of a tie. A genuine predicate error would
    # move this count by hundreds, so tol=5 still catches real drift.
    tol=5,
)

print()
if failures:
    print(f"PARITY FAILED: {failures}")
    print("A mart predicate was missed -- see the spec's Predicate parity table.")
    sys.exit(1)
print("PARITY PASSED -- cubes reproduce the validated static payload.")
