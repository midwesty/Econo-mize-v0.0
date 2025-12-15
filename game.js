/* ============================================================================
Fleet Baron (Demo) — game.js
Vanilla JS single-file MVP implementation.

You have:
  /index.html  (IDs must match)
  /style.css
  /data/
    cities.json
    missions.json
    transport.json
    buildings.json
    staff.json
    factions.json
    events.json
    investments.json

This file implements:
- World/Town views with clickable markers
- Tabs: Log / Missions / Staff / Investments
- Tutorial: intro + guided first mission planning
- Mission Planner (transport/route/services/staff/supplies) + dispatch
- Active mission tracking with in-game-time progress & events
- Staff hiring + basic roster management
- Investments: start + mature + payout
- Save/Load/Reset via localStorage

============================================================================ */

(() => {
  "use strict";

  /* =========================
     CONFIG
  ========================== */
  const CONFIG = {
    storageKey: "fleet_baron_save_v1",
    tickMs: 1000,               // real ms per tick
    minutesPerSecond: 10,       // 1 real second = 10 in-game minutes
    startDay: 1,
    startHour: 8,
    startMinute: 0,
    // duration tuning: derived duration uses this scale
    mapUnitKm: 12,              // map "percent points" converted to km (tune)
    baseSpeedKmPerHour: 10,     // speed factor baseline (tune)
    eventCheckIntervalMins: 120, // check for travel event every 2 in-game hours
    maxEventsPerMission: 2,
    // basic service costs
    services: {
      forecast: { cost: 25, bonus: 6 },
      cargoPrep: { cost: 35, bonus: 7 },
      crewBroker: { cost: 45, bonus: 8 }
    },
    // basic supplies (placeholder "stocking vessel")
    supplies: {
      none: { name: "None", cost: 0, bonus: 0 },
      basic: { name: "Basic Supplies", cost: 15, bonus: 3 },
      sturdy: { name: "Sturdy Supplies", cost: 35, bonus: 6 },
      premium: { name: "Premium Supplies", cost: 65, bonus: 10 }
    },
    // basic infra lease costs when player lacks owned facilities (fees come from city data too)
    infra: {
      originHandling: 15,
      destinationHandling: 15
    },
    // tutorial behavior
    tutorial: {
      enabled: true
    }
  };

  const DATA_FILES = {
    cities: "./data/cities.json",
    missions: "./data/missions.json",
    transport: "./data/transport.json",
    buildings: "./data/buildings.json",
    staff: "./data/staff.json",
    factions: "./data/factions.json",
    events: "./data/events.json",
    investments: "./data/investments.json"
  };

  /* =========================
     DOM HELPERS
  ========================== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function fmtMoney(n) {
    const s = Math.round(n).toString();
    return `${s} c`;
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function nowStamp(state) {
    const t = state.world.time;
    return `Day ${t.day} ${pad2(t.hour)}:${pad2(t.minute)}`;
  }

  function rngInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function pickWeighted(items, getWeight) {
    const total = items.reduce((a, it) => a + Math.max(0, getWeight(it)), 0);
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (const it of items) {
      r -= Math.max(0, getWeight(it));
      if (r <= 0) return it;
    }
    return items[items.length - 1] || null;
  }

  /* =========================
     GLOBALS
  ========================== */
  const app = {
    data: {
      cities: null,
      missions: null,
      transport: null,
      buildings: null,
      staff: null,
      factions: null,
      events: null,
      investments: null
    },
    refs: {},
    state: null,
    intervalId: null,
    // ephemeral UI state
    ui: {
      view: "world",
      activeTab: "log",
      selectedCityId: null,
      tutorialOverlayOpen: false
    }
  };

  /* =========================
     DEFAULT STATE
  ========================== */
  function buildDefaultState(data) {
    // Choose starter HQ city
    const starter = (data.cities?.cities || []).find(c => c.isStarterHQ) || (data.cities?.cities || [])[0];
    const starterCityId = starter ? starter.id : "city_dockford";

    return {
      player: {
        money: 500,
        reputationByCity: {},
        hqs: [starterCityId],
        // building instances (not catalog)
        ownedBuildings: [
          {
            instanceId: "bld_inst_hq_1",
            cityId: starterCityId,
            buildingId: "hq_shell",
            level: 1
          }
        ],
        ownedTransports: [],
        staff: [], // hired staff instances
        activeMissions: [], // active mission runs
        completedMissions: {}, // missionId -> true
        investments: [] // active investments instances
      },
      world: {
        time: {
          day: CONFIG.startDay,
          hour: CONFIG.startHour,
          minute: CONFIG.startMinute,
          totalMinutes: (CONFIG.startDay - 1) * 1440 + CONFIG.startHour * 60 + CONFIG.startMinute
        },
        weatherByRegion: {}, // regionId -> { state, updatedAtMinutes }
        // simple global log
        log: []
      },
      tutorial: {
        step: 0,
        completed: false
      }
    };
  }

  /* =========================
     DATA LOADING
  ========================== */
  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
    return await res.json();
  }

  async function loadAllData() {
    const [cities, missions, transport, buildings, staff, factions, events, investments] =
      await Promise.all([
        fetchJson(DATA_FILES.cities),
        fetchJson(DATA_FILES.missions),
        fetchJson(DATA_FILES.transport),
        fetchJson(DATA_FILES.buildings),
        fetchJson(DATA_FILES.staff),
        fetchJson(DATA_FILES.factions),
        fetchJson(DATA_FILES.events),
        fetchJson(DATA_FILES.investments)
      ]);

    app.data.cities = cities;
    app.data.missions = missions;
    app.data.transport = transport;
    app.data.buildings = buildings;
    app.data.staff = staff;
    app.data.factions = factions;
    app.data.events = events;
    app.data.investments = investments;
  }

  /* =========================
     LOOKUPS
  ========================== */
  function getCity(cityId) {
    return (app.data.cities?.cities || []).find(c => c.id === cityId) || null;
  }

  function getRegion(regionId) {
    return (app.data.cities?.regions || []).find(r => r.id === regionId) || null;
  }

  function getMission(missionId) {
    return (app.data.missions?.missions || []).find(m => m.id === missionId) || null;
  }

  function getTransport(transportId) {
    return (app.data.transport?.transport || []).find(t => t.id === transportId) || null;
  }

  function getBuildingCatalog(buildingId) {
    return (app.data.buildings?.buildings || []).find(b => b.id === buildingId) || null;
  }

  function getStaffTemplate(staffId) {
    return (app.data.staff?.templates || []).find(s => s.id === staffId) || null;
  }

  function getEventDef(eventId) {
    return (app.data.events?.events || []).find(e => e.id === eventId) || null;
  }

  function getFaction(factionId) {
    return (app.data.factions?.factions || []).find(f => f.id === factionId) || null;
  }

  function getInvestment(invId) {
    return (app.data.investments?.investments || []).find(i => i.id === invId) || null;
  }

  function getKnownRoutesBetween(originId, destId) {
    return (app.data.cities?.knownRoutes || []).filter(r =>
      r.originCityId === originId && r.destinationCityId === destId
    );
  }

  /* =========================
     WEATHER (simple MVP)
  ========================== */
  function initWeatherIfNeeded(state) {
    const regions = app.data.cities?.regions || [];
    for (const r of regions) {
      if (!state.world.weatherByRegion[r.id]) {
        state.world.weatherByRegion[r.id] = {
          state: pickWeatherForRegion(r),
          updatedAtMinutes: state.world.time.totalMinutes
        };
      }
    }
  }

  function pickWeatherForRegion(region) {
    // region.weatherBias is an array of favored states
    const bias = region?.weatherBias || ["clear", "rain", "fog", "storm"];
    const pick = bias[rngInt(0, bias.length - 1)];
    return pick || "clear";
  }

  function maybeAdvanceWeather(state) {
    // change weather every 6 in-game hours per region (simple)
    const regions = app.data.cities?.regions || [];
    const nowM = state.world.time.totalMinutes;
    for (const r of regions) {
      const w = state.world.weatherByRegion[r.id];
      if (!w) continue;
      if (nowM - w.updatedAtMinutes >= 360) {
        w.state = pickWeatherForRegion(r);
        w.updatedAtMinutes = nowM;
      }
    }
  }

  function getWeatherForCity(state, cityId) {
    const city = getCity(cityId);
    if (!city) return "clear";
    const regionId = city.regionId;
    return state.world.weatherByRegion[regionId]?.state || "clear";
  }

  /* =========================
     TIME
  ========================== */
  function advanceTime(state, minutesToAdd) {
    const t = state.world.time;
    t.totalMinutes += minutesToAdd;

    const total = t.totalMinutes;
    const day = Math.floor(total / 1440) + 1;
    const withinDay = total % 1440;
    const hour = Math.floor(withinDay / 60);
    const minute = withinDay % 60;

    t.day = day;
    t.hour = hour;
    t.minute = minute;
  }

  /* =========================
     LOGGING
  ========================== */
  function pushLog(state, text, kind = "info") {
    state.world.log.unshift({
      id: `log_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      time: nowStamp(state),
      kind,
      text
    });
    // cap log size
    if (state.world.log.length > 200) state.world.log.length = 200;
    renderActiveTab(); // update log quickly
  }

  function flashAlert(msg) {
    const a = app.refs.alertsDisplay;
    if (!a) return;
    a.textContent = msg;
    a.classList.add("flash");
    setTimeout(() => a.classList.remove("flash"), 700);
  }

  /* =========================
     SAVE / LOAD / RESET
  ========================== */
  function saveGame() {
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(app.state));
      pushLog(app.state, "Game saved.", "good");
      flashAlert("Saved.");
      renderAll();
    } catch (e) {
      console.error(e);
      pushLog(app.state, "Save failed.", "bad");
      flashAlert("Save failed.");
    }
  }

  function loadGame() {
    try {
      const raw = localStorage.getItem(CONFIG.storageKey);
      if (!raw) {
        pushLog(app.state, "No save found.", "warn");
        flashAlert("No save found.");
        return;
      }
      const loaded = JSON.parse(raw);
      // basic sanity: must have player/world
      if (!loaded?.player || !loaded?.world) throw new Error("Invalid save.");
      app.state = loaded;
      initWeatherIfNeeded(app.state);
      pushLog(app.state, "Game loaded.", "good");
      flashAlert("Loaded.");
      renderAll();
    } catch (e) {
      console.error(e);
      pushLog(app.state, "Load failed.", "bad");
      flashAlert("Load failed.");
    }
  }

  function resetGame() {
    if (!confirm("Reset the game to a new save?")) return;
    app.state = buildDefaultState(app.data);
    initWeatherIfNeeded(app.state);
    pushLog(app.state, "New game started.", "good");
    flashAlert("Reset.");
    closeAllModals();
    hideTutorialOverlay();
    renderAll();
    maybeStartTutorial();
  }

  /* =========================
     UI INIT / BINDINGS
  ========================== */
  function cacheRefs() {
    app.refs.btnWorld = $("#btnWorld");
    app.refs.btnTown = $("#btnTown");
    app.refs.btnSave = $("#btnSave");
    app.refs.btnLoad = $("#btnLoad");
    app.refs.btnReset = $("#btnReset");

    app.refs.timeDisplay = $("#timeDisplay");
    app.refs.weatherDisplay = $("#weatherDisplay");

    app.refs.worldView = $("#worldView");
    app.refs.townView = $("#townView");
    app.refs.worldMarkers = $("#worldMarkers");
    app.refs.townMarkers = $("#townMarkers");

    app.refs.tabBtn_log = $("#tabBtn_log");
    app.refs.tabBtn_missions = $("#tabBtn_missions");
    app.refs.tabBtn_staff = $("#tabBtn_staff");
    app.refs.tabBtn_investments = $("#tabBtn_investments");

    app.refs.panel_log = $("#tabPanel_log");
    app.refs.panel_missions = $("#tabPanel_missions");
    app.refs.panel_staff = $("#tabPanel_staff");
    app.refs.panel_investments = $("#tabPanel_investments");

    app.refs.moneyDisplay = $("#moneyDisplay");
    app.refs.incomeDisplay = $("#incomeDisplay");
    app.refs.alertsDisplay = $("#alertsDisplay");

    app.refs.modalRoot = $("#modalRoot");
    app.refs.tutorialOverlay = $("#tutorialOverlay");
  }

  function bindUI() {
    app.refs.btnWorld.addEventListener("click", () => setView("world"));
    app.refs.btnTown.addEventListener("click", () => setView("town"));

    app.refs.btnSave.addEventListener("click", saveGame);
    app.refs.btnLoad.addEventListener("click", loadGame);
    app.refs.btnReset.addEventListener("click", resetGame);

    app.refs.tabBtn_log.addEventListener("click", () => setTab("log"));
    app.refs.tabBtn_missions.addEventListener("click", () => setTab("missions"));
    app.refs.tabBtn_staff.addEventListener("click", () => setTab("staff"));
    app.refs.tabBtn_investments.addEventListener("click", () => setTab("investments"));

    // close modal on ESC
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        // if tutorial open, ignore ESC to avoid breaking steps
        if (app.ui.tutorialOverlayOpen) return;
        closeTopModal();
      }
    });
  }

  function setView(v) {
    app.ui.view = v;
    if (v === "world") {
      app.refs.worldView.style.display = "";
      app.refs.townView.style.display = "none";
      app.refs.btnWorld.classList.add("active");
      app.refs.btnTown.classList.remove("active");
    } else {
      app.refs.worldView.style.display = "none";
      app.refs.townView.style.display = "";
      app.refs.btnWorld.classList.remove("active");
      app.refs.btnTown.classList.add("active");
    }
    renderMarkers();
  }

  function setTab(tab) {
    app.ui.activeTab = tab;
    // buttons
    for (const t of ["log", "missions", "staff", "investments"]) {
      app.refs[`tabBtn_${t}`].classList.toggle("active", t === tab);
      app.refs[`panel_${t}`].style.display = (t === tab) ? "" : "none";
    }
    renderActiveTab();
  }

  /* =========================
     MAIN LOOP
  ========================== */
  function startLoop() {
    if (app.intervalId) clearInterval(app.intervalId);
    app.intervalId = setInterval(() => {
      tick();
    }, CONFIG.tickMs);
  }

  function tick() {
    const state = app.state;

    // advance time
    advanceTime(state, CONFIG.minutesPerSecond);

    // update world systems
    maybeAdvanceWeather(state);

    // update missions + investments
    updateActiveMissions(state);
    updateInvestments(state);

    // update HUD + active tab minimal
    renderHUD();

    // if missions changed, we’ll re-render missions tab on demand
    if (app.ui.activeTab === "missions") renderMissionsTab();
    if (app.ui.activeTab === "investments") renderInvestmentsTab();

    // tutorial checks
    if (!state.tutorial.completed) maybeAdvanceTutorialFromState();
  }

  /* =========================
     PLACEHOLDER STUBS (Part 2/3 will fill)
  ========================== */
  function renderAll() {
    renderHUD();
    renderMarkers();
    renderActiveTab();
  }

  function renderHUD() { /* implemented in Part 2 */ }
  function renderMarkers() { /* implemented in Part 2 */ }
  function renderActiveTab() { /* implemented in Part 2 */ }

  function renderLogTab() { /* implemented in Part 2 */ }
  function renderMissionsTab() { /* implemented in Part 2 */ }
  function renderStaffTab() { /* implemented in Part 2 */ }
  function renderInvestmentsTab() { /* implemented in Part 2 */ }

  function openCityPanel(cityId) { /* implemented in Part 2 */ }
  function openBuildingPanel(instanceId) { /* implemented in Part 2 */ }

  function openMissionPlanner(missionId, source = "list") { /* implemented in Part 3 */ }

  function updateActiveMissions(state) { /* implemented in Part 3 */ }
  function updateInvestments(state) { /* implemented in Part 3 */ }

  function closeAllModals() { /* implemented in Part 2 */ }
  function closeTopModal() { /* implemented in Part 2 */ }

  function showTutorialOverlay(opts) { /* implemented in Part 2 */ }
  function hideTutorialOverlay() { /* implemented in Part 2 */ }
  function maybeStartTutorial() { /* implemented in Part 3 */ }
  function maybeAdvanceTutorialFromState() { /* implemented in Part 3 */ }

  /* =========================
     BOOT
  ========================== */
  async function boot() {
    cacheRefs();

    // ensure modalRoot starts closed
    app.refs.modalRoot.classList.remove("open");

    try {
      await loadAllData();
    } catch (e) {
      console.error(e);
      alert("Failed to load game data JSON. Check /data/ paths and filenames.");
      return;
    }

    app.state = buildDefaultState(app.data);
    initWeatherIfNeeded(app.state);

    bindUI();
    setView("world");
    setTab("log");

    pushLog(app.state, "You inherit 500 crowns and a tiny warehouse HQ in Dockford.", "good");

    renderAll();
    startLoop();
    maybeStartTutorial();
  }

  window.addEventListener("DOMContentLoaded", boot);

})();
  /* =========================
     HUD RENDER
  ========================== */
  function renderHUD() {
    const state = app.state;
    const t = state.world.time;
    app.refs.timeDisplay.textContent = `Day ${t.day} ${pad2(t.hour)}:${pad2(t.minute)}`;

    const hqCityId = state.player.hqs[0];
    const w = getWeatherForCity(state, hqCityId);
    app.refs.weatherDisplay.textContent = `Weather: ${w}`;

    app.refs.moneyDisplay.textContent = `Money: ${fmtMoney(state.player.money)}`;

    // Simplified income/upkeep for demo: show active investments and salaries
    const dailySalary = calcDailySalaries(state);
    const invCount = state.player.investments.length;
    const activeMissions = state.player.activeMissions.length;
    app.refs.incomeDisplay.textContent = `Staff Salaries: ${fmtMoney(dailySalary)}/day • Investments: ${invCount} • Active Missions: ${activeMissions}`;
  }

  function calcDailySalaries(state) {
    let sum = 0;
    for (const s of state.player.staff) sum += (s.salaryDaily || 0);
    return sum;
  }

  /* =========================
     MARKERS (World + Town)
  ========================== */
  function renderMarkers() {
    const state = app.state;
    const worldLayer = app.refs.worldMarkers;
    const townLayer = app.refs.townMarkers;
    worldLayer.innerHTML = "";
    townLayer.innerHTML = "";

    if (app.ui.view === "world") {
      // City markers
      for (const c of (app.data.cities?.cities || [])) {
        const m = makeCityMarker(state, c);
        worldLayer.appendChild(m);
      }

      // Active mission badges near origin (simple)
      for (const run of state.player.activeMissions) {
        const mission = getMission(run.missionId);
        if (!mission) continue;
        const origin = getCity(mission.originCityId);
        if (!origin) continue;

        const badge = el("div", "missionBadge");
        badge.style.left = `${origin.x}%`;
        badge.style.top = `${origin.y - 4}%`;

        const txt = el("div", "missionBadgeText", "🚚");
        badge.appendChild(txt);

        badge.title = `Active: ${mission.name} (${Math.round(run.progressPct)}%)`;
        badge.addEventListener("click", () => openActiveMissionReport(run.runId));

        worldLayer.appendChild(badge);
      }

    } else {
      // Town markers: show HQ building + a couple plots (simple MVP)
      const hqCityId = state.player.hqs[0];
      const hqCity = getCity(hqCityId);
      if (!hqCity) return;

      // Place HQ near center-left
      const hqMarker = makeBuildingMarker("HQ", 35, 55, true);
      hqMarker.addEventListener("click", () => openHQPanel(hqCityId));
      townLayer.appendChild(hqMarker);

      // Dummy plot markers
      const plotA = makePlotMarker("Empty Plot", 58, 46);
      plotA.addEventListener("click", () => openBuildMenu(hqCityId));
      townLayer.appendChild(plotA);

      const plotB = makePlotMarker("Empty Plot", 62, 64);
      plotB.addEventListener("click", () => openBuildMenu(hqCityId));
      townLayer.appendChild(plotB);

      // Existing owned building instances (besides HQ shell) shown as markers (optional)
      const owned = state.player.ownedBuildings.filter(b => b.cityId === hqCityId && b.buildingId !== "hq_shell");
      let offset = 0;
      for (const inst of owned) {
        const catalog = getBuildingCatalog(inst.buildingId);
        if (!catalog) continue;
        // scatter markers a bit
        const x = 40 + (offset * 6);
        const y = 34 + (offset * 8);
        offset++;

        const bm = makeBuildingMarker(catalog.name, x, y, false);
        bm.addEventListener("click", () => openBuildingPanel(inst.instanceId));
        townLayer.appendChild(bm);
      }
    }
  }

  function makeCityMarker(state, city) {
    const marker = el("div", "marker cityMarker");
    marker.style.left = `${city.x}%`;
    marker.style.top = `${city.y}%`;

    const dot = el("div", "markerDot");
    const label = el("div", "markerLabel", city.name);

    const isHQ = state.player.hqs.includes(city.id);
    if (isHQ) marker.classList.add("hq");

    marker.appendChild(dot);
    marker.appendChild(label);

    marker.title = city.description || city.name;
    marker.addEventListener("click", () => openCityPanel(city.id));

    return marker;
  }

  function makeBuildingMarker(name, xPct, yPct, isHQ = false) {
    const marker = el("div", "marker buildingMarker");
    marker.style.left = `${xPct}%`;
    marker.style.top = `${yPct}%`;

    const dot = el("div", "markerDot");
    const label = el("div", "markerLabel", name);

    if (isHQ) marker.classList.add("hq");

    marker.appendChild(dot);
    marker.appendChild(label);

    return marker;
  }

  function makePlotMarker(name, xPct, yPct) {
    const marker = el("div", "marker plotMarker");
    marker.style.left = `${xPct}%`;
    marker.style.top = `${yPct}%`;

    const dot = el("div", "markerDot");
    const label = el("div", "markerLabel", name);

    marker.appendChild(dot);
    marker.appendChild(label);

    marker.title = "Build here (demo stub)";
    return marker;
  }

  /* =========================
     TAB RENDERING
  ========================== */
  function renderActiveTab() {
    const t = app.ui.activeTab;
    if (t === "log") renderLogTab();
    if (t === "missions") renderMissionsTab();
    if (t === "staff") renderStaffTab();
    if (t === "investments") renderInvestmentsTab();
  }

  function renderLogTab() {
    const panel = app.refs.panel_log;
    const state = app.state;

    panel.innerHTML = "";

    const lead = el("div", "panelLead");
    const title = el("div", "panelTitleBig", "Log");
    const desc = el("div", "muted", "Mission updates, events, tutorial prompts.");
    lead.appendChild(title);
    lead.appendChild(desc);
    panel.appendChild(lead);

    const list = el("div", "logList");
    if (state.world.log.length === 0) {
      list.appendChild(el("div", "logEmpty", "No messages yet."));
    } else {
      for (const entry of state.world.log.slice(0, 40)) {
        const row = el("div", `logRow ${entry.kind || ""}`);
        const time = el("div", "logTime", entry.time);
        const text = el("div", "logText", entry.text);
        row.appendChild(time);
        row.appendChild(text);
        list.appendChild(row);
      }
    }
    panel.appendChild(list);
  }

  function renderMissionsTab() {
    const panel = app.refs.panel_missions;
    const state = app.state;

    panel.innerHTML = "";

    const lead = el("div", "panelLead");
    lead.appendChild(el("div", "panelTitleBig", "Missions"));

    const help = el("div", "muted",
      "Pick a contract, plan it (transport, route, services, staff), then dispatch. Active missions progress over in-game time."
    );
    lead.appendChild(help);

    const actions = el("div", "cardActions");
    const btnPlan = el("button", "btn primary", "Plan Mission");
    btnPlan.type = "button";
    btnPlan.addEventListener("click", () => openMissionPicker());
    actions.appendChild(btnPlan);

    lead.appendChild(actions);
    panel.appendChild(lead);

    // Active missions
    const activeSection = el("div", "panelSection");
    activeSection.appendChild(el("div", "sectionTitle", "Active Missions"));

    if (state.player.activeMissions.length === 0) {
      activeSection.appendChild(el("div", "muted", "No active missions."));
    } else {
      for (const run of state.player.activeMissions) {
        const mission = getMission(run.missionId);
        if (!mission) continue;

        const card = el("div", "card");
        card.appendChild(el("div", "cardTitle", mission.name));
        card.appendChild(el("div", "cardLine", `From: ${getCity(mission.originCityId)?.name || "?"} → To: ${getCity(mission.destinationCityId)?.name || "?"}`));
        card.appendChild(el("div", "cardLine", `Transport: ${getTransport(run.plan.transportId)?.name || run.plan.transportId}`));
        card.appendChild(el("div", "cardLine", `Progress: ${Math.round(run.progressPct)}%`));
        card.appendChild(el("div", "cardLine", `ETA: Day ${run.eta.day} ${pad2(run.eta.hour)}:${pad2(run.eta.minute)}`));

        const acts = el("div", "cardActions");
        const btnView = el("button", "btn small", "View");
        btnView.type = "button";
        btnView.addEventListener("click", () => openActiveMissionReport(run.runId));
        acts.appendChild(btnView);

        card.appendChild(acts);
        activeSection.appendChild(card);
      }
    }

    panel.appendChild(activeSection);

    // Available missions
    const availSection = el("div", "panelSection");
    availSection.appendChild(el("div", "sectionTitle", "Available Contracts"));

    const missions = (app.data.missions?.missions || []);
    for (const m of missions) {
      // allow re-running; tutorial marks completed but still playable
      const item = el("button", "listItem");
      item.type = "button";

      const t = el("div", "liTitle", m.name);
      const d = el("div", "liSub", m.description);
      const meta = el("div", "liMeta", `Reward: ${fmtMoney(m.baseReward)} • Difficulty: ${m.difficulty} • Deadline: ${m.deadlineHours}h`);

      item.appendChild(t);
      item.appendChild(d);
      item.appendChild(meta);

      // Tutorial highlight
      if (!state.tutorial.completed && m.tutorial) item.classList.add("highlight");

      item.addEventListener("click", () => openMissionPlanner(m.id, "list"));
      availSection.appendChild(item);
    }

    panel.appendChild(availSection);
  }

  function renderStaffTab() {
    const panel = app.refs.panel_staff;
    const state = app.state;
    panel.innerHTML = "";

    const lead = el("div", "panelLead");
    lead.appendChild(el("div", "panelTitleBig", "Staff"));
    lead.appendChild(el("div", "muted", "Hire staff in your HQ city. Assign them during mission planning (MVP)."));
    panel.appendChild(lead);

    // Owned staff roster
    const roster = el("div", "panelSection");
    roster.appendChild(el("div", "sectionTitle", "Your Staff"));

    if (state.player.staff.length === 0) {
      roster.appendChild(el("div", "muted", "You have no hired staff yet."));
    } else {
      for (const s of state.player.staff) {
        const card = el("div", "card");
        card.appendChild(el("div", "cardTitle", `${s.name} — ${prettyRole(s.role)}`));
        card.appendChild(el("div", "cardLine", `Salary: ${fmtMoney(s.salaryDaily)}/day`));
        card.appendChild(el("div", "cardLine", `Traits: ${(s.traits || []).join(", ") || "None"}`));

        const skills = s.skills || {};
        card.appendChild(el("div", "cardLine", `Skills: forecasting ${skills.forecasting || 0}, navigation ${skills.navigation || 0}, logistics ${skills.logistics || 0}, security ${skills.security || 0}`));

        const acts = el("div", "cardActions");
        const btnFire = el("button", "btn small danger", "Dismiss");
        btnFire.type = "button";
        btnFire.addEventListener("click", () => dismissStaff(s.instanceId));
        acts.appendChild(btnFire);
        card.appendChild(acts);

        roster.appendChild(card);
      }
    }
    panel.appendChild(roster);

    // Hiring pool in HQ city
    const hire = el("div", "panelSection");
    hire.appendChild(el("div", "sectionTitle", "Hire in Current HQ"));

    const hqCityId = state.player.hqs[0];
    const hqCity = getCity(hqCityId);
    hire.appendChild(el("div", "muted", `Recruitment board in ${hqCity?.name || "HQ"}.`));

    const pool = getHirePoolForCity(hqCityId);
    if (pool.length === 0) {
      hire.appendChild(el("div", "muted", "No candidates available here right now."));
    } else {
      for (const tpl of pool) {
        const already = state.player.staff.some(s => s.templateId === tpl.id);
        const card = el("div", "card");
        card.appendChild(el("div", "cardTitle", `${tpl.name} — ${prettyRole(tpl.role)}`));
        card.appendChild(el("div", "cardLine", `Salary: ${fmtMoney(tpl.salaryDaily)}/day`));
        card.appendChild(el("div", "cardLine", `Traits: ${(tpl.traits || []).join(", ") || "None"}`));

        const skills = tpl.skills || {};
        card.appendChild(el("div", "cardLine", `Skills: forecasting ${skills.forecasting || 0}, navigation ${skills.navigation || 0}, logistics ${skills.logistics || 0}, security ${skills.security || 0}`));

        const acts = el("div", "cardActions");
        const btnHire = el("button", "btn small primary", already ? "Hired" : "Hire");
        btnHire.type = "button";
        btnHire.disabled = already;
        btnHire.addEventListener("click", () => hireStaff(tpl.id, hqCityId));
        acts.appendChild(btnHire);

        card.appendChild(acts);
        hire.appendChild(card);
      }
    }

    panel.appendChild(hire);
  }

  function renderInvestmentsTab() {
    const panel = app.refs.panel_investments;
    const state = app.state;
    panel.innerHTML = "";

    const lead = el("div", "panelLead");
    lead.appendChild(el("div", "panelTitleBig", "Investments"));
    lead.appendChild(el("div", "muted", "Fund local projects for passive returns. (MVP: payouts occur at end of duration.)"));
    panel.appendChild(lead);

    // Active investments
    const active = el("div", "panelSection");
    active.appendChild(el("div", "sectionTitle", "Active Investments"));

    if (state.player.investments.length === 0) {
      active.appendChild(el("div", "muted", "No active investments."));
    } else {
      for (const inst of state.player.investments) {
        const inv = getInvestment(inst.invId);
        if (!inv) continue;
        const card = el("div", "card");
        card.appendChild(el("div", "cardTitle", inv.name));
        card.appendChild(el("div", "cardLine", `Cost: ${fmtMoney(inv.cost)} • Total Return: ${fmtMoney(inv.totalReturn)} • Risk: ${inv.risk}`));
        card.appendChild(el("div", "cardLine", `Matures: Day ${inst.maturesAt.day} ${pad2(inst.maturesAt.hour)}:${pad2(inst.maturesAt.minute)}`));
        panel.appendChild(card);
      }
    }
    panel.appendChild(active);

    // Opportunities (HQ city)
    const opp = el("div", "panelSection");
    opp.appendChild(el("div", "sectionTitle", "Opportunities (HQ City)"));

    const hqCityId = state.player.hqs[0];
    const opps = (app.data.investments?.investments || []).filter(i => i.cityId === hqCityId);

    if (opps.length === 0) {
      opp.appendChild(el("div", "muted", "No opportunities available here."));
    } else {
      for (const inv of opps) {
        const card = el("div", "card");
        card.appendChild(el("div", "cardTitle", inv.name));
        card.appendChild(el("div", "cardLine", inv.description || ""));
        card.appendChild(el("div", "cardLine", `Cost: ${fmtMoney(inv.cost)} • Total Return: ${fmtMoney(inv.totalReturn)} • Duration: ${inv.durationDays} days • Risk: ${inv.risk}`));

        const acts = el("div", "cardActions");
        const btn = el("button", "btn small primary", "Fund");
        btn.type = "button";
        btn.disabled = app.state.player.money < inv.cost;
        btn.addEventListener("click", () => startInvestment(inv.id));
        acts.appendChild(btn);

        card.appendChild(acts);
        opp.appendChild(card);
      }
    }
    panel.appendChild(opp);
  }

  function prettyRole(role) {
    const map = {
      meteorologist: "Meteorologist",
      logistics: "Logistics",
      dockWorker: "Dock Worker",
      captain: "Captain",
      security: "Security"
    };
    return map[role] || (role ? role[0].toUpperCase() + role.slice(1) : "Staff");
  }

  /* =========================
     CITY PANEL (World click)
  ========================== */
  function openCityPanel(cityId) {
    const city = getCity(cityId);
    if (!city) return;

    const state = app.state;
    app.ui.selectedCityId = cityId;

    const body = el("div");
    const lead = el("div", "panelLead");
    lead.appendChild(el("div", "panelTitleBig", city.name));
    lead.appendChild(el("div", "muted", city.description || ""));
    body.appendChild(lead);

    const w = getWeatherForCity(state, cityId);
    const weatherCard = el("div", "card");
    weatherCard.appendChild(el("div", "cardTitle", "Local Weather"));
    weatherCard.appendChild(el("div", "cardLine", `Current: ${w}`));

    const acts = el("div", "cardActions");
    const btnForecast = el("button", "btn small", `Buy Forecast (${fmtMoney(CONFIG.services.forecast.cost)})`);
    btnForecast.type = "button";
    btnForecast.disabled = state.player.money < CONFIG.services.forecast.cost;
    btnForecast.addEventListener("click", () => {
      buyForecast(cityId);
    });
    acts.appendChild(btnForecast);
    weatherCard.appendChild(acts);

    body.appendChild(weatherCard);

    // Mission shortcuts from city
    const mCard = el("div", "card");
    mCard.appendChild(el("div", "cardTitle", "Contracts From Here"));
    const list = (app.data.missions?.missions || []).filter(m => m.originCityId === cityId);
    if (list.length === 0) {
      mCard.appendChild(el("div", "muted", "No contracts originate here in the demo."));
    } else {
      for (const m of list) {
        const b = el("button", "btn small primary", `Plan: ${m.name}`);
        b.type = "button";
        b.addEventListener("click", () => openMissionPlanner(m.id, "city"));
        mCard.appendChild(b);
      }
    }
    body.appendChild(mCard);

    // Basic faction note
    const factionCard = el("div", "card");
    factionCard.appendChild(el("div", "cardTitle", "Factions"));
    const factions = (app.data.factions?.factions || []).filter(f => (f.territories || []).includes(city.regionId));
    if (factions.length === 0) {
      factionCard.appendChild(el("div", "muted", "No major factions noted here (demo)."));
    } else {
      for (const f of factions) {
        factionCard.appendChild(el("div", "cardLine", `${f.name} (${f.type}) — attitude ${f.attitudeTowardsPlayer}`));
      }
    }
    body.appendChild(factionCard);

    openModal({
      title: `City: ${city.name}`,
      bodyEl: body,
      footerButtons: [
        { label: "Close", className: "btn", onClick: closeTopModal }
      ]
    });
  }

  function buyForecast(cityId) {
    const state = app.state;
    const cost = CONFIG.services.forecast.cost;
    if (state.player.money < cost) return;

    state.player.money -= cost;

    const city = getCity(cityId);
    const region = getRegion(city?.regionId);
    const bias = region?.weatherBias || ["clear", "rain", "fog", "storm"];
    // create a “forecast” list (approximate)
    const forecast = [];
    for (let i = 0; i < 3; i++) {
      forecast.push(bias[rngInt(0, bias.length - 1)]);
    }

    pushLog(state, `Forecast purchased for ${city?.name || "city"}: Next 3 days → ${forecast.join(", ")}.`, "good");
    flashAlert("Forecast received.");
    renderHUD();
    renderActiveTab();
  }

  /* =========================
     TOWN PANELS (MVP stubs)
  ========================== */
  function openHQPanel(cityId) {
    const city = getCity(cityId);
    const state = app.state;

    const body = el("div");

    const lead = el("div", "panelLead");
    lead.appendChild(el("div", "panelTitleBig", `${city?.name || "HQ"} — Headquarters`));
    lead.appendChild(el("div", "muted", "Your tiny warehouse HQ. Upgrade and build more facilities later."));
    body.appendChild(lead);

    const card = el("div", "card");
    card.appendChild(el("div", "cardTitle", "HQ Actions"));
    const acts = el("div", "cardActions");

    const btnPlan = el("button", "btn small primary", "Plan Mission");
    btnPlan.type = "button";
    btnPlan.addEventListener("click", () => openMissionPicker());
    acts.appendChild(btnPlan);

    const btnHire = el("button", "btn small", "Staff Board");
    btnHire.type = "button";
    btnHire.addEventListener("click", () => {
      setTab("staff");
      closeTopModal();
    });
    acts.appendChild(btnHire);

    const btnInv = el("button", "btn small", "Investments");
    btnInv.type = "button";
    btnInv.addEventListener("click", () => {
      setTab("investments");
      closeTopModal();
    });
    acts.appendChild(btnInv);

    card.appendChild(acts);
    body.appendChild(card);

    openModal({
      title: "HQ",
      bodyEl: body,
      footerButtons: [
        { label: "Close", className: "btn", onClick: closeTopModal }
      ]
    });
  }

  function openBuildMenu(cityId) {
    const state = app.state;
    const body = el("div");

    const lead = el("div", "panelLead");
    lead.appendChild(el("div", "panelTitleBig", "Build Facility (Demo Stub)"));
    lead.appendChild(el("div", "muted", "You can add a facility instance to your HQ city. Effects are minimal in MVP."));
    body.appendChild(lead);

    const list = el("div", "transportList");
    const options = (app.data.buildings?.buildings || []).filter(b => b.id !== "hq_shell");
    for (const b of options) {
      const card = el("button", "transportCard");
      card.type = "button";
      card.appendChild(el("div", "liTitle", b.name));
      card.appendChild(el("div", "liSub", `Cost: ${fmtMoney(b.baseCost)} • Slots: ${b.staffSlots} • Reliability: ${b.reliability}`));

      const affordable = state.player.money >= b.baseCost;
      if (!affordable) card.classList.add("locked");

      card.disabled = !affordable;
      card.addEventListener("click", () => {
        buyBuilding(cityId, b.id);
        closeTopModal();
      });

      list.appendChild(card);
    }

    body.appendChild(list);

    openModal({
      title: "Construction",
      bodyEl: body,
      footerButtons: [
        { label: "Close", className: "btn", onClick: closeTopModal }
      ]
    });
  }

  function buyBuilding(cityId, buildingId) {
    const state = app.state;
    const cat = getBuildingCatalog(buildingId);
    if (!cat) return;
    if (state.player.money < cat.baseCost) return;

    state.player.money -= cat.baseCost;

    const inst = {
      instanceId: `bld_inst_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      cityId,
      buildingId,
      level: 1
    };
    state.player.ownedBuildings.push(inst);

    pushLog(state, `Built: ${cat.name} in ${getCity(cityId)?.name || "HQ city"}.`, "good");
    flashAlert("Facility built.");
    renderHUD();
    renderMarkers();
    renderActiveTab();
  }

  function openBuildingPanel(instanceId) {
    const state = app.state;
    const inst = state.player.ownedBuildings.find(b => b.instanceId === instanceId);
    if (!inst) return;
    const cat = getBuildingCatalog(inst.buildingId);
    const city = getCity(inst.cityId);

    const body = el("div");

    const lead = el("div", "panelLead");
    lead.appendChild(el("div", "panelTitleBig", `${cat?.name || inst.buildingId}`));
    lead.appendChild(el("div", "muted", `Location: ${city?.name || "?"} • Level ${inst.level}`));
    body.appendChild(lead);

    const card = el("div", "card");
    card.appendChild(el("div", "cardTitle", "Status"));
    card.appendChild(el("div", "cardLine", `Reliability: ${cat?.reliability || 0}`));
    card.appendChild(el("div", "cardLine", `Staff Slots: ${cat?.staffSlots || 0}`));
    card.appendChild(el("div", "cardLine", `Features: ${(cat?.features || []).join(", ") || "None"}`));
    body.appendChild(card);

    // Upgrade (basic)
    const upCard = el("div", "card");
    upCard.appendChild(el("div", "cardTitle", "Upgrade"));
    const nextKey = `level${inst.level + 1}`;
    const cost = cat?.upgradeCosts?.[nextKey];
    if (!cost) {
      upCard.appendChild(el("div", "muted", "No upgrades available (demo)."));
    } else {
      upCard.appendChild(el("div", "cardLine", `Next upgrade cost: ${fmtMoney(cost)}`));
      const acts = el("div", "cardActions");
      const btn = el("button", "btn small primary", "Upgrade");
      btn.type = "button";
      btn.disabled = app.state.player.money < cost;
      btn.addEventListener("click", () => {
        upgradeBuilding(instanceId);
        closeTopModal();
      });
      acts.appendChild(btn);
      upCard.appendChild(acts);
    }
    body.appendChild(upCard);

    openModal({
      title: "Building",
      bodyEl: body,
      footerButtons: [
        { label: "Close", className: "btn", onClick: closeTopModal }
      ]
    });
  }

  function upgradeBuilding(instanceId) {
    const state = app.state;
    const inst = state.player.ownedBuildings.find(b => b.instanceId === instanceId);
    if (!inst) return;
    const cat = getBuildingCatalog(inst.buildingId);
    if (!cat) return;
    const nextKey = `level${inst.level + 1}`;
    const cost = cat.upgradeCosts?.[nextKey];
    if (!cost) return;
    if (state.player.money < cost) return;

    state.player.money -= cost;
    inst.level += 1;

    pushLog(state, `Upgraded ${cat.name} to Level ${inst.level}.`, "good");
    flashAlert("Upgraded.");
    renderHUD();
    renderMarkers();
    renderActiveTab();
  }

  /* =========================
     STAFF: Hire / Dismiss
  ========================== */
  function getHirePoolForCity(cityId) {
    return (app.data.staff?.templates || []).filter(tpl =>
      (tpl.availabilityCityIds || []).includes(cityId)
    );
  }

  function hireStaff(templateId, cityId) {
    const state = app.state;
    const tpl = getStaffTemplate(templateId);
    if (!tpl) return;

    // Already hired?
    if (state.player.staff.some(s => s.templateId === templateId)) return;

    // Hiring fee? (MVP: none) — you start paying daily salary implicitly
    const inst = deepClone(tpl);
    inst.instanceId = `staff_inst_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    inst.templateId = tpl.id;
    inst.hiredAtCityId = cityId;
    inst.assignedBuildingId = null;
    inst.assignedMissionRunId = null;

    state.player.staff.push(inst);

    pushLog(state, `Hired ${tpl.name} (${prettyRole(tpl.role)}).`, "good");
    flashAlert("Staff hired.");
    renderHUD();
    renderStaffTab();
  }

  function dismissStaff(instanceId) {
    const state = app.state;
    const idx = state.player.staff.findIndex(s => s.instanceId === instanceId);
    if (idx === -1) return;

    const s = state.player.staff[idx];

    // Prevent dismissal if currently assigned to an active mission run
    const assigned = state.player.activeMissions.some(r =>
      (r.plan?.assignedStaffInstanceIds || []).includes(instanceId)
    );
    if (assigned) {
      pushLog(state, `${s.name} is currently assigned to an active mission and cannot be dismissed.`, "warn");
      flashAlert("Assigned to mission.");
      return;
    }

    if (!confirm(`Dismiss ${s.name}?`)) return;

    state.player.staff.splice(idx, 1);
    pushLog(state, `Dismissed ${s.name}.`, "warn");
    flashAlert("Dismissed.");
    renderHUD();
    renderStaffTab();
  }

  /* =========================
     INVESTMENTS: start (matures handled in Part 3)
  ========================== */
  function startInvestment(invId) {
    const state = app.state;
    const inv = getInvestment(invId);
    if (!inv) return;
    if (state.player.money < inv.cost) return;

    state.player.money -= inv.cost;

    const nowM = state.world.time.totalMinutes;
    const durationMins = (inv.durationDays || 1) * 1440;
    const matureAt = minutesToClock(nowM + durationMins);

    const inst = {
      instanceId: `inv_inst_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      invId: inv.id,
      startedAtMinutes: nowM,
      maturesAtMinutes: nowM + durationMins,
      maturesAt: matureAt
    };

    state.player.investments.push(inst);
    pushLog(state, `Funded investment: ${inv.name} (matures Day ${matureAt.day}).`, "good");
    flashAlert("Investment started.");
    renderHUD();
    renderInvestmentsTab();
  }

  function minutesToClock(totalMinutes) {
    const day = Math.floor(totalMinutes / 1440) + 1;
    const within = totalMinutes % 1440;
    const hour = Math.floor(within / 60);
    const minute = within % 60;
    return { day, hour, minute };
  }

  /* =========================
     MISSION PICKER (quick modal)
  ========================== */
  function openMissionPicker() {
    const body = el("div");
    body.appendChild(el("div", "muted", "Select a mission to plan."));

    const list = el("div", "transportList");
    for (const m of (app.data.missions?.missions || [])) {
      const card = el("button", "transportCard");
      card.type = "button";
      card.appendChild(el("div", "liTitle", m.name));
      card.appendChild(el("div", "liSub", m.description));
      card.appendChild(el("div", "liMeta", `Reward: ${fmtMoney(m.baseReward)} • Difficulty: ${m.difficulty}`));
      card.addEventListener("click", () => {
        closeTopModal();
        openMissionPlanner(m.id, "picker");
      });
      list.appendChild(card);
    }

    body.appendChild(list);

    openModal({
      title: "Plan a Mission",
      bodyEl: body,
      footerButtons: [
        { label: "Close", className: "btn", onClick: closeTopModal }
      ]
    });
  }

  /* =========================
     ACTIVE MISSION REPORT (simple)
  ========================== */
  function openActiveMissionReport(runId) {
    const state = app.state;
    const run = state.player.activeMissions.find(r => r.runId === runId);
    if (!run) return;

    const mission = getMission(run.missionId);
    const body = el("div");

    const lead = el("div", "panelLead");
    lead.appendChild(el("div", "panelTitleBig", mission?.name || "Mission"));
    lead.appendChild(el("div", "muted", `Progress: ${Math.round(run.progressPct)}%`));
    body.appendChild(lead);

    const plan = run.plan || {};

    const card = el("div", "card");
    card.appendChild(el("div", "cardTitle", "Details"));
    card.appendChild(el("div", "cardLine", `Transport: ${getTransport(plan.transportId)?.name || plan.transportId}`));
    card.appendChild(el("div", "cardLine", `Route: ${plan.routeName || "Manual"}`));
    card.appendChild(el("div", "cardLine", `Departed: Day ${run.departedAt.day} ${pad2(run.departedAt.hour)}:${pad2(run.departedAt.minute)}`));
    card.appendChild(el("div", "cardLine", `ETA: Day ${run.eta.day} ${pad2(run.eta.hour)}:${pad2(run.eta.minute)}`));
    body.appendChild(card);

    const ev = el("div", "card");
    ev.appendChild(el("div", "cardTitle", "En-route Log"));
    if (!run.travelLog || run.travelLog.length === 0) {
      ev.appendChild(el("div", "muted", "No incidents yet."));
    } else {
      const pre = el("pre", "codeBlock");
      pre.textContent = run.travelLog.slice(-12).join("\n");
      ev.appendChild(pre);
    }
    body.appendChild(ev);

    openModal({
      title: "Active Mission",
      bodyEl: body,
      footerButtons: [
        { label: "Close", className: "btn", onClick: closeTopModal }
      ]
    });
  }

  /* =========================
     MODALS
  ========================== */
  function openModal({ title, bodyEl, footerButtons }) {
    const root = app.refs.modalRoot;
    root.classList.add("open");

    const overlay = el("div", "modalOverlay");
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && !app.ui.tutorialOverlayOpen) closeTopModal();
    });

    const modal = el("div", "modal");

    const header = el("div", "modalHeader");
    header.appendChild(el("div", "modalTitle", title || "Modal"));
    const btnX = el("button", "btn small", "✕");
    btnX.type = "button";
    btnX.addEventListener("click", () => {
      if (app.ui.tutorialOverlayOpen) return;
      closeTopModal();
    });
    header.appendChild(btnX);

    const body = el("div", "modalBody");
    if (bodyEl) body.appendChild(bodyEl);

    const footer = el("div", "modalFooter");
    (footerButtons || []).forEach(b => {
      const btn = el("button", b.className || "btn", b.label || "OK");
      btn.type = "button";
      btn.addEventListener("click", b.onClick || closeTopModal);
      footer.appendChild(btn);
    });

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    root.appendChild(overlay);
  }

  function closeTopModal() {
    const root = app.refs.modalRoot;
    const overlays = $$(".modalOverlay", root);
    if (overlays.length === 0) return;
    const top = overlays[overlays.length - 1];
    top.remove();
    if ($$(".modalOverlay", root).length === 0) {
      root.classList.remove("open");
    }
  }

  function closeAllModals() {
    const root = app.refs.modalRoot;
    root.innerHTML = "";
    root.classList.remove("open");
  }

  /* =========================
     TUTORIAL OVERLAY (simple)
  ========================== */
  function showTutorialOverlay({ title, paragraphs, buttonLabel = "Next", onNext }) {
    const overlay = app.refs.tutorialOverlay;
    overlay.innerHTML = "";
    overlay.classList.remove("hidden");
    app.ui.tutorialOverlayOpen = true;

    const box = el("div", "tutorialBox");
    box.appendChild(el("div", "tutorialTitle", title || "Tutorial"));

    const body = el("div", "tutorialBody");
    (paragraphs || []).forEach(p => {
      const para = document.createElement("p");
      para.textContent = p;
      body.appendChild(para);
    });

    const actions = el("div", "tutorialActions");
    const btn = el("button", "btn primary", buttonLabel);
    btn.type = "button";
    btn.addEventListener("click", () => {
      if (typeof onNext === "function") onNext();
    });
    actions.appendChild(btn);

    box.appendChild(body);
    box.appendChild(actions);

    overlay.appendChild(box);
  }

  function hideTutorialOverlay() {
    const overlay = app.refs.tutorialOverlay;
    overlay.classList.add("hidden");
    overlay.innerHTML = "";
    app.ui.tutorialOverlayOpen = false;
  }
  /* =========================
     MISSION PLANNER + DISPATCH
  ========================== */

  function openMissionPlanner(missionId, source = "list") {
    const state = app.state;
    const mission = getMission(missionId);
    if (!mission) return;

    const origin = getCity(mission.originCityId);
    const dest = getCity(mission.destinationCityId);

    // Tutorial detection: opening planner advances tutorial step
    if (!state.tutorial.completed && mission.tutorial && state.tutorial.step <= 1) {
      state.tutorial.step = 2;
      showTutorialOverlay({
        title: "Plan the Mission",
        paragraphs: [
          "Now choose your transport, route, and any preparation services.",
          "Then dispatch the mission to begin travel."
        ],
        buttonLabel: "Got it",
        onNext: () => hideTutorialOverlay()
      });
    }

    // Planner draft state
    const draft = {
      missionId,
      transportId: null,
      routeMode: "known", // known | shady | manual
      routeId: null,
      routeName: null,
      services: { forecast: false, cargoPrep: false, crewBroker: false },
      suppliesKey: "none",
      assignedStaffInstanceIds: []
    };

    // Preselect: mule if exists
    const mule = getTransport("mule");
    if (mule) draft.transportId = "mule";

    // Known routes
    const knownRoutes = getKnownRoutesBetween(mission.originCityId, mission.destinationCityId);

    // If there are known routes, default to the first "Main" route if possible
    if (knownRoutes.length > 0) {
      const main = knownRoutes.find(r => /main/i.test(r.name)) || knownRoutes[0];
      draft.routeId = main.id;
      draft.routeName = main.name;
      draft.routeMode = /shady/i.test(main.name) ? "shady" : "known";
    } else {
      draft.routeMode = "manual";
      draft.routeId = null;
      draft.routeName = "Manual Route";
    }

    // Build UI
    const body = el("div");

    const lead = el("div", "panelLead");
    lead.appendChild(el("div", "panelTitleBig", mission.name));
    lead.appendChild(el("div", "muted", mission.description));
    lead.appendChild(el("div", "muted", `From: ${origin?.name || "?"} → To: ${dest?.name || "?"}`));
    body.appendChild(lead);

    // Transport selection
    const transportSection = el("div", "panelSection");
    transportSection.appendChild(el("div", "sectionTitle", "1) Choose Transport"));

    const transportList = el("div", "transportList");
    for (const t of (app.data.transport?.transport || [])) {
      const card = el("button", "transportCard");
      card.type = "button";

      const affordable = state.player.money >= t.baseRentalCost;
      if (!affordable) card.classList.add("locked");
      if (draft.transportId === t.id) card.classList.add("selected");

      const distanceKm = estimateDistanceKm(origin, dest);
      const dur = estimateMissionDurationHours(mission, t, distanceKm, draft.routeMode, draft.routeId);

      card.appendChild(el("div", "liTitle", t.name));
      card.appendChild(el("div", "liSub", `Rental: ${fmtMoney(t.baseRentalCost)} • Speed: ${t.speed} • Risk: ${t.baseRisk}`));
      card.appendChild(el("div", "liMeta", `Estimated travel time: ~${Math.round(dur)}h in-game`));

      card.addEventListener("click", () => {
        draft.transportId = t.id;
        // rerender selection styling
        for (const c of $$(".transportCard", body)) c.classList.remove("selected");
        card.classList.add("selected");
        updateBreakdown();
      });

      transportList.appendChild(card);
    }
    transportSection.appendChild(transportList);
    body.appendChild(transportSection);

    // Route selection
    const routeSection = el("div", "panelSection");
    routeSection.appendChild(el("div", "sectionTitle", "2) Choose Route"));

    const routeChoices = el("div", "routeChoices");

    const btnKnown = el("button", `btn small ${draft.routeMode === "known" ? "primary" : ""}`, "Known Route");
    btnKnown.type = "button";
    btnKnown.addEventListener("click", () => {
      draft.routeMode = "known";
      selectRouteForMode();
      syncRouteButtons();
      updateBreakdown();
    });

    const btnShady = el("button", `btn small ${draft.routeMode === "shady" ? "primary" : ""}`, "Shady Route");
    btnShady.type = "button";
    btnShady.addEventListener("click", () => {
      draft.routeMode = "shady";
      selectRouteForMode();
      syncRouteButtons();
      updateBreakdown();
    });

    const btnManual = el("button", `btn small ${draft.routeMode === "manual" ? "primary" : ""}`, "Manual");
    btnManual.type = "button";
    btnManual.addEventListener("click", () => {
      draft.routeMode = "manual";
      draft.routeId = null;
      draft.routeName = "Manual Route";
      syncRouteButtons();
      updateBreakdown();
    });

    routeChoices.appendChild(btnKnown);
    routeChoices.appendChild(btnShady);
    routeChoices.appendChild(btnManual);
    routeSection.appendChild(routeChoices);

    const routeInfo = el("div", "muted", "");
    routeSection.appendChild(routeInfo);

    function syncRouteButtons() {
      btnKnown.classList.toggle("primary", draft.routeMode === "known");
      btnShady.classList.toggle("primary", draft.routeMode === "shady");
      btnManual.classList.toggle("primary", draft.routeMode === "manual");

      const selectedRoute = getSelectedRoute();
      if (draft.routeMode === "manual") {
        routeInfo.textContent = "Manual route: basic risk and duration (MVP).";
      } else if (selectedRoute) {
        routeInfo.textContent = `${selectedRoute.name}: ${selectedRoute.notes || ""}`;
      } else {
        routeInfo.textContent = "No route data available. Using manual defaults.";
      }
    }

    function getSelectedRoute() {
      if (!draft.routeId) return null;
      return knownRoutes.find(r => r.id === draft.routeId) || null;
    }

    function selectRouteForMode() {
      if (knownRoutes.length === 0) {
        draft.routeMode = "manual";
        draft.routeId = null;
        draft.routeName = "Manual Route";
        return;
      }
      const matches = knownRoutes.filter(r => (draft.routeMode === "shady" ? /shady/i.test(r.name) : !/shady/i.test(r.name)));
      const pick = matches[0] || knownRoutes[0];
      draft.routeId = pick.id;
      draft.routeName = pick.name;
    }

    syncRouteButtons();
    body.appendChild(routeSection);

    // Services
    const servicesSection = el("div", "panelSection");
    servicesSection.appendChild(el("div", "sectionTitle", "3) Services & Preparation"));

    const servicesList = el("div", "servicesList");

    servicesList.appendChild(makeServiceRow("forecast", "Weather Forecast", CONFIG.services.forecast.cost, () => updateBreakdown()));
    servicesList.appendChild(makeServiceRow("cargoPrep", "Cargo Prep Service", CONFIG.services.cargoPrep.cost, () => updateBreakdown()));
    servicesList.appendChild(makeServiceRow("crewBroker", "Crew Broker", CONFIG.services.crewBroker.cost, () => updateBreakdown()));

    servicesSection.appendChild(servicesList);
    body.appendChild(servicesSection);

    function makeServiceRow(key, label, cost, onChange) {
      const row = el("label", "checkRow");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!draft.services[key];
      cb.addEventListener("change", () => {
        draft.services[key] = cb.checked;
        onChange();
      });

      const txt = el("div", "checkLabel", `${label} (${fmtMoney(cost)})`);
      row.appendChild(cb);
      row.appendChild(txt);
      return row;
    }

    // Supplies (stocking)
    const suppliesSection = el("div", "panelSection");
    suppliesSection.appendChild(el("div", "sectionTitle", "4) Supplies (Stocking)"));

    const suppliesWrap = el("div", "servicesList");
    for (const key of Object.keys(CONFIG.supplies)) {
      const s = CONFIG.supplies[key];
      const row = el("label", "checkRow");
      const rb = document.createElement("input");
      rb.type = "radio";
      rb.name = "supplies";
      rb.checked = (draft.suppliesKey === key);
      rb.addEventListener("change", () => {
        draft.suppliesKey = key;
        updateBreakdown();
      });
      row.appendChild(rb);
      row.appendChild(el("div", "checkLabel", `${s.name} (${fmtMoney(s.cost)})`));
      suppliesWrap.appendChild(row);
    }
    suppliesSection.appendChild(suppliesWrap);
    body.appendChild(suppliesSection);

    // Staff assignment
    const staffSection = el("div", "panelSection");
    staffSection.appendChild(el("div", "sectionTitle", "5) Assign Staff (Optional)"));

    const staffPick = el("div", "staffPick");
    if (state.player.staff.length === 0) {
      staffPick.appendChild(el("div", "muted", "You have no staff. Hire from the Staff tab to improve outcomes."));
    } else {
      for (const s of state.player.staff) {
        const row = el("label", "checkRow");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = draft.assignedStaffInstanceIds.includes(s.instanceId);

        cb.addEventListener("change", () => {
          const on = cb.checked;
          if (on) {
            if (!draft.assignedStaffInstanceIds.includes(s.instanceId)) draft.assignedStaffInstanceIds.push(s.instanceId);
          } else {
            draft.assignedStaffInstanceIds = draft.assignedStaffInstanceIds.filter(id => id !== s.instanceId);
          }
          updateBreakdown();
        });

        row.appendChild(cb);
        row.appendChild(el("div", "checkLabel", `${s.name} — ${prettyRole(s.role)}`));
        staffPick.appendChild(row);
      }
    }
    staffSection.appendChild(staffPick);
    body.appendChild(staffSection);

    // Breakdown + confirm
    const breakdownSection = el("div", "panelSection");
    breakdownSection.appendChild(el("div", "sectionTitle", "6) Cost & Outcome Preview"));

    const breakdown = el("div", "breakdown");
    breakdownSection.appendChild(breakdown);

    const confirmRow = el("div", "confirmRow");
    const btnCancel = el("button", "btn", "Cancel");
    btnCancel.type = "button";
    btnCancel.addEventListener("click", closeTopModal);

    const btnDispatch = el("button", "btn primary", "Confirm & Dispatch");
    btnDispatch.type = "button";

    confirmRow.appendChild(btnCancel);
    confirmRow.appendChild(btnDispatch);

    breakdownSection.appendChild(confirmRow);
    body.appendChild(breakdownSection);

    btnDispatch.addEventListener("click", () => {
      const plan = finalizePlan();
      if (!plan) return;

      const ok = dispatchMission(plan);
      if (!ok) return;

      closeTopModal();
      setTab("missions");
      renderMarkers();
    });

    function finalizePlan() {
      const t = getTransport(draft.transportId);
      if (!t) return null;

      const distanceKm = estimateDistanceKm(origin, dest);
      const durationHours = estimateMissionDurationHours(mission, t, distanceKm, draft.routeMode, draft.routeId);
      const durationMinutes = Math.max(1, Math.round(durationHours * 60));

      const costs = calcMissionCosts(state, mission, draft, t);

      // Can't afford?
      if (state.player.money < costs.totalCost) {
        pushLog(state, `You can't afford this plan. Need ${fmtMoney(costs.totalCost)} but you have ${fmtMoney(state.player.money)}.`, "warn");
        flashAlert("Not enough money.");
        return null;
      }

      const odds = calcMissionOdds(state, mission, draft, t);

      return {
        missionId: mission.id,
        originCityId: mission.originCityId,
        destinationCityId: mission.destinationCityId,
        transportId: t.id,
        routeMode: draft.routeMode,
        routeId: draft.routeId,
        routeName: draft.routeName || (draft.routeMode === "manual" ? "Manual Route" : "Route"),
        services: deepClone(draft.services),
        suppliesKey: draft.suppliesKey,
        assignedStaffInstanceIds: deepClone(draft.assignedStaffInstanceIds),
        distanceKm,
        durationMinutes,
        costs,
        odds
      };
    }

    function updateBreakdown() {
      const t = getTransport(draft.transportId);
      if (!t) return;
      const distanceKm = estimateDistanceKm(origin, dest);
      const durationHours = estimateMissionDurationHours(mission, t, distanceKm, draft.routeMode, draft.routeId);
      const costs = calcMissionCosts(state, mission, draft, t);
      const odds = calcMissionOdds(state, mission, draft, t);

      breakdown.innerHTML = "";

      breakdown.appendChild(el("div", "breakLine", `Distance estimate: ~${Math.round(distanceKm)} km (MVP)`));
      breakdown.appendChild(el("div", "breakLine", `Estimated duration: ~${Math.round(durationHours)} in-game hours`));

      breakdown.appendChild(el("hr", "breakHr"));

      breakdown.appendChild(el("div", "breakLine", `Transport rental: ${fmtMoney(costs.rental)}`));
      breakdown.appendChild(el("div", "breakLine", `Infrastructure fees: ${fmtMoney(costs.infraFees)}`));
      breakdown.appendChild(el("div", "breakLine", `Services: ${fmtMoney(costs.services)}`));
      breakdown.appendChild(el("div", "breakLine", `Supplies: ${fmtMoney(costs.supplies)}`));

      breakdown.appendChild(el("hr", "breakHr"));

      breakdown.appendChild(el("div", "breakLine", `Total cost now: ${fmtMoney(costs.totalCost)}`));

      const estProfit = Math.round(mission.baseReward - costs.totalCost);
      const profitLine = el("div", "breakLine", `Base reward: ${fmtMoney(mission.baseReward)} • Est. profit (no modifiers): ${fmtMoney(estProfit)}`);
      profitLine.classList.add(estProfit >= 0 ? "good" : "bad");
      breakdown.appendChild(profitLine);

      breakdown.appendChild(el("hr", "breakHr"));

      breakdown.appendChild(el("div", "breakLine", `Prep score: ${Math.round(odds.prepScore)}/100`));
      breakdown.appendChild(el("div", "breakLine", `Condition score: ${Math.round(odds.conditionScore)}`));
      breakdown.appendChild(el("div", "breakLine", `Event chance: ${Math.round(odds.eventChance * 100)}%`));
      breakdown.appendChild(el("div", "breakLine", `Success chance: ${Math.round(odds.successChance * 100)}%`));

      btnDispatch.disabled = state.player.money < costs.totalCost;
      btnDispatch.textContent = btnDispatch.disabled ? "Can't Afford" : "Confirm & Dispatch";
    }

    updateBreakdown();

    openModal({
      title: "Mission Planner",
      bodyEl: body,
      footerButtons: [] // we use internal buttons
    });
  }

  function estimateDistanceKm(origin, dest) {
    if (!origin || !dest) return 120;
    const dx = (dest.x - origin.x);
    const dy = (dest.y - origin.y);
    const distUnits = Math.sqrt(dx * dx + dy * dy);
    return distUnits * CONFIG.mapUnitKm;
  }

  function estimateMissionDurationHours(mission, transport, distanceKm, routeMode, routeId) {
    // Base derived travel time
    // Higher transport.speed => faster. baseSpeedKmPerHour scales the world.
    const baseKph = CONFIG.baseSpeedKmPerHour * Math.max(0.5, transport.speed);
    let hours = distanceKm / baseKph;

    // route modifiers if known route selected
    if (routeMode !== "manual" && routeId) {
      const route = (app.data.cities?.knownRoutes || []).find(r => r.id === routeId);
      if (route?.durationModifier) hours *= route.durationModifier;
      if (routeMode === "shady") hours *= 0.95; // slightly faster, riskier
    } else if (routeMode === "manual") {
      hours *= 1.05;
    }

    // Ensure it never feels instant; clamp minimum
    // Use mission.baseDurationHours as minimum, but tutorial gets bumped to ~1–2 days.
    const minBase = mission.baseDurationHours || 6;
    hours = Math.max(hours, minBase);

    // Make tutorial mission feel like a real trip (1–2 in-game days)
    if (mission.tutorial) hours = Math.max(hours, 28); // ~1.2 days
    // Difficulty stretches time modestly
    hours *= (1 + (Math.max(0, (mission.difficulty || 1) - 1) * 0.18));

    return Math.max(1, hours);
  }

  function calcMissionCosts(state, mission, draft, transport) {
    // Rental
    const rental = transport.baseRentalCost || 0;

    // Services
    let services = 0;
    for (const k of Object.keys(draft.services || {})) {
      if (draft.services[k]) services += (CONFIG.services[k]?.cost || 0);
    }

    // Supplies
    const supplies = CONFIG.supplies[draft.suppliesKey]?.cost || 0;

    // Infra fees depend on transport type + ownership
    const origin = getCity(mission.originCityId);
    const dest = getCity(mission.destinationCityId);

    const infraFees = calcInfraFees(state, transport.id, origin, dest);

    const totalCost = rental + services + supplies + infraFees;

    return {
      rental,
      services,
      supplies,
      infraFees,
      totalCost
    };
  }

  function calcInfraFees(state, transportId, origin, dest) {
    // Determine required facility
    const feesOrigin = origin?.fees || {};
    const feesDest = dest?.fees || {};

    let requiredType = null;
    let originFee = 0;
    let destFee = 0;

    if (transportId === "ship") {
      requiredType = "dock";
      originFee = feesOrigin.dockUseFee || 0;
      destFee = feesDest.dockUseFee || 0;
    } else if (transportId === "train") {
      requiredType = "railDepot";
      originFee = feesOrigin.railUseFee || 0;
      destFee = feesDest.railUseFee || 0;
    } else if (transportId === "plane" || transportId === "dirigible") {
      // No hangar building in MVP data; treat as "airfield fee" always payable
      requiredType = "airfield";
      originFee = feesOrigin.airfieldUseFee || 0;
      destFee = feesDest.airfieldUseFee || 0;
    } else {
      // mule
      requiredType = "road";
      originFee = CONFIG.infra.originHandling;
      destFee = CONFIG.infra.destinationHandling;
    }

    // Ownership reduces fee (if building exists in that city)
    if (requiredType === "dock" || requiredType === "railDepot") {
      if (ownsFacilityInCity(state, origin?.id, requiredType)) originFee = Math.floor(originFee * 0.25);
      if (ownsFacilityInCity(state, dest?.id, requiredType)) destFee = Math.floor(destFee * 0.25);
    }

    // handling add-on (except road where it already is the fee)
    if (requiredType !== "road") {
      originFee += CONFIG.infra.originHandling;
      destFee += CONFIG.infra.destinationHandling;
    }

    return originFee + destFee;
  }

  function ownsFacilityInCity(state, cityId, facilityType) {
    if (!cityId) return false;
    for (const inst of state.player.ownedBuildings) {
      if (inst.cityId !== cityId) continue;
      const cat = getBuildingCatalog(inst.buildingId);
      if (!cat) continue;
      if (cat.type === facilityType) return true;
    }
    return false;
  }

  function calcMissionOdds(state, mission, draft, transport) {
    const origin = getCity(mission.originCityId);
    const dest = getCity(mission.destinationCityId);

    // Prep score (0..100)
    let prep = 0;

    // Transport contribution: lower baseRisk helps, higher speed helps a bit
    const transportScore = clamp(58 - (transport.baseRisk * 1.25) + (transport.speed * 4), 10, 70);
    prep += transportScore;

    // Infrastructure: small bonus if owned facilities exist
    if (transport.id === "ship") {
      if (ownsFacilityInCity(state, origin?.id, "dock")) prep += 6;
      if (ownsFacilityInCity(state, dest?.id, "dock")) prep += 6;
    }
    if (transport.id === "train") {
      if (ownsFacilityInCity(state, origin?.id, "railDepot")) prep += 6;
      if (ownsFacilityInCity(state, dest?.id, "railDepot")) prep += 6;
    }

    // Services bonuses
    for (const k of Object.keys(draft.services || {})) {
      if (draft.services[k]) prep += (CONFIG.services[k]?.bonus || 0);
    }

    // Supplies bonus
    prep += (CONFIG.supplies[draft.suppliesKey]?.bonus || 0);

    // Staff bonuses
    prep += calcStaffBonus(state, draft);

    prep = clamp(prep, 0, 100);

    // Condition score (can be negative)
    const weather = getWeatherForCity(state, mission.originCityId);
    const weatherMod = weatherModifier(weather);

    // Region risk
    const originRegion = getRegion(origin?.regionId);
    const destRegion = getRegion(dest?.regionId);

    const regionRisk = ((originRegion?.baseRisk || 10) + (destRegion?.baseRisk || 10)) / 2;

    // Route risk modifiers
    let routeRiskMod = 0;
    if (draft.routeMode !== "manual" && draft.routeId) {
      const route = (app.data.cities?.knownRoutes || []).find(r => r.id === draft.routeId);
      routeRiskMod += (route?.baseRiskModifier || 0);
      if (draft.routeMode === "shady") routeRiskMod += 8;
    } else {
      // manual is unknown, slightly riskier baseline
      routeRiskMod += 5;
    }

    // Conditions: higher region risk reduces condition
    const condition = (0 - regionRisk * 0.45) + weatherMod + (0 - routeRiskMod * 0.6);

    // Map to chance ranges
    const combined = clamp(prep + condition, 0, 100);
    const riskValue = 100 - combined;

    const eventChance = clamp(0.08 + (riskValue / 100) * 0.42, 0.08, 0.55);
    const successChance = clamp((combined / 100) * 0.92 + 0.05, 0.05, 0.95);

    return {
      prepScore: prep,
      conditionScore: condition,
      combinedScore: combined,
      riskValue,
      eventChance,
      successChance
    };
  }

  function calcStaffBonus(state, draft) {
    let bonus = 0;
    const ids = draft.assignedStaffInstanceIds || [];
    for (const id of ids) {
      const s = state.player.staff.find(x => x.instanceId === id);
      if (!s) continue;

      const sk = s.skills || {};
      bonus += (sk.logistics || 0) * 0.08;
      bonus += (sk.navigation || 0) * 0.06;
      bonus += (sk.security || 0) * 0.07;

      // Forecasting helps only if forecast service purchased
      if (draft.services?.forecast) bonus += (sk.forecasting || 0) * 0.04;

      // Trait nudges
      const traits = s.traits || [];
      if (traits.includes("Methodical")) bonus += 2;
      if (traits.includes("StrongBack")) bonus += 1.5;
      if (traits.includes("ObsessedWithClouds") && draft.services?.forecast) bonus += 2;
      if (traits.includes("ShortTemper")) bonus -= 1;
    }
    return clamp(bonus, -5, 22);
  }

  function weatherModifier(w) {
    if (w === "clear") return 0;
    if (w === "rain") return -6;
    if (w === "fog") return -8;
    if (w === "storm") return -14;
    if (w === "snow") return -10;
    return -2;
  }

  function dispatchMission(plan) {
    const state = app.state;
    const mission = getMission(plan.missionId);
    if (!mission) return false;

    // Deduct money now
    state.player.money -= plan.costs.totalCost;

    const nowM = state.world.time.totalMinutes;
    const departedAt = minutesToClock(nowM);

    const etaM = nowM + plan.durationMinutes;
    const eta = minutesToClock(etaM);

    const run = {
      runId: `run_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      missionId: plan.missionId,
      startedAtMinutes: nowM,
      departedAtMinutes: nowM,
      departedAt,
      durationMinutes: plan.durationMinutes,
      etaMinutes: etaM,
      eta,
      progressPct: 0,
      nextEventCheckAtMinutes: nowM + CONFIG.eventCheckIntervalMins,
      eventsUsed: 0,
      rewardMult: 1.0,
      cargoLossPct: 0,
      reputationDelta: 0,
      travelLog: [],
      plan: {
        transportId: plan.transportId,
        routeMode: plan.routeMode,
        routeId: plan.routeId,
        routeName: plan.routeName,
        services: plan.services,
        suppliesKey: plan.suppliesKey,
        assignedStaffInstanceIds: plan.assignedStaffInstanceIds,
        costs: plan.costs,
        odds: plan.odds,
        distanceKm: plan.distanceKm
      }
    };

    state.player.activeMissions.push(run);

    pushLog(state, `Mission dispatched: "${mission.name}" via ${getTransport(plan.transportId)?.name || plan.transportId}.`, "good");
    pushLog(state, `Departed ${getCity(mission.originCityId)?.name || "Origin"} → ${getCity(mission.destinationCityId)?.name || "Destination"} • ETA Day ${eta.day} ${pad2(eta.hour)}:${pad2(eta.minute)}.`, "info");

    // Tutorial: once dispatched tutorial mission, advance
    if (!state.tutorial.completed && mission.tutorial && state.tutorial.step <= 2) {
      state.tutorial.step = 3;
      showTutorialOverlay({
        title: "Mission Running",
        paragraphs: [
          "Great. The mission is traveling now.",
          "Check the Missions tab to see progress, and the Log tab for incidents."
        ],
        buttonLabel: "Continue",
        onNext: () => hideTutorialOverlay()
      });
    }

    flashAlert("Mission dispatched.");
    renderHUD();
    return true;
  }

  /* =========================
     ACTIVE MISSION UPDATES
  ========================== */
  function updateActiveMissions(state) {
    const nowM = state.world.time.totalMinutes;

    // iterate backwards so we can remove completed
    for (let i = state.player.activeMissions.length - 1; i >= 0; i--) {
      const run = state.player.activeMissions[i];
      const mission = getMission(run.missionId);
      if (!mission) continue;

      const elapsed = nowM - run.startedAtMinutes;
      run.progressPct = clamp((elapsed / run.durationMinutes) * 100, 0, 100);

      // Check for travel events periodically
      if (run.eventsUsed < CONFIG.maxEventsPerMission && nowM >= run.nextEventCheckAtMinutes && run.progressPct < 98) {
        run.nextEventCheckAtMinutes += CONFIG.eventCheckIntervalMins;
        maybeTriggerTravelEvent(state, run, mission);
      }

      // Complete mission
      if (elapsed >= run.durationMinutes) {
        completeMissionRun(state, run, mission);
        state.player.activeMissions.splice(i, 1);
      }
    }
  }

  function maybeTriggerTravelEvent(state, run, mission) {
    const odds = run.plan?.odds || calcMissionOdds(state, mission, run.plan, getTransport(run.plan.transportId));
    const chance = odds.eventChance || 0.15;

    if (Math.random() > chance) return;

    // Filter events by risk range
    const riskValue = odds.riskValue ?? 50;
    const all = app.data.events?.events || [];
    const candidates = all.filter(e => {
      const minR = e.minRisk ?? 0;
      const maxR = e.maxRisk ?? 100;
      return riskValue >= minR && riskValue <= maxR;
    });

    if (candidates.length === 0) return;

    const picked = pickWeighted(candidates, e => e.weight ?? 1);
    if (!picked) return;

    applyTravelEvent(state, run, mission, picked);
    run.eventsUsed += 1;
  }

  function applyTravelEvent(state, run, mission, eventDef) {
    // Log + apply modifiers
    if (eventDef.logText) {
      pushLog(state, `En route: ${eventDef.logText}`, "warn");
      run.travelLog.push(`• ${eventDef.logText}`);
    }

    const mods = eventDef.modifiers || {};

    // Duration multiplier affects remaining travel time (so it feels meaningful mid-run)
    if (typeof mods.durationMult === "number" && mods.durationMult !== 1) {
      const nowM = state.world.time.totalMinutes;
      const elapsed = nowM - run.startedAtMinutes;
      const remaining = Math.max(0, run.durationMinutes - elapsed);
      const newRemaining = Math.round(remaining * mods.durationMult);
      run.durationMinutes = elapsed + newRemaining;

      run.etaMinutes = run.startedAtMinutes + run.durationMinutes;
      run.eta = minutesToClock(run.etaMinutes);
    }

    // Reward multiplier stacks
    if (typeof mods.rewardMult === "number" && mods.rewardMult !== 1) {
      run.rewardMult *= mods.rewardMult;
      run.rewardMult = clamp(run.rewardMult, 0.2, 2.0);
    }

    // Cargo loss stacks
    if (typeof mods.cargoLossPct === "number") {
      run.cargoLossPct = clamp(run.cargoLossPct + mods.cargoLossPct, 0, 95);
    }

    // Reputation
    if (typeof mods.reputationDelta === "number") {
      run.reputationDelta += mods.reputationDelta;
    }

    // If faction event, note faction
    if (eventDef.factionId) {
      const f = getFaction(eventDef.factionId);
      if (f) {
        run.travelLog.push(`  (Faction involved: ${f.name})`);
      }
    }

    if (eventDef.outcomeText) {
      pushLog(state, eventDef.outcomeText, "info");
      run.travelLog.push(`  ${eventDef.outcomeText}`);
    }
  }

  function completeMissionRun(state, run, mission) {
    // Final success/fail roll based on odds
    const odds = run.plan?.odds || { successChance: 0.75 };
    const successRoll = Math.random();
    const success = successRoll <= (odds.successChance || 0.75);

    // Deadline check (late penalty)
    const deadlineMinutes = (mission.deadlineHours || 24) * 60;
    const actualDuration = run.durationMinutes;
    const late = actualDuration > deadlineMinutes;

    let deliveryFactor = 1.0;
    let kind = "good";

    if (!success) {
      // Failure: some salvage possible
      deliveryFactor = 0.18;
      kind = "bad";
    } else if (late) {
      deliveryFactor = 0.82;
      kind = "warn";
    }

    // Apply cargo loss
    const cargoFactor = 1 - (run.cargoLossPct / 100);

    const base = mission.baseReward || 0;
    const payout = Math.max(0, Math.round(base * run.rewardMult * deliveryFactor * cargoFactor));

    state.player.money += payout;

    // Rep bookkeeping (per destination)
    const destId = mission.destinationCityId;
    if (!state.player.reputationByCity[destId]) state.player.reputationByCity[destId] = 0;
    state.player.reputationByCity[destId] += run.reputationDelta;

    // Mark completed once (for tutorial purposes)
    state.player.completedMissions[mission.id] = true;

    // Report
    const originName = getCity(mission.originCityId)?.name || "Origin";
    const destName = getCity(mission.destinationCityId)?.name || "Destination";
    const transportName = getTransport(run.plan.transportId)?.name || run.plan.transportId;

    let report = `Mission complete: "${mission.name}" (${originName} → ${destName})\n`;
    report += `Transport: ${transportName}\n`;
    report += `Outcome: ${success ? (late ? "Delivered (Late)" : "Delivered") : "Failed"}\n`;
    if (run.cargoLossPct > 0) report += `Cargo loss: ${run.cargoLossPct}%\n`;
    report += `Payout: ${fmtMoney(payout)} (base ${fmtMoney(base)})\n`;
    report += `Net (rough): ${fmtMoney(payout - (run.plan?.costs?.totalCost || 0))}\n`;

    pushLog(state, report, kind);

    // Tutorial completion on first mission
    if (!state.tutorial.completed && mission.tutorial) {
      state.tutorial.step = 4;
      state.tutorial.completed = true;

      showTutorialOverlay({
        title: "Nice Work",
        paragraphs: [
          `You completed your first contract and earned ${fmtMoney(payout)}.`,
          "Now you can keep running contracts, hire staff, and fund local investments.",
          "In later phases, you'll build docks, rail depots, weather stations, and expand to other cities."
        ],
        buttonLabel: "Finish",
        onNext: () => hideTutorialOverlay()
      });
    }

    flashAlert(success ? "Mission completed!" : "Mission failed.");
    renderHUD();
    renderMarkers();
  }

  /* =========================
     INVESTMENTS MATURITY
  ========================== */
  function updateInvestments(state) {
    const nowM = state.world.time.totalMinutes;

    for (let i = state.player.investments.length - 1; i >= 0; i--) {
      const inst = state.player.investments[i];
      if (nowM < inst.maturesAtMinutes) continue;

      const inv = getInvestment(inst.invId);
      if (!inv) {
        state.player.investments.splice(i, 1);
        continue;
      }

      // Risk roll: higher risk increases chance of partial loss
      const risk = clamp(inv.risk || 0, 0, 100);
      const failChance = clamp((risk / 100) * 0.55, 0.02, 0.55);
      const roll = Math.random();

      let payout = 0;
      let kind = "good";

      if (roll < failChance) {
        // partial return
        payout = Math.round(inv.totalReturn * 0.35);
        kind = "warn";
        pushLog(state, `Investment matured (trouble): ${inv.name} returned only ${fmtMoney(payout)}.`, kind);
      } else {
        payout = Math.round(inv.totalReturn);
        pushLog(state, `Investment matured: ${inv.name} paid ${fmtMoney(payout)}.`, kind);
      }

      state.player.money += payout;
      state.player.investments.splice(i, 1);
      flashAlert("Investment payout!");
      renderHUD();
    }
  }

  /* =========================
     TUTORIAL FLOW
  ========================== */
  function maybeStartTutorial() {
    const state = app.state;
    if (!CONFIG.tutorial.enabled) return;
    if (state.tutorial.completed) return;

    // Start at step 0
    if (state.tutorial.step === 0) {
      showTutorialOverlay({
        title: "An Inheritance",
        paragraphs: [
          "Your uncle left you 500 crowns and a tiny warehouse HQ in Dockford.",
          "A friend whispers about a low-risk starter contract: a pig-dung delivery to Farmville.",
          "Let’s plan your first mission."
        ],
        buttonLabel: "Start",
        onNext: () => {
          hideTutorialOverlay();
          state.tutorial.step = 1;
          setTab("missions");
          pushLog(state, "Tutorial: Open the mission list and select “Stink of Opportunity.”", "good");
          renderMissionsTab();
        }
      });
    }
  }

  function maybeAdvanceTutorialFromState() {
    const state = app.state;
    if (state.tutorial.completed) return;

    // Step 1: waiting for player to open planner (handled in openMissionPlanner)
    // Step 2: waiting for dispatch (handled in dispatchMission)
    // Step 3: waiting for completion (handled in completeMissionRun)
  }
