#!/usr/bin/env python3
"""
Build per-species knowledge-graph JSON for the web viewer.

Input : the strict+arbitrated KG (nodes + edges CSV) from the pipeline.
Output: docs/kg/index.json           — list of species with counts
        docs/kg/<slug>.json          — one positioned subgraph per species

Per-species subgraph = that species' Gene nodes + the Pathway nodes they touch,
plus edges whose head is one of those genes and whose tail is either the same
species' gene or a pathway. Node coordinates are pre-computed (networkx spring
layout) so the browser only has to draw, never lay out.
"""
import csv, json, os, re, sys, time
import networkx as nx

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PIPE = "/home/wangy1j/script_result/jupyter/AI_paper/all_keys_abstract/pipeline"
NODES_CSV = os.path.join(PIPE, "kg_nodes_strict_plus_arbitrated.csv")
EDGES_CSV = os.path.join(PIPE, "kg_edges_strict_plus_arbitrated.csv")
EVID_CSV = os.path.join(PIPE, "kg_edge_evidence_strict_plus_arbitrated.csv")
OUT = os.path.join(ROOT, "docs", "kg")

MIN_NODES = 3          # skip species with a trivial graph
MAX_EV = 6             # evidence quotes kept per edge
csv.field_size_limit(1 << 24)
CONF_RANK = {"high": 0, "medium": 1, "low": 2, "": 3}


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def dedupe_ev(raw):
    """raw: list of (pmid, confidence, evidence). Keep one (best) quote per PMID."""
    by = {}
    for pmid, conf, ev in raw:
        ev = (ev or "").strip()
        if not ev:
            continue
        score = (CONF_RANK.get(conf, 3), -len(ev))
        cur = by.get(pmid)
        if cur is None or score < cur[0]:
            by[pmid] = (score, conf, ev[:500])
    items = sorted(by.items(), key=lambda kv: kv[1][0])
    return [{"p": str(p), "c": v[1], "q": v[2]} for p, v in items[:MAX_EV]]


def main():
    os.makedirs(OUT, exist_ok=True)

    # ---- load nodes ----
    node_species, node_type, node_label, node_papers = {}, {}, {}, {}
    with open(NODES_CSV, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            nid = r["node_id"]
            node_species[nid] = r["species"] or None
            node_type[nid] = r["node_type"]
            node_label[nid] = r["canonical"]
            try: node_papers[nid] = int(float(r["n_papers"] or 0))
            except ValueError: node_papers[nid] = 0

    genes_by_species = {}
    for nid, ty in node_type.items():
        if ty == "Gene" and node_species.get(nid):
            genes_by_species.setdefault(node_species[nid], set()).add(nid)

    # ---- load per-edge evidence: (head, relation, tail) -> [(pmid, conf, quote)] ----
    ev_raw = {}
    if os.path.exists(EVID_CSV):
        with open(EVID_CSV, newline="", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                ev_raw.setdefault((r["head_id"], r["relation"], r["tail_id"]), []).append(
                    (r.get("pmid", ""), r.get("confidence", ""), r.get("evidence", "")))

    # ---- load edges, bucket by species of the head gene ----
    edges_by_species = {}
    with open(EDGES_CSV, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            h, t = r["head_id"], r["tail_id"]
            sp = node_species.get(h)
            if not sp or node_type.get(h) != "Gene":
                continue
            # keep within-species gene-gene OR gene->pathway
            if node_type.get(t) == "Pathway" or node_species.get(t) == sp:
                edges_by_species.setdefault(sp, []).append((
                    h, t, r["relation"],
                    r.get("confidence_consensus") or "",
                    int(float(r.get("n_supports_total") or 0)),
                ))

    index = []
    t0 = time.time()
    for sp, genes in sorted(genes_by_species.items(), key=lambda kv: -len(kv[1])):
        edges = edges_by_species.get(sp, [])
        # keep ONLY nodes that participate in at least one edge (drop isolated genes)
        used = set()
        for h, t, *_ in edges:
            used.add(h); used.add(t)
        nodes = sorted(n for n in used if n in node_type)
        if len(nodes) < MIN_NODES:
            continue

        idx = {n: i for i, n in enumerate(nodes)}
        G = nx.Graph()
        G.add_nodes_from(range(len(nodes)))
        for h, t, *_ in edges:
            if h in idx and t in idx:
                G.add_edge(idx[h], idx[t])

        n = len(nodes)
        iters = 60 if n < 150 else (40 if n < 600 else 25)
        pos = nx.spring_layout(G, seed=1, k=1.0 / (n ** 0.5) * 2.2, iterations=iters)
        xs = [p[0] for p in pos.values()]; ys = [p[1] for p in pos.values()]
        minx, maxx = min(xs), max(xs); miny, maxy = min(ys), max(ys)
        sx = 1600 / (maxx - minx or 1); sy = 1600 / (maxy - miny or 1)

        out_nodes = []
        for n_id in nodes:
            i = idx[n_id]
            x = round((pos[i][0] - minx) * sx, 1)
            y = round((pos[i][1] - miny) * sy, 1)
            out_nodes.append({
                "l": node_label[n_id],
                "t": "p" if node_type.get(n_id) == "Pathway" else "g",
                "p": node_papers.get(n_id, 0),
                "x": x, "y": y,
            })
        out_edges, species_ev = [], {}
        for h, t, rel, conf, sup in edges:
            if h not in idx or t not in idx:
                continue
            i = len(out_edges)
            e = {"s": idx[h], "t": idx[t], "r": rel, "c": conf, "n": sup}
            evlist = dedupe_ev(ev_raw.get((h, rel, t), []))
            if evlist:
                e["e"] = len(evlist)
                species_ev[str(i)] = evlist
            out_edges.append(e)

        n_path = sum(1 for nd in out_nodes if nd["t"] == "p")
        with open(os.path.join(OUT, slug(sp) + ".json"), "w", encoding="utf-8") as f:
            json.dump({"species": sp, "nodes": out_nodes, "edges": out_edges},
                      f, ensure_ascii=False, separators=(",", ":"))
        if species_ev:
            with open(os.path.join(OUT, slug(sp) + ".ev.json"), "w", encoding="utf-8") as f:
                json.dump(species_ev, f, ensure_ascii=False, separators=(",", ":"))
        index.append({"species": sp, "slug": slug(sp),
                      "genes": len(nodes) - n_path, "pathways": n_path,
                      "edges": len(out_edges)})

    index.sort(key=lambda d: -d["genes"])
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)

    print(f"wrote {len(index)} species graphs to {OUT} in {time.time()-t0:.1f}s")
    print("largest:", ", ".join(f"{d['species']}({d['genes']}g/{d['edges']}e)" for d in index[:5]))


if __name__ == "__main__":
    main()
