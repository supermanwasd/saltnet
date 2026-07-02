# SaltNet pipeline MCP server

Exposes the literature → knowledge-base pipeline as agent-callable tools, one per
stage, wrapping the `Makefile`. Turns "build a SaltNet-style resource for your own
topic" into a conversation: an agent (or you) drives search → filter → extract →
arbitrate → audit → check → build with your own keywords and chosen models.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `search_abstracts(query, mindate, maxdate)` | async job | PubMed search by your keywords → download abstracts → parse |
| `filter_corpus()` | async job | SPECTER2 embed + HDBSCAN cluster + KeyBERT + topic filter |
| `extract(model_a, model_b, confirm)` | async job | dual-model extraction (genes, annotations, KG triples); `confirm=False` returns a cost estimate |
| `arbitrate(model, confirm)` | async job | adjudicate disagreements + arbitrate single-model KG edges on full text |
| `audit()` | async job | per-field Opus audits (substrate, category, species, role) |
| `check()` | sync | recompute canonical numbers + scan manuscript for stale numbers |
| `build_kg_db(target)` | sync | rebuild db + KG json + tables + figures from the master data |
| `get_job(job_id)` / `list_jobs()` / `stop_job(job_id)` | sync | manage background jobs |

Heavy LLM stages run as **background jobs** (return `job_id`; poll with `get_job`),
so the tool call never blocks for hours. Light stages run synchronously.

## Requirements
- Python 3.10+ with `mcp` (present in the `salt_nlp` conda env)
- NCBI EDirect on PATH (present: `salt_nlp/bin`, v25.3)
- Claude Code CLI authenticated/quota available for the LLM stages
- `make` (the server wraps the pipeline Makefile)

## Run
```
/home/wangy1j/miniconda3/envs/salt_nlp/bin/python pipeline_mcp.py
```

## Register with an MCP client (stdio)
Example `mcpServers` entry:
```json
{
  "mcpServers": {
    "saltnet-pipeline": {
      "command": "/home/wangy1j/miniconda3/envs/salt_nlp/bin/python",
      "args": ["/home/wangy1j/script_result/jupyter/AI_paper/all_keys_abstract/pipeline/mcp_pipeline/pipeline_mcp.py"]
    }
  }
}
```

## Typical agent flow
1. `search_abstracts(query='("cold stress"[TIAB]) AND plants[MeSH]', mindate='2000')`
2. `get_job(...)` until completed
3. `filter_corpus()` → poll
4. `extract(model_a='sonnet', model_b='opus', confirm=False)` → review cost → `confirm=True`
5. `arbitrate(confirm=True)` → `audit()` → poll
6. `build_kg_db('build')` then `check()`

Note: this is separate from the **query** MCP server
(`final_table/saltnet/mcp_server/saltnet_mcp.py`), which serves the finished
database (search_genes/get_gene/get_gene_network). This one *builds* the resource.
