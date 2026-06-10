"""
app.py
======
FastAPI server for the Reference Viewer prototype.

Endpoints:
  GET  /                -> static single-page frontend
  POST /api/analyze     -> accept one or more PDFs, return per-paper
                           identification + authoritative references +
                           venue composition + a cross-paper citation graph.

Accuracy-first: all reference data comes from authoritative database records
(see reference_core.py). Nothing is fabricated.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

import reference_core as core

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")

app = FastAPI(title="Reference Viewer", version="1.0")


EXAMPLES_DIR = os.path.join(HERE, "examples")


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.post("/api/analyze-examples")
def analyze_examples():
    """Convenience: analyze the PDFs bundled in ./examples (server-side read)."""
    payloads = []
    if os.path.isdir(EXAMPLES_DIR):
        for name in sorted(os.listdir(EXAMPLES_DIR)):
            if name.lower().endswith(".pdf"):
                with open(os.path.join(EXAMPLES_DIR, name), "rb") as fh:
                    payloads.append((name, fh.read()))
    return _analyze_payloads(payloads)


@app.post("/api/analyze")
async def analyze(files: list[UploadFile] = File(...)):
    payloads = []
    for f in files:
        # PDF-only: ignore anything that isn't a .pdf (the frontend enforces
        # this too, but guard the API so non-PDFs can't slip through).
        if not (f.filename or "").lower().endswith(".pdf"):
            continue
        data = await f.read()
        payloads.append((f.filename, data))
    return _analyze_payloads(payloads)


def _analyze_payloads(payloads: list) -> JSONResponse:
    # PDFs are independent -> resolve them concurrently. Each paper makes its
    # own OpenAlex calls; the polite pool handles modest concurrency fine.
    papers = []
    with ThreadPoolExecutor(max_workers=min(5, max(1, len(payloads)))) as ex:
        futures = [ex.submit(_safe_analyze, name, data) for name, data in payloads]
        for fut in futures:
            papers.append(fut.result())

    graph = build_graph(papers)

    return JSONResponse({
        "papers": papers,
        "graph": graph,
    })


def _safe_analyze(name: str, data: bytes) -> dict:
    try:
        return core.analyze_pdf(name, data)
    except Exception as e:  # never let one bad PDF kill the batch
        return {
            "filename": name,
            "error": f"Failed to process: {type(e).__name__}: {e}",
            "identification": {"matched": False, "confidence": None,
                               "note": "Processing error."},
            "references": [],
            "reference_stats": {"requested": 0, "resolved": 0},
            "venue_composition": [],
        }


# --------------------------------------------------------------------------
# Cross-paper citation graph
# --------------------------------------------------------------------------
def build_graph(papers: list) -> dict:
    """
    Nodes:
      - 'paper'      : each uploaded paper (always shown)
      - 'shared_ref' : a cited work referenced by >= 2 uploaded papers
    Edges (directed, citing -> cited):
      - paper -> paper        : direct citation between two uploaded papers
      - paper -> shared_ref   : an uploaded paper cites a shared reference
    """
    nodes, edges = [], []

    # Map OpenAlex id -> uploaded paper index (for direct-citation detection).
    oa_to_idx = {}
    for i, p in enumerate(papers):
        ident = p.get("identification") or {}
        oid = ident.get("openalex_id")
        if oid:
            oa_to_idx[oid] = i

    for i, p in enumerate(papers):
        ident = p.get("identification") or {}
        label = _short_label(p)
        nodes.append({
            "id": f"P{i}",
            "type": "paper",
            "label": label,
            "title": ident.get("title") or p.get("extracted_title") or p.get("filename"),
            "venue": (core.normalize_venue(ident.get("venue")) or "(unidentified)"),
            "year": ident.get("year"),
            "matched": bool(ident.get("matched")),
            "confidence": ident.get("confidence"),
            "ref_count": p.get("reference_stats", {}).get("resolved", 0),
            "color": _paper_node_color(ident),
            "doi": ident.get("doi"),
            "url": _entity_url(ident.get("doi"), ident.get("openalex_id")),
        })

    # Direct citations among uploaded papers.
    for i, p in enumerate(papers):
        ident = p.get("identification") or {}
        for ref_id in ident.get("referenced_work_ids", []):
            j = oa_to_idx.get(ref_id)
            if j is not None and j != i:
                edges.append({"from": f"P{i}", "to": f"P{j}", "kind": "direct"})

    # Shared references: cited by >= 2 uploaded papers.
    ref_index = {}  # openalex_id -> {"ref": refobj, "citers": set(paper idx)}
    for i, p in enumerate(papers):
        for r in p.get("references", []):
            oid = r.get("openalex_id")
            if not oid:
                continue
            entry = ref_index.setdefault(oid, {"ref": r, "citers": set()})
            entry["citers"].add(i)

    shared = {oid: e for oid, e in ref_index.items()
              if len(e["citers"]) >= 2 and oid not in oa_to_idx}

    for oid, e in shared.items():
        r = e["ref"]
        venue = r.get("venue") or "(unknown)"
        nodes.append({
            "id": f"R_{oid}",
            "type": "shared_ref",
            "label": _wrap(r.get("title") or "", 28),
            "title": r.get("title"),
            "venue": venue,
            "year": r.get("year"),
            "shared_by": len(e["citers"]),
            "color": core.color_for_venue(core.normalize_venue(venue), 6),
            "doi": r.get("doi"),
            "authors": r.get("authors") or [],
            "url": _entity_url(r.get("doi"), oid),
            "citers": [{"id": f"P{i}", "label": _citer_label(papers[i])}
                       for i in sorted(e["citers"])],
        })
        for i in e["citers"]:
            edges.append({"from": f"P{i}", "to": f"R_{oid}", "kind": "shared"})

    return {
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "papers": len(papers),
            "direct_citations": sum(1 for e in edges if e["kind"] == "direct"),
            "shared_references": len(shared),
        },
    }


def _entity_url(doi, openalex_id):
    """Best external link for a work: DOI first, then its OpenAlex landing page."""
    if doi:
        return f"https://doi.org/{doi}"
    if openalex_id:
        return f"https://openalex.org/{openalex_id}"
    return None


def _citer_label(p: dict) -> str:
    """Clean single-line name for an uploaded paper (used in shared-ref citer lists)."""
    ident = p.get("identification") or {}
    title = ident.get("title") or p.get("extracted_title") or p.get("filename") or "paper"
    year = ident.get("year")
    short = title if len(title) <= 48 else title[:46].rstrip() + "…"
    return f"{short} ({year})" if year else short


def _short_label(p: dict) -> str:
    ident = p.get("identification") or {}
    title = ident.get("title") or p.get("extracted_title") or p.get("filename")
    year = ident.get("year")
    # Prefer "FirstAuthorSurname (year)" style if we have a clean title.
    base = _wrap(title or "paper", 26)
    if year:
        base += f"\n({year})"
    return base


def _paper_node_color(ident: dict) -> str:
    if not ident.get("matched"):
        return "#6b7280"  # gray: unidentified
    venue = core.normalize_venue(ident.get("venue"))
    if venue in core.PINNED_VENUE_COLORS:
        return core.PINNED_VENUE_COLORS[venue]
    return "#1f2937"  # dark slate for identified papers (distinct from refs)


def _wrap(text: str, width: int) -> str:
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width:
            lines.append(cur)
            cur = w
            if len(lines) >= 3:
                cur += "…"
                break
        else:
            cur = (cur + " " + w).strip()
    if cur and len(lines) < 3:
        lines.append(cur)
    return "\n".join(lines)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
