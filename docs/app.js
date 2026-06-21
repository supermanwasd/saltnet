/* Salt-Tolerance Gene Database — in-browser SQLite (sql.js) front end.
   Loads docs/salt_genes.db, drives faceted search, a sortable/paginated
   table, and a detail modal. No server required. */

const DB_URL = "salt_genes.db";
const PAGE_SIZE = 25;

let SQL = null;        // sql.js module
let db = null;         // database handle
let state = {
  search: "",
  filters: {},         // {column/junction: value}
  sort: { col: "n_pmids", dir: "DESC" },
  userSorted: false,   // true once a column header is clicked (overrides search relevance)
  page: 0,
  total: 0,
};
const charts = {};
let tcdbFam = {};     // {gene_id: {fam, tc, exp, v}} TCDB transporter annotation
let uniprotAcc = {};  // {gene_id: {a: accession, r: reviewed}} resolved UniProt entries
let siteStats = {};   // {min_year, max_year, ...} small dashboard stats

// Facets: single-value live on `genes`; multi-value use a junction table.
const FACETS = [
  { key: "is_plant",             label: "Organism type",      col: "is_plant" },
  { key: "species",              label: "Species",            col: "species" },
  { key: "functional_category",  label: "Functional category", junction: ["gene_category", "category"] },
  { key: "evidence_strength",    label: "Evidence strength",  col: "evidence_strength" },
  { key: "gene_role",            label: "Inferred gene role", col: "gene_role" },
  { key: "tissue",               label: "Tissue / organ",     junction: ["gene_tissue", "tissue"] },
  { key: "mechanistic_role",     label: "Mechanistic role",   junction: ["gene_mechanism", "mechanism"] },
  { key: "transport_substrate",  label: "Transport substrate", junction: ["gene_substrate", "substrate"] },
];

// Columns shown in the results table.
const COLUMNS = [
  { key: "canonical_gene", label: "Gene", sortable: true },
  { key: "species",        label: "Species", sortable: true },
  { key: "gene_role",      label: "Role", sortable: true },
  { key: "functional_category", label: "Functional category", sortable: true },
  { key: "evidence_strength",   label: "Evidence", sortable: true },
  { key: "tissue",         label: "Tissue", sortable: false },
  { key: "n_pmids",        label: "# PMIDs", sortable: true, num: true },
];

// All genes columns for the detail modal, in a readable order with labels.
const DETAIL_FIELDS = [
  ["canonical_gene", "Canonical gene"],
  ["species", "Species"],
  ["is_plant", "Organism type"],
  ["all_names", "All names / aliases"],
  ["n_distinct_names", "# distinct names"],
  ["evidence_strength", "Evidence strength (best)"],
  ["gene_role", "Inferred gene role"],
  ["functional_category", "Functional category"],
  ["mechanistic_role", "Mechanistic role"],
  ["transport_substrate", "Transport substrate"],
  ["subcellular_localization", "Subcellular localization"],
  ["expression_response", "Expression response"],
  ["n_rows", "# raw extraction rows"],
  ["n_pmids", "# supporting PMIDs"],
  ["origin", "Pipeline origin"],
  ["notes", "Notes"],
];

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---- bootstrap ----
async function boot() {
  try {
    SQL = await initSqlJs({ locateFile: (f) => "vendor/" + f });
    const buf = await fetchDb(DB_URL);
    db = new SQL.Database(new Uint8Array(buf));
    try { tcdbFam = await (await fetch("tcdb_families.json")).json(); } catch (_) { tcdbFam = {}; }
    try { uniprotAcc = await (await fetch("uniprot_acc.json")).json(); } catch (_) { uniprotAcc = {}; }
    try { siteStats = await (await fetch("stats.json")).json(); } catch (_) { siteStats = {}; }
    $("#loader").classList.add("hidden");
    $("#app").classList.remove("hidden");
    renderStats();
    renderCharts();
    setupViewNav();
    buildFacets();
    bindControls();
    runQuery();
  } catch (e) {
    $("#loader").innerHTML =
      '<p style="color:#c0533b">Failed to load database.<br>' + esc(e.message) + "</p>";
    console.error(e);
  }
}

async function fetchDb(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("HTTP " + resp.status + " fetching " + url);
  return await resp.arrayBuffer();
}

// ---- query helpers ----
function one(sql, params) {
  const r = db.exec(sql, params);
  if (!r.length || !r[0].values.length) return null;
  return r[0].values[0][0];
}
function rows(sql, params) {
  const r = db.exec(sql, params);
  if (!r.length) return [];
  const cols = r[0].columns;
  return r[0].values.map((v) => Object.fromEntries(v.map((x, i) => [cols[i], x])));
}

