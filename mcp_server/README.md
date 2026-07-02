# SaltNet MCP server — setup & usage tutorial

A local [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets
an AI agent (Claude Desktop, Claude Code, Cline, Continue, …) query the **SaltNet** plant
salinity-response gene database directly. It runs on your machine over stdio and reads the
data files bundled in `../docs` — **no network, backend, API key, or external service.**

## The three tools

| Tool | What it returns |
|---|---|
| `search_genes(query?, species?, functional_category?, transport_substrate?, gene_role?, limit?)` | A list of matching genes (gene, species, role, category, evidence strength, # papers). The discovery entry point. |
| `get_gene(gene, species?)` | One gene's full record: all annotations, supporting PMIDs (+ PubMed URLs), **per-paper experimental evidence**, TCDB transporter annotation, and UniProt/NCBI **sequence links**. |
| `get_gene_network(gene, species?)` | The gene's knowledge-graph neighbourhood: connected genes/pathways, each edge's relation + confidence, and the **supporting paper evidence (PMID + quoted experiment)**. |

---

## Step 1 — Prerequisites

- **Python 3.10+** (`python --version`)
- **git**
- An MCP-capable client (Claude Desktop, Claude Code, etc.)

## Step 2 — Get the code

```bash
git clone https://github.com/supermanwasd/saltnet.git
cd saltnet/mcp_server
```

The server reads the data from `../docs` in the same clone, so keep the folder structure
intact. (You can move/run it from anywhere — it locates the data relative to its own file.)

## Step 3 — Create an environment and install

Using a dedicated virtual environment is strongly recommended so the MCP client launches a
Python that definitely has the `mcp` package:

```bash
python -m venv .venv
# macOS / Linux:
source .venv/bin/activate
# Windows (PowerShell):
# .venv\Scripts\Activate.ps1

pip install -r requirements.txt
```

Note the **absolute path to this venv's Python** — you'll paste it into the client config:

```bash
# macOS / Linux:
echo "$(pwd)/.venv/bin/python"
# Windows:
# echo "$(pwd)\.venv\Scripts\python.exe"
```

## Step 4 — Verify the data loads (optional but recommended)

This checks the database is reachable without needing an MCP client:

```bash
python -c "import saltnet_query as q; print(q.get_gene('SOS1','Arabidopsis thaliana')['canonical_gene'], '· papers:', len(q.get_gene('SOS1')['papers']))"
# expected: SOS1 · papers: 64
```

To inspect the live server interactively, use the official MCP Inspector:

```bash
npx @modelcontextprotocol/inspector python saltnet_mcp.py
```

---

## Step 5 — Register the server with your agent

In every case, use the **absolute path** to the venv Python and to `saltnet_mcp.py`.

### A. Claude Code (CLI)

```bash
claude mcp add saltnet -- /ABSOLUTE/PATH/TO/saltnet/mcp_server/.venv/bin/python /ABSOLUTE/PATH/TO/saltnet/mcp_server/saltnet_mcp.py
```

Check it's connected:

```bash
claude mcp list
```

### B. Claude Desktop

Edit the config file (create it if missing):

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "saltnet": {
      "command": "/ABSOLUTE/PATH/TO/saltnet/mcp_server/.venv/bin/python",
      "args": ["/ABSOLUTE/PATH/TO/saltnet/mcp_server/saltnet_mcp.py"]
    }
  }
}
```

On Windows the `command` is the full path to `python.exe`, e.g.
`"C:\\Users\\you\\saltnet\\mcp_server\\.venv\\Scripts\\python.exe"` (use double backslashes).
**Fully quit and reopen Claude Desktop** after editing. SaltNet then appears under the
tools (🔌) menu.

### C. Other MCP clients (Cline, Continue, etc.)

Any stdio MCP client takes the same two pieces — a **command** and **args**:

```
command:  /ABSOLUTE/PATH/TO/saltnet/mcp_server/.venv/bin/python
args:     ["/ABSOLUTE/PATH/TO/saltnet/mcp_server/saltnet_mcp.py"]
```

---

## Step 6 — Use it

Once connected, just ask your agent in natural language — it will pick the right tool:

- *"Use SaltNet to find Na⁺ transporters involved in salt tolerance in wheat."*
  → `search_genes(species="Triticum aestivum", functional_category="Transporter", transport_substrate="Na+")`
- *"What does SaltNet say about SOS1 in Arabidopsis — its evidence and which papers?"*
  → `get_gene("SOS1", "Arabidopsis thaliana")`
- *"Show SOS1's regulatory network and the experiment behind each edge."*
  → `get_gene_network("SOS1", "Arabidopsis thaliana")`
- *"List the strongest-evidence negative regulators of salt tolerance in rice."*
  → `search_genes(species="Oryza sativa", gene_role="Negative")`

---

## Tool reference

### `search_genes`
| Arg | Type | Notes |
|---|---|---|
| `query` | str | free text matched against gene name, aliases, species |
| `species` | str | exact species (e.g. `"Oryza sativa"`) |
| `functional_category` | str | e.g. `"Transporter"`, `"Transcription factor"` |
| `transport_substrate` | str | e.g. `"Na+"`, `"K+"`, `"H+"`, `"Ca2+"`, `"Cl-"` |
| `gene_role` | str | substring, e.g. `"Positive"`, `"Negative"` |
| `limit` | int | default 25, max 200 |

Returns `{ "n_results": N, "results": [ {gene_id, gene, species, gene_role, functional_category, evidence_strength, n_pmids}, … ] }`.

### `get_gene`
`get_gene(gene, species?)` → full record. Key fields: all annotation columns, `pmids` +
`pubmed_urls`, `papers` (per-paper evidence: title, year, journal, genetic background,
stress, method, tissue, phenotype, …), `tcdb` (family, TC class, substrate consistency),
and `sequence` (`uniprot`, `fasta_url`, `ncbi_gene_url`, `ncbi_protein_url`) when a UniProt
entry exists. If `species` is omitted, the best-studied species for that name is returned.

### `get_gene_network`
`get_gene_network(gene, species?)` → `{ gene, species, node_type, n_edges, edges: [ {relation,
direction, partner, partner_type, confidence, n_model_support, evidence: [{pmid, confidence,
quote, pubmed_url}, …]}, … ] }`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Client shows the server "failed" / not connecting | Use **absolute paths** for both the Python and the script. Relative paths and `~` are not expanded by most clients. |
| `ModuleNotFoundError: No module named 'mcp'` | The `command` is not the venv Python. Point `command` at `.../mcp_server/.venv/bin/python`. |
| `database not found` / empty results | The `docs/` data folder must sit next to `mcp_server/` (i.e. keep the cloned repo intact). |
| Claude Desktop doesn't show the tools | Fully **quit and reopen** the app after editing the config; check the JSON is valid. |
| Want to see raw tool I/O | Run `npx @modelcontextprotocol/inspector python saltnet_mcp.py`. |

## Notes

- **Fully offline & read-only:** the server only reads the bundled data; it never writes or
  calls the network. The UniProt/NCBI/PubMed/TCDB items it returns are *links*, not requests.
- **Same data as the website:** `docs/salt_genes.db`, `docs/gene_papers.json`,
  `docs/tcdb_families.json`, `docs/uniprot_acc.json`, and `docs/kg/`.
- **License:** CC BY 4.0 — use freely with attribution (cite SaltNet).
