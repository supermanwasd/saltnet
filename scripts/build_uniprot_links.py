#!/usr/bin/env python3
"""
Resolve each gene to a UniProt accession (so the website can link directly to a
real sequence). Writes docs/uniprot_acc.json = {gene_id: {"a": accession, "r": 0|1}}.

Strategy per gene (stop at first hit), preferring reviewed (Swiss-Prot), then the
longest entry: AGI locus id (if present) -> species-prefix-stripped symbol ->
canonical name. Resumable: re-running skips gene_ids already resolved/attempted.
"""
import json, os, re, sqlite3, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB = os.path.join(ROOT, "docs", "salt_genes.db")
OUT = os.path.join(ROOT, "docs", "uniprot_acc.json")
DONE = os.path.join(ROOT, "docs", ".uniprot_done.json")   # gene_ids attempted (hit or miss)

PREFIX = re.compile(r"^(At|Os|Ta|Td|Tt|Gh|Gb|Gm|Gs|Sl|Sp|Zm|Hv|Hb|Bn|Bp|Cc|Cm|Cq|Cd|Cr|Es|Ht|Lp|Mc|Me|Vv|Nt|Ph|Pp|Ca|Ld|Ah|Pt|Md|St)([A-Z].*)$")
AGI = re.compile(r"\b(at[1-5]g\d{5})\b", re.I)


def candidates(canon, names):
    out = []
    m = AGI.search(names or "")
    if m:
        out.append(m.group(1))
    c = (canon or "").strip()
    pm = PREFIX.match(c)
    if pm:
        out.append(pm.group(2))
    out.append(c)
    seen, uniq = set(), []
    for s in out:
        k = s.lower()
        if s and k not in seen:
            seen.add(k); uniq.append(s)
    return uniq[:3]


def query(sym, sp):
    q = f'(gene:{sym}) AND (organism_name:"{sp}")'
    url = "https://rest.uniprot.org/uniprotkb/search?" + urllib.parse.urlencode(
        {"query": q, "format": "json", "size": "5", "fields": "accession,reviewed,length"})
    try:
        with urllib.request.urlopen(url, timeout=25) as r:
            res = json.load(r).get("results", [])
    except Exception:
        return None
    if not res:
        return None
    res.sort(key=lambda e: (0 if e.get("entryType", "").startswith("UniProtKB reviewed") else 1,
                            -int(e.get("sequence", {}).get("length", 0) or 0)))
    e = res[0]
    return e["primaryAccession"], 1 if e.get("entryType", "").startswith("UniProtKB reviewed") else 0


def load(path, default):
    if os.path.exists(path):
        try: return json.load(open(path))
        except Exception: pass
    return default


def main():
    acc = load(OUT, {})
    done = set(load(DONE, []))
    con = sqlite3.connect(DB)
    rows = con.execute("SELECT gene_id, canonical_gene, species, all_names FROM genes WHERE species IS NOT NULL").fetchall()
    todo = [r for r in rows if str(r[0]) not in done]
    print(f"total {len(rows)} genes, {len(todo)} to do, {len(acc)} already resolved", flush=True)

    for i, (gid, canon, sp, names) in enumerate(todo, 1):
        for sym in candidates(canon, names):
            res = query(sym, sp)
            time.sleep(0.1)
            if res:
                acc[str(gid)] = {"a": res[0], "r": res[1]}
                break
        done.add(str(gid))
        if i % 200 == 0:
            json.dump(acc, open(OUT, "w"), separators=(",", ":"))
            json.dump(sorted(done), open(DONE, "w"))
            print(f"  {i}/{len(todo)} processed, {len(acc)} with UniProt accession", flush=True)

    json.dump(acc, open(OUT, "w"), separators=(",", ":"))
    json.dump(sorted(done), open(DONE, "w"))
    print(f"DONE: {len(acc)}/{len(rows)} genes have a UniProt accession ({100*len(acc)//len(rows)}%)", flush=True)


if __name__ == "__main__":
    main()
