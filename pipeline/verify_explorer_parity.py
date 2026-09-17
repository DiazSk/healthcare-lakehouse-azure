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
BUILDER = REPO / "pipeline" / "build_explorer_data.py"
PAYLOAD = json.loads((REPO / "docs" / "data.json").read_text())

failures = []


def check(label, got, want, tol=0.01):
    ok = abs(float(got) - float(want)) <= tol
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: got {got:,.2f} want {want:,.2f}")
    if not ok:
        failures.append(label)


# Finding 5: a green run against STALE artifacts is worse than no run at all --
# editing the builder and forgetting to re-execute it must not silently pass.
builder_mtime = BUILDER.stat().st_mtime
stale = [
    p.name for p in sorted(DATA.glob("*.parquet"))
    if p.stat().st_mtime < builder_mtime
]
if stale:
    print(f"  FAIL  freshness: {stale} older than {BUILDER.name} -- re-run "
          f"`.venv-local/bin/python pipeline/build_explorer_data.py`")
    failures.append("freshness")
else:
    print(f"  PASS  freshness: all docs/data/*.parquet newer than {BUILDER.name}")

con = duckdb.connect()
# Finding 4: register every file the builder ships, not just the four the
# original gate happened to check -- cube_full and providers are 54 of the
# 63 MB shipped and had no view, so a break in either would go undetected.
for name in ("cube_dims", "cube_code", "cube_code_h4", "cohorts",
             "providers_drug", "cube_full", "providers"):
    con.execute(
        f"CREATE VIEW {name} AS SELECT * FROM read_parquet('{DATA / (name + '.parquet')}')"
    )

# KPI: total Medicare paid, unfiltered.
check(
    "total medicare paid",
    con.execute("SELECT SUM(Tot_Mdcr_Pymt_Amt_sum) FROM cube_dims").fetchone()[0],
    PAYLOAD["kpi"]["total_mdcr_pymt"],
)

# Finding 4: same KPI, independently from cube_full (finest grain, Tier 3).
# A break specific to cube_full's own dimension set wouldn't show up above.
check(
    "total medicare paid (cube_full)",
    con.execute("SELECT SUM(Tot_Mdcr_Pymt_Amt_sum) FROM cube_full").fetchone()[0],
    PAYLOAD["kpi"]["total_mdcr_pymt"],
)

# Finding 4: providers.parquet's own distinct-provider count against the KPI
# ribbon's n_providers -- the other half of the 54 MB the old gate ignored.
check(
    "distinct providers (providers.parquet)",
    con.execute("SELECT COUNT(DISTINCT npi) FROM providers").fetchone()[0],
    PAYLOAD["kpi"]["n_providers"],
    tol=0.5,
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

# Hero 2 (Ruling R7-REVISED): the KPI-ribbon SCALAR is provider grain --
# dim_provider's first(ignorenulls=True) pick per NPI -- so it's checked
# against h2p, not h2. This is the ONLY thing h2p exists for.
check(
    "hero2 KPI non-par providers (h2p)",
    con.execute("""
        SELECT SUM(n_providers) FROM cohorts
        WHERE grain = 'h2p' AND k2 = 'False'
    """).fetchone()[0],
    PAYLOAD["kpi"]["nonpar_providers"],
    tol=0.5,
)

# Hero 2 (Ruling R7-REVISED, Finding 1): the guardrail badge reads a PER-CELL
# count from h2 (fact grain), not the KPI total. The old gate only checked
# the total summed across 104 specialties (SUM(n_providers) WHERE k2='False'),
# which stayed at 1,130-ish even when every individual cell was wrong -- e.g.
# h2 sourced from dim_provider gave Orthopedic Surgery 6 against a published
# 11, which crosses the WEAK=11 threshold and flips the badge from "thin" to
# "very-thin". Check one real published cell directly so that class of bug
# cannot hide behind an aggregate.
ortho = next(r for r in PAYLOAD["nonpar"] if r["specialty"] == "Orthopedic Surgery")
check(
    "hero2 cell: Orthopedic Surgery non-par providers (h2)",
    con.execute("""
        SELECT n_providers FROM cohorts
        WHERE grain = 'h2' AND k1 = 'Orthopedic Surgery' AND k2 = 'False'
    """).fetchone()[0],
    ortho["n_n"],
    tol=0.5,
)

# Hero 2 (Ruling R13): patient exposure is BENEFICIARY-weighted
# (SUM(Avg_Sbmtd_Chrg x Tot_Benes) / SUM(Tot_Benes) minus the same for
# Avg_Mdcr_Pymt_Amt -- 04_gold_hero_marts.ipynb cell 5), not service-weighted
# like Tot_Sbmtd_Chrg/Tot_Mdcr_Pymt_Amt (= Avg_* x Tot_Srvcs). Using the
# service-weighted measures here would be 41% off (measured for Dermatology:
# $260.60 vs. published $184.68) while still looking plausible -- this check
# exists so that error can't ship silently.
derm = next(r for r in PAYLOAD["nonpar"] if r["specialty"] == "Dermatology")
check(
    "hero2 Dermatology participating exposure (bene-weighted)",
    con.execute("""
        SELECT (SUM(bw_sbmtd_sum) - SUM(bw_pymt_sum)) / SUM(Tot_Benes_sum)
        FROM cube_dims WHERE specialty = 'Dermatology' AND is_participating
    """).fetchone()[0],
    derm["exp_y"],
    tol=0.01,
)

# Hero 4 (Ruling R9): the chargemaster markup ratio needs Tot_Srvcs >= 25 AND
# provider_tier <> 'Other/Unknown', a ROW-grain predicate no existing cube
# preserves -- not even cube_full (863,230 cells from 9,660,252 rows). Check
# a specific published cell from the pre-filtered cube_code_h4.
check(
    "hero4 markup: 99213 Physician (MD/DO)",
    con.execute("""
        SELECT SUM(Tot_Sbmtd_Chrg_sum) / SUM(Tot_Mdcr_Alowd_Amt_sum)
        FROM cube_code_h4
        WHERE hcpcs_cd = '99213' AND provider_tier = 'Physician (MD/DO)'
    """).fetchone()[0],
    next(r for r in PAYLOAD["credentials"] if r["hcpcs"] == "99213")["md"],
    tol=0.001,
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
