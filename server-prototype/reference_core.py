"""
reference_core.py
=================
Accuracy-first reference extraction for scientific PDFs.

Design principle (from CLAUDE.md): NO hallucination, NO fabrication.
We never invent reference metadata. Instead we:

  1. Identify the *uploaded* paper itself from the PDF (DOI, then verified
     title match) against authoritative scholarly databases.
  2. Pull that paper's reference list straight from the database
     (OpenAlex `referenced_works`), which is an *authoritative*, already-
     resolved list of cited works -- not something we parse heuristically.
  3. Batch-resolve each reference to real metadata (title/venue/year/authors).

If we cannot confidently identify a paper, or a reference does not resolve to
a real record, we say so and drop it rather than guess.

Primary source: OpenAlex (reliable, polite pool, authoritative referenced_works).
Identity fallback: Crossref -> DOI -> OpenAlex.
"""

from __future__ import annotations

import io
import re
import time
import os
from difflib import SequenceMatcher
from typing import Optional

import requests

try:
    import fitz  # PyMuPDF
except Exception:  # pragma: no cover
    fitz = None

MAILTO = "gwonedgar@gmail.com"
OPENALEX = "https://api.openalex.org"
CROSSREF = "https://api.crossref.org"

# Confidence thresholds for verified title matching.
SIM_HIGH = 0.92   # >= this on a title match -> high confidence
SIM_MIN = 0.82    # below this -> reject the match (no fabrication)

DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.I)


def _load_openalex_key() -> Optional[str]:
    path = os.path.expanduser("~/.config/openalex/key")
    try:
        with open(path) as fh:
            k = fh.read().strip()
            return k or None
    except Exception:
        return None


OA_KEY = _load_openalex_key()

_session = requests.Session()
_session.headers.update({"User-Agent": f"reference-map/1.0 (mailto:{MAILTO})"})


# --------------------------------------------------------------------------
# Text / string helpers
# --------------------------------------------------------------------------
def _norm(s: Optional[str]) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _sim(a: Optional[str], b: Optional[str]) -> float:
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _clean_doi(d: str) -> str:
    return d.rstrip(").,;").strip()


# --------------------------------------------------------------------------
# Venue normalization + coloring
# --------------------------------------------------------------------------
# Canonical names so "MIS Q." / "MIS Quarterly" / "Management Information
# Systems Quarterly" all collapse to one slice in the pie chart.
_VENUE_ALIASES = {
    "mis quarterly": "MIS Quarterly",
    "mis q": "MIS Quarterly",
    "management information systems quarterly": "MIS Quarterly",
    "misq": "MIS Quarterly",
    "information systems research": "Information Systems Research",
    "inform syst res": "Information Systems Research",
    "inf syst res": "Information Systems Research",
    "isr": "Information Systems Research",
    "journal of management information systems": "Journal of Management Information Systems",
    "j manage inform syst": "Journal of Management Information Systems",
    "communications of the acm": "Communications of the ACM",
    "commun acm": "Communications of the ACM",
    "management science": "Management Science",
    "manage sci": "Management Science",
    "decision support systems": "Decision Support Systems",
    "european journal of information systems": "European Journal of Information Systems",
    "journal of the association for information systems": "Journal of the Association for Information Systems",
    "information systems journal": "Information Systems Journal",
    "the journal of strategic information systems": "Journal of Strategic Information Systems",
    "journal of strategic information systems": "Journal of Strategic Information Systems",
    # HICSS shows up under several long proceedings names; collapse to a short,
    # readable label (also handles the slash-joined variants below).
    "proceedings of the annual hawaii international conference on system sciences":
        "Hawaii International Conference on System Sciences (HICSS)",
    "proceedings of the hawaii international conference on system sciences":
        "Hawaii International Conference on System Sciences (HICSS)",
    "hawaii international conference on system sciences":
        "Hawaii International Conference on System Sciences (HICSS)",
}


