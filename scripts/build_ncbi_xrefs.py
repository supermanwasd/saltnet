#!/usr/bin/env python3
"""
Enrich docs/uniprot_acc.json with verified NCBI cross-references so the website can
offer direct NCBI Protein / NCBI Gene links (only where they really exist).

For each resolved UniProt accession, fetch its cross-references and add:
  "gene"  -> NCBI GeneID   (NCBI Gene link)
  "prot"  -> RefSeq protein (NCBI Protein link)

Resumable: records that already carry gene/prot, or were already attempted, are skipped.
Run after build_uniprot_links.py.
"""
import json, os, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ACC = os.path.join(ROOT, "docs", "uniprot_acc.json")


def fetch_xrefs(acc):
    url = f"https://rest.uniprot.org/uniprotkb/{acc}.json?fields=xref_geneid,xref_refseq"
    try:
        with urllib.request.urlopen(url, timeout=25) as r:
            data = json.load(r)
    except Exception:
        return None, None
    geneid = refseq = None
    for x in data.get("uniProtKBCrossReferences", []):
        db, val = x.get("database"), x.get("id")
        if db == "GeneID" and geneid is None:
            geneid = val.rstrip(";")
        elif db == "RefSeq" and refseq is None:
            refseq = val.rstrip(";")
    return geneid, refseq


def main():
    acc = json.load(open(ACC))
    todo = [g for g, v in acc.items() if "x" not in v]   # 'x' marks attempted
    print(f"{len(acc)} accessions, {len(todo)} to enrich", flush=True)
    for i, gid in enumerate(todo, 1):
        a = acc[gid]["a"]
        geneid, refseq = fetch_xrefs(a)
        if geneid: acc[gid]["gene"] = geneid
        if refseq: acc[gid]["prot"] = refseq
        acc[gid]["x"] = 1
        time.sleep(0.1)
        if i % 200 == 0:
            json.dump(acc, open(ACC, "w"), separators=(",", ":"))
            print(f"  {i}/{len(todo)} enriched", flush=True)
    # drop the internal 'x' flag before final write
    for v in acc.values():
        v.pop("x", None)
    json.dump(acc, open(ACC, "w"), separators=(",", ":"))
    ng = sum(1 for v in acc.values() if v.get("gene"))
    npr = sum(1 for v in acc.values() if v.get("prot"))
    print(f"DONE: {ng} with NCBI GeneID, {npr} with RefSeq protein", flush=True)


if __name__ == "__main__":
    main()
