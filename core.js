/*
 * core.js
 * =======
 * Accuracy-first reference extraction for scientific PDFs — client-side port
 * of the Python prototype (reference_core.py + pdf_references.py + the graph
 * builder from app.py). Pure ES module: no DOM, importable from Node for
 * testing and from the browser for production.
 *
 * Design principle (from CLAUDE.md): NO hallucination, NO fabrication.
 * We never invent reference metadata. Instead we:
 *
 *   1. Identify the *uploaded* paper itself from the PDF (DOI, then verified
 *      title match) against authoritative scholarly databases.
 *   2. Pull that paper's reference list straight from the database
 *      (OpenAlex `referenced_works`), an authoritative, already-resolved list.
 *   3. Batch-resolve each reference to real metadata (title/venue/year/authors).
 *
 * Preprints (SSRN/arXiv) whose referenced_works is empty fall back to
 * recovering references from the PDF's References section text — but every
 * recovered entry must be confirmed against OpenAlex/Crossref before it is
 * included. Unconfirmed entries are counted and dropped, never guessed.
 *
 * Primary source: OpenAlex (polite pool via mailto). Identity fallback: Crossref.
 * Both APIs support CORS from browsers.
 */

export const MAILTO = "gwonedgar@gmail.com";
const OPENALEX = "https://api.openalex.org";
const CROSSREF = "https://api.crossref.org";

// Confidence thresholds for verified title matching.
export const SIM_HIGH = 0.92; // >= this on a title match -> high confidence
export const SIM_MIN = 0.82;  // below this -> reject the match (no fabrication)

export const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;

// ---------------------------------------------------------------------------
// Small async utilities (modest parallelism + polite backoff)
// ---------------------------------------------------------------------------
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Semaphore {
  constructor(n) { this.free = n; this.waiters = []; }
  async run(fn) {
    if (this.free > 0) this.free--;
    else await new Promise((resolve) => this.waiters.push(resolve));
    try { return await fn(); }
    finally {
      const next = this.waiters.shift();
      if (next) next(); else this.free++;
    }
  }
}

// Process-wide caps on concurrent outbound calls (mirrors the Python
// semaphores: Crossref ~10/s, OpenAlex ~10/s polite pool).
const OA_SEM = new Semaphore(6);
const CR_SEM = new Semaphore(4);

/** Map over items with at most `limit` concurrent invocations of fn. */
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

// ---------------------------------------------------------------------------
// Text / string helpers
// ---------------------------------------------------------------------------
export function norm(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Faithful port of Python difflib.SequenceMatcher(None, a, b).ratio()
 * (including the autojunk heuristic for sequences >= 200 chars), so the
 * 0.82 / 0.92 thresholds carry over exactly.
 */
export function sequenceRatio(a, b) {
  const la = a.length, lb = b.length;
  if (la + lb === 0) return 1.0;

  // b2j: char -> ascending indices in b (with autojunk popular-char removal)
  const b2j = new Map();
  for (let j = 0; j < lb; j++) {
    const ch = b[j];
    let arr = b2j.get(ch);
    if (!arr) { arr = []; b2j.set(ch, arr); }
    arr.push(j);
  }
  if (lb >= 200) {
    const ntest = Math.floor(lb / 100) + 1;
    for (const [ch, idxs] of [...b2j]) {
      if (idxs.length > ntest) b2j.delete(ch);
    }
  }

  function findLongestMatch(alo, ahi, blo, bhi) {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map();
      const idxs = b2j.get(a[i]);
      if (idxs) {
        for (const j of idxs) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) || 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
        }
      }
      j2len = newj2len;
    }
    // Extend over equal chars on both ends (no junk classes in our usage).
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi &&
           a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  }

  let matches = 0;
  const queue = [[0, la, 0, lb]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = findLongestMatch(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2.0 * matches) / (la + lb);
}

export function sim(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0.0;
  return sequenceRatio(na, nb);
}

export function cleanDoi(d) {
  return d.replace(/[).,;]+$/, "").trim();
}

function findAll(re, text) {
  // matchAll with a fresh regex (global) -> array of first capture group or
  // whole match.
  const out = [];
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of text.matchAll(r)) out.push(m[1] !== undefined ? m[1] : m[0]);
  return out;
}

