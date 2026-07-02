# SaltNet build pipeline
# ----------------------------------------------------------------------------
# Tier B (data -> db / graph-json / tables / figures) is deterministic & cheap:
#   `make build`  rebuilds everything downstream of the master data files.
# Tier A (literature -> data) is the LLM extraction pipeline: expensive, per-PMID
#   incremental. Its stages are wired as phony targets that call the real entry
#   scripts / quota-aware loop wrappers.
# Run `make help` for the target list.
# ----------------------------------------------------------------------------

PY   := /home/wangy1j/miniconda3/envs/salt_nlp/bin/python
# esearch/efetch (EDirect 25.3) live in the salt_nlp env bin:
BIN  := /home/wangy1j/miniconda3/envs/salt_nlp/bin
WEB  := ../../final_table/salt_gene_db

# --- master data (the Tier A -> Tier B boundary) ---
GENES_CSV := $(WEB)/docs/data/extracted_genes_v5_grand_final.csv
KG_EDGES  := kg_edges_strict_plus_arbitrated.parquet
KG_NODES  := kg_nodes_strict_plus_arbitrated.parquet
CORPUS    := all_parsed_combined.parquet

.DEFAULT_GOAL := help
.PHONY: help all build tables figures supp db kg check \
        search filter extract arbitrate audit consolidate clean-figs

help:
	@echo "SaltNet pipeline targets:"
	@echo "  --- Tier B: data -> outputs (deterministic, run any time) ---"
	@echo "  make build      db + kg-json + tables + figures (everything downstream of data)"
	@echo "  make db         rebuild website SQLite (salt_genes.db)"
	@echo "  make kg         rebuild per-species knowledge-graph JSON"
	@echo "  make tables     Table 1, Table 3"
	@echo "  make supp       Supplementary Tables S2, S3"
	@echo "  make figures    Figure 1 (overview), Figure 7 (case studies), lit-growth"
	@echo "  make check      verify manuscript numbers against the data"
	@echo "  --- Tier A: literature -> data (LLM, expensive, per-PMID incremental) ---"
	@echo "  make search     esearch -> fetch abstracts -> parse           (00a,00,01)"
	@echo "  make filter     embed -> cluster -> keywords -> topic filter   (02-05,07,09)"
	@echo "  make extract    dual-model abstract/fulltext/KG extraction     (06,13,19 + loops)"
	@echo "  make arbitrate  gene adjudication + KG-edge arbitration        (08,14,20 + loops)"
	@echo "  make audit      per-field Opus audits                          (15-18)"
	@echo "  make consolidate  merge -> grand_final.csv + KG parquet"

# ============================================================================
# Tier B — deterministic rebuild from master data
# ============================================================================
build: db kg tables supp figures

# --- website SQLite (reads the web-copy grand_final CSV) ---
$(WEB)/docs/salt_genes.db: $(GENES_CSV) $(WEB)/scripts/build_db.py
	cd $(WEB) && $(PY) scripts/build_db.py
db: $(WEB)/docs/salt_genes.db

# --- per-species KG JSON (reads pipeline KG csv exports) ---
$(WEB)/docs/kg/index.json: kg_nodes_strict_plus_arbitrated.csv kg_edges_strict_plus_arbitrated.csv $(WEB)/scripts/build_kg.py
	cd $(WEB) && $(PY) scripts/build_kg.py
kg: $(WEB)/docs/kg/index.json

# --- tables ---
table1_dataset_composition.csv: $(GENES_CSV) _make_table1_grandfinal.py
	$(PY) _make_table1_grandfinal.py
table3_kg_relations.csv: $(KG_EDGES) _make_table3.py
	$(PY) _make_table3.py
tables: table1_dataset_composition.csv table3_kg_relations.csv

# --- supplementary tables ---
SuppTable_S2_pathway_evidence_audit.csv SuppTable_S3_casestudy_neighbourhoods.csv: $(KG_EDGES) _make_supp_tables_s7.py
	$(PY) _make_supp_tables_s7.py
supp: SuppTable_S2_pathway_evidence_audit.csv SuppTable_S3_casestudy_neighbourhoods.csv

# --- figures ---
figure_overview.pdf: _fig_overview.py
	$(PY) _fig_overview.py
figure7_casestudies.pdf: $(KG_EDGES) $(KG_NODES) _fig7_casestudies.py
	$(PY) _fig7_casestudies.py
figure_litgrowth.pdf: $(CORPUS) _fig_litgrowth.py
	$(PY) _fig_litgrowth.py
figures: figure_overview.pdf figure7_casestudies.pdf figure_litgrowth.pdf

# --- numbers sanity check (script added separately) ---
check:
	@if [ -f check_numbers.py ]; then $(PY) check_numbers.py; else echo "check_numbers.py not present"; fi

# ============================================================================
# Tier A — literature -> data  (LLM; heavy; per-PMID resumable)
#   These call the real entry scripts / quota-aware loop wrappers. Most stages
#   skip PMIDs whose per-paper output already exists, so they are re-runnable.
#   Args (query, working dirs, models) are set inside the scripts / loop_*.sh.
# ============================================================================
QUERY   ?= -
PMIDS   ?= pmids.txt
MINDATE ?= 1940
MAXDATE ?= 2026

search:                       ## keyword -> PMID -> abstracts -> parquet
	PATH="$(BIN):$$PATH" ./00a_esearch.sh "$(QUERY)" $(PMIDS) $(MINDATE) $(MAXDATE)
	PATH="$(BIN):$$PATH" ./00_fetch_pubmed.sh $(PMIDS) pubmed_expand/downloaded
	$(PY) 01_parse_efetch.py

filter:                       ## embed + cluster + keywords + topic filter
	$(PY) 02_embed.py
	$(PY) 03_cluster.py
	$(PY) 04_keybert.py
	$(PY) 07_cluster_summary.py
	$(PY) 05_filter.py
	$(PY) 09_triage_noise.py

extract:                      ## dual-model extraction (abstract + fulltext + KG)
	bash loop_v5.sh ; bash loop_v5_opus.sh
	$(PY) 10_download_fulltext.py ; $(PY) 11_unpaywall_oa.py ; $(PY) 12_unpaywall_missing.py
	bash loop_fulltext_sonnet.sh ; bash loop_fulltext_opus.sh
	bash loop_kg_sonnet.sh ; bash loop_kg_opus.sh

arbitrate:                    ## gene adjudication + KG-edge arbitration
	bash loop_adj.sh ; bash loop_adjudicate_fulltext.sh
	bash loop_arbitrate_disagree.sh

audit:                        ## per-field Opus audits + apply
	bash loop_audit_transport.sh ; $(PY) _apply_transport_audit.py
	bash loop_audit_funccat.sh   ; $(PY) _apply_funccat_audit.py
	bash loop_audit_species.sh   ; $(PY) _apply_species_audit.py
	bash loop_audit_role.sh      ; $(PY) _apply_role_audit.py
	$(PY) _audit_heavymetal_inline.py

consolidate:                  ## merge per-paper outputs -> master data files
	$(PY) _merge_abstract_fulltext.py
	$(PY) _build_final.py
	$(PY) _normalize_species.py
	$(PY) _kg_merge_combined.py
	$(PY) _kg_strict_plus_arbitrated.py
	$(PY) _kg_dedup_edges.py
	$(PY) _kg_drop_ortholog.py
	$(PY) _kg_clean_paralog.py

# full end-to-end (heavy): Tier A then Tier B
all: search filter extract arbitrate audit consolidate build
