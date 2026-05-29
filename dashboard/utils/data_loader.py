"""Load Gold Delta tables from ADLS Gen2 into pandas DataFrames.

Uses the `deltalake` Python library so the marimo dashboard does NOT require a
running Databricks SQL warehouse (saves DBUs). Auth is via Azure SP credentials
read from environment variables, populated by python-dotenv from a gitignored
`.env` file at the repo root.

Each loader caches its result in module-global state so a hot-reload of a
marimo cell doesn't re-fetch from ADLS. Set ``DATA_LOADER_FORCE_REFRESH=1``
in the environment to bypass the cache.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

# Soft-import dotenv: optional locally, never assumed in production.
try:
    from dotenv import load_dotenv  # type: ignore[import-not-found]
    _DOTENV = True
except ImportError:
    _DOTENV = False
    def load_dotenv(*_a, **_kw): return False  # no-op fallback


# Soft-import deltalake: dashboard demo file should still work even if not installed.
try:
    from deltalake import DeltaTable  # type: ignore[import-not-found]
    _DELTALAKE = True
except ImportError:
    _DELTALAKE = False
    DeltaTable = None  # type: ignore[assignment]


_CACHE: dict[str, pd.DataFrame] = {}


def _load_env() -> None:
    """Best-effort load of `.env` at the repo root. Silent on miss."""
    if not _DOTENV:
        return
    # __file__ → dashboard/utils/data_loader.py; repo root is 2 parents up.
    repo_root = Path(__file__).resolve().parents[2]
    env_path = repo_root / ".env"
    if env_path.is_file():
        load_dotenv(env_path, override=False)


def _storage_options() -> dict[str, str]:
    """Build the deltalake `storage_options` dict from env vars."""
    _load_env()
    required = [
        "AZURE_STORAGE_ACCOUNT",
        "AZURE_TENANT_ID",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
    ]
    missing = [k for k in required if not os.getenv(k)]
    if missing:
        raise RuntimeError(
            f"Missing env vars for ADLS auth: {missing}. "
            f"Copy .env.example to .env and fill in the rotated SP client secret."
        )
    return {
        "azure_storage_account_name": os.environ["AZURE_STORAGE_ACCOUNT"],
        "azure_tenant_id":            os.environ["AZURE_TENANT_ID"],
        "azure_client_id":            os.environ["AZURE_CLIENT_ID"],
        "azure_client_secret":        os.environ["AZURE_CLIENT_SECRET"],
    }


def _gold_uri(table_name: str) -> str:
    """ABFSS URI for a Gold table in the configured storage account."""
    account = os.getenv("AZURE_STORAGE_ACCOUNT", "sthealthcareplatdev")
    return f"abfss://gold@{account}.dfs.core.windows.net/{table_name}/"


def _load_table(table_name: str, empty_columns: Optional[list[str]] = None) -> pd.DataFrame:
    """Load one Gold Delta table; return empty DF (with optional schema) on any failure."""
    force = os.getenv("DATA_LOADER_FORCE_REFRESH") == "1"
    if not force and table_name in _CACHE:
        return _CACHE[table_name]

    if not _DELTALAKE:
        logger.warning("deltalake not installed; returning empty DataFrame for %s", table_name)
        return pd.DataFrame(columns=empty_columns or [])

    try:
        opts = _storage_options()
        dt = DeltaTable(_gold_uri(table_name), storage_options=opts)
        df = dt.to_pandas()
        _CACHE[table_name] = df
        return df
    except Exception as exc:  # noqa: BLE001 — we want to fail gracefully in the UI
        logger.warning(
            "Failed to load Gold table %s: %s. "
            "Run the PySpark notebooks first or check .env auth.",
            table_name, exc,
        )
        return pd.DataFrame(columns=empty_columns or [])


# ── Public loaders, one per Gold table ──────────────────────────────────────

def load_dim_provider() -> pd.DataFrame:
    return _load_table("dim_provider", empty_columns=[
        "npi", "display_name", "credentials_raw", "provider_tier", "specialty",
        "state_abrvtn", "city", "ruca_bucket", "is_rural", "is_participating",
        "total_mdcr_pymt", "total_services", "n_distinct_hcpcs",
    ])


def load_dim_hcpcs() -> pd.DataFrame:
    return _load_table("dim_hcpcs", empty_columns=[
        "hcpcs_cd", "hcpcs_desc", "is_drug", "hcpcs_family",
        "national_services", "national_mdcr_pymt", "n_providers",
    ])


def load_dim_geography() -> pd.DataFrame:
    return _load_table("dim_geography", empty_columns=[
        "state_abrvtn", "state_fips", "n_providers", "total_benes_proxy",
        "total_mdcr_pymt", "rural_share_of_rows", "avg_geo_adj_factor",
    ])


def load_fact_provider_service() -> pd.DataFrame:
    return _load_table("fact_provider_service")


def load_hero_geo_arbitrage() -> pd.DataFrame:
    return _load_table("gold_hero_geo_arbitrage", empty_columns=[
        "state_abrvtn", "ruca_bucket", "total_geo_premium", "total_pymt",
        "total_stdzd", "total_benes_proxy", "total_services",
        "avg_geo_adj_factor", "geo_premium_per_bene",
    ])


def load_hero_non_par_premium() -> pd.DataFrame:
    return _load_table("gold_hero_non_par_premium", empty_columns=[
        "specialty", "exposure_par_Y", "exposure_par_N",
        "n_providers_Y", "n_providers_N",
        "total_mdcr_pymt_Y", "total_mdcr_pymt_N", "non_par_premium_pct",
    ])


def load_hero_jcode_concentration() -> pd.DataFrame:
    return _load_table("gold_hero_jcode_concentration", empty_columns=[
        "npi", "specialty", "state_abrvtn", "drug_mdcr_pymt", "drug_services",
        "total_mdcr_pymt", "drug_share", "is_drug_dependent",
        "cum_share_providers", "cum_share_drug",
    ])


def load_hero_credentials_markup() -> pd.DataFrame:
    return _load_table("gold_hero_credentials_markup")


def load_hero_site_neutral() -> pd.DataFrame:
    return _load_table("gold_hero_site_neutral", empty_columns=[
        "hcpcs_cd", "hcpcs_desc", "is_drug",
        "F_pymt", "F_svcs", "F_total",
        "O_pymt", "O_svcs", "O_total",
        "site_ratio", "site_neutral_savings",
    ])
