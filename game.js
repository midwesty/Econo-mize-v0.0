let player = {
    credits: 500,
    day: 1,
    month: 1,
    year: 1
};

let missions = [];
let transports = [];

function loadGameData() {
    Promise.all([
        fetch('data/missions.json').then(res => res.json()),
        fetch('data/transport.json').then(res => res.json())
    ]).then(([missionsData, transportData]) => {
        missions = missionsData;
        transports = transportData;
        updateHUD();
        populateMissions();
        populateTransports();
        showView("map-view");
    });
}

function updateHUD() {
    document.getElementById("hud-credits").innerText = `Credits: ${player.credits}`;
    document.getElementById("hud-time").innerText = `Date: Y${player.year} M${player.month} D${player.day}`;
    document.getElementById("hud-weather").innerText = `Weather: Sunny, Wind SE`;
}

function populateMissions() {
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
            <p><strong>Cargo:</strong> ${m.cargo}</p>
            <button class="select-btn" onclick="attemptMission(${m.id})">Attempt Mission</button>
        `;
        container.appendChild(div);
    });
}

function populateTransports() {
    const container = document.getElementById("transport-list");
    container.innerHTML = "";
    transports.forEach(t => {
        const div = document.createElement("div");
        div.className = "card";
        div.innerHTML = `
            <h4>${t.name}</h4>
            <p><strong>Cost:</strong> ${t.rental_cost}</p>
            <p><strong>Speed:</strong> ${t.speed}</p>
            <p><strong>Capacity:</strong> ${t.capacity}</p>
        `;
        container.appendChild(div);
    });
}

function attemptMission(missionId) {
    const mission = missions.find(m => m.id === missionId);
    if (!mission) return;
    
    const transport = transports.find(t => t.id === "mule");
    if (player.credits < transport.rental_cost) {
        log(`❌ Not enough credits to rent transport for: ${mission.title}`);
        return;
    }

    log(`🚚 Starting mission: ${mission.title} using Mule & Cart...`);
    player.credits -= transport.rental_cost;
    updateHUD();

    setTimeout(() => {
        player.credits += mission.reward;
        log(`✅ Mission complete: ${mission.title} - Gained ${mission.reward} credits`);
        updateHUD();
    }, 3000);
}

function log(message) {
    const logBox = document.getElementById("log");
    const line = document.createElement("div");
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
}

// View Toggling
function showView(id) {
    document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
    document.getElementById(id).classList.remove("hidden");
}

function toggleView(view) {
    showView(`${view}-view`);
}

function toggleMapView() {
    const current = document.getElementById("map-view");
    if (current.classList.contains("hidden")) {
        showView("map-view");
    } else {
        showView("missions-view");
    }
}

