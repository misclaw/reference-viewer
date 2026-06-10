/*
 * pdf-extract.js
 * ==============
 * Browser-side PDF text extraction (pdfjs-dist via CDN, pinned version).
 * Produces exactly the info shape that core.js's analyzePdf() expects:
 *
 *   { page_count, meta_title, title_candidates, dois, full_text }
 *
 * The pure text-layout logic (line grouping, largest-font title heuristic,
 * DOI scan) lives in pdf-text.js so the Node smoke test can exercise the
 * identical code with pdfjs-dist's legacy build.
 */

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import { linesFromTextContent, buildPdfInfo } from "./pdf-text.js";

const WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

// A cross-origin worker URL cannot be passed to `new Worker()` directly, so
// fetch the (CORS-enabled) worker script and load it from a same-origin blob
// URL. If that fails, fall back to the plain URL: pdf.js then runs its "fake
// worker" on the main thread, which is slower but correct.
const workerReady = (async () => {
  try {
    const src = await (await fetch(WORKER_URL)).text();
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
      new Blob([src], { type: "text/javascript" }));
  } catch (_e) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;
  }
})();

/**
 * Extract candidate title(s), DOI(s), full per-page text, and basic metadata
 * from PDF bytes (ArrayBuffer or Uint8Array).
 */
export async function extractPdfInfo(data) {
  await workerReady;
  const pdf = await pdfjsLib.getDocument({
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
  }).promise;

  try {
    let metaTitle = "";
    try {
      const md = await pdf.getMetadata();
      metaTitle = ((md.info || {}).Title || "").trim();
    } catch (_e) { /* metadata is optional */ }

    const pageLines = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      pageLines.push(linesFromTextContent(tc.items, page.view[3] - page.view[1]));
      page.cleanup();
    }

    return buildPdfInfo(metaTitle, pageLines);
  } finally {
    pdf.destroy();
  }
}
