/*
 * pdf-text.js
 * ===========
 * Pure text-layout logic shared by pdf-extract.js (browser, pdfjs-dist via
 * CDN) and the Node smoke tests (pdfjs-dist legacy build from npm). No DOM,
 * no imports — operates on pdf.js `getTextContent()` items only.
 *
 * Ported from the PyMuPDF-based extract_pdf_info() / _largest_font_title()
 * in server-prototype/reference_core.py.
 */

const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;

function cleanDoi(d) {
  return d.replace(/[).,;]+$/, "").trim();
}

/**
 * Group a page's text items into visual lines: [{ y, size, text }], sorted
 * top-to-bottom. `size` is the largest glyph height on the line (the
 * equivalent of PyMuPDF's max span size per line).
 *
 * @param items      pdf.js textContent.items
 * @param pageHeight page height in user-space units (view[3] - view[1])
 */
export function linesFromTextContent(items, pageHeight) {
  // Collect positioned fragments (pdf.js y origin is bottom-left; flip it).
  const frags = [];
  for (const it of items) {
    if (!("str" in it) || !it.str.trim()) continue;
    const size = Math.hypot(it.transform[2], it.transform[3]);
    frags.push({
      x: it.transform[4],
      y: pageHeight - it.transform[5], // top-down baseline y
      w: it.width || 0,
      size,
      str: it.str,
    });
  }
  frags.sort((a, b) => (a.y - b.y) || (a.x - b.x));

  // Group fragments into lines by baseline proximity.
  const lines = [];
  let cur = null;
  for (const f of frags) {
    const tol = Math.max(2.5, f.size * 0.4);
    if (cur && Math.abs(f.y - cur.y) <= tol) {
      cur.frags.push(f);
    } else {
      cur = { y: f.y, frags: [f] };
      lines.push(cur);
    }
  }

  return lines.map((ln) => {
    ln.frags.sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd = null;
    let size = 0;
    for (const f of ln.frags) {
      if (f.size > size) size = f.size;
      if (prevEnd !== null && f.x - prevEnd > 1 &&
          text && !text.endsWith(" ") && !f.str.startsWith(" ")) {
        text += " ";
      }
      text += f.str;
      prevEnd = f.x + f.w;
    }
    return { y: ln.y, size: Math.round(size * 10) / 10, text: text.trim() };
  }).filter((l) => l.text);
}

/**
 * Heuristic title detector (port of _largest_font_title): the first
 * contiguous block of lines set in the largest font on page 1, stopping at
 * the first large vertical gap (so author names set in the *same* font as
 * the title are not swept into the title).
 */
export function largestFontTitle(lines) {
  if (!lines || !lines.length) return null;
  const maxSz = Math.max(...lines.map((l) => l.size));

  const titleLines = [];
  let prevY = null;
  for (const { y, size, text } of lines) {
    if (size < maxSz - 0.5) continue;
    if (prevY !== null && y - prevY > 2.0 * maxSz) break; // gap -> authors begin
    titleLines.push(text);
    prevY = y;
  }
  const title = titleLines.join(" ").replace(/\s+/g, " ").trim();
  return title.length >= 8 && title.length <= 300 ? title : null;
}

/**
 * Assemble the info object the pipeline (core.analyzePdf) expects, from
 * already-extracted per-page line arrays + the PDF metadata title.
 *
 * @param metaTitle  PDF metadata Title (or null)
 * @param pageLines  array of per-page `linesFromTextContent` results
 */
export function buildPdfInfo(metaTitle, pageLines) {
  metaTitle = (metaTitle || "").trim();
  const bigTitle = pageLines.length ? largestFontTitle(pageLines[0]) : null;
  const pageTexts = pageLines.map((lines) => lines.map((l) => l.text).join("\n"));

  // DOI: scan only the first 2 pages so we get the *paper's own* DOI, not
  // DOIs that appear inside the reference list. De-dup, preserve order.
  const headText = pageTexts.slice(0, 2).join("\n");
  const seen = new Set();
  const dois = [];
  for (const m of headText.matchAll(DOI_RE)) {
    const d = cleanDoi(m[0]);
    if (!seen.has(d.toLowerCase())) { seen.add(d.toLowerCase()); dois.push(d); }
  }

  const candidates = [];
  for (const t of [metaTitle, bigTitle]) {
    if (t && t.length > 8 && !candidates.includes(t)) candidates.push(t);
  }

  return {
    page_count: pageLines.length,
    meta_title: metaTitle || null,
    title_candidates: candidates,
    dois,
    full_text: pageTexts.join("\n"),
  };
}