// ---------------------------------------------------------------------------
// Venue normalization + coloring
// ---------------------------------------------------------------------------
const VENUE_ALIASES = {
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
  "proceedings of the annual hawaii international conference on system sciences":
    "Hawaii International Conference on System Sciences (HICSS)",
  "proceedings of the hawaii international conference on system sciences":
    "Hawaii International Conference on System Sciences (HICSS)",
  "hawaii international conference on system sciences":
    "Hawaii International Conference on System Sciences (HICSS)",
};

/**
 * Some OpenAlex source names join two near-identical title variants with a
 * slash. Collapse only when the slash clearly joins *variants of the same
 * name* (ellipsis placeholder present, or the two sides highly similar);
 * a genuinely distinct 'A / B' name is left untouched.
 */
function pickSlashVariant(v) {
  if (!v.includes("/")) return v;
  const segs = v.split("/").map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return v;
  const hasEllipsis = segs.some((s) => s.includes("…") || s.includes("..."));
  const looksDuplicated = hasEllipsis ||
    (segs.length === 2 && sim(segs[0], segs[1]) >= 0.6);
  if (!looksDuplicated) return v;
  const clean = segs.filter((s) => !s.includes("…") && !s.includes("..."));
  const pool = clean.length ? clean : segs;
  return pool.reduce((a, b) => (b.length < a.length ? b : a));
}

export function normalizeVenue(v) {
  if (!v) return null;
  v = pickSlashVariant(v.trim());
  const key = norm(v);
  if (Object.prototype.hasOwnProperty.call(VENUE_ALIASES, key)) return VENUE_ALIASES[key];
  return v.trim();
}

// Pinned colors: ISR and MISQ get visually distinct, reserved hues.
export const PINNED_VENUE_COLORS = {
  "Information Systems Research": "#2563eb", // blue
  "MIS Quarterly": "#dc2626",                // crimson
};

const PALETTE = [
  "#0891b2", "#7c3aed", "#ea580c", "#16a34a", "#db2777",
  "#ca8a04", "#0d9488", "#9333ea", "#65a30d", "#e11d48",
  "#4f46e5", "#b45309", "#0284c7", "#be123c", "#15803d",
];

const UNKNOWN_COLOR = "#9ca3af"; // gray for unresolved / unknown venue

export function colorForVenue(venue, paletteIndex) {
  if (!venue || venue === "(unknown)") return UNKNOWN_COLOR;
  if (venue in PINNED_VENUE_COLORS) return PINNED_VENUE_COLORS[venue];
  return PALETTE[paletteIndex % PALETTE.length];
}

// ---------------------------------------------------------------------------
// OpenAlex / Crossref HTTP (polite pool: mailto param; basic 429 backoff)
// ---------------------------------------------------------------------------
async function oaGet(path, params = {}) {
  const url = new URL(OPENALEX + path);
  url.searchParams.set("mailto", MAILTO);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await OA_SEM.run(() => fetch(url));
      if (r.status === 200) return await r.json();
      if (r.status === 404) return null;
      if ([429, 500, 502, 503].includes(r.status)) {
        await sleep(1000 + attempt * 1000);
        continue;
      }
      return null;
    } catch (_e) {
      await sleep(800 + attempt * 1000);
    }
  }
  return null;
}

const WORK_SELECT =
  "id,doi,title,display_name,publication_year,type,cited_by_count," +
  "primary_location,authorships,referenced_works";
const WORK_SELECT_LITE =
  "id,doi,title,publication_year,type,primary_location,authorships";

function venueOf(work) {
  const src = (work.primary_location || {}).source || {};
  return normalizeVenue(src.display_name);
}

function authorsOf(work, limit = 8) {
  const out = [];
  for (const a of (work.authorships || []).slice(0, limit)) {
    const nm = (a.author || {}).display_name;
    if (nm) out.push(nm);
  }
  return out;
}

function workToRef(work) {
  const oid = String(work.id || "").split("/").pop() || null;
  return {
    openalex_id: oid,
    title: work.title || work.display_name || null,
    year: work.publication_year ?? null,
    venue: venueOf(work) || "(unknown)",
    type: work.type ?? null,
    doi: String(work.doi || "").replace("https://doi.org/", "") || null,
    authors: authorsOf(work),
  };
}

// ---------------------------------------------------------------------------
// Paper identification
// ---------------------------------------------------------------------------
/**
 * Identify the uploaded paper from extracted PDF info
 * ({title_candidates, dois}). Returns {matched, confidence, method,
 * openalex_id, title, year, venue, doi, referenced_work_ids, sim, note}.
 */
