# Reference Map

A **fully client-side** static web app that takes scientific-paper PDFs,
identifies each paper against authoritative scholarly databases, pulls its
**real** reference list, and visualizes venue composition (pie charts) and
cross-paper citation structure (a directed network).

There is **no server**: PDFs are parsed in the browser (pdf.js) and the
OpenAlex / Crossref APIs are queried directly from the page (both support
CORS). Deployable as-is to Cloudflare Pages — e.g.
https://reference-viewer.misclaw.app — by serving this repository root.

**Accuracy first — no hallucination.** We never parse reference strings
heuristically or invent metadata. Instead we identify the uploaded paper, then
read its already-resolved reference list straight from the database. Anything we
cannot confidently match is reported as such and omitted, never guessed.

## How it works

```
PDF ──► extract title + DOI in the browser (pdfjs-dist, pinned CDN build)
     ──► identify the paper
            1. DOI  → OpenAlex            (exact, highest confidence)
            2. title→ OpenAlex search, verified by title-similarity ≥ 0.82
                      (ties broken toward the most-cited canonical record)
            3. Crossref → DOI → OpenAlex  (fallback)
            else → "unidentified", references omitted
     ──► references = OpenAlex `referenced_works`  (authoritative list)
     ──► batch-resolve each reference to real title/venue/year/authors
         (works endpoint, openalex_id filter, batches of 50, per_page=50)
     ──► venue composition + cross-paper citation graph
```

Sources: **OpenAlex** (primary; polite pool via the `mailto` query param),
**Crossref** (identity fallback). Semantic Scholar was evaluated but is heavily
rate-limited; OpenAlex's `referenced_works` is both authoritative and stable,
so it is the backbone. The title-similarity check is a faithful port of
Python's `difflib.SequenceMatcher.ratio()` (including autojunk), so the
0.82 / 0.92 confidence thresholds carry over exactly.

### Preprints (SSRN / arXiv): reference recovery from the PDF

SSRN and arXiv do **not** deposit reference lists into OpenAlex/Crossref, so a
preprint is found but its `referenced_works` is empty. When that happens, the
tool recovers the references **directly from the PDF**, while keeping the
no-fabrication guarantee:

```
parse the References section  ─►  split into entries (author-year aware)
  for each entry, resolve to a REAL record:
     explicit arXiv id / DOI   ─► OpenAlex          [high confidence]
     else title → OpenAlex search, gated on title-recall vs the entry  [fast]
     else Crossref bibliographic, same recall + score + year gate      [thorough]
  + a split-independent identifier sweep (every arXiv/DOI in the section)
  drop anything that fails the gate
```

The parsed text is used **only as a search query** — every field displayed
(title, venue, year, authors, DOI) comes from the resolved database record, not
from the parse. Each recovered reference is tagged with how it was matched
(arXiv id / DOI / title match) and a confidence level, and the card is marked
**"references recovered from PDF"** to distinguish it from the authoritative
database path. Entries that cannot be confidently resolved are counted and
dropped, never guessed. See the recovery section of `core.js`.

## Features

- **Drag-and-drop** one or many PDFs (or **"Try the example papers"**, which
  fetches the bundled PDFs from `examples/` and runs the same client pipeline).
- **Per-paper card**: identification + confidence badge (high / medium /
  unidentified), match method, resolved-vs-listed reference counts, a venue
  **doughnut chart**, venue bars, and an expandable table of every resolved
  reference (with DOI links).
- **Overall venue composition** across all uploaded papers.
- **Export** the resolved data: a flat **References CSV** (one row per resolved
  reference, with source paper + venue + authors + DOI) or the **full JSON**.
- **Citation Map** (shown for ≥2 papers): directed graph where
  - **paper → paper** edges = one uploaded paper directly cites another,
  - **paper → shared-reference** edges = a work cited by ≥2 uploaded papers
    (bibliographic overlap). Toggle shared references on/off.
