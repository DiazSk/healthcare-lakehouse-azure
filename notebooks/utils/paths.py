"""Canonical lakehouse paths for the medallion containers.

Two modes, one code path:

* **Azure (default)** — `abfss://` URIs into the ADLS Gen2 containers, exactly as
  the pipeline ran on Databricks.
* **Local** — set ``LAKEHOUSE_LOCAL_ROOT`` to a directory and every path below
  resolves under ``{root}/{container}/`` instead, so the same notebooks run on a
  laptop against the public CMS download. The Azure subscription is retired; this
  is what keeps the pipeline reproducible.

Bronze differs by more than its prefix: on Azure it was JSON (written by the ADF
ingest), locally it is the raw CMS CSV. So the glob, the reader format, and the
reader options all switch together — a prefix-only flip would glob `*.json`
against a directory of CSV and fail with "Path does not exist".
"""

import os

STORAGE_ACCOUNT = "sthealthcareplatdev"

# Resolved once at import. Every notebook imports this package before it builds a
# SparkSession, so the runner has already set the environment by this point.
_LOCAL_ROOT = (os.getenv("LAKEHOUSE_LOCAL_ROOT") or "").rstrip("/")
LOCAL_MODE = bool(_LOCAL_ROOT)


def abfss(container: str, suffix: str) -> str:
    if LOCAL_MODE:
        return f"{_LOCAL_ROOT}/{container}/{suffix}"
    return f"abfss://{container}@{STORAGE_ACCOUNT}.dfs.core.windows.net/{suffix}"


if LOCAL_MODE:
    BRONZE_PHYSICIAN_GLOB = abfss("bronze", "*.csv")
    BRONZE_FORMAT = "csv"
    BRONZE_OPTIONS = {
        "header": "true",
        # RFC4180 doubles quotes to escape them; Spark's default escape is a
        # backslash, which would mangle any quoted field containing one.
        "escape": '"',
        # Default (true) maps the 28 columns BY POSITION and never checks the
        # header. False makes Spark validate names against CMS_RAW_SCHEMA and fail
        # loudly if CMS ever reorders the file.
        "enforceSchema": "false",
        # Deliberately NOT multiLine: it makes the 3 GB file non-splittable (one
        # core for the whole pipeline). Verified against the real file that no
        # field contains a newline, so quoting alone is sufficient.
    }
else:
    BRONZE_PHYSICIAN_GLOB = abfss("bronze", "*.json")
    BRONZE_FORMAT = "json"
    BRONZE_OPTIONS = {"multiLine": "true"}

SILVER_PHYSICIAN = abfss("silver", "physician_by_provider_service/")


def GOLD(name: str) -> str:
    return abfss("gold", f"{name}/")
