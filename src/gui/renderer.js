const btnLaunch = document.getElementById('btn-launch');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnReload = document.getElementById('btn-reload');
const btnResetStats = document.getElementById('btn-reset-stats');
const statusBadge = document.getElementById('status-badge');
const logContainer = document.getElementById('log-container');
const selectBotMode = document.getElementById('bot-mode');
const selectBrowserType = document.getElementById('browser-type');
const inputQuestUrl = document.getElementById('quest-url');
const questUrlGroup = document.getElementById('quest-url-group');
const inputMaxRuns = document.getElementById('max-runs');
const maxRunsLabel = document.getElementById('max-runs-label');
const selectBattleMode = document.getElementById('battle-mode');
const statsDisplay = document.getElementById('stats-display');

// Bot Mode Change Handler
selectBotMode.addEventListener('change', () => {
    const mode = selectBotMode.value;
    if (mode === 'quest') {
        questUrlGroup.style.display = 'flex';
        maxRunsLabel.textContent = 'Max Quests';
    } else if (mode === 'raid') {
        questUrlGroup.style.display = 'none';
        maxRunsLabel.textContent = 'Max Raids';
    }
});

// 1. Launch Browser
btnLaunch.addEventListener('click', async () => {
    btnLaunch.disabled = true;
    btnLaunch.textContent = 'Browser Open';
    addLog({ level: 'info', message: 'Launching browser...', timestamp: new Date().toISOString() });

    const browserType = selectBrowserType.value;
    const result = await window.electronAPI.launchBrowser(browserType);

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
    const botMode = selectBotMode.value;
    const settings = {
        botMode: botMode,
        questUrl: inputQuestUrl.value,
        maxRuns: inputMaxRuns.value,
        battleMode: selectBattleMode.value
    };

    // Validate quest mode requires URL
    if (botMode === 'quest' && !settings.questUrl) {
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

// Reload App
btnReload.addEventListener('click', async () => {
    addLog({ level: 'info', message: 'Restarting application...', timestamp: new Date().toISOString() });
    await window.electronAPI.restartApp();
});

// Reset Stats
btnResetStats.addEventListener('click', async () => {
    const result = await window.electronAPI.resetStats();
    if (result.success) {
        addLog({ level: 'info', message: 'Stats reset successfully', timestamp: new Date().toISOString() });
        document.getElementById('battle-times-display').innerHTML = '<div style="color: #565f89;">No battles yet</div>';
        statsDisplay.innerHTML = 'Runs Completed: 0';
    }
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
    selectBotMode.disabled = isRunning;
    inputQuestUrl.disabled = isRunning;
    inputMaxRuns.disabled = isRunning;
    selectBattleMode.disabled = isRunning;
}

// Poll for stats every second if running
setInterval(async () => {
    if (statusBadge.textContent === 'Running') {
        const result = await window.electronAPI.getStatus();
        if (result.stats) {
            const botMode = selectBotMode.value;
            let completedLabel = 'Runs';
            let completed = 0;
            let max = '∞';

            if (botMode === 'quest') {
                completedLabel = 'Quests';
                completed = result.stats.questsCompleted || 0;
                max = result.stats.maxQuests || '∞';
            } else if (botMode === 'raid') {
                completedLabel = 'Raids';
                completed = result.stats.raidsCompleted || 0;
                max = result.stats.maxRaids || '∞';
            }

            statsDisplay.innerHTML = `
                ${completedLabel} Completed: ${completed} / ${max}<br>
                Status: ${result.status}
            `;

            // Update battle times display
            const battleTimesContainer = document.getElementById('battle-times-display');
            if (result.stats.battleTimes && result.stats.battleTimes.length > 0) {
                const formatTime = (ms) => {
                    const totalSeconds = Math.floor(ms / 1000);
                    const minutes = Math.floor(totalSeconds / 60);
                    const seconds = totalSeconds % 60;
                    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                };

                const avgTime = formatTime(result.stats.averageBattleTime);

                let html = `<div style="margin-bottom: 10px; color: #9ece6a; font-weight: bold;">Average: ${avgTime}</div>`;
                html += '<div style="border-top: 1px solid #2a2e3e; padding-top: 5px;">';

                result.stats.battleTimes.forEach((time, index) => {
                    const formattedTime = formatTime(time);
                    html += `<div style="margin-bottom: 3px; color: #a9b1d6;">Battle ${index + 1}: ${formattedTime}</div>`;
                });

                html += '</div>';
                battleTimesContainer.innerHTML = html;
            } else {
                battleTimesContainer.innerHTML = '<div style="color: #565f89;">No battles yet</div>';
            }
        }
    }
}, 1000);
