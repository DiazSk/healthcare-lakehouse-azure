"""Delta table maintenance, gated for local runs."""

from .paths import LOCAL_MODE


def optimize_zorder(spark, path: str, *columns: str) -> None:
    """Run ``OPTIMIZE ... ZORDER BY`` on a Delta path. Skipped in local mode.

    Z-ordering is genuinely available in OSS Delta (open-sourced in 2.0, and this
    project pins delta-spark 3.3.3 with both the SQL extension and the Delta
    catalog configured), so this is not a capability gap.

    It is skipped locally because it changes file *layout* only, never data, and a
    laptop run has no Power BI Import refresh or concurrent reader to benefit from
    the clustering. Skipping it cuts roughly 25 minutes off a full run and halves
    peak disk — OPTIMIZE leaves the pre-optimize files in place until VACUUM, so
    every optimized table would otherwise occupy about twice its size.
    """
    cols = ", ".join(columns)
    if LOCAL_MODE:
        print(f"Local mode — skipping OPTIMIZE ZORDER BY ({cols}) on {path}")
        return
    spark.sql(f"OPTIMIZE delta.`{path}` ZORDER BY ({cols})")
    print(f"OPTIMIZE ZORDER BY ({cols}) complete → {path}")
