# SaltNet pipeline — stage map (for Makefile + MCP packaging)

Two-tier design. Tier A = literature → structured data (LLM, expensive, per-PMID
incremental). Tier B = data → db/graph/tables/figures (deterministic, cheap).
The 7 proposed MCP tools each wrap one group of stages below.

## MCP tool 1 — `search_abstracts`  (search + download)
| step | script | input | output | incremental |
|---|---|---|---|---|
| esearch (keyword → PMID list) | *(to add: EDirect esearch wrapper)* | keywords, date range | `pmids.txt` | by date |
| fetch abstracts | `00_fetch_pubmed.sh` | `pmids.txt` | `downloaded/batch_*.txt` | ✅ skips existing batches |
| parse | `01_parse_efetch.py` | `batch_*.txt` | `all_parsed_combined.parquet` (pmid,title,abstract,year,journal) | rebuild |

## MCP tool 2 — `filter_corpus`  (keywords + clustering + filter)
| step | script | input | output | incremental |
|---|---|---|---|---|
| embed | `02_embed.py` | all_parsed | `embeddings.npy`, `pmid_order.csv` | new rows |
| cluster | `03_cluster.py` | embeddings | `umap_5d.npy`, `clusters.parquet` | global |
| keywords | `04_keybert.py` | all_parsed (+emb) | `keywords_per_doc.parquet` | new rows |
| cluster annotation (Haiku) | `07_cluster_summary.py` | clusters + keywords | `cluster_summary/*.json` | ✅ skips done |
| off-topic filter | `05_filter.py` | emb + clusters + decisions | retained PMID set | rebuild |
| noise rescue | `09_triage_noise.py` | dropped-noise PMIDs | `triage_noise/{pmid}.json` | ✅ per-PMID |

## MCP tool 3 — `extract`  (two user-chosen models)
| step | script | input | output | incremental |
|---|---|---|---|---|
| abstract extract (×2 models) | `06_cli_extract_v5.py` + `loop_v5*.sh` | retained abstracts | `llm_extract_v5_{model}/{pmid}.json` | ✅ per-PMID, quota-aware |
| fulltext download | `10_download_fulltext.py`, `11/12_unpaywall_*` | PMID list | `fulltext_corpus/{pmid}.xml`, `pdf_corpus/{pmid}.pdf` | ✅ per-PMID |
| fulltext extract (×2 models) | `13_extract_fulltext.py` + `loop_fulltext_*.sh` | fulltext | `llm_extract_v5_fulltext_{model}/{pmid}.json` | ✅ per-PMID |
| KG extract (×2 models) | `19_kg_extract.py` + `loop_kg_*.sh` | fulltext | `kg_extract_{model}/{pmid}.json` | ✅ per-PMID |

## MCP tool 4 — `arbitrate`
| step | script | input | output | incremental |
|---|---|---|---|---|
| gene adjudication (abstract) | `08_adjudicate.py` + `loop_adj.sh` | sonnet/opus parquet + abstracts | `adjudication_v5_opus/{pmid}.json` | ✅ per disputed PMID |
| gene adjudication (fulltext) | `14_adjudicate_fulltext.py` + `loop_adjudicate_fulltext.sh` | fulltext disagreements | `adjudication_v5_fulltext_opus/{pmid}.json` | ✅ per-PMID |
| KG edge arbitration | `20_arbitrate_disagree.py` + `loop_arbitrate_disagree.sh` | `kg_edges_combined.parquet` | `kg_arbitration_results.parquet` | ✅ per disputed edge, quota-aware |

## MCP tool 5 — `audit`
| step | script (+apply) | column | incremental |
|---|---|---|---|
| transport substrate | `15_audit_transport.py` → `_apply_transport_audit.py` | Transport Substrate | ✅ per-gene |
| functional category | `16_audit_funccat.py` → `_apply_funccat_audit.py` | Functional Category | ✅ per-gene |
| species | `17_audit_species.py` → `_apply_species_audit.py` | species | ✅ per-gene |
| inferred role | `18_audit_role.py` → `_apply_role_audit.py` | Inferred gene role | ✅ per-gene |
| heavy-metal substep | `_audit_heavymetal_inline.py` | (substrate placeholders) | small |

## MCP tool 6 — `check`
| step | script | checks |
|---|---|---|
| transporter/TCDB consistency | `_qc_transporter_tcdb.py`, `_qc_transporter_validate.py` | substrate vs TCDB |
| sampling / scoring QC | `_qc_sample.py`, `_qc_score.py` | manual-review sample |
| pathway-edge evidence audit | `_judge_pathway_evidence.py` | experimental vs background |
| *(to add)* manuscript-number check | `check_numbers.py` | prose numbers vs data |

## MCP tool 7 — `build_kg_db`  (Tier B, deterministic)
| step | script | output |
|---|---|---|
| merge functional (abstract+fulltext) | `_merge_abstract_fulltext.py`, `_build_final.py`, `_dedup_*`, `_normalize_species.py` | `extracted_genes_v5_grand_final.csv/parquet` |
| build KG (consensus+arbitrated) | `_kg_merge_combined.py`, `_kg_strict_plus_arbitrated.py`, `_kg_dedup_edges.py`, `_kg_drop_ortholog.py`, `_kg_clean_paralog.py` | `kg_edges/nodes/evidence_strict_plus_arbitrated.parquet` |
| website DB | `salt_gene_db/scripts/build_db.py` | `docs/salt_genes.db` |
| website KG json | `salt_gene_db/scripts/build_kg.py` | `docs/kg/*.json` |
| tables | `_make_table1_grandfinal.py`, `_make_table3.py` | table1_*, table3_* |
| supp tables | `_make_supp_tables_s7.py`, species/records scripts | SuppTable_*.csv |
| figures | `_fig_overview.py`, `_fig7_casestudies.py`, `_fig_litgrowth.py` | figure_*.pdf/png |

## Notes / gaps to resolve before Makefile
1. **esearch entry point missing** — need a small wrapper: keywords → PMID list
   (the csv-*.csv were produced by EDirect esearch; wrap it as step 0).
2. **Global stages** (03_cluster, 05_filter, all `_kg_*` merges, consolidation)
   re-run on the full set — cheap, no LLM.
3. **Per-PMID stages are the expensive ones** and are all resumable already.
4. **Figures hardcode some numbers** (`_fig_overview.py`) — parameterize to read
   from data so they auto-update.
5. **State**: a per-project working dir + a processed-PMID manifest lets `extract`
   run only new papers.
