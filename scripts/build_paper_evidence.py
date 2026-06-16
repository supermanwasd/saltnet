#!/usr/bin/env python3
"""
Build per-paper evidence for each gene: docs/gene_papers.json = {gene_id: [cards]}.

Each card is one supporting paper with that paper's own experimental context
(genetic background, validation method, stress condition, tissue, phenotype, …)
pulled from the pre-merge per-paper extraction, plus the paper's title/year/journal.

gene_id matches build_db.py (1-based row order of the grand_final CSV).

Run after build_db.py:  python scripts/build_paper_evidence.py
"""
import csv, json, os, re
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PIPE = "/home/wangy1j/script_result/jupyter/AI_paper/all_keys_abstract/pipeline"
CSV_PATH = os.path.join(ROOT, "docs", "data", "extracted_genes_v5_grand_final.csv")
OUT = os.path.join(ROOT, "docs", "gene_papers.json")
csv.field_size_limit(1 << 24)

# per-paper extraction column -> short JSON key (experiment-specific fields only)
FIELDS = [
    ("Genetic background / cultivar", "gb"),
    ("Functional validation method", "method"),
    ("Stress condition", "stress"),
    ("Tissue / Organ", "tissue"),
    ("Perturbation phenotype", "phen"),
    ("Allelic info", "allelic"),
    ("Population evidence", "pop"),
    ("Population context", "popctx"),
    ("Inferred gene role", "role"),
    ("Evidence Strength", "ev"),
    ("Notes", "notes"),
]


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def clean(v):
    if v is None:
        return None
    v = str(v).strip()
    if not v or v.lower() in {"nan", "n/a", "na", "none", "not applicable", "not reported"}:
        return None
    return v


def main():
    # paper metadata
    meta = pd.read_parquet(os.path.join(PIPE, "all_parsed.parquet"),
                           columns=["pmid", "title", "year", "journal"])
    pmeta = {str(r.pmid).strip(): (clean(r.title), r.year, clean(r.journal))
             for r in meta.itertuples(index=False)}

    # per-paper extraction (abstract + fulltext finals)
    A = pd.read_parquet(os.path.join(PIPE, "extracted_genes_v5_final_v2.parquet"))
    F = pd.read_parquet(os.path.join(PIPE, "extracted_genes_v5_fulltext_final.parquet"))
    P = pd.concat([A, F], ignore_index=True)

    # index (pmid, species) -> list of row indices; precompute gene-name norm
    P["_gn"] = P["Gene Name"].map(norm)
    P["_sp"] = P["Species"].astype(str).str.strip()
    P["_pmid"] = P["pmid"].astype(str).str.strip()
    from collections import defaultdict
    idx = defaultdict(list)
    for i, (pm, sp) in enumerate(zip(P["_pmid"], P["_sp"])):
        idx[(pm, sp)].append(i)
    Pr = P.to_dict("records")

    def score(rec):
        return sum(1 for col, _ in FIELDS if clean(rec.get(col)))

    out = {}
    n_cards = 0
    with open(CSV_PATH, newline="", encoding="utf-8") as fh:
        for gid, g in enumerate(csv.DictReader(fh), start=1):
            sp = (g["species"] or "").strip()
            names = {norm(x) for x in str(g["all_names"]).split(";")}
            names.add(norm(g["canonical_gene"]))
            pmids = [p.strip() for p in str(g["pmids"]).split(";") if p.strip()]
            cards = []
            for pm in pmids:
                cands = [Pr[i] for i in idx.get((pm, sp), []) if Pr[i]["_gn"] in names]
                if not cands:
                    continue
                rec = max(cands, key=score)               # most complete extraction
                card = {"pmid": pm}
                title, year, journal = pmeta.get(pm, (None, None, None))
                if title: card["title"] = title
                if year and str(year) != "nan": card["year"] = int(year) if str(year).replace(".0", "").isdigit() else str(year)
                if journal: card["journal"] = journal
                for col, key in FIELDS:
                    v = clean(rec.get(col))
                    if v:
                        card[key] = v
                cards.append(card)
            if cards:
                # newest paper first when year known
                cards.sort(key=lambda c: -(c.get("year") or 0) if isinstance(c.get("year"), int) else 0)
                out[str(gid)] = cards
                n_cards += len(cards)

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(OUT) / 1024 / 1024
    print(f"wrote {OUT}: {len(out)} genes, {n_cards} paper cards, {size:.1f} MB")


if __name__ == "__main__":
    main()
