/* Per-species knowledge-graph viewer (canvas). Loads docs/kg/index.json and a
   positioned subgraph per species (docs/kg/<slug>.json), draws it with pan/zoom,
   hover labels, and click-through to a gene's record. Depends on app.js globals
   ($, esc, rows, openGeneByName). */
(function () {
  let inited = false, index = null, data = null;
  let view = { k: 1, ox: 0, oy: 0 };     // world->screen: sx = x*k+ox
  let cssW = 0, cssH = 0, dpr = 1;
  let hover = -1, hoverEdge = -1, labeled = new Set();
  let canvas, ctx, wrap, tip;
  let dirty = false;
  let curSlug = null, evCache = {};
  let focusNode = -1, focusSet = null, visibleNodes = new Set();

  // relation -> [legend category, colour]
  const REL = {
    positively_regulates: ["Activates", "#1f9d6b"],
    activates_pathway:    ["Activates", "#1f9d6b"],
    negatively_regulates: ["Inhibits", "#c0533b"],
    inhibits_pathway:     ["Inhibits", "#c0533b"],
    member_of:            ["Pathway member", "#1b76b0"],
    interacts_with:       ["Interacts", "#8a96a3"],
    crosstalks_with:      ["Interacts", "#8a96a3"],
    transcribes_target:   ["Regulates", "#e0a458"],
    phosphorylates:       ["Regulates", "#e0a458"],
    dephosphorylates:     ["Regulates", "#e0a458"],
    upstream_of:          ["Regulates", "#e0a458"],
    is_ortholog_of:       ["Homology", "#8e6fc0"],
    is_paralog_of:        ["Homology", "#8e6fc0"],
  };
  const GENE_FILL = "#1b76b0", PATH_FILL = "#e0a458";

  function relColor(r) { return (REL[r] || ["", "#b8c6d2"])[1]; }

  async function initKG() {
    if (inited) return;
    inited = true;
    canvas = document.getElementById("kg-canvas");
    ctx = canvas.getContext("2d");
    wrap = document.getElementById("kg-wrap");
    tip = document.getElementById("kg-tip");
    buildLegend();
    bindEvents();
    try {
      index = await (await fetch("kg/index.json")).json();
    } catch (e) {
      document.getElementById("kg-stat").textContent = "Failed to load graph index.";
      return;
    }
    const sel = document.getElementById("kg-species");
    const defaultSlug = index.length ? index[0].slug : null;   // index is count-sorted: [0] = largest
    const byName = [...index].sort((a, b) =>
      a.species.toLowerCase() < b.species.toLowerCase() ? -1 : 1);   // dropdown alphabetical
    sel.innerHTML = byName
      .map((d) => `<option value="${d.slug}">${esc(d.species)} — ${d.genes} genes, ${d.edges} edges</option>`)
      .join("");
    sel.addEventListener("change", () => loadSpecies(sel.value));
    if (defaultSlug) { sel.value = defaultSlug; loadSpecies(defaultSlug); }
  }
  window.initKG = initKG;

  async function loadSpecies(slug) {
    document.getElementById("kg-stat").textContent = "Loading…";
    let d;
    try { d = await (await fetch(`kg/${slug}.json`)).json(); }
    catch (e) { document.getElementById("kg-stat").textContent = "Failed to load species graph."; return; }
    data = d; curSlug = slug; hover = -1; hoverEdge = -1;
    // node screen radius + which nodes get a permanent label (hubs)
    for (const n of data.nodes) {
      n.r = n.t === "p" ? 7 : Math.max(3, Math.min(14, 3 + Math.sqrt(n.p || 0) * 0.9));
    }
    const order = data.nodes.map((n, i) => i).sort((a, b) => (data.nodes[b].p || 0) - (data.nodes[a].p || 0));
    labeled = new Set(order.slice(0, 28));
    populatePathways();
    populateGenes();
    focusNode = -1; focusSet = null;
    recomputeVisible();
    resize();
    fitView();
    const np = data.nodes.filter((n) => n.t === "p").length;
    document.getElementById("kg-stat").textContent =
      `${data.species} · ${data.nodes.length - np} genes · ${np} pathways · ${data.edges.length} edges`;
    schedule();
  }

  // ---- view helpers ----
  function edgeActive(e) {
    const conf = document.getElementById("kg-conf").value;
    if (conf && !conf.split(",").includes(e.c)) return false;
    if (focusNode >= 0) return focusSet.has(e.s) && focusSet.has(e.t);
    if (!document.getElementById("kg-pathways").checked &&
        (data.nodes[e.s].t === "p" || data.nodes[e.t].t === "p")) return false;
    return true;
  }
  // a single selected pathway -> the pathway plus the genes directly linked to it
  function recomputeFocusSet() {
    if (focusNode < 0) { focusSet = null; return; }
    focusSet = new Set([focusNode]);
    for (const e of data.edges) {
      if (e.s === focusNode) focusSet.add(e.t);
      else if (e.t === focusNode) focusSet.add(e.s);
    }
  }
  // visible nodes = endpoints of currently-active edges (auto-drops isolated nodes)
  function recomputeVisible() {
    visibleNodes = new Set();
    for (const e of data.edges) {
      if (edgeActive(e)) { visibleNodes.add(e.s); visibleNodes.add(e.t); }
    }
  }
  function populatePathways() {
    const deg = {};
    for (const e of data.edges) {
      if (data.nodes[e.s].t === "p") deg[e.s] = (deg[e.s] || 0) + 1;
      if (data.nodes[e.t].t === "p") deg[e.t] = (deg[e.t] || 0) + 1;
    }
    const pw = [];
    for (let i = 0; i < data.nodes.length; i++) if (data.nodes[i].t === "p") pw.push(i);
    pw.sort((a, b) => (deg[b] || 0) - (deg[a] || 0));
    document.getElementById("kg-pathway").innerHTML =
      `<option value="-1">All pathways</option>` +
      pw.map((i) => `<option value="${i}">${esc(data.nodes[i].l)} (${deg[i] || 0})</option>`).join("");
  }
  function populateGenes() {
    const g = [];
    for (let i = 0; i < data.nodes.length; i++) if (data.nodes[i].t === "g") g.push(i);
    g.sort((a, b) => data.nodes[a].l.toLowerCase() < data.nodes[b].l.toLowerCase() ? -1 : 1);
    document.getElementById("kg-gene").innerHTML =
      `<option value="-1">All genes</option>` +
      g.map((i) => `<option value="${i}">${esc(data.nodes[i].l)}</option>`).join("");
  }

  function ptSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy || 1;
    let t = ((px - x1) * dx + (py - y1) * dy) / L;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function edgeAt(mx, my) {
    let best = -1, bd = 6;
    for (let i = 0; i < data.edges.length; i++) {
      const e = data.edges[i];
      if (!edgeActive(e)) continue;
      const a = data.nodes[e.s], b = data.nodes[e.t];
      const d = ptSeg(mx, my, sx(a.x), sy(a.y), sx(b.x), sy(b.y));
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function fitView() {
    if (!data || !data.nodes.length) return;
    const set = visibleNodes.size ? visibleNodes : null;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let i = 0; i < data.nodes.length; i++) {
      if (set && !set.has(i)) continue;
      const n = data.nodes[i];
      if (n.x < minx) minx = n.x; if (n.x > maxx) maxx = n.x;
      if (n.y < miny) miny = n.y; if (n.y > maxy) maxy = n.y;
    }
    const bw = maxx - minx || 1, bh = maxy - miny || 1;
    view.k = Math.min(cssW / bw, cssH / bh) * 0.9;
    view.ox = (cssW - bw * view.k) / 2 - minx * view.k;
    view.oy = (cssH - bh * view.k) / 2 - miny * view.k;
  }
  const sx = (x) => x * view.k + view.ox;
  const sy = (y) => y * view.k + view.oy;

  // ---- rendering ----
  function schedule() { if (!dirty) { dirty = true; requestAnimationFrame(render); } }

  function render() {
    dirty = false;
    if (!data) return;
    ctx.clearRect(0, 0, cssW, cssH);
    const N = data.nodes;

    // edges
    for (let i = 0; i < data.edges.length; i++) {
      const e = data.edges[i];
      if (!edgeActive(e)) continue;
      const a = N[e.s], b = N[e.t];
      const hot = hover === e.s || hover === e.t || hoverEdge === i;
      ctx.strokeStyle = relColor(e.r);
      ctx.lineWidth = hoverEdge === i ? 2.6 : 1;
      ctx.globalAlpha = hot ? 0.95 : 0.26;
      ctx.beginPath();
      ctx.moveTo(sx(a.x), sy(a.y));
      ctx.lineTo(sx(b.x), sy(b.y));
      ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.lineWidth = 1;

    // nodes
    for (let i = 0; i < N.length; i++) {
      const n = N[i];
      if (!visibleNodes.has(i)) continue;
      const x = sx(n.x), y = sy(n.y), r = n.r;
      if (x < -20 || x > cssW + 20 || y < -20 || y > cssH + 20) continue;
      ctx.beginPath();
      if (n.t === "p") { ctx.rect(x - r, y - r, r * 2, r * 2); }
      else { ctx.arc(x, y, r, 0, 6.2832); }
      ctx.fillStyle = n.t === "p" ? PATH_FILL : GENE_FILL;
      ctx.globalAlpha = hover === -1 || hover === i ? 1 : 0.85;
      ctx.fill();
      ctx.lineWidth = i === hover ? 2 : 0.7;
      ctx.strokeStyle = i === hover ? "#0c3a63" : "#fff";
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // labels: hub nodes + hovered
    ctx.font = "11px -apple-system, Segoe UI, sans-serif";
    ctx.fillStyle = "#10283a";
    ctx.textAlign = "center";
    const toLabel = new Set(labeled);
    if (hover >= 0) toLabel.add(hover);
    for (const i of toLabel) {
      const n = N[i];
      if (!visibleNodes.has(i)) continue;
      const x = sx(n.x), y = sy(n.y);
      if (x < 0 || x > cssW || y < 0 || y > cssH) continue;
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.85)";
      ctx.strokeText(n.l, x, y - n.r - 3);
      ctx.fillText(n.l, x, y - n.r - 3);
    }
  }

  // ---- interaction ----
  function nodeAt(mx, my) {
    let best = -1, bd = 16;
    for (let i = 0; i < data.nodes.length; i++) {
      if (!visibleNodes.has(i)) continue;
      const n = data.nodes[i];
      const dx = sx(n.x) - mx, dy = sy(n.y) - my;
      const d = Math.hypot(dx, dy);
      if (d < n.r + 4 && d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function resize() {
    const w = wrap.clientWidth, h = wrap.clientHeight || 520;
    dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cssW = w; cssH = h;
  }

  function bindEvents() {
    document.getElementById("kg-conf").addEventListener("change", () => { recomputeVisible(); schedule(); });
    document.getElementById("kg-pathways").addEventListener("change", () => { recomputeVisible(); schedule(); });
    document.getElementById("kg-pathway").addEventListener("change", (e) => {
      focusNode = parseInt(e.target.value, 10);
      if (focusNode >= 0) document.getElementById("kg-gene").value = "-1";
      recomputeFocusSet(); recomputeVisible(); fitView(); schedule();
    });
    document.getElementById("kg-gene").addEventListener("change", (e) => {
      focusNode = parseInt(e.target.value, 10);
      if (focusNode >= 0) document.getElementById("kg-pathway").value = "-1";
      recomputeFocusSet(); recomputeVisible(); fitView(); schedule();
    });
    document.getElementById("kg-fit").addEventListener("click", () => { fitView(); schedule(); });

    let dragging = false, lastX = 0, lastY = 0, moved = false;
    canvas.addEventListener("mousedown", (e) => { dragging = true; moved = false; lastX = e.offsetX; lastY = e.offsetY; });
    window.addEventListener("mouseup", () => { dragging = false; });
    canvas.addEventListener("mousemove", (e) => {
      const mx = e.offsetX, my = e.offsetY;
      if (dragging) {
        moved = true;
        view.ox += mx - lastX; view.oy += my - lastY;
        lastX = mx; lastY = my; hover = -1; hoverEdge = -1; tip.classList.add("hidden");
        schedule();
        return;
      }
      const h = nodeAt(mx, my);
      const he = h < 0 ? edgeAt(mx, my) : -1;
      if (h !== hover || he !== hoverEdge) {
        hover = h; hoverEdge = he;
        if (h >= 0) {
          const n = data.nodes[h];
          tip.innerHTML = `<strong>${esc(n.l)}</strong><br>${n.t === "p" ? "Pathway" : "Gene · " + (n.p || 0) + " papers"}`;
          canvas.style.cursor = "pointer"; tip.classList.remove("hidden");
        } else if (he >= 0) {
          const ed = data.edges[he];
          tip.innerHTML = `<strong>${esc(data.nodes[ed.s].l)} → ${esc(data.nodes[ed.t].l)}</strong><br>` +
            `${esc(ed.r.replace(/_/g, " "))}${ed.e ? " · click for evidence" : ""}`;
          canvas.style.cursor = "pointer"; tip.classList.remove("hidden");
        } else { tip.classList.add("hidden"); canvas.style.cursor = "default"; }
        schedule();
      }
      if (h >= 0 || he >= 0) { tip.style.left = mx + 14 + "px"; tip.style.top = my + 12 + "px"; }
    });
    canvas.addEventListener("mouseleave", () => { hover = -1; hoverEdge = -1; tip.classList.add("hidden"); schedule(); });

    canvas.addEventListener("click", (e) => {
      if (moved) return;
      const i = nodeAt(e.offsetX, e.offsetY);
      if (i >= 0) {
        const n = data.nodes[i];
        if (n.t === "g" && typeof openGeneByName === "function") {
          if (!openGeneByName(n.l, data.species)) flash(`${n.l} — no detailed record in the table`);
        }
        return;
      }
      const ei = edgeAt(e.offsetX, e.offsetY);
      if (ei >= 0) openEvidence(ei);
    });

    // evidence modal close
    document.getElementById("kg-ev-close").addEventListener("click", hideEvidence);
    document.getElementById("kg-ev").addEventListener("click", (e) => { if (e.target.id === "kg-ev") hideEvidence(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideEvidence(); });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const mx = e.offsetX, my = e.offsetY;
      // zoom toward cursor: keep world point under cursor fixed
      view.ox = mx - (mx - view.ox) * f;
      view.oy = my - (my - view.oy) * f;
      view.k *= f;
      schedule();
    }, { passive: false });

    window.addEventListener("resize", () => { if (!data) return; resize(); schedule(); });
  }

  async function openEvidence(ei) {
    const e = data.edges[ei];
    const a = data.nodes[e.s], b = data.nodes[e.t];
    if (evCache[curSlug] === undefined) {
      try { evCache[curSlug] = await (await fetch(`kg/${curSlug}.ev.json`)).json(); }
      catch (_) { evCache[curSlug] = {}; }
    }
    const list = (evCache[curSlug] && evCache[curSlug][String(ei)]) || [];
    document.getElementById("kg-ev-title").innerHTML =
      `${esc(a.l)} <span class="ev-rel">${esc(e.r.replace(/_/g, " "))}</span> ${esc(b.l)}`;
    const sub = `<div class="ev-sub">${e.n || 0} model support${e.n === 1 ? "" : "s"} · ${list.length} paper${list.length === 1 ? "" : "s"} cited</div>`;
    const body = list.length
      ? list.map((x) =>
          `<div class="ev-item">
             <div class="ev-meta">
               <a href="https://pubmed.ncbi.nlm.nih.gov/${esc(x.p)}/" target="_blank" rel="noopener">PMID ${esc(x.p)}</a>
               <span class="ev-conf ${esc(x.c || "")}">${esc(x.c || "n/a")}</span>
             </div>
             <div class="ev-quote">${esc(x.q)}</div>
           </div>`).join("")
      : `<p class="empty-state">No evidence quote was recorded for this edge.</p>`;
    document.getElementById("kg-ev-body").innerHTML = sub + body;
    document.getElementById("kg-ev").classList.add("open");
  }
  function hideEvidence() { document.getElementById("kg-ev").classList.remove("open"); }

  function flash(msg) {
    const s = document.getElementById("kg-stat");
    const prev = s.textContent; s.textContent = msg;
    setTimeout(() => { s.textContent = prev; }, 2500);
  }

  function buildLegend() {
    const cats = [];
    const seen = new Set();
    for (const [, [cat, col]] of Object.entries(REL)) {
      if (!seen.has(cat)) { seen.add(cat); cats.push([cat, col]); }
    }
    const node = [["Gene", GENE_FILL, "circle"], ["Pathway", PATH_FILL, "square"]];
    document.getElementById("kg-legend").innerHTML =
      node.map(([t, c, sh]) => `<span class="lg"><span class="lg-${sh}" style="background:${c}"></span>${t}</span>`).join("") +
      `<span class="lg-sep"></span>` +
      cats.map(([t, c]) => `<span class="lg"><span class="lg-line" style="background:${c}"></span>${t}</span>`).join("");
  }
})();
