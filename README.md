# 🌱 SaltNet — Plant Salt-Tolerance Gene Database

A curated, literature-mined catalogue of plant **salt-tolerance genes** across species —
with alias clustering, PubMed support, evidence-strength grading, functional category,
transport substrate, subcellular localization, mechanistic role, per-paper evidence, a
per-species knowledge graph, and TCDB-checked transporter annotations.

**🔗 Website:** <https://supermanwasd.github.io/saltnet/>

- 8,785 gene × species records · 854 species · ~6,900 unique PMIDs
- Per-species knowledge graph: 8,644 nodes · 15,070 edges · 24,498 evidence quotes

---

## Download the data

All underlying data is in this repository under `docs/`. Use the direct links below,
or download the whole dataset by clicking **Code → Download ZIP** at the top of the repo.

| Data | File | Direct download |
|---|---|---|
| **Full gene table (CSV)** — one row per gene × species, all 26 fields | `docs/data/extracted_genes_v5_grand_final.csv` | [download](https://github.com/supermanwasd/saltnet/raw/main/docs/data/extracted_genes_v5_grand_final.csv) |
| **SQLite database** — genes + child tables + species dimension | `docs/salt_genes.db` | [download](https://github.com/supermanwasd/saltnet/raw/main/docs/salt_genes.db) |
| **Per-paper evidence (JSON)** — each paper's experimental context per gene | `docs/gene_papers.json` | [download](https://github.com/supermanwasd/saltnet/raw/main/docs/gene_papers.json) |
| **TCDB transporter annotation (JSON)** — family / TC class per transporter | `docs/tcdb_families.json` | [download](https://github.com/supermanwasd/saltnet/raw/main/docs/tcdb_families.json) |
| **Knowledge graph** — one positioned subgraph + evidence per species | `docs/kg/` (`index.json`, `<species>.json`, `<species>.ev.json`) | browse the [`docs/kg/`](docs/kg) folder |

To get everything at once:

```bash
git clone https://github.com/supermanwasd/saltnet.git
# data lives in saltnet/docs/
```

### Querying the SQLite database

```bash
sqlite3 docs/salt_genes.db
```

```sql
-- best-supported Na+ transporters
SELECT g.canonical_gene, g.species, g.n_pmids
FROM genes g
JOIN gene_substrate s ON s.gene_id = g.gene_id AND s.substrate = 'Na+'
ORDER BY g.n_pmids DESC LIMIT 20;

-- all genes citing a given paper
SELECT g.canonical_gene, g.species
FROM genes g JOIN gene_pmid p ON p.gene_id = g.gene_id
WHERE p.pmid = '12239394';
```

Or in Python:

```python
import sqlite3, pandas as pd
con = sqlite3.connect("docs/salt_genes.db")
df = pd.read_sql("SELECT * FROM genes", con)
```

---

## Database schema (`salt_genes.db`)

**`genes`** — one row per `(canonical_gene, species)` cluster:

`gene_id`, `canonical_gene`, `species`, `all_names`, `n_distinct_names`, `n_rows`,
`n_pmids`, `pmids`, `origin`, `in_abstract`, `in_fulltext`, `evidence_strength`,
`genetic_background`, `validation_method`, `population_evidence`, `population_context`,
`allelic_info`, `stress_condition`, `tissue`, `perturbation_phenotype`, `gene_role`,
`functional_category`, `transport_substrate`, `subcellular_localization`,
`mechanistic_role`, `expression_response`, `notes`, `is_plant`.

**Child tables** (each `gene_id` → many values):

| table | columns |
|---|---|
| `gene_pmid` | `gene_id`, `pmid` |
| `gene_category` | `gene_id`, `category` |
| `gene_tissue` | `gene_id`, `tissue` |
| `gene_mechanism` | `gene_id`, `mechanism` |
| `gene_substrate` | `gene_id`, `substrate` |

**`species_dim`** — `species`, `n_genes`, `total_pmids`.

### Other data files

- **`gene_papers.json`** — `{gene_id: [ {pmid, title, journal, year, gb, method, stress,
  tissue, phen, allelic, pop, ...} ]}`: the per-paper experimental context behind each gene.
- **`tcdb_families.json`** — `{gene_id: {fam, tc, exp, v}}`: TCDB transporter family, TC
  class, expected substrate, and whether the annotated substrate is consistent with TCDB.
- **`kg/index.json`** — list of species with node/edge counts; **`kg/<species>.json`** —
  nodes (genes + pathways, positioned) and edges (relation, confidence, support);
  **`kg/<species>.ev.json`** — per-edge supporting evidence (PMID, confidence, quote).

---

## Citation

If you use SaltNet, please cite the accompanying paper. *(Add citation / DOI here.)*

## License

SaltNet is licensed under the **Creative Commons Attribution 4.0 International License
([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/))** — see [`LICENSE`](LICENSE).
You are free to use, share, and adapt the data and website for any purpose, provided you
give appropriate credit and cite the source.
