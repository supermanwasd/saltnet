#!/usr/bin/env python3
"""
Compute small dashboard stats and write docs/stats.json (loaded at startup):
  - earliest / latest paper *year* over the PMIDs in the database
  - the most recent paper's *month* (real electronic-publication date from PubMed)
"""
import json, os, sqlite3, time, urllib.parse, urllib.request
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB = os.path.join(ROOT, "docs", "salt_genes.db")
PIPE = "/home/wangy1j/script_result/jupyter/AI_paper/all_keys_abstract/pipeline"
OUT = os.path.join(ROOT, "docs", "stats.json")
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def latest_month(pmids):
    """Newest real ePub (year, month) among the given PMIDs, via PubMed esummary."""
    ids = list(pmids)
    best = None  # (year, month, "Mon YYYY")
    for i in range(0, len(ids), 150):
        url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?" + urllib.parse.urlencode(
            {"db": "pubmed", "id": ",".join(ids[i:i + 150]), "retmode": "json"})
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                res = json.load(r).get("result", {})
        except Exception:
            continue
        for uid in res.get("uids", []):
            parts = (res[uid].get("epubdate") or "").split()
            if len(parts) >= 2 and parts[0].isdigit() and parts[1] in MONTHS:
                y, m = int(parts[0]), MONTHS.index(parts[1]) + 1
                if best is None or (y, m) > (best[0], best[1]):
                    best = (y, m, f"{parts[1]} {y}")
        time.sleep(0.4)
    return best


def main():
    con = sqlite3.connect(DB)
    pmids = {str(r[0]).strip() for r in con.execute("SELECT DISTINCT pmid FROM gene_pmid")}

    meta = pd.read_parquet(os.path.join(PIPE, "all_parsed.parquet"), columns=["pmid", "year"])
    meta["pmid"] = meta["pmid"].astype(str).str.strip()
    yr = {}
    for p, y in zip(meta["pmid"], meta["year"]):
        try:
            yi = int(float(y))
        except (TypeError, ValueError):
            continue
        if 1900 <= yi <= 2100:
            yr[p] = yi

    years = [yr[p] for p in pmids if p in yr]
    out = {
        "min_year": min(years) if years else None,
        "max_year": max(years) if years else None,
        "n_pmids_dated": len(years),
    }
    if years:
        my = max(years)
        latest = latest_month([p for p in pmids if yr.get(p) == my])
        if latest:
            out["latest_paper_year"] = latest[0]
            out["latest_paper_month"] = latest[1]
            out["latest_paper_label"] = latest[2]   # e.g. "Apr 2026"

    json.dump(out, open(OUT, "w"))
    print("wrote", OUT, out)


if __name__ == "__main__":
    main()