def _pick_slash_variant(v: str) -> str:
    """Some OpenAlex source names join two near-identical title variants with a
    slash, e.g. 'Proceedings of the … Annual Hawaii International Conference on
    System Sciences/Proceedings of the Annual Hawaii International Conference on
    System Sciences'. Showing the whole slashed string is long and ugly, so pick
    one clean variant.

    We only collapse when the slash is clearly joining *variants of the same
    name* -- an ellipsis placeholder is present, or the two sides are highly
    similar. A genuinely distinct 'A / B' name is left untouched so we never
    misrepresent the venue."""
    if "/" not in v:
        return v
    segs = [s.strip() for s in v.split("/") if s.strip()]
    if len(segs) < 2:
        return v
    has_ellipsis = any("…" in s or "..." in s for s in segs)
    looks_duplicated = has_ellipsis or (
        len(segs) == 2 and _sim(segs[0], segs[1]) >= 0.6
    )
    if not looks_duplicated:
        return v
    clean = [s for s in segs if "…" not in s and "..." not in s]
    return min(clean or segs, key=len)


def normalize_venue(v: Optional[str]) -> Optional[str]:
    if not v:
        return None
    v = _pick_slash_variant(v.strip())
    key = _norm(v)
    if key in _VENUE_ALIASES:
        return _VENUE_ALIASES[key]
    # Strip trailing punctuation/abbrev dots, title-case lightly but keep
    # original if it already looks like a full name.
    return v.strip()


# Pinned colors: ISR and MISQ get visually distinct, reserved hues per the
# user's request. Everything else draws from a categorical palette.
PINNED_VENUE_COLORS = {
    "Information Systems Research": "#2563eb",  # blue
    "MIS Quarterly": "#dc2626",                # crimson
}

PALETTE = [
    "#0891b2", "#7c3aed", "#ea580c", "#16a34a", "#db2777",
    "#ca8a04", "#0d9488", "#9333ea", "#65a30d", "#e11d48",
    "#4f46e5", "#b45309", "#0284c7", "#be123c", "#15803d",
]

UNKNOWN_COLOR = "#9ca3af"  # gray for unresolved / unknown venue


def color_for_venue(venue: Optional[str], palette_index: int) -> str:
    if not venue or venue == "(unknown)":
        return UNKNOWN_COLOR
    if venue in PINNED_VENUE_COLORS:
        return PINNED_VENUE_COLORS[venue]
    return PALETTE[palette_index % len(PALETTE)]


# --------------------------------------------------------------------------
# PDF parsing
# --------------------------------------------------------------------------
def extract_pdf_info(data: bytes) -> dict:
    """Return candidate title(s), DOI, and basic metadata from PDF bytes."""
    if fitz is None:
        raise RuntimeError("PyMuPDF (fitz) is not installed")
    doc = fitz.open(stream=data, filetype="pdf")

    meta = doc.metadata or {}
    meta_title = (meta.get("title") or "").strip()

    # Largest-font line block on page 0 is usually the title.
    big_title = _largest_font_title(doc[0]) if doc.page_count else None

    # DOI: scan only the first 2 pages so we get the *paper's own* DOI, not
    # DOIs that appear inside the reference list.
    head_text = "\n".join(doc[i].get_text() for i in range(min(2, doc.page_count)))
    dois = [_clean_doi(d) for d in DOI_RE.findall(head_text)]
    # de-dup, preserve order
    seen = set()
    dois = [d for d in dois if not (d.lower() in seen or seen.add(d.lower()))]

    candidates = []
    for t in (meta_title, big_title):
        if t and len(t) > 8 and t not in candidates:
            candidates.append(t)

    return {
        "page_count": doc.page_count,
        "meta_title": meta_title or None,
        "title_candidates": candidates,
        "dois": dois,
    }


