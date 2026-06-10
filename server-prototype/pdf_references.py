"""
pdf_references.py
=================
Fallback reference recovery for papers whose references are NOT in any database
(typical for SSRN / arXiv preprints, which do not deposit reference lists).

Pipeline, designed to preserve the "no fabrication" guarantee:

  1. Locate the *main* References section in the PDF and split it into entries.
  2. For each entry, resolve it to an AUTHORITATIVE database record:
       a. explicit arXiv id  -> OpenAlex (via 10.48550/arXiv.<id>)   [high conf]
       b. explicit DOI       -> OpenAlex                              [high conf]
       c. otherwise          -> Crossref bibliographic match, GATED on a
          title-recall test (the matched record's title tokens must actually
          appear in the parsed reference string) + a Crossref relevance score.
  3. Anything that does not clear the confidence gate is DROPPED, not guessed.

The parsed reference string is only ever used as a *search query*. Every field
shown to the user (title, venue, year, authors, DOI) comes from the resolved
database record — never from our own parse.
"""

from __future__ import annotations

import re
import time
import threading
from concurrent.futures import ThreadPoolExecutor

import requests

import reference_core as core

MAIL = core.MAILTO
_session = core._session

# Process-wide caps on concurrent outbound calls. Multiple preprints can be
# recovered at once (the server analyzes papers in parallel); without these,
# bursts of lookups exceed the providers' rate limits (Crossref ~10/s,
# OpenAlex ~10/s polite) and references are silently lost to 429s.
_CR_SEM = threading.BoundedSemaphore(6)
_OA_SEM = threading.BoundedSemaphore(8)

# Confidence gate for bibliographic (no-identifier) matches.
RECALL_MIN = 0.72          # fraction of matched-title tokens present in entry
CROSSREF_SCORE_MIN = 40.0
MAX_ENTRIES = 90           # bound work per paper; report if we truncate

ARXIV_RE = re.compile(r'arxiv[:/\s]*?(\d{4}\.\d{4,5})(?:v\d+)?', re.I)
ARXIV_URL_RE = re.compile(r'arxiv\.org/abs/\s*(\d{4}\.\d{4,5})', re.I)
DOI_RE = re.compile(r'10\.\d{4,9}/[-._;()/:a-z0-9]+', re.I)
YEAR_PARENS_RE = re.compile(r'\((?:19|20)\d{2}[a-z]?\)')
YEAR_RE = re.compile(r'\b(?:19|20)\d{2}\b')

# A line that begins a new author-year reference, e.g.
#   "Abbas M, Jam F A, Khan T I (2024) ..."   "Alavi M (1994) ..."
#   "Joeran Beel, Min-Yen Kan, and Moritz Baumgart. An evaluation ..."
REF_START_RE = re.compile(r'^[A-ZÀ-Þ][A-Za-zÀ-ÿ’\'\-]+,?\s+[A-ZÀ-Þ]')


# --------------------------------------------------------------------------
# 1. Extract + split the references section
# --------------------------------------------------------------------------
def extract_references_section(doc) -> str | None:
    """Return the text of the *first* (main) reference list, trimmed at the
    next reference heading / appendix / end."""
    full = "\n".join(doc[i].get_text() for i in range(doc.page_count))
    headings = list(re.finditer(
        r'\n[ \t]*(References|REFERENCES|Bibliography|BIBLIOGRAPHY|Works Cited|Literature Cited)[ \t]*\n',
        full))
    if not headings:
        return None
    start = headings[0].end()
    rest = full[start:]
    # Stop at the next big section that clearly follows the bibliography.
    stop = re.search(
        r'\n[ \t]*(Appendix|APPENDIX|Supplementary|SUPPLEMENTARY|'
        r'References|REFERENCES|Bibliography|BIBLIOGRAPHY)\b', rest)
    return rest[:stop.start()] if stop else rest


def _dehyphenate(text: str) -> str:
    text = text.replace('­', '')           # soft hyphen
    text = re.sub(r'(\w)-\n(\w)', r'\1\2', text)  # word-break hyphenation
    return text


