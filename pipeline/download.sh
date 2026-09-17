#!/usr/bin/env bash
# Download the CMS source file this lakehouse was built on.
#
# The Azure subscription that hosted the original Bronze layer is retired, but the
# CMS source is public and immutable, so the whole pipeline is reproducible from here.
# Dataset: Medicare Physician & Other Practitioners - by Provider and Service (2023)
# Landing page: https://data.cms.gov/provider-summary-by-type-of-service/medicare-physician-other-practitioners/medicare-physician-other-practitioners-by-provider-and-service
set -euo pipefail

URL="https://data.cms.gov/sites/default/files/2025-04/e3f823f8-db5b-4cc7-ba04-e7ae92b99757/MUP_PHY_R25_P05_V20_D23_Prov_Svc.csv"
EXPECTED_BYTES=3062332720
DEST="$(cd "$(dirname "$0")/.." && pwd)/data/bronze/MUP_PHY_R25_P05_V20_D23_Prov_Svc.csv"

mkdir -p "$(dirname "$DEST")"

# -C - resumes a partial download, so an interrupted 3 GB pull is cheap to retry.
curl -L -C - --retry 5 --retry-delay 5 -o "$DEST" "$URL"

actual=$(wc -c < "$DEST" | tr -d ' ')
if [ "$actual" != "$EXPECTED_BYTES" ]; then
    echo "FAIL: expected $EXPECTED_BYTES bytes, got $actual" >&2
    exit 1
fi
echo "OK: $DEST ($actual bytes)"