// Build the WHERE clause + params shared by table + count.
function buildWhere() {
  const clauses = [];
  const params = {};
  if (state.search.trim()) {
    params.$q = "%" + state.search.trim() + "%";
    // match gene name / aliases / species only — NOT notes (avoids "mentions SOS1" noise)
    clauses.push(
      "(g.canonical_gene LIKE $q OR g.all_names LIKE $q OR g.species LIKE $q)"
    );
  }
  let i = 0;
  for (const f of FACETS) {
    const val = state.filters[f.key];
    if (!val) continue;
    const p = "$f" + i++;
    params[p] = val;
    if (f.junction) {
      const [tbl, vc] = f.junction;
      clauses.push(
        `EXISTS (SELECT 1 FROM ${tbl} j WHERE j.gene_id=g.gene_id AND j."${vc}"=${p})`
      );
    } else {
      clauses.push(`g.${f.col}=${p}`);
    }
  }
  return { where: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
}

// ---- rendering ----
function renderStats() {
  const g = one("SELECT COUNT(*) FROM genes");
  const sp = one("SELECT COUNT(*) FROM species_dim");
  const pm = one("SELECT COUNT(DISTINCT pmid) FROM gene_pmid");
  const dv = one("SELECT COUNT(*) FROM genes WHERE evidence_strength='Direct functional validation'");
  const cards = [
    [g.toLocaleString(), "Gene × species records"],
    [sp.toLocaleString(), "Distinct species"],
    [pm.toLocaleString(), "Unique PMIDs"],
    [dv.toLocaleString(), "Direct functional validation"],
  ];
  if (siteStats.min_year && siteStats.max_year) {
    cards.push([`${siteStats.min_year}–${siteStats.max_year}`, "Literature span (oldest–newest paper)"]);
  }
  if (siteStats.latest_paper_label) {
    cards.push([siteStats.latest_paper_label, "Most recent paper in the database"]);
  }
  $("#stats").innerHTML = cards
    .map((c) => `<div class="stat"><div class="num">${c[0]}</div><div class="lab">${c[1]}</div></div>`)
    .join("");
}

function buildFacets() {
  const host = $("#filters");
  host.innerHTML = FACETS.map((f) => {
    let opts;
    if (f.junction) {
      const [tbl, vc] = f.junction;
      opts = rows(`SELECT "${vc}" v, COUNT(*) n FROM ${tbl} GROUP BY "${vc}" ORDER BY n DESC`);
    } else {
      // species is sorted alphabetically; other single-value facets by count
      const order = f.key === "species" ? "v COLLATE NOCASE ASC" : "n DESC";
      opts = rows(
        `SELECT ${f.col} v, COUNT(*) n FROM genes WHERE ${f.col} IS NOT NULL AND ${f.col}<>'' GROUP BY ${f.col} ORDER BY ${order}`
      );
    }
    const optHtml = opts
      .map((o) => `<option value="${esc(o.v)}">${esc(o.v)} (${o.n})</option>`)
      .join("");
    return `<div class="field"><label>${f.label}</label>
      <select data-facet="${f.key}"><option value="">All</option>${optHtml}</select></div>`;
  }).join("");

  host.querySelectorAll("select[data-facet]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const k = sel.dataset.facet;
      if (sel.value) state.filters[k] = sel.value;
      else delete state.filters[k];
      state.page = 0;
      runQuery();
    });
  });
}

