#!/usr/bin/env python
"""Build the tiered Parquet query surface for the interactive dashboard.

Reads the local Gold Delta tables and emits seven Parquet files into docs/data/.
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


import hashlib
import json
import os
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "docs" / "data"

# ── build manifest (format owned here, read by verify_explorer_parity.py) ─────
#
# The freshness gate asks one question: did the builder change since these
# artifacts were built? It used to answer it by comparing mtimes, which is wrong
# for the way this repo is actually handled -- `git clone`, `git checkout` and
# `git merge` rewrite every tracked file's mtime in one burst, in write order.
# The merge to main left all seven Parquet files 6-170 MILLISECONDS older than
# this script and failed the gate on artifacts that were perfectly current
# (9 of 9 value checks passed at the same time); on a fresh clone the check
# passes or fails by luck of ordering. Task 3's ledger had already flagged this
# as a deferred minor.
#
# A hash of the builder's own source answers the real question, and is immune to
# timestamps, clones and checkouts. It ships next to the Parquet so the gate
# works on a fresh clone -- `docs/data/` survives .gitignore's bare `data/` rule
# only through the explicit `!/docs/data/` negation (Ruling R12), which does
# cover this file: `git check-ignore -v docs/data/build-manifest.json` exits 1.
MANIFEST_NAME = "build-manifest.json"
REBUILD_CMD = "`.venv-local/bin/python pipeline/build_explorer_data.py`"


def builder_sha256(builder_path: Path | None = None) -> str:
    """SHA-256 of the builder's own source bytes."""
    target = builder_path or Path(__file__).resolve()
    return hashlib.sha256(target.read_bytes()).hexdigest()


def write_manifest(data_dir: Path, artifact_names, payload_generated=None) -> Path:
    path = data_dir / MANIFEST_NAME
    path.write_text(json.dumps({
        "builder": "pipeline/build_explorer_data.py",
        "builder_sha256": builder_sha256(),
        "artifacts": sorted(artifact_names),
        # Informational only, never gated on: which published payload these
        # artifacts sit beside. Nothing compares it, so it is labelled here
        # rather than left to look like a second check.
        "payload_generated": payload_generated,
    }, indent=2) + "\n")
    return path


def freshness_verdict(data_dir: Path, builder_path: Path) -> tuple[bool, str]:
    """(ok, message) for the gate. Every failure names the fix, not just the fact."""
    path = data_dir / MANIFEST_NAME
    if not path.exists():
        return False, f"{MANIFEST_NAME} is missing -- re-run {REBUILD_CMD}"
    try:
        manifest = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        return False, f"{MANIFEST_NAME} is not valid JSON ({exc}) -- re-run {REBUILD_CMD}"

    recorded = manifest.get("builder_sha256")
    current = builder_sha256(builder_path)
    if recorded != current:
        return False, (
            f"{builder_path.name} has changed since these artifacts were built "
            f"(recorded {str(recorded)[:12]}, current {current[:12]}) -- "
            f"re-run {REBUILD_CMD}"
        )

    absent = [n for n in manifest.get("artifacts", [])
              if not (data_dir / f"{n}.parquet").exists()]
    if absent:
        return False, (
            f"manifest lists {absent} but the Parquet is absent -- re-run {REBUILD_CMD}"
        )

    return True, (
        f"{builder_path.name} unchanged since these artifacts were built "
        f"({current[:12]}); all {len(manifest.get('artifacts', []))} artifacts present"
    )

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

# Ruling R15: bene-weighted measures exist SOLELY so hero 2's exposure
# (SUM(bw_sbmtd)/SUM(Tot_Benes) minus the same for bw_pymt) is reproducible
# from a cube -- see Ruling R13. The products are additive at row grain, so
# they survive any GROUP BY untouched. Hero 2 is a (specialty x
# is_participating) query, i.e. cube_dims only; no other artifact
# (cube_code, cube_code_h4, cohorts, providers_drug, cube_full, providers)
# reads them. MEASURES was global for one release and put these two float64
# columns on cube_full's 863,230 rows and providers' 1,396,961 rows for
# nothing -- ~35 MB dead weight. Confine them to cube_dims via this separate
# list instead of re-globalising MEASURES.
MEASURES_BW = MEASURES + [("bw_sbmtd", "sum"), ("bw_pymt", "sum")]