export async function identifyPaper(info) {
  const result = {
    matched: false, confidence: null, method: null,
    openalex_id: null, title: null, year: null, venue: null,
    doi: null, referenced_work_ids: [], sim: null, note: null,
  };

  // 1) DOI direct (most reliable)
  for (const doi of info.dois || []) {
    const work = await oaGet(`/works/doi:${doi}`, { select: WORK_SELECT });
    if (work && work.id) {
      return finalizeMatch(result, work, "doi", "high", 1.0);
    }
  }

  // 2) Verified title search on OpenAlex. Among strong title matches prefer
  //    the most-cited record (canonical version over reprints/preprints);
  //    otherwise fall back to the single best title similarity.
  const cands = []; // [simScore, citedByCount, work]
  for (const cand of info.title_candidates || []) {
    const data = await oaGet("/works", { search: cand, per_page: 5, select: WORK_SELECT });
    for (const w of (data || {}).results || []) {
      const s = sim(cand, w.title || w.display_name);
      cands.push([s, w.cited_by_count || 0, w]);
    }
    await sleep(200);
  }

  let best = null, bestSim = 0.0;
  if (cands.length) {
    const strong = cands.filter((c) => c[0] >= SIM_HIGH);
    if (strong.length) {
      const top = strong.reduce((x, y) => (y[1] > x[1] ? y : x));
      bestSim = top[0]; best = top[2];
    } else {
      const top = cands.reduce((x, y) => (y[0] > x[0] ? y : x));
      bestSim = top[0]; best = top[2];
    }
    if (bestSim >= SIM_MIN) {
      const conf = bestSim >= SIM_HIGH ? "high" : "medium";
      return finalizeMatch(result, best, "title", conf, Math.round(bestSim * 1000) / 1000);
    }
  }

  // 3) Crossref fallback -> DOI -> OpenAlex
  for (const cand of info.title_candidates || []) {
    const doi = await crossrefDoi(cand);
    if (doi) {
      const work = await oaGet(`/works/doi:${doi}`, { select: WORK_SELECT });
      if (work && work.id) {
        const s = sim(cand, work.title || work.display_name);
        if (s >= SIM_MIN) {
          const conf = s >= SIM_HIGH ? "high" : "medium";
          return finalizeMatch(result, work, "crossref+doi", conf, Math.round(s * 1000) / 1000);
        }
      }
    }
  }

  // Not confidently identified -> report honestly, no references.
  result.note =
    "Not confidently identified in OpenAlex/Crossref. This is common for " +
    "very recent working papers or preprints not yet indexed. References " +
    "are omitted rather than guessed.";
  if (best !== null) {
    result.sim = Math.round(bestSim * 1000) / 1000;
    result.note += ` (best candidate match similarity=${bestSim.toFixed(2)})`;
  }
  return result;
}

function finalizeMatch(result, work, method, confidence, simScore) {
  return Object.assign(result, {
    matched: true,
    confidence,
    method,
    openalex_id: String(work.id || "").split("/").pop() || null,
    title: work.title || work.display_name || null,
    year: work.publication_year ?? null,
    venue: venueOf(work),
    doi: String(work.doi || "").replace("https://doi.org/", "") || null,
    referenced_work_ids: (work.referenced_works || []).map((w) => String(w || "").split("/").pop()),
    sim: simScore,
  });
}