def split_reference_entries(section: str) -> list[str]:
    """Split a references section into individual reference strings.

    Strategy A: blank-line separated entries (common in Word-exported PDFs).
    Strategy B: author-year line starts ("Surname I (YYYY)" / "Firstname Last,").
    We pick whichever yields more entries that each contain a year, then merge
    yearless fragments into the previous entry (they are continuations)."""
    section = _dehyphenate(section)

    a = _split_blank_lines(section)
    b = _split_author_year(section)

    def score(entries):
        good = sum(1 for e in entries if YEAR_RE.search(e))
        return good
    chosen = a if score(a) >= score(b) else b

    # Merge fragments without a year into the previous entry; drop tiny noise.
    merged: list[str] = []
    for e in chosen:
        e = re.sub(r'\s+', ' ', e).strip()
        if not e:
            continue
        if not YEAR_RE.search(e) and merged:
            merged[-1] = (merged[-1] + " " + e).strip()
        else:
            merged.append(e)
    # Keep plausible references: contain a year and have some length.
    return [e for e in merged if YEAR_RE.search(e) and 20 <= len(e) <= 700]


def _split_blank_lines(section: str) -> list[str]:
    return [c for c in re.split(r'\n[ \t]*\n', section) if c.strip()]


def _split_author_year(section: str) -> list[str]:
    lines = section.split('\n')
    entries, cur = [], []
    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        if REF_START_RE.match(s) and cur:
            entries.append(" ".join(cur))
            cur = [s]
        else:
            cur.append(s)
    if cur:
        entries.append(" ".join(cur))
    return entries


# --------------------------------------------------------------------------
# 2. Resolve one reference entry to an authoritative record
# --------------------------------------------------------------------------
def _norm(s: str) -> str:
    return re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).strip()


def _title_recall(entry: str, title: str) -> float:
    """Fraction of the matched title's (content) tokens that appear in the
    parsed reference string. High recall => the matched record really is this
    reference, not a Crossref near-miss."""
    nt, ne = _norm(title), _norm(entry)
    toks = [t for t in nt.split() if len(t) > 2]
    if len(toks) < 3:
        return 0.0
    ne_set = set(ne.split())
    return sum(1 for t in toks if t in ne_set) / len(toks)


# Resolution is two-phase. Phase 1 turns each entry into a CANDIDATE: either a
# DOI to batch-resolve later, or (for the fast OpenAlex title-search path) an
# already-resolved record. Phase 2 batch-resolves the DOI-only candidates.
#
# Resolver priority per entry: explicit arXiv id / DOI -> OpenAlex title search
# (fast, ~0.5s) -> Crossref bibliographic (thorough but ~5s, used only for the
# minority OpenAlex misses). Every non-identifier match must pass a title-recall
# gate against the full reference string, so near-misses are dropped not guessed.

_TITLE_AFTER_YEAR = re.compile(r'\((?:19|20)\d{2}[a-z]?\)\.?\s*(.+)', re.S)
_TITLE_AFTER_PAREN = re.compile(r'\)\.?\s*(.+)', re.S)


def _title_guess(entry: str) -> str:
    """Best-effort title fragment from an author-year reference (the text after
    the '(year)'/author block, up to the first sentence break)."""
    m = _TITLE_AFTER_YEAR.search(entry) or _TITLE_AFTER_PAREN.search(entry)
    t = m.group(1) if m else entry
    t = re.split(r'\.\s+(?=[A-Z(])', t)[0]   # up to first real sentence break
    return re.sub(r'\s+', ' ', t).strip()[:240]


