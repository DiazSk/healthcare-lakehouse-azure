# DAX measure set

Create these in a dedicated `_Measures` table (**Home → Enter data**, one blank
table named `_Measures`, delete its placeholder column) so they group together in
the Fields pane instead of hiding inside the fact table.

Values in the comments are the expected result against the 2023 data with no
filters applied — use them to confirm the model is wired correctly. They match the
published dashboard in `docs/`.

## Core aggregates (require `fact_provider_service`)

```dax
Medicare Paid =
SUM ( fact_provider_service[Tot_Mdcr_Pymt_Amt] )
-- unfiltered: $93.72B

Submitted Charges =
SUM ( fact_provider_service[Tot_Sbmtd_Chrg] )

Medicare Allowed =
SUM ( fact_provider_service[Tot_Mdcr_Alowd_Amt] )

Standardized Paid =
SUM ( fact_provider_service[Tot_Mdcr_Stdzd_Amt] )

Total Services =
SUM ( fact_provider_service[Tot_Srvcs] )

Beneficiary Proxy =
SUM ( fact_provider_service[Tot_Benes] )
-- Named "proxy" on purpose: this sums a per-row beneficiary count, so a patient
-- seen for three procedures is counted three times. It is NOT a patient count.

Providers =
DISTINCTCOUNT ( fact_provider_service[npi] )
-- unfiltered: 1,175,213

Procedure Codes =
DISTINCTCOUNT ( fact_provider_service[hcpcs_cd] )
-- unfiltered: 6,405
```

## Ratios

Always divide measures, never columns, and always with `DIVIDE` so a zero
denominator yields blank rather than an error.

```dax
Markup Ratio =
DIVIDE ( [Submitted Charges], [Medicare Allowed] )
-- Service-weighted by construction: both sides are already dollar totals, so this
-- is the correct weighted ratio. AVERAGE(Markup_Ratio) would weight every
-- provider-service row equally and is wrong.

Medicare Payment Rate =
DIVIDE ( [Medicare Paid], [Medicare Allowed] )

Geographic Premium =
[Medicare Paid] - [Standardized Paid]

Geographic Premium % =
DIVIDE ( [Geographic Premium], [Standardized Paid] )

Patient Exposure per Beneficiary =
DIVIDE ( [Submitted Charges] - [Medicare Paid], [Beneficiary Proxy] )
```

## Participation (Hero 02)

```dax
Non-Participating Providers =
CALCULATE ( [Providers], dim_provider[is_participating] = FALSE )
-- unfiltered: 1,130

Non-Participating Share =
DIVIDE ( [Non-Participating Providers], [Providers] )
-- unfiltered: 0.096% -- the headline finding: the loophole is functionally extinct

Exposure — Participating =
CALCULATE ( [Patient Exposure per Beneficiary], dim_provider[is_participating] = TRUE )

Exposure — Non-Participating =
CALCULATE ( [Patient Exposure per Beneficiary], dim_provider[is_participating] = FALSE )

Non-Par Premium % =
VAR Par    = [Exposure — Participating]
VAR NonPar = [Exposure — Non-Participating]
RETURN DIVIDE ( NonPar - Par, Par )

Non-Par Premium % (reliable only) =
-- Guards the denominator trap. Specialties with a handful of non-participating
-- providers produce meaningless ratios: Orthopedic Surgery shows +2,223% off
-- 11 providers measured against 20,699. Blank them rather than chart them.
IF ( [Non-Participating Providers] >= 30, [Non-Par Premium %] )
```

## Drug concentration (Hero 03)

