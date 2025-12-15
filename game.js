/* ============================================================================
Fleet Baron (Working Title: Fleet Baron / Fleet Baron Demo)
File: /game.js
Stack: Vanilla JS (no dependencies)
-------------------------------------------------------------------------------
This JS expects your project structure (per bible):

/index.html
/style.css
/game.js   <-- this file
/data/
  cities.json
  missions.json
  transport.json
  buildings.json
  staff.json
  factions.json
  events.json
  investments.json
/assets/
  map.png
  town.png
  icons/*.png

IMPORTANT RULE (per your bible):
- All game content is loaded from JSON. This JS does NOT hardcode any game content.
- If required JSON is missing or malformed, the game will show a blocking error with
  instructions in the Log panel.

This file builds a functional MVP demo:
- World map + Town map toggle
- Clickable cities (from cities.json)
- Missions panel with tutorial pig-dung mission flow (missions.json)
- Mission Planner (transport choice; mule affordable; others visible)
- Mission timer loop + in-transit events + resolution engine
- Weather model + pay-for-forecast service (if services are defined in buildings.json)
- Basic staff hiring + assignment affecting mission outcome (staff.json)
- Investments panel with 1–2 starter opportunities (investments.json)
- Save/Load/Reset via localStorage

You will paste this into GitHub as /game.js.
============================================================================ */