async function crossrefDoi(title) {
  const url = new URL(CROSSREF + "/works");
  url.searchParams.set("query.bibliographic", title);
  url.searchParams.set("rows", "3");
  url.searchParams.set("mailto", MAILTO);
  try {
    const r = await CR_SEM.run(() => fetch(url));
    if (r.status !== 200) return null;
    const data = await r.json();
    for (const it of ((data.message || {}).items) || []) {
      const t = (it.title || []).join(" ");
      if (sim(title, t) >= SIM_MIN && it.DOI) return it.DOI;
    }
  } catch (_e) {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reference resolution (authoritative, batch)
// ---------------------------------------------------------------------------
/**
 * Batch-resolve OpenAlex work IDs to real reference records (batches of 50,
 * per_page=50). Returns {references, requested, resolved}. Unresolved IDs are
 * counted but never fabricated.
 */
export async function resolveReferences(referencedIds) {
  const ids = (referencedIds || []).filter(Boolean);
  const resolved = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const filt = "openalex_id:" + batch.join("|");
    const data = await oaGet("/works", { filter: filt, per_page: 50, select: WORK_SELECT_LITE });
    for (const w of (data || {}).results || []) {
      const ref = workToRef(w);
      if (ref.openalex_id && ref.title) resolved.set(ref.openalex_id, ref);
    }
    await sleep(200);
  }
  const refs = [...resolved.values()];
  refs.sort((a, b) => ((b.year || 0) - (a.year || 0)) || String(a.venue).localeCompare(String(b.venue)));
  return { references: refs, requested: ids.length, resolved: refs.length };
}

// ---------------------------------------------------------------------------
// Venue composition
// ---------------------------------------------------------------------------
export function venueComposition(references) {
  const counts = new Map();
  for (const r of references) {
    const v = r.venue || "(unknown)";
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const items = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  const out = [];
  let pidx = 0;
  for (const [venue, count] of items) {
    let color;
    if (venue in PINNED_VENUE_COLORS || venue === "(unknown)") {
      color = colorForVenue(venue, 0);
    } else {
      color = colorForVenue(venue, pidx);
      pidx += 1;
    }
    out.push({ venue, count, color });
  }
  return out;
}

// ===========================================================================
// References-section recovery from PDF text (port of pdf_references.py)
// ===========================================================================
// Used when a found preprint has empty referenced_works. The parsed reference
// string is only ever used as a *search query* — every displayed field comes
// from the resolved database record. Anything that fails the confidence gate
// is DROPPED, not guessed.

const RECALL_MIN = 0.72;          // fraction of matched-title tokens in entry
const CROSSREF_SCORE_MIN = 40.0;
const MAX_ENTRIES = 90;           // bound work per paper; report if truncated

const ARXIV_RE = /arxiv[:/\s]*?(\d{4}\.\d{4,5})(?:v\d+)?/gi;
const ARXIV_URL_RE = /arxiv\.org\/abs\/\s*(\d{4}\.\d{4,5})/gi;
const REF_DOI_RE = /10\.\d{4,9}\/[-._;()/:a-z0-9]+/gi;
const YEAR_RE = /\b(?:19|20)\d{2}\b/;
const YEAR_RE_G = /\b(?:19|20)\d{2}\b/g;

// A line that begins a new author-year reference, e.g.
//   "Abbas M, Jam F A, Khan T I (2024) ..."   "Alavi M (1994) ..."
//   "Joeran Beel, Min-Yen Kan, and Moritz Baumgart. An evaluation ..."
const REF_START_RE = /^[A-ZÀ-Þ][A-Za-zÀ-ÿ’'-]+,?\s+[A-ZÀ-Þ]/;

/** Return the text of the first (main) reference list, trimmed at the next
 *  reference heading / appendix / end. `fullText` is the whole PDF's text. */
export function extractReferencesSection(fullText) {
  const headingRe = /\n[ \t]*(References|REFERENCES|Bibliography|BIBLIOGRAPHY|Works Cited|Literature Cited)[ \t]*\n/g;
  const m = headingRe.exec(fullText);
  if (!m) return null;
  const rest = fullText.slice(m.index + m[0].length);
  const stop = /\n[ \t]*(Appendix|APPENDIX|Supplementary|SUPPLEMENTARY|References|REFERENCES|Bibliography|BIBLIOGRAPHY)\b/.exec(rest);
  return stop ? rest.slice(0, stop.index) : rest;
}

function dehyphenate(text) {
  text = text.replace(/­/g, "");                 // soft hyphen
  text = text.replace(/(\w)-\n(\w)/g, "$1$2");        // word-break hyphenation
  return text;
}

/**
 * Split a references section into individual reference strings.
 * Strategy A: blank-line separated entries. Strategy B: author-year line
 * starts. Pick whichever yields more entries containing a year, then merge
 * yearless fragments into the previous entry (they are continuations).
 */
export function splitReferenceEntries(section) {
  section = dehyphenate(section);

  const a = section.split(/\n[ \t]*\n/).filter((c) => c.trim());
  const b = splitAuthorYear(section);

  const score = (entries) => entries.filter((e) => YEAR_RE.test(e)).length;
  const chosen = score(a) >= score(b) ? a : b;

  const merged = [];
  for (let e of chosen) {
    e = e.replace(/\s+/g, " ").trim();
    if (!e) continue;
    if (!YEAR_RE.test(e) && merged.length) {
      merged[merged.length - 1] = (merged[merged.length - 1] + " " + e).trim();
    } else {
      merged.push(e);
    }
  }
  return merged.filter((e) => YEAR_RE.test(e) && e.length >= 20 && e.length <= 700);
}

function splitAuthorYear(section) {
  const entries = [];
  let cur = [];
  for (const ln of section.split("\n")) {
    const s = ln.trim();
    if (!s) continue;
    if (REF_START_RE.test(s) && cur.length) {
      entries.push(cur.join(" "));
      cur = [s];
    } else {
      cur.push(s);
    }
  }
  if (cur.length) entries.push(cur.join(" "));
  return entries;
}

/** Fraction of the matched title's content tokens present in the parsed
 *  reference string. High recall => the match really is this reference. */
function titleRecall(entry, title) {
  const nt = norm(title), ne = norm(entry);
  const toks = nt.split(" ").filter((t) => t.length > 2);
  if (toks.length < 3) return 0.0;
  const neSet = new Set(ne.split(" "));
  return toks.filter((t) => neSet.has(t)).length / toks.length;
}

const TITLE_AFTER_YEAR = /\((?:19|20)\d{2}[a-z]?\)\.?\s*([\s\S]+)/;
const TITLE_AFTER_PAREN = /\)\.?\s*([\s\S]+)/;

/** Best-effort title fragment from an author-year reference. */
function titleGuess(entry) {
  const m = TITLE_AFTER_YEAR.exec(entry) || TITLE_AFTER_PAREN.exec(entry);
  let t = m ? m[1] : entry;
  t = t.split(/\.\s+(?=[A-Z(])/)[0]; // up to first real sentence break
  return t.replace(/\s+/g, " ").trim().slice(0, 240);
}

function yearOk(entry, year) {
  // The matched record's year must agree with a year stated in the entry
  // (allowing off-by-one for preprint vs publication).
  if (!year) return true;
  const entryYears = findAll(YEAR_RE_G, entry);
  if (!entryYears.length) return true;
  return entryYears.some((y) => Math.abs(parseInt(y, 10) - year) <= 1);
}

/** Phase 1: resolve an entry to a candidate, or null if not confident. */
async function entryCandidate(entry) {
  // a) explicit arXiv id
  const arxivIds = findAll(ARXIV_URL_RE, entry).concat(findAll(ARXIV_RE, entry));
  if (arxivIds.length) {
    return { doi: `10.48550/arXiv.${arxivIds[0]}`, match_by: "arxiv-id", match_conf: "high", cr: null };
  }

  // b) explicit DOI in the reference text
  for (let d of findAll(REF_DOI_RE, entry)) {
    d = d.replace(/[).,;]+$/, "");
    if (!d.toLowerCase().startsWith("10.48550")) {
      return { doi: d, match_by: "doi", match_conf: "high", cr: null };
    }
  }

  // c) OpenAlex title search (fast). Gate on title-recall vs the full entry.
  const tg = titleGuess(entry);
  if (tg.length >= 8) {
    const data = await oaGet("/works", { search: tg, per_page: 3, select: WORK_SELECT_LITE });
    const works = (data || {}).results || [];
    let best = null, bestRec = 0.0;
    for (const w of works) {
      const rec = titleRecall(entry, w.title || w.display_name || "");
      if (rec > bestRec) { best = w; bestRec = rec; }
    }
    if (best && bestRec >= RECALL_MIN && yearOk(entry, best.publication_year)) {
      const ref = workToRef(best);
      if (ref.title) {
        return { ref, match_by: "title-search", match_conf: bestRec >= 0.9 ? "high" : "medium" };
      }
    }
  }

  // d) Crossref bibliographic fallback (thorough), same recall+score+year gate
  const items = await crossrefBibliographic(entry);
  if (!items || !items.length) return null;
  let best = null, bestRecall = 0.0;
  for (const it of items) {
    const rec = titleRecall(entry, (it.title || []).join(" "));
    if (rec > bestRecall) { best = it; bestRecall = rec; }
  }
  if (!best || bestRecall < RECALL_MIN || (best.score || 0.0) < CROSSREF_SCORE_MIN) return null;
  if (!yearOk(entry, crossrefYear(best))) return null;
  if (!best.DOI) return null;
  return { doi: best.DOI, match_by: "bibliographic", match_conf: "medium", cr: best };
}

async function entryCandidateSafe(entry) {
  try { return await entryCandidate(entry); }
  catch (_e) { return null; }
}

/** Phase 2: resolve many DOIs to authoritative OpenAlex records at once. */
async function batchResolveDois(dois) {
  const out = new Map();
  const list = [...dois].filter(Boolean);
  for (let i = 0; i < list.length; i += 50) {
    const batch = list.slice(i, i + 50);
    const filt = "doi:" + batch.join("|");
    const data = await oaGet("/works", { filter: filt, per_page: 50, select: WORK_SELECT_LITE });
    for (const w of (data || {}).results || []) {
      const ref = workToRef(w);
      const key = (ref.doi || "").toLowerCase();
      if (key && ref.title) out.set(key, ref);
    }
    await sleep(200);
  }
  return out;
}

/** Build a reference record from Crossref metadata (used only when a DOI is
 *  genuinely absent from OpenAlex). */
function crToRef(item) {
  return {
    openalex_id: null,
    title: (item.title || []).join(" "),
    year: crossrefYear(item),
    venue: normalizeVenue((item["container-title"] || []).join(" ")) || "(unknown)",
    type: item.type ?? null,
    doi: item.DOI ?? null,
    authors: crossrefAuthors(item),
  };
}

/** Crossref bibliographic search, rate-limited and retried on throttling. */
async function crossrefBibliographic(entry) {
  const url = new URL(CROSSREF + "/works");
  url.searchParams.set("query.bibliographic", entry);
  url.searchParams.set("rows", "3");
  url.searchParams.set("mailto", MAILTO);
  url.searchParams.set("select", "DOI,title,score,container-title,issued,author,type");
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try {
      r = await CR_SEM.run(() => fetch(url));
    } catch (_e) {
      await sleep(600 * (attempt + 1));
      continue;
    }
    if (r.status === 200) {
      const data = await r.json();
      return ((data.message || {}).items) || [];
    }
    if ([429, 500, 502, 503].includes(r.status)) {
      await sleep(1000 + 1200 * attempt);
      continue;
    }
    return null;
  }
  return null;
}

function crossrefYear(item) {
  try {
    const y = item.issued["date-parts"][0][0];
    return y ?? null;
  } catch (_e) {
    return null;
  }
}

function crossrefAuthors(item, limit = 8) {
  const out = [];
  for (const a of (item.author || []).slice(0, limit)) {
    const nm = [a.given, a.family].filter(Boolean).join(" ");
    if (nm) out.push(nm);
  }
  return out;
}

/** Split-independent identifier sweep: every explicit arXiv id / DOI in the
 *  section becomes a candidate, so imperfect segmentation never loses an
 *  identifier-bearing reference. */
function identifierCandidates(section) {
  const cands = [];
  const seen = new Set();
  const arxivIds = new Set([...findAll(ARXIV_URL_RE, section), ...findAll(ARXIV_RE, section)]);
  for (const v of arxivIds) {
    const doi = `10.48550/arXiv.${v}`;
    if (!seen.has(doi.toLowerCase())) {
      seen.add(doi.toLowerCase());
      cands.push({ doi, match_by: "arxiv-id", match_conf: "high", cr: null });
    }
  }
  for (let d of findAll(REF_DOI_RE, section)) {
    d = d.replace(/[).,;]+$/, "");
    const dl = d.toLowerCase();
    if (dl.startsWith("10.48550") || seen.has(dl)) continue;
    seen.add(dl);
    cands.push({ doi: d, match_by: "doi", match_conf: "high", cr: null });
  }
  return cands;
}