# Exact distinct-provider counts, at the grains the panel guardrails need.
# The cubes drop npi, and summing a per-cell count across cells would
# over-count any provider billing in more than one cell -- so these are
# precomputed instead of derived.
COHORT_GRAINS = {
    "h1": ["state_abrvtn", "ruca_bucket", "in_top50_basket"],
    "h2": ["specialty", "is_participating"],
    "h2p": ["specialty", "is_participating"],
    "h4": ["hcpcs_cd", "provider_tier"],
    "h5": ["hcpcs_cd", "place_of_srvc"],
}

_MONEY_SUFFIXES = ("Chrg_sum", "Amt_sum")
# bw_sbmtd_sum/bw_pymt_sum are money too (beneficiary-weighted dollar sums,
# Ruling R13) but don't end in either suffix above -- listed explicitly so
# they don't fall through to the int64 branch below and get truncated.
_MONEY_NAMES = {"bw_sbmtd_sum", "bw_pymt_sum"}


def tighten(table: pa.Table) -> pa.Table:
    """Cast to the compact on-disk types the browser reads."""
    fields = []
    for f in table.schema:
        if pa.types.is_string(f.type):
            fields.append(pa.field(f.name, pa.dictionary(pa.int32(), pa.string())))
        elif f.name.endswith(_MONEY_SUFFIXES) or f.name in _MONEY_NAMES:
            # Money is float64 deliberately: float32 cube rows sum to $124.61 error
            # vs. exact published totals; float64 is exact.
            fields.append(pa.field(f.name, pa.float64()))
        elif f.name.endswith("_sum") or f.name == "n_providers":
            fields.append(pa.field(f.name, pa.int64()))
        else:
            fields.append(f)
    return table.cast(pa.schema(fields))


def build_cube(fact: pa.Table, dims: list[str], measures: list = MEASURES) -> pa.Table:
    """Group the fact to `dims` and sum every measure."""
    return tighten(fact.group_by(list(dims)).aggregate(measures))


