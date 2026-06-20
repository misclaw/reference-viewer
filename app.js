/* Reference Viewer — frontend logic (fully client-side: the analysis
 * pipeline runs in the browser; OpenAlex/Crossref are queried directly). */
import * as core from "./core.js";
import { extractPdfInfo } from "./pdf-extract.js";

(() => {
  "use strict";

  // Example PDFs served statically from ./examples (each < 25 MiB,
  // the Cloudflare Pages per-file limit).
  const EXAMPLES = [
    "bapna_etal2025_agentic_ai_analytics.pdf",
    "hevner_etal2004_design_science.pdf",
    "li_etal2026_chatgpt_learning.pdf",
    "sun_etal2025_voice_ai.pdf",
    "yamada_etal2025_ai_scientist_v2.pdf",
  ];

  const $ = (id) => document.getElementById(id);
  const fileInput = $("fileInput");
  const fileList = $("fileList");
  const analyzeBtn = $("analyzeBtn");
  const clearBtn = $("clearBtn");
  const dropzone = $("dropzone");

  let queued = []; // File objects
  const charts = []; // Chart.js instances (to destroy on re-render)
  let network = null;
  let lastGraph = null;
  let lastData = null; // full last analysis result (for export)

  // ---- theme (dark / light) -----------------------------------------
  const cssVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function persistTheme(theme) {
    // Pin to a cookie on .misclaw.app so the light/dark choice stays in sync
    // across every *.misclaw.app site; localStorage is the same-origin fallback.
    try {
      localStorage.setItem("theme", theme);
      localStorage.setItem("refmap-theme", theme);
    } catch (_) {}
    try {
      let c = "mc-theme=" + theme + ";path=/;max-age=31536000;samesite=lax";
      if (location.hostname === "misclaw.app" || location.hostname.endsWith(".misclaw.app")) {
        c += ";domain=.misclaw.app";
      }
      if (location.protocol === "https:") c += ";secure";
      document.cookie = c;
    } catch (_) {}
  }

  function applyTheme(theme) {
    // The sun/moon icons inside #themeToggle swap via [data-theme] CSS rules.
    document.documentElement.dataset.theme = theme;
    persistTheme(theme);
  }

  function restyleForTheme() {
    // Chart slice borders and graph node/edge colors are baked in at render
    // time, so refresh them after a theme switch (positions are preserved).
    const border = cssVar("--chart-border");
    charts.forEach((c) => {
      c.data.datasets[0].borderColor = border;
      c.update("none");
    });
    if (network && lastGraph) drawNetwork(lastGraph, $("toggleShared").checked, true);
  }

  (() => {
    // The pre-paint reader in index.html may have already pinned a theme from
    // the shared .misclaw.app cookie / localStorage — trust it; otherwise follow
    // the system preference.
    const pre = document.documentElement.dataset.theme;
    if (pre === "light" || pre === "dark") { applyTheme(pre); return; }
    const prefersLight = window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: light)").matches;
    applyTheme(prefersLight ? "light" : "dark");
  })();

  $("themeToggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    restyleForTheme();
  });

  // ---- file queue management ----------------------------------------
  function refreshFileList() {
    fileList.innerHTML = "";
    queued.forEach((f, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="fname">📄 ${escapeHtml(f.name)}</span>
        <span class="fsize">${(f.size / 1024 / 1024).toFixed(1)} MB</span>
        <button class="rm" data-i="${i}" title="remove">✕</button>`;
      fileList.appendChild(li);
    });
    fileList.querySelectorAll(".rm").forEach((b) =>
      b.addEventListener("click", (e) => {
        queued.splice(+e.target.dataset.i, 1);
        refreshFileList();
      })
    );
    const has = queued.length > 0;
    analyzeBtn.disabled = !has;
    clearBtn.disabled = !has;
  }

  function addFiles(files) {
    const rejected = [];
    for (const f of files) {
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
      if (!isPdf) { rejected.push(f.name); continue; }
      if (!queued.some((q) => q.name === f.name && q.size === f.size)) queued.push(f);
    }
    showReject(rejected);
    refreshFileList();
  }

  function showReject(names) {
    const el = $("fileReject");
    if (!el) return;
    if (names.length) {
      el.textContent = `Only PDF files are accepted — skipped ${names.length} file(s): ${names.join(", ")}`;
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }

  $("browseBtn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => addFiles(e.target.files));
  clearBtn.addEventListener("click", () => { queued = []; showReject([]); refreshFileList(); });

  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); })
  );
  dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

  // ---- analyze (runs entirely in the browser) ------------------------
  analyzeBtn.addEventListener("click", async () => {
    showProgress(true, "Reading PDF file(s)…");
    $("results").classList.add("hidden");
    try {
      const payloads = await Promise.all(queued.map(async (f) => ({
        name: f.name,
        data: await f.arrayBuffer(),
      })));
      await runAnalysis(payloads);
    } catch (err) {
      showProgress(false);
      alert("Analysis failed: " + err.message);
      console.error(err);
    }
  });

  // "Try the example papers": fetch bundled PDFs over HTTP, then run the
  // exact same client-side pipeline as for uploads.
  $("examplesBtn").addEventListener("click", async () => {
    showProgress(true, `Downloading ${EXAMPLES.length} example PDF(s)…`);
    $("results").classList.add("hidden");
    try {
      const payloads = await Promise.all(EXAMPLES.map(async (name) => {
        const res = await fetch(`examples/${encodeURIComponent(name)}`);
        if (!res.ok) throw new Error(`Could not fetch ${name} (HTTP ${res.status})`);
        return { name, data: await res.arrayBuffer() };
      }));
      await runAnalysis(payloads);
    } catch (err) {
      showProgress(false);
      alert("Analysis failed: " + err.message);
      console.error(err);
    }
  });

  // payloads: [{name, data: ArrayBuffer}] — analyze concurrently (modest
  // parallelism; core.js additionally caps concurrent API calls), then build
  // the cross-paper graph. Output shape matches the old /api/analyze response.
  async function runAnalysis(payloads) {
    showProgress(true);
    let done = 0;
    setProgressText(`Analyzing 0/${payloads.length} paper(s)… (identification + reference resolution)`);
    const papers = await core.mapPool(payloads, 4, async (p) => {
      const paper = await safeAnalyze(p.name, p.data);
      done += 1;
      setProgressText(`Analyzing ${done}/${payloads.length} paper(s)… (identification + reference resolution)`);
      return paper;
    });
    const graph = core.buildGraph(papers);
    render({ papers, graph });
  }

  // Mirror of the server's _safe_analyze: one bad PDF never kills the batch.
  async function safeAnalyze(name, data) {
    try {
      const info = await extractPdfInfo(data);
      return await core.analyzePdf(name, info);
    } catch (e) {
      console.error(`Failed to process ${name}:`, e);
      return {
        filename: name,
        error: `Failed to process: ${e && e.name ? e.name : "Error"}: ${e && e.message ? e.message : e}`,
        identification: { matched: false, confidence: null, note: "Processing error." },
        references: [],
        reference_stats: { requested: 0, resolved: 0 },
        venue_composition: [],
      };
    }
  }

  function showProgress(on, text) {
    $("progress").classList.toggle("hidden", !on);
    if (on && text) setProgressText(text);
  }

  function setProgressText(text) {
    $("progressText").textContent = text;
  }

  // ---- rendering -----------------------------------------------------
  function render(data) {
    showProgress(false);
    lastData = data;
    charts.forEach((c) => c.destroy());
    charts.length = 0;
    $("results").classList.remove("hidden");

    renderSummary(data);
    renderGraph(data.graph);
    renderSharedList(data.graph);
    renderCards(data.papers);
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderSummary(data) {
    const papers = data.papers || [];
    const identified = papers.filter((p) => p.identification && p.identification.matched).length;
    const totalRefs = papers.reduce((s, p) => s + (p.reference_stats?.resolved || 0), 0);
    const venues = new Set();
    papers.forEach((p) => (p.venue_composition || []).forEach((v) => venues.add(v.venue)));
    const g = data.graph?.stats || {};
    const cards = [
      ["Papers", papers.length],
      ["Confidently identified", `${identified}/${papers.length}`],
      ["References resolved", totalRefs],
      ["Distinct venues", venues.size],
      ["Direct citations", g.direct_citations ?? 0],
      ["Shared references", g.shared_references ?? 0],
    ];
    $("summaryBand").innerHTML = cards
      .map(([l, n]) => `<div class="stat-card"><div class="num">${n}</div><div class="lbl">${l}</div></div>`)
      .join("");
  }

  // ---- citation graph (vis-network) ---------------------------------
  function renderGraph(graph) {
    lastGraph = graph;
    hideNodeInfo();
    const panel = $("graphPanel");
    const papers = (graph?.nodes || []).filter((n) => n.type === "paper");
    if (!graph || papers.length < 1) { panel.classList.add("hidden"); return; }
    // Only worth showing the map when there is more than one paper.
    if (papers.length < 2) { panel.classList.add("hidden"); return; }
    panel.classList.remove("hidden");

    const showShared = $("toggleShared").checked;
    drawNetwork(graph, showShared);

    const s = graph.stats || {};
    $("graphStats").textContent =
      `${s.papers} papers · ${s.direct_citations} direct citation(s) · ${s.shared_references} shared reference(s)`;

    const noLinks = (s.direct_citations || 0) === 0 && (s.shared_references || 0) === 0;
    $("graphEmpty").classList.toggle("hidden", !noLinks);

    $("toggleShared").onchange = () => { hideNodeInfo(); drawNetwork(lastGraph, $("toggleShared").checked); };
  }

  // ---- shared references list (works cited by >= 2 uploaded papers) --
  function renderSharedList(graph) {
    const wrap = $("sharedRefs");
    const shared = (graph?.nodes || [])
      .filter((n) => n.type === "shared_ref")
      .sort((a, b) => (b.shared_by - a.shared_by) || ((b.year || 0) - (a.year || 0)));
    if (!shared.length) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");

    const btn = $("sharedToggle");
    const scroll = $("sharedScroll");
    scroll.classList.add("hidden");
    scroll.innerHTML = sharedTable(shared);
    btn.textContent = `Show ${shared.length} shared reference(s) ▾`;
    $("sharedHint").textContent =
      "Works cited by two or more of your uploaded papers — click a title to open it.";
    btn.onclick = () => {
      const hidden = scroll.classList.toggle("hidden");
      btn.textContent = `${hidden ? "Show" : "Hide"} ${shared.length} shared reference(s) ${hidden ? "▾" : "▴"}`;
    };
  }

  function sharedTable(shared) {
    const rows = shared.map((n) => {
      const authors = n.authors && n.authors.length
        ? `<br><span class="muted" style="font-size:11px">${escapeHtml(n.authors.slice(0, 4).join(", "))}${n.authors.length > 4 ? " et al." : ""}</span>`
        : "";
      const titleCell = n.url
        ? `<a href="${escapeHtml(n.url)}" target="_blank" rel="noopener">${escapeHtml(n.title || "(untitled)")}</a>`
        : escapeHtml(n.title || "(untitled)");
      const citers = (n.citers || []).map((c) => c.label).join("; ");
      return `<tr>
        <td>${n.year ?? ""}</td>
        <td>${titleCell}${authors}</td>
        <td><span class="vpill" style="background:${venueColor(n.venue)}">${escapeHtml(n.venue || "(unknown)")}</span></td>
        <td title="${escapeHtml(citers)}" style="font-variant-numeric:tabular-nums">${n.shared_by}</td>
      </tr>`;
    }).join("");
    return `<table class="ref-table">
      <thead><tr><th>Year</th><th>Title</th><th>Venue</th><th>Cited&nbsp;by</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  function drawNetwork(graph, showShared, keepPositions) {
    // Theme-aware colors (kept in CSS so dark/light stay in sync).
    const paperBorder = cssVar("--graph-paper-border");
    const refBorder = cssVar("--graph-ref-border");
    const refFont = cssVar("--graph-ref-font");
    const sharedEdge = cssVar("--graph-edge-shared");

    // When restyling (e.g. theme switch) reuse the current layout so nodes
    // don't jump — capture positions before we tear the network down.
    const positions = (keepPositions && network) ? network.getPositions() : null;

    const nodeById = {};
    const nodes = [];
    const edges = [];
    for (const n of graph.nodes) {
      if (n.type === "shared_ref" && !showShared) continue;
      nodeById[n.id] = n;
      const base = { id: n.id, label: n.label, title: tooltip(n) };
      if (positions && positions[n.id]) { base.x = positions[n.id].x; base.y = positions[n.id].y; }
      if (n.type === "paper") {
        nodes.push({
          ...base, shape: "box",
          color: { background: n.color, border: paperBorder },
          font: { color: "#fff", size: 15, multi: false, face: "Helvetica" },
          borderWidth: n.matched ? 2 : 1,
          shapeProperties: { borderDashes: n.matched ? false : [4, 4] },
          margin: 10,
        });
      } else {
        nodes.push({
          ...base, shape: "dot", size: 8 + 3 * (n.shared_by || 1),
          color: { background: n.color, border: refBorder },
          font: { color: refFont, size: 11 },
        });
      }
    }
    const presentIds = new Set(nodes.map((n) => n.id));
    for (const e of graph.edges) {
      if (!presentIds.has(e.from) || !presentIds.has(e.to)) continue;
      edges.push({
        from: e.from, to: e.to,
        arrows: "to",
        color: { color: e.kind === "direct" ? "#f59e0b" : sharedEdge, opacity: e.kind === "direct" ? 0.9 : 0.6 },
        width: e.kind === "direct" ? 2.5 : 1,
        dashes: e.kind === "shared",
      });
    }

    if (network) network.destroy();
    network = new vis.Network($("network"),
      { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) },
      {
        // Reusing positions => freeze physics so the layout stays put.
        physics: positions ? false : { stabilization: true, barnesHut: { gravitationalConstant: -9000, springLength: 140 } },
        // zoomView is disabled here; a custom wheel handler (attachTrackpadPanZoom)
        // pans on a two-finger scroll and only zooms on pinch (ctrl/⌘ + wheel),
        // so trackpad panning no longer zooms unexpectedly.
        interaction: { hover: true, tooltipDelay: 120, zoomView: false, dragView: true },
        nodes: { borderWidthSelected: 3 },
      });

    // Click a node -> show its details + link. Double-click -> open the page.
    network.on("click", (params) => {
      const n = params.nodes.length ? nodeById[params.nodes[0]] : null;
      if (n) showNodeInfo(n); else hideNodeInfo();
    });
    network.on("doubleClick", (params) => {
      const n = params.nodes.length ? nodeById[params.nodes[0]] : null;
      if (n && n.url) window.open(n.url, "_blank", "noopener");
    });
  }

  // Trackpad-friendly wheel handling. vis-network's built-in zoomView treats a
  // two-finger scroll (a pan gesture) as a zoom, which is jarring. We disable it
  // and route wheel events here: a plain scroll pans the canvas, while a pinch
  // (which the browser delivers as ctrl/⌘ + wheel) zooms, anchored on the cursor.
  // Attached once to the persistent container; it always reads the live network.
  (() => {
    const container = $("network");
    if (!container) return;
    container.addEventListener("wheel", (e) => {
      if (!network) return;
      e.preventDefault();
      const scale = network.getScale();
      if (e.ctrlKey || e.metaKey) {
        const rect = container.getBoundingClientRect();
        const dom = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const center = { x: rect.width / 2, y: rect.height / 2 };
        const canvasPt = network.DOMtoCanvas(dom); // point under the cursor (pre-zoom)
        const factor = Math.exp(-e.deltaY * 0.0015);
        const newScale = Math.min(4, Math.max(0.1, scale * factor));
        // Keep the point under the cursor fixed while the scale changes.
        network.moveTo({
          scale: newScale,
          position: {
            x: canvasPt.x - (dom.x - center.x) / newScale,
            y: canvasPt.y - (dom.y - center.y) / newScale,
          },
          animation: false,
        });
      } else {
        const pos = network.getViewPosition();
        network.moveTo({
          position: { x: pos.x + e.deltaX / scale, y: pos.y + e.deltaY / scale },
          animation: false,
        });
      }
    }, { passive: false });
  })();

  function showNodeInfo(n) {
    const box = $("nodeInfo");
    const parts = [`<div class="ni-title">${escapeHtml(n.title || n.label || "")}</div>`];
    const meta = [];
    if (n.venue && n.venue !== "(unknown)" && n.venue !== "(unidentified)") meta.push(escapeHtml(n.venue));
    if (n.year) meta.push(n.year);
    if (n.type === "paper") meta.push(`${n.ref_count} resolved references`);
    if (n.type === "shared_ref") meta.push(`cited by ${n.shared_by} of your papers`);
    if (meta.length) parts.push(`<div class="ni-meta">${meta.join(" · ")}</div>`);
    if (n.type === "shared_ref" && n.citers && n.citers.length) {
      parts.push(`<div class="ni-citers">Cited by: ${n.citers.map((c) => escapeHtml(c.label)).join("; ")}</div>`);
    }
    parts.push(n.url
      ? `<a class="ni-open" href="${escapeHtml(n.url)}" target="_blank" rel="noopener">Open page ↗</a>`
      : `<span class="muted">No external link is available for this node.</span>`);
    box.innerHTML = parts.join("");
    box.classList.remove("hidden");
  }

  function hideNodeInfo() {
    $("nodeInfo").classList.add("hidden");
  }

  function tooltip(n) {
    const parts = [];
    if (n.title) parts.push(`<b>${escapeHtml(n.title)}</b>`);
    if (n.venue) parts.push(escapeHtml(n.venue));
    if (n.year) parts.push(String(n.year));
    if (n.type === "paper") parts.push(`${n.ref_count} references` + (n.confidence ? ` · ${n.confidence} confidence` : ""));
    if (n.type === "shared_ref") parts.push(`cited by ${n.shared_by} uploaded papers`);
    const div = document.createElement("div");
    div.innerHTML = parts.join("<br>");
    return div;
  }

  // ---- per-paper cards ----------------------------------------------
  function renderCards(papers) {
    const wrap = $("paperCards");
    wrap.innerHTML = "";
    papers.forEach((p, idx) => wrap.appendChild(paperCard(p, idx)));
  }

  function paperCard(p, idx) {
    const ident = p.identification || {};
    const card = document.createElement("div");
    card.className = "paper-card" + (p.error ? " error-card" : "");

    const conf = ident.confidence || "none";
    const badgeLabel = ident.matched
      ? `${conf} confidence`
      : "unidentified";
    const title = ident.title || p.extracted_title || p.filename || "Unknown paper";
    const metaBits = [];
    if (ident.year) metaBits.push(ident.year);
    if (ident.venue) metaBits.push(escapeHtml(ident.venue));
    if (ident.doi) metaBits.push(`<a href="https://doi.org/${encodeURIComponent(ident.doi)}" target="_blank">doi</a>`);

    const stats = p.reference_stats || {};
    const comp = p.venue_composition || [];
    const src = p.reference_source;
    const srcPill = src === "database"
      ? `<span class="src-pill db" title="The paper's reference list came straight from the scholarly database.">references from database</span>`
      : src === "pdf-recovered"
      ? `<span class="src-pill pdf" title="No reference list was available in any database. References were parsed from the PDF and each was resolved against Crossref/OpenAlex; uncertain entries were dropped.">references recovered from PDF</span>`
      : "";

    card.innerHTML = `
      <div class="pc-head">
        <div class="pc-title">
          <h3>${escapeHtml(title)}</h3>
          <div class="pc-meta">${metaBits.join(" · ") || "—"}</div>
          <div class="pc-file">${escapeHtml(p.filename || "")} ${p.page_count ? "· " + p.page_count + "p" : ""}</div>
        </div>
        <div class="pc-badges">
          <span class="badge ${conf}">${badgeLabel}</span>
          ${ident.method ? `<div class="method-tag">via ${ident.method}${ident.sim != null ? " · sim " + ident.sim : ""}</div>` : ""}
          ${srcPill}
        </div>
      </div>`;

    const body = document.createElement("div");
    body.className = "pc-body";

    // left: pie or message
    const left = document.createElement("div");
    if (comp.length > 0) {
      left.innerHTML = `<div class="pc-chart"><canvas id="chart-${idx}"></canvas></div>`;
    } else {
      const msg = !ident.matched
        ? (ident.note || "This paper could not be confidently identified, so its references are intentionally omitted (no guessing).")
        : (stats.note || "No references available from the database for this paper.");
      left.innerHTML = `<div class="pc-chart-empty">${escapeHtml(msg)}</div>`;
    }
    body.appendChild(left);

    // right: stats + venue mini bars + references
    const right = document.createElement("div");
    right.className = "pc-right";
    const listedLabel = src === "pdf-recovered" ? "parsed from PDF" : "references listed";
    right.innerHTML = `
      <div class="pc-statline">
        <div><div class="v">${stats.resolved ?? 0}</div><div class="k">references resolved</div></div>
        <div><div class="v">${stats.requested ?? 0}</div><div class="k">${listedLabel}</div></div>
        <div><div class="v">${comp.length}</div><div class="k">distinct venues</div></div>
      </div>`;

    if (comp.length > 0) {
      const maxC = Math.max(...comp.map((v) => v.count));
      const mini = document.createElement("div");
      mini.className = "venue-mini";
      mini.innerHTML = comp.slice(0, 8).map((v) => {
        const pinned = v.venue === "MIS Quarterly" || v.venue === "Information Systems Research";
        return `<div class="row">
          <span class="swatch" style="background:${v.color}"></span>
          <span class="vname ${pinned ? "pinned" : ""}">${escapeHtml(v.venue)}</span>
          <span class="bar" style="background:${v.color};width:${Math.max(8, (v.count / maxC) * 120)}px"></span>
          <span class="vcount">${v.count}</span></div>`;
      }).join("");
      right.appendChild(mini);

      if (p.references && p.references.length) {
        right.appendChild(buildRefSection(p.references));
      }
    }

    if (stats.requested && stats.resolved < stats.requested) {
      const dropped = stats.requested - stats.resolved;
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = src === "pdf-recovered"
        ? `${dropped} parsed reference(s) could not be confidently resolved to a real record and were omitted (not guessed).`
        : `${dropped} listed reference(s) could not be resolved to a database record and were omitted (not fabricated).`;
      right.appendChild(note);
    }
    if (stats.truncated) {
      const t = document.createElement("div");
      t.className = "note";
      t.textContent = "Note: only the first batch of parsed references was processed (cap reached).";
      right.appendChild(t);
    }

    body.appendChild(right);
    card.appendChild(body);

    if (comp.length > 0) {
      // chart must be created after canvas is in the DOM
      requestAnimationFrame(() => makePie($(`chart-${idx}`), comp));
    }
    return card;
  }

  // A collapsible references block with a text filter and sortable columns.
  // State (filter text, sort key/direction) is kept per-card in the closure.
  function buildRefSection(refs) {
    const frag = document.createDocumentFragment();
    const total = refs.length;

    const btn = document.createElement("button");
    btn.className = "ref-toggle";
    btn.textContent = `Show ${total} resolved references ▾`;

    const panel = document.createElement("div");
    panel.className = "ref-panel hidden";

    const controls = document.createElement("div");
    controls.className = "ref-controls";
    const filter = document.createElement("input");
    filter.type = "search";
    filter.className = "ref-filter";
    filter.placeholder = "Filter by title, author, venue, or year…";
    const count = document.createElement("span");
    count.className = "ref-count muted";
    controls.appendChild(filter);
    controls.appendChild(count);

    const scroll = document.createElement("div");
    scroll.className = "ref-scroll";

    panel.appendChild(controls);
    panel.appendChild(scroll);

    let sortKey = "year";
    let sortDir = -1; // -1 = descending, 1 = ascending
    let filterText = "";

    const matches = (r) => {
      if (!filterText) return true;
      const hay = [r.title, r.venue, r.year, (r.authors || []).join(" ")]
        .join(" ").toLowerCase();
      return hay.includes(filterText);
    };

    const compare = (a, b) => {
      let av, bv;
      if (sortKey === "year") { av = a.year || 0; bv = b.year || 0; }
      else { av = (a[sortKey] || "").toLowerCase(); bv = (b[sortKey] || "").toLowerCase(); }
      if (av < bv) return -sortDir;
      if (av > bv) return sortDir;
      return 0;
    };

    function rerender() {
      const rows = refs.filter(matches).slice().sort(compare);
      scroll.innerHTML = refTable(rows, sortKey, sortDir);
      count.textContent = filterText
        ? `${rows.length} of ${total} shown`
        : `${total} references`;
      scroll.querySelectorAll("th.sortable-th").forEach((th) => {
        th.addEventListener("click", () => {
          const key = th.dataset.key;
          if (sortKey === key) sortDir = -sortDir;
          else { sortKey = key; sortDir = key === "year" ? -1 : 1; }
          rerender();
        });
      });
    }

    filter.addEventListener("input", () => {
      filterText = filter.value.trim().toLowerCase();
      rerender();
    });

    btn.addEventListener("click", () => {
      const hidden = panel.classList.toggle("hidden");
      btn.textContent = `${hidden ? "Show" : "Hide"} ${total} resolved references ${hidden ? "▾" : "▴"}`;
      if (!hidden) filter.focus();
    });

    rerender();
    frag.appendChild(btn);
    frag.appendChild(panel);
    return frag;
  }

  function refTable(refs, sortKey, sortDir) {
    const arrow = (key) => (sortKey === key ? (sortDir < 0 ? " ▼" : " ▲") : "");
    const rows = refs.map((r) => `
      <tr>
        <td>${r.year ?? ""}</td>
        <td>${escapeHtml(r.title || "")}${r.authors && r.authors.length ? `<br><span class="muted" style="font-size:11px">${escapeHtml(r.authors.slice(0, 4).join(", "))}${r.authors.length > 4 ? " et al." : ""}</span>` : ""}</td>
        <td><span class="vpill" style="background:${venueColor(r.venue)}">${escapeHtml(r.venue || "(unknown)")}</span></td>
        <td>${r.doi ? `<a href="https://doi.org/${encodeURIComponent(r.doi)}" target="_blank">link</a>` : ""}</td>
      </tr>`).join("");
    return `<table class="ref-table">
      <thead><tr>
        <th class="sortable-th" data-key="year">Year${arrow("year")}</th>
        <th class="sortable-th" data-key="title">Title${arrow("title")}</th>
        <th class="sortable-th" data-key="venue">Venue${arrow("venue")}</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  // pinned-aware color for a single venue string (mirror of server logic)
  function venueColor(v) {
    if (v === "Information Systems Research") return "#2563eb";
    if (v === "MIS Quarterly") return "#dc2626";
    if (!v || v === "(unknown)") return "#9ca3af";
    // hash to a stable palette color
    const palette = ["#0891b2", "#7c3aed", "#ea580c", "#16a34a", "#db2777", "#ca8a04", "#0d9488", "#9333ea"];
    let h = 0;
    for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  function makePie(canvas, comp) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const c = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: comp.map((v) => v.venue),
        datasets: [{
          data: comp.map((v) => v.count),
          backgroundColor: comp.map((v) => v.color),
          borderColor: cssVar("--chart-border"),
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "55%",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => {
                const total = c.dataset.data.reduce((a, b) => a + b, 0);
                const pct = ((c.parsed / total) * 100).toFixed(1);
                return ` ${c.label}: ${c.parsed} (${pct}%)`;
              },
            },
          },
        },
      },
    });
    charts.push(c);
  }

  // ---- export -------------------------------------------------------
  $("exportJson").addEventListener("click", () => {
    if (!lastData) return;
    download("reference-viewer.json", JSON.stringify(lastData, null, 2), "application/json");
  });

  $("exportCsv").addEventListener("click", () => {
    if (!lastData) return;
    const rows = [[
      "source_paper", "source_identified", "source_venue",
      "ref_title", "ref_year", "ref_venue", "ref_authors", "ref_doi", "ref_openalex_id",
    ]];
    (lastData.papers || []).forEach((p) => {
      const ident = p.identification || {};
      const src = ident.title || p.extracted_title || p.filename || "";
      (p.references || []).forEach((r) => {
        rows.push([
          src, ident.matched ? "yes" : "no", ident.venue || "",
          r.title || "", r.year ?? "", r.venue || "",
          (r.authors || []).join("; "), r.doi || "", r.openalex_id || "",
        ]);
      });
    });
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
    download("references.csv", "﻿" + csv, "text/csv");
  });

  function csvCell(v) {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function download(name, content, mime) {
    const blob = new Blob([content], { type: mime + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }
})();