/**
 * Best-effort recovery of references straight from the PDF's full text, each
 * resolved to an authoritative record. Returns {references, stats}.
 */
export async function recoverReferencesFromText(fullText) {
  const section = extractReferencesSection(fullText);
  if (!section) {
    return { references: [], stats: {
      parsed: 0, resolved: 0, truncated: false,
      note: "No References section detected in the PDF." } };
  }

  let entries = splitReferenceEntries(section);
  const truncated = entries.length > MAX_ENTRIES;
  entries = entries.slice(0, MAX_ENTRIES);
  if (!entries.length) {
    return { references: [], stats: {
      parsed: 0, resolved: 0, truncated: false,
      note: "Could not segment the References section into entries." } };
  }

  // Phase 1: each entry -> a candidate (already-resolved record, or a DOI to
  // batch-resolve). Modest parallelism; provider semaphores cap real traffic.
  const cands = (await mapPool(entries, 6, entryCandidateSafe)).filter(Boolean);

  // Identifier sweep over the whole section.
  cands.push(...identifierCandidates(section));

  // Phase 2 (batch): resolve the DOI-only candidates in bulk.
  const dois = new Set(cands.filter((c) => c.doi && !c.ref).map((c) => c.doi.toLowerCase()));
  const oaMap = await batchResolveDois(dois);

  // Phase 3: assemble + dedup. Prefer an already-resolved/OpenAlex record;
  // fall back to Crossref metadata only when the DOI is absent from OpenAlex;
  // otherwise drop (never guess).
  const seen = new Set();
  const refs = [];
  for (const c of cands) {
    let base = c.ref || null;
    if (!base) {
      const doi = (c.doi || "").toLowerCase();
      base = oaMap.get(doi) || null;
      if (!base && c.cr) base = crToRef(c.cr);
    }
    if (!base) continue;
    const ref = { ...base, match_by: c.match_by, match_conf: c.match_conf };
    const key = ref.openalex_id || ref.doi || norm(ref.title || "");
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }

  refs.sort((a, b) => ((b.year || 0) - (a.year || 0)) ||
    String(a.venue || "").localeCompare(String(b.venue || "")));
  return {
    references: refs,
    stats: { parsed: entries.length, resolved: refs.length, truncated, note: null },
  };
}

