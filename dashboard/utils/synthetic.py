"""Generate synthetic Gold-shaped DataFrames for the demo dashboard.

Schemas match the real Gold tables produced by the PySpark notebooks, so the
demo and analytics dashboards can share chart code unchanged. Distributions are
hand-tuned to be visually realistic (Medicare-like markups, drug-revenue
concentration, geographic spread) without claiming statistical accuracy.

All generators take a `seed` argument for reproducibility.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


# Curated set of US states (50 + DC) for choropleth coverage.
STATES = [
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
    "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
    "VA","WA","WV","WI","WY","DC",
]

SPECIALTIES = [
    "Internal Medicine", "Family Practice", "Cardiology", "Ophthalmology",
    "Orthopedic Surgery", "Dermatology", "Psychiatry", "Radiology",
    "Anesthesiology", "Emergency Medicine", "Nurse Practitioner",
    "Physician Assistant", "Gastroenterology", "Nephrology", "Oncology",
]

PROVIDER_TIERS = [
    "Physician (MD/DO)",
    "Nurse Practitioner",
    "Physician Assistant",
    "Specialist",
    "Other/Unknown",
]

RUCA_BUCKETS = ["Urban", "Large rural", "Small rural / isolated"]

# Realistic-ish HCPCS sample (shared E&M + a few procedural + a few drugs).
HCPCS_SAMPLE = [
    ("99213", "Office/outpatient visit, est",                  "N"),
    ("99214", "Office/outpatient visit, est",                  "N"),
    ("99203", "Office/outpatient visit, new",                  "N"),
    ("99204", "Office/outpatient visit, new",                  "N"),
    ("99215", "Office/outpatient visit, est",                  "N"),
    ("66984", "Cataract surgery with IOL",                     "N"),
    ("45378", "Diagnostic colonoscopy",                        "N"),
    ("93000", "Electrocardiogram, complete",                   "N"),
    ("77067", "Screening mammography, bilateral",              "N"),
    ("J0897", "Denosumab injection",                           "Y"),
    ("J9355", "Trastuzumab injection",                         "Y"),
    ("J3490", "Unclassified drug injection",                   "Y"),
    ("J9217", "Leuprolide acetate injection",                  "Y"),
    ("Q5107", "Bevacizumab biosimilar injection",              "Y"),
    ("J2778", "Ranibizumab injection",                         "Y"),
]


# ── Dimensions ──────────────────────────────────────────────────────────────

def dim_provider(n: int = 1500, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    npis = np.array([f"{1000000000 + i}" for i in range(n)])
    return pd.DataFrame({
        "npi": npis,
        "display_name": [f"Provider {i:04d}" for i in range(n)],
        "credentials_raw": rng.choice(["M.D.", "D.O.", "N.P.", "P.A.", "O.D., F.A.A.O.", "M.D., F.A.C.S."], n),
        "provider_tier": rng.choice(PROVIDER_TIERS, n, p=[0.65, 0.12, 0.08, 0.10, 0.05]),
        "specialty": rng.choice(SPECIALTIES, n),
        "state_abrvtn": rng.choice(STATES, n),
        "city": rng.choice(["Boston", "Houston", "Phoenix", "Atlanta", "Seattle", "Miami", "Denver"], n),
        "ruca_bucket": rng.choice(RUCA_BUCKETS, n, p=[0.72, 0.20, 0.08]),
        "is_rural": rng.random(n) < 0.28,
        "is_participating": rng.random(n) < 0.96,
        "total_mdcr_pymt": rng.gamma(2.0, 30000.0, n).round(2),
        "total_services": rng.integers(50, 50000, n),
        "n_distinct_hcpcs": rng.integers(1, 80, n),
    })


def dim_hcpcs(seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    return pd.DataFrame({
        "hcpcs_cd":   [c[0] for c in HCPCS_SAMPLE],
        "hcpcs_desc": [c[1] for c in HCPCS_SAMPLE],
        "is_drug":    [c[2] == "Y" for c in HCPCS_SAMPLE],
        "hcpcs_family": [c[0][0] for c in HCPCS_SAMPLE],
        "national_services":  rng.integers(50_000, 5_000_000, len(HCPCS_SAMPLE)),
        "national_mdcr_pymt": rng.uniform(1e6, 1.5e9, len(HCPCS_SAMPLE)).round(2),
        "n_providers":        rng.integers(500, 250_000, len(HCPCS_SAMPLE)),
    })


def dim_geography(seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    return pd.DataFrame({
        "state_abrvtn": STATES,
        "state_fips":   [f"{i:02d}" for i in range(1, len(STATES) + 1)],
        "n_providers":      rng.integers(500, 80_000, len(STATES)),
        "total_benes_proxy": rng.integers(50_000, 4_000_000, len(STATES)),
        "total_mdcr_pymt":   rng.uniform(5e7, 3e9, len(STATES)).round(2),
        "rural_share_of_rows": rng.uniform(0.05, 0.55, len(STATES)).round(3),
        "avg_geo_adj_factor":  rng.normal(1.00, 0.10, len(STATES)).clip(0.75, 1.30).round(3),
    })


# ── Hero marts ──────────────────────────────────────────────────────────────

def hero_geo_arbitrage(seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []
    for st in STATES:
        for bucket in RUCA_BUCKETS:
            base_pymt = rng.uniform(3e7, 5e8)
            # Coastal/metro states skew positive premium; rural buckets skew negative.
            bucket_mult = {"Urban": 1.0, "Large rural": -0.4, "Small rural / isolated": -0.7}[bucket]
            state_mult = {"NY": 1.6, "CA": 1.5, "MA": 1.4, "MS": -0.5, "WV": -0.4}.get(st, rng.normal(0, 1))
            geo_premium = base_pymt * 0.08 * (state_mult * 0.5 + bucket_mult)
            benes = rng.integers(50_000, 1_500_000)
            rows.append({
                "state_abrvtn": st,
                "ruca_bucket":  bucket,
                "total_geo_premium": round(geo_premium, 2),
                "total_pymt":        round(base_pymt, 2),
                "total_stdzd":       round(base_pymt - geo_premium, 2),
                "total_benes_proxy": int(benes),
                "total_services":    int(rng.integers(100_000, 8_000_000)),
                "avg_geo_adj_factor": round(rng.normal(1.0, 0.08), 3),
                "geo_premium_per_bene": round(geo_premium / max(benes, 1), 2),
            })
    return pd.DataFrame(rows)


def hero_non_par_premium(seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []
    for spec in SPECIALTIES:
        # Psychiatry & dermatology have higher non-par premium in reality.
        spec_premium = {
            "Psychiatry": 0.31, "Dermatology": 0.22, "Ophthalmology": 0.18,
            "Cardiology": 0.12, "Orthopedic Surgery": 0.15,
        }.get(spec, rng.uniform(0.05, 0.20))
        exp_Y = rng.uniform(40, 120)
        exp_N = exp_Y * (1 + spec_premium)
        n_par = int(rng.integers(2_000, 80_000))
        n_non_par = int(n_par * rng.uniform(0.02, 0.12))
        rows.append({
            "specialty": spec,
            "exposure_par_Y":     round(exp_Y, 2),
            "exposure_par_N":     round(exp_N, 2),
            "n_providers_Y":      n_par,
            "n_providers_N":      n_non_par,
            "total_mdcr_pymt_Y":  round(rng.uniform(1e8, 5e9), 2),
            "total_mdcr_pymt_N":  round(rng.uniform(1e7, 5e8), 2),
            "non_par_premium_pct": round(spec_premium, 4),
        })
    return pd.DataFrame(rows)


def hero_jcode_concentration(n: int = 2000, seed: int = 42) -> pd.DataFrame:
    """Lorenz-curve-shaped distribution: a few providers dominate drug revenue."""
    rng = np.random.default_rng(seed)
    # Pareto-distributed drug payment per provider → realistic concentration.
    drug_pymt = np.sort(rng.pareto(1.4, n) * 5_000)
    total_pymt = drug_pymt * rng.uniform(1.1, 8.0, n)
    drug_share = (drug_pymt / total_pymt).clip(0, 1)

    df = pd.DataFrame({
        "npi": [f"{2000000000 + i}" for i in range(n)],
        "specialty":    rng.choice(SPECIALTIES, n),
        "state_abrvtn": rng.choice(STATES, n),
        "drug_mdcr_pymt":  drug_pymt.round(2),
        "drug_services":   rng.integers(20, 5000, n),
        "total_mdcr_pymt": total_pymt.round(2),
        "drug_share":      drug_share.round(6),
        "is_drug_dependent": drug_share > 0.60,
    })
    df = df.sort_values("drug_mdcr_pymt").reset_index(drop=True)
    df["cum_share_providers"] = (np.arange(1, n + 1) / n).round(6)
    df["cum_share_drug"]      = (df["drug_mdcr_pymt"].cumsum() / df["drug_mdcr_pymt"].sum()).round(6)
    return df


def hero_credentials_markup(seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    shared_e_and_m = ["99213", "99214", "99203", "99204", "99215"]
    rows = []
    for hcpcs in [c[0] for c in HCPCS_SAMPLE]:
        # MDs/DOs submit higher chargemasters than NPs/PAs for the same code.
        md_markup  = rng.uniform(3.0, 6.0)
        np_markup  = md_markup * rng.uniform(0.35, 0.55)
        pa_markup  = md_markup * rng.uniform(0.40, 0.60)
        spc_markup = md_markup * rng.uniform(0.70, 0.95)
        pymt = rng.uniform(20, 250)
        svcs = rng.integers(5_000, 1_500_000)
        desc = next((d for c, d, _ in HCPCS_SAMPLE if c == hcpcs), "")
        rows.append({
            "hcpcs_cd": hcpcs,
            "hcpcs_desc": desc,
            "is_shared_e_and_m": hcpcs in shared_e_and_m,
            "Physician (MD/DO)_markup": round(md_markup, 4),
            "Physician (MD/DO)_pymt":   round(pymt, 2),
            "Physician (MD/DO)_svcs":   int(svcs),
            "Nurse Practitioner_markup": round(np_markup, 4),
            "Nurse Practitioner_pymt":   round(pymt, 2),
            "Nurse Practitioner_svcs":   int(svcs * rng.uniform(0.05, 0.25)),
            "Physician Assistant_markup": round(pa_markup, 4),
            "Physician Assistant_pymt":   round(pymt, 2),
            "Physician Assistant_svcs":   int(svcs * rng.uniform(0.04, 0.18)),
            "Specialist_markup": round(spc_markup, 4),
            "Specialist_pymt":   round(pymt, 2),
            "Specialist_svcs":   int(svcs * rng.uniform(0.02, 0.10)),
        })
    return pd.DataFrame(rows)


def hero_site_neutral(seed: int = 42) -> pd.DataFrame:
    """Same HCPCS, F (facility) typically pays more than O (office)."""
    rng = np.random.default_rng(seed)
    rows = []
    for hcpcs, desc, drug in HCPCS_SAMPLE:
        if drug == "Y":
            continue   # drugs aren't site-of-service comparisons
        o_pymt = rng.uniform(80, 600)
        f_pymt = o_pymt * rng.uniform(1.1, 2.8)
        f_svcs = rng.integers(20_000, 800_000)
        o_svcs = rng.integers(40_000, 1_500_000)
        rows.append({
            "hcpcs_cd": hcpcs,
            "hcpcs_desc": desc,
            "is_drug": False,
            "F_pymt": round(f_pymt, 2),
            "F_svcs": int(f_svcs),
            "F_total": round(f_pymt * f_svcs, 2),
            "O_pymt": round(o_pymt, 2),
            "O_svcs": int(o_svcs),
            "O_total": round(o_pymt * o_svcs, 2),
            "site_ratio": round(f_pymt / o_pymt, 4),
            "site_neutral_savings": round((f_pymt - o_pymt) * f_svcs, 2),
        })
    return pd.DataFrame(rows).sort_values("site_ratio", ascending=False).reset_index(drop=True)
