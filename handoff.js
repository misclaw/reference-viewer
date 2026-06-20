/* Cross-app handoff: encode discovered papers into a URL fragment that
 * mis-lit-reviewer reads to add them to one or more streams.
 *
 * reference-viewer and mis-lit-reviewer are SEPARATE origins, so we can't touch
 * the reviewer's localStorage from here. Instead we open the reviewer with the
 * selection encoded in the URL hash (#add=…) and let the reviewer — first-party
 * to its own store — show the stream picker. The hash never reaches a server.
 *
 * Wire contract (must stay in sync with mis-lit-reviewer/src/handoff.js):
 *   <REVIEWER_URL>#add=<base64url(utf8(JSON))>
 *   JSON = { v:1, src:"reference-viewer",
 *            papers:[ {title, authors:[…], year, venue, doi, url, col} ] }
 *   col ∈ journal | conference | preprint
 */

export const REVIEWER_URL = "https://mis-lit-reviewer.misclaw.app/";

// Keep payloads inside what a URL fragment comfortably holds; disclose, never
// silently truncate (see encodeHandoff).
const MAX_PAPERS = 40;
const MAX_BYTES = 30000;

// --- base64url(utf8) round-trip (unicode-safe) ---
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Light venue → column heuristic so papers land in a sensible column; the user
// can re-file later in the reviewer. Faithful-enough, never authoritative.
export function guessCol(venue) {
  const v = (venue || "").toLowerCase();
  if (/\b(arxiv|ssrn|preprint|working\s+paper|mpra|biorxiv|medrxiv|osf|repec)\b/.test(v)) return "preprint";
  if (/\b(proceedings|conference|conf\.|workshop|symposium|congress|icis|hicss|ecis|pacis|amcis|chi|cscw|kdd|neurips|acl|emnlp|sigir|sigmod|vldb|www)\b/.test(v)) return "conference";
  return "journal";
}

// Stable identity for de-duping the tray and matching against existing papers:
// DOI when present, else normalized title + year.
export function paperKey(r) {
  if (r && r.doi) return String(r.doi).trim().toLowerCase();
  const t = String((r && r.title) || "").toLowerCase().replace(/\s+/g, " ").trim();
  return t + "|" + ((r && r.year) || "");
}

function trim(r) {
  return {
    title: r.title || null,
    authors: Array.isArray(r.authors) ? r.authors.slice(0, 12) : [],
    year: r.year ?? null,
    venue: r.venue || null,
    doi: r.doi || null,
    url: r.url || (r.doi ? "https://doi.org/" + encodeURIComponent(r.doi) : null),
    col: guessCol(r.venue),
  };
}

function payloadFor(records) {
  return "add=" + b64urlEncode(JSON.stringify({ v: 1, src: "reference-viewer", papers: records }));
}

/**
 * Build the reviewer URL for a selection of papers.
 * Returns { url, sent, total, dropped }. Honors a size cap on both paper count
 * and encoded bytes; callers should disclose `dropped` to the user.
 */
export function encodeHandoff(papers) {
  const all = papers.map(trim);
  let n = Math.min(all.length, MAX_PAPERS);
  let frag = payloadFor(all.slice(0, n));
  while (n > 1 && frag.length > MAX_BYTES) {
    n -= 1;
    frag = payloadFor(all.slice(0, n));
  }
  return { url: REVIEWER_URL + "#" + frag, sent: n, total: all.length, dropped: all.length - n };
}
