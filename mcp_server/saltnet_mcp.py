#!/usr/bin/env python3
"""SaltNet MCP server (stdio).

Exposes three tools so an AI agent can query the SaltNet plant salinity-response gene
database: search_genes, get_gene, get_gene_network. Backed by the data files bundled
in ../docs (no network or external service required).

Run:  python saltnet_mcp.py     (requires: pip install mcp)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import saltnet_query as q
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("saltnet")


@mcp.tool()
def search_genes(query: str = "", species: str = "", functional_category: str = "",
                 transport_substrate: str = "", gene_role: str = "", limit: int = 25) -> dict:
    """Find plant salinity-response genes in SaltNet.

    Args:
        query: free text matched against gene name, aliases, or species (e.g. "SOS1", "HKT").
        species: restrict to one species (exact, e.g. "Triticum aestivum").
        functional_category: e.g. "Transporter", "Transcription factor", "Protein kinase".
        transport_substrate: e.g. "Na+", "K+", "H+", "Ca2+", "Cl-".
        gene_role: substring of the inferred role, e.g. "Positive", "Negative".
        limit: max rows (default 25, max 200).

    Returns a list of matches with gene_id, gene, species, role, category, evidence
    strength, and number of supporting papers. Use get_gene for the full record.
    """
    return q.search_genes(query, species, functional_category, transport_substrate, gene_role, limit)


@mcp.tool()
def get_gene(gene: str, species: str = "") -> dict:
    """Full SaltNet record for one gene.

    Args:
        gene: gene name or alias (e.g. "SOS1", "OsHKT1;5").
        species: optional; if omitted the best-studied species for that name is used.

    Returns all annotations plus supporting PMIDs (with PubMed URLs), per-paper
    experimental evidence (each paper's genetic background, stress, method, tissue,
    phenotype...), the TCDB transporter annotation, and UniProt/NCBI sequence links.
    """
    return q.get_gene(gene, species)


@mcp.tool()
def get_gene_network(gene: str, species: str = "") -> dict:
    """Knowledge-graph neighbourhood of a gene.

    Args:
        gene: gene name (e.g. "SOS1").
        species: optional; inferred from the gene if omitted.

    Returns the genes and pathways directly connected to the gene, each edge's
    relation (e.g. positively_regulates, member_of, interacts_with), confidence, and
    the supporting paper evidence (PMID + the quoted experiment that established it).
    """
    return q.get_gene_network(gene, species)


if __name__ == "__main__":
    mcp.run()
