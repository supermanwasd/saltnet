#!/usr/bin/env bash
# Keyword -> PMID list, the front door of the corpus pipeline (feeds 00_fetch_pubmed.sh).
#
# Usage:
#   ./00a_esearch.sh "QUERY" OUT_FILE [MINDATE] [MAXDATE]
#
#   QUERY     PubMed query string (Boolean, [TIAB]/[MeSH] tags allowed).
#             If omitted or "-", uses the built-in SaltNet salt-stress query.
#   OUT_FILE  where to write the PMID list (default: pmids.txt)
#   MINDATE   optional start year (e.g. 1940)   ] publication-date filter
#   MAXDATE   optional end year   (e.g. 2026)   ]
#
# Requires: NCBI EDirect (esearch/efetch on PATH). Set NCBI_API_KEY to raise the
# rate limit (optional). Resumable: writes atomically; re-running refreshes the list.
#
# Examples:
#   ./00a_esearch.sh - pmids.txt 1940 2026            # default salt-stress query
#   ./00a_esearch.sh '("cold stress"[TIAB] OR chilling[TIAB]) AND plants[MeSH]' cold_pmids.txt 2000 2026
set -euo pipefail

QUERY="${1:--}"
OUT_FILE="${2:-pmids.txt}"
MINDATE="${3:-}"
MAXDATE="${4:-}"

# built-in SaltNet salt-stress query (the one used for the published corpus)
DEFAULT_QUERY='("salt stress"[TIAB] OR salinity[TIAB] OR "salt tolerance"[TIAB] OR
 "salt-tolerant"[TIAB] OR "osmotic stress"[TIAB] OR "ionic stress"[TIAB] OR
 "ion homeostasis"[TIAB] OR "SOS pathway"[TIAB] OR "NHX antiporter"[TIAB] OR
 "HKT transporter"[TIAB] OR osmoprotectant*[TIAB] OR "ROS scavenging"[TIAB] OR
 "ABA signaling"[TIAB] OR halophyte*[TIAB] OR halotolerant*[TIAB] OR
 halophilic[TIAB] OR hypersaline*[TIAB] OR "salt-responsive"[TIAB] OR
 "Na+/K+"[TIAB] OR "osmotic adjustment"[TIAB] OR
 "Salt-Tolerant Plants"[MeSH] OR "Salt Tolerance"[MeSH])
 AND hasabstract[text]'

if [ "$QUERY" = "-" ] || [ -z "$QUERY" ]; then
  QUERY="$DEFAULT_QUERY"
fi

if ! command -v esearch >/dev/null 2>&1; then
  echo "ERROR: NCBI EDirect not found (need esearch/efetch on PATH)." >&2
  echo "Install: sh -c \"\$(curl -fsSL https://ftp.ncbi.nlm.nih.gov/entrez/entrezdirect/install-edirect.sh)\"" >&2
  exit 1
fi

# assemble optional date filter
DATE_ARGS=()
if [ -n "$MINDATE" ] || [ -n "$MAXDATE" ]; then
  DATE_ARGS=(-datetype PDAT -mindate "${MINDATE:-1900}" -maxdate "${MAXDATE:-3000}")
fi

echo "query   : $(echo "$QUERY" | tr '\n' ' ' | sed 's/  */ /g')" >&2
[ ${#DATE_ARGS[@]} -gt 0 ] && echo "date    : ${MINDATE:-any}..${MAXDATE:-any} (PDAT)" >&2

TMP="$(mktemp)"
# esearch -> efetch uid gives one PMID per line
esearch -db pubmed -query "$QUERY" "${DATE_ARGS[@]}" \
  | efetch -format uid \
  | grep -E '^[0-9]+$' | sort -u > "$TMP"

N=$(wc -l < "$TMP")
mv -f "$TMP" "$OUT_FILE"
echo "wrote $N PMIDs -> $OUT_FILE" >&2
echo "next: ./00_fetch_pubmed.sh $OUT_FILE <out_dir>" >&2