def _entry_candidate(entry: str) -> dict | None:
    """Phase 1: resolve an entry to a candidate, or None if not confident."""
    # a) explicit arXiv id
    m = ARXIV_URL_RE.search(entry) or ARXIV_RE.search(entry)
    if m:
        return {"doi": f"10.48550/arXiv.{m.group(1)}",
                "match_by": "arxiv-id", "match_conf": "high", "cr": None}

    # b) explicit DOI in the reference text
    for d in DOI_RE.findall(entry):
        d = d.rstrip(').,;')
        if not d.lower().startswith('10.48550'):
            return {"doi": d, "match_by": "doi", "match_conf": "high", "cr": None}

    # c) OpenAlex title search (fast). Gate on title-recall vs the full entry.
    tg = _title_guess(entry)
    if len(tg) >= 8:
        works = _oa_title_search(tg)
        best, best_rec = None, 0.0
        for w in works:
            rec = _title_recall(entry, w.get("title") or w.get("display_name"))
            if rec > best_rec:
                best, best_rec = w, rec
        if best and best_rec >= RECALL_MIN and _year_ok(entry, best.get("publication_year")):
            ref = core._work_to_ref(best)
            if ref.get("title"):
                return {"ref": ref, "match_by": "title-search",
                        "match_conf": "high" if best_rec >= 0.9 else "medium"}

    # d) Crossref bibliographic fallback (thorough), same recall+score+year gate
    items = _crossref_bibliographic(entry)
    if not items:
        return None
    best, best_recall = None, 0.0
    for it in items:
        rec = _title_recall(entry, " ".join(it.get("title") or []))
        if rec > best_recall:
            best, best_recall = it, rec
    if not best or best_recall < RECALL_MIN or (best.get("score") or 0.0) < CROSSREF_SCORE_MIN:
        return None
    if not _year_ok(entry, _crossref_year(best)):
        return None
    doi = best.get("DOI")
    if not doi:
        return None
    return {"doi": doi, "match_by": "bibliographic", "match_conf": "medium",
            "cr": best}


def _year_ok(entry: str, year) -> bool:
    """The matched record's year must agree with a year stated in the entry
    (allowing off-by-one for preprint vs publication)."""
    if not year:
        return True
    entry_years = set(YEAR_RE.findall(entry))
    if not entry_years:
        return True
    return any(abs(int(y) - int(year)) <= 1 for y in entry_years)


def _oa_title_search(title: str) -> list:
    with _OA_SEM:
        data = core._oa_get("/works", search=title, per_page=3,
                            select=core._WORK_SELECT_LITE)
    return (data or {}).get("results", []) if data else []


def _entry_candidate_safe(entry: str):
    try:
        return _entry_candidate(entry)
    except Exception:
        return None


def _batch_resolve_dois(dois) -> dict:
    """Phase 2: resolve many DOIs to authoritative OpenAlex records at once."""
    out: dict[str, dict] = {}
    dois = [d for d in dois if d]
    for i in range(0, len(dois), 50):
        batch = dois[i:i + 50]
        filt = "doi:" + "|".join(batch)
        data = core._oa_get("/works", filter=filt, per_page=50,
                            select=core._WORK_SELECT_LITE)
        for w in (data or {}).get("results", []):
            ref = core._work_to_ref(w)
            key = (ref.get("doi") or "").lower()
            if key and ref.get("title"):
                out[key] = ref
        time.sleep(0.2)
    return out


def _cr_to_ref(item: dict) -> dict:
    """Build a reference record from Crossref metadata (used only when a DOI is
    not present in OpenAlex)."""
    return {
        "openalex_id": None,
        "title": " ".join(item.get("title") or []),
        "year": _crossref_year(item),
        "venue": core.normalize_venue(" ".join(item.get("container-title") or [])) or "(unknown)",
        "type": item.get("type"),
        "doi": item.get("DOI"),
        "authors": _crossref_authors(item),
    }


def _crossref_bibliographic(entry: str) -> list | None:
    """Crossref bibliographic search, rate-limited and retried on throttling.
    Returns a list of items, or None on hard failure."""
    params = {"query.bibliographic": entry, "rows": 3, "mailto": MAIL,
              "select": "DOI,title,score,container-title,issued,author,type"}
    for attempt in range(4):
        with _CR_SEM:
            try:
                r = _session.get("https://api.crossref.org/works",
                                 params=params, timeout=30)
            except requests.RequestException:
                time.sleep(0.6 * (attempt + 1))
                continue
        if r.status_code == 200:
            return r.json().get("message", {}).get("items", [])
        if r.status_code in (429, 500, 502, 503):
            time.sleep(1.0 + 1.2 * attempt)
            continue
        return None
    return None


