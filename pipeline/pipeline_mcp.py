#!/usr/bin/env python
"""SaltNet pipeline MCP server (stdio).

Exposes the literature -> knowledge-base pipeline as agent-callable tools, one per
stage, wrapping the Makefile. Heavy LLM stages run as background jobs (return a
job_id; poll with get_job); light stages run synchronously.

Run:  python pipeline_mcp.py        (requires: pip install mcp ; EDirect on PATH)
Registered with an MCP client via stdio transport.
"""
import json
import os
import shlex
import signal
import subprocess
import time
from pathlib import Path

from mcp.server.fastmcp import FastMCP

PIPE = Path(__file__).resolve().parent.parent          # the pipeline/ dir
JOBS = PIPE / ".mcp_jobs"
JOBS.mkdir(exist_ok=True)
PY = "/home/wangy1j/miniconda3/envs/salt_nlp/bin/python"
BIN = "/home/wangy1j/miniconda3/envs/salt_nlp/bin"     # esearch/efetch (EDirect)

mcp = FastMCP("saltnet-pipeline")


# --------------------------------------------------------------------------- #
# background-job helpers
# --------------------------------------------------------------------------- #
def _new_job_id(label: str) -> str:
    n = len(list(JOBS.glob("*"))) + 1
    return f"{n:04d}_{label}"


def _launch(make_args: list, label: str, env_extra: dict | None = None) -> dict:
    """Start `make <make_args>` in the pipeline dir as a detached background job."""
    jid = _new_job_id(label)
    jd = JOBS / jid
    jd.mkdir(parents=True, exist_ok=True)
    log = jd / "log.txt"
    env = os.environ.copy()
    env["PATH"] = f"{BIN}:{env.get('PATH','')}"
    if env_extra:
        env.update({k: str(v) for k, v in env_extra.items()})
    # wrap so we record the exit code when the make target finishes
    cmd = f"make {' '.join(shlex.quote(a) for a in make_args)}; echo $? > {shlex.quote(str(jd/'exit.code'))}"
    with open(log, "wb") as fh:
        p = subprocess.Popen(["bash", "-lc", cmd], cwd=str(PIPE), stdout=fh,
                             stderr=subprocess.STDOUT, env=env, start_new_session=True)
    (jd / "meta.json").write_text(json.dumps(
        {"job_id": jid, "label": label, "make": make_args, "pid": p.pid}))
    return {"job_id": jid, "status": "running", "pid": p.pid,
            "hint": f"poll with get_job('{jid}')"}


def _status(jid: str) -> dict:
    jd = JOBS / jid
    if not jd.exists():
        return {"job_id": jid, "status": "unknown"}
    meta = json.loads((jd / "meta.json").read_text()) if (jd / "meta.json").exists() else {}
    exit_file = jd / "exit.code"
    log = (jd / "log.txt")
    tail = ""
    if log.exists():
        tail = "\n".join(log.read_text(errors="ignore").splitlines()[-25:])
    if exit_file.exists():
        code = exit_file.read_text().strip()
        status = "completed" if code == "0" else f"failed (exit {code})"
    else:
        pid = meta.get("pid")
        alive = pid and Path(f"/proc/{pid}").exists()
        status = "running" if alive else "stopped (no exit code)"
    return {"job_id": jid, "status": status, "label": meta.get("label"), "log_tail": tail}


def _run_sync(make_args: list, env_extra: dict | None = None) -> dict:
    env = os.environ.copy()
    env["PATH"] = f"{BIN}:{env.get('PATH','')}"
    if env_extra:
        env.update({k: str(v) for k, v in env_extra.items()})
    r = subprocess.run(["make", *make_args], cwd=str(PIPE), env=env,
                       capture_output=True, text=True, timeout=1800)
    return {"exit": r.returncode,
            "stdout": r.stdout[-4000:], "stderr": r.stderr[-2000:]}


# --------------------------------------------------------------------------- #
# 1. search_abstracts
# --------------------------------------------------------------------------- #
@mcp.tool()
def search_abstracts(query: str = "-", mindate: str = "1940", maxdate: str = "2026",
                     pmids_file: str = "pmids.txt") -> dict:
    """Search PubMed by your own keywords/query and download the matching abstracts.

    query    : PubMed Boolean query ([TIAB]/[MeSH] allowed). "-" = built-in SaltNet
               salt-stress query.
    mindate/maxdate : publication-year range.
    Runs esearch -> fetch -> parse (background job; poll with get_job).
    """
    return _launch(["search", f"QUERY={query}", f"MINDATE={mindate}",
                    f"MAXDATE={maxdate}", f"PMIDS={pmids_file}"], "search")


# --------------------------------------------------------------------------- #
# 2. filter_corpus
# --------------------------------------------------------------------------- #
@mcp.tool()
def filter_corpus() -> dict:
    """Embed (SPECTER2), cluster (UMAP+HDBSCAN), extract keywords (KeyBERT) and
    keep only on-topic abstracts. Background job; poll with get_job."""
    return _launch(["filter"], "filter")


