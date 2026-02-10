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
const checkboxEnableCustom = document.getElementById('enable-custom-size');
const inputWindowWidth = document.getElementById('window-width');
const inputWindowHeight = document.getElementById('window-height');
const customSizeContainer = document.getElementById('custom-size-inputs');

// === Toast Notifications ===
function showToast(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icon = document.createElement('div');
    icon.className = 'toast-icon';
    const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
    };
    icon.textContent = icons[type] || icons.info;

    const messageEl = document.createElement('div');
    messageEl.className = 'toast-message';
    messageEl.textContent = message;

    toast.appendChild(icon);
    toast.appendChild(messageEl);

    const container = document.getElementById('toast-container');
    container.appendChild(toast);

    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);

    // Auto-dismiss
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// === Loading State Helpers ===
function setButtonLoading(button, isLoading, loadingText = '') {
    if (isLoading) {
        button.classList.add('loading');
        button.dataset.originalHtml = button.innerHTML;
        button.innerHTML = `<span class="spinner"></span>${loadingText || button.innerHTML}`;
    } else {
        button.classList.remove('loading');
        if (button.dataset.originalHtml) {
            button.innerHTML = button.dataset.originalHtml;
        }
    }
}

// === Progress Tracking ===
let farmingStartTime = null;

function updateProgressBar(current, max) {
    const progressSection = document.getElementById('progress-section');
    const progressFill = document.getElementById('progress-fill');
    const progressPercent = document.getElementById('progress-percent');
    const progressEta = document.getElementById('progress-eta');
    const progressRemaining = document.getElementById('progress-remaining');

    if (max > 0) {
        progressSection.style.display = 'block';
        const percent = Math.min(100, (current / max) * 100);
        progressFill.style.width = `${percent}%`;
        progressPercent.textContent = `${Math.round(percent)}%`;

        // Calculate ETA
        if (current > 0 && farmingStartTime) {
            const elapsed = Date.now() - farmingStartTime;
            const avgTimePerRun = elapsed / current;
            const remaining = max - current;
            const etaMs = remaining * avgTimePerRun;

            const etaMinutes = Math.floor(etaMs / 60000);
            const etaSeconds = Math.floor((etaMs % 60000) / 1000);
            progressEta.textContent = `Est: ${etaMinutes}m ${etaSeconds}s`;
            progressRemaining.textContent = `${remaining} remaining`;
        }
    } else {
        progressSection.style.display = 'none';
    }
}

