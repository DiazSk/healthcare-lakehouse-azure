from pyspark.sql import Column, functions as F


def normalize_credentials_to_tier(crdntls_col: Column) -> Column:
    """Defensive cleansing of the CMS free-text Rndrng_Prvdr_Crdntls field.

    NULL inputs map to 'Other/Unknown' (never to NULL) — coalescing before any
    string op prevents NULL propagation through upper/regexp_replace that would
    silently shrink Hero Mart #4's denominator.

    Pipeline: coalesce → upper → strip periods/whitespace → rlike bucket.
    Returns one of:
      'Physician (MD/DO)' | 'Nurse Practitioner' | 'Physician Assistant'
      | 'Specialist' | 'Other/Unknown'
    """
    safe  = F.coalesce(crdntls_col, F.lit(""))
    clean = F.regexp_replace(F.upper(safe), r"[\.\s]+", "")
    return (
        F.when(clean.rlike(r"(?:^|[^A-Z])(MD|DO)(?:$|[^A-Z])"),                F.lit("Physician (MD/DO)"))
         .when(clean.rlike(r"(?:^|[^A-Z])(NP|APRN|FNP|CRNA)(?:$|[^A-Z])"),     F.lit("Nurse Practitioner"))
         .when(clean.rlike(r"(?:^|[^A-Z])(PA|PAC)(?:$|[^A-Z])"),               F.lit("Physician Assistant"))
         .when(clean.rlike(r"(?:^|[^A-Z])(OD|DPM|DDS|DMD|DC)(?:$|[^A-Z])"),    F.lit("Specialist"))
         .otherwise(F.lit("Other/Unknown"))
    )
