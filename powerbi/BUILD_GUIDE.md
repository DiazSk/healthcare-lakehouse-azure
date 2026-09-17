# Building the .pbix

Power BI Desktop is **Windows-only**. On a Mac you need Parallels, a Windows VM,
Boot Camp on Intel hardware, a cloud Windows box, or a lab PC. There is no macOS
build, and Power BI Service (the browser app) cannot author a model from local
files — it only hosts what Desktop publishes.

Everything Desktop needs is already generated, so this is mechanical work, not
design work: the model is specified in [MODEL.md](MODEL.md) and every measure in
[MEASURES.md](MEASURES.md), with expected values to check against.

## Before you start

On the machine with the data:

```bash
python pipeline/run_local.py          # if data/gold/ isn't populated
python pipeline/export_powerbi.py     # writes powerbi/data/*.parquet
```

`powerbi/data/` is gitignored (~1.5 GB), so copy it to the Windows machine or run
both commands there. The pipeline needs Java 11 and Python 3.11 — see the repo README.

## Steps

1. **Turn off auto date/time first.** File → Options and settings → Options →
   Data Load → uncheck *Auto date/time for new files*. This dataset is a single
   annual snapshot; leaving it on generates a hidden date table per date-ish column.

2. **Import the eight small tables.** Get Data → Parquet → point at
   `powerbi/data/<name>.parquet`, once per table. Skip
   `fact_provider_service.parquet` on this pass — every hero visual works without
   it, and at 1.47 GB it turns a two-minute import into a long one. Add it later
   if you want free-form drill-down.

3. **Set data types and formats** per the Column configuration table in
   [MODEL.md](MODEL.md). Do this before building visuals — NPI and HCPCS codes
   default to whole numbers, which makes Power BI try to *sum* them.

4. **Create the relationships** in Model view per the Relationships table in
   MODEL.md. Keep every one single-direction; MODEL.md explains why bidirectional
   filtering is the wrong choice here despite what the original README said.

5. **Add the `_Measures` table** and paste in the measures from
   [MEASURES.md](MEASURES.md). Check `Medicare Paid` reads **$93.72B** and
   `Providers` reads **1,175,213** with no filters. If either is off, a
   relationship or a data type is wrong — fix it before going further.

6. **Build the pages** below.

7. **Publish** (optional) to Power BI Service for a shareable link. A free licence
   publishes to *My workspace*; sharing with others needs Pro. Note that the
   published report is not a substitute for the static dashboard in `docs/` —
   Service links require a sign-in, so they are a poor fit for a resume.

## Page layout

Six pages, each following the same structure: a KPI row across the top, the
primary visual dominant on the left, supporting detail right, caveat text at the
bottom. Slicers go in a left rail, synced across pages with View → Sync slicers.

### Page 1 — Overview
- **KPI cards:** `Medicare Paid`, `Providers`, `Procedure Codes`,
  `Non-Participating Share`, `Drug Share of Payments`
- **Map:** filled map on `dim_geography[state_abrvtn]`, colour saturation
  `Geographic Premium`, diverging red–white–blue with the midpoint pinned at 0
- **Bar:** top 15 `dim_hcpcs[hcpcs_cd]` by `Medicare Paid`
- **Slicers:** `dim_geography[state_abrvtn]`, `dim_provider[ruca_bucket]`

### Page 2 — Geographic arbitrage
- **KPI cards:** `Geographic Premium`, `Geographic Premium %`
- **Filled map:** `gold_hero_geo_arbitrage[total_geo_premium]` by state
- **Tornado:** bar of `total_geo_premium` by state, sorted ascending, with
  conditional formatting on the sign — one colour for positive, one for negative
- **Matrix:** rows `state_abrvtn`, columns `ruca_bucket`, values
  `geo_premium_per_bene`

### Page 3 — Participation
- **KPI cards:** `Non-Participating Providers` (1,130), `Non-Participating Share` (0.096%)
- **Bar:** `Non-Par Premium % (reliable only)` by `gold_hero_non_par_premium[specialty]`
  — use the guarded measure, or the chart is dominated by 11-provider artifacts
