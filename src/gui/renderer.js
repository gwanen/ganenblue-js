const btnLaunch = document.getElementById('btn-launch');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const statusBadge = document.getElementById('status-badge');
const logContainer = document.getElementById('log-container');
const inputQuestUrl = document.getElementById('quest-url');
const inputMaxQuests = document.getElementById('max-quests');
const selectBattleMode = document.getElementById('battle-mode');
const statsDisplay = document.getElementById('stats-display');

// 1. Launch Browser
btnLaunch.addEventListener('click', async () => {
    btnLaunch.disabled = true;
    btnLaunch.textContent = 'Browser Open';
    addLog({ level: 'info', message: 'Launching browser...', timestamp: new Date().toISOString() });

    const result = await window.electronAPI.launchBrowser();

    if (result.success) {
        addLog({ level: 'info', message: 'Browser launched. Please login manually.', timestamp: new Date().toISOString() });
        btnStart.disabled = false;
    } else {
        addLog({ level: 'error', message: `Launch failed: ${result.message}`, timestamp: new Date().toISOString() });
        btnLaunch.disabled = false;
        btnLaunch.textContent = '1. Open Browser';
    }
});

// 2. Start Bot
btnStart.addEventListener('click', async () => {
    const settings = {
        questUrl: inputQuestUrl.value,
        maxQuests: inputMaxQuests.value,
        battleMode: selectBattleMode.value
    };

    if (!settings.questUrl) {
        addLog({ level: 'warn', message: 'Please enter a Quest URL', timestamp: new Date().toISOString() });
        return;
    }

    setRunningState(true);
    addLog({ level: 'info', message: 'Starting farming...', timestamp: new Date().toISOString() });

    const result = await window.electronAPI.startBot(settings);

    if (!result.success) {
        addLog({ level: 'error', message: `Start failed: ${result.message}`, timestamp: new Date().toISOString() });
        setRunningState(false);
    }
});

// Stop Bot
btnStop.addEventListener('click', async () => {
    addLog({ level: 'info', message: 'Stopping bot...', timestamp: new Date().toISOString() });
    await window.electronAPI.stopBot();
    setRunningState(false);

    // Reset state
    // btnLaunch.disabled = false; // Keep browser button disabled as browser is open
    // btnStart.disabled = true;   // ERROR: This was disabling start. Remove it.

    // Ensure Start is enabled for next run
    btnStart.disabled = false;
    btnStart.textContent = '2. Start Farming';

    addLog({ level: 'info', message: 'Bot stopped', timestamp: new Date().toISOString() });
});

// Log Updates
window.electronAPI.onLogUpdate((log) => {
    addLog(log);
});

function addLog(log) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const time = new Date(log.timestamp).toLocaleTimeString();
    const levelClass = `log-level-${log.level}`;

    entry.innerHTML = `
        <span class="log-time">[${time}]</span>
        <span class="${levelClass}">${log.level.toUpperCase()}:</span>
        ${log.message}
    `;

    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
}

function setRunningState(isRunning) {
    btnStart.disabled = isRunning;
    btnStop.disabled = !isRunning;

    statusBadge.className = `status-badge status-${isRunning ? 'Running' : 'Stopped'}`;
    statusBadge.textContent = isRunning ? 'Running' : 'Stopped';

    // Disable inputs while running
    inputQuestUrl.disabled = isRunning;
    inputMaxQuests.disabled = isRunning;
    selectBattleMode.disabled = isRunning;
}

// Poll for stats every second if running
setInterval(async () => {
    if (statusBadge.textContent === 'Running') {
        const result = await window.electronAPI.getStatus();
        if (result.stats) {
            statsDisplay.innerHTML = `
                Quests Completed: ${result.stats.questsCompleted} / ${result.stats.maxQuests || '∞'}<br>
                Status: ${result.status}
            `;
        }
    }
}, 1000);