function bindControls() {
  let t;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.search = e.target.value;
      state.userSorted = false;   // a new search reverts to relevance ranking
      state.page = 0;
      runQuery();
    }, 220);
  });
  $("#reset").addEventListener("click", () => {
    state.search = "";
    state.filters = {};
    state.userSorted = false;
    state.page = 0;
    $("#search").value = "";
    $("#filters").querySelectorAll("select").forEach((s) => (s.value = ""));
    runQuery();
  });
  $("#modal-bg").addEventListener("click", (e) => {
    if (e.target.id === "modal-bg" || e.target.classList.contains("close")) closeModal();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  document.querySelectorAll(".mtab").forEach((b) =>
    b.addEventListener("click", () => showTab(b.dataset.tab))
  );
}

function roleBadge(role) {
  if (!role) return '<span class="badge unclear">—</span>';
  const r = role.toLowerCase();
  let cls = "unclear";
  if (r.startsWith("positive")) cls = "pos";
  else if (r.startsWith("negative")) cls = "neg";
  const short = role.replace(/ regulator of salt tolerance/gi, "").replace(/;.*/, "");
  return `<span class="badge ${cls}">${esc(short)}</span>`;
}

function runQuery() {
  const { where, params } = buildWhere();
  state.total = one(`SELECT COUNT(*) FROM genes g ${where}`, params) || 0;

  // When searching (and the user hasn't picked a column sort), rank by relevance so
  // an exact symbol and all its cross-species orthologs cluster at the top.
  let order, tableParams = params;
  if (state.search.trim() && !state.userSorted) {
    tableParams = { ...params, $qx: state.search.trim() };
    order =
      `ORDER BY CASE
         WHEN g.canonical_gene = $qx COLLATE NOCASE THEN 0
         WHEN g.canonical_gene LIKE $q THEN 1
         WHEN g.all_names LIKE $q THEN 2
         ELSE 3 END,
       g.n_pmids DESC, g.canonical_gene ASC`;
  } else {
    order = `ORDER BY g.${state.sort.col} ${state.sort.dir} ${state.sort.col !== "canonical_gene" ? ", g.canonical_gene ASC" : ""}`;
  }

  const offset = state.page * PAGE_SIZE;
  const data = rows(
    `SELECT g.gene_id, g.canonical_gene, g.species, g.gene_role, g.functional_category,
            g.evidence_strength, g.tissue, g.n_pmids
     FROM genes g ${where} ${order} LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    tableParams
  );
  renderTable(data);
  renderFoot();
}

function renderTable(data) {
  const head = COLUMNS.map((c) => {
    let arrow = "";
    if (state.sort.col === c.key) arrow = state.sort.dir === "ASC" ? " ▲" : " ▼";
    return `<th data-col="${c.key}" data-sortable="${!!c.sortable}">${c.label}${arrow}</th>`;
  }).join("");

  if (!data.length) {
    $("#table").innerHTML =
      `<thead><tr>${head}</tr></thead><tbody><tr><td colspan="${COLUMNS.length}" class="empty-state">No matching genes. Try clearing some filters.</td></tr></tbody>`;
  } else {
    const body = data
      .map((r) => {
        const cells = COLUMNS.map((c) => {
          let v = r[c.key];
          if (c.key === "canonical_gene") return `<td><span class="gene-name">${esc(v)}</span></td>`;
          if (c.key === "species") return `<td><span class="species-name">${esc(v)}</span></td>`;
          if (c.key === "gene_role") return `<td>${roleBadge(v)}</td>`;
          if (c.key === "n_pmids") return `<td class="pmid-count">${v == null ? "" : v}</td>`;
          if (c.key === "tissue") return `<td>${esc((v || "").replace(/;\s*/g, ", "))}</td>`;
          if (c.key === "functional_category") return `<td>${esc((v || "").replace(/;\s*/g, ", "))}</td>`;
          return `<td>${esc(v)}</td>`;
        }).join("");
        return `<tr data-id="${r.gene_id}">${cells}</tr>`;
      })
      .join("");
    $("#table").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  }

  $("#table").querySelectorAll("th[data-sortable='true']").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (state.sort.col === col) state.sort.dir = state.sort.dir === "ASC" ? "DESC" : "ASC";
      else state.sort = { col, dir: col === "n_pmids" ? "DESC" : "ASC" };
      state.userSorted = true;   // honour the chosen column sort over search relevance
      state.page = 0;
      runQuery();
    });
  });
  $("#table").querySelectorAll("tbody tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => openModal(+tr.dataset.id));
  });
}

function renderFoot() {
  const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  const cur = state.page + 1;
  const from = state.total ? state.page * PAGE_SIZE + 1 : 0;
  const to = Math.min(state.total, (state.page + 1) * PAGE_SIZE);
  $("#count").textContent = `${state.total.toLocaleString()} genes · showing ${from}–${to}`;
  $("#pager").innerHTML =
    `<button class="btn" id="prev" ${state.page === 0 ? "disabled" : ""}>‹ Prev</button>
     <span>Page ${cur} / ${pages}</span>
     <button class="btn" id="next" ${cur >= pages ? "disabled" : ""}>Next ›</button>`;
  const prev = $("#prev"), next = $("#next");
  if (prev) prev.onclick = () => { if (state.page > 0) { state.page--; runQuery(); } };
  if (next) next.onclick = () => { if (cur < pages) { state.page++; runQuery(); } };
}

// ---- detail modal + co-citation graph ----
let currentGeneId = null;

const ROLE_COLOR = (role) => {
  const r = (role || "").toLowerCase();
  if (r.startsWith("positive")) return "#1b76b0";
  if (r.startsWith("negative")) return "#c0533b";
  return "#8aa1b0";
};

function openModal(id) { openGene(id, "details"); }

function openGene(id, tab) {
  currentGeneId = id;
  const r = rows("SELECT * FROM genes WHERE gene_id=?", [id])[0];
  if (!r) return;
  $("#modal-title").innerHTML =
    `${esc(r.canonical_gene)} <span class="species-name">${esc(r.species)}</span>`;

  // ----- details tab -----
  const dl = DETAIL_FIELDS.map(([k, lab]) => {
    let v = r[k];
    let dd;
    if (v == null || v === "") dd = '<dd class="empty">—</dd>';
    else if (k === "all_names" || k === "tissue" || k === "mechanistic_role" || k === "functional_category")
      dd = `<dd>${esc(String(v).replace(/;\s*/g, " · "))}</dd>`;
    else dd = `<dd>${esc(v)}</dd>`;
    return `<dt>${lab}</dt>${dd}`;
  }).join("");
  const pmids = rows("SELECT pmid FROM gene_pmid WHERE gene_id=? ORDER BY CAST(pmid AS INTEGER)", [id]);
  const links = pmids.length
    ? `<div class="pmid-links">${pmids
        .map((p) => `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(p.pmid)}/" target="_blank" rel="noopener">${esc(p.pmid)}</a>`)
        .join("")}</div>`
    : '<span class="empty">—</span>';
  $("#tab-details").innerHTML =
    sequenceLinks(r) + tcdbBadge(id) +
    `<dl class="detail">${dl}<dt>PMIDs (${pmids.length})</dt><dd>${links}</dd></dl>`;

  // graph & papers are rendered lazily when their tab is shown
  $("#tab-graph").dataset.rendered = "";
  $("#tab-papers").dataset.rendered = "";
  showTab(tab || "details");
  $("#modal-bg").classList.add("open");
}

function showTab(tab) {
  document.querySelectorAll(".mtab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#tab-details").classList.toggle("hidden", tab !== "details");
  $("#tab-papers").classList.toggle("hidden", tab !== "papers");
  $("#tab-graph").classList.toggle("hidden", tab !== "graph");
  if (tab === "graph" && $("#tab-graph").dataset.rendered !== String(currentGeneId)) {
    renderGraph(currentGeneId);
    $("#tab-graph").dataset.rendered = String(currentGeneId);
  }
  if (tab === "papers" && $("#tab-papers").dataset.rendered !== String(currentGeneId)) {
    renderPapers(currentGeneId);
    $("#tab-papers").dataset.rendered = String(currentGeneId);
  }
}

// ---- per-paper evidence tab (lazy-loaded gene_papers.json) ----
let paperData = null;
const PAPER_FIELDS = [
  ["gb", "Genetic background"], ["allelic", "Allelic info"],
  ["method", "Validation method"], ["stress", "Stress condition"],
  ["tissue", "Tissue / organ"], ["phen", "Perturbation phenotype"],
  ["pop", "Population evidence"], ["popctx", "Population context"],
  ["role", "Inferred role (this paper)"], ["ev", "Evidence strength"], ["notes", "Notes"],
];

function paperCard(c) {
  const head =
    (c.title
      ? `<a class="paper-title" href="https://pubmed.ncbi.nlm.nih.gov/${esc(c.pmid)}/" target="_blank" rel="noopener">${esc(c.title)}</a>`
      : `<a class="paper-title" href="https://pubmed.ncbi.nlm.nih.gov/${esc(c.pmid)}/" target="_blank" rel="noopener">PMID ${esc(c.pmid)}</a>`) +
    `<div class="paper-meta">${[c.journal, c.year, "PMID " + c.pmid].filter(Boolean).map(esc).join(" · ")}</div>`;
  const rows = PAPER_FIELDS.filter(([k]) => c[k])
    .map(([k, lab]) => `<dt>${lab}</dt><dd>${esc(c[k])}</dd>`).join("");
  return `<div class="paper-card"><div class="paper-head">${head}</div>` +
    (rows ? `<dl class="paper-fields">${rows}</dl>` : "") + `</div>`;
}

async function renderPapers(id) {
  const host = $("#tab-papers");
  host.innerHTML = '<p class="empty-state">Loading papers…</p>';
  if (!paperData) {
    try { paperData = await (await fetch("gene_papers.json")).json(); }
    catch (_) { host.innerHTML = '<p class="empty-state">Failed to load per-paper evidence.</p>'; return; }
  }
  const cards = paperData[String(id)] || [];
  if (!cards.length) {
    host.innerHTML = '<p class="empty-state">No per-paper evidence available for this gene.</p>'; return;
  }
  host.innerHTML =
    `<div class="paper-count">${cards.length} supporting paper${cards.length === 1 ? "" : "s"} — each with its own experimental context</div>` +
    cards.map(paperCard).join("");
}

function closeModal() { $("#modal-bg").classList.remove("open"); }

// Sequence links — only shown when the gene resolves to a real UniProt entry.
// All links are direct (verified to have a sequence): the UniProt entry + FASTA,
// and NCBI Protein / NCBI Gene built from the entry's cross-references.
function sequenceLinks(r) {
  const t = uniprotAcc[String(r.gene_id)];
  if (!t || !t.a) return "";
  const acc = esc(t.a);
  const links = [
    [`UniProt ${acc} ↗`, `https://www.uniprot.org/uniprotkb/${acc}/entry`],
    [`FASTA ⬇`, `https://rest.uniprot.org/uniprotkb/${acc}.fasta`],
  ];
  if (t.prot) links.push([`NCBI Protein ↗`, `https://www.ncbi.nlm.nih.gov/protein/${esc(t.prot)}`]);
  if (t.gene) links.push([`NCBI Gene ↗`, `https://www.ncbi.nlm.nih.gov/gene/${esc(t.gene)}`]);
  const badge = t.r
    ? '<span class="seq-tag rev">Swiss-Prot</span>'
    : '<span class="seq-tag un">TrEMBL</span>';
  return `<div class="ext-links"><span class="ext-label">Sequence</span>` +
    links.map(([txt, u]) => `<a class="ext-btn" href="${u}" target="_blank" rel="noopener">${txt}</a>`).join("") +
    ` ${badge}</div>`;
}

// TCDB transporter-family annotation (shown for transporters only)
function tcdbBadge(id) {
  const t = tcdbFam[String(id)];
  if (!t) return "";
  const verdict = t.v === "consistent"
    ? '<span class="tcdb-ok">substrate consistent with TCDB ✓</span>'
    : t.v === "mismatch"
    ? '<span class="tcdb-warn">substrate differs from TCDB family</span>'
    : "";
  return `<div class="tcdb-box"><span class="tcdb-label">TCDB</span>` +
    `<a href="https://www.tcdb.org/search/result.php?tc=${esc(t.tc)}" target="_blank" rel="noopener">TC ${esc(t.tc)} ↗</a>` +
    ` <span class="tcdb-fam">${esc(t.fam)}</span> · expected ${esc(t.exp)} ${verdict}</div>`;
}

// ---- co-citation ego network ----
function renderGraph(id) {
  const host = $("#tab-graph");
  const center = rows("SELECT gene_id, canonical_gene, species, gene_role FROM genes WHERE gene_id=?", [id])[0];
  const nb = rows(
    `SELECT b.gene_id id, g.canonical_gene name, g.species species, g.gene_role role,
            COUNT(DISTINCT a.pmid) w
     FROM gene_pmid a
     JOIN gene_pmid b ON a.pmid=b.pmid AND b.gene_id<>a.gene_id
     JOIN genes g ON g.gene_id=b.gene_id
     WHERE a.gene_id=? GROUP BY b.gene_id ORDER BY w DESC, g.n_pmids DESC LIMIT 30`,
    [id]
  );
  if (!nb.length) {
    host.innerHTML =
      '<div class="empty-state">No co-citations — in this dataset, every paper supporting this gene mentions it alone.</div>';
    return;
  }
  const ids = [id, ...nb.map((n) => n.id)];
  const idset = ids.join(",");
  const edges = rows(
    `SELECT a.gene_id s, b.gene_id t, COUNT(DISTINCT a.pmid) w
     FROM gene_pmid a JOIN gene_pmid b ON a.pmid=b.pmid AND a.gene_id<b.gene_id
     WHERE a.gene_id IN (${idset}) AND b.gene_id IN (${idset})
     GROUP BY a.gene_id, b.gene_id`
  );

  const W = 720, H = 460;
  const maxW = Math.max(...nb.map((n) => n.w), 1);
  const nodes = [
    { id: center.gene_id, name: center.canonical_gene, species: center.species, role: center.gene_role, w: 0, isCenter: true },
    ...nb.map((n) => ({ id: n.id, name: n.name, species: n.species, role: n.role, w: n.w, isCenter: false })),
  ];
  nodes.forEach((n) => { n.r = n.isCenter ? 20 : 7 + 11 * (n.w / maxW); });

  simulate(nodes, edges, W, H);

  const meta =
    `<div class="graph-meta">
       <span><strong>${nb.length}</strong> co-cited genes · edge width = shared papers</span>
       <span class="lg"><span class="dot" style="background:#1b76b0"></span>Positive</span>
       <span class="lg"><span class="dot" style="background:#c0533b"></span>Negative</span>
       <span class="lg"><span class="dot" style="background:#8aa1b0"></span>Unclear/other</span>
     </div>`;
  host.innerHTML =
    meta +
    `<svg class="graph-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"></svg>` +
    `<div class="graph-hint">Drag a node to rearrange · click a neighbour to re-center the network · node size = shared papers with the focus gene.</div>`;
  drawGraph(host.querySelector("svg"), nodes, edges, W, H);
}

// Fruchterman–Reingold layout with a pinned center node + gentle gravity.
function simulate(nodes, edges, W, H) {
  const n = nodes.length;
  const k = Math.sqrt((W * H) / n) * 0.62;
  const idx = Object.fromEntries(nodes.map((nd, i) => [nd.id, i]));
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.34;
  nodes.forEach((nd, i) => {
    const a = (2 * Math.PI * i) / n;
    nd.x = cx + R * Math.cos(a) + ((i * 7) % 13) - 6;
    nd.y = cy + R * Math.sin(a) + ((i * 5) % 11) - 5;
  });
  let t = Math.min(W, H) * 0.12;
  for (let it = 0; it < 350; it++) {
    nodes.forEach((nd) => { nd.dx = 0; nd.dy = 0; });
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        let dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
        let d = Math.hypot(dx, dy) || 0.01;
        let f = (k * k) / d;
        let ux = dx / d, uy = dy / d;
        nodes[i].dx += ux * f; nodes[i].dy += uy * f;
        nodes[j].dx -= ux * f; nodes[j].dy -= uy * f;
      }
    edges.forEach((e) => {
      const a = nodes[idx[e.s]], b = nodes[idx[e.t]];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d = Math.hypot(dx, dy) || 0.01;
      let f = ((d * d) / k) * (0.5 + 0.12 * Math.min(e.w, 4));
      let ux = dx / d, uy = dy / d;
      a.dx -= ux * f; a.dy -= uy * f;
      b.dx += ux * f; b.dy += uy * f;
    });
    nodes.forEach((nd) => {
      nd.dx += (cx - nd.x) * 0.016;
      nd.dy += (cy - nd.y) * 0.016;
      if (nd.isCenter) { nd.x = cx; nd.y = cy; return; }
      let d = Math.hypot(nd.dx, nd.dy) || 0.01;
      let lim = Math.min(d, t);
      nd.x += (nd.dx / d) * lim;
      nd.y += (nd.dy / d) * lim;
      nd.x = Math.max(nd.r + 4, Math.min(W - nd.r - 4, nd.x));
      nd.y = Math.max(nd.r + 14, Math.min(H - nd.r - 4, nd.y));
    });
    t *= 0.975;
  }
}

