#!/usr/bin/env python3
"""
Compute small dashboard stats (earliest / latest paper year over the PMIDs in the
database) and write docs/stats.json. Loaded at startup for the Dashboard.
"""
import json, os, sqlite3
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB = os.path.join(ROOT, "docs", "salt_genes.db")
PIPE = "/home/wangy1j/script_result/jupyter/AI_paper/all_keys_abstract/pipeline"
OUT = os.path.join(ROOT, "docs", "stats.json")


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
    json.dump(out, open(OUT, "w"))
    print("wrote", OUT, out)


if __name__ == "__main__":
    main()