- **Information Systems Research** and **MIS Quarterly** are pinned to distinct
  reserved colors (ISR = blue `#2563eb`, MISQ = crimson `#dc2626`) everywhere —
  pies, bars, venue pills, and graph nodes. Venue-name variants
  (`MIS Q.`, `Management Information Systems Quarterly`, …) are normalized so
  they collapse into one slice.

## Architecture (no build step — plain ES modules)

```
index.html        single page; loads Chart.js + vis-network (UMD) and app.js (module)
styles.css        styling (dark/light themes)
app.js            UI: upload queue, examples manifest, rendering, charts, graph, export
pdf-extract.js    browser-only: pdfjs-dist@4.10.38 (pinned, jsDelivr ESM + worker);
                  extracts {page_count, meta_title, title_candidates, dois, full_text}
pdf-text.js       pure text-layout logic used by pdf-extract.js (line grouping,
                  largest-font title heuristic, DOI scan) — DOM-free, Node-testable
core.js           the pipeline (NO DOM — importable from Node for testing):
                  identification, reference resolution, References-section recovery,
                  venue normalization/coloring, venue composition, citation-graph builder,
                  bounded concurrency + 429 backoff for OpenAlex/Crossref
examples/         sample PDFs (each < 25 MiB, the Cloudflare Pages per-file limit)
server-prototype/ the original Python (FastAPI/PyMuPDF) prototype, kept for reference,
                  plus a Node smoke test (tests/smoke.mjs) that exercises core.js
                  against the live OpenAlex API
```

The browser analyzes papers concurrently (4 at a time) and `core.js`
additionally caps concurrent OpenAlex/Crossref calls (6 / 4) with backoff on
HTTP 429/5xx — the same etiquette the Python prototype used. All OpenAlex and
Crossref requests carry `mailto=` for the polite pool.

## Run locally

Any static file server works:

```bash
cd reference-viewer
python3 -m http.server 8000     # → http://127.0.0.1:8000
```

Open the page and click **Try the example papers**, or drop your own PDFs.

### Deploy (Cloudflare Pages)

Point a Pages project at the repository root (no build command, output
directory = `/`). Everything is static; the example PDFs are served from
`examples/`.

### Test the pipeline from Node (no browser needed)

```bash
node server-prototype/tests/smoke.mjs
```

This identifies a known paper by title against the live OpenAlex API,
batch-resolves its references, and checks venue/graph shapes.

## What "no fabrication" looks like in practice

From the bundled examples:

| Paper | Outcome |
|---|---|
| Hevner et al. 2004, *Design Science* | ✓ MIS Quarterly — 69/69 references from database |
| Sun et al. 2025, *Voice AI* | ✓ Information Systems Research — 39/40 from database |
| Li et al., *ChatGPT & Learning* | ✓ SSRN — DB lists 0 refs → **~61 recovered from PDF** & resolved |
| Bapna et al. 2025, *Agentic AI* | ✓ SSRN — DB lists 0 refs → **~53 recovered from PDF** & resolved |
| Yamada et al., *AI Scientist-v2* | ✓ arXiv — DB lists 0 refs → **~18 recovered from PDF** & resolved |

(Recovery counts vary slightly run-to-run with API availability; uncertain
entries are always dropped rather than guessed.)

A reference that the database lists but that does not resolve to a real record is
counted and disclosed ("N listed reference(s) could not be resolved … omitted"),
not fabricated. If a paper cannot be matched at all (e.g. a brand-new working
paper not yet in any index), it is labeled *unidentified* and its references are
omitted entirely rather than approximated.

## Known data quirks (faithful to the source, not bugs in this tool)

- A few OpenAlex records carry footnote artifacts in the title field (e.g. a
  trailing superscript digit). These are shown as the database stores them.
- Very recent working papers / preprints are often not yet indexed; those are
  reported as unidentified rather than approximated.
- Some arXiv-only works are not deposited under their `10.48550/arXiv.*` DOI in
  OpenAlex at all; such entries are dropped (disclosed in the counts), never
  guessed.
