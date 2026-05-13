variable "resource_group_name" {
  description = "Name of the Azure Resource Group that holds all platform resources."
  type        = string
  default     = "rg-healthcare-platform-dev"
}

variable "location" {
  description = "Azure region for all resources."
  type        = string
  default     = "westus2"
}

variable "storage_account_name" {
  description = "Globally unique name for the ADLS Gen2 storage account (3-24 lowercase alphanumeric)."
  type        = string
  default     = "sthealthcareplatdev"
}

variable "key_vault_name" {
  description = "Globally unique name for the Azure Key Vault (3-24 alphanumeric, must start with a letter)."
  type        = string
  default     = "kv-healthcare-plat-dev"
}

variable "medallion_containers" {
  description = "ADLS Gen2 filesystem (container) names for the Medallion layers."
  type        = list(string)
  default     = ["bronze", "silver", "gold"]
}

variable "environment" {
  description = "Deployment environment used for tagging and naming."
  type        = string
  default     = "Dev"
}

variable "project" {
  description = "Project tag value applied to every resource for cost tracking."
  type        = string
  default     = "Healthcare-Platform"
}

variable "data_factory_name" {
  description = "Globally unique name for the Azure Data Factory (3-63 alphanumeric and hyphens, must start with a letter)."
  type        = string
  default     = "adf-healthcare-plat-dev"
}

variable "service_principal_object_id" {
  description = "Object ID of the Service Principal that ADF/Databricks will use to access the Data Lake. Provide via terraform.tfvars or -var."
  type        = string
}

variable "databricks_workspace_name" {
  description = "Globally unique name for the Azure Databricks workspace (3-63 alphanumeric and hyphens, must start with a letter)."
  type        = string
  default     = "dbw-healthcare-plat-dev"
}