// === Persistent Settings ===
function saveSettings() {
    const settings = {
        botMode: selectBotMode.value,
        questUrl: inputQuestUrl.value,
        maxRuns: inputMaxRuns.value,
        browserType: selectBrowserType.value,
        battleMode: selectBattleMode.value,
        customSize: checkboxEnableCustom.checked,
        windowWidth: inputWindowWidth.value,
        windowHeight: inputWindowHeight.value
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
            checkboxEnableCustom.checked = settings.customSize || false;
            inputWindowWidth.value = settings.windowWidth || 500;
            inputWindowHeight.value = settings.windowHeight || 850;

            inputWindowWidth.value = settings.windowWidth || 500;
            inputWindowHeight.value = settings.windowHeight || 850;

            // Trigger UI updates
            updateUIForBotMode();
            updateUIForCustomSize();

            // Restore Compact Mode
            if (settings.compactMode) {
                document.body.classList.add('compact-mode');
                if (btnCompact) btnCompact.textContent = '🔼';
            }

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

function updateUIForCustomSize() {
    if (checkboxEnableCustom.checked) {
        customSizeContainer.style.display = 'block';
    } else {
        customSizeContainer.style.display = 'none';
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
checkboxEnableCustom.addEventListener('change', debouncedSave);
inputWindowWidth.addEventListener('input', debouncedSave);
inputWindowHeight.addEventListener('input', debouncedSave);

// Custom Size Toggle Handler
checkboxEnableCustom.addEventListener('change', () => {
    updateUIForCustomSize();
});

// Bot Mode Change Handler
selectBotMode.addEventListener('change', () => {
    updateUIForBotMode();
});

// === Input Validation ===
function validateQuestUrl(url) {
    if (!url) return true;// Empty is valid
    return url.startsWith('http://game.granbluefantasy.jp/') || url.startsWith('https://game.granbluefantasy.jp/');
}

// Real-time URL validation
inputQuestUrl.addEventListener('input', (e) => {
    const url = e.target.value.trim();
    const errorEl = document.getElementById('quest-url-error');

    if (url && !validateQuestUrl(url)) {
        inputQuestUrl.classList.add('input-error');
        inputQuestUrl.classList.remove('input-success');
        errorEl.classList.add('show');
    } else if (url) {
        inputQuestUrl.classList.remove('input-error');
        inputQuestUrl.classList.add('input-success');
        errorEl.classList.remove('show');
    } else {
        inputQuestUrl.classList.remove('input-error', 'input-success');
        errorEl.classList.remove('show');
    }
});

// === Collapsible Sections ===
// === Collapsible Sections ===
function toggleSection(sectionName) {
    const content = document.getElementById(`${sectionName}-content`);
    const chevron = document.getElementById(`${sectionName}-chevron`);

    if (content.classList.contains('open')) {
        content.classList.remove('open');
        chevron.textContent = '▼';
    } else {
        content.classList.add('open');
        chevron.textContent = '▲';
    }
}
window.toggleSection = toggleSection;

// Legacy support for toggleCredentials (if called directly)
window.toggleCredentials = () => toggleSection('credentials');

// === Compact Mode Toggle ===
const btnCompact = document.getElementById('btn-compact');
btnCompact.addEventListener('click', () => {
    document.body.classList.toggle('compact-mode');
    const isCompact = document.body.classList.contains('compact-mode');
    btnCompact.textContent = isCompact ? '🔼' : '👁️';

    // Save state
    const currentSettings = JSON.parse(localStorage.getItem('ganenblue_settings') || '{}');
    currentSettings.compactMode = isCompact;
    localStorage.setItem('ganenblue_settings', JSON.stringify(currentSettings));
});

// === Legacy Support ===
// Keeping this for potential future restoring if needed, but listeners are removed as per request.

// === Interactive Status Badge ===
// === Interactive Status Badge ===
statusBadge.addEventListener('click', () => {
    console.log('Status badge clicked');
    const currentStatus = statusBadge.textContent.trim();

    if (currentStatus === 'Stopped') {
        // Check if browser is launched
        if (btnStart.disabled) {
            console.log('Cannot start: Browser not launched');
            showToast('Please launch browser first', 'warning');
            return;
        }

        // Confirm Start
        if (confirm('Start farming?')) {
            btnStart.click();
        }
    } else if (currentStatus === 'Running' || currentStatus === 'Paused') {
        // Confirm Stop
        if (confirm('Stop the bot?')) {
            btnStop.click();
        }
    }
});

// === Sound Playback ===
if (window.electronAPI && window.electronAPI.onPlaySound) {
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
}

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
        console.log('Loading saved credentials...');
        const result = await window.electronAPI.loadCredentials();

        if (result.success && result.credentials) {
            // Only load email, keep password empty for security
            inputMobageEmail.value = result.credentials.email || '';
            // Don't log email or password
            addLog({ level: 'info', message: `[Login] ✓ Loaded saved email: ${result.credentials.email}`, timestamp: new Date().toISOString() });
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
    setButtonLoading(btnLaunch, true, 'Launching...');
    btnLaunch.disabled = true;
    addLog({ level: 'info', message: '[Login] Launching browser...', timestamp: new Date().toISOString() });

    const browserType = selectBrowserType.value;
    const deviceSettings = {
        mode: checkboxEnableCustom.checked ? 'custom' : 'desktop',
        width: parseInt(inputWindowWidth.value),
        height: parseInt(inputWindowHeight.value)
    };

    const result = await window.electronAPI.launchBrowser(browserType, deviceSettings);

    setButtonLoading(btnLaunch, false);

    if (result.success) {
        btnLaunch.textContent = 'Browser Open';
        addLog({ level: 'info', message: '[Login] Browser launched. Please login manually.', timestamp: new Date().toISOString() });
        showToast('Browser launched successfully!', 'success');
        btnStart.disabled = false;

        // Hide credentials section after browser launches
        const credSection = document.getElementById('credentials-section');
        if (credSection) {
            credSection.style.display = 'none';
        }
    } else {
        addLog({ level: 'error', message: `Launch failed: ${result.message}`, timestamp: new Date().toISOString() });
        showToast(`Launch failed: ${result.message}`, 'error');
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
        showToast('Please enter a Quest URL', 'warning');
        return;
    }

    farmingStartTime = Date.now();
    setRunningState(true);
    startTimer(); // Start elapsed timer
    addLog({ level: 'info', message: 'Starting farming...', timestamp: new Date().toISOString() });
    showToast('Bot started successfully!', 'success');

    const result = await window.electronAPI.startBot(settings);

    if (!result.success) {
        addLog({ level: 'error', message: `Start failed: ${result.message}`, timestamp: new Date().toISOString() });
        showToast(`Start failed: ${result.message}`, 'error');
        setRunningState(false);
        stopTimer(); // Stop timer if failed
        farmingStartTime = null;
    }
});

// Stop Bot
btnStop.addEventListener('click', async () => {
    addLog({ level: 'info', message: 'Stopping bot...', timestamp: new Date().toISOString() });
    await window.electronAPI.stopBot();
    setRunningState(false);
    stopTimer(); // Stop elapsed timer
    farmingStartTime = null;

    // Reset state
    // btnLaunch.disabled = false; // Keep browser button disabled as browser is open
    // btnStart.disabled = true;   // ERROR: This was disabling start. Remove it.

    // Ensure Start is enabled for next run
    btnStart.disabled = false;
    // Removed manual textContent assignment that was causing overlap glitch

    addLog({ level: 'info', message: 'Bot stopped', timestamp: new Date().toISOString() });
    showToast('Bot stopped', 'info');
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
        showToast('Stats reset successfully', 'success');
        document.getElementById('battle-times-display').innerHTML = '<div style="color: var(--text-secondary);">No battles yet</div>';
        document.getElementById('completed-runs').textContent = '0';
        document.getElementById('avg-battle').textContent = '--:--';
        document.getElementById('avg-turns').textContent = '0.0'; // Reset avg-turns
        document.getElementById('runs-per-hour').textContent = '0.0';
        farmingStartTime = null;
    }
});

// Log Updates
if (window.electronAPI && window.electronAPI.onLogUpdate) {
    window.electronAPI.onLogUpdate((log) => {
        addLog(log);
    });
}

function addLog(log) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const time = new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const levelClass = `log-level-${log.level}`;

    let message = log.message;

    // Multi-color tag mapping
    const tagColors = {
        'quest': 'quest', 'raid': 'quest', 'summon': 'quest',
        'battle': 'battle', 'turn': 'battle',
        'wait': 'wait', 'reload': 'wait', 'fa': 'wait',
        'cleared': 'success', 'summary': 'success', 'victory': 'success', 'loot': 'success', 'drop': 'success',
        'bot': 'bot'
    };

    // Replace all bracketed tags with colorized spans
    message = message.replace(/\[(.*?)\]/g, (match, tag) => {
        const cleanTag = tag.toLowerCase().split(' ')[0]; // Handle [Turn 1] -> turn
        const colorClass = tagColors[cleanTag] || 'bot';
        return `<span class="log-tag log-tag-${colorClass}">${match}</span>`;
    });

    // Highlight Keywords (remaining text highlights)
    message = message.replace(/(successfully|✓)/gi, '<span class="log-highlight-success">$1</span>');

    entry.innerHTML = `
        <span class="log-time">${time}</span>
        <span class="${levelClass}"></span>
        ${message}
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
            // Update completed runs (Battles Done)
            // Prioritize battleCount for "Battles Done" display
            const completed = result.stats.battleCount || result.stats.completedQuests || result.stats.raidsCompleted || 0;
            const max = result.stats.maxRuns || 0;
            const completedLabel = result.stats.botMode === 'raid' ? 'Raids Done' : 'Battles Done';

            // Update completed runs
            document.getElementById('completed-runs').textContent = max > 0 ? `${completed} / ${max}` : completed;
            document.getElementById('completed-label').textContent = completedLabel;

            // Update Avg Turns
            document.getElementById('avg-turns').textContent = result.stats.avgTurns || '0.0';

            // Calculate average time display
            let avgTimeDisplay = '--:--';
            if (result.stats.avgBattleTime > 0) {
                const avgMs = result.stats.avgBattleTime;
                const totalSeconds = Math.floor(avgMs / 1000);
                const minutes = Math.floor(totalSeconds / 60);
                const seconds = totalSeconds % 60;
                avgTimeDisplay = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            }
            document.getElementById('avg-battle').textContent = avgTimeDisplay;

            // Calculate runs per hour: 60 / (avgBattleTime + 15 sec buffer)
            if (result.stats.avgBattleTime > 0) {
                const avgMin = result.stats.avgBattleTime / 60000;
                const perHour = (60 / (avgMin + 0.25)).toFixed(1);
                document.getElementById('runs-per-hour').textContent = perHour;
            } else {
                document.getElementById('runs-per-hour').textContent = '0.0';
            }

            // Update progress bar
            updateProgressBar(completed, max);

            // Update battle times display
            const battleTimesContainer = document.getElementById('battle-times-display');
            if (result.stats.battleTimes && result.stats.battleTimes.length > 0) {
                const formatTime = (ms) => {
                    const totalSeconds = Math.floor(ms / 1000);
                    const minutes = Math.floor(totalSeconds / 60);
                    const seconds = totalSeconds % 60;
                    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                };

                const avgTime = formatTime(result.stats.avgBattleTime);

                let html = `<div style="margin-bottom: 10px; color: var(--accent-green); font-weight: bold;">Average: ${avgTime}</div>`;
                html += '<div style="border-top: 1px solid var(--border); padding-top: 5px;">';

                result.stats.battleTimes.forEach((time, index) => {
                    const formattedTime = formatTime(time);
                    const turns = result.stats.battleTurns ? result.stats.battleTurns[index] : 0;
                    html += `<div style="margin-bottom: 3px; color: var(--text-primary);">Battle ${index + 1}: ${formattedTime} (${turns} turns)</div>`;
                });

                html += '</div>';
                battleTimesContainer.innerHTML = html;
            } else {
                battleTimesContainer.innerHTML = '<div style="color: var(--text-secondary);">No battles yet</div>';
            }
        }
    }
}, 1000);
