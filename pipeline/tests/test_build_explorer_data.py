"""Unit tests for the explorer Parquet builder.

These run on small synthetic pyarrow tables, not the real 9.66M-row Gold layer,
so they are fast and need no pipeline run. Parity against the real data is a
separate verification step in Task 3.
"""

import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
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


from build_explorer_data import DIMS, build_cohorts, build_cube, tighten

FACT_COLS = {
    "npi": ["1", "1", "2", "3"],
    "specialty": ["Cardiology"] * 3 + ["Podiatry"],
    "provider_tier": ["Physician (MD/DO)"] * 4,
    "state_abrvtn": ["NY", "NY", "CA", "CA"],
    "ruca_bucket": ["Urban"] * 4,
    "is_rural": [False] * 4,
    "is_participating": [True, True, True, False],
    "hcpcs_cd": ["99213", "99214", "99213", "99213"],
    "is_drug": [False] * 4,
    "place_of_srvc": ["O", "F", "O", "O"],
    "Tot_Benes": [11, 12, 13, 14],
    "Tot_Srvcs": [100, 200, 300, 400],
    "Tot_Sbmtd_Chrg": [1000.0, 2000.0, 3000.0, 4000.0],
    "Tot_Mdcr_Alowd_Amt": [500.0, 600.0, 700.0, 800.0],
    "Tot_Mdcr_Pymt_Amt": [400.0, 500.0, 600.0, 700.0],
    "Tot_Mdcr_Stdzd_Amt": [390.0, 490.0, 590.0, 690.0],
    # Ruling R13: beneficiary-weighted products, as load_fact() would compute
    # them (Avg_Sbmtd_Chrg/Avg_Mdcr_Pymt_Amt x Tot_Benes). Values here don't
    # need to reconcile with Tot_Sbmtd_Chrg/Tot_Mdcr_Pymt_Amt above -- these
    # tests only check that the columns survive build_cube/tighten.
    "bw_sbmtd": [3800.0, 4800.0, 3900.0, 2800.0],
    "bw_pymt": [3600.0, 4500.0, 3700.0, 2450.0],
}


def _full_fact():
    t = pa.table(FACT_COLS)
    return t.append_column(
        "in_top50_basket", pa.array([True, False, True, True])
    )


def _dim_provider():
    # One row per NPI -- the provider-grain counterpart to FACT_COLS above.
    # npi "1" and "2" are both Cardiology/participating; npi "3" is Podiatry/not.
    return pa.table({
        "npi": ["1", "2", "3"],
        "specialty": ["Cardiology", "Cardiology", "Podiatry"],
        "is_participating": [True, True, False],
    })


def test_cube_dims_keeps_basket_as_a_grouping_column():
    cube = build_cube(_full_fact(), [d for d in DIMS if d != "hcpcs_cd"])
    assert "in_top50_basket" in cube.column_names, (
        "cube_dims drops hcpcs_cd, so the basket flag must be a GROUP BY key or "
        "hero 1 becomes unreproducible"
    )
    assert "hcpcs_cd" not in cube.column_names


def test_cube_dims_preserves_totals_exactly():
    cube = build_cube(_full_fact(), [d for d in DIMS if d != "hcpcs_cd"])
    assert pc.sum(cube["Tot_Mdcr_Pymt_Amt_sum"]).as_py() == pytest.approx(2200.0)
    assert pc.sum(cube["Tot_Srvcs_sum"]).as_py() == 1000


def test_cube_dims_separates_basket_from_non_basket_rows():
    cube = build_cube(_full_fact(), [d for d in DIMS if d != "hcpcs_cd"])
    in_basket = cube.filter(pc.equal(cube["in_top50_basket"], True))
    # Rows 0, 2, 3 are in the basket: 400 + 600 + 700
    assert pc.sum(in_basket["Tot_Mdcr_Pymt_Amt_sum"]).as_py() == pytest.approx(1700.0)


def test_tighten_dictionary_encodes_dimensions_and_widens_money():
    out = tighten(build_cube(_full_fact(), [d for d in DIMS if d != "hcpcs_cd"]))
    assert pa.types.is_dictionary(out.schema.field("specialty").type)
    assert pa.types.is_float64(out.schema.field("Tot_Mdcr_Pymt_Amt_sum").type)
    assert pa.types.is_int64(out.schema.field("Tot_Srvcs_sum").type)


def test_tighten_widens_bene_weighted_measures_to_float64():
    # Ruling R13: bw_sbmtd_sum/bw_pymt_sum are money but don't end in
    # "Chrg_sum"/"Amt_sum", so _MONEY_SUFFIXES alone would miss them and let
    # them fall through to the int64 branch, truncating money to whole
    # dollars.
    out = tighten(build_cube(_full_fact(), [d for d in DIMS if d != "hcpcs_cd"]))
    assert pa.types.is_float64(out.schema.field("bw_sbmtd_sum").type)
    assert pa.types.is_float64(out.schema.field("bw_pymt_sum").type)