# --------------------------------------------------------------------------- #
# 3. extract  (two user-chosen models)
# --------------------------------------------------------------------------- #
@mcp.tool()
def extract(model_a: str = "sonnet", model_b: str = "opus",
            confirm: bool = False) -> dict:
    """Extract genes, annotations and knowledge-graph triples from each paper with
    two independent LLMs (model_a, model_b), each citing PMID + verbatim evidence.

    Expensive (LLM calls over the whole retained corpus). Call once with
    confirm=False to get a cost/scale estimate, then confirm=True to launch.
    Background job; poll with get_job.
    """
    # cost estimate: extraction runs on the ON-TOPIC subset (~40% of corpus after
    # filtering), not the full corpus. Use the retained set if present, else ~40%.
    try:
        import pandas as pd
        corpus = len(pd.read_parquet(PIPE / "all_parsed_combined.parquet"))
    except Exception:
        corpus = None
    retained = None
    for cand in ("retained_pmids.txt", "retained_abstracts.parquet"):
        f = PIPE / cand
        if f.exists():
            retained = sum(1 for _ in open(f)) if f.suffix == ".txt" else len(pd.read_parquet(f))
            break
    n_extract = retained if retained else (round(corpus * 0.40) if corpus else None)
    # ~$0.006/paper (sonnet-class) + $0.012/paper (opus-class), per model pass
    est = round(n_extract * (0.006 + 0.012)) if n_extract else None
    if not confirm:
        return {"action": "estimate_only",
                "corpus_abstracts": corpus,
                "papers_to_extract": n_extract,
                "papers_basis": "retained set" if retained else "~40% of corpus (post-filter estimate)",
                "models": [model_a, model_b],
                "rough_cost_usd": est,
                "note": "re-call with confirm=True to launch; cost is a rough upper bound"}
    return _launch(["extract"], "extract",
                   env_extra={"MODEL_A": model_a, "MODEL_B": model_b})


# --------------------------------------------------------------------------- #
# 4. arbitrate
# --------------------------------------------------------------------------- #
@mcp.tool()
def arbitrate(model: str = "opus", confirm: bool = False) -> dict:
    """Adjudicate single-model disagreements and arbitrate single-model KG edges
    against the cited full text (no-prior-knowledge rule). LLM; background job.
    Call with confirm=True to launch."""
    if not confirm:
        return {"action": "estimate_only", "model": model,
                "note": "arbitrates only disagreement edges; re-call confirm=True to launch"}
    return _launch(["arbitrate"], "arbitrate", env_extra={"ARB_MODEL": model})


# --------------------------------------------------------------------------- #
# 5. audit
# --------------------------------------------------------------------------- #
@mcp.tool()
def audit() -> dict:
    """Run per-field Opus audits (transport substrate, functional category,
    species, inferred role) against the cited evidence. Background job."""
    return _launch(["audit"], "audit")


# --------------------------------------------------------------------------- #
# 6. check
# --------------------------------------------------------------------------- #
@mcp.tool()
def check() -> dict:
    """Recompute the canonical numbers from the data and scan the manuscript for
    stale/superseded numbers. Fast; runs synchronously."""
    return _run_sync(["check"])


# --------------------------------------------------------------------------- #
# 7. build_kg_db
# --------------------------------------------------------------------------- #
@mcp.tool()
def build_kg_db(target: str = "build") -> dict:
    """Rebuild the deterministic outputs from the master data: knowledge graph +
    database + tables + figures. target ∈ {build, db, kg, tables, supp, figures}.
    Fast; runs synchronously."""
    if target not in {"build", "db", "kg", "tables", "supp", "figures"}:
        return {"error": f"unknown target '{target}'"}
    return _run_sync([target])


# --------------------------------------------------------------------------- #
# job management
# --------------------------------------------------------------------------- #
@mcp.tool()
def get_job(job_id: str) -> dict:
    """Poll a background job's status and see the tail of its log."""
    return _status(job_id)


@mcp.tool()
def list_jobs() -> dict:
    """List all pipeline jobs and their current status."""
    return {"jobs": [_status(p.name) for p in sorted(JOBS.glob("*")) if p.is_dir()]}


@mcp.tool()
def stop_job(job_id: str) -> dict:
    """Stop a running background job."""
    jd = JOBS / job_id
    if not jd.exists():
        return {"job_id": job_id, "status": "unknown"}
    meta = json.loads((jd / "meta.json").read_text())
    try:
        os.killpg(os.getpgid(meta["pid"]), signal.SIGTERM)
        return {"job_id": job_id, "status": "terminating"}
    except Exception as e:
        return {"job_id": job_id, "status": f"could not stop: {e}"}


if __name__ == "__main__":
    mcp.run()
