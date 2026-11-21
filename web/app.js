(() => {
  "use strict";

  const DATA = window.RESIDENT_DATA;
  if (!DATA || !Array.isArray(DATA.records)) {
    document.body.innerHTML = "<p style='padding:24px'>데이터(web/data.js)를 불러오지 못했습니다. <code>python3 build_data.py</code>를 실행해 주세요.</p>";
    return;
  }

  // =========================================================================
  // Constants & Helpers
  // =========================================================================
  const METRO_REGIONS = new Set(["서울", "인천", "경기"]);
  const ESSENTIAL_DEPTS = new Set(["내과", "외과", "산부인과", "소아청소년과", "응급의학과", "심장혈관흉부외과"]);
  const POPULAR_DEPTS = new Set(["피부과", "안과", "성형외과", "정형외과", "재활의학과", "영상의학과"]);
  const SERIES_COLORS = [
    "#0d9488", "#4f46e5", "#d97706", "#e11d48", "#0284c7", "#7c3aed"
  ];
  const collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });
  const fmt = (n) => Number(n || 0).toLocaleString("ko-KR");
  const esc = (s) => String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const TERMS = DATA.terms;
  const TERM_BY_ID = Object.fromEntries(TERMS.map((t) => [t.id, t]));
  const LATEST_TERM = TERMS[TERMS.length - 1]?.id || "2027-1";
  const PREV_FIRST_HALF = TERMS.find((t) => t.id === "2026-1")?.id || TERMS[Math.max(0, TERMS.length - 2)]?.id;

  // Compute hospital scale per term:
  // 대형: resident total TO >= 30, 중형: 10..29, 소형: <= 9 (fallback to intern TO if no resident records)
  const scaleMap = new Map(); // `${term}|${hospital}` -> 'large' | 'medium' | 'small'
  const resSumByTermHosp = new Map();
  const intSumByTermHosp = new Map();
  for (const r of DATA.records) {
    const k = `${r.term}|${r.hospital}`;
    if (r.type === "resident") {
      resSumByTermHosp.set(k, (resSumByTermHosp.get(k) || 0) + r.to);
    } else {
      intSumByTermHosp.set(k, (intSumByTermHosp.get(k) || 0) + r.to);
    }
  }
  const allTermHosps = new Set([...resSumByTermHosp.keys(), ...intSumByTermHosp.keys()]);
  for (const k of allTermHosps) {
    const base = resSumByTermHosp.has(k) ? resSumByTermHosp.get(k) : (intSumByTermHosp.get(k) || 0);
    scaleMap.set(k, base >= 30 ? "large" : base >= 10 ? "medium" : "small");
  }
  const getScale = (term, hospital) => scaleMap.get(`${term}|${hospital}`) || "small";
  const scaleLabel = (s) => (s === "large" ? "대형" : s === "medium" ? "중형" : "소형");

  // =========================================================================
  // Application State
  // =========================================================================
  const state = {
    type: "resident",        // 'resident' | 'intern'
    tab: "overview",         // 'overview' | 'hospitals' | 'ratio' | 'diff' | 'table'
    term: LATEST_TERM,       // term.id or 'ALL'
    regions: new Set(),
    depts: new Set(),
    size: "all",             // 'all' | 'large' | 'medium' | 'small'
    search: "",
    hideZero: true,
    extraOnly: false,
    newOnly: false,
    hospitalSort: "to_desc",
    compareSet: new Set(),
    diffFrom: PREV_FIRST_HALF,
    diffTo: LATEST_TERM,
    ratioFromTerm: PREV_FIRST_HALF,
    ratioMinIntern: 10,
    ratioHideZeroDept: true,
    lastRatioRows: [],
    schoolKind: "all",       // 'all' | '국립' | '사립'
    schoolFromTerm: PREV_FIRST_HALF,
    lastSchoolRows: [],
    filterDrawerOpen: false,
    tableLimit: 300,
    lastFiltered: [],
  };

  // =========================================================================
  // Theme Toggle (modern-web-guidance: dark-mode-toggle)
  // =========================================================================
  const metaColorScheme = document.querySelector('meta[name="color-scheme"]');
  const themeToggleBtn = document.getElementById("themeToggle");

  function getSystemScheme() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function getStoredScheme() {
    try {
      const v = localStorage.getItem("color-scheme");
      return v === "light" || v === "dark" ? v : null;
    } catch {
      return null;
    }
  }

  function applyScheme(stored) {
    metaColorScheme.content = stored ?? "light dark";
  }

  themeToggleBtn.addEventListener("click", () => {
    const system = getSystemScheme();
    const current = getStoredScheme() ?? system;
    const target = current === "dark" ? "light" : "dark";
    try {
      if (target === system) {
        localStorage.removeItem("color-scheme");
        applyScheme(null);
      } else {
        localStorage.setItem("color-scheme", target);
        applyScheme(target);
      }
    } catch {
      applyScheme(target === system ? null : target);
    }
  });

  window.addEventListener("storage", (e) => {
    if (e.key === "color-scheme") applyScheme(getStoredScheme());
  });

  // =========================================================================
  // Light-Dismiss Dialog Fallback (modern-web-guidance: light-dismiss-a-dialog)
  // =========================================================================
  function attachDialogFallback(dialog) {
    if (!dialog || "closedBy" in HTMLDialogElement.prototype) return;
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!inside) dialog.close();
    });
  }
  const schoolDialog = document.getElementById("schoolDialog");
  const hospitalDialog = document.getElementById("hospitalDialog");
  const compareDialog = document.getElementById("compareDialog");
  attachDialogFallback(schoolDialog);
  attachDialogFallback(hospitalDialog);
  attachDialogFallback(compareDialog);

  // =========================================================================
  // Tooltip Controller
  // =========================================================================
  const tooltipEl = document.getElementById("chartTooltip");
  function showTooltip(evt, html) {
    tooltipEl.innerHTML = html;
    tooltipEl.hidden = false;
    positionTooltip(evt);
  }
  function positionTooltip(evt) {
    if (tooltipEl.hidden) return;
    const pad = 14;
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    const rect = tooltipEl.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
    tooltipEl.style.left = `${Math.max(8, x)}px`;
    tooltipEl.style.top = `${Math.max(8, y)}px`;
  }
  function hideTooltip() {
    tooltipEl.hidden = true;
  }

  // =========================================================================
  // Filtering Engine
  // =========================================================================
  function matchesBaseFilters(r, { ignoreTerm = false, ignoreRegion = false, ignoreDept = false } = {}) {
    if (r.type !== state.type) return false;
    if (!ignoreTerm && state.term !== "ALL" && r.term !== state.term) return false;
    if (!ignoreRegion && state.regions.size > 0 && !state.regions.has(r.region)) return false;
    if (!ignoreDept && state.type === "resident" && state.depts.size > 0 && !state.depts.has(r.dept)) return false;
    if (state.size !== "all" && getScale(r.term, r.hospital) !== state.size) return false;
    if (state.hideZero && r.to === 0) return false;
    if (state.extraOnly && !(r.extra > 0)) return false;
    if (state.newOnly && !r.note.includes("신규")) return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      const hay = `${r.hospital} ${r.dept} ${r.region} ${r.note}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function getFilteredRecords(opts) {
    return DATA.records.filter((r) => matchesBaseFilters(r, opts));
  }

  function findComparablePrevTerm(termId) {
    if (termId === "ALL") return null;
    const cur = TERM_BY_ID[termId];
    if (!cur) return null;
    // Prefer same half in previous year, else immediately preceding term
    const sameHalfPrev = TERMS.slice().reverse().find((t) => t.sort < cur.sort && t.half === cur.half);
    if (sameHalfPrev) return sameHalfPrev.id;
    const prev = TERMS.slice().reverse().find((t) => t.sort < cur.sort);
    return prev ? prev.id : null;
  }

  // =========================================================================
  // Static Controls Initialization
  // =========================================================================
  function initControls() {
    // Data range label (compact)
    if (TERMS.length >= 2) {
      document.getElementById("dataRangeLabel").textContent =
        `${TERMS[0].year}–${TERMS[TERMS.length - 1].year}`;
    }

    // Term pills (latest first for quick access)
    const termPills = document.getElementById("termPills");
    const termBtns = [
      ...TERMS.slice().reverse().map((t) => {
        const cls = t.id === LATEST_TERM ? "term-pill term-pill--latest is-active" : "term-pill";
        return `<button type="button" class="${cls}" data-term="${t.id}">${esc(t.label)}</button>`;
      }),
      `<button type="button" class="term-pill" data-term="ALL">전체 합산</button>`,
    ];
    termPills.innerHTML = termBtns.join("");
    termPills.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-term]");
      if (!btn) return;
      state.term = btn.dataset.term;
      state.tableLimit = 300;
      renderAll();
    });

    // Region chips
    const regionChips = document.getElementById("regionChips");
    regionChips.innerHTML = DATA.regions
      .map((reg) => `<button type="button" class="chip" data-region="${esc(reg)}">${esc(reg)}</button>`)
      .join("");
    regionChips.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-region]");
      if (!btn) return;
      const r = btn.dataset.region;
      if (state.regions.has(r)) state.regions.delete(r);
      else state.regions.add(r);
      state.tableLimit = 300;
      renderAll();
    });

    // Region presets (toggleable!)
    document.querySelectorAll("[data-region-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = btn.dataset.regionPreset;
        if (p === "metro") {
          const isAlready = state.regions.size === METRO_REGIONS.size && [...METRO_REGIONS].every((r) => state.regions.has(r));
          state.regions.clear();
          if (!isAlready) DATA.regions.forEach((r) => { if (METRO_REGIONS.has(r)) state.regions.add(r); });
        } else if (p === "nonmetro") {
          const nonMetro = DATA.regions.filter((r) => !METRO_REGIONS.has(r));
          const isAlready = state.regions.size === nonMetro.length && nonMetro.every((r) => state.regions.has(r));
          state.regions.clear();
          if (!isAlready) nonMetro.forEach((r) => state.regions.add(r));
        } else {
          state.regions.clear();
        }
        state.tableLimit = 300;
        renderAll();
      });
    });

    // Dept chips
    const deptChips = document.getElementById("deptChips");
    deptChips.innerHTML = DATA.depts
      .map((d) => `<button type="button" class="chip" data-dept="${esc(d)}">${esc(d)}</button>`)
      .join("");
    deptChips.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-dept]");
      if (!btn) return;
      const d = btn.dataset.dept;
      if (state.depts.has(d)) state.depts.delete(d);
      else state.depts.add(d);
      state.tableLimit = 300;
      renderAll();
    });

    // Dept presets (toggleable!)
    document.querySelectorAll("[data-dept-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = btn.dataset.deptPreset;
        if (p === "essential") {
          const isAlready = state.depts.size === ESSENTIAL_DEPTS.size && [...ESSENTIAL_DEPTS].every((d) => state.depts.has(d));
          state.depts.clear();
          if (!isAlready) DATA.depts.forEach((d) => { if (ESSENTIAL_DEPTS.has(d)) state.depts.add(d); });
        } else if (p === "popular") {
          const isAlready = state.depts.size === POPULAR_DEPTS.size && [...POPULAR_DEPTS].every((d) => state.depts.has(d));
          state.depts.clear();
          if (!isAlready) DATA.depts.forEach((d) => { if (POPULAR_DEPTS.has(d)) state.depts.add(d); });
        } else {
          state.depts.clear();
        }
        state.tableLimit = 300;
        renderAll();
      });
    });

    // Collapsible filter drawer toggle
    const drawerBtn = document.getElementById("toggleFilterDrawer");
    const drawerEl = document.getElementById("filterDrawer");
    drawerBtn.addEventListener("click", () => {
      state.filterDrawerOpen = !state.filterDrawerOpen;
      drawerEl.hidden = !state.filterDrawerOpen;
      drawerBtn.setAttribute("aria-expanded", String(state.filterDrawerOpen));
    });

    // Type switcher
    document.querySelectorAll("[data-type-switch]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.dataset.typeSwitch;
        if (state.type === next) return;
        state.type = next;
        state.compareSet.clear();
        state.tableLimit = 300;
        renderAll();
      });
    });

    // Nav tabs
    document.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.tab = btn.dataset.tab;
        renderAll();
      });
    });

    // Size pills
    document.getElementById("sizePills").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-size]");
      if (!btn) return;
      state.size = btn.dataset.size;
      state.tableLimit = 300;
      renderAll();
    });

    // Search
    const searchInput = document.getElementById("searchInput");
    const searchClear = document.getElementById("searchClear");
    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = searchInput.value.trim();
        searchClear.hidden = !state.search;
        state.tableLimit = 300;
        renderAll();
      }, 100);
    });
    searchClear.addEventListener("click", () => {
      searchInput.value = "";
      state.search = "";
      searchClear.hidden = true;
      searchInput.focus();
      renderAll();
    });

    // Keyboard shortcut '/' to focus search
    window.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "SELECT") {
        e.preventDefault();
        searchInput.focus();
      }
    });

    // Toggles
    document.getElementById("hideZeroToggle").addEventListener("change", (e) => {
      state.hideZero = e.target.checked;
      renderAll();
    });
    document.getElementById("extraOnlyToggle").addEventListener("change", (e) => {
      state.extraOnly = e.target.checked;
      renderAll();
    });
    document.getElementById("newOnlyToggle").addEventListener("change", (e) => {
      state.newOnly = e.target.checked;
      if (state.newOnly && state.hideZero) {
        // 2027 신규 중 TO 0인 과목도 볼 수 있게 자동 해제
        state.hideZero = false;
        document.getElementById("hideZeroToggle").checked = false;
      }
      renderAll();
    });

    // Reset Filters
    document.getElementById("resetFiltersBtn").addEventListener("click", () => {
      state.regions.clear();
      state.depts.clear();
      state.size = "all";
      state.search = "";
      state.hideZero = true;
      state.extraOnly = false;
      state.newOnly = false;
      searchInput.value = "";
      searchClear.hidden = true;
      document.getElementById("hideZeroToggle").checked = true;
      document.getElementById("extraOnlyToggle").checked = false;
      document.getElementById("newOnlyToggle").checked = false;
      renderAll();
    });

    // Hospital sort & compare
    document.getElementById("hospitalSort").addEventListener("change", (e) => {
      state.hospitalSort = e.target.value;
      renderHospitals();
    });
    document.getElementById("openCompareBtn").addEventListener("click", openCompareModal);

    // Diff selects
    const diffFrom = document.getElementById("diffFrom");
    const diffTo = document.getElementById("diffTo");
    const opts = TERMS.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("");
    diffFrom.innerHTML = opts;
    diffTo.innerHTML = opts;
    diffFrom.value = state.diffFrom;
    diffTo.value = state.diffTo;
    diffFrom.addEventListener("change", () => {
      state.diffFrom = diffFrom.value;
      renderDiffTab();
    });
    diffTo.addEventListener("change", () => {
      state.diffTo = diffTo.value;
      renderDiffTab();
    });

    // Export CSV
    document.getElementById("exportCsvBtn").addEventListener("click", exportFilteredCsv);

    // Wire Sortable Table (modern-web-guidance: sortable-table)
    initSortableTable();
    initRatioControls();
    initSchoolControls();
  }

  // =========================================================================
  // Sync Control UI States
  // =========================================================================
  function syncControlsUI() {
    document.body.classList.toggle("is-intern-mode", state.type === "intern");
    document.getElementById("deptFilterRow").hidden = state.type === "intern" && state.tab !== "ratio" && state.tab !== "schools";
    document.getElementById("kpiGrid").hidden = state.tab === "ratio" || state.tab === "diff" || state.tab === "schools";

    document.querySelectorAll("[data-type-switch]").forEach((btn) => {
      const active = btn.dataset.typeSwitch === state.type;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });

    document.querySelectorAll("[data-tab]").forEach((btn) => {
      const active = btn.dataset.tab === state.tab;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });

    ["overview", "schools", "hospitals", "ratio", "diff", "table"].forEach((id) => {
      const panel = document.getElementById(`panel-${id}`);
      const active = state.tab === id;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
    });

    document.querySelectorAll("#termPills [data-term]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.term === state.term);
    });

    document.querySelectorAll("#sizePills [data-size]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.size === state.size);
    });

    document.querySelectorAll("#regionChips [data-region]").forEach((btn) => {
      btn.classList.toggle("is-active", state.regions.has(btn.dataset.region));
    });

    document.querySelectorAll("#deptChips [data-dept]").forEach((btn) => {
      btn.classList.toggle("is-active", state.depts.has(btn.dataset.dept));
    });

    // Highlight active quick preset pills
    const isMetroPreset = state.regions.size === METRO_REGIONS.size && [...METRO_REGIONS].every((r) => state.regions.has(r));
    const nonMetroList = DATA.regions.filter((r) => !METRO_REGIONS.has(r));
    const isNonMetroPreset = state.regions.size === nonMetroList.length && nonMetroList.every((r) => state.regions.has(r));
    const isEssPreset = state.depts.size === ESSENTIAL_DEPTS.size && [...ESSENTIAL_DEPTS].every((d) => state.depts.has(d));
    const isPopPreset = state.depts.size === POPULAR_DEPTS.size && [...POPULAR_DEPTS].every((d) => state.depts.has(d));
    document.querySelectorAll(".quick-presets [data-region-preset]").forEach((btn) => {
      btn.classList.toggle("is-active", (btn.dataset.regionPreset === "metro" && isMetroPreset) || (btn.dataset.regionPreset === "nonmetro" && isNonMetroPreset));
    });
    document.querySelectorAll(".quick-presets [data-dept-preset]").forEach((btn) => {
      btn.classList.toggle("is-active", (btn.dataset.deptPreset === "essential" && isEssPreset) || (btn.dataset.deptPreset === "popular" && isPopPreset));
    });

    const is2027Included = state.term === "2027-1" || state.term === "ALL";
    document.getElementById("extraOnlyWrap").hidden = false;
    document.getElementById("newOnlyWrap").hidden = !is2027Included;

    // Active filter tags (individually removable!)
    const tagObjs = [];
    if (state.regions.size > 0) {
      const txt = isMetroPreset ? "수도권" : isNonMetroPreset ? "비수도권" : [...state.regions].join(", ");
      tagObjs.push({ key: "regions", label: `지역: ${txt}` });
    }
    if ((state.type === "resident" || state.tab === "ratio" || state.tab === "schools") && state.depts.size > 0) {
      const txt = isEssPreset ? "필수의료 6과" : isPopPreset ? "피·안·성·정·재·영" : [...state.depts].join(", ");
      tagObjs.push({ key: "depts", label: `과목: ${txt}` });
    }
    if (state.size !== "all") tagObjs.push({ key: "size", label: `규모: ${scaleLabel(state.size)}` });
    if (state.search) tagObjs.push({ key: "search", label: `검색: "${state.search}"` });
    if (state.extraOnly) tagObjs.push({ key: "extraOnly", label: "별도정원만" });
    if (state.newOnly) tagObjs.push({ key: "newOnly", label: "2027 신규만" });
    if (!state.hideZero) tagObjs.push({ key: "hideZero", label: "TO 0 포함" });

    const hasFilters = tagObjs.length > 0;
    document.getElementById("resetFiltersBtn").hidden = !hasFilters;
    const badge = document.getElementById("filterCountBadge");
    badge.hidden = !hasFilters;
    badge.textContent = String(tagObjs.length);

    const activeBar = document.getElementById("activeBar");
    activeBar.hidden = !hasFilters;
    const tagsContainer = document.getElementById("activeTags");
    tagsContainer.innerHTML = tagObjs
      .map((t) => `<span class="active-tag">${esc(t.label)}<button type="button" class="active-tag-remove" data-clear-tag="${t.key}" aria-label="${esc(t.label)} 해제">×</button></span>`)
      .join("");
    tagsContainer.querySelectorAll("[data-clear-tag]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.dataset.clearTag;
        if (k === "regions") state.regions.clear();
        else if (k === "depts") state.depts.clear();
        else if (k === "size") state.size = "all";
        else if (k === "search") {
          state.search = "";
          document.getElementById("searchInput").value = "";
          document.getElementById("searchClear").hidden = true;
        } else if (k === "extraOnly") {
          state.extraOnly = false;
          document.getElementById("extraOnlyToggle").checked = false;
        } else if (k === "newOnly") {
          state.newOnly = false;
          document.getElementById("newOnlyToggle").checked = false;
        } else if (k === "hideZero") {
          state.hideZero = true;
          document.getElementById("hideZeroToggle").checked = true;
        }
        renderAll();
      });
    });
  }

  // =========================================================================
  // KPI Strip
  // =========================================================================
  function renderKPIs(rows) {
    const totalTO = rows.reduce((s, r) => s + r.to, 0);
    const hospitals = new Set(rows.map((r) => r.hospital));
    const metroTO = rows.reduce((s, r) => s + (METRO_REGIONS.has(r.region) ? r.to : 0), 0);
    const nonMetroTO = totalTO - metroTO;
    const metroPct = totalTO > 0 ? Math.round((metroTO / totalTO) * 1000) / 10 : 0;
    const nonMetroPct = totalTO > 0 ? Math.round((100 - metroPct) * 10) / 10 : 0;

    // YoY delta vs comparable previous term
    const prevTermId = findComparablePrevTerm(state.term);
    let deltaHtml = `<span class="delta-pill delta-pill--flat">전체 시기 합산</span>`;
    if (prevTermId) {
      const prevRows = DATA.records.filter(
        (r) => r.term === prevTermId && matchesBaseFilters(r, { ignoreTerm: true })
      );
      const prevTO = prevRows.reduce((s, r) => s + r.to, 0);
      const diff = totalTO - prevTO;
      const pct = prevTO > 0 ? ((diff / prevTO) * 100).toFixed(1) : "0.0";
      const cls = diff > 0 ? "delta-pill--up" : diff < 0 ? "delta-pill--down" : "delta-pill--flat";
      const sign = diff > 0 ? "+" : "";
      deltaHtml = `<span class="delta-pill ${cls}">${esc(TERM_BY_ID[prevTermId].label)} 대비 ${sign}${fmt(diff)} (${sign}${pct}%)</span>`;
    }

    // Breakdown info (all 2023-2027 official PDFs have base/extra/cut)
    const extraSum = rows.reduce((s, r) => s + (r.extra || 0), 0);
    const cutSum = rows.reduce((s, r) => s + (r.cut || 0), 0);
    let breakdownMeta = "";
    if (extraSum > 0 || cutSum < 0) {
      const baseOnly = totalTO - extraSum - cutSum;
      breakdownMeta = `<span class="delta-pill delta-pill--amber">기본 ${fmt(baseOnly)} · 별도 +${fmt(extraSum)}${cutSum < 0 ? ` · 감원 ${cutSum}` : ""}</span>`;
    }

    // Scale counts
    const scaleCounts = { large: 0, medium: 0, small: 0 };
    const seenH = new Set();
    for (const r of rows) {
      const key = `${r.term}|${r.hospital}`;
      if (seenH.has(key)) continue;
      seenH.add(key);
      scaleCounts[getScale(r.term, r.hospital)]++;
    }

    // Top entity (dept for resident, hospital for intern)
    const topMap = new Map();
    for (const r of rows) {
      const key = state.type === "resident" ? r.dept : r.hospital;
      topMap.set(key, (topMap.get(key) || 0) + r.to);
    }
    const topEntry = [...topMap.entries()].sort((a, b) => b[1] - a[1])[0];
    const topShare = topEntry && totalTO > 0 ? ((topEntry[1] / totalTO) * 100).toFixed(1) : "0.0";

    const kpiGrid = document.getElementById("kpiGrid");
    kpiGrid.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">총 정원 (TO) · ${state.term === "ALL" ? "전체 합산" : esc(TERM_BY_ID[state.term]?.label || "")}</span>
        </div>
        <div class="kpi-val">${fmt(totalTO)}<span style="font-size:14px;font-weight:600;color:var(--ink-2);margin-left:4px">명</span></div>
        <div class="kpi-meta">${deltaHtml}${breakdownMeta}</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">모집 수련기관 수</span>
        </div>
        <div class="kpi-val">${fmt(hospitals.size)}<span style="font-size:14px;font-weight:600;color:var(--ink-2);margin-left:4px">곳</span></div>
        <div class="kpi-meta">
          <span>대형 ${fmt(scaleCounts.large)}</span> ·
          <span>중형 ${fmt(scaleCounts.medium)}</span> ·
          <span>소형 ${fmt(scaleCounts.small)}</span>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">수도권 vs 비수도권</span>
        </div>
        <div class="kpi-val" style="font-size:22px">${metroPct}% <span style="color:var(--ink-3);font-weight:500">/</span> ${nonMetroPct}%</div>
        <div class="split-bar" aria-hidden="true">
          <div class="split-bar-a" style="width:${metroPct}%"></div>
          <div class="split-bar-b" style="width:${nonMetroPct}%"></div>
        </div>
        <div class="kpi-meta">
          <span>수도권 ${fmt(metroTO)}명</span> · <span>비수도권 ${fmt(nonMetroTO)}명</span>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">${state.type === "resident" ? "최다 정원 과목" : "최다 정원 병원"}</span>
        </div>
        <div class="kpi-val" style="font-size:21px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${topEntry ? esc(topEntry[0]) : "—"}</div>
        <div class="kpi-meta">
          ${topEntry ? `<span>${fmt(topEntry[1])}명 (전체의 ${topShare}%)</span>` : "<span>조건에 맞는 데이터 없음</span>"}
        </div>
      </div>
    `;
  }

  // =========================================================================
  // TAB 1: Overview SVG Charts
  // =========================================================================
  function renderOverview(rows) {
    renderTrendChart();
    renderRegionChart(rows);
    renderDeptChart(rows);
    renderScaleDonut(rows);
    renderHeatmap(rows);
  }

  function renderTrendChart() {
    const el = document.getElementById("chartTrend");
    const legendEl = document.getElementById("trendLegend");
    const subEl = document.getElementById("trendSub");

    // Decide series mode:
    // If 1..6 regions selected -> split by region
    // Else if resident & 1..6 depts selected -> split by dept
    // Else -> single total series
    let mode = "total";
    let keys = ["전체"];
    if (state.regions.size >= 1 && state.regions.size <= 6) {
      mode = "region";
      keys = DATA.regions.filter((r) => state.regions.has(r));
      subEl.textContent = `선택한 ${keys.length}개 지역별 시기 추이 (전반기·후반기)`;
    } else if (state.type === "resident" && state.depts.size >= 1 && state.depts.size <= 6) {
      mode = "dept";
      keys = DATA.depts.filter((d) => state.depts.has(d));
      subEl.textContent = `선택한 ${keys.length}개 과목별 시기 추이 (전반기·후반기)`;
    } else {
      subEl.textContent = "2022 후반기 – 2027 전반기 전체 추이 (지역 또는 과목 1~6개 선택 시 다중 추이선 자동 분리)";
    }

    const baseRows = getFilteredRecords({ ignoreTerm: true });
    const series = keys.map((k, idx) => {
      const vals = TERMS.map((t) => {
        let sum = 0;
        for (const r of baseRows) {
          if (r.term !== t.id) continue;
          if (mode === "region" && r.region !== k) continue;
          if (mode === "dept" && r.dept !== k) continue;
          sum += r.to;
        }
        return sum;
      });
      return { name: k, color: SERIES_COLORS[idx % SERIES_COLORS.length], vals };
    });

    legendEl.innerHTML = series
      .map((s) => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${esc(s.name)}</span>`)
      .join("");

    const maxVal = Math.max(10, ...series.flatMap((s) => s.vals));
    const W = 620, H = 215;
    const pad = { top: 20, right: 22, bottom: 32, left: 46 };
    const cw = W - pad.left - pad.right;
    const ch = H - pad.top - pad.bottom;

    const xOf = (i) => pad.left + (TERMS.length === 1 ? cw / 2 : (i / (TERMS.length - 1)) * cw);
    const yOf = (v) => pad.top + ch - (v / maxVal) * ch;

    // Gridlines
    const ticks = 4;
    let gridSvg = "";
    for (let i = 0; i <= ticks; i++) {
      const val = Math.round((maxVal * i) / ticks);
      const y = yOf(val);
      gridSvg += `
        <line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="var(--border)" stroke-dasharray="${i === 0 ? "" : "3 3"}"/>
        <text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" fill="var(--ink-3)" font-size="11">${fmt(val)}</text>
      `;
    }

    // Active term highlight band
    let activeBand = "";
    const activeIdx = TERMS.findIndex((t) => t.id === state.term);
    if (activeIdx >= 0) {
      const ax = xOf(activeIdx);
      activeBand = `<line x1="${ax}" y1="${pad.top}" x2="${ax}" y2="${H - pad.bottom}" stroke="var(--accent)" stroke-opacity="0.3" stroke-width="22" stroke-linecap="round"/>`;
    }

    // Lines & Area (area for single series)
    let pathsSvg = "";
    let dotsSvg = "";
    series.forEach((s) => {
      const pts = s.vals.map((v, i) => [xOf(i), yOf(v)]);
      const dLine = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
      if (series.length === 1) {
        const dArea = `${dLine} L${pts[pts.length - 1][0].toFixed(1)},${(pad.top + ch).toFixed(1)} L${pts[0][0].toFixed(1)},${(pad.top + ch).toFixed(1)} Z`;
        pathsSvg += `<path d="${dArea}" fill="${s.color}" fill-opacity="0.12"/>`;
      }
      pathsSvg += `<path d="${dLine}" fill="none" stroke="${s.color}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`;
      pts.forEach(([x, y], i) => {
        const v = s.vals[i];
        const isSel = TERMS[i].id === state.term;
        dotsSvg += `
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${isSel ? 5.5 : 4}"
            fill="${s.color}" stroke="var(--surface)" stroke-width="2"
            class="trend-dot" data-series="${esc(s.name)}" data-term-idx="${i}" data-val="${v}" style="cursor:pointer"/>
        `;
        if (series.length === 1) {
          dotsSvg += `<text x="${x.toFixed(1)}" y="${(y - 10).toFixed(1)}" text-anchor="middle" fill="var(--ink)" font-size="11" font-weight="700">${fmt(v)}</text>`;
        }
      });
    });

    // X-axis labels
    const xLabels = TERMS.map((t, i) => {
      const isSel = t.id === state.term;
      return `<text x="${xOf(i).toFixed(1)}" y="${H - 12}" text-anchor="middle" fill="${isSel ? "var(--accent-strong)" : "var(--ink-2)"}" font-size="11.5" font-weight="${isSel ? "800" : "600"}" style="cursor:pointer" data-pick-term="${t.id}">${esc(t.label)}</text>`;
    }).join("");

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="시기별 TO 추이 차트">${activeBand}${gridSvg}${pathsSvg}${dotsSvg}${xLabels}</svg>`;

    el.querySelectorAll(".trend-dot").forEach((dot) => {
      dot.addEventListener("mouseenter", (e) => {
        const ti = Number(dot.dataset.termIdx);
        showTooltip(e, `<strong>${esc(TERMS[ti].label)} · ${esc(dot.dataset.series)}</strong>TO: ${fmt(dot.dataset.val)}명<br><span style="opacity:.75">클릭하면 해당 시기로 이동</span>`);
      });
      dot.addEventListener("mousemove", positionTooltip);
      dot.addEventListener("mouseleave", hideTooltip);
      dot.addEventListener("click", () => {
        state.term = TERMS[Number(dot.dataset.termIdx)].id;
        renderAll();
      });
    });

    el.querySelectorAll("[data-pick-term]").forEach((lbl) => {
      lbl.addEventListener("click", () => {
        state.term = lbl.dataset.pickTerm;
        renderAll();
      });
    });
  }

  function renderRegionChart(rows) {
    const el = document.getElementById("chartRegion");
    const map = new Map();
    for (const r of rows) map.set(r.region, (map.get(r.region) || 0) + r.to);
    const items = [...map.entries()].sort((a, b) => b[1] - a[1]);
    if (!items.length) {
      el.innerHTML = `<div class="empty-state">조건에 맞는 지역 데이터가 없습니다.</div>`;
      return;
    }

    const total = items.reduce((s, [, v]) => s + v, 0);
    const maxVal = items[0][1] || 1;
    const rowH = 26;
    const W = 520;
    const H = items.length * rowH + 16;
    const labelW = 50;
    const valW = 86;
    const barMax = W - labelW - valW - 14;

    const rowsSvg = items.map(([reg, val], i) => {
      const y = 8 + i * rowH;
      const bw = Math.max(2, (val / maxVal) * barMax);
      const pct = total > 0 ? ((val / total) * 100).toFixed(1) : "0.0";
      const isMetro = METRO_REGIONS.has(reg);
      const fill = isMetro ? "var(--accent)" : "var(--indigo)";
      const active = state.regions.has(reg);
      return `
        <g class="svg-bar-row" data-reg="${esc(reg)}" data-val="${val}" data-pct="${pct}">
          <rect class="svg-bar-bg" x="0" y="${y}" width="${W}" height="${rowH - 2}" rx="5" fill="${active ? "var(--accent-soft)" : "transparent"}"/>
          <text x="${labelW - 6}" y="${y + 16}" text-anchor="end" fill="${active ? "var(--accent-strong)" : "var(--ink)"}" font-size="12" font-weight="${active ? "800" : "600"}">${esc(reg)}</text>
          <rect class="svg-bar-fill" x="${labelW}" y="${y + 4}" width="${bw.toFixed(1)}" height="${rowH - 10}" rx="4" fill="${fill}" fill-opacity="${active ? "1" : "0.86"}"/>
          <text x="${W - 6}" y="${y + 16}" text-anchor="end" fill="var(--ink-2)" font-size="11.5" font-weight="650">${fmt(val)} (${pct}%)</text>
        </g>
      `;
    }).join("");

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="지역별 TO 막대 차트">${rowsSvg}</svg>`;
    el.querySelectorAll(".svg-bar-row").forEach((g) => {
      g.addEventListener("mouseenter", (e) => {
        const reg = g.dataset.reg;
        showTooltip(e, `<strong>${esc(reg)} (${METRO_REGIONS.has(reg) ? "수도권" : "비수도권"})</strong>TO: ${fmt(g.dataset.val)}명 (${g.dataset.pct}%)<br><span style="opacity:.75">클릭 시 지역 필터 토글</span>`);
      });
      g.addEventListener("mousemove", positionTooltip);
      g.addEventListener("mouseleave", hideTooltip);
      g.addEventListener("click", () => {
        const reg = g.dataset.reg;
        if (state.regions.has(reg)) state.regions.delete(reg);
        else state.regions.add(reg);
        renderAll();
      });
    });
  }

  function renderDeptChart(rows) {
    const card = document.getElementById("cardDeptChart");
    const el = document.getElementById("chartDept");
    const titleEl = document.getElementById("deptChartTitle");
    const subEl = document.getElementById("deptChartSub");

    if (state.type === "intern") {
      // In intern mode, show Top 15 Hospitals bar chart instead!
      titleEl.textContent = "인턴 TO 상위 15개 병원";
      subEl.textContent = "병원 막대 클릭 시 상세 정보 열기";
      const map = new Map();
      for (const r of rows) map.set(r.hospital, (map.get(r.hospital) || 0) + r.to);
      const items = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
      if (!items.length) {
        el.innerHTML = `<div class="empty-state">조건에 맞는 인턴 데이터가 없습니다.</div>`;
        return;
      }
      const maxVal = items[0][1] || 1;
      const rowH = 27;
      const W = 520;
      const H = items.length * rowH + 16;
      const labelW = 140;
      const valW = 54;
      const barMax = W - labelW - valW - 14;
      const rowsSvg = items.map(([hosp, val], i) => {
        const y = 8 + i * rowH;
        const bw = Math.max(2, (val / maxVal) * barMax);
        const shortName = hosp.length > 11 ? hosp.slice(0, 10) + "…" : hosp;
        return `
          <g class="svg-bar-row" data-hosp="${esc(hosp)}" data-val="${val}">
            <rect class="svg-bar-bg" x="0" y="${y}" width="${W}" height="${rowH - 2}" rx="5" fill="transparent"/>
            <text x="${labelW - 8}" y="${y + 17}" text-anchor="end" fill="var(--ink)" font-size="11.5" font-weight="600">${esc(shortName)}</text>
            <rect class="svg-bar-fill" x="${labelW}" y="${y + 5}" width="${bw.toFixed(1)}" height="${rowH - 12}" rx="4" fill="var(--accent)"/>
            <text x="${W - 6}" y="${y + 17}" text-anchor="end" fill="var(--ink-2)" font-size="11.5" font-weight="700">${fmt(val)}명</text>
          </g>
        `;
      }).join("");
      el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="인턴 상위 병원 차트">${rowsSvg}</svg>`;
      el.querySelectorAll(".svg-bar-row").forEach((g) => {
        g.addEventListener("mouseenter", (e) => showTooltip(e, `<strong>${esc(g.dataset.hosp)}</strong>인턴 TO: ${fmt(g.dataset.val)}명`));
        g.addEventListener("mousemove", positionTooltip);
        g.addEventListener("mouseleave", hideTooltip);
        g.addEventListener("click", () => openHospitalModal(g.dataset.hosp));
      });
      return;
    }

    titleEl.textContent = "과목별 TO";
    subEl.textContent = "막대 클릭 시 과목 필터 · 청록=기본정원 / 주황=별도정원";

    const map = new Map();
    const extraMap = new Map();
    for (const r of rows) {
      if (!r.dept) continue;
      map.set(r.dept, (map.get(r.dept) || 0) + r.to);
      if (r.extra) extraMap.set(r.dept, (extraMap.get(r.dept) || 0) + r.extra);
    }
    const items = [...map.entries()].sort((a, b) => b[1] - a[1]);
    if (!items.length) {
      el.innerHTML = `<div class="empty-state">조건에 맞는 과목 데이터가 없습니다.</div>`;
      return;
    }

    const total = items.reduce((s, [, v]) => s + v, 0);
    const maxVal = items[0][1] || 1;
    const rowH = 25;
    const W = 520;
    const H = items.length * rowH + 16;
    const labelW = 104;
    const valW = 86;
    const barMax = W - labelW - valW - 14;

    const rowsSvg = items.map(([dept, val], i) => {
      const y = 8 + i * rowH;
      const ex = extraMap.get(dept) || 0;
      const baseV = Math.max(0, val - ex);
      const bwTotal = Math.max(2, (val / maxVal) * barMax);
      const bwBase = val > 0 ? (baseV / val) * bwTotal : 0;
      const bwEx = bwTotal - bwBase;
      const pct = total > 0 ? ((val / total) * 100).toFixed(1) : "0.0";
      const active = state.depts.has(dept);
      return `
        <g class="svg-bar-row" data-dept="${esc(dept)}" data-val="${val}" data-extra="${ex}" data-pct="${pct}">
          <rect class="svg-bar-bg" x="0" y="${y}" width="${W}" height="${rowH - 2}" rx="5" fill="${active ? "var(--accent-soft)" : "transparent"}"/>
          <text x="${labelW - 7}" y="${y + 16}" text-anchor="end" fill="${active ? "var(--accent-strong)" : "var(--ink)"}" font-size="11.5" font-weight="${active ? "800" : "600"}">${esc(dept)}</text>
          <rect class="svg-bar-fill" x="${labelW}" y="${y + 4}" width="${bwBase.toFixed(1)}" height="${rowH - 10}" rx="3.5" fill="var(--accent)"/>
          ${ex > 0 ? `<rect class="svg-bar-fill" x="${(labelW + bwBase).toFixed(1)}" y="${y + 4}" width="${Math.max(2, bwEx).toFixed(1)}" height="${rowH - 10}" rx="3.5" fill="var(--amber)"/>` : ""}
          <text x="${W - 6}" y="${y + 16}" text-anchor="end" fill="var(--ink-2)" font-size="11" font-weight="650">${fmt(val)} (${pct}%)</text>
        </g>
      `;
    }).join("");

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="과목별 TO 막대 차트">${rowsSvg}</svg>`;
    el.querySelectorAll(".svg-bar-row").forEach((g) => {
      g.addEventListener("mouseenter", (e) => {
        const ex = Number(g.dataset.extra);
        const exTxt = ex > 0 ? `<br>기본 ${fmt(Number(g.dataset.val) - ex)} + 별도 ${fmt(ex)}` : "";
        showTooltip(e, `<strong>${esc(g.dataset.dept)}</strong>TO: ${fmt(g.dataset.val)}명 (${g.dataset.pct}%)${exTxt}<br><span style="opacity:.75">클릭 시 과목 필터 토글</span>`);
      });
      g.addEventListener("mousemove", positionTooltip);
      g.addEventListener("mouseleave", hideTooltip);
      g.addEventListener("click", () => {
        const d = g.dataset.dept;
        if (state.depts.has(d)) state.depts.delete(d);
        else state.depts.add(d);
        renderAll();
      });
    });
  }

  function renderScaleDonut(rows) {
    const el = document.getElementById("chartScale");
    const sums = { large: 0, medium: 0, small: 0 };
    const hosps = { large: new Set(), medium: new Set(), small: new Set() };
    for (const r of rows) {
      const sc = getScale(r.term, r.hospital);
      sums[sc] += r.to;
      hosps[sc].add(r.hospital);
    }
    const total = sums.large + sums.medium + sums.small;
    if (total === 0) {
      el.innerHTML = `<div class="empty-state">표시할 데이터가 없습니다.</div>`;
      return;
    }

    const slices = [
      { key: "large", label: "대형 (30↑)", val: sums.large, cnt: hosps.large.size, color: "var(--accent)" },
      { key: "medium", label: "중형 (10–29)", val: sums.medium, cnt: hosps.medium.size, color: "var(--indigo)" },
      { key: "small", label: "소형 (9↓)", val: sums.small, cnt: hosps.small.size, color: "var(--amber)" },
    ];

    const cx = 115, cy = 110, R = 76, strokeW = 28;
    const C = 2 * Math.PI * R;
    let offset = 0;
    const arcs = slices.map((s) => {
      const frac = s.val / total;
      const len = frac * C;
      const dash = `${len.toFixed(2)} ${(C - len).toFixed(2)}`;
      const rot = -90 + (offset / C) * 360;
      offset += len;
      return `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${strokeW}"
        stroke-dasharray="${dash}" transform="rotate(${rot.toFixed(2)} ${cx} ${cy})"
        style="cursor:pointer;transition:opacity .15s" data-scale-slice="${s.key}" data-val="${s.val}" data-cnt="${s.cnt}" data-label="${s.label}"/>`;
    }).join("");

    const legendRows = slices.map((s, i) => {
      const y = 52 + i * 52;
      const pct = ((s.val / total) * 100).toFixed(1);
      const isAct = state.size === s.key;
      return `
        <g style="cursor:pointer" data-scale-slice="${s.key}" data-val="${s.val}" data-cnt="${s.cnt}" data-label="${s.label}">
          <rect x="235" y="${y - 16}" width="250" height="42" rx="8" fill="${isAct ? "var(--accent-soft)" : "var(--surface-subtle)"}"/>
          <circle cx="253" cy="${y + 5}" r="6" fill="${s.color}"/>
          <text x="268" y="${y + 2}" fill="var(--ink)" font-size="13" font-weight="700">${s.label}</text>
          <text x="268" y="${y + 18}" fill="var(--ink-2)" font-size="11.5">${fmt(s.cnt)}개 병원</text>
          <text x="472" y="${y + 4}" text-anchor="end" fill="var(--ink)" font-size="13.5" font-weight="800">${fmt(s.val)}명</text>
          <text x="472" y="${y + 19}" text-anchor="end" fill="var(--ink-2)" font-size="11">${pct}%</text>
        </g>
      `;
    }).join("");

    el.innerHTML = `
      <svg viewBox="0 0 500 220" role="img" aria-label="병원 규모별 분포 도넛 차트">
        ${arcs}
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="var(--ink-2)" font-size="11.5" font-weight="600">총 정원</text>
        <text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="var(--ink)" font-size="20" font-weight="800">${fmt(total)}</text>
        ${legendRows}
      </svg>
    `;

    el.querySelectorAll("[data-scale-slice]").forEach((node) => {
      node.addEventListener("mouseenter", (e) => {
        const pct = ((Number(node.dataset.val) / total) * 100).toFixed(1);
        showTooltip(e, `<strong>${esc(node.dataset.label)}</strong>TO: ${fmt(node.dataset.val)}명 (${pct}%)<br>병원 수: ${fmt(node.dataset.cnt)}곳`);
      });
      node.addEventListener("mousemove", positionTooltip);
      node.addEventListener("mouseleave", hideTooltip);
      node.addEventListener("click", () => {
        const k = node.dataset.scaleSlice;
        state.size = state.size === k ? "all" : k;
        renderAll();
      });
    });
  }

  function renderHeatmap(rows) {
    const card = document.getElementById("cardHeatmap");
    const el = document.getElementById("chartHeatmap");
    if (state.type === "intern") {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    const grid = new Map();
    const hospGrid = new Map();
    const regTotals = new Map();
    const deptTotals = new Map();
    let maxVal = 0;

    for (const r of rows) {
      if (!r.dept || !r.region) continue;
      const k = `${r.region}|${r.dept}`;
      const nv = (grid.get(k) || 0) + r.to;
      grid.set(k, nv);
      if (nv > maxVal) maxVal = nv;
      if (!hospGrid.has(k)) hospGrid.set(k, new Set());
      if (r.to > 0) hospGrid.get(k).add(r.hospital);
      regTotals.set(r.region, (regTotals.get(r.region) || 0) + r.to);
      deptTotals.set(r.dept, (deptTotals.get(r.dept) || 0) + r.to);
    }

    const activeRegions = DATA.regions.filter((reg) => (regTotals.get(reg) || 0) > 0);
    const activeDepts = [...deptTotals.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([d]) => d);

    if (!activeRegions.length || !activeDepts.length) {
      el.innerHTML = `<div class="empty-state">히트맵에 표시할 데이터가 없습니다.</div>`;
      return;
    }

    const shortDept = (d) => d
      .replace("심장혈관흉부외과", "흉부외과")
      .replace("마취통증의학과", "마취통증")
      .replace("정신건강의학과", "정신건강")
      .replace("진단검사의학과", "진단검사")
      .replace("직업환경의학과", "직업환경")
      .replace("방사선종양학과", "방사선종")
      .replace("소아청소년과", "소아청소")
      .replace("가정의학과", "가정의학")
      .replace("응급의학과", "응급의학")
      .replace("영상의학과", "영상의학")
      .replace("재활의학과", "재활의학")
      .replace("비뇨의학과", "비뇨의학")
      .replace("예방의학과", "예방의학");

    const levelOf = (v) => {
      if (!v) return 0;
      const ratio = Math.sqrt(v / Math.max(1, maxVal));
      if (ratio < 0.22) return 1;
      if (ratio < 0.42) return 2;
      if (ratio < 0.64) return 3;
      if (ratio < 0.84) return 4;
      return 5;
    };

    const headCols = activeDepts.map((d) => `<th title="${esc(d)}">${esc(shortDept(d))}</th>`).join("");
    const bodyRows = activeRegions.map((reg) => {
      const cells = activeDepts.map((d) => {
        const k = `${reg}|${d}`;
        const v = grid.get(k) || 0;
        const hc = hospGrid.get(k)?.size || 0;
        const lvl = levelOf(v);
        const sel = state.regions.has(reg) && state.depts.has(d) ? " is-selected" : "";
        return `<td><button type="button" class="hm-cell lvl-${lvl}${sel}" data-hm-reg="${esc(reg)}" data-hm-dept="${esc(d)}" data-hm-val="${v}" data-hm-hc="${hc}">${v || "·"}</button></td>`;
      }).join("");
      return `<tr><th class="hm-row-hdr">${esc(reg)}</th>${cells}</tr>`;
    }).join("");

    el.innerHTML = `<table class="heatmap-table"><thead><tr><th class="hm-row-hdr">지역 \\ 과목</th>${headCols}</tr></thead><tbody>${bodyRows}</tbody></table>`;

    el.querySelectorAll(".hm-cell").forEach((btn) => {
      btn.addEventListener("mouseenter", (e) => {
        showTooltip(e, `<strong>${esc(btn.dataset.hmReg)} · ${esc(btn.dataset.hmDept)}</strong>TO: ${fmt(btn.dataset.hmVal)}명 (${fmt(btn.dataset.hmHc)}개 병원)<br><span style="opacity:.75">클릭 시 지역+과목 동시 필터</span>`);
      });
      btn.addEventListener("mousemove", positionTooltip);
      btn.addEventListener("mouseleave", hideTooltip);
      btn.addEventListener("click", () => {
        const reg = btn.dataset.hmReg;
        const dept = btn.dataset.hmDept;
        if (state.regions.size === 1 && state.regions.has(reg) && state.depts.size === 1 && state.depts.has(dept)) {
          state.regions.clear();
          state.depts.clear();
        } else {
          state.regions = new Set([reg]);
          state.depts = new Set([dept]);
        }
        renderAll();
      });
    });
  }

  // =========================================================================
  // TAB 2: Hospital Explorer + Detail Modal + Compare Modal
  // =========================================================================
  function renderHospitals() {
    const rows = state.lastFiltered;
    const prevTermId = findComparablePrevTerm(state.term);

    // Previous term sums per hospital (same type & dept filter)
    const prevMap = new Map();
    if (prevTermId) {
      for (const r of DATA.records) {
        if (r.term !== prevTermId || r.type !== state.type) continue;
        if (state.type === "resident" && state.depts.size > 0 && !state.depts.has(r.dept)) continue;
        prevMap.set(r.hospital, (prevMap.get(r.hospital) || 0) + r.to);
      }
    }

    const byHosp = new Map();
    for (const r of rows) {
      if (!byHosp.has(r.hospital)) {
        byHosp.set(r.hospital, {
          hospital: r.hospital,
          region: r.region,
          to: 0,
          extra: 0,
          cut: 0,
          depts: new Map(),
          scale: getScale(state.term === "ALL" ? LATEST_TERM : state.term, r.hospital),
        });
      }
      const h = byHosp.get(r.hospital);
      h.to += r.to;
      h.extra += r.extra || 0;
      h.cut += r.cut || 0;
      if (r.dept && r.to > 0) h.depts.set(r.dept, (h.depts.get(r.dept) || 0) + r.to);
    }

    let list = [...byHosp.values()].map((h) => {
      const prev = prevTermId ? (prevMap.get(h.hospital) ?? null) : null;
      return {
        ...h,
        prev,
        delta: prev !== null ? h.to - prev : null,
        deptCount: h.depts.size,
      };
    });

    switch (state.hospitalSort) {
      case "to_asc": list.sort((a, b) => a.to - b.to || collator.compare(a.hospital, b.hospital)); break;
      case "delta_desc": list.sort((a, b) => (b.delta ?? -9999) - (a.delta ?? -9999) || b.to - a.to); break;
      case "depts_desc": list.sort((a, b) => b.deptCount - a.deptCount || b.to - a.to); break;
      case "name_asc": list.sort((a, b) => collator.compare(a.hospital, b.hospital)); break;
      default: list.sort((a, b) => b.to - a.to || collator.compare(a.hospital, b.hospital));
    }

    document.getElementById("hospitalCountHeading").textContent =
      `병원 순위 (${fmt(list.length)}개 기관)`;
    updateCompareBtn();

    const grid = document.getElementById("hospitalGrid");
    if (!list.length) {
      grid.innerHTML = `<div class="card card--full"><div class="empty-state">조건에 맞는 병원이 없습니다.</div></div>`;
      return;
    }

    grid.innerHTML = list.map((h, idx) => {
      const topDepts = [...h.depts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      const deltaBadge = h.delta !== null
        ? `<span class="delta-pill ${h.delta > 0 ? "delta-pill--up" : h.delta < 0 ? "delta-pill--down" : "delta-pill--flat"}">${h.delta > 0 ? "+" : ""}${h.delta}</span>`
        : "";
      const extraBadge = h.extra > 0 ? `<span class="badge badge--amber">별도 +${h.extra}</span>` : "";
      const cutBadge = h.cut < 0 ? `<span class="badge badge--rose">감원 ${h.cut}</span>` : "";
      const checked = state.compareSet.has(h.hospital) ? "checked" : "";
      const disabled = !checked && state.compareSet.size >= 4 ? "disabled" : "";

      return `
        <article class="hosp-card">
          <div class="hosp-card-top">
            <div class="hosp-rank-name">
              <span class="hosp-rank">#${idx + 1}</span>
              <div>
                <button type="button" class="hosp-name-btn" data-open-hosp="${esc(h.hospital)}">${esc(h.hospital)}</button>
                <div class="hosp-badges">
                  <span class="badge">${esc(h.region)}</span>
                  <span class="badge badge--${h.scale}">${scaleLabel(h.scale)}</span>
                  ${state.type === "resident" ? `<span class="badge">${h.deptCount}개 과</span>` : ""}
                  ${extraBadge}${cutBadge}
                </div>
              </div>
            </div>
            <div class="hosp-to-col">
              <div class="hosp-to-num">${fmt(h.to)}<span class="hosp-to-unit">명</span></div>
              <div style="margin-top:4px">${deltaBadge}</div>
            </div>
          </div>

          ${topDepts.length ? `
            <div class="hosp-depts-preview">
              ${topDepts.map(([d, v]) => `<span class="dept-mini">${esc(d)} ${v}</span>`).join("")}
              ${h.deptCount > 5 ? `<span class="dept-mini">+${h.deptCount - 5}과</span>` : ""}
            </div>
          ` : ""}

          <div class="hosp-card-foot">
            <label class="compare-check">
              <input type="checkbox" data-compare-hosp="${esc(h.hospital)}" ${checked} ${disabled}>
              <span>비교 담기</span>
            </label>
            <button type="button" class="detail-link" data-open-hosp="${esc(h.hospital)}">연도별 추이·상세 →</button>
          </div>
        </article>
      `;
    }).join("");

    grid.querySelectorAll("[data-open-hosp]").forEach((btn) => {
      btn.addEventListener("click", () => openHospitalModal(btn.dataset.openHosp));
    });
    grid.querySelectorAll("[data-compare-hosp]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const h = cb.dataset.compareHosp;
        if (cb.checked) {
          if (state.compareSet.size < 4) state.compareSet.add(h);
        } else {
          state.compareSet.delete(h);
        }
        renderHospitals();
      });
    });
  }

  function updateCompareBtn() {
    const btn = document.getElementById("openCompareBtn");
    document.getElementById("compareCount").textContent = String(state.compareSet.size);
    btn.disabled = state.compareSet.size < 2;
  }

  function openHospitalModal(hospital) {
    const allRecs = DATA.records.filter((r) => r.hospital === hospital);
    if (!allRecs.length) return;
    const region = allRecs[allRecs.length - 1].region;
    const targetTerm = state.term === "ALL" ? LATEST_TERM : state.term;
    const scale = getScale(targetTerm, hospital);

    document.getElementById("hospitalDialogTitle").textContent = hospital;
    document.getElementById("hospitalDialogBadges").innerHTML = `
      <span class="badge">${esc(region)}</span>
      <span class="badge badge--${scale}">${scaleLabel(scale)} 병원</span>
      <span class="badge">${esc(TERM_BY_ID[targetTerm]?.label || targetTerm)} 기준</span>
    `;

    // Build trend chart SVG (supports switching between Selected Specialties vs Full Hospital when state.depts.size > 0)
    const hasSelDepts = state.depts.size > 0;
    const selLabel = ratioDeptLabel();
    const resVals = TERMS.map((t) => allRecs.filter((r) => r.term === t.id && r.type === "resident").reduce((s, r) => s + r.to, 0));
    const intVals = TERMS.map((t) => allRecs.filter((r) => r.term === t.id && r.type === "intern").reduce((s, r) => s + r.to, 0));
    const selVals = TERMS.map((t) => allRecs.filter((r) => r.term === t.id && r.type === "resident" && state.depts.has(r.dept)).reduce((s, r) => s + r.to, 0));

    function buildModalTrendSvg(mode) {
      const W = 740, H = 195, pad = { top: 28, right: 44, bottom: 32, left: 42 };
      const cw = W - pad.left - pad.right, ch = H - pad.top - pad.bottom;
      const xOf = (i) => pad.left + (TERMS.length === 1 ? cw / 2 : (i / (TERMS.length - 1)) * cw);

      const makeLine = (vals, color, showZero = false, subLabels = null) => {
        const pts = vals.map((v, i) => [xOf(i), yOf(v)]);
        const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>` +
          pts.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.2" fill="${color}" stroke="var(--surface)" stroke-width="1.5"/>` +
            ((showZero || vals[i] > 0) ? `<text x="${x.toFixed(1)}" y="${(y - 9).toFixed(1)}" text-anchor="middle" fill="${color}" font-size="11" font-weight="750">${vals[i]}${subLabels && subLabels[i] ? ` (${subLabels[i]})` : ""}</text>` : "")
          ).join("");
      };

      const maxV = mode === "selected"
        ? Math.max(4, ...selVals)
        : Math.max(5, ...resVals, ...intVals);
      const yOf = (v) => pad.top + ch - (v / maxV) * ch;

      let linesSvg = "";
      if (mode === "selected") {
        const pctSubs = TERMS.map((_, i) => intVals[i] > 0 ? `${((selVals[i] / intVals[i]) * 100).toFixed(1)}%` : "");
        const pts = selVals.map((v, i) => [xOf(i), yOf(v)]);
        const dArea = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") +
          ` L${pts[pts.length - 1][0].toFixed(1)},${(pad.top + ch).toFixed(1)} L${pts[0][0].toFixed(1)},${(pad.top + ch).toFixed(1)} Z`;
        linesSvg = `<path d="${dArea}" fill="#d97706" fill-opacity="0.12"/>` + makeLine(selVals, "#d97706", true, pctSubs);
      } else {
        linesSvg = makeLine(resVals, "#0d9488") + makeLine(intVals, "#4f46e5") + (hasSelDepts ? makeLine(selVals, "#d97706") : "");
      }

      return `
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
          <line x1="${pad.left}" y1="${pad.top + ch}" x2="${W - pad.right}" y2="${pad.top + ch}" stroke="var(--border)"/>
          <line x1="${pad.left}" y1="${pad.top + ch / 2}" x2="${W - pad.right}" y2="${pad.top + ch / 2}" stroke="var(--border)" stroke-dasharray="3 3"/>
          <text x="${pad.left - 6}" y="${pad.top + 4}" text-anchor="end" fill="var(--ink-3)" font-size="10.5">${fmt(maxV)}</text>
          <text x="${pad.left - 6}" y="${pad.top + ch + 4}" text-anchor="end" fill="var(--ink-3)" font-size="10.5">0</text>
          ${linesSvg}
          ${TERMS.map((t, i) => `<text x="${xOf(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" fill="var(--ink-2)" font-size="11">${esc(t.label)}</text>`).join("")}
        </svg>
      `;
    }
    const defaultChartMode = hasSelDepts ? "selected" : "all";
    const trendSvg = buildModalTrendSvg(defaultChartMode);

    // Specialty table for targetTerm (pin selected depts in state.depts to the top!)
    const prevTermId = findComparablePrevTerm(targetTerm);
    const curRes = allRecs
      .filter((r) => r.term === targetTerm && r.type === "resident")
      .sort((a, b) => {
        const aSel = state.depts.has(a.dept) ? 1 : 0;
        const bSel = state.depts.has(b.dept) ? 1 : 0;
        if (aSel !== bSel) return bSel - aSel;
        return b.to - a.to || collator.compare(a.dept, b.dept);
      });
    const curInt = allRecs.find((r) => r.term === targetTerm && r.type === "intern");
    const prevResMap = new Map(
      allRecs.filter((r) => r.term === prevTermId && r.type === "resident").map((r) => [r.dept, r.to])
    );
    const showBreak = true;

    const internTO = curInt ? curInt.to : 0;
    const deptRowsHtml = curRes.length ? `
      <table class="mini-table">
        <thead>
          <tr>
            <th>과목</th>
            <th class="num-col">최종 TO</th>
            ${internTO > 0 ? `<th class="num-col">인턴 대비</th>` : ""}
            ${showBreak ? `<th class="num-col">기본</th><th class="num-col">별도</th>` : ""}
            ${prevTermId ? `<th class="num-col">${esc(TERM_BY_ID[prevTermId].label)} 대비</th>` : ""}
            <th>비고</th>
          </tr>
        </thead>
        <tbody>
          ${curRes.map((r) => {
            const pv = prevResMap.get(r.dept);
            const diff = pv !== undefined ? r.to - pv : null;
            const diffStr = diff === null ? "—" : diff > 0 ? `<span style="color:var(--emerald);font-weight:700">+${diff}</span>` : diff < 0 ? `<span style="color:var(--rose);font-weight:700">${diff}</span>` : "0";
            const ratioPct = internTO > 0 ? `${((r.to / internTO) * 100).toFixed(1)}%` : "—";
            const isSel = state.depts.has(r.dept);
            return `
              <tr class="${isSel ? "is-pinned-dept" : ""}">
                <td><strong>${esc(r.dept)}</strong>${isSel ? `<span class="badge badge--large" style="margin-left:5px">선택</span>` : ""}</td>
                <td class="num-col"><strong>${fmt(r.to)}</strong></td>
                ${internTO > 0 ? `<td class="num-col" style="color:var(--accent-strong);font-weight:650">${ratioPct}</td>` : ""}
                ${showBreak ? `<td class="num-col">${esc(r.base ?? "—")}</td><td class="num-col">${r.extra ? `+${r.extra}` : "0"}</td>` : ""}
                ${prevTermId ? `<td class="num-col">${diffStr}</td>` : ""}
                <td>${esc(r.note || "—")}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    ` : `<p class="card-sub">해당 시기에 레지던트 배정 내역이 없습니다.</p>`;

    const internSummary = curInt
      ? `<div class="kpi-meta" style="margin-top:4px">
           <strong>${esc(TERM_BY_ID[targetTerm].label)} 인턴 TO: ${fmt(curInt.to)}명</strong>
           ${curInt.base !== undefined ? `<span>(기본 ${curInt.base}${curInt.extra ? `, 별도 +${curInt.extra}` : ""}${curInt.cut ? `, 감원 ${curInt.cut}` : ""})</span>` : ""}
           ${curInt.note ? `<span class="badge">${esc(curInt.note)}</span>` : ""}
         </div>`
      : "";

    document.getElementById("hospitalDialogBody").innerHTML = `
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <h3 class="modal-section-title" style="margin:0">2023–2027 시기별 TO 추이</h3>
            ${hasSelDepts ? `
              <div class="pill-group" id="hospModalChartMode" role="group" aria-label="차트 보기 전환">
                <button type="button" class="pill is-active" data-hcm="selected">선택 과목 (${esc(selLabel)})</button>
                <button type="button" class="pill" data-hcm="all">전체 레지던트·인턴</button>
              </div>
            ` : ""}
          </div>
          <div class="card-legend" id="hospModalLegend">
            ${defaultChartMode === "selected"
              ? `<span class="legend-item"><span class="legend-dot" style="background:#d97706"></span>${esc(selLabel)} TO (인턴 대비 %)</span>`
              : `<span class="legend-item"><span class="legend-dot" style="background:#0d9488"></span>레지던트</span><span class="legend-item"><span class="legend-dot" style="background:#4f46e5"></span>인턴</span>${hasSelDepts ? `<span class="legend-item"><span class="legend-dot" style="background:#d97706"></span>${esc(selLabel)}</span>` : ""}`
            }
          </div>
        </div>
        <div id="hospModalTrendWrap">${trendSvg}</div>
        ${internSummary}
      </div>
      <div>
        <h3 class="modal-section-title">${esc(TERM_BY_ID[targetTerm]?.label || targetTerm)} 레지던트 과목별 정원 (총 ${fmt(curRes.reduce((s, r) => s + r.to, 0))}명)</h3>
        ${deptRowsHtml}
      </div>
    `;

    const hcmWrap = document.getElementById("hospModalChartMode");
    if (hcmWrap) {
      hcmWrap.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-hcm]");
        if (!btn) return;
        const m = btn.dataset.hcm;
        hcmWrap.querySelectorAll("[data-hcm]").forEach((b) => b.classList.toggle("is-active", b === btn));
        document.getElementById("hospModalTrendWrap").innerHTML = buildModalTrendSvg(m);
        document.getElementById("hospModalLegend").innerHTML = m === "selected"
          ? `<span class="legend-item"><span class="legend-dot" style="background:#d97706"></span>${esc(selLabel)} TO (인턴 대비 %)</span>`
          : `<span class="legend-item"><span class="legend-dot" style="background:#0d9488"></span>레지던트</span><span class="legend-item"><span class="legend-dot" style="background:#4f46e5"></span>인턴</span><span class="legend-item"><span class="legend-dot" style="background:#d97706"></span>${esc(selLabel)}</span>`;
      });
    }

    hospitalDialog.showModal();
  }

  function openCompareModal() {
    const hosps = [...state.compareSet];
    if (hosps.length < 2) return;
    const targetTerm = state.term === "ALL" ? LATEST_TERM : state.term;
    document.getElementById("compareDialogSub").textContent =
      `${TERM_BY_ID[targetTerm]?.label || targetTerm} · ${state.type === "resident" ? "레지던트" : "인턴"} 정원 비교`;

    const body = document.getElementById("compareDialogBody");
    if (state.type === "intern") {
      // Compare intern TO across all terms
      const head = `<tr><th>시기</th>${hosps.map((h) => `<th class="num-col">${esc(h)}</th>`).join("")}</tr>`;
      const rowsHtml = TERMS.map((t) => {
        const cols = hosps.map((h) => {
          const v = DATA.records.filter((r) => r.term === t.id && r.type === "intern" && r.hospital === h).reduce((s, r) => s + r.to, 0);
          return `<td class="num-col">${v ? fmt(v) : "—"}</td>`;
        }).join("");
        return `<tr><td><strong>${esc(t.label)}</strong></td>${cols}</tr>`;
      }).join("");
      body.innerHTML = `<table class="mini-table"><thead>${head}</thead><tbody>${rowsHtml}</tbody></table>`;
    } else {
      // Compare resident TO across all specialties for targetTerm
      const deptsSet = new Set();
      const map = new Map();
      for (const r of DATA.records) {
        if (r.term !== targetTerm || r.type !== "resident" || !state.compareSet.has(r.hospital)) continue;
        if (r.to > 0) deptsSet.add(r.dept);
        map.set(`${r.hospital}|${r.dept}`, (map.get(`${r.hospital}|${r.dept}`) || 0) + r.to);
      }
      const depts = [...deptsSet].sort((a, b) => {
        const aSel = state.depts.has(a) ? 1 : 0;
        const bSel = state.depts.has(b) ? 1 : 0;
        if (aSel !== bSel) return bSel - aSel;
        return collator.compare(a, b);
      });
      const totals = hosps.map((h) => depts.reduce((s, d) => s + (map.get(`${h}|${d}`) || 0), 0));
      const head = `<tr><th>과목</th>${hosps.map((h) => `<th class="num-col">${esc(h)}</th>`).join("")}</tr>`;
      const totalRow = `<tr style="background:var(--accent-soft)"><td><strong>합계</strong></td>${totals.map((v) => `<td class="num-col"><strong>${fmt(v)}</strong></td>`).join("")}</tr>`;
      const rowsHtml = depts.map((d) => {
        const vals = hosps.map((h) => map.get(`${h}|${d}`) || 0);
        const maxV = Math.max(...vals);
        const isSel = state.depts.has(d);
        const cols = vals.map((v) => `<td class="num-col">${v > 0 ? (v === maxV && maxV > 0 ? `<strong style="color:var(--accent-strong)">${v}</strong>` : v) : "—"}</td>`).join("");
        return `<tr class="${isSel ? "is-pinned-dept" : ""}"><td>${esc(d)}${isSel ? `<span class="badge badge--large" style="margin-left:5px">선택</span>` : ""}</td>${cols}</tr>`;
      }).join("");
      body.innerHTML = `<table class="mini-table"><thead>${head}</thead><tbody>${totalRow}${rowsHtml}</tbody></table>`;
    }
    compareDialog.showModal();
  }

  // =========================================================================
  // TAB 2.5: Intern-to-Specialty Ratio & YoY Change Analysis
  // =========================================================================
  // Pre-index intern TO and resident TO per (term, hospital) for instant lookup
  const internToByTermHosp = new Map();
  const hospRegionMap = new Map();
  const resRecordsByTermHosp = new Map();
  for (const r of DATA.records) {
    if (r.region) hospRegionMap.set(r.hospital, r.region);
    const k = `${r.term}|${r.hospital}`;
    if (r.type === "intern") {
      internToByTermHosp.set(k, (internToByTermHosp.get(k) || 0) + r.to);
    } else {
      if (!resRecordsByTermHosp.has(k)) resRecordsByTermHosp.set(k, []);
      resRecordsByTermHosp.get(k).push(r);
    }
  }

  // Major full-recruitment terms for sparklines (exclude tiny residual half-terms < 500 interns)
  const MAJOR_TERMS = TERMS.filter((t) => {
    const sum = DATA.records.filter((r) => r.term === t.id && r.type === "intern").reduce((s, r) => s + r.to, 0);
    return sum >= 500;
  });

  function getDeptTOForRatio(termId, hospital) {
    const list = resRecordsByTermHosp.get(`${termId}|${hospital}`);
    if (!list) return 0;
    let sum = 0;
    for (const r of list) {
      if (state.depts.size === 0 || state.depts.has(r.dept)) sum += r.to;
    }
    return sum;
  }

  function ratioDeptLabel() {
    if (state.depts.size === 0) return "전체 레지던트";
    if (state.depts.size === 1) return [...state.depts][0];
    if (state.depts.size === ESSENTIAL_DEPTS.size && [...ESSENTIAL_DEPTS].every((d) => state.depts.has(d))) {
      return "필수의료 6과 합계";
    }
    if (state.depts.size === POPULAR_DEPTS.size && [...POPULAR_DEPTS].every((d) => state.depts.has(d))) {
      return "피·안·성·정·재·영 합계";
    }
    const arr = [...state.depts];
    return arr.length <= 3 ? arr.join("·") : `${arr.slice(0, 2).join("·")} 외 ${arr.length - 2}과`;
  }

  const ratioTableEl = document.getElementById("ratio-table");
  const ratioTbodyEl = document.getElementById("ratioTableBody");
  const ratioStatusEl = document.getElementById("ratioSortStatus");
  let ratioSortCol = 4; // 현재 비율
  let ratioSortDir = "descending";

  function sortExistingRatioRows(th, direction) {
    const tbody = ratioTableEl.tBodies[0];
    const index = th.cellIndex;
    const type = th.dataset.type || "text";
    const factor = direction === "ascending" ? 1 : -1;
    const pairs = [...tbody.rows].map((row) => {
      const cell = row.cells[index];
      const raw = cell.dataset.value ?? cell.textContent.trim();
      return { row, val: type === "number" ? Number(raw) : raw };
    });
    pairs.sort((a, b) =>
      factor * (type === "number" ? a.val - b.val : collator.compare(a.val, b.val))
    );
    for (const { row } of pairs) {
      if (typeof tbody.moveBefore === "function") tbody.moveBefore(row, null);
      else tbody.appendChild(row);
    }
    return pairs.length;
  }

  function handleRatioSortActivate(button) {
    const th = button.closest("th");
    if (!th) return;
    const direction = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
    for (const header of ratioTableEl.tHead.rows[0].cells) header.removeAttribute("aria-sort");
    th.setAttribute("aria-sort", direction);
    ratioSortCol = th.cellIndex;
    ratioSortDir = direction;
    const count = sortExistingRatioRows(th, direction);
    ratioStatusEl.textContent = `${button.textContent.trim()} 기준 ${direction === "ascending" ? "오름차순" : "내림차순"} 정렬, ${count}건`;
  }

  function initRatioControls() {
    const fromSel = document.getElementById("ratioFromTerm");
    const termOpts = TERMS.slice().reverse().map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("");
    fromSel.innerHTML = termOpts;
    fromSel.value = state.ratioFromTerm;
    fromSel.addEventListener("change", () => {
      state.ratioFromTerm = fromSel.value;
      renderRatioTab();
    });

    const minSel = document.getElementById("ratioMinIntern");
    minSel.addEventListener("change", () => {
      state.ratioMinIntern = Number(minSel.value);
      renderRatioTab();
    });

    document.getElementById("ratioHideZeroDept").addEventListener("change", (e) => {
      state.ratioHideZeroDept = e.target.checked;
      renderRatioTab();
    });

    document.getElementById("exportRatioCsvBtn").addEventListener("click", exportRatioCsv);

    // Sortable table wiring (modern-web-guidance: sortable-table)
    ratioTableEl.addEventListener("command", (event) => {
      if (event.command !== "--sort") return;
      handleRatioSortActivate(event.source);
    });
    if (!("commandForElement" in HTMLButtonElement.prototype)) {
      ratioTableEl.tHead.querySelectorAll('button[command="--sort"]').forEach((btn) => {
        btn.addEventListener("click", () => handleRatioSortActivate(btn));
      });
    }
  }

  function buildSparklineSvg(points) {
    // points: [{ label, ratio: number | null }]
    const valid = points.filter((p) => p.ratio !== null);
    if (valid.length < 2) {
      return `<span style="color:var(--ink-3);font-size:11px">추이 부족</span>`;
    }
    const W = 96, H = 26, padX = 5, padY = 4;
    const vals = valid.map((p) => p.ratio);
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const span = Math.max(0.5, maxV - minV);
    const xOf = (i) => padX + (points.length === 1 ? 0 : (i / (points.length - 1)) * (W - padX * 2));
    const yOf = (v) => padY + (H - padY * 2) - ((v - minV) / span) * (H - padY * 2);

    const first = valid[0].ratio;
    const last = valid[valid.length - 1].ratio;
    const stroke = last > first + 0.05 ? "var(--emerald)" : last < first - 0.05 ? "var(--rose)" : "var(--accent)";

    let d = "";
    let dots = "";
    points.forEach((p, i) => {
      if (p.ratio === null) return;
      const x = xOf(i).toFixed(1);
      const y = yOf(p.ratio).toFixed(1);
      d += (d ? " L" : "M") + `${x},${y}`;
      dots += `<circle cx="${x}" cy="${y}" r="${i === points.length - 1 ? 2.8 : 1.8}" fill="${stroke}"/>`;
    });

    const tip = points.map((p) => `${p.label}: ${p.ratio === null ? "—" : p.ratio.toFixed(1) + "%"}`).join(" / ");
    return `<svg class="sparkline-svg" viewBox="0 0 ${W} ${H}" aria-label="${esc(tip)}"><title>${esc(tip)}</title><path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>${dots}</svg>`;
  }

  function renderRatioTab() {
    const deptName = ratioDeptLabel();
    const toTerm = state.term === "ALL" ? LATEST_TERM : state.term;
    const fromTerm = state.ratioFromTerm;
    document.getElementById("ratioScopeBadge").textContent =
      `${TERM_BY_ID[toTerm]?.label || toTerm} · ${deptName}`;

    // Collect all hospitals that have intern TO in toTerm
    const hospsInTerm = [];
    for (const [k, itn] of internToByTermHosp.entries()) {
      const [term, hosp] = k.split("|");
      if (term !== toTerm) continue;
      if (itn < state.ratioMinIntern) continue;
      const reg = hospRegionMap.get(hosp) || "";
      if (state.regions.size > 0 && !state.regions.has(reg)) continue;
      if (state.size !== "all" && getScale(toTerm, hosp) !== state.size) continue;
      if (state.search) {
        const q = state.search.toLowerCase();
        if (!`${hosp} ${reg}`.toLowerCase().includes(q)) continue;
      }
      const dTo = getDeptTOForRatio(toTerm, hosp);
      if (state.ratioHideZeroDept && dTo === 0) continue;

      const curRatio = (dTo / itn) * 100;
      const prevItn = internToByTermHosp.get(`${fromTerm}|${hosp}`) || 0;
      const prevDept = prevItn > 0 ? getDeptTOForRatio(fromTerm, hosp) : 0;
      const prevRatio = prevItn > 0 ? (prevDept / prevItn) * 100 : null;
      const deltaPp = prevRatio !== null ? curRatio - prevRatio : null;
      const deltaPct = prevRatio !== null && prevRatio > 0 ? ((curRatio - prevRatio) / prevRatio) * 100 : null;

      const spark = MAJOR_TERMS.map((t) => {
        const ti = internToByTermHosp.get(`${t.id}|${hosp}`) || 0;
        if (ti <= 0) return { label: t.label, ratio: null };
        const td = getDeptTOForRatio(t.id, hosp);
        return { label: t.label, ratio: (td / ti) * 100 };
      });

      hospsInTerm.push({
        region: reg,
        hospital: hosp,
        internTo: itn,
        deptTo: dTo,
        curRatio,
        prevInternTo: prevItn,
        prevDeptTo: prevDept,
        prevRatio,
        deltaPp,
        deltaPct,
        spark,
      });
    }

    state.lastRatioRows = hospsInTerm;

    // Aggregate KPIs
    const sumIntern = hospsInTerm.reduce((s, r) => s + r.internTo, 0);
    const sumDept = hospsInTerm.reduce((s, r) => s + r.deptTo, 0);
    const avgRatio = sumIntern > 0 ? (sumDept / sumIntern) * 100 : 0;

    const sumPrevIntern = hospsInTerm.reduce((s, r) => s + (r.prevRatio !== null ? r.prevInternTo : 0), 0);
    const sumPrevDept = hospsInTerm.reduce((s, r) => s + (r.prevRatio !== null ? r.prevDeptTo : 0), 0);
    const prevAvgRatio = sumPrevIntern > 0 ? (sumPrevDept / sumPrevIntern) * 100 : null;
    const avgDeltaPp = prevAvgRatio !== null ? avgRatio - prevAvgRatio : null;
    const avgDeltaPct = prevAvgRatio !== null && prevAvgRatio > 0 ? ((avgRatio - prevAvgRatio) / prevAvgRatio) * 100 : null;

    const topRatioHosp = hospsInTerm.slice().sort((a, b) => b.curRatio - a.curRatio || b.deptTo - a.deptTo)[0];
    const topGainHosp = hospsInTerm.filter((r) => r.deltaPp !== null).sort((a, b) => b.deltaPp - a.deltaPp)[0];
    const per100 = avgRatio.toFixed(1);

    document.getElementById("ratioKpiGrid").innerHTML = `
      <div class="kpi-card">
        <span class="kpi-label">전체 평균 비율 (${esc(deptName)})</span>
        <div class="kpi-val">${avgRatio.toFixed(2)}<span style="font-size:15px;color:var(--ink-2)">%</span></div>
        <div class="kpi-meta">
          ${avgDeltaPp !== null ? `<span class="delta-pill ${avgDeltaPp >= 0 ? "delta-pill--up" : "delta-pill--down"}">${avgDeltaPp >= 0 ? "+" : ""}${avgDeltaPp.toFixed(2)}%p (${avgDeltaPct !== null ? `${avgDeltaPct >= 0 ? "+" : ""}${avgDeltaPct.toFixed(1)}%` : "—"})</span>` : ""}
          <span>인턴 100명당 ${per100}명</span>
        </div>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">최고 비율 병원</span>
        <div class="kpi-val" style="font-size:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${topRatioHosp ? esc(topRatioHosp.hospital) : "—"}</div>
        <div class="kpi-meta">${topRatioHosp ? `<strong>${topRatioHosp.curRatio.toFixed(1)}%</strong> (${topRatioHosp.deptTo} / 인턴 ${topRatioHosp.internTo}명)` : "조건에 맞는 병원 없음"}</div>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">${esc(TERM_BY_ID[fromTerm]?.label || fromTerm)} 대비 최대 상승</span>
        <div class="kpi-val" style="font-size:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${topGainHosp ? esc(topGainHosp.hospital) : "—"}</div>
        <div class="kpi-meta">${topGainHosp ? `<span class="delta-pill delta-pill--up">+${topGainHosp.deltaPp.toFixed(1)}%p</span> (${topGainHosp.prevRatio.toFixed(1)}% → ${topGainHosp.curRatio.toFixed(1)}%)` : "비교 가능 병원 없음"}</div>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">분석 대상 병원 · 총 TO</span>
        <div class="kpi-val">${fmt(hospsInTerm.length)}<span style="font-size:14px;color:var(--ink-2);margin-left:3px">곳</span></div>
        <div class="kpi-meta"><span>${esc(deptName)} ${fmt(sumDept)}명</span> · <span>인턴 ${fmt(sumIntern)}명</span></div>
      </div>
    `;

    // Chart A: Top 20 Ratio Horizontal Bar + Comparison Term Marker
    document.getElementById("ratioBarTitle").textContent = `병원별 인턴 대비 ${deptName} 비율 TOP 20`;
    const barEl = document.getElementById("chartRatioBar");
    const top20 = hospsInTerm.slice().sort((a, b) => b.curRatio - a.curRatio || b.deptTo - a.deptTo).slice(0, 20);
    if (!top20.length) {
      barEl.innerHTML = `<div class="empty-state">조건에 맞는 병원이 없습니다. 최소 인턴 TO 조건을 낮춰 보세요.</div>`;
    } else {
      const maxR = Math.max(5, ...top20.map((r) => Math.max(r.curRatio, r.prevRatio || 0)));
      const rowH = 26, W = 540, H = top20.length * rowH + 16;
      const labelW = 134, valW = 94, barMax = W - labelW - valW - 14;
      const rowsSvg = top20.map((r, i) => {
        const y = 8 + i * rowH;
        const bw = Math.max(2, (r.curRatio / maxR) * barMax);
        const shortH = r.hospital.length > 10 ? r.hospital.slice(0, 9) + "…" : r.hospital;
        const prevX = r.prevRatio !== null ? labelW + (r.prevRatio / maxR) * barMax : null;
        const barColor = r.deltaPp !== null && r.deltaPp > 0.2 ? "var(--emerald)" : r.deltaPp !== null && r.deltaPp < -0.2 ? "var(--rose)" : "var(--accent)";
        return `
          <g class="svg-bar-row" data-hosp="${esc(r.hospital)}" data-cur="${r.curRatio.toFixed(2)}" data-prev="${r.prevRatio !== null ? r.prevRatio.toFixed(2) : ""}" data-itn="${r.internTo}" data-dept="${r.deptTo}" data-pp="${r.deltaPp !== null ? r.deltaPp.toFixed(2) : ""}">
            <rect class="svg-bar-bg" x="0" y="${y}" width="${W}" height="${rowH - 2}" rx="5" fill="transparent"/>
            <text x="${labelW - 8}" y="${y + 16}" text-anchor="end" fill="var(--ink)" font-size="11.5" font-weight="600">${esc(shortH)}</text>
            <rect class="svg-bar-fill" x="${labelW}" y="${y + 5}" width="${bw.toFixed(1)}" height="${rowH - 12}" rx="3.5" fill="${barColor}" fill-opacity="0.88"/>
            ${prevX !== null ? `<circle cx="${prevX.toFixed(1)}" cy="${(y + rowH / 2 - 1).toFixed(1)}" r="3.6" fill="var(--surface)" stroke="var(--ink)" stroke-width="1.8"/>` : ""}
            <text x="${W - 6}" y="${y + 16}" text-anchor="end" fill="var(--ink-2)" font-size="11" font-weight="700">${r.curRatio.toFixed(1)}% (${r.deptTo}/${r.internTo})</text>
          </g>
        `;
      }).join("");
      barEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="병원별 인턴 대비 과목 비율 차트">${rowsSvg}</svg>`;
      barEl.querySelectorAll(".svg-bar-row").forEach((g) => {
        g.addEventListener("mouseenter", (e) => {
          const prevTxt = g.dataset.prev ? `<br>${esc(TERM_BY_ID[fromTerm].label)}: ${g.dataset.prev}% (${Number(g.dataset.pp) >= 0 ? "+" : ""}${g.dataset.pp}%p)` : "";
          showTooltip(e, `<strong>${esc(g.dataset.hosp)}</strong>${esc(TERM_BY_ID[toTerm].label)}: ${g.dataset.cur}% (${g.dataset.dept}명 / 인턴 ${g.dataset.itn}명)${prevTxt}`);
        });
        g.addEventListener("mousemove", positionTooltip);
        g.addEventListener("mouseleave", hideTooltip);
        g.addEventListener("click", () => openHospitalModal(g.dataset.hosp));
      });
    }

    // Chart B: Scatter Plot (Intern TO vs Dept TO with Iso-Ratio Lines)
    document.getElementById("ratioScatterTitle").textContent = `인턴 TO × ${deptName} TO 분포 (등비율선)`;
    const scEl = document.getElementById("chartRatioScatter");
    if (!hospsInTerm.length) {
      scEl.innerHTML = `<div class="empty-state">표시할 데이터가 없습니다.</div>`;
    } else {
      const W = 520, H = 360, pad = { top: 24, right: 26, bottom: 42, left: 48 };
      const cw = W - pad.left - pad.right, ch = H - pad.top - pad.bottom;
      const maxX = Math.max(20, ...hospsInTerm.map((r) => r.internTo)) * 1.08;
      const maxY = Math.max(4, ...hospsInTerm.map((r) => r.deptTo)) * 1.15;
      const xOf = (x) => pad.left + (x / maxX) * cw;
      const yOf = (y) => pad.top + ch - (y / maxY) * ch;

      // Choose sensible iso-ratio reference percentages based on average ratio
      const refPcts = avgRatio > 40 ? [50, 80, 100, 120] : avgRatio > 12 ? [10, 15, 20, 30] : [3, 5, 10, 15];
      let isoSvg = "";
      for (const p of refPcts) {
        const slope = p / 100;
        const xEnd = Math.min(maxX, maxY / slope);
        const yEnd = xEnd * slope;
        isoSvg += `
          <line x1="${xOf(0)}" y1="${yOf(0)}" x2="${xOf(xEnd).toFixed(1)}" y2="${yOf(yEnd).toFixed(1)}" stroke="var(--border-strong)" stroke-dasharray="4 4"/>
          <text x="${(xOf(xEnd) - 4).toFixed(1)}" y="${(yOf(yEnd) - 5).toFixed(1)}" text-anchor="end" fill="var(--ink-3)" font-size="10.5" font-weight="600">${p}%</text>
        `;
      }

      // Axes & ticks
      let axesSvg = `
        <line x1="${pad.left}" y1="${pad.top + ch}" x2="${W - pad.right}" y2="${pad.top + ch}" stroke="var(--border-strong)"/>
        <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + ch}" stroke="var(--border-strong)"/>
        <text x="${pad.left + cw / 2}" y="${H - 8}" text-anchor="middle" fill="var(--ink-2)" font-size="11.5" font-weight="650">인턴 TO (명)</text>
        <text x="14" y="${pad.top + ch / 2}" text-anchor="middle" fill="var(--ink-2)" font-size="11.5" font-weight="650" transform="rotate(-90 14 ${pad.top + ch / 2})">${esc(deptName)} TO (명)</text>
      `;
      for (let i = 0; i <= 4; i++) {
        const xv = Math.round((maxX * i) / 4);
        const yv = Math.round((maxY * i) / 4);
        axesSvg += `<text x="${xOf(xv).toFixed(1)}" y="${H - 24}" text-anchor="middle" fill="var(--ink-3)" font-size="10.5">${xv}</text>`;
        axesSvg += `<text x="${pad.left - 8}" y="${(yOf(yv) + 4).toFixed(1)}" text-anchor="end" fill="var(--ink-3)" font-size="10.5">${yv}</text>`;
      }

      // Dots (highlight top 6 hospitals with text labels)
      const labelSet = new Set(hospsInTerm.slice().sort((a, b) => b.deptTo * 2 + b.curRatio - (a.deptTo * 2 + a.curRatio)).slice(0, 6).map((r) => r.hospital));
      const dotsSvg = hospsInTerm.map((r) => {
        const cx = xOf(r.internTo).toFixed(1);
        const cy = yOf(r.deptTo).toFixed(1);
        const fill = METRO_REGIONS.has(r.region) ? "var(--accent)" : "var(--indigo)";
        const lbl = labelSet.has(r.hospital)
          ? `<text x="${(Number(cx) + 6).toFixed(1)}" y="${(Number(cy) + 3).toFixed(1)}" fill="var(--ink)" font-size="10" font-weight="650" pointer-events="none">${esc(r.hospital.replace("병원", ""))}</text>`
          : "";
        return `
          <circle cx="${cx}" cy="${cy}" r="5" fill="${fill}" fill-opacity="0.82" stroke="var(--surface)" stroke-width="1.3"
            class="scatter-dot" style="cursor:pointer" data-hosp="${esc(r.hospital)}" data-reg="${esc(r.region)}"
            data-itn="${r.internTo}" data-dept="${r.deptTo}" data-cur="${r.curRatio.toFixed(2)}" data-pp="${r.deltaPp !== null ? r.deltaPp.toFixed(2) : ""}"/>
          ${lbl}
        `;
      }).join("");

      scEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="인턴 TO 대 과목 TO 산점도">${isoSvg}${axesSvg}${dotsSvg}</svg>`;
      scEl.querySelectorAll(".scatter-dot").forEach((dot) => {
        dot.addEventListener("mouseenter", (e) => {
          const pp = dot.dataset.pp ? `<br>변화폭: ${Number(dot.dataset.pp) >= 0 ? "+" : ""}${dot.dataset.pp}%p` : "";
          showTooltip(e, `<strong>${esc(dot.dataset.hosp)} (${esc(dot.dataset.reg)})</strong>인턴 ${dot.dataset.itn}명 · ${esc(deptName)} ${dot.dataset.dept}명<br>비율: <strong>${dot.dataset.cur}%</strong>${pp}`);
        });
        dot.addEventListener("mousemove", positionTooltip);
        dot.addEventListener("mouseleave", hideTooltip);
        dot.addEventListener("click", () => openHospitalModal(dot.dataset.hosp));
      });
    }

    // Sortable Ratio Table
    document.getElementById("ratioTableTitle").textContent = `병원별 인턴 대비 ${deptName} 비율 & 연도별 변화`;
    document.getElementById("ratioTableSub").textContent =
      `총 ${fmt(hospsInTerm.length)}개 기관 · 현재 ${TERM_BY_ID[toTerm]?.label || toTerm} vs 기준 ${TERM_BY_ID[fromTerm]?.label || fromTerm}`;

    // Apply current sort column to initial render
    const sorted = hospsInTerm.slice().sort((a, b) => {
      const f = ratioSortDir === "ascending" ? 1 : -1;
      switch (ratioSortCol) {
        case 0: return f * collator.compare(a.region, b.region);
        case 1: return f * collator.compare(a.hospital, b.hospital);
        case 2: return f * (a.internTo - b.internTo);
        case 3: return f * (a.deptTo - b.deptTo);
        case 5: return f * ((a.prevRatio ?? -1) - (b.prevRatio ?? -1));
        case 6: return f * ((a.deltaPp ?? -9999) - (b.deltaPp ?? -9999));
        case 7: return f * ((a.deltaPct ?? -9999) - (b.deltaPct ?? -9999));
        default: return f * (a.curRatio - b.curRatio) || b.deptTo - a.deptTo;
      }
    });

    ratioTbodyEl.innerHTML = sorted.map((r) => {
      const oneInN = r.deptTo > 0 ? `1 : ${(r.internTo / r.deptTo).toFixed(1)}` : "—";
      const ppColor = r.deltaPp === null ? "var(--ink-3)" : r.deltaPp > 0.05 ? "var(--emerald)" : r.deltaPp < -0.05 ? "var(--rose)" : "var(--ink-2)";
      const pctColor = r.deltaPct === null ? "var(--ink-3)" : r.deltaPct > 0.5 ? "var(--emerald)" : r.deltaPct < -0.5 ? "var(--rose)" : "var(--ink-2)";
      return `
        <tr>
          <td>${esc(r.region)}</td>
          <td><button type="button" class="table-hosp-btn" data-open-hosp="${esc(r.hospital)}">${esc(r.hospital)}</button></td>
          <td class="num-col" data-value="${r.internTo}">${fmt(r.internTo)}</td>
          <td class="num-col" data-value="${r.deptTo}"><strong>${fmt(r.deptTo)}</strong></td>
          <td class="num-col" data-value="${r.curRatio.toFixed(4)}">
            <strong style="color:var(--accent-strong)">${r.curRatio.toFixed(1)}%</strong>
            <span class="ratio-sub-val">${oneInN}</span>
          </td>
          <td class="num-col" data-value="${r.prevRatio !== null ? r.prevRatio.toFixed(4) : -1}">
            ${r.prevRatio !== null ? `${r.prevRatio.toFixed(1)}%<span class="ratio-sub-val">${r.prevDeptTo}/${r.prevInternTo}</span>` : "—"}
          </td>
          <td class="num-col" data-value="${r.deltaPp !== null ? r.deltaPp.toFixed(4) : -9999}" style="color:${ppColor};font-weight:700">
            ${r.deltaPp !== null ? `${r.deltaPp >= 0 ? "+" : ""}${r.deltaPp.toFixed(1)}%p` : "—"}
          </td>
          <td class="num-col" data-value="${r.deltaPct !== null ? r.deltaPct.toFixed(4) : -9999}" style="color:${pctColor};font-weight:700">
            ${r.deltaPct !== null ? `${r.deltaPct >= 0 ? "+" : ""}${r.deltaPct.toFixed(1)}%` : "—"}
          </td>
          <td><div class="sparkline-wrap">${buildSparklineSvg(r.spark)}</div></td>
        </tr>
      `;
    }).join("");

    ratioTbodyEl.querySelectorAll("[data-open-hosp]").forEach((btn) => {
      btn.addEventListener("click", () => openHospitalModal(btn.dataset.openHosp));
    });
  }

  function exportRatioCsv() {
    const rows = state.lastRatioRows;
    const deptName = ratioDeptLabel();
    const toTerm = state.term === "ALL" ? LATEST_TERM : state.term;
    const toLbl = TERM_BY_ID[toTerm]?.label || toTerm;
    const fromLbl = TERM_BY_ID[state.ratioFromTerm]?.label || state.ratioFromTerm;
    const hdr = ["지역", "병원명", "대상과목", `${toLbl} 인턴TO`, `${toLbl} 과목TO`, `${toLbl} 비율(%)`, `${fromLbl} 비율(%)`, "변화폭(%p)", "변화율(%)"];
    const csvEsc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [hdr.map(csvEsc).join(",")];
    for (const r of rows) {
      lines.push([
        r.region, r.hospital, deptName, r.internTo, r.deptTo,
        r.curRatio.toFixed(2),
        r.prevRatio !== null ? r.prevRatio.toFixed(2) : "",
        r.deltaPp !== null ? r.deltaPp.toFixed(2) : "",
        r.deltaPct !== null ? r.deltaPct.toFixed(1) : "",
      ].map(csvEsc).join(","));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `인턴대비_${deptName}_비율_${toTerm}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  // TAB: Medical Schools vs University Admission Quota (40개 의대)
  // =========================================================================
  const SCHOOLS = DATA.schools || [];
  const schoolTableEl = document.getElementById("school-table");
  const schoolTbodyEl = document.getElementById("schoolTableBody");
  const schoolStatusEl = document.getElementById("schoolSortStatus");
  let schoolSortCol = 5; // 정원 대비 비율
  let schoolSortDir = "descending";

  function sortExistingSchoolRows(th, direction) {
    const tbody = schoolTableEl.tBodies[0];
    const index = th.cellIndex;
    const type = th.dataset.type || "text";
    const factor = direction === "ascending" ? 1 : -1;
    const pairs = [...tbody.rows].map((row) => {
      const cell = row.cells[index];
      const raw = cell.dataset.value ?? cell.textContent.trim();
      return { row, val: type === "number" ? Number(raw) : raw };
    });
    pairs.sort((a, b) =>
      factor * (type === "number" ? a.val - b.val : collator.compare(a.val, b.val))
    );
    for (const { row } of pairs) {
      if (typeof tbody.moveBefore === "function") tbody.moveBefore(row, null);
      else tbody.appendChild(row);
    }
    return pairs.length;
  }

  function handleSchoolSortActivate(button) {
    const th = button.closest("th");
    if (!th) return;
    const direction = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
    for (const header of schoolTableEl.tHead.rows[0].cells) header.removeAttribute("aria-sort");
    th.setAttribute("aria-sort", direction);
    schoolSortCol = th.cellIndex;
    schoolSortDir = direction;
    const count = sortExistingSchoolRows(th, direction);
    schoolStatusEl.textContent = `${button.textContent.trim()} 기준 ${direction === "ascending" ? "오름차순" : "내림차순"} 정렬, ${count}건`;
  }

  function initSchoolControls() {
    document.getElementById("schoolKindPills").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-school-kind]");
      if (!btn) return;
      state.schoolKind = btn.dataset.schoolKind;
      document.querySelectorAll("#schoolKindPills [data-school-kind]").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.schoolKind === state.schoolKind);
      });
      renderSchoolsTab();
    });

    const fromSel = document.getElementById("schoolFromTerm");
    fromSel.innerHTML = TERMS.slice().reverse().map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("");
    fromSel.value = state.schoolFromTerm;
    fromSel.addEventListener("change", () => {
      state.schoolFromTerm = fromSel.value;
      renderSchoolsTab();
    });

    document.getElementById("exportSchoolCsvBtn").addEventListener("click", exportSchoolCsv);

    schoolTableEl.addEventListener("command", (event) => {
      if (event.command !== "--sort") return;
      handleSchoolSortActivate(event.source);
    });
    if (!("commandForElement" in HTMLButtonElement.prototype)) {
      schoolTableEl.tHead.querySelectorAll('button[command="--sort"]').forEach((btn) => {
        btn.addEventListener("click", () => handleSchoolSortActivate(btn));
      });
    }
  }

  function computeSchoolMetrics(school, termId) {
    let internTo = 0;
    let deptTo = 0;
    const activeHosps = [];
    for (const h of school.hospitals) {
      const it = internToByTermHosp.get(`${termId}|${h}`) || 0;
      const dt = getDeptTOForRatio(termId, h);
      internTo += it;
      deptTo += dt;
      if (it > 0 || dt > 0) activeHosps.push(h);
    }
    return { internTo, deptTo, activeHosps };
  }

  function renderSchoolsTab() {
    const deptName = ratioDeptLabel();
    const toTerm = state.term === "ALL" ? LATEST_TERM : state.term;
    const fromTerm = state.schoolFromTerm;
    const isAllDepts = state.depts.size === 0;

    document.getElementById("schoolScopeBadge").textContent =
      `${TERM_BY_ID[toTerm]?.label || toTerm} · ${deptName}`;

    const rows = [];
    for (const sc of SCHOOLS) {
      if (state.schoolKind !== "all" && sc.kind !== state.schoolKind) continue;
      if (state.regions.size > 0 && !state.regions.has(sc.region)) continue;
      if (state.search) {
        const q = state.search.toLowerCase();
        const hay = `${sc.name} ${sc.region} ${sc.kind} ${sc.hospitals.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }

      const cur = computeSchoolMetrics(sc, toTerm);
      const prev = computeSchoolMetrics(sc, fromTerm);
      const ratioPct = (cur.deptTo / sc.quota) * 100;
      const internRatioPct = (cur.internTo / sc.quota) * 100;
      const prevRatioPct = (prev.deptTo / sc.quota) * 100;
      const deltaPp = ratioPct - prevRatioPct;

      const spark = MAJOR_TERMS.map((t) => {
        const m = computeSchoolMetrics(sc, t.id);
        return { label: t.label, ratio: (m.deptTo / sc.quota) * 100 };
      });

      rows.push({
        school: sc,
        internTo: cur.internTo,
        deptTo: cur.deptTo,
        activeHosps: cur.activeHosps,
        ratioPct,
        internRatioPct,
        prevRatioPct,
        deltaPp,
        spark,
      });
    }

    state.lastSchoolRows = rows;

    // KPIs
    const totalQuota = rows.reduce((s, r) => s + r.school.quota, 0);
    const totalDept = rows.reduce((s, r) => s + r.deptTo, 0);
    const totalIntern = rows.reduce((s, r) => s + r.internTo, 0);
    const avgPct = totalQuota > 0 ? (totalDept / totalQuota) * 100 : 0;

    const topSchool = rows.slice().sort((a, b) => b.ratioPct - a.ratioPct)[0];
    const pubRows = rows.filter((r) => r.school.kind === "국립");
    const privRows = rows.filter((r) => r.school.kind === "사립");
    const pubQ = pubRows.reduce((s, r) => s + r.school.quota, 0);
    const privQ = privRows.reduce((s, r) => s + r.school.quota, 0);
    const pubPct = pubQ > 0 ? (pubRows.reduce((s, r) => s + r.deptTo, 0) / pubQ) * 100 : 0;
    const privPct = privQ > 0 ? (privRows.reduce((s, r) => s + r.deptTo, 0) / privQ) * 100 : 0;
    const over100 = rows.filter((r) => r.ratioPct >= 100).length;

    document.getElementById("schoolKpiGrid").innerHTML = `
      <div class="kpi-card">
        <span class="kpi-label">의대 총 정원 vs 부속병원 ${esc(deptName)}</span>
        <div class="kpi-val">${avgPct.toFixed(1)}<span style="font-size:15px;color:var(--ink-2)">%</span></div>
        <div class="kpi-meta"><span>정원 ${fmt(totalQuota)}명</span> · <span>${esc(deptName)} ${fmt(totalDept)}명</span> · <span>인턴 ${fmt(totalIntern)}명</span></div>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">정원 대비 최고 비율 의대</span>
        <div class="kpi-val" style="font-size:20px">${topSchool ? esc(topSchool.school.name) : "—"}</div>
        <div class="kpi-meta">${topSchool ? `<strong>${topSchool.ratioPct.toFixed(1)}%</strong> (${fmt(topSchool.deptTo)}명 / 정원 ${topSchool.school.quota}명)` : "해당 의대 없음"}</div>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">국립 vs 사립 (정원 대비 %)</span>
        <div class="kpi-val" style="font-size:21px">${pubPct.toFixed(1)}% <span style="color:var(--ink-3);font-weight:500">/</span> ${privPct.toFixed(1)}%</div>
        <div class="kpi-meta"><span>국립 ${pubRows.length}개교</span> · <span>사립 ${privRows.length}개교</span></div>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">${isAllDepts ? "자교 TO ≥ 의대 정원 (100%↑)" : `${esc(deptName)} 개설 의대`}</span>
        <div class="kpi-val">${isAllDepts ? over100 : rows.filter((r) => r.deptTo > 0).length}<span style="font-size:14px;color:var(--ink-2)"> / ${rows.length}개교</span></div>
        <div class="kpi-meta">${isAllDepts ? "졸업 정원 이상 자교 레지던트 TO 보유" : "부속·협력병원 중 1명 이상 배정"}</div>
      </div>
    `;

    // Chart A: Ranked Horizontal Bar Chart
    document.getElementById("schoolBarTitle").textContent = `의대 정원 대비 ${deptName} 비율 (%) 순위`;
    const barEl = document.getElementById("chartSchoolBar");
    const ranked = rows.slice().sort((a, b) => b.ratioPct - a.ratioPct || b.deptTo - a.deptTo);
    if (!ranked.length) {
      barEl.innerHTML = `<div class="empty-state">조건에 맞는 의과대학이 없습니다.</div>`;
    } else {
      const maxR = Math.max(isAllDepts ? 120 : 10, ...ranked.map((r) => r.ratioPct));
      const rowH = 22, W = 540, H = ranked.length * rowH + 22;
      const labelW = 114, valW = 96, barMax = W - labelW - valW - 14;
      const ref100X = isAllDepts ? labelW + (100 / maxR) * barMax : null;
      const refLine = ref100X && ref100X < labelW + barMax
        ? `<line x1="${ref100X.toFixed(1)}" y1="6" x2="${ref100X.toFixed(1)}" y2="${H - 14}" stroke="var(--amber)" stroke-dasharray="4 3" stroke-width="1.4"/>
           <text x="${ref100X.toFixed(1)}" y="${H - 3}" text-anchor="middle" fill="var(--amber)" font-size="10" font-weight="700">100%</text>`
        : "";
      const barsSvg = ranked.map((r, i) => {
        const y = 8 + i * rowH;
        const bw = Math.max(1.5, (r.ratioPct / maxR) * barMax);
        const fill = r.school.kind === "국립" ? "var(--indigo)" : "var(--accent)";
        return `
          <g class="svg-bar-row" data-school-id="${r.school.id}" data-name="${esc(r.school.name)}" data-q="${r.school.quota}" data-dept="${r.deptTo}" data-itn="${r.internTo}" data-pct="${r.ratioPct.toFixed(1)}">
            <rect class="svg-bar-bg" x="0" y="${y}" width="${W}" height="${rowH - 1}" rx="4" fill="transparent"/>
            <text x="${labelW - 7}" y="${y + 14}" text-anchor="end" fill="var(--ink)" font-size="11" font-weight="600">${esc(r.school.name)}</text>
            <rect class="svg-bar-fill" x="${labelW}" y="${y + 4}" width="${bw.toFixed(1)}" height="${rowH - 9}" rx="3" fill="${fill}" fill-opacity="0.88"/>
            <text x="${W - 6}" y="${y + 14}" text-anchor="end" fill="var(--ink-2)" font-size="10.5" font-weight="700">${r.ratioPct.toFixed(1)}% (${r.deptTo}/${r.school.quota})</text>
          </g>
        `;
      }).join("");
      barEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="의대 정원 대비 TO 비율 막대 차트">${barsSvg}${refLine}</svg>`;
      barEl.querySelectorAll(".svg-bar-row").forEach((g) => {
        g.addEventListener("mouseenter", (e) => {
          showTooltip(e, `<strong>${esc(g.dataset.name)}</strong>의대 정원: ${g.dataset.q}명<br>${esc(deptName)} TO: ${g.dataset.dept}명 (<strong>${g.dataset.pct}%</strong>)<br>부속 인턴 TO: ${g.dataset.itn}명`);
        });
        g.addEventListener("mousemove", positionTooltip);
        g.addEventListener("mouseleave", hideTooltip);
        g.addEventListener("click", () => openSchoolModal(g.dataset.schoolId));
      });
    }

    // Chart B: Scatter Plot (School Quota vs Affiliated Hospital TO)
    document.getElementById("schoolScatterTitle").textContent = `의대 입학정원 × 부속병원 ${deptName} TO`;
    const scEl = document.getElementById("chartSchoolScatter");
    if (!rows.length) {
      scEl.innerHTML = `<div class="empty-state">표시할 데이터가 없습니다.</div>`;
    } else {
      const W = 520, H = 380, pad = { top: 26, right: 26, bottom: 42, left: 48 };
      const cw = W - pad.left - pad.right, ch = H - pad.top - pad.bottom;
      const maxX = 160;
      const maxY = Math.max(8, ...rows.map((r) => r.deptTo)) * 1.14;
      const xOf = (x) => pad.left + (x / maxX) * cw;
      const yOf = (y) => pad.top + ch - (y / maxY) * ch;

      const refPcts = isAllDepts ? [50, 100, 200, 300] : avgPct > 15 ? [10, 20, 40, 60] : [2, 5, 10, 20];
      let isoSvg = "";
      for (const p of refPcts) {
        const slope = p / 100;
        const xEnd = Math.min(maxX, maxY / slope);
        const yEnd = xEnd * slope;
        isoSvg += `
          <line x1="${xOf(0)}" y1="${yOf(0)}" x2="${xOf(xEnd).toFixed(1)}" y2="${yOf(yEnd).toFixed(1)}" stroke="${p === 100 ? "var(--amber)" : "var(--border-strong)"}" stroke-dasharray="4 4"/>
          <text x="${(xOf(xEnd) - 4).toFixed(1)}" y="${(yOf(yEnd) - 5).toFixed(1)}" text-anchor="end" fill="${p === 100 ? "var(--amber)" : "var(--ink-3)"}" font-size="10.5" font-weight="700">${p}%</text>
        `;
      }

      let axesSvg = `
        <line x1="${pad.left}" y1="${pad.top + ch}" x2="${W - pad.right}" y2="${pad.top + ch}" stroke="var(--border-strong)"/>
        <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + ch}" stroke="var(--border-strong)"/>
        <text x="${pad.left + cw / 2}" y="${H - 8}" text-anchor="middle" fill="var(--ink-2)" font-size="11.5" font-weight="650">의대 입학정원 (명)</text>
        <text x="14" y="${pad.top + ch / 2}" text-anchor="middle" fill="var(--ink-2)" font-size="11.5" font-weight="650" transform="rotate(-90 14 ${pad.top + ch / 2})">부속병원 ${esc(deptName)} TO (명)</text>
      `;
      for (const xv of [40, 80, 120, 160]) {
        axesSvg += `<text x="${xOf(xv).toFixed(1)}" y="${H - 24}" text-anchor="middle" fill="var(--ink-3)" font-size="10.5">${xv}</text>`;
      }
      for (let i = 0; i <= 4; i++) {
        const yv = Math.round((maxY * i) / 4);
        axesSvg += `<text x="${pad.left - 8}" y="${(yOf(yv) + 4).toFixed(1)}" text-anchor="end" fill="var(--ink-3)" font-size="10.5">${yv}</text>`;
      }

      const labelIds = new Set(rows.slice().sort((a, b) => b.deptTo - a.deptTo).slice(0, 8).map((r) => r.school.id));
      const dotsSvg = rows.map((r) => {
        const cx = xOf(r.school.quota).toFixed(1);
        const cy = yOf(r.deptTo).toFixed(1);
        const fill = r.school.kind === "국립" ? "var(--indigo)" : "var(--accent)";
        const shortName = r.school.name.replace(" 의대", "");
        const lbl = labelIds.has(r.school.id)
          ? `<text x="${(Number(cx) + 7).toFixed(1)}" y="${(Number(cy) + 3).toFixed(1)}" fill="var(--ink)" font-size="10" font-weight="650" pointer-events="none">${esc(shortName)}</text>`
          : "";
        return `
          <circle cx="${cx}" cy="${cy}" r="5.5" fill="${fill}" fill-opacity="0.85" stroke="var(--surface)" stroke-width="1.4"
            class="school-dot" style="cursor:pointer" data-school-id="${r.school.id}" data-name="${esc(r.school.name)}"
            data-q="${r.school.quota}" data-dept="${r.deptTo}" data-pct="${r.ratioPct.toFixed(1)}"/>
          ${lbl}
        `;
      }).join("");

      scEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="의대 정원 대 부속병원 TO 산점도">${isoSvg}${axesSvg}${dotsSvg}</svg>`;
      scEl.querySelectorAll(".school-dot").forEach((dot) => {
        dot.addEventListener("mouseenter", (e) => {
          showTooltip(e, `<strong>${esc(dot.dataset.name)}</strong>의대 정원 ${dot.dataset.q}명 · ${esc(deptName)} ${dot.dataset.dept}명<br>정원 대비 비율: <strong>${dot.dataset.pct}%</strong>`);
        });
        dot.addEventListener("mousemove", positionTooltip);
        dot.addEventListener("mouseleave", hideTooltip);
        dot.addEventListener("click", () => openSchoolModal(dot.dataset.schoolId));
      });
    }

    // Sortable School Table
    document.getElementById("schoolTableTitle").textContent = `의과대학 정원 vs 부속·협력병원 ${deptName} TO (${rows.length}개교)`;
    const sorted = rows.slice().sort((a, b) => {
      const f = schoolSortDir === "ascending" ? 1 : -1;
      switch (schoolSortCol) {
        case 0: return f * collator.compare(a.school.name, b.school.name);
        case 1: return f * collator.compare(a.school.kind, b.school.kind);
        case 2: return f * (a.school.quota - b.school.quota);
        case 3: return f * (a.internTo - b.internTo);
        case 4: return f * (a.deptTo - b.deptTo);
        case 6: return f * (a.deltaPp - b.deltaPp);
        default: return f * (a.ratioPct - b.ratioPct) || b.deptTo - a.deptTo;
      }
    });

    schoolTbodyEl.innerHTML = sorted.map((r) => {
      const ppColor = r.deltaPp > 0.1 ? "var(--emerald)" : r.deltaPp < -0.1 ? "var(--rose)" : "var(--ink-2)";
      const hospPreview = r.activeHosps.length ? r.activeHosps.join(", ") : r.school.hospitals.slice(0, 2).join(", ");
      return `
        <tr>
          <td>
            <button type="button" class="table-hosp-btn" data-open-school="${r.school.id}">${esc(r.school.name)}</button>
            <span class="ratio-sub-val">${esc(r.school.region)}</span>
          </td>
          <td><span class="badge ${r.school.kind === "국립" ? "badge--medium" : "badge--large"}">${esc(r.school.kind)}</span></td>
          <td class="num-col" data-value="${r.school.quota}">${fmt(r.school.quota)}명</td>
          <td class="num-col" data-value="${r.internTo}">
            ${fmt(r.internTo)}
            <span class="ratio-sub-val">${r.internRatioPct.toFixed(0)}%</span>
          </td>
          <td class="num-col" data-value="${r.deptTo}"><strong>${fmt(r.deptTo)}</strong></td>
          <td class="num-col" data-value="${r.ratioPct.toFixed(4)}">
            <strong style="color:var(--accent-strong)">${r.ratioPct.toFixed(1)}%</strong>
          </td>
          <td class="num-col" data-value="${r.deltaPp.toFixed(4)}" style="color:${ppColor};font-weight:700">
            ${r.deltaPp >= 0 ? "+" : ""}${r.deltaPp.toFixed(1)}%p
          </td>
          <td class="school-hosps-cell" title="${esc(hospPreview)}">${esc(hospPreview)}</td>
          <td><div class="sparkline-wrap">${buildSparklineSvg(r.spark)}</div></td>
        </tr>
      `;
    }).join("");

    schoolTbodyEl.querySelectorAll("[data-open-school]").forEach((btn) => {
      btn.addEventListener("click", () => openSchoolModal(btn.dataset.openSchool));
    });
  }

  function openSchoolModal(schoolId) {
    const sc = SCHOOLS.find((s) => s.id === schoolId);
    if (!sc) return;
    const targetTerm = state.term === "ALL" ? LATEST_TERM : state.term;
    const hospSet = new Set(sc.hospitals);
    const schoolRecs = DATA.records.filter((r) => hospSet.has(r.hospital));

    document.getElementById("schoolDialogTitle").textContent = `${sc.name} (입학정원 ${sc.quota}명)`;
    document.getElementById("schoolDialogBadges").innerHTML = `
      <span class="badge">${esc(sc.region)}</span>
      <span class="badge ${sc.kind === "국립" ? "badge--medium" : "badge--large"}">${esc(sc.kind)}</span>
      <span class="badge">${esc(TERM_BY_ID[targetTerm]?.label || targetTerm)} 기준</span>
    `;

    // Trend chart (supports switching between Selected Specialties vs Full School when state.depts.size > 0)
    const hasSelDepts = state.depts.size > 0;
    const selLabel = ratioDeptLabel();
    const resVals = TERMS.map((t) => schoolRecs.filter((r) => r.term === t.id && r.type === "resident").reduce((s, r) => s + r.to, 0));
    const intVals = TERMS.map((t) => schoolRecs.filter((r) => r.term === t.id && r.type === "intern").reduce((s, r) => s + r.to, 0));
    const selVals = TERMS.map((t) => schoolRecs.filter((r) => r.term === t.id && r.type === "resident" && state.depts.has(r.dept)).reduce((s, r) => s + r.to, 0));

    function buildSchoolTrendSvg(mode) {
      const W = 760, H = 200, pad = { top: 28, right: 44, bottom: 32, left: 46 };
      const cw = W - pad.left - pad.right, ch = H - pad.top - pad.bottom;
      const xOf = (i) => pad.left + (TERMS.length === 1 ? cw / 2 : (i / (TERMS.length - 1)) * cw);
      const maxV = mode === "selected"
        ? Math.max(4, ...selVals)
        : Math.max(sc.quota * 1.15, ...resVals, ...intVals, 10);
      const yOf = (v) => pad.top + ch - (v / maxV) * ch;

      const makeLine = (vals, color, showZero = false, subLabels = null) => {
        const pts = vals.map((v, i) => [xOf(i), yOf(v)]);
        const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>` +
          pts.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.2" fill="${color}" stroke="var(--surface)" stroke-width="1.5"/>` +
            ((showZero || vals[i] > 0) ? `<text x="${x.toFixed(1)}" y="${(y - 9).toFixed(1)}" text-anchor="middle" fill="${color}" font-size="11" font-weight="750">${vals[i]}${subLabels && subLabels[i] ? ` (${subLabels[i]})` : ""}</text>` : "")
          ).join("");
      };

      if (mode === "selected") {
        const pctSubs = selVals.map((v) => `${((v / sc.quota) * 100).toFixed(1)}%`);
        const pts = selVals.map((v, i) => [xOf(i), yOf(v)]);
        const dArea = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") +
          ` L${pts[pts.length - 1][0].toFixed(1)},${(pad.top + ch).toFixed(1)} L${pts[0][0].toFixed(1)},${(pad.top + ch).toFixed(1)} Z`;
        return `
          <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
            <line x1="${pad.left}" y1="${pad.top + ch}" x2="${W - pad.right}" y2="${pad.top + ch}" stroke="var(--border)"/>
            <line x1="${pad.left}" y1="${pad.top + ch / 2}" x2="${W - pad.right}" y2="${pad.top + ch / 2}" stroke="var(--border)" stroke-dasharray="3 3"/>
            <text x="${pad.left - 6}" y="${pad.top + 4}" text-anchor="end" fill="var(--ink-3)" font-size="10.5">${fmt(Math.round(maxV))}</text>
            <text x="${pad.left - 6}" y="${pad.top + ch + 4}" text-anchor="end" fill="var(--ink-3)" font-size="10.5">0</text>
            <path d="${dArea}" fill="#d97706" fill-opacity="0.12"/>
            ${makeLine(selVals, "#d97706", true, pctSubs)}
            ${TERMS.map((t, i) => `<text x="${xOf(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" fill="var(--ink-2)" font-size="11">${esc(t.label)}</text>`).join("")}
          </svg>
        `;
      }

      const qY = yOf(sc.quota).toFixed(1);
      return `
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
          <line x1="${pad.left}" y1="${pad.top + ch}" x2="${W - pad.right}" y2="${pad.top + ch}" stroke="var(--border)"/>
          <line x1="${pad.left}" y1="${qY}" x2="${W - pad.right}" y2="${qY}" stroke="var(--amber)" stroke-dasharray="5 4" stroke-width="1.5"/>
          <text x="${W - pad.right}" y="${(Number(qY) - 5).toFixed(1)}" text-anchor="end" fill="var(--amber)" font-size="10.5" font-weight="700">의대 정원 ${sc.quota}명</text>
          <text x="${pad.left - 6}" y="${pad.top + 4}" text-anchor="end" fill="var(--ink-3)" font-size="10.5">${fmt(Math.round(maxV))}</text>
          <text x="${pad.left - 6}" y="${pad.top + ch + 4}" text-anchor="end" fill="var(--ink-3)" font-size="10.5">0</text>
          ${makeLine(resVals, "#0d9488")}
          ${makeLine(intVals, "#4f46e5")}
          ${hasSelDepts ? makeLine(selVals, "#d97706") : ""}
          ${TERMS.map((t, i) => `<text x="${xOf(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" fill="var(--ink-2)" font-size="11">${esc(t.label)}</text>`).join("")}
        </svg>
      `;
    }
    const defaultScMode = hasSelDepts ? "selected" : "all";
    const trendSvg = buildSchoolTrendSvg(defaultScMode);

    // Per-hospital contribution in targetTerm
    const roles = sc.roles || {};
    const hospBreakdown = sc.hospitals.map((h) => {
      const it = internToByTermHosp.get(`${targetTerm}|${h}`) || 0;
      const rt = (resRecordsByTermHosp.get(`${targetTerm}|${h}`) || []).reduce((s, r) => s + r.to, 0);
      return { hospital: h, intern: it, resident: rt, role: roles[h] || "부속" };
    }).filter((h) => h.intern > 0 || h.resident > 0).sort((a, b) => b.resident - a.resident || b.intern - a.intern);

    // Per-specialty aggregate in targetTerm
    const deptMap = new Map();
    for (const r of schoolRecs) {
      if (r.term !== targetTerm || r.type !== "resident" || !r.dept) continue;
      deptMap.set(r.dept, (deptMap.get(r.dept) || 0) + r.to);
    }
    const deptList = [...deptMap.entries()]
      .filter(([d, v]) => v > 0 || state.depts.has(d))
      .sort((a, b) => {
        const aSel = state.depts.has(a[0]) ? 1 : 0;
        const bSel = state.depts.has(b[0]) ? 1 : 0;
        if (aSel !== bSel) return bSel - aSel;
        return b[1] - a[1] || collator.compare(a[0], b[0]);
      });

    document.getElementById("schoolDialogBody").innerHTML = `
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <h3 class="modal-section-title" style="margin:0">2023–2027 부속·협력병원 합산 TO 추이</h3>
            ${hasSelDepts ? `
              <div class="pill-group" id="schoolModalChartMode" role="group" aria-label="차트 보기 전환">
                <button type="button" class="pill is-active" data-scm="selected">선택 과목 (${esc(selLabel)})</button>
                <button type="button" class="pill" data-scm="all">전체 합산 vs 정원</button>
              </div>
            ` : ""}
          </div>
          <div class="card-legend" id="schoolModalLegend">
            ${defaultScMode === "selected"
              ? `<span class="legend-item"><span class="legend-dot" style="background:#d97706"></span>${esc(selLabel)} 합산 (의대 정원 대비 %)</span>`
              : `<span class="legend-item"><span class="legend-dot" style="background:#0d9488"></span>레지던트 합계</span><span class="legend-item"><span class="legend-dot" style="background:#4f46e5"></span>인턴 합계</span><span class="legend-item"><span class="legend-dot" style="background:var(--amber)"></span>의대 정원 (${sc.quota}명)</span>`
            }
          </div>
        </div>
        <div id="schoolModalTrendWrap">${trendSvg}</div>
      </div>

      <div class="school-modal-grid">
        <div>
          <h3 class="modal-section-title">소속 수련병원별 TO (${esc(TERM_BY_ID[targetTerm]?.label || targetTerm)})</h3>
          <table class="mini-table">
            <thead><tr><th>병원명</th><th class="num-col">인턴</th><th class="num-col">레지던트</th><th class="num-col">정원 대비</th></tr></thead>
            <tbody>
              ${hospBreakdown.map((h) => {
                const roleCls = h.role === "협력" ? "badge--amber" : h.role === "위탁" ? "badge--medium" : "badge--large";
                return `
                <tr>
                  <td>
                    <button type="button" class="table-hosp-btn" data-jump-hosp="${esc(h.hospital)}">${esc(h.hospital)}</button>
                    <span class="badge ${roleCls}" style="margin-left:4px">${esc(h.role)}</span>
                  </td>
                  <td class="num-col">${fmt(h.intern)}</td>
                  <td class="num-col"><strong>${fmt(h.resident)}</strong></td>
                  <td class="num-col" style="color:var(--accent-strong)">${((h.resident / sc.quota) * 100).toFixed(1)}%</td>
                </tr>
              `;
              }).join("") || `<tr><td colspan="4">해당 시기 데이터 없음</td></tr>`}
            </tbody>
          </table>
        </div>

        <div>
          <h3 class="modal-section-title">과목별 합산 TO & 의대 정원 대비 (%)</h3>
          <table class="mini-table">
            <thead><tr><th>과목</th><th class="num-col">합산 TO</th><th class="num-col">의대 정원 대비</th></tr></thead>
            <tbody>
              ${deptList.map(([d, v]) => {
                const isSel = state.depts.has(d);
                return `
                <tr class="${isSel ? "is-pinned-dept" : ""}">
                  <td><strong>${esc(d)}</strong>${isSel ? `<span class="badge badge--large" style="margin-left:5px">선택</span>` : ""}</td>
                  <td class="num-col">${fmt(v)}명</td>
                  <td class="num-col" style="color:var(--accent-strong);font-weight:700">${((v / sc.quota) * 100).toFixed(1)}%</td>
                </tr>
              `;
              }).join("") || `<tr><td colspan="3">해당 시기 레지던트 데이터 없음</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const scmWrap = document.getElementById("schoolModalChartMode");
    if (scmWrap) {
      scmWrap.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-scm]");
        if (!btn) return;
        const m = btn.dataset.scm;
        scmWrap.querySelectorAll("[data-scm]").forEach((b) => b.classList.toggle("is-active", b === btn));
        document.getElementById("schoolModalTrendWrap").innerHTML = buildSchoolTrendSvg(m);
        document.getElementById("schoolModalLegend").innerHTML = m === "selected"
          ? `<span class="legend-item"><span class="legend-dot" style="background:#d97706"></span>${esc(selLabel)} 합산 (의대 정원 대비 %)</span>`
          : `<span class="legend-item"><span class="legend-dot" style="background:#0d9488"></span>레지던트 합계</span><span class="legend-item"><span class="legend-dot" style="background:#4f46e5"></span>인턴 합계</span><span class="legend-item"><span class="legend-dot" style="background:var(--amber)"></span>의대 정원 (${sc.quota}명)</span>`;
      });
    }

    document.getElementById("schoolDialogBody").querySelectorAll("[data-jump-hosp]").forEach((btn) => {
      btn.addEventListener("click", () => {
        schoolDialog.close();
        openHospitalModal(btn.dataset.jumpHosp);
      });
    });

    schoolDialog.showModal();
  }

  function exportSchoolCsv() {
    const rows = state.lastSchoolRows;
    const deptName = ratioDeptLabel();
    const toTerm = state.term === "ALL" ? LATEST_TERM : state.term;
    const toLbl = TERM_BY_ID[toTerm]?.label || toTerm;
    const hdr = ["의과대학", "구분", "소재", "의대정원", `${toLbl} 부속인턴TO`, `${toLbl} ${deptName} TO`, "정원대비비율(%)", "기준대비(%p)", "소속병원"];
    const csvEsc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [hdr.map(csvEsc).join(",")];
    for (const r of rows) {
      lines.push([
        r.school.name, r.school.kind, r.school.region, r.school.quota,
        r.internTo, r.deptTo, r.ratioPct.toFixed(2), r.deltaPp.toFixed(2),
        r.activeHosps.join(" / "),
      ].map(csvEsc).join(","));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `의대별_정원대비_${deptName}_${toTerm}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  // TAB 3: YoY Diff & 2027 Special Analysis
  // =========================================================================
  function renderDiffTab() {
    const fromRows = DATA.records.filter((r) => r.term === state.diffFrom && r.type === state.type);
    const toRows = DATA.records.filter((r) => r.term === state.diffTo && r.type === state.type);

    const fromTotal = fromRows.reduce((s, r) => s + r.to, 0);
    const toTotal = toRows.reduce((s, r) => s + r.to, 0);
    const net = toTotal - fromTotal;
    const pct = fromTotal > 0 ? ((net / fromTotal) * 100).toFixed(1) : "0.0";

    const fromMetro = fromRows.filter((r) => METRO_REGIONS.has(r.region)).reduce((s, r) => s + r.to, 0);
    const toMetro = toRows.filter((r) => METRO_REGIONS.has(r.region)).reduce((s, r) => s + r.to, 0);
    const fromNonMetro = fromTotal - fromMetro;
    const toNonMetro = toTotal - toMetro;

    document.getElementById("diffKpiGrid").innerHTML = `
      <div class="kpi-card">
        <span class="kpi-label">${esc(TERM_BY_ID[state.diffFrom].label)} → ${esc(TERM_BY_ID[state.diffTo].label)}</span>
        <div class="kpi-val">${fmt(fromTotal)} → ${fmt(toTotal)}</div>
        <div class="kpi-meta"><span class="delta-pill ${net >= 0 ? "delta-pill--up" : "delta-pill--down"}">${net >= 0 ? "+" : ""}${fmt(net)}명 (${net >= 0 ? "+" : ""}${pct}%)</span></div>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">수도권 증감</span>
        <div class="kpi-val">${toMetro - fromMetro >= 0 ? "+" : ""}${fmt(toMetro - fromMetro)}<span style="font-size:14px;color:var(--ink-2)">명</span></div>
        <div class="kpi-meta">${fmt(fromMetro)} → ${fmt(toMetro)}명</div>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">비수도권 증감</span>
        <div class="kpi-val">${toNonMetro - fromNonMetro >= 0 ? "+" : ""}${fmt(toNonMetro - fromNonMetro)}<span style="font-size:14px;color:var(--ink-2)">명</span></div>
        <div class="kpi-meta">${fmt(fromNonMetro)} → ${fmt(toNonMetro)}명</div>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">비수도권 비중 변화</span>
        <div class="kpi-val">${fromTotal ? ((fromNonMetro / fromTotal) * 100).toFixed(1) : 0}% → ${toTotal ? ((toNonMetro / toTotal) * 100).toFixed(1) : 0}%</div>
        <div class="kpi-meta">비수도권 정원 점유율</div>
      </div>
    `;

    // Diverging bar helper
    function renderDiverging(containerId, keyFn) {
      const el = document.getElementById(containerId);
      const m1 = new Map(), m2 = new Map();
      fromRows.forEach((r) => { const k = keyFn(r); if (k) m1.set(k, (m1.get(k) || 0) + r.to); });
      toRows.forEach((r) => { const k = keyFn(r); if (k) m2.set(k, (m2.get(k) || 0) + r.to); });
      const keys = [...new Set([...m1.keys(), ...m2.keys()])];
      const diffs = keys.map((k) => {
        const a = m1.get(k) || 0, b = m2.get(k) || 0;
        return { key: k, from: a, to: b, diff: b - a };
      }).sort((a, b) => b.diff - a.diff);

      const maxAbs = Math.max(1, ...diffs.map((d) => Math.abs(d.diff)));
      const rowH = 25, W = 520, H = diffs.length * rowH + 16;
      const labelW = 104, rightW = 60;
      const midX = labelW + (W - labelW - rightW) / 2;
      const halfBar = (W - labelW - rightW) / 2 - 8;

      const svgRows = diffs.map((d, i) => {
        const y = 8 + i * rowH;
        const bw = (Math.abs(d.diff) / maxAbs) * halfBar;
        const x = d.diff >= 0 ? midX : midX - bw;
        const fill = d.diff > 0 ? "var(--emerald)" : d.diff < 0 ? "var(--rose)" : "var(--ink-3)";
        const sign = d.diff > 0 ? "+" : "";
        return `
          <g class="svg-bar-row" data-k="${esc(d.key)}" data-from="${d.from}" data-to="${d.to}" data-diff="${d.diff}">
            <rect class="svg-bar-bg" x="0" y="${y}" width="${W}" height="${rowH - 2}" rx="4" fill="transparent"/>
            <text x="${labelW - 8}" y="${y + 16}" text-anchor="end" fill="var(--ink)" font-size="11.5" font-weight="600">${esc(d.key)}</text>
            <rect class="svg-bar-fill" x="${x.toFixed(1)}" y="${y + 5}" width="${Math.max(1.5, bw).toFixed(1)}" height="${rowH - 11}" rx="3" fill="${fill}"/>
            <text x="${W - 6}" y="${y + 16}" text-anchor="end" fill="${fill}" font-size="11.5" font-weight="750">${sign}${fmt(d.diff)}</text>
          </g>
        `;
      }).join("");

      el.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}">
          <line x1="${midX}" y1="4" x2="${midX}" y2="${H - 4}" stroke="var(--border-strong)"/>
          ${svgRows}
        </svg>
      `;
      el.querySelectorAll(".svg-bar-row").forEach((g) => {
        g.addEventListener("mouseenter", (e) => {
          const df = Number(g.dataset.diff);
          showTooltip(e, `<strong>${esc(g.dataset.k)}</strong>${fmt(g.dataset.from)}명 → ${fmt(g.dataset.to)}명 (${df >= 0 ? "+" : ""}${fmt(df)}명)`);
        });
        g.addEventListener("mousemove", positionTooltip);
        g.addEventListener("mouseleave", hideTooltip);
      });
    }

    renderDiverging("chartDiffRegion", (r) => r.region);
    const cardDiffDept = document.getElementById("cardDiffDept");
    if (state.type === "resident") {
      cardDiffDept.hidden = false;
      renderDiverging("chartDiffDept", (r) => r.dept);
    } else {
      cardDiffDept.hidden = true;
    }

    // 2027 Special Insights (별도정원, 감원, 2027년 신규)
    const r2027 = DATA.records.filter((r) => r.term === "2027-1" && r.type === state.type);
    const extraByHosp = new Map();
    for (const r of r2027) {
      if (r.extra > 0) extraByHosp.set(r.hospital, (extraByHosp.get(r.hospital) || 0) + r.extra);
    }
    const topExtra = [...extraByHosp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const cuts = DATA.records.filter((r) => r.term === "2027-1" && r.cut < 0);
    const news = DATA.records.filter((r) => r.term === "2027-1" && r.note.includes("신규"));

    document.getElementById("special2027Grid").innerHTML = `
      <div class="special-box">
        <h3><span>2027 별도정원(b) 상위 병원 (${state.type === "resident" ? "레지던트" : "인턴"})</span><span class="badge badge--amber">총 +${fmt(r2027.reduce((s, r) => s + (r.extra || 0), 0))}</span></h3>
        <ul class="special-list">
          ${topExtra.map(([h, v]) => `<li><span>${esc(h)}</span><strong style="color:var(--amber)">+${v}명</strong></li>`).join("") || "<li>해당 내역 없음</li>"}
        </ul>
      </div>
      <div class="special-box">
        <h3><span>2027 감원(c) 적용 기관 (전체)</span><span class="badge badge--rose">${cuts.length}곳</span></h3>
        <ul class="special-list">
          ${cuts.map((r) => `<li><span>${esc(r.hospital)} <small style="color:var(--ink-2)">(${r.type === "intern" ? "인턴" : r.dept})</small></span><strong style="color:var(--rose)">${r.cut}명 (최종 ${r.to})</strong></li>`).join("") || "<li>해당 내역 없음</li>"}
        </ul>
      </div>
      <div class="special-box">
        <h3><span>2027년 신규 지정 (전체)</span><span class="badge badge--large">${news.length}건</span></h3>
        <ul class="special-list">
          ${news.map((r) => `<li><span>${esc(r.hospital)} · ${esc(r.type === "intern" ? "인턴" : r.dept)}</span><strong>TO ${r.to}</strong></li>`).join("") || "<li>해당 내역 없음</li>"}
        </ul>
      </div>
    `;
  }

  // =========================================================================
  // TAB 4: Accessible Sortable Table (modern-web-guidance: sortable-table)
  // =========================================================================
  const tableEl = document.getElementById("data-table");
  const tbodyEl = document.getElementById("dataTableBody");
  const statusEl = document.getElementById("tableSortStatus");
  let currentSortCol = 4; // 최종 TO
  let currentSortDir = "descending";

  function sortExistingRows(th, direction) {
    const tbody = tableEl.tBodies[0];
    const index = th.cellIndex;
    const type = th.dataset.type || "text";
    const factor = direction === "ascending" ? 1 : -1;

    const pairs = [...tbody.rows].map((row) => {
      const cell = row.cells[index];
      const raw = cell.dataset.value ?? cell.textContent.trim();
      return { row, val: type === "number" ? Number(raw) : raw };
    });

    pairs.sort((a, b) =>
      factor * (type === "number" ? a.val - b.val : collator.compare(a.val, b.val))
    );

    // MANDATORY: Move existing <tr> nodes (moveBefore with appendChild fallback)
    for (const { row } of pairs) {
      if (typeof tbody.moveBefore === "function") tbody.moveBefore(row, null);
      else tbody.appendChild(row);
    }
    return pairs.length;
  }

  function handleSortActivate(button) {
    const th = button.closest("th");
    if (!th) return;
    const direction = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
    for (const header of tableEl.tHead.rows[0].cells) header.removeAttribute("aria-sort");
    th.setAttribute("aria-sort", direction);
    currentSortCol = th.cellIndex;
    currentSortDir = direction;

    const count = sortExistingRows(th, direction);
    const dirKo = direction === "ascending" ? "오름차순" : "내림차순";
    statusEl.textContent = `${button.textContent.trim()} 기준 ${dirKo} 정렬, ${count}건`;
  }

  function initSortableTable() {
    // Primary: Invoker commands (`commandfor` + `command="--sort"`)
    tableEl.addEventListener("command", (event) => {
      if (event.command !== "--sort") return;
      handleSortActivate(event.source);
    });

    // Fallback for browsers without Invoker Commands support
    if (!("commandForElement" in HTMLButtonElement.prototype)) {
      tableEl.tHead.querySelectorAll('button[command="--sort"]').forEach((btn) => {
        btn.addEventListener("click", () => handleSortActivate(btn));
      });
    }
  }

  function renderTable(rows) {
    const showBreakdown = true;
    tableEl.querySelectorAll(".col-breakdown").forEach((el) => { el.hidden = !showBreakdown; });

    document.getElementById("tableCountSub").textContent =
      `필터 결과 총 ${fmt(rows.length)}건 · 총 TO ${fmt(rows.reduce((s, r) => s + r.to, 0))}명`;

    // Pre-sort data before initial slice so top rows match current sort column
    const sorted = rows.slice().sort((a, b) => {
      const f = currentSortDir === "ascending" ? 1 : -1;
      switch (currentSortCol) {
        case 0: return f * collator.compare(a.term, b.term);
        case 1: return f * collator.compare(a.region, b.region);
        case 2: return f * collator.compare(a.hospital, b.hospital);
        case 3: return f * collator.compare(a.dept, b.dept);
        case 5: return f * ((parseInt(String(a.base || "0").replace(/[()]/g, ""), 10) || 0) - (parseInt(String(b.base || "0").replace(/[()]/g, ""), 10) || 0));
        case 6: return f * ((a.extra || 0) - (b.extra || 0));
        case 7: return f * ((a.cut || 0) - (b.cut || 0));
        case 8: return f * collator.compare(a.note, b.note);
        default: return f * (a.to - b.to) || collator.compare(a.hospital, b.hospital);
      }
    });

    const visible = sorted.slice(0, state.tableLimit);
    tbodyEl.innerHTML = visible.map((r) => {
      const baseNum = r.base !== undefined ? (parseInt(String(r.base).replace(/[()]/g, ""), 10) || 0) : -1;
      return `
        <tr>
          <td data-value="${esc(r.term)}">${esc(TERM_BY_ID[r.term]?.label || r.term)}</td>
          <td>${esc(r.region)}</td>
          <td><button type="button" class="table-hosp-btn" data-open-hosp="${esc(r.hospital)}">${esc(r.hospital)}</button></td>
          <td class="col-dept">${esc(r.dept || "—")}</td>
          <td class="num-col" data-value="${r.to}">${fmt(r.to)}</td>
          <td class="num-col col-breakdown" data-value="${baseNum}" ${showBreakdown ? "" : "hidden"}>${r.base !== undefined ? esc(r.base) : "—"}</td>
          <td class="num-col col-breakdown" data-value="${r.extra || 0}" ${showBreakdown ? "" : "hidden"}>${r.extra ? `<span style="color:var(--amber)">+${r.extra}</span>` : (r.base !== undefined ? "0" : "—")}</td>
          <td class="num-col col-breakdown" data-value="${r.cut || 0}" ${showBreakdown ? "" : "hidden"}>${r.cut ? `<span style="color:var(--rose)">${r.cut}</span>` : "—"}</td>
          <td>${r.note ? `<span class="badge ${r.note.includes("신규") ? "badge--large" : ""}">${esc(r.note)}</span>` : "—"}</td>
        </tr>
      `;
    }).join("");

    tbodyEl.querySelectorAll("[data-open-hosp]").forEach((btn) => {
      btn.addEventListener("click", () => openHospitalModal(btn.dataset.openHosp));
    });

    const footer = document.getElementById("tableFooter");
    if (sorted.length > state.tableLimit) {
      footer.innerHTML = `
        <span>${fmt(sorted.length)}건 중 ${fmt(visible.length)}건 표시</span>
        <button type="button" class="pill" id="loadMoreRowsBtn">더 보기 (+500건)</button>
      `;
      document.getElementById("loadMoreRowsBtn").addEventListener("click", () => {
        state.tableLimit += 500;
        renderTable(state.lastFiltered);
      });
    } else {
      footer.innerHTML = `<span>전체 ${fmt(sorted.length)}건 표시 완료</span><span>헤더 클릭 시 정렬 · 병원명 클릭 시 상세</span>`;
    }
  }

  function exportFilteredCsv() {
    const rows = state.lastFiltered;
    const isRes = state.type === "resident";
    const hdr = isRes
      ? ["시기", "지역", "병원명", "과목", "최종TO", "기본정원", "별도정원", "감원", "비고"]
      : ["시기", "지역", "병원명", "최종TO", "기본정원", "별도정원", "감원", "비고"];
    const csvEsc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [hdr.map(csvEsc).join(",")];
    for (const r of rows) {
      const vals = isRes
        ? [TERM_BY_ID[r.term]?.label || r.term, r.region, r.hospital, r.dept, r.to, r.base ?? "", r.extra ?? "", r.cut ?? "", r.note]
        : [TERM_BY_ID[r.term]?.label || r.term, r.region, r.hospital, r.to, r.base ?? "", r.extra ?? "", r.cut ?? "", r.note];
      lines.push(vals.map(csvEsc).join(","));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `TO_${state.type}_${state.term}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  // Master Render
  // =========================================================================
  function renderAll() {
    syncControlsUI();
    const rows = getFilteredRecords();
    state.lastFiltered = rows;
    renderKPIs(rows);

    if (state.tab === "overview") renderOverview(rows);
    else if (state.tab === "schools") renderSchoolsTab();
    else if (state.tab === "hospitals") renderHospitals();
    else if (state.tab === "ratio") renderRatioTab();
    else if (state.tab === "diff") renderDiffTab();
    else if (state.tab === "table") renderTable(rows);
  }

  initControls();
  renderAll();
})();