def test_bene_weighted_exposure_differs_from_service_weighted():
    # Ruling R13: hero 2's published patient exposure is BENEFICIARY-weighted
    # (SUM(Avg_* x Tot_Benes) / SUM(Tot_Benes)), not service-weighted like
    # Tot_Sbmtd_Chrg/Tot_Mdcr_Pymt_Amt (= Avg_* x Tot_Srvcs). Row A has many
    # benes and few services; row B the reverse -- so the two weightings must
    # land far apart. This fails if bw_sbmtd/bw_pymt are ever "simplified"
    # back to reusing Tot_Sbmtd_Chrg/Tot_Mdcr_Pymt_Amt.
    t = pa.table({
        "specialty": ["Cardiology", "Cardiology"],
        "Tot_Benes": pa.array([100, 1], pa.int64()),
        "Tot_Srvcs": pa.array([1, 100], pa.int64()),
        "Tot_Sbmtd_Chrg": [100.0, 1000.0],    # Avg_Sbmtd_Chrg (100, 10) x Tot_Srvcs
        "Tot_Mdcr_Alowd_Amt": [0.0, 0.0],     # unused by this test; MEASURES needs it
        "Tot_Mdcr_Pymt_Amt": [90.0, 900.0],   # Avg_Mdcr_Pymt_Amt (90, 9)  x Tot_Srvcs
        "Tot_Mdcr_Stdzd_Amt": [0.0, 0.0],     # unused by this test; MEASURES needs it
        "bw_sbmtd": [100.0 * 100, 10.0 * 1],  # Avg_Sbmtd_Chrg x Tot_Benes
        "bw_pymt": [90.0 * 100, 9.0 * 1],     # Avg_Mdcr_Pymt_Amt x Tot_Benes
    })
    cube = build_cube(t, ["specialty"])
    row = cube.to_pylist()[0]

    bene_weighted = (row["bw_sbmtd_sum"] - row["bw_pymt_sum"]) / row["Tot_Benes_sum"]
    service_weighted = (
        (row["Tot_Sbmtd_Chrg_sum"] - row["Tot_Mdcr_Pymt_Amt_sum"]) / row["Tot_Benes_sum"]
    )
    assert bene_weighted == pytest.approx(1001 / 101)
    assert service_weighted == pytest.approx(110 / 101)
    assert bene_weighted != pytest.approx(service_weighted, rel=0.1), (
        "bene-weighted and service-weighted exposure must diverge here -- if "
        "they match, bw_sbmtd/bw_pymt have been swapped for the service-"
        "weighted Tot_Sbmtd_Chrg/Tot_Mdcr_Pymt_Amt columns"
    )


def test_cohorts_counts_distinct_providers_not_rows():
    cohorts = build_cohorts(_full_fact(), _dim_provider())
    h2 = cohorts.filter(pc.equal(cohorts["grain"], "h2")).to_pylist()
    cardio = [r for r in h2 if r["k1"] == "Cardiology" and r["k2"] == "True"]
    assert len(cardio) == 1
    # npi "1" appears twice in Cardiology; it must count once.
    assert cardio[0]["n_providers"] == 2


def test_cohorts_covers_all_five_panel_grains():
    grains = set(build_cohorts(_full_fact(), _dim_provider())["grain"].to_pylist())
    assert grains == {"h1", "h2", "h2p", "h4", "h5"}


def test_cohorts_h2_is_fact_sourced_not_dim_provider():
    # R7-REVISED: h2 serves the published PER-SPECIALTY provider counts
    # (docs/data.json nonpar[].n_y/n_n), which the mart computes at fact
    # grain. Give dim_provider a different is_participating value than the
    # fact table has for npi "3", and confirm h2 follows the FACT table's
    # answer, not dim_provider's.
    dim_provider = pa.table({
        "npi": ["1", "2", "3"],
        "specialty": ["Cardiology", "Cardiology", "Podiatry"],
        "is_participating": [True, True, True],  # npi "3" flipped vs. fact (False)
    })
    cohorts = build_cohorts(_full_fact(), dim_provider)
    h2 = cohorts.filter(pc.equal(cohorts["grain"], "h2")).to_pylist()
    non_par = [r for r in h2 if r["k1"] == "Podiatry" and r["k2"] == "False"]
    assert len(non_par) == 1 and non_par[0]["n_providers"] == 1, (
        "h2 must read is_participating from the fact table, not dim_provider"
    )


def test_cohorts_h2p_is_sourced_from_dim_provider_not_fact():
    # R7-REVISED: h2p serves the published KPI-ribbon scalar
    # (docs/data.json kpi.nonpar_providers), which the mart computes from
    # dim_provider's per-NPI dedup. Same disagreeing dim_provider as above;
    # this time assert h2p follows DIM_PROVIDER's answer (nobody
    # non-participating), not the fact table's.
    dim_provider = pa.table({
        "npi": ["1", "2", "3"],
        "specialty": ["Cardiology", "Cardiology", "Podiatry"],
        "is_participating": [True, True, True],
    })
    cohorts = build_cohorts(_full_fact(), dim_provider)
    h2p = cohorts.filter(pc.equal(cohorts["grain"], "h2p")).to_pylist()
    non_par = [r for r in h2p if r["k2"] == "False"]
    assert non_par == [], (
        "h2p must read is_participating from dim_provider, not the fact table"
    )
