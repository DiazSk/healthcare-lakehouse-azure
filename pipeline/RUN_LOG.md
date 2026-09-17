# Local run log

Appended by `pipeline/run_local.py` on every run. This is the reproducibility evidence
for the local rebuild: real row counts, per-notebook wall-clock, and the 13 data-quality
assertions, captured from stdout.

The notebooks' own stored outputs (still in the `.ipynb` files) are from the original
**Azure Databricks** execution — `Bronze row count: 9,665,647`, `Fact rows: 9,665,252`,
drift `$0.0025`. Compare them against the full run below: the absolute counts differ by
5,000 because CMS republished the 2023 file, but the `Cntry = 'US'` filter delta is
**395 in both**, which is what shows the transformations are unchanged.

# Local run — 2026-09-16 23:46:46 (sample_mode=True)

```
LAKEHOUSE_LOCAL_ROOT=<repo>/data

========================================================================
>>> 01_bronze_to_silver.ipynb
========================================================================
Local mode — skipping ADLS OAuth (reading from LAKEHOUSE_LOCAL_ROOT).
sample_mode = True
Bronze row count: 1,000
Silver written → <repo>/data/silver/physician_by_provider_service/
Local mode — skipping OPTIMIZE ZORDER BY (HCPCS_Cd, Rndrng_Prvdr_Type) on <repo>/data/silver/physician_by_provider_service/
<<< 01_bronze_to_silver.ipynb completed in 11.3s

TOTAL: 11.3s
```


# Local run — 2026-09-16 23:47:07 (sample_mode=True)

```
LAKEHOUSE_LOCAL_ROOT=<repo>/data

========================================================================
>>> 01_bronze_to_silver.ipynb
========================================================================
Local mode — skipping ADLS OAuth (reading from LAKEHOUSE_LOCAL_ROOT).
sample_mode = True
Bronze row count: 1,000
Silver written → <repo>/data/silver/physician_by_provider_service/
Local mode — skipping OPTIMIZE ZORDER BY (HCPCS_Cd, Rndrng_Prvdr_Type) on <repo>/data/silver/physician_by_provider_service/
<<< 01_bronze_to_silver.ipynb completed in 10.2s

========================================================================
>>> 02_silver_to_gold_dims.ipynb
========================================================================
Local mode — skipping ADLS OAuth (reading from LAKEHOUSE_LOCAL_ROOT).
Local mode — skipping OPTIMIZE ZORDER BY (npi) on <repo>/data/gold/dim_provider/
dim_provider written → <repo>/data/gold/dim_provider/
Local mode — skipping OPTIMIZE ZORDER BY (hcpcs_cd) on <repo>/data/gold/dim_hcpcs/
dim_hcpcs written → <repo>/data/gold/dim_hcpcs/
dim_geography written → <repo>/data/gold/dim_geography/
<<< 02_silver_to_gold_dims.ipynb completed in 3.6s

========================================================================
>>> 03_silver_to_gold_fact.ipynb
========================================================================
Local mode — skipping ADLS OAuth (reading from LAKEHOUSE_LOCAL_ROOT).
fact_provider_service written → <repo>/data/gold/fact_provider_service/
Local mode — skipping OPTIMIZE ZORDER BY (hcpcs_cd, specialty) on <repo>/data/gold/fact_provider_service/
<<< 03_silver_to_gold_fact.ipynb completed in 1.3s

========================================================================
>>> 04_gold_hero_marts.ipynb
========================================================================
Local mode — skipping ADLS OAuth (reading from LAKEHOUSE_LOCAL_ROOT).
Local mode — skipping OPTIMIZE ZORDER BY (ruca_bucket) on <repo>/data/gold/gold_hero_geo_arbitrage/
gold_hero_geo_arbitrage written → <repo>/data/gold/gold_hero_geo_arbitrage/
gold_hero_non_par_premium written → <repo>/data/gold/gold_hero_non_par_premium/
gold_hero_jcode_concentration written → <repo>/data/gold/gold_hero_jcode_concentration/
Local mode — skipping OPTIMIZE ZORDER BY (hcpcs_cd) on <repo>/data/gold/gold_hero_credentials_markup/
gold_hero_credentials_markup written → <repo>/data/gold/gold_hero_credentials_markup/
Local mode — skipping OPTIMIZE ZORDER BY (site_ratio) on <repo>/data/gold/gold_hero_site_neutral/
gold_hero_site_neutral written → <repo>/data/gold/gold_hero_site_neutral/
All 5 hero marts complete.
<<< 04_gold_hero_marts.ipynb completed in 6.6s

========================================================================
>>> 99_dq_checks.ipynb
========================================================================
Local mode — skipping ADLS OAuth (reading from LAKEHOUSE_LOCAL_ROOT).
  PASS  npi_not_null
  PASS  hcpcs_not_null
  PASS  pos_in_domain
  PASS  ent_in_domain
  PASS  benes_min_11
  PASS  ratios_nonneg
  PASS  provider_tier_set
  PASS  fact_row_count_band
  PASS  dim_provider_unique
  PASS  dim_hcpcs_unique
  PASS  dim_geo_unique
  PASS  dim_geo_reasonable
  PASS  decimal_drift_relative

All DQ checks passed. Fact rows: 1,000. Decimal drift across full Silver: $0.0011 (1.19e-10 relative)
<<< 99_dq_checks.ipynb completed in 2.5s

TOTAL: 24.3s
```


