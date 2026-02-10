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

// === Persistent Settings ===
function saveSettings() {
    const settings = {
        botMode: selectBotMode.value,
        questUrl: inputQuestUrl.value,
        maxRuns: inputMaxRuns.value,
        browserType: selectBrowserType.value,
        battleMode: selectBattleMode.value
    };
    localStorage.setItem('ganenblue_settings', JSON.stringify(settings));
}

function loadSettings() {
    try {
        const saved = localStorage.getItem('ganenblue_settings');
        if (saved) {
            const settings = JSON.parse(saved);
            selectBotMode.value = settings.botMode || 'quest';
            inputQuestUrl.value = settings.questUrl || '';
            inputMaxRuns.value = settings.maxRuns || 0;
            selectBrowserType.value = settings.browserType || 'chromium';
            selectBattleMode.value = settings.battleMode || 'full_auto';

            // Trigger UI updates for bot mode
            updateUIForBotMode();
        }
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
}

function updateUIForBotMode() {
    const mode = selectBotMode.value;
    if (mode === 'quest') {
        questUrlGroup.style.display = 'flex';
        maxRunsLabel.textContent = 'Max Quests';
    } else if (mode === 'raid') {
        questUrlGroup.style.display = 'none';
        maxRunsLabel.textContent = 'Max Raids';
    }
}

// Debounced save to avoid excessive writes
let saveTimeout;
function debouncedSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveSettings(), 500);
}

// Load settings on startup
window.addEventListener('DOMContentLoaded', () => {
    loadSettings();
});

// Auto-save on changes
selectBotMode.addEventListener('change', debouncedSave);
selectBrowserType.addEventListener('change', debouncedSave);
selectBattleMode.addEventListener('change', debouncedSave);
inputQuestUrl.addEventListener('input', debouncedSave);
inputMaxRuns.addEventListener('input', debouncedSave);

// Bot Mode Change Handler
selectBotMode.addEventListener('change', () => {
    updateUIForBotMode();
});

// === Sound Playback ===
window.electronAPI.onPlaySound((soundType) => {
    // Simple beep using Web Audio API (no external files needed)
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        // Notification sound: 2 quick beeps
        oscillator.frequency.value = 800;
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);

        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.1);

        // Second beep
        const oscillator2 = audioContext.createOscillator();
        const gainNode2 = audioContext.createGain();
        oscillator2.connect(gainNode2);
        gainNode2.connect(audioContext.destination);
        oscillator2.frequency.value = 1000;
        gainNode2.gain.setValueAtTime(0.3, audioContext.currentTime + 0.15);
        gainNode2.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.25);
        oscillator2.start(audioContext.currentTime + 0.15);
        oscillator2.stop(audioContext.currentTime + 0.25);
    } catch (error) {
        console.error('Sound playback failed:', error);
    }
});

// Save Credentials Button
const btnSaveCredentials = document.getElementById('btn-save-credentials');
const inputMobageEmail = document.getElementById('mobage-email');
const inputMobagePassword = document.getElementById('mobage-password');

btnSaveCredentials.addEventListener('click', async () => {
    const email = inputMobageEmail.value.trim();
    const password = inputMobagePassword.value.trim();

    if (!email || !password) {
        addLog({ level: 'warn', message: 'Please enter both email and password', timestamp: new Date().toISOString() });
        return;
    }

    const result = await window.electronAPI.saveCredentials({ email, password });

    if (result.success) {
        addLog({ level: 'info', message: '✓ Credentials saved successfully!', timestamp: new Date().toISOString() });
    } else {
        addLog({ level: 'error', message: `Failed to save credentials: ${result.message}`, timestamp: new Date().toISOString() });
    }
});