// ---------------------------------------------------------------------------
// Full single-paper pipeline
// ---------------------------------------------------------------------------
/**
 * Analyze one paper from already-extracted PDF info:
 *   info = { page_count, meta_title, title_candidates, dois, full_text }
 * (produced in the browser by pdf-extract.js; any source of the same shape
 * works in Node). Returns the same paper object shape as the old
 * /api/analyze response's papers[i].
 */
export async function analyzePdf(filename, info) {
  const ident = await identifyPaper(info);

  const paper = {
    filename,
    page_count: info.page_count ?? null,
    extracted_title: (info.title_candidates || [null])[0] ?? null,
    extracted_dois: info.dois || [],
    identification: ident,
    references: [],
    reference_source: null, // 'database' | 'pdf-recovered' | null
    reference_stats: { requested: 0, resolved: 0 },
    venue_composition: [],
  };

  if (ident.matched && ident.referenced_work_ids.length) {
    // Authoritative path: the database has this paper's reference list.
    const res = await resolveReferences(ident.referenced_work_ids);
    for (const r of res.references) {
      if (r.match_by === undefined) r.match_by = "database";
      if (r.match_conf === undefined) r.match_conf = "high";
    }
    paper.references = res.references;
    paper.reference_source = "database";
    paper.reference_stats = { requested: res.requested, resolved: res.resolved };
    paper.venue_composition = venueComposition(res.references);
  } else {
    // Fallback path: preprint/working paper with no reference list in any
    // database (or not matched). Recover references straight from the PDF.
    let rec;
    try {
      rec = await recoverReferencesFromText(info.full_text || "");
    } catch (e) {
      rec = { references: [], stats: {
        parsed: 0, resolved: 0, truncated: false,
        note: `PDF reference recovery failed: ${e && e.name ? e.name : "Error"}.` } };
    }
    if (rec && rec.references.length) {
      paper.references = rec.references;
      paper.reference_source = "pdf-recovered";
      const st = rec.stats;
      paper.reference_stats = {
        requested: st.parsed, resolved: st.resolved,
        parsed: st.parsed, truncated: st.truncated || false,
        note: "References were recovered directly from the PDF and " +
              "resolved against Crossref/OpenAlex; entries that could " +
              "not be confidently resolved were omitted.",
      };
      paper.venue_composition = venueComposition(rec.references);
    } else {
      const note = (rec && rec.stats.note) ||
        (ident.matched
          ? "Paper identified, but no reference list is available in any " +
            "database and none could be recovered from the PDF."
          : "Paper not confidently identified; references omitted.");
      paper.reference_stats.note = note;
    }
  }
  return paper;
}