const SVGNS = "http://www.w3.org/2000/svg";
function drawGraph(svg, nodes, edges, W, H) {
  const idx = Object.fromEntries(nodes.map((nd, i) => [nd.id, i]));
  const maxEW = Math.max(...edges.map((e) => e.w), 1);
  svg.innerHTML = "";
  const gEdges = document.createElementNS(SVGNS, "g");
  const gNodes = document.createElementNS(SVGNS, "g");
  svg.appendChild(gEdges);
  svg.appendChild(gNodes);

  const lineEls = edges.map((e) => {
    const ln = document.createElementNS(SVGNS, "line");
    ln.setAttribute("class", "edge");
    ln.setAttribute("stroke-width", (1 + 3 * (e.w / maxEW)).toFixed(2));
    ln.setAttribute("stroke-opacity", "0.7");
    gEdges.appendChild(ln);
    return ln;
  });

  const nodeEls = nodes.map((nd) => {
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "node" + (nd.isCenter ? " center" : ""));
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("r", nd.r);
    c.setAttribute("fill", ROLE_COLOR(nd.role));
    const title = document.createElementNS(SVGNS, "title");
    title.textContent = nd.isCenter
      ? `${nd.name} (${nd.species}) — focus gene`
      : `${nd.name} (${nd.species}) — ${nd.w} shared paper${nd.w > 1 ? "s" : ""}`;
    c.appendChild(title);
    const txt = document.createElementNS(SVGNS, "text");
    txt.setAttribute("text-anchor", "middle");
    txt.setAttribute("dy", (-nd.r - 4).toString());
    txt.textContent = nd.name;
    g.appendChild(c);
    g.appendChild(txt);
    gNodes.appendChild(g);
    return g;
  });

  const place = () => {
    nodes.forEach((nd, i) => nodeEls[i].setAttribute("transform", `translate(${nd.x},${nd.y})`));
    edges.forEach((e, i) => {
      const a = nodes[idx[e.s]], b = nodes[idx[e.t]];
      lineEls[i].setAttribute("x1", a.x); lineEls[i].setAttribute("y1", a.y);
      lineEls[i].setAttribute("x2", b.x); lineEls[i].setAttribute("y2", b.y);
    });
  };
  place();

  // drag to rearrange; a click (no drag) on a neighbour re-centers the graph
  let drag = null, moved = false, startPt = null;
  const toSvg = (ev) => {
    const rect = svg.getBoundingClientRect();
    return { x: ((ev.clientX - rect.left) / rect.width) * W, y: ((ev.clientY - rect.top) / rect.height) * H };
  };
  nodeEls.forEach((g, i) => {
    g.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      drag = i; moved = false; startPt = toSvg(ev);
      g.setPointerCapture(ev.pointerId);
    });
    g.addEventListener("pointermove", (ev) => {
      if (drag !== i) return;
      const p = toSvg(ev);
      if (Math.hypot(p.x - startPt.x, p.y - startPt.y) > 4) moved = true;
      nodes[i].x = p.x; nodes[i].y = p.y;
      place();
    });
    g.addEventListener("pointerup", () => {
      if (drag === i && !moved && !nodes[i].isCenter) openGene(nodes[i].id, "graph");
      drag = null;
    });
  });
}