def _largest_font_title(page) -> Optional[str]:
    """
    Heuristic title detector. The title is usually the first contiguous block
    of lines set in the largest font on page 0. Crucially we stop at the first
    large vertical gap, so author names set in the *same* font as the title
    (common in working papers) are not swept into the title.
    """
    try:
        d = page.get_text("dict")
    except Exception:
        return None

    # Collapse spans into lines: (y, size, text).
    lines = []
    for b in d.get("blocks", []):
        for ln in b.get("lines", []):
            txt = " ".join(sp.get("text", "") for sp in ln.get("spans", [])).strip()
            if not txt:
                continue
            size = max((sp.get("size", 0) for sp in ln.get("spans", [])), default=0)
            lines.append((round(ln["bbox"][1]), round(size, 1), txt))
    if not lines:
        return None

    lines.sort(key=lambda x: x[0])  # top-to-bottom
    max_sz = max(s[1] for s in lines)

    # Walk the largest-font lines top-down; stop at the first big vertical gap.
    title_lines, prev_y = [], None
    for y, size, txt in lines:
        if size < max_sz - 0.5:
            continue
        if prev_y is not None and (y - prev_y) > 2.0 * max_sz:
            break  # gap -> authors/affiliation begin here
        title_lines.append(txt)
        prev_y = y

    title = re.sub(r"\s+", " ", " ".join(title_lines)).strip()
    return title if 8 <= len(title) <= 300 else None


# --------------------------------------------------------------------------
# OpenAlex helpers
# --------------------------------------------------------------------------
def _oa_get(path: str, **params) -> Optional[dict]:
    params.setdefault("mailto", MAILTO)
    if OA_KEY:
        params.setdefault("api_key", OA_KEY)
    for attempt in range(3):
        try:
            r = _session.get(f"{OPENALEX}{path}", params=params, timeout=40)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:
                return None
            if r.status_code in (429, 500, 502, 503):
                time.sleep(1.0 + attempt)
                continue
            return None
        except requests.RequestException:
            time.sleep(0.8 + attempt)
    return None


_WORK_SELECT = (
    "id,doi,title,display_name,publication_year,type,cited_by_count,"
    "primary_location,authorships,referenced_works"
)
_WORK_SELECT_LITE = "id,doi,title,publication_year,type,primary_location,authorships"


def _venue_of(work: dict) -> Optional[str]:
    loc = work.get("primary_location") or {}
    src = loc.get("source") or {}
    return normalize_venue(src.get("display_name"))


def _authors_of(work: dict, limit: int = 8) -> list:
    out = []
    for a in (work.get("authorships") or [])[:limit]:
        nm = (a.get("author") or {}).get("display_name")
        if nm:
            out.append(nm)
    return out


def _work_to_ref(work: dict) -> dict:
    return {
        "openalex_id": (work.get("id") or "").split("/")[-1] or None,
        "title": work.get("title") or work.get("display_name"),
        "year": work.get("publication_year"),
        "venue": _venue_of(work) or "(unknown)",
        "type": work.get("type"),
        "doi": (work.get("doi") or "").replace("https://doi.org/", "") or None,
        "authors": _authors_of(work),
    }


