/*
 * Node smoke test for the ported client-side pipeline (core.js).
 * Runs against the LIVE OpenAlex API — proves the identification +
 * reference-resolution path works outside a browser.
 *
 *   node server-prototype/tests/smoke.mjs
 */
import * as core from "../../core.js";

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok  :", msg);
}

// 1) similarity function sanity (same thresholds as the Python original)
const s = core.sim(
  "Design Science in Information Systems Research",
  "Design science in information systems research"
);
assert(s === 1.0, `sim() exact-after-normalization = ${s}`);
assert(core.sim("Design Science in IS Research", "Completely different title") < core.SIM_MIN,
  "sim() rejects unrelated titles");

// 2) identify a known paper by title via live OpenAlex
const info = {
  page_count: null,
  meta_title: null,
  title_candidates: ["Design Science in Information Systems Research"],
  dois: [],
  full_text: "",
};
const ident = await core.identifyPaper(info);
console.log("identified:", {
  matched: ident.matched, method: ident.method, confidence: ident.confidence,
  openalex_id: ident.openalex_id, title: ident.title, year: ident.year,
  venue: ident.venue, doi: ident.doi, sim: ident.sim,
  referenced: ident.referenced_work_ids.length,
});
assert(ident.matched, "paper matched");
assert(ident.method === "title", "matched via title search");
assert(ident.confidence === "high", "high confidence");
assert(ident.venue === "MIS Quarterly", `venue normalized to MIS Quarterly (got ${ident.venue})`);
assert(ident.referenced_work_ids.length > 0, `referenced_works non-empty (${ident.referenced_work_ids.length})`);

// 3) batch-resolve the references
const res = await core.resolveReferences(ident.referenced_work_ids);
console.log(`references: requested=${res.requested} resolved=${res.resolved}`);
assert(res.resolved > 0 && res.resolved <= res.requested, "references resolved within bounds");
const sample = res.references[0];
assert(sample.title && (sample.year || sample.venue), "resolved refs carry real metadata");
console.log("sample ref:", { title: sample.title, year: sample.year, venue: sample.venue, doi: sample.doi });

// 4) venue composition + graph builder shapes
const comp = core.venueComposition(res.references);
assert(comp.length > 0 && comp[0].venue && comp[0].count > 0 && comp[0].color, "venue composition shape");
const misq = comp.find((c) => c.venue === "MIS Quarterly");
if (misq) assert(misq.color === "#dc2626", "MISQ pinned crimson");

const paper = {
  filename: "smoke.pdf", page_count: null, extracted_title: info.title_candidates[0],
  extracted_dois: [], identification: ident, references: res.references,
  reference_source: "database",
  reference_stats: { requested: res.requested, resolved: res.resolved },
  venue_composition: comp,
};
const graph = core.buildGraph([paper, paper]);
assert(graph.nodes.filter((n) => n.type === "paper").length === 2, "graph has 2 paper nodes");
assert(typeof graph.stats.shared_references === "number", "graph stats present");

// 5) references-section parsing (offline check of the recovery splitter)
const fakeSection = "\nReferences\nAlavi M, Leidner D E (2001) Review: Knowledge management and knowledge management systems. MIS Quarterly 25(1):107-136.\nHevner A R, March S T, Park J, Ram S (2004) Design science in information systems research. MIS Quarterly 28(1):75-105.\n";
const sec = core.extractReferencesSection(fakeSection);
const entries = core.splitReferenceEntries(sec);
assert(entries.length === 2, `splitter found 2 entries (got ${entries.length})`);

console.log("\nSMOKE TEST PASSED");