// ---- dashboard: view switch + proportion charts ----
function setupViewNav() {
  document.querySelectorAll(".vtab").forEach((b) =>
    b.addEventListener("click", () => showView(b.dataset.view)));
}
function showView(view) {
  document.querySelectorAll(".vtab").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#view-dashboard").classList.toggle("hidden", view !== "dashboard");
  $("#view-browse").classList.toggle("hidden", view !== "browse");
  $("#view-kg").classList.toggle("hidden", view !== "kg");
  $("#view-download").classList.toggle("hidden", view !== "download");
  $("#view-mcp").classList.toggle("hidden", view !== "mcp");
  if (view === "kg" && typeof initKG === "function") initKG();
}

// Open a gene's detail modal by (name, species) — used by the KG view. Matches the
// canonical name first, then the name as a full alias token in all_names.
function openGeneByName(name, species) {
  let r = rows("SELECT gene_id FROM genes WHERE species=? AND canonical_gene=? COLLATE NOCASE LIMIT 1", [species, name]);
  if (!r.length) {
    const key = "%;" + name.toLowerCase().replace(/ /g, "") + ";%";
    r = rows("SELECT gene_id FROM genes WHERE species=? AND (';'||replace(lower(all_names),' ','')||';') LIKE ? LIMIT 1", [species, key]);
  }
  if (r.length) { openGene(r[0].gene_id, "details"); return true; }
  return false;
}

