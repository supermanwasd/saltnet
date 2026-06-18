# SaltNet MCP server

A local [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
AI agent query SaltNet directly. It runs over stdio and reads the data files bundled
in `../docs` — no network, backend, or external service required.

## Tools

| Tool | What it does |
|---|---|
| `search_genes(query?, species?, functional_category?, transport_substrate?, gene_role?, limit?)` | Find genes by free text and/or facets. Returns matches (gene, species, role, category, evidence, #papers). |
| `get_gene(gene, species?)` | Full record for one gene: all annotations, supporting PMIDs, **per-paper experimental evidence**, TCDB transporter annotation, and UniProt/NCBI sequence links. |
| `get_gene_network(gene, species?)` | The gene's knowledge-graph neighbourhood: connected genes/pathways, each edge's relation + confidence, and the **supporting paper evidence (PMID + quoted experiment)**. |

## Install

```bash
git clone https://github.com/supermanwasd/saltnet.git
cd saltnet/mcp_server
pip install -r requirements.txt        # installs the `mcp` package
```

## Register with an agent

**Claude Code:**
```bash
claude mcp add saltnet -- python /ABSOLUTE/PATH/TO/saltnet/mcp_server/saltnet_mcp.py
```

**Claude Desktop** — add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "saltnet": {
      "command": "python",
      "args": ["/ABSOLUTE/PATH/TO/saltnet/mcp_server/saltnet_mcp.py"]
    }
  }
}
```

(Use the absolute path; the server locates the data via its own location, so it can be
launched from anywhere.)

## Example agent prompts

- "Use SaltNet to find Na⁺ transporters involved in salt tolerance in wheat."
- "What does SaltNet say about SOS1 in Arabidopsis — evidence and which papers?"
- "Show SOS1's regulatory network and the experiment behind each edge."

## Data provenance

The server queries the same bundled data as the website: `docs/salt_genes.db`,
`docs/gene_papers.json`, `docs/tcdb_families.json`, `docs/uniprot_acc.json`, and the
per-species knowledge graph in `docs/kg/`.