# Local run — 2026-09-16 23:48:46 (sample_mode=False)

```
LAKEHOUSE_LOCAL_ROOT=<repo>/data

========================================================================
>>> 01_bronze_to_silver.ipynb
========================================================================
Local mode — skipping ADLS OAuth (reading from LAKEHOUSE_LOCAL_ROOT).
sample_mode = False
Bronze row count: 9,660,647
Silver written → <repo>/data/silver/physician_by_provider_service/
Local mode — skipping OPTIMIZE ZORDER BY (HCPCS_Cd, Rndrng_Prvdr_Type) on <repo>/data/silver/physician_by_provider_service/
<<< 01_bronze_to_silver.ipynb completed in 64.6s

========================================================================
>>> 02_silver_to_gold_dims.ipynb
========================================================================
Local mode — skipping ADLS OAuth (reading from LAKEHOUSE_LOCAL_ROOT).
Local mode — skipping OPTIMIZE ZORDER BY (npi) on <repo>/data/gold/dim_provider/
dim_provider written → <repo>/data/gold/dim_provider/
Local mode — skipping OPTIMIZE ZORDER BY (hcpcs_cd) on <repo>/data/gold/dim_hcpcs/
dim_hcpcs written → <repo>/data/gold/dim_hcpcs/
dim_geography written → <repo>/data/gold/dim_geography/
<<< 02_silver_to_gold_dims.ipynb completed in 79.0s

========================================================================
>>> 03_silver_to_gold_fact.ipynb
========================================================================
Local mode — skipping ADLS OAuth (reading from LAKEHOUSE_LOCAL_ROOT).
fact_provider_service written → <repo>/data/gold/fact_provider_service/
Local mode — skipping OPTIMIZE ZORDER BY (hcpcs_cd, specialty) on <repo>/data/gold/fact_provider_service/
<<< 03_silver_to_gold_fact.ipynb completed in 37.5s

========================================================================
>>> 04_gold_hero_marts.ipynb
========================================================================
Local mode — skipping ADLS OAuth (reading from LAKEHOUSE_LOCAL_ROOT).
Local mode — skipping OPTIMIZE ZORDER BY (ruca_bucket) on <repo>/data/gold/gold_hero_geo_arbitrage/
gold_hero_geo_arbitrage written → <repo>/data/gold/gold_hero_geo_arbitrage/
gold_hero_non_par_premium written → <repo>/data/gold/gold_hero_non_par_premium/
gold_hero_jcode_concentration written → <repo>/data/gold/gold_hero_jcode_concentration/
Local mode — skipping OPTIMIZE ZORDER BY (hcpcs_cd) on <repo>/data/gold/gold_hero_credentials_markup/
gold_hero_credentials_markup written → <repo>/data/gold/gold_hero_credentials_markup/
Local mode — skipping OPTIMIZE ZORDER BY (site_ratio) on <repo>/data/gold/gold_hero_site_neutral/
gold_hero_site_neutral written → <repo>/data/gold/gold_hero_site_neutral/
All 5 hero marts complete.
<<< 04_gold_hero_marts.ipynb completed in 42.5s

========================================================================
>>> 99_dq_checks.ipynb
========================================================================
Local mode — skipping ADLS OAuth (reading from LAKEHOUSE_LOCAL_ROOT).
  PASS  npi_not_null
  PASS  hcpcs_not_null
  PASS  pos_in_domain
  PASS  ent_in_domain
  PASS  benes_min_11
  PASS  ratios_nonneg
  PASS  provider_tier_set
  PASS  fact_row_count_band
  PASS  dim_provider_unique
  PASS  dim_hcpcs_unique
  PASS  dim_geo_unique
  PASS  dim_geo_reasonable
  PASS  decimal_drift_relative

All DQ checks passed. Fact rows: 9,660,252. Decimal drift across full Silver: $0.8470 (9.04e-12 relative)
<<< 99_dq_checks.ipynb completed in 7.3s

TOTAL: 230.9s
```