// ocean depth gradient — shallow aqua → deep abyssal navy (seawater by depth)
const PALETTE = ["#aee3ea","#8ad4de","#66c3d4","#45afc8","#2f99bd","#2182b0",
  "#186ca2","#135892","#0f477e","#0c3a6a","#0a2f56","#082544","#061b33"];

// collapse the long tail of a sorted [{v,n}] list into a single "Other" slice
function collapseTail(data, topN) {
  if (data.length <= topN + 1) return data;
  const rest = data.slice(topN).reduce((s, d) => s + d.n, 0);
  return [...data.slice(0, topN), { v: `Other (${data.length - topN} more)`, n: rest }];
}

// map a click anywhere on a horizontal-bar row (incl. the y-axis label gutter) to its data index
function rowFromEvent(e, chart, len) {
  const y = e.y != null ? e.y : (e.native ? e.native.offsetY : null);
  if (y == null) return null;
  const ca = chart.chartArea;
  if (ca && (y < ca.top || y > ca.bottom)) return null;
  const idx = Math.round(chart.scales.y.getValueForPixel(y));
  return idx >= 0 && idx < len ? idx : null;
}

function barChartH(id, data, onItem) {
  const ctx = document.getElementById(id);
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: "bar",
    data: { labels: data.map((d) => d.v),
      datasets: [{ data: data.map((d) => d.n), backgroundColor: data.map((_, i) => PALETTE[i % PALETTE.length]) }] },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { font: { size: 11 } } }, y: { ticks: { font: { size: 11 }, autoSkip: false } } },
      onClick: onItem
        ? (e, _els, chart) => {
            const idx = rowFromEvent(e, chart, data.length);
            if (idx != null) { const d = data[idx]; if (d && d.id != null) onItem(d.id); }
          }
        : undefined,
      onHover: onItem
        ? (e, _els, chart) => {
            e.native.target.style.cursor = rowFromEvent(e, chart, data.length) != null ? "pointer" : "default";
          }
        : undefined,
    },
  });
}