```dax
Drug Paid =
CALCULATE ( [Medicare Paid], dim_hcpcs[is_drug] = TRUE )

Drug Share of Payments =
DIVIDE ( [Drug Paid], [Medicare Paid] )

Drug-Billing Providers =
CALCULATE ( [Providers], dim_hcpcs[is_drug] = TRUE )
-- unfiltered: 221,364

Drug-Dependent Providers =
-- Providers whose drug payments exceed 60% of their total. The mart already
-- carries the flag, so this counts rather than recomputes.
CALCULATE (
    DISTINCTCOUNT ( gold_hero_jcode_concentration[npi] ),
    gold_hero_jcode_concentration[is_drug_dependent] = TRUE
)
-- unfiltered: 42,264

Top 1% Share of Drug Spend =
-- Reads the Lorenz curve the Gold mart already computed: find the cumulative drug
-- share at the 99th percentile of providers and take the complement.
VAR AtP99 =
    CALCULATE (
        MAX ( gold_hero_jcode_concentration[cum_share_drug] ),
        gold_hero_jcode_concentration[cum_share_providers] <= 0.99
    )
RETURN 1 - AtP99
-- unfiltered: 48.9%
```

## Credentials markup (Hero 04)

The mart is pivoted one column per tier, so these are plain aggregates. Averaging
across codes is safe here because each row is already service-weighted within its code.

```dax
Markup — Physician =
AVERAGE ( gold_hero_credentials_markup[Physician_MD_DO_markup] )

Markup — Nurse Practitioner =
AVERAGE ( gold_hero_credentials_markup[Nurse_Practitioner_markup] )

Markup — Physician Assistant =
AVERAGE ( gold_hero_credentials_markup[Physician_Assistant_markup] )

Markup — Specialist =
AVERAGE ( gold_hero_credentials_markup[Specialist_markup] )

Markup Spread (PA − Physician) =
[Markup — Physician Assistant] - [Markup — Physician]
-- Positive across all six shared E&M codes. The direction is the finding:
-- non-physician practitioners submit the HIGHER multiple of the allowed amount.
```

Filter these visuals to `gold_hero_credentials_markup[is_shared_e_and_m] = TRUE`
for the six codes all tiers bill. Across those codes the averages run
PA 2.72x, NP 2.69x, MD 2.23x, Specialist 1.79x.

## Site of service (Hero 05)

```dax
Facility Premium =
SUM ( gold_hero_site_neutral[site_neutral_savings] )
-- unfiltered: -$2.90B. NEGATIVE, and that is correct -- see the caveat below.

Facility Premium (positive tail) =
CALCULATE (
    SUM ( gold_hero_site_neutral[site_neutral_savings] ),
    gold_hero_site_neutral[site_neutral_savings] > 0
)
-- $2.65B

Facility Premium (negative tail) =
CALCULATE (
    SUM ( gold_hero_site_neutral[site_neutral_savings] ),
    gold_hero_site_neutral[site_neutral_savings] < 0
)
-- -$5.55B

Codes Paying More in Facility =
CALCULATE (
    COUNTROWS ( gold_hero_site_neutral ),
    gold_hero_site_neutral[site_ratio] > 1
)
-- 137 of 972

Median Facility-to-Office Ratio =
MEDIAN ( gold_hero_site_neutral[site_ratio] )
-- 0.59x
```

**Do not label `Facility Premium` as "savings."** This dataset contains only the
physician's professional fee. When a procedure is performed in a facility, Medicare's
fee schedule moves the practice-expense component out of the physician's payment and
pays the hospital separately under OPPS — a different dataset entirely. 830 of 972
codes therefore pay the physician *less* in a facility. The measure shows where
payment **moved**, not money saved. A real site-neutral estimate requires joining
OPPS data.

## Formatting

Set these once per measure in **Measure tools**:

| Measures | Format |
|---|---|
| All dollar measures | Currency, 0 decimals, thousands separator |
| `*Share*`, `*%*`, `Medicare Payment Rate` | Percentage, 1 decimal |
| `Markup*`, `Median Facility-to-Office Ratio` | Decimal, 2 decimals |
| `Providers`, `*Codes*`, `Total Services`, `Beneficiary Proxy` | Whole number, thousands separator |
