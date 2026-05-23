STORAGE_ACCOUNT = "sthealthcareplatdev"


def abfss(container: str, suffix: str) -> str:
    return f"abfss://{container}@{STORAGE_ACCOUNT}.dfs.core.windows.net/{suffix}"


BRONZE_PHYSICIAN_GLOB = abfss("bronze", "*.json")
SILVER_PHYSICIAN      = abfss("silver", "physician_by_provider_service/")


def GOLD(name: str) -> str:
    return abfss("gold", f"{name}/")