function doughnut(id, data) {
  const ctx = document.getElementById(id);
  if (charts[id]) charts[id].destroy();
  const total = data.reduce((s, d) => s + d.n, 0) || 1;
  charts[id] = new Chart(ctx, {
    type: "doughnut",
    data: { labels: data.map((d) => d.v),
      datasets: [{ data: data.map((d) => d.n), backgroundColor: data.map((_, i) => PALETTE[i % PALETTE.length]) }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { font: { size: 11 }, boxWidth: 12, padding: 7 } },
        tooltip: { callbacks: { label: (c) => `${c.label}: ${c.parsed} (${((c.parsed / total) * 100).toFixed(1)}%)` } },
      },
    },
  });
}

function renderCharts() {
  barChartH("chart-topgenes",
    rows("SELECT gene_id id, canonical_gene || '  ·  ' || species v, n_pmids n FROM genes ORDER BY n_pmids DESC, canonical_gene LIMIT 15"),
    (gid) => openGene(gid, "details"));
  doughnut("chart-species",
    collapseTail(rows("SELECT species v, n_genes n FROM species_dim ORDER BY n_genes DESC"), 12));
  doughnut("chart-cat",
    collapseTail(rows("SELECT category v, COUNT(*) n FROM gene_category GROUP BY category ORDER BY n DESC"), 10));
  doughnut("chart-role",
    rows(`SELECT CASE
            WHEN gene_role LIKE 'Positive%' THEN 'Positive regulator'
            WHEN gene_role LIKE 'Negative%' THEN 'Negative regulator'
            ELSE 'Unclear / mixed' END v,
          COUNT(*) n FROM genes GROUP BY v ORDER BY n DESC`));
  doughnut("chart-evidence",
    rows("SELECT evidence_strength v, COUNT(*) n FROM genes WHERE evidence_strength IS NOT NULL AND evidence_strength<>'' GROUP BY evidence_strength ORDER BY n DESC"));
  barChartH("chart-mech",
    rows("SELECT mechanism v, COUNT(*) n FROM gene_mechanism GROUP BY mechanism ORDER BY n DESC"));
  barChartH("chart-substrate",
    rows("SELECT substrate v, COUNT(*) n FROM gene_substrate WHERE substrate<>'Not applicable' GROUP BY substrate ORDER BY n DESC LIMIT 12"));
}

// ---- visitor world map ----
// To colour EVERY visited country, set ONE of these:
//   PANTRY_ID   – a free getpantry.cloud id (no account/password, no backend to host)  ← recommended
//   VISITOR_API – a Cloudflare Worker URL (see backend/cloudflare-worker.js)
// Leave both empty for self-contained mode (only the current visitor's country).
const PANTRY_ID = "d9eb8e96-d8d5-4fbd-8485-4b7e24d373e4";
const VISITOR_API = "";
const VM_NS = "salt-gene-db";  // abacus namespace (used only in self-contained mode)
let vmAgg = {};                // {CC: count} for region tooltips in aggregate mode

async function detectGeo() {
  for (const url of ["https://get.geojs.io/v1/ip/geo.json", "https://ipwho.is/"]) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      const cc = String(j.country_code || "").toUpperCase();
      if (cc) return { cc, country: j.country, lat: +j.latitude, lng: +j.longitude };
    } catch (_) { /* try next */ }
  }
  return null;
}
async function abacus(kind, key) {
  const r = await fetch(`https://abacus.jasoncameron.dev/${kind}/${VM_NS}/${key}`);
  if (!r.ok) throw new Error("counter " + r.status);
  return (await r.json()).value;
}

