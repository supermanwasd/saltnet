#!/usr/bin/env python3
"""
Assign each transporter gene to a TCDB family / TC class and write
docs/tcdb_families.json = {gene_id: {fam, tc, exp, v}} for the web viewer.

Family -> TC mapping and expected substrates mirror the TCDB validation in
NAR_supp_TCDB_validation/ (family-level check; no sequences required).
"""
import csv, json, os, re, sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB = os.path.join(ROOT, "docs", "salt_genes.db")
OUT = os.path.join(ROOT, "docs", "tcdb_families.json")

FAMILIES = [
    ("HKT (Na+/K+)",            r"HKT\d|HKT\b|SKC1",               "2.A.38", {"Na+", "K+", "Li+", "Rb+", "Cs+"}),
    ("NHX/SOS1 (Na+/H+, CPA1)", r"NHX\d|NHX\b|SOS1\b|NHE\d|NHA\d", "2.A.36", {"Na+", "H+", "K+", "Li+"}),
    ("KEA/CHX (CPA2)",          r"KEA\d|CHX\d",                    "2.A.37", {"K+", "Na+", "H+"}),
    ("Shaker K+ channel",       r"AKT\d|KAT\d|SKOR|GORK|SPIK|KC1\b|KZM\d", "1.A.1", {"K+", "Rb+", "Cs+"}),
    ("HAK/KUP/KT (K+ uptake)",  r"HAK\d|KUP\d|KUT\d|KT\d\b",       "2.A.72", {"K+", "Rb+", "Cs+", "Na+"}),
    ("TPK/KCO (vac. K+)",       r"TPK\d|KCO\d",                    "1.A.1",  {"K+"}),
    ("CAX (Ca2+/H+)",           r"CAX\d",                          "2.A.19", {"Ca2+", "H+", "Mn2+", "Cd2+"}),
    ("Ca2+-ATPase (ACA/ECA)",   r"ACA\d|ECA\d",                    "3.A.3",  {"Ca2+"}),
    ("H+-ATPase (AHA/PMA/HA)",  r"AHA\d|PMA\d|HA\d\b",             "3.A.3",  {"H+"}),
    ("H+-PPase (AVP/VHP/HVP)",  r"AVP\d?|VHP\d|HVP\d|VP1\b|VPP\d|H\+-PPase|pyrophosphatase", "3.A.10", {"H+"}),
    ("Aquaporin (MIP)",         r"PIP\d|TIP\d|NIP\d|SIP\d|XIP\d|AQP|aquaporin", "1.A.8", {"Water (aquaporin)", "Glycerol", "As3+", "Other"}),
    ("ALMT (malate/anion)",     r"ALMT\d",                         "2.A.85", {"Cl-", "Other"}),
    ("SLAC/SLAH (anion)",       r"SLAC\d|SLAH\d",                  "1.A.17", {"Cl-", "NO3-", "Other"}),
    ("NRT/NPF (NO3-)",          r"NRT\d|NPF\d|NAR\d|NRT2",         "2.A.1",  {"NO3-", "Cl-", "Other"}),
    ("AMT (NH4+)",              r"AMT\d|AMT1|AMT2",                "1.A.11", {"NH4+"}),
    ("SULTR (SO4-)",            r"SULTR\d|SULT\d|SHST\d",          "2.A.53", {"SO4-"}),
    ("ZIP/IRT (metal)",         r"ZIP\d|IRT\d|ZTP\d?|ZRT\d",       "2.A.5",  {"Zn2+", "Fe2+", "Mn2+", "Cd2+", "Cu2+"}),
    ("HMA (heavy-metal ATPase)",r"HMA\d",                          "3.A.3",  {"Cu+", "Cu2+", "Zn2+", "Cd2+", "Other"}),
    ("NRAMP (metal)",           r"NRAMP\d|NRAT\d|MTP\d",           "2.A.55", {"Mn2+", "Fe2+", "Cd2+", "Zn2+"}),
    ("SWEET/STP/SUC (sugar)",   r"SWEET\d|STP\d|SUC\d|SUT\d|TMT\d|ERD6|TST\d|VGT\d", "2.A.123", {"Sugar"}),
    ("PHT (PO4-)",              r"PHT\d|PHO\d|PT\d\b|PHF\d",       "2.A.1",  {"PO4-"}),
    ("MGT/MRS2 (Mg2+)",         r"MGT\d|MRS2|MGE\d",               "1.A.35", {"Mg2+"}),
    ("ABC transporter",         r"ABC[A-G]\d|PDR\d|MDR\d|ALS\d|STAR1", "3.A.1", {"Other"}),
    ("MATE/DTX (efflux)",       r"MATE\d|DTX\d|FRD\d",             "2.A.66", {"Cl-", "Other"}),
    ("CNGC (cation channel)",   r"CNGC\d",                         "1.A.1",  {"K+", "Na+", "Ca2+", "Other"}),
    ("GLR (glutamate-R)",       r"GLR\d",                          "1.A.10", {"Ca2+", "Na+", "K+", "Other"}),
    ("OSCA/ANN/MSL (Ca2+/mech)",r"OSCA\d|ANN\d|ANNAT\d|MSL\d|MCA\d|TPC\d", "1.A.17", {"Ca2+", "Cl-", "Other"}),
]
SKIP = {"Not applicable", "Other", ""}


def classify(name, aliases):
    hay = (name or "") + " ; " + (aliases or "")
    for label, rx, tc, exp in FAMILIES:
        if re.search(rx, hay, re.I):
            return label, tc, exp
    return None


def main():
    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT gene_id, canonical_gene, all_names, transport_substrate "
        "FROM genes WHERE functional_category LIKE '%Transporter%'").fetchall()
    out = {}
    n_consistent = 0
    for gid, gene, names, subs in rows:
        fam = classify(gene, names)
        if not fam:
            continue
        label, tc, exp = fam
        annot = {s.strip() for s in (subs or "").split(";") if s.strip() and s.strip() not in SKIP}
        if not annot:
            v = "family"          # family known, no substrate to check
        elif annot & exp:
            v = "consistent"; n_consistent += 1
        else:
            v = "mismatch"
        out[str(gid)] = {"fam": label, "tc": tc, "exp": "/".join(sorted(exp)), "v": v}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {OUT}: {len(out)} transporter genes annotated, {n_consistent} substrate-consistent")


if __name__ == "__main__":
    main()