// ===========================================================================
// Cross-paper citation graph (port of app.py build_graph)
// ===========================================================================
export function buildGraph(papers) {
  const nodes = [], edges = [];

  // Map OpenAlex id -> uploaded paper index (for direct-citation detection).
  const oaToIdx = new Map();
  papers.forEach((p, i) => {
    const oid = (p.identification || {}).openalex_id;
    if (oid) oaToIdx.set(oid, i);
  });

  papers.forEach((p, i) => {
    const ident = p.identification || {};
    nodes.push({
      id: `P${i}`,
      type: "paper",
      label: shortLabel(p),
      title: ident.title || p.extracted_title || p.filename,
      venue: normalizeVenue(ident.venue) || "(unidentified)",
      year: ident.year ?? null,
      matched: Boolean(ident.matched),
      confidence: ident.confidence ?? null,
      ref_count: (p.reference_stats || {}).resolved || 0,
      color: paperNodeColor(ident),
      doi: ident.doi ?? null,
      url: entityUrl(ident.doi, ident.openalex_id),
    });
  });

  // Direct citations among uploaded papers.
  papers.forEach((p, i) => {
    const ident = p.identification || {};
    for (const refId of ident.referenced_work_ids || []) {
      const j = oaToIdx.get(refId);
      if (j !== undefined && j !== i) {
        edges.push({ from: `P${i}`, to: `P${j}`, kind: "direct" });
      }
    }
  });

  // Shared references: cited by >= 2 uploaded papers.
  const refIndex = new Map(); // openalex_id -> {ref, citers:Set}
  papers.forEach((p, i) => {
    for (const r of p.references || []) {
      const oid = r.openalex_id;
      if (!oid) continue;
      let entry = refIndex.get(oid);
      if (!entry) { entry = { ref: r, citers: new Set() }; refIndex.set(oid, entry); }
      entry.citers.add(i);
    }
  });

  const shared = new Map();
  for (const [oid, e] of refIndex) {
    if (e.citers.size >= 2 && !oaToIdx.has(oid)) shared.set(oid, e);
  }

  for (const [oid, e] of shared) {
    const r = e.ref;
    const venue = r.venue || "(unknown)";
    nodes.push({
      id: `R_${oid}`,
      type: "shared_ref",
      label: wrap(r.title || "", 28),
      title: r.title ?? null,
      venue,
      year: r.year ?? null,
      shared_by: e.citers.size,
      color: colorForVenue(normalizeVenue(venue), 6),
      doi: r.doi ?? null,
      authors: r.authors || [],
      url: entityUrl(r.doi, oid),
      citers: [...e.citers].sort((a, b) => a - b)
        .map((i) => ({ id: `P${i}`, label: citerLabel(papers[i]) })),
    });
    for (const i of e.citers) {
      edges.push({ from: `P${i}`, to: `R_${oid}`, kind: "shared" });
    }
  }

  return {
    nodes,
    edges,
    stats: {
      papers: papers.length,
      direct_citations: edges.filter((e) => e.kind === "direct").length,
      shared_references: shared.size,
    },
  };
}