// Load credentials on startup
(async () => {
    try {
        console.log('Loading credentials...');
        const result = await window.electronAPI.loadCredentials();
        console.log('Load result:', result);

        if (result.success && result.credentials) {
            // Only load email, keep password empty for security
            inputMobageEmail.value = result.credentials.email || '';
            console.log('Email loaded:', inputMobageEmail.value);
            // Don't populate password - user must re-enter for privacy
            addLog({ level: 'info', message: `✓ Loaded saved email: ${result.credentials.email}`, timestamp: new Date().toISOString() });
        } else {
            console.log('No credentials found or load failed');
            addLog({ level: 'info', message: 'No saved credentials found', timestamp: new Date().toISOString() });
        }
    } catch (error) {
        console.error('Error loading credentials:', error);
        addLog({ level: 'error', message: `Failed to load credentials: ${error.message}`, timestamp: new Date().toISOString() });
    }
})();

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

        // Hide credentials section after browser launches
        const credSection = document.getElementById('credentials-section');
        if (credSection) {
            credSection.style.display = 'none';
        }
    } else {
        addLog({ level: 'error', message: `Launch failed: ${result.message}`, timestamp: new Date().toISOString() });
        btnLaunch.disabled = false;
        btnLaunch.textContent = 'Launch Browser';
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
    startTimer(); // Start elapsed timer
    addLog({ level: 'info', message: 'Starting farming...', timestamp: new Date().toISOString() });

    const result = await window.electronAPI.startBot(settings);

    if (!result.success) {
        addLog({ level: 'error', message: `Start failed: ${result.message}`, timestamp: new Date().toISOString() });
        setRunningState(false);
        stopTimer(); // Stop timer if failed
    }
});

// Stop Bot
btnStop.addEventListener('click', async () => {
    addLog({ level: 'info', message: 'Stopping bot...', timestamp: new Date().toISOString() });
    await window.electronAPI.stopBot();
    setRunningState(false);
    stopTimer(); // Stop elapsed timer

    // Reset state
    // btnLaunch.disabled = false; // Keep browser button disabled as browser is open
    // btnStart.disabled = true;   // ERROR: This was disabling start. Remove it.

    // Ensure Start is enabled for next run
    btnStart.disabled = false;
    btnStart.textContent = '2. Start Farming';

    addLog({ level: 'info', message: 'Bot stopped', timestamp: new Date().toISOString() });
});

// Timer functionality
let timerInterval = null;
let startTime = null;

function startTimer() {
    startTime = Date.now();
    timerInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function updateTimer() {
    if (!startTime) return;

    const elapsed = Date.now() - startTime;
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);

    const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    document.getElementById('elapsed-time').textContent = timeString;
}

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
            const completed = result.stats.completedRuns || result.stats.completedQuests || 0;
            const max = result.stats.maxRuns || '∞';
            const completedLabel = result.stats.botMode === 'raid' ? 'Raids' : 'Quests';

            // Calculate average time display
            let avgTimeDisplay = 'N/A';
            if (result.stats.battleTimes && result.stats.battleTimes.length > 0) {
                const avgMs = result.stats.averageBattleTime;
                const totalSeconds = Math.floor(avgMs / 1000);
                const minutes = Math.floor(totalSeconds / 60);
                const seconds = totalSeconds % 60;
                avgTimeDisplay = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            }

            statsDisplay.innerHTML = `
                <div style="margin-bottom: 8px;"><strong>Elapsed Time:</strong> <span id="elapsed-time">${document.getElementById('elapsed-time')?.textContent || '00:00:00'}</span></div>
                <div style="margin-bottom: 8px;"><strong>Avg Battle:</strong> ${avgTimeDisplay}</div>
                <div>${completedLabel} Completed: ${completed} / ${max}</div>
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

                let html = `<div style="margin-bottom: 10px; color: var(--accent-green); font-weight: bold;">Average: ${avgTime}</div>`;
                html += '<div style="border-top: 1px solid var(--border); padding-top: 5px;">';

                result.stats.battleTimes.forEach((time, index) => {
                    const formattedTime = formatTime(time);
                    html += `<div style="margin-bottom: 3px; color: var(--text-primary);">Battle ${index + 1}: ${formattedTime}</div>`;
                });

                html += '</div>';
                battleTimesContainer.innerHTML = html;
            } else {
                battleTimesContainer.innerHTML = '<div style="color: var(--text-secondary);">No battles yet</div>';
            }
        }
    }
}, 1000);
