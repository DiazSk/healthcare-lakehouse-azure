# Power BI dimensional model

Import-mode star schema over the Gold layer. Run `python pipeline/export_powerbi.py`
first — it writes `powerbi/data/*.parquet` (gitignored; ~1.5 GB, regenerate locally).

## Tables to load

| Table | Rows | Role | Load? |
|---|---|---|---|
| `dim_provider` | 1,175,213 | Dimension — grain `npi` | Yes |
| `dim_hcpcs` | 6,405 | Dimension — grain `hcpcs_cd` | Yes |
| `dim_geography` | 61 | Dimension — grain `state_abrvtn` | Yes |
| `fact_provider_service` | 9,660,252 | Fact — grain `npi × hcpcs_cd × place_of_srvc` | Optional |
| `gold_hero_geo_arbitrage` | 211 | Pre-aggregated mart | Yes |
| `gold_hero_non_par_premium` | 104 | Pre-aggregated mart | Yes |
| `gold_hero_jcode_concentration` | 221,364 | Pre-aggregated mart | Yes |
| `gold_hero_credentials_markup` | 4,544 | Pre-aggregated mart | Yes |
| `gold_hero_site_neutral` | 972 | Pre-aggregated mart | Yes |

**On the fact table.** The five hero marts are already aggregated to exactly what
their pages need, so every hero visual works without the fact table at all. Load it
only for free-form drill-down. It is 1.47 GB as Parquet and takes several minutes to
import; VertiPaq compresses it hard once loaded, but the import is the slow part.
Build and validate the hero pages first, then add it if you actually want drill-down.

## Relationships

All single-direction, many-to-one from fact to dimension. Set them up in
Model view by dragging the fact column onto the dimension key.

| From (many) | To (one) | Cardinality | Cross-filter | Active |
|---|---|---|---|---|
| `fact_provider_service[npi]` | `dim_provider[npi]` | Many-to-one | Single | Yes |
| `fact_provider_service[hcpcs_cd]` | `dim_hcpcs[hcpcs_cd]` | Many-to-one | Single | Yes |
| `fact_provider_service[state_abrvtn]` | `dim_geography[state_abrvtn]` | Many-to-one | Single | Yes |
| `gold_hero_jcode_concentration[npi]` | `dim_provider[npi]` | Many-to-one | Single | Yes |
| `gold_hero_geo_arbitrage[state_abrvtn]` | `dim_geography[state_abrvtn]` | Many-to-one | Single | Yes |
| `gold_hero_credentials_markup[hcpcs_cd]` | `dim_hcpcs[hcpcs_cd]` | Many-to-one | Single | Yes |
| `gold_hero_site_neutral[hcpcs_cd]` | `dim_hcpcs[hcpcs_cd]` | Many-to-one | Single | Yes |

`gold_hero_non_par_premium` is grained on `specialty`, which is an attribute of
`dim_provider` rather than a key, so it stays **disconnected**. Filter its visuals
with its own `specialty` column. Do not build a relationship to `dim_provider[specialty]`
— it is non-unique there and Power BI will refuse it.

### Why single-direction, not bidirectional

The README originally called for bidirectional filtering so one state slicer would
cascade across every page. Don't. With three dimensions joined to one fact,
bidirectional cross-filtering creates ambiguous filter paths (dim_geography → fact →
dim_provider), which Power BI resolves unpredictably and which makes measures
depend on visual layout. Use single-direction relationships and put the slicers on
`dim_geography[state_abrvtn]` and `dim_hcpcs[hcpcs_cd]` — dimension slicers already
propagate to the fact, which is the cascade you actually wanted.

Sync slicers across pages with **View → Sync slicers** instead.

## Column configuration

Set these in Column tools after import, or the visuals will misbehave:

| Column | Setting |
|---|---|
| `dim_provider[npi]`, `fact_provider_service[npi]` | Data type **Text**, Summarization **Don't summarize** |
| `dim_provider[zip5]`, `dim_geography[state_fips]` | Data type **Text** (leading zeros) |
| `dim_hcpcs[hcpcs_cd]`, all mart `hcpcs_cd` | Data type **Text**, Summarization **Don't summarize** |
| `dim_geography[state_abrvtn]` | Data category **State or Province** (enables map visuals) |
| All `Tot_*`, `Avg_*`, `total_*` money columns | Format **Currency**, 0 decimals for totals |
| All `*_markup`, `*_ratio`, `Markup_Ratio` | Format **Decimal**, 2 decimals |
| `Mdcr_Pymt_Rate`, `drug_share`, `non_par_premium_pct` | Format **Percentage**, 1 decimal |
| Every `is_*` column | Data type **True/False** |

Hide from report view (keys and helper columns nobody should drag onto a visual):
`fact_provider_service[service_sk]`, every `ruca_int`, and the `*_svcs` / `*_pymt`
columns in `gold_hero_credentials_markup` once the measures below are in place.

## No date dimension

The dataset is a single annual snapshot (calendar year 2023) with no date column, so
there is deliberately no date table and no time intelligence. Don't let Power BI's
auto date/time create one: **File → Options → Data Load → uncheck "Auto date/time
for new files"** before importing, or you will get 30 hidden date tables.

If you later load multiple CMS years, add a `source_year` column in Silver
(`01_bronze_to_silver` already sets `Source_Year`) and build a one-column year table.
