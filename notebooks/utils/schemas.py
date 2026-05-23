from pyspark.sql.types import StructType, StructField, StringType

# All 28 CMS columns read as StringType so the Bronze read skips the two-pass
# `inferSchema` cost on a 3 GB / 9.6M-row file. Every numeric column is cast
# explicitly inside 01_bronze_to_silver.py against SILVER_CASTS below.
CMS_RAW_SCHEMA = StructType([
    StructField("Rndrng_NPI",                    StringType(), False),
    StructField("Rndrng_Prvdr_Last_Org_Name",    StringType(), True),
    StructField("Rndrng_Prvdr_First_Name",       StringType(), True),
    StructField("Rndrng_Prvdr_MI",               StringType(), True),
    StructField("Rndrng_Prvdr_Crdntls",          StringType(), True),
    StructField("Rndrng_Prvdr_Ent_Cd",           StringType(), True),
    StructField("Rndrng_Prvdr_St1",              StringType(), True),
    StructField("Rndrng_Prvdr_St2",              StringType(), True),
    StructField("Rndrng_Prvdr_City",             StringType(), True),
    StructField("Rndrng_Prvdr_State_Abrvtn",     StringType(), True),
    StructField("Rndrng_Prvdr_State_FIPS",       StringType(), True),
    StructField("Rndrng_Prvdr_Zip5",             StringType(), True),
    StructField("Rndrng_Prvdr_RUCA",             StringType(), True),
    StructField("Rndrng_Prvdr_RUCA_Desc",        StringType(), True),
    StructField("Rndrng_Prvdr_Cntry",            StringType(), True),
    StructField("Rndrng_Prvdr_Type",             StringType(), True),
    StructField("Rndrng_Prvdr_Mdcr_Prtcptg_Ind", StringType(), True),
    StructField("HCPCS_Cd",                      StringType(), False),
    StructField("HCPCS_Desc",                    StringType(), True),
    StructField("HCPCS_Drug_Ind",                StringType(), True),
    StructField("Place_Of_Srvc",                 StringType(), True),
    StructField("Tot_Benes",                     StringType(), True),
    StructField("Tot_Srvcs",                     StringType(), True),
    StructField("Tot_Bene_Day_Srvcs",            StringType(), True),
    StructField("Avg_Sbmtd_Chrg",                StringType(), True),
    StructField("Avg_Mdcr_Alowd_Amt",            StringType(), True),
    StructField("Avg_Mdcr_Pymt_Amt",             StringType(), True),
    StructField("Avg_Mdcr_Stdzd_Amt",            StringType(), True),
])

SILVER_CASTS = {
    "Tot_Benes":           "int",
    "Tot_Srvcs":           "long",
    "Tot_Bene_Day_Srvcs":  "long",
    "Avg_Sbmtd_Chrg":      "double",
    "Avg_Mdcr_Alowd_Amt":  "double",
    "Avg_Mdcr_Pymt_Amt":   "double",
    "Avg_Mdcr_Stdzd_Amt":  "double",
}
