#!/usr/bin/env python3
"""
Build the SQLite database `salt_genes.db` from the curated CSV.

Design: a flat main table `genes` (mirrors the 26 CSV columns with clean
snake_case names) PLUS a handful of normalized child tables for the
multi-value fields that are most useful for filtering / charting, PLUS a
`species` dimension table with per-species counts.

Run:
    python scripts/build_db.py
Reads : data/extracted_genes_v5_grand_final.csv
Writes: docs/salt_genes.db   (served by GitHub Pages and queryable in-browser)
"""
import csv
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CSV_PATH = os.path.join(ROOT, "docs", "data", "extracted_genes_v5_grand_final.csv")
DB_PATH = os.path.join(ROOT, "docs", "salt_genes.db")

# CSV header  ->  clean SQL column name
COLMAP = [
    ("canonical_gene",                "canonical_gene"),
    ("species",                       "species"),
    ("all_names",                     "all_names"),
    ("n_distinct_names",              "n_distinct_names"),
    ("n_rows",                        "n_rows"),
    ("n_pmids",                       "n_pmids"),
    ("pmids",                         "pmids"),
    ("_origin",                       "origin"),
    ("_in_abstract",                  "in_abstract"),
    ("_in_fulltext",                  "in_fulltext"),
    ("Evidence_Strength_best",        "evidence_strength"),
    ("Genetic background / cultivar", "genetic_background"),
    ("Functional validation method",  "validation_method"),
    ("Population evidence",           "population_evidence"),
    ("Population context",            "population_context"),
    ("Allelic info",                  "allelic_info"),
    ("Stress condition",              "stress_condition"),
    ("Tissue / Organ",                "tissue"),
    ("Perturbation phenotype",        "perturbation_phenotype"),
    ("Inferred gene role",            "gene_role"),
    ("Functional Category",           "functional_category"),
    ("Transport Substrate",           "transport_substrate"),
    ("Subcellular Localization",      "subcellular_localization"),
    ("Mechanistic Role",              "mechanistic_role"),
    ("Expression Response",           "expression_response"),
    ("Notes",                         "notes"),
    ("_is_plant",                     "is_plant"),
]
INT_COLS = {"n_distinct_names", "n_rows", "n_pmids"}
BOOL_COLS = {"in_abstract", "in_fulltext"}
# stored as readable text ("Plant" / "Non-plant host") so it works as a facet
PLANT_COL = "is_plant"

# child tables: (table, value column, source SQL column)
CHILD_TABLES = [
    ("gene_pmid",      "pmid",      "pmids"),
    ("gene_category",  "category",  "functional_category"),
    ("gene_tissue",    "tissue",    "tissue"),
    ("gene_mechanism", "mechanism", "mechanistic_role"),
    ("gene_substrate", "substrate", "transport_substrate"),
]


def split_vals(s):
    if s is None:
        return []
    seen, out = set(), []
    for p in str(s).split(";"):
        p = p.strip()
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


def to_int(s):
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None


def to_bool(s):
    if s is None:
        return None
    return 1 if str(s).strip().lower() in {"true", "1", "yes"} else 0


def main():
    if not os.path.exists(CSV_PATH):
        sys.exit(f"CSV not found: {CSV_PATH}")
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute("PRAGMA journal_mode=OFF")
    cur.execute("PRAGMA synchronous=OFF")

    # ---- main table ----
    col_defs = ["gene_id INTEGER PRIMARY KEY"]
    for _csv, sqlc in COLMAP:
        if sqlc in INT_COLS or sqlc in BOOL_COLS:
            col_defs.append(f'"{sqlc}" INTEGER')
        else:
            col_defs.append(f'"{sqlc}" TEXT')
    cur.execute(f"CREATE TABLE genes ({', '.join(col_defs)})")

    # ---- child tables ----
    for tbl, valcol, _src in CHILD_TABLES:
        cur.execute(
            f"CREATE TABLE {tbl} ("
            f"gene_id INTEGER NOT NULL REFERENCES genes(gene_id), "
            f'"{valcol}" TEXT NOT NULL)'
        )

    sql_cols = [c for _, c in COLMAP]
    insert_genes = (
        f'INSERT INTO genes (gene_id, {", ".join(chr(34)+c+chr(34) for c in sql_cols)}) '
        f"VALUES ({', '.join(['?'] * (len(sql_cols) + 1))})"
    )

    child_rows = {t: [] for t, _, _ in CHILD_TABLES}
    n = 0
    with open(CSV_PATH, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for gid, row in enumerate(reader, start=1):
            vals = [gid]
            rowmap = {}
            for csv_name, sqlc in COLMAP:
                raw = row.get(csv_name)
                if raw is not None and raw.strip() == "":
                    raw = None
                if sqlc in INT_COLS:
                    v = to_int(raw)
                elif sqlc in BOOL_COLS:
                    v = to_bool(raw)
                elif sqlc == PLANT_COL:
                    v = None if raw is None else (
                        "Plant" if str(raw).strip().lower() in {"true", "1", "yes"} else "Non-plant host"
                    )
                else:
                    v = raw
                vals.append(v)
                rowmap[sqlc] = raw
            cur.execute(insert_genes, vals)
            for tbl, _valcol, src in CHILD_TABLES:
                for v in split_vals(rowmap.get(src)):
                    child_rows[tbl].append((gid, v))
            n += 1

    for tbl, valcol, _src in CHILD_TABLES:
        cur.executemany(
            f'INSERT INTO {tbl} (gene_id, "{valcol}") VALUES (?, ?)', child_rows[tbl]
        )

    # ---- species dimension (per-species gene + pmid counts) ----
    cur.execute(
        """
        CREATE TABLE species_dim AS
        SELECT species,
               COUNT(*)            AS n_genes,
               SUM(COALESCE(n_pmids,0)) AS total_pmids
        FROM genes
        WHERE species IS NOT NULL
        GROUP BY species
        """
    )

    # ---- indexes ----
    cur.execute("CREATE INDEX idx_genes_species  ON genes(species)")
    cur.execute("CREATE INDEX idx_genes_evidence ON genes(evidence_strength)")
    cur.execute("CREATE INDEX idx_genes_role     ON genes(gene_role)")
    cur.execute("CREATE INDEX idx_genes_canon    ON genes(canonical_gene)")
    cur.execute("CREATE INDEX idx_genes_plant    ON genes(is_plant)")
    for tbl, valcol, _src in CHILD_TABLES:
        cur.execute(f"CREATE INDEX idx_{tbl}_val ON {tbl}(\"{valcol}\")")
        cur.execute(f"CREATE INDEX idx_{tbl}_gid ON {tbl}(gene_id)")

    con.commit()

    # ---- report ----
    def count(t):
        return cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]

    print(f"Built {DB_PATH}")
    print(f"  genes          {count('genes'):>7}")
    for tbl, _, _ in CHILD_TABLES:
        print(f"  {tbl:<14} {count(tbl):>7}")
    print(f"  species_dim    {count('species_dim'):>7}")
    con.close()


if __name__ == "__main__":
    main()