# --------------------------------------------------------------------------
# Paper identification
# --------------------------------------------------------------------------
def identify_paper(info: dict) -> dict:
    """
    Identify the uploaded paper. Returns a dict with:
      matched (bool), confidence ('high'|'medium'|None), method, openalex_id,
      title, year, venue, doi, referenced_work_ids, sim, note
    """
    result = {
        "matched": False, "confidence": None, "method": None,
        "openalex_id": None, "title": None, "year": None, "venue": None,
        "doi": None, "referenced_work_ids": [], "sim": None, "note": None,
    }

    # 1) DOI direct (most reliable)
    for doi in info.get("dois", []):
        work = _oa_get(f"/works/https://doi.org/{doi}", select=_WORK_SELECT)
        if work and work.get("id"):
            return _finalize_match(result, work, method="doi",
                                   confidence="high", sim=1.0)

    # 2) Verified title search on OpenAlex. Collect candidates across all
    #    title guesses, then choose: among strong title matches prefer the
    #    most-cited record (the canonical "version of record" over reprints/
    #    preprints), otherwise fall back to the single best title similarity.
    cands = []  # (sim, cited_by_count, work)
    for cand in info.get("title_candidates", []):
        data = _oa_get("/works", search=cand, per_page=5, select=_WORK_SELECT)
        for w in (data or {}).get("results", []):
            s = _sim(cand, w.get("title") or w.get("display_name"))
            cands.append((s, w.get("cited_by_count") or 0, w))
        time.sleep(0.2)

    if cands:
        strong = [c for c in cands if c[0] >= SIM_HIGH]
        if strong:
            best_sim, _, best = max(strong, key=lambda c: c[1])
        else:
            best_sim, _, best = max(cands, key=lambda c: c[0])
        if best_sim >= SIM_MIN:
            conf = "high" if best_sim >= SIM_HIGH else "medium"
            return _finalize_match(result, best, method="title", confidence=conf,
                                   sim=round(best_sim, 3))
    else:
        best, best_sim = None, 0.0

    # 3) Crossref fallback -> DOI -> OpenAlex
    for cand in info.get("title_candidates", []):
        doi = _crossref_doi(cand)
        if doi:
            work = _oa_get(f"/works/https://doi.org/{doi}", select=_WORK_SELECT)
            if work and work.get("id"):
                s = _sim(cand, work.get("title") or work.get("display_name"))
                if s >= SIM_MIN:
                    conf = "high" if s >= SIM_HIGH else "medium"
                    return _finalize_match(result, work, method="crossref+doi",
                                           confidence=conf, sim=round(s, 3))

    # Not confidently identified -> report honestly, no references.
    result["note"] = (
        "Not confidently identified in OpenAlex/Crossref. This is common for "
        "very recent working papers or preprints not yet indexed. References "
        "are omitted rather than guessed."
    )
    if best is not None:
        result["sim"] = round(best_sim, 3)
        result["note"] += f" (best candidate match similarity={best_sim:.2f})"
    return result


def _finalize_match(result, work, method, confidence, sim) -> dict:
    result.update({
        "matched": True,
        "confidence": confidence,
        "method": method,
        "openalex_id": (work.get("id") or "").split("/")[-1] or None,
        "title": work.get("title") or work.get("display_name"),
        "year": work.get("publication_year"),
        "venue": _venue_of(work),
        "doi": (work.get("doi") or "").replace("https://doi.org/", "") or None,
        "referenced_work_ids": [
            (w or "").split("/")[-1] for w in (work.get("referenced_works") or [])
        ],
        "sim": sim,
    })
    return result


def _crossref_doi(title: str) -> Optional[str]:
    try:
        r = _session.get(
            f"{CROSSREF}/works",
            params={"query.bibliographic": title, "rows": 3, "mailto": MAILTO},
            timeout=30,
        )
        if r.status_code != 200:
            return None
        for it in r.json().get("message", {}).get("items", []):
            t = " ".join(it.get("title") or [])
            if _sim(title, t) >= SIM_MIN and it.get("DOI"):
                return it["DOI"]
    except requests.RequestException:
        return None
    return None


# --------------------------------------------------------------------------
# Reference resolution (authoritative, batch)
# --------------------------------------------------------------------------
def resolve_references(referenced_ids: list) -> dict:
    """
    Batch-resolve OpenAlex work IDs to real reference records.
    Returns {'references': [...resolved...], 'requested': N, 'resolved': M}.
    Unresolved IDs are counted but never fabricated.
    """
    ids = [i for i in referenced_ids if i]
    resolved: dict[str, dict] = {}
    for i in range(0, len(ids), 50):
        batch = ids[i:i + 50]
        filt = "openalex_id:" + "|".join(batch)
        data = _oa_get("/works", filter=filt, per_page=50, select=_WORK_SELECT_LITE)
        for w in (data or {}).get("results", []):
            ref = _work_to_ref(w)
            if ref["openalex_id"] and ref["title"]:
                resolved[ref["openalex_id"]] = ref
        time.sleep(0.2)

    refs = list(resolved.values())
    refs.sort(key=lambda r: (-(r["year"] or 0), r["venue"]))
    return {
        "references": refs,
        "requested": len(ids),
        "resolved": len(refs),
    }


