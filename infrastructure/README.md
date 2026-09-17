# Terraform — Azure infrastructure

Provisions the original Azure footprint: Resource Group, ADLS Gen2 (HNS enabled) with
`bronze`/`silver`/`gold` filesystems, Key Vault, the SP role assignment, Data Factory,
and the Databricks workspace.

## State is stale — read before running anything

`terraform.tfstate` is local and gitignored, and it is at **serial 23 describing 10
resource instances that no longer exist** — the subscription behind them is retired.

- `terraform plan` / `destroy` will fail at authentication, not do damage.
- `terraform apply` against a *fresh* subscription will fail on globally-unique names
  already taken (`sthealthcareplatdev`, `kv-healthcare-plat-dev`). Change the defaults
  in `variables.tf` first.
- Delete or archive the stale state before reusing this against a new subscription.

**None of this is needed to run the project.** The pipeline reproduces entirely from the
public CMS source — see "Reproduce the whole pipeline locally" in the root README.

## Known gaps (were manual steps, never codified)

- **No Key Vault access policy for the service principal.** The root README's
  `az keyvault secret set` step worked because the policy covers the interactive caller,
  not the SP. A from-scratch apply would not reproduce the working secret path.
- **No `azurerm_databricks_cluster`.** The 10-minute auto-terminate FinOps invariant is
  documented but enforced by hand in the workspace UI.
- **No ADF pipeline/dataset/linked-service resources.** The CMS → Bronze ingest was
  built in the portal, so the ADF resource here is an empty shell. `pipeline/download.sh`
  is the reproducible replacement.
- **Region mismatch.** `azurerm_databricks_workspace` hardcodes `centralus` while
  everything else uses `var.location` (`westus2`).