- **Clustered bar:** `n_providers_Y` vs `n_providers_N` by specialty, **log scale**
  (Format → Y axis → Scale type → Log). The cohorts differ by three orders of
  magnitude, and that disparity is the actual finding.
- **Text box:** the caveat — 31 of 36 comparable specialties run *opposite* to the
  expected direction

### Page 4 — Drug concentration
- **KPI cards:** `Drug Paid`, `Drug Share of Payments`, `Drug-Dependent Providers`,
  `Top 1% Share of Drug Spend`
- **Line:** Lorenz curve — X `gold_hero_jcode_concentration[cum_share_providers]`,
  Y `cum_share_drug`. Set X to *Continuous*, not Categorical, or Power BI plots
  221,364 discrete categories and hangs. Add a constant line from (0,0) to (1,1)
  via the Analytics pane for the equality reference.
- **Bar:** top 25 drug codes by `national_mdcr_pymt` from `dim_hcpcs`
- **Table:** top providers by `drug_mdcr_pymt` with `drug_share`

### Page 5 — Credentials markup
- **KPI cards:** the four `Markup — *` measures, plus `Markup Spread (PA − Physician)`
- **Clustered column:** the four markup measures by
  `gold_hero_credentials_markup[hcpcs_cd]`, filtered to
  `is_shared_e_and_m = TRUE`
- **Table:** the same six codes with `hcpcs_desc` and all four tier markups —
  keep this, the exact numbers are the point
- **Text box:** credentials are parsed from a free-text CMS field, so tier
  assignment is approximate

### Page 6 — Site of service
- **KPI cards:** `Facility Premium`, `Codes Paying More in Facility` (137 of 972),
  `Median Facility-to-Office Ratio` (0.59x)
- **Scatter:** X `O_pymt`, Y `F_pymt`, size `F_svcs`, details `hcpcs_cd`. Add a
  y = x reference line (Analytics → Trend line won't do it; use a calculated
  column or a constant line per axis).
- **Bar:** `site_neutral_savings` by `hcpcs_cd`, both tails, diverging colour
- **Text box:** the professional-fee-only caveat from MEASURES.md. This one is not
  optional — labelling the negative total as "savings" would be wrong.

## Theme

Already saved as [`theme.json`](theme.json) — load it via View → Themes → → Browse for themes. Reproduced here for reference.
These are the same validated tokens the static dashboard uses, so the two surfaces
match.

```json
{
  "name": "Medicare Reimbursement Gap",
  "dataColors": ["#2a78d6", "#eb6834", "#1baf7a", "#eda100",
                 "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  "background": "#fcfcfb",
  "foreground": "#0b0b0b",
  "tableAccent": "#2a78d6",
  "good": "#0ca30c",
  "neutral": "#898781",
  "bad": "#d03b3b",
  "visualStyles": {
    "*": {
      "*": {
        "background": [{ "color": { "solid": { "color": "#fcfcfb" } } }],
        "border": [{ "show": true, "color": { "solid": { "color": "#e1e0d9" } } }],
        "title": [{ "fontColor": { "solid": { "color": "#0b0b0b" } },
                    "fontSize": 13, "alignment": "left" }],
        "labels": [{ "color": { "solid": { "color": "#52514e" } } }]
      }
    }
  }
}
```

The eight data colours are ordered for colour-vision-deficiency separation — keep
the order. Slots 1–4 are what the shared-E&M chart uses.

## Checks before you call it done

- `Medicare Paid` = **$93.72B**, `Providers` = **1,175,213**, `Procedure Codes` = **6,405**
- `Non-Participating Share` = **0.096%**
- `Top 1% Share of Drug Spend` = **48.9%**
- `Codes Paying More in Facility` = **137**
- Every page's numbers match `docs/data.json` and the live dashboard
- No visual shows a summed NPI or HCPCS code
- The site-of-service page carries its caveat text