function entityUrl(doi, openalexId) {
  // Best external link for a work: DOI first, then its OpenAlex landing page.
  if (doi) return `https://doi.org/${doi}`;
  if (openalexId) return `https://openalex.org/${openalexId}`;
  return null;
}

function citerLabel(p) {
  const ident = p.identification || {};
  const title = ident.title || p.extracted_title || p.filename || "paper";
  const year = ident.year;
  const short = title.length <= 48 ? title : title.slice(0, 46).trimEnd() + "…";
  return year ? `${short} (${year})` : short;
}

function shortLabel(p) {
  const ident = p.identification || {};
  const title = ident.title || p.extracted_title || p.filename;
  const year = ident.year;
  let base = wrap(title || "paper", 26);
  if (year) base += `\n(${year})`;
  return base;
}

function paperNodeColor(ident) {
  if (!ident.matched) return "#6b7280"; // gray: unidentified
  const venue = normalizeVenue(ident.venue);
  if (venue && venue in PINNED_VENUE_COLORS) return PINNED_VENUE_COLORS[venue];
  return "#1f2937"; // dark slate for identified papers (distinct from refs)
}

function wrap(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (cur.length + w.length + 1 > width) {
      lines.push(cur);
      cur = w;
      if (lines.length >= 3) { cur += "…"; break; }
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur && lines.length < 3) lines.push(cur);
  return lines.join("\n");
}