# --------------------------------------------------------------------------
# Venue composition
# --------------------------------------------------------------------------
def venue_composition(references: list) -> list:
    counts: dict[str, int] = {}
    for r in references:
        v = r.get("venue") or "(unknown)"
        counts[v] = counts.get(v, 0) + 1
    items = sorted(counts.items(), key=lambda x: (-x[1], x[0]))
    # Assign palette indices deterministically (pinned venues bypass palette).
    out, pidx = [], 0
    for venue, count in items:
        if venue in PINNED_VENUE_COLORS or venue == "(unknown)":
            color = color_for_venue(venue, 0)
        else:
            color = color_for_venue(venue, pidx)
            pidx += 1
        out.append({"venue": venue, "count": count, "color": color})
    return out


# --------------------------------------------------------------------------
# Full single-paper pipeline
# --------------------------------------------------------------------------
def analyze_pdf(filename: str, data: bytes) -> dict:
    info = extract_pdf_info(data)
    ident = identify_paper(info)

    paper = {
        "filename": filename,
        "page_count": info.get("page_count"),
        "extracted_title": (info.get("title_candidates") or [None])[0],
        "extracted_dois": info.get("dois", []),
        "identification": ident,
        "references": [],
        "reference_source": None,   # 'database' | 'pdf-recovered' | None
        "reference_stats": {"requested": 0, "resolved": 0},
        "venue_composition": [],
    }

    if ident["matched"] and ident["referenced_work_ids"]:
        # Authoritative path: the database has this paper's reference list.
        res = resolve_references(ident["referenced_work_ids"])
        for r in res["references"]:
            r.setdefault("match_by", "database")
            r.setdefault("match_conf", "high")
        paper["references"] = res["references"]
        paper["reference_source"] = "database"
        paper["reference_stats"] = {
            "requested": res["requested"], "resolved": res["resolved"],
        }
        paper["venue_composition"] = venue_composition(res["references"])
    else:
        # Fallback path: the paper is a preprint/working paper with no
        # reference list in any database (or could not be matched). Recover
        # references straight from the PDF, resolving each to a real record.
        rec = _recover_from_pdf(data)
        if rec and rec["references"]:
            paper["references"] = rec["references"]
            paper["reference_source"] = "pdf-recovered"
            st = rec["stats"]
            paper["reference_stats"] = {
                "requested": st["parsed"], "resolved": st["resolved"],
                "parsed": st["parsed"], "truncated": st.get("truncated", False),
                "note": ("References were recovered directly from the PDF and "
                         "resolved against Crossref/OpenAlex; entries that could "
                         "not be confidently resolved were omitted."),
            }
            paper["venue_composition"] = venue_composition(rec["references"])
        else:
            note = (rec["stats"].get("note") if rec else None) or (
                "Paper identified, but no reference list is available in any "
                "database and none could be recovered from the PDF."
                if ident["matched"] else
                "Paper not confidently identified; references omitted.")
            paper["reference_stats"]["note"] = note
    return paper


def _recover_from_pdf(data: bytes) -> Optional[dict]:
    """Lazy wrapper around the PDF reference-recovery fallback (deferred import
    avoids a circular dependency with pdf_references)."""
    try:
        import fitz as _fitz
        import pdf_references
        doc = _fitz.open(stream=data, filetype="pdf")
        return pdf_references.recover_references_from_pdf(doc)
    except Exception as e:
        return {"references": [], "stats": {
            "parsed": 0, "resolved": 0, "truncated": False,
            "note": f"PDF reference recovery failed: {type(e).__name__}."}}
