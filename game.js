// game.js - Main game logic for tutorial demo

let gameState = {
    credits: 500,
    selectedMission: null,
    selectedTransport: null,
    selectedServices: [],
    currentStep: "intro",
    log: [],
    inProgress: false
};

const missionTimerDuration = 10 * 1000; // 10 seconds = 1 in-game day for demo

async function loadGameData() {
    const [missions, transports, cities] = await Promise.all([
        fetch('data/missions.json').then(res => res.json()),
        fetch('data/transport.json').then(res => res.json()),
        fetch('data/cities.json').then(res => res.json())
    ]);
    gameState.missions = missions;
    gameState.transports = transports;
    gameState.cities = cities;

    initGame();
}

function initGame() {
    logMessage("You have inherited 500 crowns and a dilapidated warehouse.");
    showAvailableMissions();
    updateUI();
}

function showAvailableMissions() {
    const missionList = document.getElementById('mission-list');
    missionList.innerHTML = "";
    gameState.missions.forEach((mission, index) => {
        const el = document.createElement('div');
        el.className = "mission-card";
        el.innerHTML = `
            <h4>${mission.title}</h4>
            <p>Destination: ${mission.destination}</p>
            <p>Reward: ${mission.reward}c</p>
            <button onclick="selectMission(${index})">Plan This Mission</button>
        `;
        missionList.appendChild(el);
    });
}

function selectMission(index) {
    gameState.selectedMission = gameState.missions[index];
    logMessage("Mission selected: " + gameState.selectedMission.title);
    showTransportOptions();
}

function showTransportOptions() {
    const transportList = document.getElementById('transport-list');
    transportList.innerHTML = "<h3>Select Transport</h3>";
    gameState.transports.forEach((trans, index) => {
        const affordable = gameState.credits >= trans.rental_cost;
        const buttonLabel = affordable ? "Select" : `Need ${trans.rental_cost - gameState.credits} more`;
        const buttonState = affordable ? "" : "disabled";
        const el = document.createElement('div');
        el.className = "transport-card";
        el.innerHTML = `
            <h4>${trans.name}</h4>
            <p>Rental Cost: ${trans.rental_cost}c</p>
            <p>Speed: ${trans.speed}</p>
            <button onclick="selectTransport(${index})" ${buttonState}>${buttonLabel}</button>
        `;
        transportList.appendChild(el);
    });
}

function selectTransport(index) {
    gameState.selectedTransport = gameState.transports[index];
    logMessage("Transport selected: " + gameState.selectedTransport.name);
    confirmMission();
}

function confirmMission() {
    const totalCost = gameState.selectedTransport.rental_cost;
    if (gameState.credits < totalCost) {
        logMessage("You can't afford this transport.");
        return;
    }

    gameState.credits -= totalCost;
    gameState.inProgress = true;
    updateUI();
    logMessage("Mission launched: " + gameState.selectedMission.title);
    logMessage("En route to " + gameState.selectedMission.destination + "...");

    setTimeout(() => {
        completeMission();
    }, missionTimerDuration);
}

function completeMission() {
    const success = Math.random() < 0.9; // 90% chance of success
    if (success) {
        gameState.credits += gameState.selectedMission.reward;
        logMessage("Mission success! Received " + gameState.selectedMission.reward + " crowns.");
    } else {
        logMessage("Mission failed. Bandits stole your cargo!");
    }

    gameState.selectedMission = null;
    gameState.selectedTransport = null;
    gameState.inProgress = false;
    updateUI();
    showAvailableMissions();
}

function logMessage(msg) {
    const logBox = document.getElementById('log');
    const time = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.textContent = `[${time}] ${msg}`;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
}

function updateUI() {
    document.getElementById('credits-display').textContent = "Credits: " + gameState.credits;
}