def _crossref_year(item: dict):
    try:
        return item["issued"]["date-parts"][0][0]
    except Exception:
        return None


def _crossref_authors(item: dict, limit: int = 8) -> list:
    out = []
    for a in (item.get("author") or [])[:limit]:
        nm = " ".join(x for x in [a.get("given"), a.get("family")] if x)
        if nm:
            out.append(nm)
    return out


# --------------------------------------------------------------------------
# 3. Orchestrator
# --------------------------------------------------------------------------
def recover_references_from_pdf(doc) -> dict:
    """Best-effort recovery of references straight from the PDF, each resolved
    to an authoritative record. Returns references + honest stats."""
    section = extract_references_section(doc)
    if not section:
        return {"references": [], "stats": {
            "parsed": 0, "resolved": 0, "truncated": False,
            "note": "No References section detected in the PDF."}}

    entries = split_reference_entries(section)
    truncated = len(entries) > MAX_ENTRIES
    entries = entries[:MAX_ENTRIES]
    if not entries:
        return {"references": [], "stats": {
            "parsed": 0, "resolved": 0, "truncated": False,
            "note": "Could not segment the References section into entries."}}

    # Phase 1: each entry -> a candidate. A candidate is either already resolved
    # (OpenAlex title-search path, carries 'ref') or a DOI to batch-resolve.
    with ThreadPoolExecutor(max_workers=8) as ex:
        cands = [c for c in ex.map(_entry_candidate_safe, entries) if c]

    # Split-independent identifier sweep: every explicit arXiv id / DOI in the
    # section becomes a candidate too, so imperfect segmentation never loses an
    # identifier-bearing reference.
    cands += _identifier_candidates(section)

    # Phase 2 (batch): resolve the DOI-only candidates in bulk.
    dois = {c["doi"].lower() for c in cands if c.get("doi") and not c.get("ref")}
    oa_map = _batch_resolve_dois(dois)

    # Phase 3: assemble + dedup. Prefer an already-resolved/OpenAlex record;
    # fall back to Crossref metadata only when a DOI is genuinely absent from
    # OpenAlex; otherwise drop (never guess).
    seen, refs = set(), []
    for c in cands:
        base = c.get("ref")
        if base is None:
            doi = (c.get("doi") or "").lower()
            base = oa_map.get(doi)
            if base is None and c.get("cr"):
                base = _cr_to_ref(c["cr"])
        if base is None:
            continue
        ref = dict(base)
        ref["match_by"], ref["match_conf"] = c["match_by"], c["match_conf"]
        key = ref.get("openalex_id") or ref.get("doi") or _norm(ref.get("title") or "")
        if key in seen:
            continue
        seen.add(key)
        refs.append(ref)

    refs.sort(key=lambda r: (-(r.get("year") or 0), r.get("venue") or ""))
    return {
        "references": refs,
        "stats": {
            "parsed": len(entries),
            "resolved": len(refs),
            "truncated": truncated,
            "note": None,
        },
    }


def _identifier_candidates(section: str) -> list:
    """Build DOI candidates from every explicit arXiv id / DOI in the section."""
    cands = []
    seen = set()
    for v in set(ARXIV_URL_RE.findall(section)) | set(ARXIV_RE.findall(section)):
        doi = f"10.48550/arXiv.{v}"
        if doi.lower() not in seen:
            seen.add(doi.lower())
            cands.append({"doi": doi, "match_by": "arxiv-id",
                          "match_conf": "high", "cr": None})
    for d in DOI_RE.findall(section):
        d = d.rstrip(').,;')
        if d.lower().startswith('10.48550') or d.lower() in seen:
            continue
        seen.add(d.lower())
        cands.append({"doi": d, "match_by": "doi", "match_conf": "high", "cr": None})
    return cands
