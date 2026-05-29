# Azure Healthcare Data Lakehouse — Medicare Reimbursement Gap Analyzer

An end-to-end **Azure data lakehouse** that ingests the CMS *Medicare Physician & Other Practitioners by Provider and Service* dataset and surfaces five "hero" billing-anomaly insights through a **Medallion architecture** (Bronze → Silver → Gold), executed entirely on **Azure Databricks + PySpark + Delta Lake**, served by **Power BI** (primary) and a **marimo** Python web app (secondary).

---

## Data Architecture

This project follows **Medallion Architecture** with Bronze, Silver, and Gold layers, all stored as Delta tables on Azure Data Lake Storage Gen2.

```mermaid
flowchart LR
    %% ---- Source ----
    CMS[("CMS Medicare<br/>Physician & Other<br/>Practitioners CSV")]:::source

    %% ---- Azure ----
    subgraph AZ["Azure Subscription"]
        direction TB

        ADF["Azure Data Factory<br/>(Phase 1 ingest)"]:::azure

        subgraph LAKE["ADLS Gen2 (Delta Lake)"]
            direction LR
            BRONZE[("Bronze<br/>raw CSV<br/>string-only")]:::bronze
            SILVER[("Silver<br/>typed, cleansed<br/>Delta")]:::silver
            GOLD[("Gold<br/>star schema +<br/>5 hero marts")]:::gold
        end

        subgraph DBX["Azure Databricks (PySpark, Photon, auto-term 10 min)"]
            direction TB
            NB1["01_bronze_to_silver"]
            NB2["02_silver_to_gold_dims"]
            NB3["03_silver_to_gold_fact"]
            NB4["04_gold_hero_marts"]
            NB5["99_dq_checks"]
        end

        KV[("Azure Key Vault<br/>kv-healthcare-plat-dev")]:::secret
        SP["Service Principal<br/>(Microsoft Entra ID)"]:::secret
    end

    %% ---- Serving ----
    subgraph VIZ["Serving Layer"]
        direction TB
        PBI["Power BI Desktop<br/>(primary, Import mode)"]:::viz
        MAR["marimo + DuckDB<br/>(interim local web app)"]:::viz
    end

    %% ---- Flow ----
    CMS --> ADF --> BRONZE
    BRONZE --> NB1 --> SILVER
    SILVER --> NB2 --> GOLD
    SILVER --> NB3 --> GOLD
    GOLD --> NB4 --> GOLD
    GOLD --> NB5
    GOLD --> PBI
    GOLD --> MAR

    %% ---- Auth ----
    SP -. OAuth 2.0 .-> LAKE
    KV --- SP
    DBX -. Databricks secret scope<br/>akv-healthcare-plat .-> KV
    MAR -. local .env<br/>(rotated SP secret) .-> SP

    %% ---- Styles ----
    classDef source  fill:#F1F5F9,stroke:#64748B,color:#0F172A
    classDef azure   fill:#E0F2FE,stroke:#0284C7,color:#0F172A
    classDef bronze  fill:#FEF3C7,stroke:#B45309,color:#0F172A
    classDef silver  fill:#E2E8F0,stroke:#475569,color:#0F172A
    classDef gold    fill:#FDE68A,stroke:#B45309,color:#0F172A
    classDef secret  fill:#FEE2E2,stroke:#B91C1C,color:#0F172A
    classDef viz     fill:#DCFCE7,stroke:#059669,color:#0F172A
```

1. **Bronze Layer**: Raw, immutable CSV ingested from CMS — read as `string`-only (no `inferSchema`), append-only.
2. **Silver Layer**: Typed, cleansed, deduplicated Delta tables with derived columns (markup ratio, par-status flag, credential category, place-of-service flag).
3. **Gold Layer**: A narrow star schema (3 dimensions + 1 fact) plus **5 hero marts** designed for the Medium / LinkedIn storytelling angles.

---

## Project Overview

This project demonstrates:

- **Cloud Data Architecture**: Azure-native Medallion on ADLS Gen2 + Delta Lake.
- **Infrastructure as Code**: Terraform-provisioned Resource Group, ADLS Gen2, Key Vault, ADF, Databricks workspace.
- **Distributed Compute**: PySpark on Azure Databricks (Photon) with strict idempotency, schema enforcement, and DECIMAL precision.
- **Secret Management**: Service Principal credentials stored in Azure Key Vault and surfaced to Databricks via a Key-Vault-backed secret scope — no hardcoded secrets.
- **Advanced Analytics**: Five feature-engineered "hero" insights (geographic arbitrage, non-participating premium, J-code concentration, credentials markup cliff, site-neutral simulation).
- **Dual-surface BI**: Power BI Desktop (Import mode) as the long-term dashboard, and a marimo + DuckDB Python web app for an immediately-runnable interim view.

Ideal for showcasing expertise in: `Azure` `Databricks` `PySpark` `Delta Lake` `ADLS Gen2` `Terraform` `Power BI` `marimo` `Data Engineering` `Healthcare Analytics`

---

## Data Source

| Source | Provider | Records | Description |
| ------ | -------- | ------- | ----------- |
| Medicare Physician & Other Practitioners — by Provider and Service | [CMS](https://data.cms.gov/provider-summary-by-type-of-service/medicare-physician-other-practitioners/medicare-physician-other-practitioners-by-provider-and-service) | ~10M rows / year | Aggregated provider-level utilization, submitted charges, and Medicare-allowed amounts per HCPCS procedure code. |

The dataset reports **Submitted Charge** (what the provider asked for) vs. **Medicare Allowed Amount** (what Medicare actually pays) at the `NPI × HCPCS × place-of-service` grain. That single ratio is the engine behind every hero insight in this project.

---

## Tools & Technologies

| Category           | Tool                                                                       | Purpose                                             |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------- |
| Infrastructure     | [Terraform](https://www.terraform.io/)                                      | Provision Azure resources (RG, ADLS, KV, ADF, DBX)  |
| Data Lake          | [Azure Data Lake Storage Gen2](https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-introduction) | Bronze / Silver / Gold containers, HNS enabled |
| Storage Format     | [Delta Lake](https://delta.io/)                                             | ACID, schema enforcement, time travel               |
| Compute            | [Azure Databricks](https://learn.microsoft.com/azure/databricks/) + PySpark | Medallion transformations (Photon, auto-terminate)  |
| Ingest (Phase 1)   | [Azure Data Factory](https://learn.microsoft.com/azure/data-factory/)       | CMS CSV → Bronze container                          |
| Identity           | Microsoft Entra ID (Service Principal)                                      | Service-to-service auth into ADLS Gen2              |
| Secrets            | [Azure Key Vault](https://learn.microsoft.com/azure/key-vault/)             | SP client secrets, Databricks-backed secret scope   |
| Primary BI         | [Power BI Desktop](https://powerbi.microsoft.com/desktop/) (Import mode)    | Recruiter-facing hero dashboards                    |
| Interim BI         | [marimo](https://marimo.io/) + [DuckDB](https://duckdb.org/)                | Reactive Python web app over Gold Delta tables      |
| Charting           | [Plotly](https://plotly.com/python/)                                        | Choropleth, Lorenz, slope, tornado, dot-plot        |
| Language           | [Python 3.11+](https://www.python.org/)                                     | PySpark notebooks, dashboard, helpers               |
| Diagrams           | Mermaid (in-Markdown)                                                       | Architecture diagram (this file)                    |

---

## Infrastructure (Terraform)

All Azure resources are provisioned by the Terraform code in `infrastructure/`:

| Resource                       | Name (default)                | Purpose                                                  |
| ------------------------------ | ----------------------------- | -------------------------------------------------------- |
| `azurerm_resource_group`       | `rg-healthcare-platform-dev`  | Cost-tracking boundary, tagged `Project: Healthcare-Platform` |
| `azurerm_storage_account`      | `sthealthcareplatdev`         | ADLS Gen2 (HNS enabled, TLS 1.2 minimum, LRS)            |
| `azurerm_storage_data_lake_gen2_filesystem` | `bronze`, `silver`, `gold` | Medallion containers                          |
| `azurerm_key_vault`            | `kv-healthcare-plat-dev`      | SP client secret storage                                 |
| `azurerm_role_assignment`      | `Storage Blob Data Contributor` | SP → ADLS access                                       |
| `azurerm_data_factory`         | `adf-healthcare-plat-dev`     | Phase 1 ingest pipeline                                  |
| `azurerm_databricks_workspace` | `dbw-healthcare-plat-dev`     | Premium SKU, hosts the PySpark notebooks                 |

**FinOps invariant:** every Databricks cluster MUST be configured to **auto-terminate after exactly 10 minutes** of inactivity (see `context/ARCHITECTURE.md`).

---

## Medallion Pipeline

The pipeline runs as five sequential PySpark notebooks under `notebooks/`:

| Notebook                          | Layer                  | Output                                                                                              |
| --------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `01_bronze_to_silver.ipynb`       | Bronze → Silver        | Typed, cleansed Silver Delta table (DECIMAL(18,2) totals, DECIMAL(12,6) ratios)                     |
| `02_silver_to_gold_dims.ipynb`    | Silver → Gold (dims)   | `dim_provider`, `dim_hcpcs`, `dim_geography`                                                        |
| `03_silver_to_gold_fact.ipynb`    | Silver → Gold (fact)   | `fact_provider_service` — narrow, additive, grain = `NPI × HCPCS × place-of-service`                |
| `04_gold_hero_marts.ipynb`        | Gold → Gold (marts)    | 5 hero marts (see "Hero Insights" below) + `OPTIMIZE … ZORDER`                                      |
| `99_dq_checks.ipynb`              | Cross-cutting          | Row counts, null checks, FK integrity, idempotency assertion                                        |
| `100_register_tables.ipynb`       | Catalog registration   | Registers all Delta tables in the Databricks Unity / Hive metastore                                 |

Helper modules in `notebooks/utils/`:

- `secrets.py` — fetches the SP client secret from the Databricks-backed Key Vault scope.
- `paths.py` — canonical `abfss://` paths for Bronze / Silver / Gold.
- `schemas.py` — explicit `StructType` schemas (no `inferSchema`).
- `credentials.py` — provider credential parsing (used by the credentials-markup hero).

---

## Star Schema (Gold Layer)

| Table Type   | Count | Tables                                                                                               |
| ------------ | ----- | ---------------------------------------------------------------------------------------------------- |
| Dimensions   | 3     | `dim_provider`, `dim_hcpcs`, `dim_geography`                                                          |
| Facts        | 1     | `fact_provider_service`                                                                               |
| Hero Marts   | 5     | `gold_hero_geo_arbitrage`, `gold_hero_non_par_premium`, `gold_hero_jcode_concentration`, `gold_hero_credentials_markup`, `gold_hero_site_neutral` |

**Total**: 9 Gold Delta tables. Join keys: `npi`, `hcpcs_cd`, `state_abrvtn` — all bi-directional so a single state slicer in Power BI cascades across every hero page.

---

## Hero Insights (Phase 2)

These are the five feature-engineered angles the Gold marts are designed to surface — each one is a candidate Medium / LinkedIn headline.

| # | Mart                              | Story Angle                                                                                                  |
| - | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1 | `gold_hero_geo_arbitrage`         | Net-sender vs. net-receiver states: which geographies inflate identical procedures the most.                 |
| 2 | `gold_hero_non_par_premium`       | The Medicare-allowed premium that Non-Participating providers extract vs. Participating peers on the same code. |
| 3 | `gold_hero_jcode_concentration`   | Lorenz-curve concentration of drug (J-code) spend across a tiny fraction of NPIs.                            |
| 4 | `gold_hero_credentials_markup`    | The "MD vs. NP vs. PA" markup cliff on shared E&M codes — does the letterhead change the bill?               |
| 5 | `gold_hero_site_neutral`          | A site-neutral counterfactual: total Medicare savings if facility-billed procedures were paid at non-facility rates. |

---

## Repository Structure

```
azure-healthcare-platform/
│
├── infrastructure/                # Terraform IaC for all Azure resources
│   ├── main.tf                    # RG, ADLS Gen2, Key Vault, ADF, Databricks
│   ├── variables.tf               # Project / env / naming variables
│   └── .terraform.lock.hcl
│
├── notebooks/                     # PySpark notebooks executed on Databricks
│   ├── 01_bronze_to_silver.ipynb
│   ├── 02_silver_to_gold_dims.ipynb
│   ├── 03_silver_to_gold_fact.ipynb
│   ├── 04_gold_hero_marts.ipynb
│   ├── 99_dq_checks.ipynb
│   ├── 100_register_tables.ipynb
│   └── utils/                     # Shared helpers
│       ├── secrets.py             # Key-Vault-backed secret scope reader
│       ├── paths.py               # abfss:// path constants
│       ├── schemas.py             # Explicit StructType definitions
│       └── credentials.py         # Provider-credential regex parser
│
├── dashboard/                     # marimo + DuckDB interim web app
│   ├── medicare_demo_dashboard.py        # Synthetic data, no Azure needed
│   ├── medicare_analytics_dashboard.py   # Reads real Gold Delta tables
│   ├── utils/
│   │   ├── data_loader.py         # deltalake → pandas, per Gold table
│   │   ├── theme.py               # UI tokens (matches ui-context.md)
│   │   └── synthetic.py           # Gold-shaped synthetic data generators
│   └── README.md
│
├── context/                       # Spec files read by both humans and the AI agent
│   ├── ARCHITECTURE.md            # Stack, storage model, auth, invariants
│   ├── project-overview.md        # Dataset + Phase 2 goals
│   ├── progress-tracker.md        # Phase 1 + Phase 2 status
│   ├── code-standards.md          # PySpark / dbt / Terraform conventions
│   ├── ui-context.md              # Color tokens + layout patterns
│   └── ai-workflow-rules.md       # Spec-driven workflow rules
│
├── .env.example                   # Local-dev env template (no secrets)
├── .gitignore
├── CLAUDE.md                      # Phase 2 mission brief
├── requirements.txt               # PySpark + dashboard Python deps
└── README.md
```

---

## Quick Start

### Option A: Azure Databricks (Full Pipeline)

#### Prerequisites
- Azure subscription with permissions to create Resource Groups
- [Terraform](https://developer.hashicorp.com/terraform/downloads) ≥ 1.5
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) authenticated (`az login`)
- [Databricks CLI](https://docs.databricks.com/en/dev-tools/cli/install.html) (for secret-scope registration)

#### Setup

```bash
# 1. Clone repo
git clone https://github.com/<you>/azure-healthcare-platform.git
cd azure-healthcare-platform

# 2. Provision Azure resources
cd infrastructure
terraform init
terraform apply -var="service_principal_object_id=<your-sp-object-id>"

# 3. Rotate + store the SP client secret in Key Vault
az ad sp credential reset --id <your-sp-app-id>
az keyvault secret set --vault-name kv-healthcare-plat-dev \
  --name sp-databricks-client-secret --value '<rotated-secret>'

# 4. Register the Databricks Key-Vault-backed secret scope
databricks secrets create-scope akv-healthcare-plat \
  --scope-backend-type AZURE_KEYVAULT \
  --resource-id /subscriptions/<sub>/resourceGroups/rg-healthcare-platform-dev/providers/Microsoft.KeyVault/vaults/kv-healthcare-plat-dev \
  --dns-name https://kv-healthcare-plat-dev.vault.azure.net/
```

#### Run the Pipeline
1. Upload `notebooks/` to the Databricks workspace.
2. Attach a Premium cluster (Photon, 8 workers, **10-minute auto-terminate** — non-negotiable FinOps invariant).
3. **Dry-run** with the `sample_mode=true` widget on `01_bronze_to_silver`, then run `01 → 02 → 03 → 04 → 99` in order.
4. Confirm `99_dq_checks` is green (row counts, null checks, FK integrity, idempotency).
5. Re-run the chain with `sample_mode=false` for the full volume.
6. Re-run `99_dq_checks` a second time to confirm idempotent row counts.

---

### Option B: Local marimo Dashboard (Demo, no Azure)

The fastest way to see the hero insights without provisioning anything.

#### Prerequisites
- Python 3.11+

#### Setup

```bash
python -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

#### Run

```bash
# Demo (synthetic Gold-shaped data — no Azure auth needed)
marimo edit dashboard/medicare_demo_dashboard.py
# OR headless web app:
marimo run dashboard/medicare_demo_dashboard.py --port 8501

# Analytics (real Gold Delta tables — requires .env + populated Gold layer)
cp .env.example .env       # fill in AZURE_CLIENT_SECRET (rotated SP secret)
marimo edit dashboard/medicare_analytics_dashboard.py
```

See [`dashboard/README.md`](dashboard/README.md) for the full marimo / theme / troubleshooting guide.

---

## Service Access

| Service                   | URL / Location                                  | Auth                                                    |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| **Azure Portal**          | https://portal.azure.com                        | Your Azure account                                      |
| **Azure Databricks**      | `https://<workspace>.azuredatabricks.net`       | Microsoft Entra ID                                      |
| **ADLS Gen2 (Bronze/Silver/Gold)** | `abfss://<container>@sthealthcareplatdev.dfs.core.windows.net/` | SP OAuth 2.0 (via Databricks secret scope) |
| **Azure Key Vault**       | `https://kv-healthcare-plat-dev.vault.azure.net/` | Entra ID access policy                                |
| **Power BI Desktop**      | Local install                                   | Databricks SQL endpoint connector                       |
| **marimo (demo)**         | http://localhost:8501                           | None (synthetic data)                                   |
| **marimo (analytics)**    | http://localhost:8501                           | SP client secret from local `.env`                      |

---

## Authentication Model

```
Databricks notebook
    │
    │  dbutils.secrets.get(scope="akv-healthcare-plat", key="sp-databricks-client-secret")
    ▼
Databricks Key-Vault-backed scope ──── reads ───▶ Azure Key Vault (kv-healthcare-plat-dev)
                                                       │
                                                       │  stores rotated SP client_secret
                                                       ▼
                                            Service Principal (Microsoft Entra ID)
                                                       │
                                                       │  OAuth 2.0 client credentials flow
                                                       ▼
                                            ADLS Gen2 (Bronze / Silver / Gold)
```

The local marimo analytics dashboard skips the Databricks scope and reads the same SP secret from a gitignored `.env` file — the only place a secret value ever touches your laptop. See `context/ARCHITECTURE.md` § "Auth and Access Model".

---

## Useful Commands

```bash
# Terraform
cd infrastructure
terraform init
terraform plan -var="service_principal_object_id=<sp-object-id>"
terraform apply -var="service_principal_object_id=<sp-object-id>"
terraform destroy -var="service_principal_object_id=<sp-object-id>"   # tear down

# Databricks CLI
databricks clusters list
databricks workspace import_dir notebooks /Users/<you>/healthcare/notebooks --overwrite
databricks secrets list-scopes
databricks secrets list --scope akv-healthcare-plat

# marimo
source .venv/bin/activate
marimo edit dashboard/medicare_demo_dashboard.py
marimo run  dashboard/medicare_analytics_dashboard.py --port 8501

# Verify .env is gitignored before pushing
git check-ignore -v .env
```

---

## Data Attribution

| Dataset                                                 | Source                                                                                                                                                                                  | License        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Medicare Physician & Other Practitioners — by Provider and Service | [data.cms.gov](https://data.cms.gov/provider-summary-by-type-of-service/medicare-physician-other-practitioners/medicare-physician-other-practitioners-by-provider-and-service) | Public Domain (U.S. Government work) |

Data published by the **Centers for Medicare & Medicaid Services (CMS)**. This project is an independent analytical work and is not affiliated with or endorsed by CMS.

---

## License

This project is licensed under the [MIT License](LICENSE.md). You are free to use, modify, and share this project with proper attribution.

---

## About Me

Hi! I'm **Zaid Shaikh**, an MS Computer Science student at **Northeastern University Seattle**, passionate about Data Engineering and building scalable cloud data platforms.

[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/zaidshaikhengineer/)
[![GitHub](https://img.shields.io/badge/GitHub-100000?style=for-the-badge&logo=github&logoColor=white)](https://github.com/DiazSk)