def build_cohorts(fact: pa.Table, dim_provider: pa.Table) -> pa.Table:
    """Long/narrow exact distinct-provider counts: grain, k1, k2, k3, n_providers.

    h1, h2, h4 and h5 all key on CLAIM attributes captured at fact grain --
    state x rurality, specialty x participation, code x tier, code x place --
    where one provider legitimately appears in several cells, so they are all
    counted from the fact table with count_distinct(npi). This matches how
    the Gold hero marts compute these same per-cell provider counts: hero 2's
    published per-specialty n_y/n_n (docs/data.json `nonpar[]`) come from
    `non_par_pivot`'s n_providers_Y/N in 04_gold_hero_marts.ipynb cell 5,
    which counts npi distinctly WITHIN the fact-grain (specialty,
    is_participating) groups -- i.e. exactly what h2 computes here.

    h2p is the one exception, added by Ruling R7-REVISED. It exists ONLY to
    reproduce the KPI ribbon's single scalar (docs/data.json
    `kpi.nonpar_providers` = 1,130), which the Gold marts compute from
    dim_provider (one row per NPI) via
    `F.first("Is_Participating", ignorenulls=True)` -- an order-dependent,
    provider-level dedup, not a fact-grain count (02_silver_to_gold_dims.ipynb
    cell 3). ~522 providers have both True and False rows in the fact table:
    summing h2 across all specialties counts each such provider once per
    specialty it appears under (1,461 total), while h2p, sourced from
    dim_provider, matches the mart's single arbitrary pick per NPI (1,130
    total). Both numbers are genuinely published, at genuinely different
    grains -- reproducing both, rather than picking one, is the point.

    R7 (the prior ruling) collapsed h2 itself onto dim_provider, which
    silently broke the per-specialty guardrail cells (e.g. Orthopedic Surgery
    published 11, dim_provider-sourced h2 gave 6) -- that was wrong and is
    reverted here.
    """
    rows = []
    for grain, keys in COHORT_GRAINS.items():
        source = dim_provider if grain == "h2p" else fact
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
    # Ruling R13: row-grain averages needed to build the beneficiary-weighted
    # measures below. Tot_Sbmtd_Chrg/Tot_Mdcr_Pymt_Amt are SERVICE-weighted
    # (Avg_* x Tot_Srvcs) and cannot substitute -- hero 2's exposure is
    # weighted by Tot_Benes instead, and the two diverge by >40% in practice.
    "Avg_Sbmtd_Chrg", "Avg_Mdcr_Pymt_Amt",
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
    fact = fact.append_column("in_top50_basket", flag)

    # Ruling R13: materialize the beneficiary-weighted products at row grain,
    # BEFORE any GROUP BY, so they stay additive through every cube -- the
    # same trick as in_top50_basket and cube_code_h4. pc.multiply is
    # null-safe (null * x -> null, never silently 0), so a missing Avg_* or
    # Tot_Benes correctly drops that row from the weighted sum instead of
    # dragging the average toward zero.
    bw_sbmtd = pc.multiply(
        fact["Avg_Sbmtd_Chrg"].cast(pa.float64()), fact["Tot_Benes"].cast(pa.float64())
    )
    bw_pymt = pc.multiply(
        fact["Avg_Mdcr_Pymt_Amt"].cast(pa.float64()), fact["Tot_Benes"].cast(pa.float64())
    )
    fact = fact.append_column("bw_sbmtd", bw_sbmtd)
    fact = fact.append_column("bw_pymt", bw_pymt)
    return fact


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

    # Ruling R9: hero 4's markup predicate (Tot_Srvcs >= 25, tier known) is a
    # ROW-grain filter. No cube keeps row grain -- not even cube_full, whose
    # finest cells are already 863,230-way aggregates -- so it must be
    # materialized as its own pre-filtered cube, the same trick as
    # in_top50_basket, rather than approximated by filtering a cube's summed
    # cells after the fact (04_gold_hero_marts.ipynb cell 9).
    h4_mask = pc.and_(
        pc.greater_equal(fact["Tot_Srvcs"], 25),
        pc.not_equal(fact["provider_tier"], "Other/Unknown"),
    )
    h4_fact = fact.filter(h4_mask)

    # The mart's Lorenz/Gini population additionally excludes providers whose
    # drug billing nets to zero Medicare payment -- a POST-aggregation filter
    # on the provider's total, not a row-level one (e.g. NPI 1760441786: 825
    # drug services, $0.00 paid across all of them; 04_gold_hero_marts.ipynb
    # cell 7 filters `drug_mdcr_pymt > 0` after grouping to provider grain).
    drug_providers = build_cube(
        fact.filter(pc.equal(fact["is_drug"], True)), prov_dims
    )
    drug_providers = drug_providers.filter(
        pc.greater(drug_providers["Tot_Mdcr_Pymt_Amt_sum"], 0)
    )

    artifacts = {
        # Tier 1 -- loaded on "Explore" click.
        "cube_dims": build_cube(fact, dims_no_code, measures=MEASURES_BW),
        "cube_code": build_cube(fact, code_dims),
        "cube_code_h4": build_cube(h4_fact, code_dims),
        "cohorts": build_cohorts(fact, dim_provider),
        # Tier 2 -- loaded when hero 3 is filtered (its Lorenz needs npi grain).
        "providers_drug": drug_providers,
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

    payload = REPO / "docs" / "data.json"
    generated = None
    if payload.exists():
        generated = json.loads(payload.read_text()).get("meta", {}).get("generated")
    manifest = write_manifest(OUT_DIR, artifacts, generated)
    print(f"Manifest {manifest.relative_to(REPO)} -- builder {builder_sha256()[:12]}")
    # ponytail: pyarrow's Parquet output isn't byte-stable run to run (row-group/
    # metadata layout varies even when the data doesn't), so `git status` will show
    # most of these ~61 MB files as modified after every rebuild. Only commit them
    # if the Gold layer actually changed -- `git checkout -- docs/data/` otherwise.
    # Upgrade path if reproducible artifacts ever matter: pin pyarrow's writer to a
    # deterministic row-group size and sort order.
    print("NOTE: docs/data/*.parquet will show as modified even when the data is "
          "unchanged -- pyarrow's Parquet output isn't byte-stable run to run. "
          "Only commit these files if the Gold layer actually changed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
