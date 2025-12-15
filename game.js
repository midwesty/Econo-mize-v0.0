// === GLOBAL GAME STATE ===
const player = {
    credits: 500,
    day: 1,
    month: 1,
    year: 1,
    staff: [],
    log: [],
};

let missions = [];
let transports = [];
let services = [];
let staffPool = [];

function initGame() {
    initDummyData(); // temporary until JSON
    updateHUD();
    renderMissions();
    renderTransports();
    renderStaff();
    renderServices();
    logMessage("Game started. Welcome, entrepreneur.");
}

// === HUD AND UTILITY ===
function updateHUD() {
    document.getElementById("hud-credits").innerText = `Credits: ${player.credits}`;
    document.getElementById("hud-time").innerText = `Date: Y${player.year} M${player.month} D${player.day}`;
    document.getElementById("hud-weather").innerText = `Weather: Sunny, Wind SE`;
    updateNotif("HUD Updated.");
}

function updateNotif(msg) {
    document.getElementById("notif-msg").innerText = msg;
}

// === PANEL TOGGLING ===
function togglePanel(panel) {
    const panels = document.querySelectorAll(".panel");
    panels.forEach(p => p.classList.remove("active"));
    const selected = document.getElementById(`${panel}-panel`);
    if (selected) {
        selected.classList.add("active");
        updateNotif(`Switched to ${panel} panel.`);
    }
}

// === LOGGING ===
function logMessage(message) {
    const logBox = document.getElementById("log-box");
    const entry = document.createElement("div");
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logBox.appendChild(entry);
    logBox.scrollTop = logBox.scrollHeight;
}

// === RENDER FUNCTIONS ===

function renderMissions() {
    const container = document.getElementById("mission-list");
    container.innerHTML = "";
    missions.forEach(m => {
        const div = document.createElement("div");
        div.className = "card";
        div.innerHTML = `
            <h4>${m.title}</h4>
            <p><strong>Origin:</strong> ${m.origin}</p>
            <p><strong>Destination:</strong> ${m.destination}</p>
            <p><strong>Reward:</strong> ${m.reward} credits</p>
            <p><strong>Transport Type:</strong> ${m.transport_required}</p>
            <button onclick="acceptMission('${m.id}')">Accept Mission</button>
        `;
        container.appendChild(div);
    });
}

function renderTransports() {
    const container = document.getElementById("transport-list");
    container.innerHTML = "";
    transports.forEach(t => {
        const div = document.createElement("div");
        div.className = "card";
        div.innerHTML = `
            <h4>${t.name}</h4>
            <p>Type: ${t.type}</p>
            <p>Cost: ${t.rental_cost} credits</p>
            <p>Speed: ${t.speed}</p>
            <p>Capacity: ${t.capacity}</p>
        `;
        container.appendChild(div);
    });
}

function renderStaff() {
    const container = document.getElementById("staff-list");
    container.innerHTML = "";
    staffPool.forEach(s => {
        const div = document.createElement("div");
        div.className = "card";
        div.innerHTML = `
            <h4>${s.name}</h4>
            <p>Role: ${s.role}</p>
            <p>Skill: ${s.skill}</p>
            <p>Wage: ${s.wage} credits</p>
            <button onclick="hireStaff('${s.id}')">Hire</button>
        `;
        container.appendChild(div);
    });
}

function renderServices() {
    const container = document.getElementById("services-list");
    container.innerHTML = `
        <div class="card">
            <h4>Weather Forecast</h4>
            <p>Cost: 10 credits</p>
            <button onclick="buyForecast()">Buy Forecast</button>
        </div>
        <div class="card">
            <h4>Map Upgrade</h4>
            <p>Cost: 50 credits</p>
            <button onclick="buyMapUpgrade()">Purchase</button>
        </div>
    `;
}

// === ACTIONS ===

function acceptMission(id) {
    const m = missions.find(m => m.id === id);
    if (!m) return;

    const t = transports.find(t => t.type === m.transport_required);
    if (!t || player.credits < t.rental_cost) {
        logMessage(`Not enough credits or no ${m.transport_required} available.`);
        return;
    }

    player.credits -= t.rental_cost;
    updateHUD();
    logMessage(`Accepted mission "${m.title}" using ${t.name}.`);

    setTimeout(() => {
        player.credits += m.reward;
        logMessage(`✅ Mission "${m.title}" completed. +${m.reward} credits`);
        updateHUD();
    }, 3000);
}

function hireStaff(id) {
    const s = staffPool.find(s => s.id === id);
    if (!s || player.credits < s.wage) {
        logMessage("Not enough credits to hire staff.");
        return;
    }
    player.credits -= s.wage;
    player.staff.push(s);
    staffPool = staffPool.filter(st => st.id !== id);
    updateHUD();
    renderStaff();
    logMessage(`Hired ${s.name} as ${s.role}.`);
}

function buyForecast() {
    if (player.credits < 10) {
        logMessage("Insufficient credits for forecast.");
        return;
    }
    player.credits -= 10;
    updateHUD();
    logMessage("Bought detailed weather forecast: Wind NE, light rain expected tomorrow.");
}

function buyMapUpgrade() {
    if (player.credits < 50) {
        logMessage("Insufficient credits for map upgrade.");
        return;
    }
    player.credits -= 50;
    updateHUD();
    logMessage("Installed upgraded map view. More towns visible.");
}

// === TEMP DATA ===

function initDummyData() {
    missions = [
        {
            id: "m1",
            title: "Deliver Pig Dung",
            origin: "Cattleford",
            destination: "Oatmere",
            reward: 150,
            transport_required: "mule"
        },
        {
            id: "m2",
            title: "Move Tools & Sacks",
            origin: "Millhaven",
            destination: "Brickle Bay",
            reward: 220,
            transport_required: "train"
        }
    ];

    transports = [
        {
            id: "t1",
            name: "Cart & Mule",
            type: "mule",
            rental_cost: 50,
            speed: "Slow",
            capacity: "Light"
        },
        {
            id: "t2",
            name: "Cargo Train",
            type: "train",
            rental_cost: 120,
            speed: "Medium",
            capacity: "Heavy"
        }
    ];

    staffPool = [
        {
            id: "s1",
            name: "Billy Smokes",
            role: "Cart Driver",
            skill: "Navigation",
            wage: 30
        },
        {
            id: "s2",
            name: "Edna Brakes",
            role: "Engineer",
            skill: "Maintenance",
            wage: 60
        }
    ];
}