(() => {
  "use strict";

  /* ==============================
   *  CONFIG
   * ============================== */

  const APP = {
    title: "Fleet Baron",
    version: "0.1.0-demo",
    storageKey: "fleet_baron_save_v0_1_0",
    tickMs: 250,

    // Time Model (per bible): 1 real second ≈ 10 in-game minutes (tuneable).
    // This means: 1 real second = 10 game minutes = 10 * 60 = 600 game seconds.
    // We'll store time as totalGameMinutes for simplicity.
    realSecondToGameMinutes: 10,

    // Missions: baseDurationHours (game hours). Convert to game minutes for end time.
    // Base: 1 game hour = 60 minutes (game minutes).
    minutesPerHour: 60,

    // If you want slightly longer/shorter demo, adjust this multiplier:
    timeRateMultiplier: 1.0,

    // UI / Layout defaults (only used if index.html is missing expected nodes)
    defaultMapImage: "./assets/map.png",
    defaultTownImage: "./assets/town.png",

    // MVP: Required data files
    dataFiles: [
      "cities.json",
      "missions.json",
      "transport.json",
      "buildings.json",
      "staff.json",
      "factions.json",
      "events.json",
      "investments.json",
    ],

    // MVP: Transport → required facility type (for fees/bonuses)
    transportFacilityTypeMap: {
      mule: null,
      train: "railDepot",
      ship: "dock",
      plane: "airfield",
      dirigible: "hangar",
    },

    // Safety
    maxLogEntries: 300,

    // Tutorial mission ID (must exist in missions.json)
    tutorialMissionId: "mission_pigdung_001",

    // Starter HQ city ID (must exist in cities.json)
    starterCityId: "city_dockford",

    // Basic bankruptcy threshold (per bible)
    bankruptcyMoneyThreshold: 100,
  };

  /* ==============================
   *  UTILITIES
   * ============================== */

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  function safeJsonParse(str) {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  function uid(prefix = "id") {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  }

  function fmtMoney(n) {
    const v = Math.round(Number(n) || 0);
    return `${v} c`;
  }

  function fmtPct(n) {
    const v = Math.round((Number(n) || 0) * 100);
    return `${v}%`;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = String(v);
      else if (k === "text") node.textContent = String(v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, String(v));
    }
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child == null) continue;
      if (typeof child === "string") node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function nowMs() {
    return Date.now();
  }

  function rand01() {
    return Math.random();
  }

  function pickOne(arr) {
    if (!arr || !arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // Weighted pick: [{item, w}, ...]
  function pickWeighted(weighted) {
    const items = (weighted || []).filter(x => x && Number(x.w) > 0);
    if (!items.length) return null;
    const total = items.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total;
    for (const x of items) {
      r -= x.w;
      if (r <= 0) return x.item;
    }
    return items[items.length - 1].item;
  }

  /* ==============================
   *  DATA LOADING + INDEXES
   * ============================== */

  const Data = {
    cities: [],
    missions: [],
    transport: [],
    buildings: [],
    staff: [],
    factions: [],
    events: [],
    investments: [],

    // Indexes
    cityById: new Map(),
    missionById: new Map(),
    transportById: new Map(),
    buildingById: new Map(),
    staffById: new Map(),
    factionById: new Map(),
    eventById: new Map(),
    investmentById: new Map(),

    // Optional global service definitions (recommended):
    // buildings.json may include:
    // { "services": [ { "id":"svc_weather_forecast", "name":"Weather Forecast", "cost":50, "bonuses":{...}, "tags":["weather"] }, ... ] }
    services: [],
    serviceById: new Map(),

    // Optional known routes:
    // cities.json may include: routes: [{id, fromCityId, toCityId, riskModifier, distanceModifier, tags:[...]}]
    routes: [],
    routesByKey: new Map(), // key: from|to
  };

  async function fetchJson(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
    return await res.json();
  }

  function buildIndexes() {
    Data.cityById.clear();
    Data.missionById.clear();
    Data.transportById.clear();
    Data.buildingById.clear();
    Data.staffById.clear();
    Data.factionById.clear();
    Data.eventById.clear();
    Data.investmentById.clear();
    Data.serviceById.clear();
    Data.routesByKey.clear();

    for (const c of Data.cities) Data.cityById.set(c.id, c);
    for (const m of Data.missions) Data.missionById.set(m.id, m);
    for (const t of Data.transport) Data.transportById.set(t.id, t);
    for (const b of Data.buildings) Data.buildingById.set(b.id, b);
    for (const s of Data.staff) Data.staffById.set(s.id, s);
    for (const f of Data.factions) Data.factionById.set(f.id, f);
    for (const e of Data.events) Data.eventById.set(e.id, e);
    for (const inv of Data.investments) Data.investmentById.set(inv.id, inv);

    // Services: prefer buildings.json top-level "services" array if present
    Data.services = [];
    Data.serviceById.clear();
    if (Array.isArray(Data.buildings?.services)) {
      Data.services = Data.buildings.services;
    } else if (Array.isArray(Data.buildings) && Data.buildings.some(x => x && x.type === "service")) {
      Data.services = Data.buildings.filter(x => x && x.type === "service");
    }
    for (const svc of Data.services) Data.serviceById.set(svc.id, svc);

    // Routes: prefer cities.json top-level "routes" array if present
    Data.routes = [];
    if (Array.isArray(Data.cities?.routes)) {
      Data.routes = Data.cities.routes;
    } else if (Array.isArray(Data.cities) && Data.cities.some(x => Array.isArray(x.routes))) {
      // alternate schema: city.routes (not recommended)
      const all = [];
      for (const c of Data.cities) {
        for (const r of (c.routes || [])) all.push(r);
      }
      Data.routes = all;
    }
    for (const r of Data.routes) {
      if (!r || !r.fromCityId || !r.toCityId) continue;
      Data.routesByKey.set(`${r.fromCityId}|${r.toCityId}`, r);
      Data.routesByKey.set(`${r.toCityId}|${r.fromCityId}`, { ...r, fromCityId: r.toCityId, toCityId: r.fromCityId });
    }
  }

  function validateDataOrThrow() {
    const errs = [];

    const mustArray = (name, val) => {
      if (!Array.isArray(val)) errs.push(`${name} must be an array.`);
    };

    mustArray("cities.json", Data.cities);
    mustArray("missions.json", Data.missions);
    mustArray("transport.json", Data.transport);
    // buildings.json can be either array OR { buildings: [...], services:[...] }, so normalize:
    if (!(Array.isArray(Data.buildings) || (Data.buildings && Array.isArray(Data.buildings.buildings)))) {
      errs.push("buildings.json must be an array OR an object containing { buildings: [...] }.");
    }
    mustArray("staff.json", Data.staff);
    mustArray("factions.json", Data.factions);
    mustArray("events.json", Data.events);
    mustArray("investments.json", Data.investments);

    // Normalize buildings if object form
    if (Data.buildings && !Array.isArray(Data.buildings) && Array.isArray(Data.buildings.buildings)) {
      const obj = Data.buildings;
      // preserve optional services as top-level
      const arr = obj.buildings;
      // attach services onto array so buildIndexes can read either
      arr.services = obj.services || [];
      Data.buildings = arr;
    }

    // Basic ID checks
    const requireIds = (arrName, arr) => {
      const seen = new Set();
      for (const x of arr || []) {
        if (!x || !x.id) errs.push(`${arrName} has an item missing "id".`);
        else {
          if (seen.has(x.id)) errs.push(`${arrName} has duplicate id: ${x.id}`);
          seen.add(x.id);
        }
      }
    };

    requireIds("cities.json", Data.cities);
    requireIds("missions.json", Data.missions);
    requireIds("transport.json", Data.transport);
    requireIds("buildings.json", Data.buildings);
    requireIds("staff.json", Data.staff);
    requireIds("factions.json", Data.factions);
    requireIds("events.json", Data.events);
    requireIds("investments.json", Data.investments);

    // Must contain starter city and tutorial mission
    if (!Data.cities.some(c => c.id === APP.starterCityId)) {
      errs.push(`Missing starter city id "${APP.starterCityId}" in cities.json.`);
    }
    if (!Data.missions.some(m => m.id === APP.tutorialMissionId)) {
      errs.push(`Missing tutorial mission id "${APP.tutorialMissionId}" in missions.json.`);
    }
    if (!Data.transport.some(t => t.id === "mule")) {
      errs.push(`transport.json must include transport with id "mule" for MVP.`);
    }

    if (errs.length) throw new Error(errs.join("\n"));
  }

  async function loadAllData() {
    const base = "./data/";
    const [cities, missions, transport, buildings, staff, factions, events, investments] = await Promise.all([
      fetchJson(base + "cities.json"),
      fetchJson(base + "missions.json"),
      fetchJson(base + "transport.json"),
      fetchJson(base + "buildings.json"),
      fetchJson(base + "staff.json"),
      fetchJson(base + "factions.json"),
      fetchJson(base + "events.json"),
      fetchJson(base + "investments.json"),
    ]);

    Data.cities = cities;
    Data.missions = missions;
    Data.transport = transport;
    Data.buildings = buildings;
    Data.staff = staff;
    Data.factions = factions;
    Data.events = events;
    Data.investments = investments;

    validateDataOrThrow();
    buildIndexes();
  }

  /* ==============================
   *  UI SCHEMA (created if missing)
   * ============================== */

  const UI = {
    root: null,

    topbar: null,
    btnWorld: null,
    btnTown: null,
    btnSave: null,
    btnLoad: null,
    btnReset: null,
    title: null,
    time: null,
    weather: null,

    main: null,
    worldView: null,
    townView: null,

    worldMapImg: null,
    worldMarkers: null,

    townMapImg: null,
    townMarkers: null,

    sidebar: null,
    tabButtons: {},
    tabPanels: {},

    money: null,
    income: null,
    alerts: null,

    modalRoot: null,
    tutorialOverlay: null,
  };

  function ensureBaseUI() {
    // If index.html already provides these IDs, we reuse them.
    // Otherwise, we create a minimal SPA shell dynamically.
    const existing = qs("#appRoot");
    if (existing) {
      UI.root = existing;
    } else {
      UI.root = el("div", { id: "appRoot", class: "appRoot" });
      document.body.appendChild(UI.root);
    }

    const topbar = qs("#topBar", UI.root) || el("header", { id: "topBar", class: "topBar" });
    if (!topbar.parentNode) UI.root.appendChild(topbar);
    UI.topbar = topbar;

    UI.title = qs("#gameTitle", topbar) || el("div", { id: "gameTitle", class: "gameTitle", text: APP.title });
    if (!UI.title.parentNode) topbar.appendChild(UI.title);

    UI.btnWorld = qs("#btnWorld", topbar) || el("button", { id: "btnWorld", class: "btn", text: "World Map" });
    UI.btnTown = qs("#btnTown", topbar) || el("button", { id: "btnTown", class: "btn", text: "Town Map" });

    UI.btnSave = qs("#btnSave", topbar) || el("button", { id: "btnSave", class: "btn", text: "Save" });
    UI.btnLoad = qs("#btnLoad", topbar) || el("button", { id: "btnLoad", class: "btn", text: "Load" });
    UI.btnReset = qs("#btnReset", topbar) || el("button", { id: "btnReset", class: "btn danger", text: "Reset" });

    UI.time = qs("#timeDisplay", topbar) || el("div", { id: "timeDisplay", class: "hudItem", text: "Day 1 08:00" });
    UI.weather = qs("#weatherDisplay", topbar) || el("div", { id: "weatherDisplay", class: "hudItem", text: "Weather: —" });

    // Order in topbar
    const topKids = [UI.btnWorld, UI.btnTown, UI.btnSave, UI.btnLoad, UI.btnReset, UI.time, UI.weather];
    for (const k of topKids) if (!k.parentNode) topbar.appendChild(k);

    UI.main = qs("#mainArea", UI.root) || el("div", { id: "mainArea", class: "mainArea" });
    if (!UI.main.parentNode) UI.root.appendChild(UI.main);

    // Left: map area
    const viewWrap = qs("#viewWrap", UI.main) || el("div", { id: "viewWrap", class: "viewWrap" });
    if (!viewWrap.parentNode) UI.main.appendChild(viewWrap);

    UI.worldView = qs("#worldView", viewWrap) || el("div", { id: "worldView", class: "view worldView" });
    UI.townView = qs("#townView", viewWrap) || el("div", { id: "townView", class: "view townView" });

    if (!UI.worldView.parentNode) viewWrap.appendChild(UI.worldView);
    if (!UI.townView.parentNode) viewWrap.appendChild(UI.townView);

    // World view: image + markers overlay
    UI.worldMapImg = qs("#worldMapImage", UI.worldView) || el("img", { id: "worldMapImage", class: "mapImage", src: APP.defaultMapImage, alt: "World Map" });
    UI.worldMarkers = qs("#worldMarkers", UI.worldView) || el("div", { id: "worldMarkers", class: "markerLayer" });
    if (!UI.worldMapImg.parentNode) UI.worldView.appendChild(UI.worldMapImg);
    if (!UI.worldMarkers.parentNode) UI.worldView.appendChild(UI.worldMarkers);

    // Town view: image + markers overlay
    UI.townMapImg = qs("#townMapImage", UI.townView) || el("img", { id: "townMapImage", class: "mapImage", src: APP.defaultTownImage, alt: "Town Map" });
    UI.townMarkers = qs("#townMarkers", UI.townView) || el("div", { id: "townMarkers", class: "markerLayer" });
    if (!UI.townMapImg.parentNode) UI.townView.appendChild(UI.townMapImg);
    if (!UI.townMarkers.parentNode) UI.townView.appendChild(UI.townMarkers);

    // Right: sidebar
    UI.sidebar = qs("#sidebar", UI.main) || el("aside", { id: "sidebar", class: "sidebar" });
    if (!UI.sidebar.parentNode) UI.main.appendChild(UI.sidebar);

    const tabs = qs("#tabs", UI.sidebar) || el("div", { id: "tabs", class: "tabs" });
    if (!tabs.parentNode) UI.sidebar.appendChild(tabs);

    const panels = qs("#tabPanels", UI.sidebar) || el("div", { id: "tabPanels", class: "tabPanels" });
    if (!panels.parentNode) UI.sidebar.appendChild(panels);

    const tabDefs = [
      { id: "log", label: "Log" },
      { id: "missions", label: "Missions" },
      { id: "staff", label: "Staff" },
      { id: "investments", label: "Investments" },
    ];

    for (const t of tabDefs) {
      const btn = qs(`#tabBtn_${t.id}`, tabs) || el("button", { id: `tabBtn_${t.id}`, class: "tabBtn", text: t.label });
      const pnl = qs(`#tabPanel_${t.id}`, panels) || el("div", { id: `tabPanel_${t.id}`, class: "tabPanel" });

      if (!btn.parentNode) tabs.appendChild(btn);
      if (!pnl.parentNode) panels.appendChild(pnl);

      UI.tabButtons[t.id] = btn;
      UI.tabPanels[t.id] = pnl;
    }

    // Bottom bar
    const bottom = qs("#bottomBar", UI.root) || el("footer", { id: "bottomBar", class: "bottomBar" });
    if (!bottom.parentNode) UI.root.appendChild(bottom);

    UI.money = qs("#moneyDisplay", bottom) || el("div", { id: "moneyDisplay", class: "hudItem", text: "Money: 500 c" });
    UI.income = qs("#incomeDisplay", bottom) || el("div", { id: "incomeDisplay", class: "hudItem", text: "Income/Upkeep: —" });
    UI.alerts = qs("#alertsDisplay", bottom) || el("div", { id: "alertsDisplay", class: "hudItem alerts", text: "" });

    for (const k of [UI.money, UI.income, UI.alerts]) if (!k.parentNode) bottom.appendChild(k);

    // Modal root
    UI.modalRoot = qs("#modalRoot", UI.root) || el("div", { id: "modalRoot", class: "modalRoot" });
    if (!UI.modalRoot.parentNode) UI.root.appendChild(UI.modalRoot);

    // Tutorial overlay
    UI.tutorialOverlay = qs("#tutorialOverlay", UI.root) || el("div", { id: "tutorialOverlay", class: "tutorialOverlay hidden" });
    if (!UI.tutorialOverlay.parentNode) UI.root.appendChild(UI.tutorialOverlay);

    // Wire up buttons
    UI.btnWorld.addEventListener("click", () => setActiveView("world"));
    UI.btnTown.addEventListener("click", () => setActiveView("town"));
    UI.btnSave.addEventListener("click", () => saveGame());
    UI.btnLoad.addEventListener("click", () => loadGame());
    UI.btnReset.addEventListener("click", () => resetGame());

    for (const [tabId, btn] of Object.entries(UI.tabButtons)) {
      btn.addEventListener("click", () => setActiveTab(tabId));
    }
  }

  function setActiveView(which) {
    const w = which === "world";
    UI.worldView.style.display = w ? "block" : "none";
    UI.townView.style.display = w ? "none" : "block";
    UI.btnWorld.classList.toggle("active", w);
    UI.btnTown.classList.toggle("active", !w);
    Game.ui.activeView = which;
    renderAll();
  }

  function setActiveTab(tabId) {
    for (const [id, pnl] of Object.entries(UI.tabPanels)) {
      pnl.style.display = id === tabId ? "block" : "none";
      UI.tabButtons[id].classList.toggle("active", id === tabId);
    }
    Game.ui.activeTab = tabId;
    renderAll();
  }

  /* ==============================
   *  MODALS
   * ============================== */

  function closeModal() {
    UI.modalRoot.innerHTML = "";
    UI.modalRoot.classList.remove("open");
  }

  function openModal(title, contentNode, actions = []) {
    UI.modalRoot.innerHTML = "";
    UI.modalRoot.classList.add("open");

    const overlay = el("div", { class: "modalOverlay", onclick: (e) => { if (e.target === overlay) closeModal(); } });
    const modal = el("div", { class: "modal" });

    const header = el("div", { class: "modalHeader" }, [
      el("div", { class: "modalTitle", text: title }),
      el("button", { class: "btn small", text: "✕", onclick: () => closeModal() }),
    ]);

    const body = el("div", { class: "modalBody" }, contentNode);

    const footer = el("div", { class: "modalFooter" });
    for (const a of actions) footer.appendChild(a);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    UI.modalRoot.appendChild(overlay);

    return { overlay, modal };
  }

  /* ==============================
   *  LOGGING
   * ============================== */

  function logEntry(text, type = "info") {
    const entry = {
      id: uid("log"),
      t: Game.world.time.totalGameMinutes,
      type,
      text: String(text),
    };
    Game.ui.log.push(entry);
    if (Game.ui.log.length > APP.maxLogEntries) {
      Game.ui.log.splice(0, Game.ui.log.length - APP.maxLogEntries);
    }
    renderLog();
  }

  function timeLabelFromMinutes(totalMinutes) {
    const day = Math.floor(totalMinutes / (24 * 60)) + 1;
    const minsInDay = totalMinutes % (24 * 60);
    const hour = Math.floor(minsInDay / 60);
    const min = minsInDay % 60;
    return `Day ${day} ${pad2(hour)}:${pad2(min)}`;
  }

  /* ==============================
   *  GAME STATE
   * ============================== */

  const Game = {
    booted: false,
    dataReady: false,
    fatalError: null,

    ui: {
      activeView: "world",
      activeTab: "log",
      log: [],
      selectedCityId: null,
      selectedBuildingInstanceId: null,
      selectedMissionId: null,
    },

    // World + Player state (loaded / saved)
    player: null,
    world: null,
    tutorial: null,

    // Runtime-only
    _lastTickMs: 0,
  };

  function makeNewGameState() {
    // Note: Content NOT hardcoded. We only set starting numeric values & IDs that must exist in JSON.
    const starterCityId = APP.starterCityId;

    const s = {
      player: {
        money: 500,
        reputationByCity: {},
        hqs: [starterCityId],
        ownedBuildings: [
          // Instances, not templates:
          // { instanceId, cityId, buildingTemplateId, level, nick, staffIds:[], modules:[] }
          // For MVP: create a minimal HQ shell using a building template if provided,
          // else leave empty and Town Map will show an HQ marker regardless.
        ],
        ownedTransports: [],
        staff: [],
        activeMissions: [],
        investments: [],
      },

      world: {
        time: {
          totalGameMinutes: 0, // Day 1 00:00
        },
        weather: {
          // regionId -> { state, severity, updatedAtMinutes, forecastAccuracyBase }
          regions: {},
        },
        // bookkeeping
        discoveredCities: [starterCityId],
      },

      tutorial: {
        step: 0,
        completed: false,
        pinnedMissionId: APP.tutorialMissionId,
      },
    };

    // Start at Day 1 08:00 (per bible)
    s.world.time.totalGameMinutes = 8 * 60;

    // Reputation init
    for (const c of Data.cities) {
      s.player.reputationByCity[c.id] = 0;
    }

    // Seed initial weather for all regions that appear in cities.json
    const regionIds = new Set();
    for (const c of Data.cities) {
      if (c.regionId) regionIds.add(c.regionId);
    }
    for (const r of regionIds) {
      s.world.weather.regions[r] = {
        state: "Clear",
        severity: 0.2,
        updatedAtMinutes: s.world.time.totalGameMinutes,
        forecastAccuracyBase: 0.5,
      };
    }

    return s;
  }

  function adoptGameState(state) {
    Game.player = state.player;
    Game.world = state.world;
    Game.tutorial = state.tutorial;

    // Ensure required keys exist (forward-compat)
    Game.player.money ??= 500;
    Game.player.reputationByCity ??= {};
    Game.player.hqs ??= [APP.starterCityId];
    Game.player.ownedBuildings ??= [];
    Game.player.ownedTransports ??= [];
    Game.player.staff ??= [];
    Game.player.activeMissions ??= [];
    Game.player.investments ??= [];

    Game.world.time ??= { totalGameMinutes: 8 * 60 };
    Game.world.time.totalGameMinutes ??= 8 * 60;

    Game.world.weather ??= { regions: {} };
    Game.world.weather.regions ??= {};
    Game.world.discoveredCities ??= [APP.starterCityId];

    Game.tutorial ??= { step: 0, completed: false, pinnedMissionId: APP.tutorialMissionId };

    // If player has no HQ building instance, we still render HQ marker.
  }

  /* ==============================
   *  SAVE / LOAD
   * ============================== */

  function saveGame() {
    try {
      const payload = {
        meta: {
          title: APP.title,
          version: APP.version,
          savedAt: new Date().toISOString(),
        },
        state: {
          player: Game.player,
          world: Game.world,
          tutorial: Game.tutorial,
        },
      };
      localStorage.setItem(APP.storageKey, JSON.stringify(payload));
      logEntry("Game saved.", "good");
      flashAlert("Saved ✓");
    } catch (e) {
      logEntry(`Save failed: ${e.message}`, "bad");
      flashAlert("Save failed");
    }
  }

  function loadGame() {
    try {
      const raw = localStorage.getItem(APP.storageKey);
      if (!raw) {
        logEntry("No saved game found.", "warn");
        flashAlert("No save found");
        return;
      }
      const parsed = safeJsonParse(raw);
      if (!parsed || !parsed.state) throw new Error("Save file is corrupted.");
      adoptGameState(parsed.state);
      logEntry("Game loaded.", "good");
      flashAlert("Loaded ✓");
      renderAll();
    } catch (e) {
      logEntry(`Load failed: ${e.message}`, "bad");
      flashAlert("Load failed");
    }
  }

  function resetGame() {
    openConfirmModal(
      "Reset Game",
      "This will erase your current session (localStorage save remains until overwritten). Proceed?",
      () => {
        const fresh = makeNewGameState();
        adoptGameState(fresh);
        Game.ui.log = [];
        logEntry("New game started.", "good");
        setActiveView("world");
        setActiveTab("log");
        renderAll();
        beginTutorialIfNeeded(true);
      }
    );
  }

  function openConfirmModal(title, message, onYes) {
    const content = el("div", { class: "confirmBox" }, [
      el("p", { text: message }),
    ]);
    openModal(title, content, [
      el("button", { class: "btn", text: "Cancel", onclick: () => closeModal() }),
      el("button", { class: "btn primary", text: "Yes", onclick: () => { closeModal(); onYes(); } }),
    ]);
  }

  function flashAlert(text) {
    if (!UI.alerts) return;
    UI.alerts.textContent = text;
    UI.alerts.classList.add("flash");
    setTimeout(() => UI.alerts.classList.remove("flash"), 700);
  }

  /* ==============================
   *  WEATHER MODEL
   * ============================== */

  const WEATHER_STATES = ["Clear", "Rain", "Storm", "Fog", "Snow"];

  function updateWeatherIfDue() {
    // Simple model: each region may shift every 6 game hours.
    // This is algorithmic (allowed), not content.
    const mins = Game.world.time.totalGameMinutes;
    const dueEvery = 6 * 60;
    for (const [regionId, w] of Object.entries(Game.world.weather.regions)) {
      if (!w) continue;
      if (mins - (w.updatedAtMinutes || 0) < dueEvery) continue;

      // Drift weather state
      const roll = rand01();
      let next = w.state || "Clear";
      let sev = clamp((w.severity ?? 0.2) + (rand01() - 0.5) * 0.3, 0, 1);

      if (roll < 0.45) {
        // minor change
        next = next;
      } else if (roll < 0.75) {
        // adjacent-ish change
        if (next === "Clear") next = pickOne(["Rain", "Fog"]);
        else if (next === "Rain") next = pickOne(["Clear", "Storm", "Fog"]);
        else if (next === "Storm") next = pickOne(["Rain", "Fog"]);
        else if (next === "Fog") next = pickOne(["Clear", "Rain"]);
        else if (next === "Snow") next = pickOne(["Clear", "Fog"]);
      } else {
        // bigger shift
        next = pickOne(WEATHER_STATES);
      }

      w.state = next;
      w.severity = sev;
      w.updatedAtMinutes = mins;
    }
  }

  function getCityWeather(cityId) {
    const city = Data.cityById.get(cityId);
    if (!city) return { state: "Clear", severity: 0.2 };
    const regionId = city.regionId || "region_unknown";
    const w = Game.world.weather.regions[regionId] || { state: "Clear", severity: 0.2 };
    return { state: w.state || "Clear", severity: w.severity ?? 0.2 };
  }

  function weatherModifierForTransport(state, severity, transportId) {
    // Returns a conditionScore modifier (- to +). Algorithmic.
    const t = transportId;
    const sev = clamp(severity ?? 0.2, 0, 1);
    const base = (s) => {
      if (s === "Clear") return 5 * (1 - sev);
      if (s === "Rain") return -10 * sev;
      if (s === "Storm") return -25 * sev;
      if (s === "Fog") return -15 * sev;
      if (s === "Snow") return -20 * sev;
      return 0;
    };
    let m = base(state);

    // Transport sensitivity
    if (t === "mule") m *= 1.0;
    else if (t === "train") m *= 0.8;
    else if (t === "ship") m *= 0.9;
    else if (t === "plane") m *= 1.2;
    else if (t === "dirigible") m *= 1.3;

    return Math.round(m);
  }

  /* ==============================
   *  MISSIONS + RESOLUTION ENGINE
   * ============================== */

  function cityDistance(aId, bId) {
    const a = Data.cityById.get(aId);
    const b = Data.cityById.get(bId);
    if (!a || !b) return 1;

    // Recommended schema in cities.json:
    // mapX/mapY as 0..100 percentages (or 0..1). We handle both.
    const ax = Number(a.mapX ?? a.x ?? 0.5);
    const ay = Number(a.mapY ?? a.y ?? 0.5);
    const bx = Number(b.mapX ?? b.x ?? 0.5);
    const by = Number(b.mapY ?? b.y ?? 0.5);

    const norm = (v) => (v > 1 ? v / 100 : v);
    const x1 = norm(ax), y1 = norm(ay), x2 = norm(bx), y2 = norm(by);

    const dx = x2 - x1;
    const dy = y2 - y1;
    const d = Math.sqrt(dx * dx + dy * dy);

    // Convert into a convenient "distance units"
    return d; // 0..~1.5 depending on layout
  }

  function getKnownRoute(fromId, toId) {
    return Data.routesByKey.get(`${fromId}|${toId}`) || null;
  }

  function computeDurationHours(mission, transport) {
    // Mission baseDurationHours is baseline for the mission
    // We then adjust by transport speed (relative).
    const base = Number(mission.baseDurationHours || 8);
    const speed = Math.max(0.1, Number(transport.speed || 1));
    // Faster speed => shorter time
    const adjusted = base / speed;

    // Slight distance influence (keeps demo flexible)
    const d = cityDistance(mission.originCityId, mission.destinationCityId);
    // Reference distance around 0.35 (tune based on your city coordinates)
    const ref = 0.35;
    const distFactor = clamp(d / ref, 0.7, 1.7);

    return adjusted * distFactor;
  }

  function computeBaseCosts(mission, transportId, routeMode, selectedServiceIds, assignedStaffIds) {
    const transport = Data.transportById.get(transportId);
    if (!transport) return { ok: false, reason: "Unknown transport." };

    const rental = Number(transport.baseRentalCost || 0);

    // Facility fees: if transport requires dock/rail/airfield/hangar
    const facilityType = APP.transportFacilityTypeMap[transportId] || null;
    const originFee = facilityType ? computeFacilityFee(mission.originCityId, facilityType) : 0;
    const destFee = facilityType ? computeFacilityFee(mission.destinationCityId, facilityType) : 0;

    // Route fees (optional)
    let routeFee = 0;
    let routeRiskMod = 0;

    if (routeMode === "known") {
      const r = getKnownRoute(mission.originCityId, mission.destinationCityId);
      if (r) {
        routeFee += Number(r.fee || 0);
        routeRiskMod += Number(r.riskModifier || 0);
      }
    } else if (routeMode === "manual") {
      // Manual route is slightly riskier in MVP (algorithmic)
      routeRiskMod += 5;
    } else if (routeMode === "shady") {
      // Shady route: cheaper but riskier (algorithmic)
      routeFee -= Math.round(rental * 0.15);
      routeRiskMod += 12;
    }

    // Services: loaded from JSON (buildings.json services array recommended)
    let servicesCost = 0;
    let servicesBonus = 0;
    const serviceBreakdown = [];
    for (const svcId of (selectedServiceIds || [])) {
      const svc = Data.serviceById.get(svcId);
      if (!svc) continue;
      const cost = Number(svc.cost || 0);
      servicesCost += cost;
      const bonus = Number(svc.prepBonus || (svc.bonuses?.prepScore || 0) || 0);
      servicesBonus += bonus;
      serviceBreakdown.push({ id: svcId, name: svc.name || svcId, cost, bonus });
    }

    // Staff: modest prep bonus from skills/role match (algorithmic)
    const staffBonus = computeStaffPrepBonus(assignedStaffIds, transportId);

    const total = Math.max(0, rental + originFee + destFee + routeFee + servicesCost);

    return {
      ok: true,
      rental,
      originFee,
      destFee,
      routeFee,
      servicesCost,
      servicesBonus,
      serviceBreakdown,
      staffBonus,
      routeRiskMod,
      total,
    };
  }

  function computeFacilityFee(cityId, facilityType) {
    // If player owns a facility in that city of given type, fee = 0 (owned).
    // Else, lease fee is determined by matching building templates (buildings.json)
    // Recommended building schema: { id, type, name, leaseFeePerUse, reliability, ... }
    const owned = findPlayerBuildingByCityAndType(cityId, facilityType);
    if (owned) return 0;

    const template = findBuildingTemplateByType(facilityType);
    if (!template) {
      // If template missing, we can't compute lease fee safely.
      // Return a conservative default lease (algorithmic, not content-specific).
      return 100;
    }
    const fee = Number(template.leaseFeePerUse ?? template.leaseFee ?? 100);
    return Math.max(0, fee);
  }

  function findBuildingTemplateByType(type) {
    return (Data.buildings || []).find(b => b && b.type === type) || null;
  }

  function findPlayerBuildingByCityAndType(cityId, type) {
    for (const inst of Game.player.ownedBuildings) {
      const tpl = Data.buildingById.get(inst.buildingTemplateId);
      if (!tpl) continue;
      if (inst.cityId === cityId && tpl.type === type) return inst;
    }
    return null;
  }

  function computeFacilityBonus(cityId, facilityType) {
    // Owned facility → bonus from reliability * level.
    const owned = findPlayerBuildingByCityAndType(cityId, facilityType);
    if (!owned) return 0;

    const tpl = Data.buildingById.get(owned.buildingTemplateId);
    if (!tpl) return 0;

    const rel = clamp(Number(tpl.reliability || 60) / 100, 0, 1);
    const lvl = Math.max(1, Number(owned.level || tpl.level || 1));
    // Bonus scale
    return Math.round(rel * 10 + (lvl - 1) * 3);
  }

  function computeStaffPrepBonus(staffIds, transportId) {
    let bonus = 0;
    const ids = (staffIds || []).filter(Boolean);
    for (const sid of ids) {
      const st = Game.player.staff.find(x => x.id === sid);
      if (!st) continue;

      const skills = st.skills || {};
      // Relevant skills by transport
      let relevant = 0;
      if (transportId === "mule") relevant = (skills.logistics || 0) * 0.12 + (skills.navigation || 0) * 0.08;
      else if (transportId === "train") relevant = (skills.logistics || 0) * 0.12 + (skills.leadership || 0) * 0.06;
      else if (transportId === "ship") relevant = (skills.navigation || 0) * 0.12 + (skills.leadership || 0) * 0.06;
      else if (transportId === "plane") relevant = (skills.navigation || 0) * 0.15 + (skills.forecasting || 0) * 0.05;
      else if (transportId === "dirigible") relevant = (skills.navigation || 0) * 0.16 + (skills.forecasting || 0) * 0.06;

      // Traits can add small bonus (algorithmic)
      const traits = st.traits || [];
      if (traits.includes("Reliable")) relevant += 2.5;
      if (traits.includes("Reckless")) relevant -= 2.5;
      if (traits.includes("Insightful")) relevant += 1.5;

      bonus += relevant;
    }
    return Math.round(bonus);
  }

  function mapRiskToEventChance(riskValue) {
    // riskValue: 0..100 (higher = more risky)
    // Map to chance: 5%..55%
    const t = clamp(riskValue / 100, 0, 1);
    return lerp(0.05, 0.55, t);
  }

  function computeFactionRiskModifier(mission) {
    // If factions have territories/regions including the route's region(s),
    // contribute risk based on strength and attitude.
    // Recommended factions schema: { territories:[regionId,...], strength, attitudeTowardsPlayer }
    const origin = Data.cityById.get(mission.originCityId);
    const dest = Data.cityById.get(mission.destinationCityId);
    const regionIds = new Set();
    if (origin?.regionId) regionIds.add(origin.regionId);
    if (dest?.regionId) regionIds.add(dest.regionId);

    // If mission explicitly includes regions: mission.regionIds or mission.routeRegionIds
    for (const rid of (mission.regionIds || mission.routeRegionIds || [])) regionIds.add(rid);

    let mod = 0;
    for (const f of Data.factions) {
      if (!f || !Array.isArray(f.territories)) continue;
      const overlap = f.territories.some(r => regionIds.has(r));
      if (!overlap) continue;

      const strength = clamp(Number(f.strength || 0), 0, 100);
      const attitude = clamp(Number(f.attitudeTowardsPlayer || 0), -100, 100);

      // Hostile factions increase risk; friendly reduce slightly.
      const hostility = clamp((-attitude) / 100, 0, 1);
      mod += Math.round((strength / 100) * 18 * hostility);
      if (attitude > 30) mod -= 2;
    }
    return clamp(mod, -10, 25);
  }

  function selectRandomEventForMission(missionCtx) {
    // missionCtx: { categoryHint, weatherState, transportId, riskValue, regionIds:Set, factionIds:Set }
    // events.json recommended schema:
    // {
    //   id, name, category, weight,
    //   tags: ["weather","bandits"], minRisk, maxRisk,
    //   allowedTransportTypes: ["mule"...],
    //   allowedWeatherStates: ["Rain","Storm"],
    //   regionIds: ["region_..."], factionIds: ["faction_..."],
    //   effects: { cargoLossPct, delayMinutes, bonusMoney, repDelta, prepDelta },
    //   narrative: "Short text"
    // }
    const events = Data.events || [];
    const regionIds = missionCtx.regionIds || new Set();
    const risk = Number(missionCtx.riskValue || 0);
    const weatherState = missionCtx.weatherState || "Clear";
    const tId = missionCtx.transportId;

    const candidates = [];
    for (const e of events) {
      if (!e) continue;

      const minRisk = Number(e.minRisk ?? 0);
      const maxRisk = Number(e.maxRisk ?? 100);
      if (risk < minRisk || risk > maxRisk) continue;

      if (Array.isArray(e.allowedTransportTypes) && !e.allowedTransportTypes.includes(tId)) continue;
      if (Array.isArray(e.allowedWeatherStates) && !e.allowedWeatherStates.includes(weatherState)) continue;

      if (Array.isArray(e.regionIds) && e.regionIds.length) {
        const ok = e.regionIds.some(r => regionIds.has(r));
        if (!ok) continue;
      }

      // Simple category bias (optional)
      const cat = e.category || "generic";
      if (missionCtx.categoryHint && cat !== missionCtx.categoryHint) {
        // still allowed, but less weight
      }

      let w = Number(e.weight || 1);
      if (missionCtx.categoryHint && cat === missionCtx.categoryHint) w *= 1.8;

      candidates.push({ item: e, w });
    }

    return pickWeighted(candidates);
  }

  function resolveMission(activeMission) {
    // activeMission stores planning choices and accumulates events.
    const mission = Data.missionById.get(activeMission.missionId);
    const transport = Data.transportById.get(activeMission.transportId);
    if (!mission || !transport) {
      return {
        status: "failed",
        deliveryFactor: 0,
        cargoLossPct: 1,
        moneyDelta: 0,
        report: "Mission data missing; mission automatically failed.",
        repDeltas: [],
      };
    }

    // Prep Score
    const baseTransportScore = clamp(100 - Number(transport.baseRisk || 10), 0, 100);
    const facilityType = APP.transportFacilityTypeMap[activeMission.transportId] || null;

    const originFacilityBonus = facilityType ? computeFacilityBonus(mission.originCityId, facilityType) : 0;
    const destinationFacilityBonus = facilityType ? computeFacilityBonus(mission.destinationCityId, facilityType) : 0;

    const servicesBonus = Number(activeMission.servicesBonus || 0);
    const staffBonus = Number(activeMission.staffBonus || 0);

    const prepScore = clamp(
      Math.round(baseTransportScore * 0.35 + originFacilityBonus + destinationFacilityBonus + servicesBonus + staffBonus),
      0,
      100
    );

    // Condition Score
    const wOrigin = getCityWeather(mission.originCityId);
    const wDest = getCityWeather(mission.destinationCityId);
    const wMod = weatherModifierForTransport(wOrigin.state, wOrigin.severity, activeMission.transportId)
              + weatherModifierForTransport(wDest.state, wDest.severity, activeMission.transportId);
    const factionRisk = computeFactionRiskModifier(mission);
    const routeRiskMod = Number(activeMission.routeRiskMod || 0);

    const conditionScore = clamp(Math.round(wMod - factionRisk - routeRiskMod), -50, 30);

    const combined = clamp(prepScore + conditionScore, 0, 100);
    const riskValue = 100 - combined;

    // Random roll decides outcome bracket
    const roll = rand01();
    // Convert riskValue into a failure pressure
    const failPressure = clamp(riskValue / 100, 0, 1);

    // Base factors
    let status = "success";
    let deliveryFactor = 1.0;
    let cargoLossPct = 0.0;
    let delayMinutes = 0;

    // Apply in-transit events effects accumulated during mission
    const events = activeMission.eventsEncountered || [];
    let eventMoneyDelta = 0;
    let eventRepDelta = 0;

    for (const ev of events) {
      const effects = ev.effects || {};
      cargoLossPct = clamp(cargoLossPct + (Number(effects.cargoLossPct || 0) / 100), 0, 1);
      delayMinutes += Number(effects.delayMinutes || 0);
      eventMoneyDelta += Number(effects.bonusMoney || 0);
      eventRepDelta += Number(effects.repDelta || 0);
    }

    // Outcome thresholds (algorithmic)
    // Higher failPressure => more likely failure/partial/delay
    const failChance = lerp(0.03, 0.35, failPressure);
    const partialChance = lerp(0.10, 0.40, failPressure);
    const delayChance = lerp(0.20, 0.50, failPressure);

    if (roll < failChance) {
      status = "failed";
      deliveryFactor = 0.0;
      cargoLossPct = clamp(Math.max(cargoLossPct, 0.7), 0, 1);
    } else if (roll < failChance + partialChance) {
      status = "partial";
      deliveryFactor = lerp(0.35, 0.75, 1 - failPressure);
      cargoLossPct = clamp(Math.max(cargoLossPct, lerp(0.15, 0.55, failPressure)), 0, 1);
    } else if (roll < failChance + partialChance + delayChance) {
      status = "delayed";
      deliveryFactor = lerp(0.75, 0.95, 1 - failPressure);
      delayMinutes += Math.round(lerp(60, 360, failPressure));
      cargoLossPct = clamp(cargoLossPct + lerp(0.0, 0.15, failPressure), 0, 1);
    } else {
      status = "success";
      deliveryFactor = 1.0 - clamp(cargoLossPct * 0.2, 0, 0.2);
    }

    // Deadline penalty
    const deadlineHours = Number(mission.deadlineHours || 0);
    if (deadlineHours > 0) {
      const plannedMinutes = activeMission.plannedDurationMinutes || Math.round(Number(mission.baseDurationHours || 8) * 60);
      const totalMinutes = plannedMinutes + delayMinutes;
      if (totalMinutes > deadlineHours * 60) {
        const lateFactor = clamp(1 - ((totalMinutes - deadlineHours * 60) / (deadlineHours * 60)) * 0.5, 0.5, 1);
        deliveryFactor *= lateFactor;
        if (status === "success") status = "delayed";
      }
    }

    // Final payment
    const baseReward = Number(mission.baseReward ?? mission.cargo?.baseValue ?? 0);
    const gross = Math.round(baseReward * deliveryFactor);
    const net = gross + eventMoneyDelta;

    // Reputation
    const repDeltas = [];
    const repChange = Math.round(lerp(2, 8, deliveryFactor) + eventRepDelta);
    repDeltas.push({ cityId: mission.destinationCityId, delta: repChange });

    // Staff XP
    awardStaffExperience(activeMission.assignedStaffIds || [], status);

    // Build report string
    const reportLines = [];
    reportLines.push(`${mission.name} — ${status.toUpperCase()}`);
    reportLines.push(`Prep Score: ${prepScore}/100`);
    reportLines.push(`Condition Score: ${conditionScore}`);
    reportLines.push(`Risk Value: ${riskValue}/100`);
    if (delayMinutes > 0) reportLines.push(`Delay: ${Math.round(delayMinutes)} minutes`);
    if (cargoLossPct > 0) reportLines.push(`Cargo loss: ${Math.round(cargoLossPct * 100)}%`);
    if (events.length) reportLines.push(`Events: ${events.map(e => e.name || e.id).join(", ")}`);

    return {
      status,
      deliveryFactor: clamp(deliveryFactor, 0, 1),
      cargoLossPct: clamp(cargoLossPct, 0, 1),
      moneyDelta: net,
      grossReward: gross,
      report: reportLines.join("\n"),
      repDeltas,
    };
  }

  function awardStaffExperience(staffIds, missionStatus) {
    const ids = (staffIds || []).filter(Boolean);
    const xp = missionStatus === "success" ? 12 : missionStatus === "delayed" ? 9 : missionStatus === "partial" ? 6 : 3;
    for (const sid of ids) {
      const st = Game.player.staff.find(s => s.id === sid);
      if (!st) continue;
      st.experience = Number(st.experience || 0) + xp;
      // Minimal leveling effect (algorithmic, optional)
      if (st.experience > 200 && !st._leveled1) {
        st._leveled1 = true;
        // small stat bump
        if (st.skills) {
          for (const k of Object.keys(st.skills)) st.skills[k] = Math.round(Number(st.skills[k] || 0) + 2);
        }
        logEntry(`${st.name} gained experience and improved skills.`, "good");
      }
    }
  }

  function startMission(planning) {
    // planning = {
    //  missionId, transportId, routeMode, selectedServiceIds, assignedStaffIds, costBreakdown, durationMinutes
    // }
    const mission = Data.missionById.get(planning.missionId);
    if (!mission) {
      logEntry("Cannot start mission: missing mission.", "bad");
      return false;
    }

    const totalCost = planning.costBreakdown.total;
    if (Game.player.money < totalCost) {
      logEntry("Cannot start mission: insufficient funds.", "warn");
      return false;
    }

    Game.player.money -= totalCost;

    const startAt = Game.world.time.totalGameMinutes;
    const durationMinutes = Math.max(1, Math.round(planning.durationMinutes));
    const endAt = startAt + durationMinutes;

    const active = {
      id: uid("activeMission"),
      missionId: planning.missionId,
      transportId: planning.transportId,
      routeMode: planning.routeMode,
      routeRiskMod: planning.costBreakdown.routeRiskMod || 0,
      selectedServiceIds: planning.selectedServiceIds || [],
      servicesBonus: planning.costBreakdown.servicesBonus || 0,
      staffBonus: planning.costBreakdown.staffBonus || 0,
      assignedStaffIds: planning.assignedStaffIds || [],
      costs: deepClone(planning.costBreakdown),
      startedAtMinutes: startAt,
      plannedDurationMinutes: durationMinutes,
      endsAtMinutes: endAt,
      eventsEncountered: [],
      lastEventRollAtMinutes: startAt,
      status: "running",
      lastLogMilestone: 0,
    };

    Game.player.activeMissions.push(active);

    logEntry(`Mission started: ${mission.name} (${planning.transportId}). Cost: ${fmtMoney(totalCost)}.`, "good");
    logEntry(`Departure: ${Data.cityById.get(mission.originCityId)?.name || mission.originCityId}`, "info");

    // Tutorial progression hook
    tutorialOnMissionStarted(mission.id);

    renderAll();
    return true;
  }

  function tickActiveMissions() {
    const nowMins = Game.world.time.totalGameMinutes;
    const toComplete = [];

    for (const am of Game.player.activeMissions) {
      if (!am || am.status !== "running") continue;
      const mission = Data.missionById.get(am.missionId);
      if (!mission) continue;

      // Milestone logs
      const progress = clamp((nowMins - am.startedAtMinutes) / (am.plannedDurationMinutes || 1), 0, 1);
      const milestone = Math.floor(progress * 4); // 0..4
      if (milestone > (am.lastLogMilestone || 0)) {
        am.lastLogMilestone = milestone;
        if (milestone === 1) logEntry(`En route: ${mission.name} (25%).`, "info");
        if (milestone === 2) logEntry(`En route: ${mission.name} (50%).`, "info");
        if (milestone === 3) logEntry(`En route: ${mission.name} (75%).`, "info");
      }

      // In-transit event roll every ~2 in-game hours
      const eventEvery = 2 * 60;
      if (nowMins - (am.lastEventRollAtMinutes || 0) >= eventEvery) {
        am.lastEventRollAtMinutes = nowMins;
        maybeTriggerInTransitEvent(am);
      }

      if (nowMins >= am.endsAtMinutes) {
        toComplete.push(am);
      }
    }

    for (const am of toComplete) {
      completeMission(am);
    }
  }

  function maybeTriggerInTransitEvent(activeMission) {
    const mission = Data.missionById.get(activeMission.missionId);
    if (!mission) return;

    // Compute a rough live risk snapshot (prep + conditions)
    const transport = Data.transportById.get(activeMission.transportId);
    if (!transport) return;

    const baseTransportScore = clamp(100 - Number(transport.baseRisk || 10), 0, 100);
    const facilityType = APP.transportFacilityTypeMap[activeMission.transportId] || null;

    const originFacilityBonus = facilityType ? computeFacilityBonus(mission.originCityId, facilityType) : 0;
    const destinationFacilityBonus = facilityType ? computeFacilityBonus(mission.destinationCityId, facilityType) : 0;

    const prepScore = clamp(
      Math.round(baseTransportScore * 0.35 + originFacilityBonus + destinationFacilityBonus + Number(activeMission.servicesBonus || 0) + Number(activeMission.staffBonus || 0)),
      0,
      100
    );

    const wOrigin = getCityWeather(mission.originCityId);
    const wDest = getCityWeather(mission.destinationCityId);
    const weatherState = (wOrigin.state === wDest.state) ? wOrigin.state : pickOne([wOrigin.state, wDest.state]);
    const wMod = weatherModifierForTransport(wOrigin.state, wOrigin.severity, activeMission.transportId)
              + weatherModifierForTransport(wDest.state, wDest.severity, activeMission.transportId);

    const factionRisk = computeFactionRiskModifier(mission);
    const conditionScore = clamp(Math.round(wMod - factionRisk - Number(activeMission.routeRiskMod || 0)), -50, 30);

    const combined = clamp(prepScore + conditionScore, 0, 100);
    const riskValue = 100 - combined;

    const chance = mapRiskToEventChance(riskValue);
    if (rand01() > chance) return;

    const regionIds = new Set();
    const origin = Data.cityById.get(mission.originCityId);
    const dest = Data.cityById.get(mission.destinationCityId);
    if (origin?.regionId) regionIds.add(origin.regionId);
    if (dest?.regionId) regionIds.add(dest.regionId);

    const ev = selectRandomEventForMission({
      categoryHint: null,
      weatherState,
      transportId: activeMission.transportId,
      riskValue,
      regionIds,
      factionIds: new Set(),
    });

    if (!ev) return;

    activeMission.eventsEncountered.push(deepClone(ev));
    logEntry(`Event: ${ev.narrative || ev.name || ev.id}`, ev.category === "lucky" ? "good" : "warn");
  }

  function completeMission(activeMission) {
    const mission = Data.missionById.get(activeMission.missionId);
    if (!mission) return;

    const result = resolveMission(activeMission);
    activeMission.status = "completed";
    activeMission.result = result;
    activeMission.completedAtMinutes = Game.world.time.totalGameMinutes;

    // Apply money
    Game.player.money += result.moneyDelta;

    // Apply reputation
    for (const rd of (result.repDeltas || [])) {
      Game.player.reputationByCity[rd.cityId] = Number(Game.player.reputationByCity[rd.cityId] || 0) + Number(rd.delta || 0);
    }

    // Log report
    logEntry(`Mission completed: ${mission.name}. Net payout: ${fmtMoney(result.moneyDelta)}.`, result.status === "failed" ? "bad" : "good");
    logEntry(result.report, "info");

    // Remove from active list
    Game.player.activeMissions = Game.player.activeMissions.filter(x => x.id !== activeMission.id);

    // Tutorial hook
    tutorialOnMissionCompleted(mission.id, result);

    // Bankruptcy safety net check
    maybeTriggerBankruptcySafetyNet();

    renderAll();
  }

  /* ==============================
   *  INVESTMENTS
   * ============================== */

  function getInvestmentOpportunitiesForCity(cityId) {
    return (Data.investments || []).filter(inv => inv && inv.cityId === cityId && !inv.hidden);
  }

  function startInvestment(invId) {
    const inv = Data.investmentById.get(invId);
    if (!inv) {
      logEntry("Investment not found.", "warn");
      return;
    }
    const cost = Number(inv.cost || 0);
    if (Game.player.money < cost) {
      logEntry(`Can't invest in "${inv.name}": insufficient funds.`, "warn");
      return;
    }

    Game.player.money -= cost;

    const start = Game.world.time.totalGameMinutes;
    const days = Math.max(1, Number(inv.durationDays || 1));
    const end = start + days * 24 * 60;

    Game.player.investments.push({
      instanceId: uid("inv"),
      investmentId: invId,
      startedAtMinutes: start,
      endsAtMinutes: end,
      cost,
      totalReturn: Number(inv.totalReturn || 0),
      risk: Number(inv.risk || 0),
      cityId: inv.cityId,
      status: "running",
    });

    logEntry(`Investment started: ${inv.name} (Cost: ${fmtMoney(cost)}).`, "good");
    renderAll();
  }

  function tickInvestments() {
    const nowMins = Game.world.time.totalGameMinutes;
    const finished = [];

    for (const inst of Game.player.investments) {
      if (!inst || inst.status !== "running") continue;
      if (nowMins >= inst.endsAtMinutes) finished.push(inst);
    }

    for (const inst of finished) {
      finishInvestment(inst);
    }
  }

  function finishInvestment(inst) {
    const inv = Data.investmentById.get(inst.investmentId);
    if (!inv) {
      inst.status = "completed";
      return;
    }

    // Simple risk resolution: may reduce payout.
    const risk = clamp(Number(inv.risk || 0) / 100, 0, 1);
    const roll = rand01();
    let payout = Number(inv.totalReturn || 0);

    if (roll < risk * 0.25) {
      payout = Math.round(payout * 0.4);
      logEntry(`Investment setback: "${inv.name}" underperformed.`, "warn");
    } else if (roll < risk * 0.45) {
      payout = Math.round(payout * 0.75);
      logEntry(`Investment wobble: "${inv.name}" returned less than expected.`, "warn");
    } else if (roll > 1 - (0.08 * (1 - risk))) {
      payout = Math.round(payout * 1.15);
      logEntry(`Investment bonus: "${inv.name}" exceeded expectations!`, "good");
    }

    Game.player.money += payout;
    inst.status = "completed";
    inst.payout = payout;

    logEntry(`Investment completed: ${inv.name}. Payout: ${fmtMoney(payout)}.`, "good");

    // Remove completed investments to keep UI clean (MVP choice)
    Game.player.investments = Game.player.investments.filter(x => x.instanceId !== inst.instanceId);

    renderAll();
  }

  function maybeTriggerBankruptcySafetyNet() {
    if (Game.player.money >= APP.bankruptcyMoneyThreshold) return;
    if (Game.player.activeMissions.length > 0) return;

    // If the city has a safety-net tagged investment, surface it.
    // Recommended investments.json: include at least one entry with tags including "safety_net" and cost <= 100.
    const cityId = Game.player.hqs[0] || APP.starterCityId;
    const options = getInvestmentOpportunitiesForCity(cityId);
    const safety = options.filter(x => (x.tags || []).includes("safety_net"));
    if (safety.length) {
      logEntry("Safety net: A small guaranteed opportunity is available in Investments.", "warn");
      flashAlert("Safety net available");
    } else {
      logEntry("Safety net needed, but no investments are tagged 'safety_net' in investments.json.", "warn");
    }
  }

  /* ==============================
   *  STAFF: HIRING + ASSIGNMENT
   * ============================== */

  function getHirePoolForCity(cityId) {
    // staff.json recommended: staff templates may include cityId OR tags/regions.
    // We'll filter by staff.cityId if present, else allow if no cityId (global).
    const pool = (Data.staff || []).filter(s => {
      if (!s) return false;
      if (s.cityId) return s.cityId === cityId;
      return true;
    });

    // Exclude already hired (by id)
    const hiredIds = new Set(Game.player.staff.map(s => s.id));
    return pool.filter(s => !hiredIds.has(s.id));
  }

  function hireStaff(staffId) {
    const st = Data.staffById.get(staffId);
    if (!st) {
      logEntry("Staff candidate not found.", "warn");
      return;
    }

    const salary = Number(st.salary || 0);
    const hireCost = Number(st.hireCost || 0);

    if (Game.player.money < hireCost) {
      logEntry(`Can't hire ${st.name}: hire cost is ${fmtMoney(hireCost)}.`, "warn");
      return;
    }

    Game.player.money -= hireCost;

    const hired = deepClone(st);
    hired.assignedBuildingId = null;
    hired.assignedMissionId = null;

    Game.player.staff.push(hired);
    logEntry(`Hired staff: ${hired.name} (${hired.role || "staff"}).`, "good");

    renderAll();
  }

  function unassignStaff(staffId) {
    const st = Game.player.staff.find(s => s.id === staffId);
    if (!st) return;
    st.assignedBuildingId = null;
    st.assignedMissionId = null;
    logEntry(`${st.name} is now unassigned.`, "info");
    renderAll();
  }

  /* ==============================
   *  BUILDINGS (MVP upgradeable stub)
   * ============================== */

  function buildBuilding(cityId, buildingTemplateId) {
    const tpl = Data.buildingById.get(buildingTemplateId);
    if (!tpl) {
      logEntry("Building template not found.", "warn");
      return;
    }
    const cost = Number(tpl.baseCost || 0);
    if (Game.player.money < cost) {
      logEntry(`Can't build ${tpl.name}: cost is ${fmtMoney(cost)}.`, "warn");
      return;
    }
    Game.player.money -= cost;

    const inst = {
      instanceId: uid("bld"),
      cityId,
      buildingTemplateId,
      level: Number(tpl.level || 1),
      nick: tpl.name,
      staffIds: [],
      modules: [],
    };

    Game.player.ownedBuildings.push(inst);
    logEntry(`Built: ${tpl.name} in ${Data.cityById.get(cityId)?.name || cityId}.`, "good");
    renderAll();
  }

  function upgradeBuilding(instanceId) {
    const inst = Game.player.ownedBuildings.find(b => b.instanceId === instanceId);
    if (!inst) return;

    const tpl = Data.buildingById.get(inst.buildingTemplateId);
    if (!tpl) return;

    const curr = Number(inst.level || 1);
    const next = curr + 1;

    // buildings.json recommended: upgradeCosts: { "level2": 5000, "level3": 9000 }
    const key = `level${next}`;
    const cost = Number(tpl.upgradeCosts?.[key] || 0);

    if (!cost) {
      logEntry(`${tpl.name} has no upgrade data for ${key}.`, "warn");
      return;
    }
    if (Game.player.money < cost) {
      logEntry(`Can't upgrade ${tpl.name}: cost is ${fmtMoney(cost)}.`, "warn");
      return;
    }

    Game.player.money -= cost;
    inst.level = next;

    logEntry(`Upgraded ${tpl.name} to Level ${next}.`, "good");
    renderAll();
  }

  /* ==============================
   *  TUTORIAL
   * ============================== */

  function beginTutorialIfNeeded(force = false) {
    if (!force && Game.tutorial.completed) return;
    if (!force && Game.tutorial.step > 0) return;

    showTutorialDialog(
      "A Letter From Your Uncle",
      [
        "You inherited 500 crowns and a tiny HQ shell in Dockford.",
        "A friend insists there’s easy money in local deliveries… if you fund the mission.",
        "Let’s start with something unglamorous: pig dung.",
      ],
      () => {
        Game.tutorial.step = 1;
        renderAll();
        tutorialPromptSelectMission();
      }
    );
  }

  function showTutorialDialog(title, lines, onNext) {
    UI.tutorialOverlay.classList.remove("hidden");
    UI.tutorialOverlay.innerHTML = "";

    const box = el("div", { class: "tutorialBox" }, [
      el("div", { class: "tutorialTitle", text: title }),
      el("div", { class: "tutorialBody" }, lines.map(t => el("p", { text: t }))),
      el("div", { class: "tutorialActions" }, [
        el("button", { class: "btn primary", text: "Next", onclick: () => {
          UI.tutorialOverlay.classList.add("hidden");
          UI.tutorialOverlay.innerHTML = "";
          if (typeof onNext === "function") onNext();
        }})
      ]),
    ]);

    UI.tutorialOverlay.appendChild(box);
  }

  function tutorialPromptSelectMission() {
    setActiveTab("missions");
    logEntry("Tutorial: In Missions, click the highlighted job to plan it.", "info");
    flashAlert("Tutorial: Plan mission");
  }

  function tutorialOnMissionStarted(missionId) {
    if (Game.tutorial.completed) return;
    if (missionId !== APP.tutorialMissionId) return;

    if (Game.tutorial.step <= 1) {
      Game.tutorial.step = 2;
      logEntry("Tutorial: Mission is running. Watch the Log for updates.", "info");
      flashAlert("Mission running");
    }
  }

  function tutorialOnMissionCompleted(missionId, result) {
    if (Game.tutorial.completed) return;
    if (missionId !== APP.tutorialMissionId) return;

    if (Game.tutorial.step <= 2) {
      Game.tutorial.step = 3;

      showTutorialDialog(
        "First Profit",
        [
          `You finished the run. Outcome: ${result.status.toUpperCase()}.`,
          `Money changes immediately: reward minus costs, plus any event bonuses.`,
          "Next: check Investments and Staff to grow beyond mule work.",
        ],
        () => {
          Game.tutorial.completed = true;
          Game.tutorial.step = 99;
          logEntry("Tutorial completed. You are free to expand.", "good");
          flashAlert("Tutorial complete");
          renderAll();
        }
      );
    }
  }

  /* ==============================
   *  RENDERING
   * ============================== */

  function renderAll() {
    if (!Game.dataReady) return;
    renderTopHud();
    renderWorldMap();
    renderTownMap();
    renderMissionsPanel();
    renderStaffPanel();
    renderInvestmentsPanel();
    renderLog();
    renderBottomHud();
  }

  function renderTopHud() {
    UI.title.textContent = `${APP.title} (Demo)`;

    UI.time.textContent = timeLabelFromMinutes(Game.world.time.totalGameMinutes);

    // Weather HUD: shows local (HQ city) weather for free (per bible)
    const hqCityId = Game.player.hqs[0] || APP.starterCityId;
    const w = getCityWeather(hqCityId);
    UI.weather.textContent = `Weather: ${w.state} (${Math.round(clamp(w.severity, 0, 1) * 100)}%)`;
  }

  function renderBottomHud() {
    UI.money.textContent = `Money: ${fmtMoney(Game.player.money)}`;

    // MVP: we don’t implement ongoing salaries/upkeep as mandatory,
    // but we can show a hint if staff have salaries.
    const salaries = Game.player.staff.reduce((s, st) => s + Number(st.salary || 0), 0);
    UI.income.textContent = salaries > 0 ? `Staff Salaries (daily est.): ${fmtMoney(salaries)}` : `Income/Upkeep: —`;
  }

  function clearMarkers(layer) {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
  }

  function renderWorldMap() {
    if (Game.ui.activeView !== "world") return;

    clearMarkers(UI.worldMarkers);

    // City markers
    for (const c of Data.cities) {
      const x = Number(c.mapX ?? c.x ?? 0.5);
      const y = Number(c.mapY ?? c.y ?? 0.5);
      const norm = (v) => (v > 1 ? v / 100 : v);

      const marker = el("button", {
        class: "marker cityMarker",
        title: c.name || c.id,
        "data-city": c.id,
        onclick: () => openCityPanel(c.id),
      }, [
        el("span", { class: "markerDot" }),
        el("span", { class: "markerLabel", text: c.name || c.id }),
      ]);

      marker.style.left = `${clamp(norm(x), 0, 1) * 100}%`;
      marker.style.top = `${clamp(norm(y), 0, 1) * 100}%`;

      // HQ indicator
      const isHQ = Game.player.hqs.includes(c.id);
      if (isHQ) marker.classList.add("hq");

      UI.worldMarkers.appendChild(marker);
    }

    // Active mission lines (simple)
    for (const am of Game.player.activeMissions) {
      const m = Data.missionById.get(am.missionId);
      if (!m) continue;

      const a = Data.cityById.get(m.originCityId);
      const b = Data.cityById.get(m.destinationCityId);
      if (!a || !b) continue;

      // Render as small badge at midpoint (MVP)
      const ax = Number(a.mapX ?? a.x ?? 0.5), ay = Number(a.mapY ?? a.y ?? 0.5);
      const bx = Number(b.mapX ?? b.x ?? 0.5), by = Number(b.mapY ?? b.y ?? 0.5);
      const norm = (v) => (v > 1 ? v / 100 : v);

      const mx = (norm(ax) + norm(bx)) / 2;
      const my = (norm(ay) + norm(by)) / 2;

      const badge = el("div", { class: "missionBadge", title: m.name }, [
        el("span", { class: "missionBadgeText", text: "🚚" }),
      ]);

      badge.style.left = `${clamp(mx, 0, 1) * 100}%`;
      badge.style.top = `${clamp(my, 0, 1) * 100}%`;

      UI.worldMarkers.appendChild(badge);
    }
  }

  function renderTownMap() {
    if (Game.ui.activeView !== "town") return;

    clearMarkers(UI.townMarkers);

    // Town map is HQ-focused: show HQ marker + owned buildings in that city (MVP: only first HQ city).
    const cityId = Game.player.hqs[0] || APP.starterCityId;
    const city = Data.cityById.get(cityId);

    // HQ marker in center (algorithmic placement)
    const hqMarker = el("button", {
      class: "marker buildingMarker hq",
      title: `HQ — ${city?.name || cityId}`,
      onclick: () => openHQPanel(cityId),
    }, [
      el("span", { class: "markerDot" }),
      el("span", { class: "markerLabel", text: "HQ" }),
    ]);
    hqMarker.style.left = `50%`;
    hqMarker.style.top = `55%`;
    UI.townMarkers.appendChild(hqMarker);

    // Owned buildings in HQ city
    const ownedHere = Game.player.ownedBuildings.filter(b => b.cityId === cityId);
    let i = 0;
    for (const inst of ownedHere) {
      const tpl = Data.buildingById.get(inst.buildingTemplateId);
      if (!tpl) continue;
      i++;

      const bm = el("button", {
        class: "marker buildingMarker",
        title: `${tpl.name} (Lv ${inst.level || 1})`,
        onclick: () => openBuildingPanel(inst.instanceId),
      }, [
        el("span", { class: "markerDot" }),
        el("span", { class: "markerLabel", text: tpl.name }),
      ]);

      // Spread around HQ
      const angle = (i / Math.max(3, ownedHere.length + 1)) * Math.PI * 2;
      const dx = Math.cos(angle) * 18;
      const dy = Math.sin(angle) * 12;

      bm.style.left = `calc(50% + ${dx}%)`;
      bm.style.top = `calc(55% + ${dy}%)`;

      UI.townMarkers.appendChild(bm);
    }

    // Dummy plots (MVP: 2 plots)
    for (let p = 0; p < 2; p++) {
      const plot = el("button", {
        class: "marker plotMarker",
        title: "Empty Plot (Build)",
        onclick: () => openBuildMenu(cityId),
      }, [
        el("span", { class: "markerDot" }),
        el("span", { class: "markerLabel", text: "Empty Plot" }),
      ]);
      plot.style.left = p === 0 ? `25%` : `75%`;
      plot.style.top = p === 0 ? `35%` : `30%`;
      UI.townMarkers.appendChild(plot);
    }
  }

  function renderLog() {
    const pnl = UI.tabPanels.log;
    if (!pnl) return;
    if (Game.ui.activeTab !== "log") return;

    pnl.innerHTML = "";
    const wrap = el("div", { class: "logList" });

    for (const entry of Game.ui.log.slice().reverse()) {
      const row = el("div", { class: `logRow ${entry.type || "info"}` }, [
        el("div", { class: "logTime", text: timeLabelFromMinutes(entry.t) }),
        el("div", { class: "logText", text: entry.text }),
      ]);
      wrap.appendChild(row);
    }

    if (!Game.ui.log.length) {
      wrap.appendChild(el("div", { class: "logEmpty", text: "No logs yet." }));
    }

    pnl.appendChild(wrap);
  }

  function renderMissionsPanel() {
    const pnl = UI.tabPanels.missions;
    if (!pnl) return;
    if (Game.ui.activeTab !== "missions") return;

    pnl.innerHTML = "";

    // Active missions summary
    const activeBox = el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "Active Missions" }),
    ]);

    if (!Game.player.activeMissions.length) {
      activeBox.appendChild(el("div", { class: "muted", text: "None running." }));
    } else {
      for (const am of Game.player.activeMissions) {
        const m = Data.missionById.get(am.missionId);
        if (!m) continue;
        const now = Game.world.time.totalGameMinutes;
        const remaining = Math.max(0, am.endsAtMinutes - now);
        const prog = clamp((now - am.startedAtMinutes) / (am.plannedDurationMinutes || 1), 0, 1);

        activeBox.appendChild(el("div", { class: "card" }, [
          el("div", { class: "cardTitle", text: m.name }),
          el("div", { class: "cardLine", text: `Transport: ${am.transportId}` }),
          el("div", { class: "cardLine", text: `Progress: ${Math.round(prog * 100)}%` }),
          el("div", { class: "cardLine", text: `ETA: ~${Math.round(remaining)} min` }),
        ]));
      }
    }

    // Available missions in HQ city (MVP)
    const hqCityId = Game.player.hqs[0] || APP.starterCityId;
    const available = (Data.missions || []).filter(m => m && m.originCityId === hqCityId);

    const availBox = el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "Available Missions" }),
    ]);

    if (!available.length) {
      availBox.appendChild(el("div", { class: "muted", text: "No missions in this city." }));
    } else {
      for (const m of available) {
        const isTutorialTarget = !Game.tutorial.completed && Game.tutorial.step === 1 && m.id === APP.tutorialMissionId;
        const btn = el("button", {
          class: `listItem ${isTutorialTarget ? "highlight" : ""}`,
          onclick: () => openMissionPlanner(m.id),
        }, [
          el("div", { class: "liTitle", text: m.name }),
          el("div", { class: "liSub", text: `${Data.cityById.get(m.originCityId)?.name || m.originCityId} → ${Data.cityById.get(m.destinationCityId)?.name || m.destinationCityId}` }),
          el("div", { class: "liMeta", text: `Reward: ${fmtMoney(m.baseReward ?? 0)} • Duration: ${m.baseDurationHours || "?"}h • Diff: ${m.difficulty || 1}` }),
        ]);
        availBox.appendChild(btn);
      }
    }

    // Quick action
    const quick = el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "Quick Actions" }),
      el("button", { class: "btn", text: "Plan Mission (Pick)", onclick: () => {
        const m = available[0];
        if (!m) return;
        openMissionPlanner(m.id);
      }}),
    ]);

    pnl.appendChild(activeBox);
    pnl.appendChild(availBox);
    pnl.appendChild(quick);
  }

  function renderStaffPanel() {
    const pnl = UI.tabPanels.staff;
    if (!pnl) return;
    if (Game.ui.activeTab !== "staff") return;

    pnl.innerHTML = "";

    const hqCityId = Game.player.hqs[0] || APP.starterCityId;

    const hires = getHirePoolForCity(hqCityId);

    const ownedBox = el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "Your Staff" }),
    ]);

    if (!Game.player.staff.length) {
      ownedBox.appendChild(el("div", { class: "muted", text: "No staff hired yet." }));
    } else {
      for (const st of Game.player.staff) {
        const assigned = st.assignedBuildingId ? `Building: ${st.assignedBuildingId}` : st.assignedMissionId ? `Mission: ${st.assignedMissionId}` : "Unassigned";
        ownedBox.appendChild(el("div", { class: "card" }, [
          el("div", { class: "cardTitle", text: `${st.name} — ${st.role || "staff"}` }),
          el("div", { class: "cardLine", text: `XP: ${st.experience || 0} • Loyalty: ${st.loyalty || 0}` }),
          el("div", { class: "cardLine", text: assigned }),
          el("div", { class: "cardLine", text: `Traits: ${(st.traits || []).join(", ") || "—"}` }),
          el("div", { class: "cardActions" }, [
            el("button", { class: "btn small", text: "Details", onclick: () => openStaffDetails(st.id) }),
            el("button", { class: "btn small", text: "Unassign", onclick: () => unassignStaff(st.id) }),
          ]),
        ]));
      }
    }

    const hireBox = el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: `Hire in ${Data.cityById.get(hqCityId)?.name || hqCityId}` }),
    ]);

    if (!hires.length) {
      hireBox.appendChild(el("div", { class: "muted", text: "No candidates available right now." }));
    } else {
      for (const st of hires.slice(0, 6)) {
        const hireCost = Number(st.hireCost || 0);
        const canAfford = Game.player.money >= hireCost;
        hireBox.appendChild(el("div", { class: "card" }, [
          el("div", { class: "cardTitle", text: `${st.name} — ${st.role || "staff"}` }),
          el("div", { class: "cardLine", text: `Hire: ${fmtMoney(hireCost)} • Salary: ${fmtMoney(st.salary || 0)}` }),
          el("div", { class: "cardLine", text: `Skills: ${formatSkillsLine(st.skills || {})}` }),
          el("div", { class: "cardActions" }, [
            el("button", {
              class: `btn small ${canAfford ? "primary" : ""}`,
              text: canAfford ? "Hire" : "Can't afford",
              onclick: () => { if (canAfford) hireStaff(st.id); },
              title: canAfford ? "" : `Need ${fmtMoney(hireCost)}`
            }),
          ]),
        ]));
      }
    }

    pnl.appendChild(ownedBox);
    pnl.appendChild(hireBox);
  }

  function formatSkillsLine(skills) {
    const parts = [];
    for (const [k, v] of Object.entries(skills || {})) {
      parts.push(`${k}:${v}`);
    }
    return parts.join(" • ") || "—";
  }

  function renderInvestmentsPanel() {
    const pnl = UI.tabPanels.investments;
    if (!pnl) return;
    if (Game.ui.activeTab !== "investments") return;

    pnl.innerHTML = "";

    const cityId = Game.player.hqs[0] || APP.starterCityId;
    const cityName = Data.cityById.get(cityId)?.name || cityId;

    const activeBox = el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "Active Investments" }),
    ]);

    if (!Game.player.investments.length) {
      activeBox.appendChild(el("div", { class: "muted", text: "None running." }));
    } else {
      for (const inst of Game.player.investments) {
        const inv = Data.investmentById.get(inst.investmentId);
        if (!inv) continue;
        const now = Game.world.time.totalGameMinutes;
        const remaining = Math.max(0, inst.endsAtMinutes - now);
        activeBox.appendChild(el("div", { class: "card" }, [
          el("div", { class: "cardTitle", text: inv.name }),
          el("div", { class: "cardLine", text: `Expected return: ${fmtMoney(inv.totalReturn || 0)} • Risk: ${inv.risk || 0}` }),
          el("div", { class: "cardLine", text: `Time left: ~${Math.round(remaining / (24 * 60) * 10) / 10} days` }),
        ]));
      }
    }

    const oppBox = el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: `Opportunities in ${cityName}` }),
    ]);

    const ops = getInvestmentOpportunitiesForCity(cityId).slice(0, 6);

    if (!ops.length) {
      oppBox.appendChild(el("div", { class: "muted", text: "No opportunities defined for this city." }));
    } else {
      for (const inv of ops) {
        const canAfford = Game.player.money >= Number(inv.cost || 0);
        oppBox.appendChild(el("div", { class: "card" }, [
          el("div", { class: "cardTitle", text: inv.name }),
          el("div", { class: "cardLine", text: `Cost: ${fmtMoney(inv.cost || 0)} • Return: ${fmtMoney(inv.totalReturn || 0)} • Days: ${inv.durationDays || 1}` }),
          el("div", { class: "cardLine", text: `Risk: ${inv.risk || 0} • Tags: ${(inv.tags || []).join(", ") || "—"}` }),
          el("div", { class: "cardActions" }, [
            el("button", {
              class: `btn small ${canAfford ? "primary" : ""}`,
              text: canAfford ? "Invest" : "Can't afford",
              onclick: () => { if (canAfford) startInvestment(inv.id); },
            }),
          ]),
        ]));
      }
    }

    pnl.appendChild(activeBox);
    pnl.appendChild(oppBox);
  }

  /* ==============================
   *  CITY / HQ / BUILDING PANELS
   * ============================== */

  function openCityPanel(cityId) {
    const c = Data.cityById.get(cityId);
    if (!c) return;

    const missionsHere = (Data.missions || []).filter(m => m && (m.originCityId === cityId || m.destinationCityId === cityId));
    const invHere = getInvestmentOpportunitiesForCity(cityId);

    const content = el("div", { class: "cityPanel" });

    content.appendChild(el("div", { class: "panelLead" }, [
      el("div", { class: "panelTitleBig", text: c.name || cityId }),
      el("div", { class: "muted", text: `Region: ${c.regionId || "—"} • Pop: ${c.population || "—"}` }),
    ]));

    // Missions list (starting from this city)
    content.appendChild(el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "Missions" }),
      ...missionsHere.slice(0, 6).map(m => el("button", {
        class: "listItem",
        onclick: () => openMissionPlanner(m.id),
      }, [
        el("div", { class: "liTitle", text: m.name }),
        el("div", { class: "liSub", text: `${Data.cityById.get(m.originCityId)?.name || m.originCityId} → ${Data.cityById.get(m.destinationCityId)?.name || m.destinationCityId}` }),
      ])),
    ]));

    // Investments list
    content.appendChild(el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "Investments" }),
      ...(invHere.slice(0, 4).map(inv => el("div", { class: "card" }, [
        el("div", { class: "cardTitle", text: inv.name }),
        el("div", { class: "cardLine", text: `Cost: ${fmtMoney(inv.cost || 0)} • Return: ${fmtMoney(inv.totalReturn || 0)}` }),
      ]))),
      invHere.length ? null : el("div", { class: "muted", text: "No investments defined here." }),
    ]));

    openModal(`City: ${c.name || cityId}`, content, [
      el("button", { class: "btn", text: "Close", onclick: () => closeModal() }),
    ]);
  }

  function openHQPanel(cityId) {
    const city = Data.cityById.get(cityId);
    const content = el("div", { class: "hqPanel" });

    content.appendChild(el("div", { class: "panelLead" }, [
      el("div", { class: "panelTitleBig", text: `HQ — ${city?.name || cityId}` }),
      el("div", { class: "muted", text: "Your headquarters. Buildings here unlock services and reduce risk." }),
    ]));

    const owned = Game.player.ownedBuildings.filter(b => b.cityId === cityId);
    content.appendChild(el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "Owned Buildings" }),
      ...(owned.length
        ? owned.map(inst => {
            const tpl = Data.buildingById.get(inst.buildingTemplateId);
            if (!tpl) return null;
            return el("button", { class: "listItem", onclick: () => openBuildingPanel(inst.instanceId) }, [
              el("div", { class: "liTitle", text: `${tpl.name} (Lv ${inst.level || 1})` }),
              el("div", { class: "liSub", text: `Type: ${tpl.type}` }),
            ]);
          })
        : [el("div", { class: "muted", text: "None built yet. Click an Empty Plot to build." })]
      ),
    ]));

    openModal("Headquarters", content, [
      el("button", { class: "btn", text: "Build…", onclick: () => { closeModal(); openBuildMenu(cityId); } }),
      el("button", { class: "btn", text: "Close", onclick: () => closeModal() }),
    ]);
  }

  function openBuildMenu(cityId) {
    const city = Data.cityById.get(cityId);

    // Buildable: any building template with baseCost and not type "service"
    const buildable = (Data.buildings || []).filter(b => b && b.baseCost != null && b.type !== "service");

    const content = el("div", { class: "buildMenu" }, [
      el("div", { class: "panelLead" }, [
        el("div", { class: "panelTitleBig", text: `Build in ${city?.name || cityId}` }),
        el("div", { class: "muted", text: "Owning infrastructure reduces per-mission fees and risk." }),
      ]),
    ]);

    const list = el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "Available Buildings" }),
    ]);

    for (const b of buildable.slice(0, 12)) {
      const canAfford = Game.player.money >= Number(b.baseCost || 0);
      list.appendChild(el("div", { class: "card" }, [
        el("div", { class: "cardTitle", text: b.name || b.id }),
        el("div", { class: "cardLine", text: `Type: ${b.type} • Cost: ${fmtMoney(b.baseCost || 0)} • Reliability: ${b.reliability || "—"}` }),
        el("div", { class: "cardLine", text: `Lease per use: ${fmtMoney(b.leaseFeePerUse ?? b.leaseFee ?? 0)} • Staff slots: ${b.staffSlots ?? "—"}` }),
        el("div", { class: "cardActions" }, [
          el("button", {
            class: `btn small ${canAfford ? "primary" : ""}`,
            text: canAfford ? "Build" : "Can't afford",
            onclick: () => { if (canAfford) { closeModal(); buildBuilding(cityId, b.id); } },
          }),
        ]),
      ]));
    }

    content.appendChild(list);

    openModal("Build", content, [
      el("button", { class: "btn", text: "Close", onclick: () => closeModal() }),
    ]);
  }

  function openBuildingPanel(instanceId) {
    const inst = Game.player.ownedBuildings.find(b => b.instanceId === instanceId);
    if (!inst) return;

    const tpl = Data.buildingById.get(inst.buildingTemplateId);
    if (!tpl) return;

    const city = Data.cityById.get(inst.cityId);

    const content = el("div", { class: "buildingPanel" });

    content.appendChild(el("div", { class: "panelLead" }, [
      el("div", { class: "panelTitleBig", text: `${tpl.name} (Lv ${inst.level || 1})` }),
      el("div", { class: "muted", text: `${city?.name || inst.cityId} • Type: ${tpl.type} • Reliability: ${tpl.reliability || "—"}` }),
    ]));

    // Upgrade info
    const curr = Number(inst.level || 1);
    const next = curr + 1;
    const key = `level${next}`;
    const cost = Number(tpl.upgradeCosts?.[key] || 0);

    content.appendChild(el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "Upgrades" }),
      cost
        ? el("div", { class: "card" }, [
            el("div", { class: "cardTitle", text: `Upgrade to Level ${next}` }),
            el("div", { class: "cardLine", text: `Cost: ${fmtMoney(cost)}` }),
            el("div", { class: "cardActions" }, [
              el("button", {
                class: `btn small ${Game.player.money >= cost ? "primary" : ""}`,
                text: Game.player.money >= cost ? "Upgrade" : "Can't afford",
                onclick: () => { if (Game.player.money >= cost) { closeModal(); upgradeBuilding(instanceId); } },
              }),
            ]),
          ])
        : el("div", { class: "muted", text: "No further upgrades defined." }),
    ]));

    openModal("Building", content, [
      el("button", { class: "btn", text: "Close", onclick: () => closeModal() }),
    ]);
  }

  function openStaffDetails(staffId) {
    const st = Game.player.staff.find(s => s.id === staffId) || Data.staffById.get(staffId);
    if (!st) return;

    const content = el("div", { class: "staffDetails" });

    content.appendChild(el("div", { class: "panelLead" }, [
      el("div", { class: "panelTitleBig", text: `${st.name}` }),
      el("div", { class: "muted", text: `${st.role || "staff"} • XP: ${st.experience || 0} • Loyalty: ${st.loyalty || 0}` }),
    ]));

    content.appendChild(el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "Skills" }),
      el("pre", { class: "codeBlock", text: JSON.stringify(st.skills || {}, null, 2) }),
    ]));

    content.appendChild(el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "Traits" }),
      el("div", { class: "muted", text: (st.traits || []).join(", ") || "—" }),
    ]));

    if (st.bio) {
      content.appendChild(el("div", { class: "panelSection" }, [
        el("div", { class: "sectionTitle", text: "Bio" }),
        el("div", { class: "muted", text: st.bio }),
      ]));
    }

    openModal("Staff", content, [
      el("button", { class: "btn", text: "Close", onclick: () => closeModal() }),
    ]);
  }

  /* ==============================
   *  MISSION PLANNER UI
   * ============================== */

  function openMissionPlanner(missionId) {
    const mission = Data.missionById.get(missionId);
    if (!mission) return;

    const transportChoices = (mission.allowedTransportTypes || Data.transport.map(t => t.id) || []).map(id => Data.transportById.get(id)).filter(Boolean);

    // Planner state (UI local)
    const planner = {
      missionId,
      transportId: "mule",
      routeMode: getKnownRoute(mission.originCityId, mission.destinationCityId) ? "known" : "manual",
      selectedServiceIds: [],
      assignedStaffIds: [],
    };

    // Default: if mule exists and is allowed
    if (transportChoices.some(t => t.id === "mule")) planner.transportId = "mule";
    else planner.transportId = transportChoices[0]?.id || "mule";

    const content = el("div", { class: "missionPlanner" });

    // Header summary
    const summary = el("div", { class: "panelLead" }, [
      el("div", { class: "panelTitleBig", text: mission.name }),
      el("div", { class: "muted", text: mission.description || "" }),
      el("div", { class: "muted", text: `${Data.cityById.get(mission.originCityId)?.name || mission.originCityId} → ${Data.cityById.get(mission.destinationCityId)?.name || mission.destinationCityId}` }),
    ]);

    // Transport selection
    const transportBox = el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "1) Choose Transport" }),
    ]);

    const transportList = el("div", { class: "transportList" });

    for (const t of transportChoices) {
      const cb = () => {
        planner.transportId = t.id;
        repaint();
      };

      const cost = Number(t.baseRentalCost || 0);
      const canAfford = Game.player.money >= cost; // minimal check; real check includes fees/services
      const btn = el("button", {
        class: `transportCard ${planner.transportId === t.id ? "selected" : ""} ${canAfford ? "" : "locked"}`,
        onclick: cb,
        title: canAfford ? "" : `Costs at least ${fmtMoney(cost)} to rent`,
      }, [
        el("div", { class: "cardTitle", text: t.name || t.id }),
        el("div", { class: "cardLine", text: `Rental: ${fmtMoney(cost)} • Speed: ${t.speed || 1} • Capacity: ${t.capacity || "—"} • Base risk: ${t.baseRisk || 0}` }),
      ]);

      transportList.appendChild(btn);
    }

    transportBox.appendChild(transportList);

    // Route selection
    const routeBox = el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "2) Choose Route" }),
    ]);

    const hasKnown = !!getKnownRoute(mission.originCityId, mission.destinationCityId);

    const routeBtns = el("div", { class: "routeChoices" }, [
      el("button", {
        class: `btn small ${planner.routeMode === "known" ? "primary" : ""}`,
        text: hasKnown ? "Known Route" : "Known Route (None)",
        onclick: () => { if (hasKnown) { planner.routeMode = "known"; repaint(); } },
        disabled: hasKnown ? null : "true",
        title: hasKnown ? "" : "No known route defined in cities.json routes",
      }),
      el("button", {
        class: `btn small ${planner.routeMode === "manual" ? "primary" : ""}`,
        text: "Manual Route",
        onclick: () => { planner.routeMode = "manual"; repaint(); },
      }),
      el("button", {
        class: `btn small ${planner.routeMode === "shady" ? "primary" : ""}`,
        text: "Shady Route",
        onclick: () => { planner.routeMode = "shady"; repaint(); },
        title: "Cheaper but riskier",
      }),
    ]);

    routeBox.appendChild(routeBtns);
    routeBox.appendChild(el("div", { class: "muted", id: "routeHint", text: "" }));

    // Services selection (from JSON services)
    const servicesBox = el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "3) Services & Prep" }),
    ]);

    const servicesList = el("div", { class: "servicesList" });
    const servicesAvailable = (Data.services || []).slice(0, 8);

    if (!servicesAvailable.length) {
      servicesBox.appendChild(el("div", { class: "muted", text: "No services defined. (Add top-level 'services' array in buildings.json for Weather Forecast, Cargo Prep, Crew Broker, etc.)" }));
    } else {
      for (const svc of servicesAvailable) {
        const id = svc.id;
        const cost = Number(svc.cost || 0);
        const bonus = Number(svc.prepBonus || (svc.bonuses?.prepScore || 0) || 0);
        const checked = planner.selectedServiceIds.includes(id);

        const row = el("label", { class: "checkRow" }, [
          el("input", {
            type: "checkbox",
            checked: checked ? "true" : null,
            onchange: (e) => {
              const on = e.target.checked;
              if (on && !planner.selectedServiceIds.includes(id)) planner.selectedServiceIds.push(id);
              if (!on) planner.selectedServiceIds = planner.selectedServiceIds.filter(x => x !== id);
              repaint();
            },
          }),
          el("span", { class: "checkLabel", text: `${svc.name || id} — Cost: ${fmtMoney(cost)} • Prep: +${bonus}` }),
        ]);
        servicesList.appendChild(row);
      }
      servicesBox.appendChild(servicesList);
    }

    // Staff assignment (MVP: pick up to 2 staff)
    const staffBox = el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "4) Assign Staff" }),
    ]);

    const staffHint = el("div", { class: "muted", text: "Assign staff to improve mission odds (logistics/navigation/forecasting)." });
    staffBox.appendChild(staffHint);

    const staffSelect = el("div", { class: "staffPick" });
    const staffCandidates = Game.player.staff.slice();

    if (!staffCandidates.length) {
      staffSelect.appendChild(el("div", { class: "muted", text: "No staff hired. (You can hire in the Staff tab.)" }));
    } else {
      for (const st of staffCandidates) {
        const on = planner.assignedStaffIds.includes(st.id);
        const row = el("label", { class: "checkRow" }, [
          el("input", {
            type: "checkbox",
            checked: on ? "true" : null,
            onchange: (e) => {
              const checked = e.target.checked;
              if (checked) {
                if (!planner.assignedStaffIds.includes(st.id)) planner.assignedStaffIds.push(st.id);
                // cap at 2 for MVP
                if (planner.assignedStaffIds.length > 2) planner.assignedStaffIds.shift();
              } else {
                planner.assignedStaffIds = planner.assignedStaffIds.filter(x => x !== st.id);
              }
              repaint();
            },
          }),
          el("span", { class: "checkLabel", text: `${st.name} (${st.role || "staff"}) • ${formatSkillsLine(st.skills || {})}` }),
        ]);
        staffSelect.appendChild(row);
      }
    }

    staffBox.appendChild(staffSelect);

    // Cost breakdown + confirm
    const costBox = el("div", { class: "panelSection" }, [
      el("div", { class: "sectionTitle", text: "5) Cost Breakdown & Confirm" }),
    ]);

    const breakdownNode = el("div", { id: "breakdownNode", class: "breakdown" });
    costBox.appendChild(breakdownNode);

    // Paint function
    const repaint = () => {
      // Recompute costs
      const transport = Data.transportById.get(planner.transportId);
      const durHours = transport ? computeDurationHours(mission, transport) : Number(mission.baseDurationHours || 8);
      const durMins = Math.round(durHours * 60);

      const costs = computeBaseCosts(
        mission,
        planner.transportId,
        planner.routeMode,
        planner.selectedServiceIds,
        planner.assignedStaffIds
      );

      // Route hint
      const routeHint = qs("#routeHint", routeBox);
      if (routeHint) {
        if (planner.routeMode === "known") routeHint.textContent = "Known route: lower uncertainty (if defined).";
        else if (planner.routeMode === "manual") routeHint.textContent = "Manual route: moderate uncertainty.";
        else routeHint.textContent = "Shady route: cheaper, higher bandit/political risk.";
      }

      // Highlight chosen transport
      qsa(".transportCard", transportBox).forEach(btn => {
        const tId = btn.querySelector(".cardTitle")?.textContent;
        // We set class on creation; easiest is to re-render selection class by data attribute in future,
        // but for MVP we just re-apply by comparing button text to selected transport name/id.
        btn.classList.remove("selected");
      });
      // We’ll just rebuild transportBox selection states in a simple way:
      // (Minimal; not perfect, but fine for MVP.)
      qsa(".transportCard", transportBox).forEach(btn => {
        const title = btn.querySelector(".cardTitle")?.textContent || "";
        const selTransport = Data.transportById.get(planner.transportId);
        if (selTransport && (title === (selTransport.name || selTransport.id))) btn.classList.add("selected");
      });

      // Render breakdown
      breakdownNode.innerHTML = "";
      if (!costs.ok) {
        breakdownNode.appendChild(el("div", { class: "muted", text: `Error: ${costs.reason}` }));
        return;
      }

      const netPossible = Math.round(Number(mission.baseReward || 0) - Number(costs.total || 0));

      breakdownNode.appendChild(el("div", { class: "breakLine", text: `Rental: ${fmtMoney(costs.rental)}` }));
      breakdownNode.appendChild(el("div", { class: "breakLine", text: `Origin fees: ${fmtMoney(costs.originFee)} • Destination fees: ${fmtMoney(costs.destFee)}` }));
      breakdownNode.appendChild(el("div", { class: "breakLine", text: `Route fees: ${fmtMoney(costs.routeFee)} • Route risk mod: ${costs.routeRiskMod}` }));
      breakdownNode.appendChild(el("div", { class: "breakLine", text: `Services: ${fmtMoney(costs.servicesCost)} • Services prep bonus: +${costs.servicesBonus}` }));
      breakdownNode.appendChild(el("div", { class: "breakLine", text: `Staff prep bonus: +${costs.staffBonus}` }));
      breakdownNode.appendChild(el("hr", { class: "breakHr" }));
      breakdownNode.appendChild(el("div", { class: "breakTotal", text: `Total cost now: ${fmtMoney(costs.total)}` }));
      breakdownNode.appendChild(el("div", { class: "breakLine", text: `Expected duration: ~${Math.round(durMins)} minutes (game minutes)` }));
      breakdownNode.appendChild(el("div", { class: `breakLine ${netPossible >= 0 ? "good" : "bad"}`, text: `Net (if full success): ${fmtMoney(netPossible)}` }));

      const canAfford = Game.player.money >= costs.total;
      const confirmBtn = qs("#confirmMissionBtn", content);
      if (confirmBtn) {
        confirmBtn.disabled = canAfford ? null : "true";
        confirmBtn.textContent = canAfford ? "Confirm & Start" : `Need ${fmtMoney(costs.total)}`;
      }

      // Attach computed values onto planner (used on confirm)
      planner._costs = costs;
      planner._durationMinutes = durMins;
    };

    // Confirm row
    const confirmRow = el("div", { class: "confirmRow" }, [
      el("button", { class: "btn", text: "Cancel", onclick: () => closeModal() }),
      el("button", {
        class: "btn primary",
        id: "confirmMissionBtn",
        text: "Confirm & Start",
        onclick: () => {
          const costs = planner._costs;
          if (!costs?.ok) return;
          const planning = {
            missionId: planner.missionId,
            transportId: planner.transportId,
            routeMode: planner.routeMode,
            selectedServiceIds: planner.selectedServiceIds.slice(),
            assignedStaffIds: planner.assignedStaffIds.slice(),
            costBreakdown: deepClone(costs),
            durationMinutes: planner._durationMinutes || Math.round(Number(mission.baseDurationHours || 8) * 60),
          };

          if (startMission(planning)) closeModal();
        },
      }),
    ]);

    // Assemble
    content.appendChild(summary);
    content.appendChild(transportBox);
    content.appendChild(routeBox);
    content.appendChild(servicesBox);
    content.appendChild(staffBox);
    content.appendChild(costBox);
    content.appendChild(confirmRow);

    openModal("Mission Planner", content, []);
    repaint();

    // Tutorial hook
    if (!Game.tutorial.completed && Game.tutorial.step === 1 && missionId === APP.tutorialMissionId) {
      logEntry("Tutorial: Choose Mule & Cart and confirm to start.", "info");
    }
  }

  /* ==============================
   *  GAME LOOP
   * ============================== */

  function advanceTime(deltaMs) {
    const realSeconds = deltaMs / 1000;
    const gameMinutesAdvanced = realSeconds * APP.realSecondToGameMinutes * APP.timeRateMultiplier;
    Game.world.time.totalGameMinutes += gameMinutesAdvanced;
  }

  function tick() {
    const t = nowMs();
    if (!Game._lastTickMs) Game._lastTickMs = t;
    const delta = t - Game._lastTickMs;
    Game._lastTickMs = t;

    if (!Game.dataReady || Game.fatalError) return;

    advanceTime(delta);
    updateWeatherIfDue();
    tickActiveMissions();
    tickInvestments();

    // Refresh HUD frequently
    renderTopHud();
    renderBottomHud();
  }

  /* ==============================
   *  BOOT
   * ============================== */

  function showFatalError(err) {
    Game.fatalError = err;

    // Ensure UI exists, then show a blocking modal + log.
    ensureBaseUI();
    setActiveTab("log");
    setActiveView("world");

    Game.ui.log = [];
    logEntry("FATAL: Game cannot start. Fix the issues below.", "bad");
    logEntry(String(err?.message || err), "bad");

    const msg = el("div", { class: "fatalBox" }, [
      el("p", { text: "Game failed to load required JSON data." }),
      el("p", { class: "muted", text: "Check /data/*.json exists and matches the expected schemas. Then reload." }),
      el("pre", { class: "codeBlock", text: String(err?.message || err) }),
    ]);

    openModal("Fatal Error", msg, [
      el("button", { class: "btn", text: "Close", onclick: () => closeModal() }),
    ]);
  }

  async function boot() {
    ensureBaseUI();
    setActiveView("world");
    setActiveTab("log");

    // Loading notice
    Game.ui.log = [];
    logEntry("Loading data…", "info");

    try {
      await loadAllData();
      Game.dataReady = true;
      logEntry("Data loaded.", "good");

      // New game state (or load auto if exists)
      const raw = localStorage.getItem(APP.storageKey);
      if (raw) {
        const parsed = safeJsonParse(raw);
        if (parsed?.state) {
          adoptGameState(parsed.state);
          logEntry("Loaded existing save from localStorage.", "info");
        } else {
          const fresh = makeNewGameState();
          adoptGameState(fresh);
          logEntry("Started new game (save was invalid).", "warn");
        }
      } else {
        const fresh = makeNewGameState();
        adoptGameState(fresh);
        logEntry("Started new game.", "good");
      }

      // First render
      renderAll();

      // Tutorial
      beginTutorialIfNeeded(false);

      // Start loop
      Game._lastTickMs = nowMs();
      setInterval(tick, APP.tickMs);

      Game.booted = true;

    } catch (e) {
      showFatalError(e);
    }
  }

  // Start when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

})();
