"""Package init — and the local-mode bootstrap.

Every notebook's first code cell does ``from utils.X import ...`` *before* it calls
``SparkSession.builder.getOrCreate()``, which makes this module the earliest
reliable hook for the two things that must happen before the JVM starts:

1. **``dbutils``** — a bare global that only exists inside the Databricks runtime.
   Installing a shim here means the notebooks need no edits at all.
2. **``PYSPARK_SUBMIT_ARGS``** — the Delta jars and, critically, the driver heap.
   ``spark-submit`` reads this only at JVM launch; ``spark.conf.set()`` afterwards
   is silently ignored for these settings.

Both are no-ops on Databricks: the real ``dbutils`` is detected and left alone, and
``PYSPARK_SUBMIT_ARGS`` is only set when ``LAKEHOUSE_LOCAL_ROOT`` is present.

Putting this here rather than in the runner is deliberate — it also fires when a
notebook is opened directly in Jupyter or VS Code, which otherwise fails with a
baffling ``Failed to find data source: delta``.
"""

import builtins
import os

from .paths import LOCAL_MODE, _LOCAL_ROOT


# ── 1. dbutils shim ─────────────────────────────────────────────────────────
class _WidgetShim:
    """Minimal stand-in for dbutils.widgets, backed by environment variables.

    A widget named ``sample_mode`` reads from ``$SAMPLE_MODE``, falling back to the
    default declared in the notebook — so the notebooks' own defaults stay in force.
    """

    def __init__(self):
        self._defaults: dict[str, str] = {}

    def dropdown(self, name, defaultValue, choices, label=None):
        self._defaults[name] = defaultValue

    def text(self, name, defaultValue, label=None):
        self._defaults[name] = defaultValue

    def get(self, name):
        return os.getenv(name.upper(), self._defaults.get(name, ""))

    def remove(self, name):
        self._defaults.pop(name, None)

    def removeAll(self):
        self._defaults.clear()


class _SecretsShim:
    """Refuses to serve secrets. There is no Key Vault outside Databricks.

    This raises rather than returning a placeholder on purpose: if local mode is
    somehow off, the correct outcome is a loud failure, not a silently broken
    OAuth configuration that fails later with an opaque storage error.
    """

    def get(self, scope, key):
        raise RuntimeError(
            f"dbutils.secrets.get(scope={scope!r}, key={key!r}) is unavailable outside "
            "Databricks. Set LAKEHOUSE_LOCAL_ROOT to run against the local lakehouse "
            "(see pipeline/download.sh), or run this notebook on a Databricks cluster."
        )

    def listScopes(self):
        return []


class _DBUtilsShim:
    def __init__(self):
        self.widgets = _WidgetShim()
        self.secrets = _SecretsShim()


def _install_dbutils_shim() -> None:
    """Expose `dbutils` as a global, but never shadow the real Databricks one."""
    if getattr(builtins, "dbutils", None) is not None:
        return
    try:
        # Databricks injects dbutils into the user namespace, not builtins.
        from IPython import get_ipython  # type: ignore[import-not-found]

        ip = get_ipython()
        if ip is not None and "dbutils" in ip.user_ns:
            return
    except Exception:
        pass
    builtins.dbutils = _DBUtilsShim()  # type: ignore[attr-defined]


# ── 2. Spark submit args (local only) ───────────────────────────────────────
# In local[*] the driver IS the executor: spark.executor.memory is ignored and the
# default heap is 1 GB, which cannot hold notebook 04's cache of 9.66M x 30 columns.
# 9g on a 16 GiB machine leaves room for macOS, the Python side, and Ivy.
DRIVER_MEMORY = "9g"
LOCAL_CORES = 8  # not local[*]; leaves headroom so the laptop stays usable
SHUFFLE_PARTITIONS = 32  # default 200 means 200 tiny tasks per shuffle


def _delta_maven_coordinate() -> str:
    """Derive the jar coordinate from the installed delta-spark, so they can't drift."""
    from importlib.metadata import version

    return f"io.delta:delta-spark_2.12:{version('delta-spark')}"


def _configure_spark_submit_args() -> None:
    if os.environ.get("PYSPARK_SUBMIT_ARGS"):
        return  # caller knows better; don't override

    spark_tmp = os.path.join(_LOCAL_ROOT, "_spark_tmp")
    os.makedirs(spark_tmp, exist_ok=True)

    args = [
        f"--master local[{LOCAL_CORES}]",
        f"--driver-memory {DRIVER_MEMORY}",
        f"--packages {_delta_maven_coordinate()}",
        "--conf spark.sql.extensions=io.delta.sql.DeltaSparkSessionExtension",
        "--conf spark.sql.catalog.spark_catalog=org.apache.spark.sql.delta.catalog.DeltaCatalog",
        f"--conf spark.sql.shuffle.partitions={SHUFFLE_PARTITIONS}",
        "--conf spark.driver.maxResultSize=2g",
        f"--conf spark.local.dir={spark_tmp}",
        "pyspark-shell",  # required sentinel: pyspark appends this arg list to spark-submit
    ]
    os.environ["PYSPARK_SUBMIT_ARGS"] = " ".join(args)


_install_dbutils_shim()
if LOCAL_MODE:
    _configure_spark_submit_args()