async function initVisitorMap() {
  const holder = document.getElementById("visitor-map");
  const cap = document.getElementById("vis-caption");
  if (!holder || typeof jsVectorMap === "undefined") return;

  let map;
  try {
    map = new jsVectorMap({
      selector: "#visitor-map",
      map: "world",
      zoomButtons: true,
      backgroundColor: "transparent",
      regionStyle: {
        initial: { fill: "#d4e3ee", stroke: "#ffffff", strokeWidth: 0.4 },
        hover: { fill: "#9fc3dd" },
      },
      markersSelectable: false,
      markerStyle: { initial: { fill: "#c0533b", stroke: "#fff", strokeWidth: 1.5, r: 6 } },
      series: { regions: [{ attribute: "fill", scale: ["#bcd6e8", "#0c3a63"],
        normalizeFunction: "polynomial", values: {} }] },
      onRegionTooltipShow(_e, tooltip, code) {
        const n = vmAgg[code];
        if (n != null) tooltip.text(`${tooltip.text()}: ${(+n).toLocaleString()} visit${+n === 1 ? "" : "s"}`, true);
      },
    });
  } catch (e) {
    if (cap) cap.textContent = "Visitor map failed to load.";
    return;
  }

  const geo = await detectGeo();
  if (VISITOR_API && await runWorkerMode(map, cap, geo)) return;
  if (PANTRY_ID && await runPantryMode(map, cap, geo)) return;
  await runSingleCountry(map, cap, geo);
}

// Colour every country from an aggregate {CC: count} and write the caption.
function paintAggregate(map, cap, geo, raw) {
  if (!raw || typeof raw !== "object") return false;
  // keep only real ISO-2 country codes with numeric counts (drops Pantry's _metadata etc.)
  const agg = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = +v;
    if (/^[A-Z]{2}$/.test(k) && Number.isFinite(n) && n > 0) agg[k] = n;
  }
  if (!Object.keys(agg).length) return false;
  vmAgg = agg;
  try { map.series.regions[0].setValues(agg); } catch (_) {}
  if (geo) {
    try { if (Number.isFinite(geo.lat) && Number.isFinite(geo.lng))
      map.addMarkers([{ name: geo.country, coords: [geo.lat, geo.lng] }]); } catch (_) {}
  }
  const total = Object.values(agg).reduce((s, n) => s + (+n || 0), 0);
  const nC = Object.keys(agg).length;
  if (cap) {
    cap.innerHTML =
      `<strong>${total.toLocaleString()}</strong> visits from <strong>${nC}</strong> countr${nC === 1 ? "y" : "ies"}` +
      (geo ? ` · you're visiting from <strong>${esc(geo.country)}</strong>` : "");
  }
  return true;
}

// All-countries via Cloudflare Worker.
async function runWorkerMode(map, cap, geo) {
  try {
    const base = VISITOR_API.replace(/\/$/, "");
    const fresh = geo && !sessionStorage.getItem("vm_counted");
    const resp = fresh ? await fetch(`${base}/hit?cc=${geo.cc}`, { method: "POST" }) : await fetch(base);
    const agg = await resp.json();
    if (fresh) sessionStorage.setItem("vm_counted", "1");
    return paintAggregate(map, cap, geo, agg);
  } catch (_) { return false; }
}

// All-countries via Pantry (getpantry.cloud) — no backend to host.
async function runPantryMode(map, cap, geo) {
  const base = `https://getpantry.cloud/apiv1/pantry/${PANTRY_ID}/basket/visitors`;
  let agg = {};
  try { const r = await fetch(base); if (r.ok) agg = await r.json(); } catch (_) {}
  if (!agg || typeof agg !== "object") agg = {};
  try {
    if (geo && !sessionStorage.getItem("vm_counted")) {
      const next = (+agg[geo.cc] || 0) + 1;
      const exists = Object.keys(agg).length > 0;          // PUT merges; POST creates the basket
      await fetch(base, {
        method: exists ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [geo.cc]: next }),
      });
      agg[geo.cc] = next;
      sessionStorage.setItem("vm_counted", "1");
    }
  } catch (_) { /* still paint whatever we managed to read */ }
  return paintAggregate(map, cap, geo, agg);
}

// Self-contained fallback: only the current visitor's country is highlighted.
async function runSingleCountry(map, cap, geo) {
  if (!geo) { if (cap) cap.textContent = "Couldn't determine your location — map shown without a marker."; return; }
  let cCount = null, total = null;
  try {
    const fresh = !sessionStorage.getItem("vm_counted");
    const kind = fresh ? "hit" : "get";
    cCount = await abacus(kind, "c_" + geo.cc);
    total = await abacus(kind, "total");
    if (fresh) sessionStorage.setItem("vm_counted", "1");
  } catch (_) { /* counters optional */ }

  vmAgg = cCount != null ? { [geo.cc]: cCount } : {};
  try { map.series.regions[0].setValues({ [geo.cc]: cCount || 1 }); } catch (_) {}
  try { if (map.regions && map.regions[geo.cc]) map.regions[geo.cc].element.setStyle("fill", "#1b76b0"); } catch (_) {}
  try { if (Number.isFinite(geo.lat) && Number.isFinite(geo.lng))
    map.addMarkers([{ name: geo.country, coords: [geo.lat, geo.lng] }]); } catch (_) {}

  if (cap) {
    cap.innerHTML =
      `You're visiting from <strong>${esc(geo.country)}</strong>` +
      (cCount != null ? ` — <strong>${cCount.toLocaleString()}</strong> visit${cCount === 1 ? "" : "s"} from your country` : "") +
      (total != null ? ` · <strong>${total.toLocaleString()}</strong> total visits` : "");
  }
}

boot();
initVisitorMap();
