"""SaltNet query core — pure functions over the bundled data files (no MCP dependency).

Reads ../docs/salt_genes.db plus the JSON sidecars (gene_papers, tcdb_families,
uniprot_acc) and the per-species knowledge graph in ../docs/kg/. Used by the MCP
server (saltnet_mcp.py); importable and testable on its own.
"""
import json, os, re, sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(os.path.dirname(HERE), "docs")
DB = os.path.join(DOCS, "salt_genes.db")

_cache = {}


def _json(name):
    if name not in _cache:
        try:
            with open(os.path.join(DOCS, name), encoding="utf-8") as f:
                _cache[name] = json.load(f)
        except Exception:
            _cache[name] = {}
    return _cache[name]


def _db():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def search_genes(query="", species="", functional_category="", transport_substrate="",
                 gene_role="", limit=25):
    """Search salt-tolerance genes by free text and/or facets; return matching rows."""
    clauses, params = [], {}
    if (query or "").strip():
        params["q"] = f"%{query.strip()}%"
        clauses.append("(g.canonical_gene LIKE :q OR g.all_names LIKE :q OR g.species LIKE :q)")
    if (species or "").strip():
        params["sp"] = species.strip()
        clauses.append("g.species = :sp COLLATE NOCASE")
    if (gene_role or "").strip():
        params["r"] = f"%{gene_role.strip()}%"
        clauses.append("g.gene_role LIKE :r")
    if (functional_category or "").strip():
        params["c"] = functional_category.strip()
        clauses.append("EXISTS(SELECT 1 FROM gene_category j WHERE j.gene_id=g.gene_id AND j.category=:c)")
    if (transport_substrate or "").strip():
        params["s"] = transport_substrate.strip()
        clauses.append("EXISTS(SELECT 1 FROM gene_substrate j WHERE j.gene_id=g.gene_id AND j.substrate=:s)")
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    n = max(1, min(int(limit or 25), 200))
    con = _db()
    rows = con.execute(
        f"""SELECT g.gene_id, g.canonical_gene AS gene, g.species, g.gene_role,
                   g.functional_category, g.evidence_strength, g.n_pmids
            FROM genes g {where}
            ORDER BY g.n_pmids DESC, g.canonical_gene LIMIT {n}""", params).fetchall()
    con.close()
    return {"n_results": len(rows), "results": [dict(r) for r in rows]}


def _find_gene(con, gene, species=""):
    if (species or "").strip():
        r = con.execute("SELECT * FROM genes WHERE canonical_gene=? COLLATE NOCASE AND species=? COLLATE NOCASE",
                        (gene, species)).fetchone()
        if r:
            return r
    r = con.execute("SELECT * FROM genes WHERE canonical_gene=? COLLATE NOCASE ORDER BY n_pmids DESC LIMIT 1",
                    (gene,)).fetchone()
    if r:
        return r
    key = "%;" + gene.lower().replace(" ", "") + ";%"
    return con.execute(
        "SELECT * FROM genes WHERE (';'||replace(lower(all_names),' ','')||';') LIKE ? "
        "ORDER BY n_pmids DESC LIMIT 1", (key,)).fetchone()


def get_gene(gene, species=""):
    """Full annotated record for a gene incl. per-paper evidence, TCDB, sequence links."""
    con = _db()
    row = _find_gene(con, gene, species)
    if not row:
        con.close()
        return {"error": f"gene '{gene}' not found"}
    rec = dict(row)
    gid = rec["gene_id"]
    rec["pmids"] = [r["pmid"] for r in con.execute(
        "SELECT pmid FROM gene_pmid WHERE gene_id=? ORDER BY CAST(pmid AS INTEGER)", (gid,))]
    con.close()
    rec["pubmed_urls"] = [f"https://pubmed.ncbi.nlm.nih.gov/{p}/" for p in rec["pmids"]]
    rec["papers"] = _json("gene_papers.json").get(str(gid), [])
    t = _json("tcdb_families.json").get(str(gid))
    if t:
        rec["tcdb"] = {"family": t.get("fam"), "tc_class": t.get("tc"),
                       "expected_substrate": t.get("exp"), "substrate_consistency": t.get("v"),
                       "tcdb_url": f"https://www.tcdb.org/search/result.php?tc={t.get('tc')}"}
    u = _json("uniprot_acc.json").get(str(gid))
    if u and u.get("a"):
        seq = {"uniprot": u["a"], "reviewed": bool(u.get("r")),
               "uniprot_url": f"https://www.uniprot.org/uniprotkb/{u['a']}/entry",
               "fasta_url": f"https://rest.uniprot.org/uniprotkb/{u['a']}.fasta"}
        if u.get("gene"):
            seq["ncbi_gene_url"] = f"https://www.ncbi.nlm.nih.gov/gene/{u['gene']}"
        if u.get("prot"):
            seq["ncbi_protein_url"] = f"https://www.ncbi.nlm.nih.gov/protein/{u['prot']}"
        rec["sequence"] = seq
    return rec


def get_gene_network(gene, species=""):
    """Knowledge-graph neighbourhood of a gene: connected genes/pathways, edges with
    relation/confidence, and the supporting paper evidence (PMID + quoted experiment)."""
    if not (species or "").strip():
        con = _db()
        r = con.execute("SELECT species FROM genes WHERE canonical_gene=? COLLATE NOCASE "
                        "ORDER BY n_pmids DESC LIMIT 1", (gene,)).fetchone()
        con.close()
        species = r["species"] if r else ""
    if not species:
        return {"error": f"could not determine species for '{gene}'; pass species="}
    slug = _slug(species)
    graph = _json(f"kg/{slug}.json")
    if not graph:
        return {"error": f"no knowledge graph available for species '{species}'"}
    nodes, edges = graph["nodes"], graph["edges"]
    gi = next((i for i, n in enumerate(nodes) if n["l"].lower() == gene.lower()), None)
    if gi is None:
        return {"error": f"'{gene}' is not in the {species} knowledge graph", "species": species}
    ev = _json(f"kg/{slug}.ev.json")
    out = []
    for ei, e in enumerate(edges):
        if e["s"] != gi and e["t"] != gi:
            continue
        other = nodes[e["t"] if e["s"] == gi else e["s"]]
        out.append({
            "relation": e["r"],
            "direction": "out" if e["s"] == gi else "in",
            "partner": other["l"],
            "partner_type": "pathway" if other["t"] == "p" else "gene",
            "confidence": e.get("c"),
            "n_model_support": e.get("n"),
            "evidence": [{"pmid": x["p"], "confidence": x["c"], "quote": x["q"],
                          "pubmed_url": f"https://pubmed.ncbi.nlm.nih.gov/{x['p']}/"}
                         for x in ev.get(str(ei), [])],
        })
    return {"gene": nodes[gi]["l"], "species": species,
            "node_type": "pathway" if nodes[gi]["t"] == "p" else "gene",
            "n_edges": len(out), "edges": out}
