"""ADLS Gen2 OAuth wiring — config is read from environment variables.

Resolution order, in priority:
  1. `os.environ` — already-set process or Databricks cluster env vars.
  2. `.env` file at the repo root, loaded via python-dotenv (if installed).

The actual SP `client_secret` value is NEVER read from env — it is fetched at
runtime from the Databricks Key-Vault-backed secret scope. Env vars only carry
non-secret IDs (tenant_id, client_id, storage account name, scope name).

On Databricks clusters where `python-dotenv` is not installed, the import is
softly skipped and the helper falls back to whatever `os.environ` provides —
the recommended Databricks pattern is to set these vars under Compute → Cluster
→ Edit → Advanced → Environment variables, so dotenv is not needed in production.
"""

from __future__ import annotations

import os
from pathlib import Path

from pyspark.sql import SparkSession

# ── Soft import of python-dotenv ────────────────────────────────────────────
# If dotenv is unavailable (e.g., on a stock Databricks runtime where it
# wasn't pip-installed), we silently skip it and rely on real env vars.
try:
    from dotenv import load_dotenv

    _DOTENV_AVAILABLE = True
except ImportError:
    _DOTENV_AVAILABLE = False

    def load_dotenv(*_args, **_kwargs) -> bool:
        return False


def _load_env_file() -> None:
    """Best-effort load of a `.env` at the repo root. Idempotent and silent on miss."""
    if not _DOTENV_AVAILABLE:
        return
    # __file__ → notebooks/utils/secrets.py; repo root is 2 parents up.
    repo_root = Path(__file__).resolve().parents[2]
    env_path = repo_root / ".env"
    if env_path.is_file():
        load_dotenv(env_path, override=False)


def _require(var_name: str) -> str:
    """Read an env var, fail loudly if unset — never return None or empty."""
    value = os.getenv(var_name)
    if not value:
        raise RuntimeError(
            f"Missing required environment variable: {var_name}. "
            f"Either copy .env.example to .env (local), or set it as a "
            f"Databricks cluster environment variable (production)."
        )
    return value


def configure_adls_oauth(spark: SparkSession, dbutils) -> None:
    """Wire ADLS Gen2 OAuth on the current Spark session.

    `dbutils` is the Databricks runtime singleton — passed in so this helper
    stays unit-testable outside Databricks (mock dbutils).
    """
    _load_env_file()

    storage_account = _require("AZURE_STORAGE_ACCOUNT")
    tenant_id       = _require("AZURE_TENANT_ID")
    client_id       = _require("AZURE_CLIENT_ID")
    scope           = _require("AZURE_KEYVAULT_SCOPE")
    secret_key      = os.getenv("AZURE_KEYVAULT_SECRET_KEY", "sp-databricks-client-secret")

    # Actual secret stays in Azure Key Vault — fetched here via Databricks scope.
    client_secret = dbutils.secrets.get(scope=scope, key=secret_key)

    host = f"{storage_account}.dfs.core.windows.net"
    spark.conf.set(f"fs.azure.account.auth.type.{host}", "OAuth")
    spark.conf.set(
        f"fs.azure.account.oauth.provider.type.{host}",
        "org.apache.hadoop.fs.azurebfs.oauth2.ClientCredsTokenProvider",
    )
    spark.conf.set(f"fs.azure.account.oauth2.client.id.{host}",     client_id)
    spark.conf.set(f"fs.azure.account.oauth2.client.secret.{host}", client_secret)
    spark.conf.set(
        f"fs.azure.account.oauth2.client.endpoint.{host}",
        f"https://login.microsoftonline.com/{tenant_id}/oauth2/token",
    )
