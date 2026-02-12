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
const inputHonorTarget = document.getElementById('honor-target');
const honorTargetGroup = document.getElementById('honor-target-group');
const checkboxDisableSandbox = document.getElementById('disable-sandbox');
const tabButtons = document.querySelectorAll('.tab-button');

// === Multi-Profile State ===
let currentProfile = 'profile1';

const profileState = {
    profile1: {
        isRunning: false,
        isBrowserOpen: false,
        startTime: null,
        logs: [], // Array of log objects
        stats: {
            completedQuests: 0,
            raidsCompleted: 0,
            battleCount: 0,
            avgBattleTime: 0,
            avgTurns: 0,
            battleTimes: [],
            battleTurns: []
        },
        settings: {} // Cache settings per profile
    },
    profile2: {
        isRunning: false,
        isBrowserOpen: false,
        startTime: null,
        logs: [],
        stats: {
            completedQuests: 0,
            raidsCompleted: 0,
            battleCount: 0,
            avgBattleTime: 0,
            avgTurns: 0,
            battleTimes: [],
            battleTurns: []
        },
        settings: {}
    }
};

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

// === Profile Switching Logic ===
function switchProfile(newProfileId) {
    if (newProfileId === currentProfile) return;

    // 1. Save current UI settings to state
    saveUiToState(currentProfile);

    // 2. Update active tab
    tabButtons.forEach(btn => {
        if (btn.dataset.tab === newProfileId) btn.classList.add('active');
        else btn.classList.remove('active');
    });

    // 3. Switch context
    currentProfile = newProfileId;

    // 4. Load settings from state (or defaults) to UI
    loadUiFromState(newProfileId);

    // 5. Update Status Badge & Buttons
    updateStatusDisplay();

    // 6. Refresh Logs
    refreshLogDisplay();

    // 7. Refresh Stats
    refreshStatsDisplay();

    // 8. Update Credentials UI
    loadCredentialsForProfile(newProfileId);
}

function saveUiToState(profileId) {
    profileState[profileId].settings = {
        botMode: selectBotMode.value,
        questUrl: inputQuestUrl.value,
        maxRuns: inputMaxRuns.value,
        browserType: selectBrowserType.value,
        battleMode: selectBattleMode.value,
        customSize: checkboxEnableCustom.checked,
        disableSandbox: checkboxDisableSandbox.checked,
        windowWidth: inputWindowWidth.value,
        windowHeight: inputWindowHeight.value,
        honorTarget: cleanHonorsValue(inputHonorTarget.value)
    };
}

function loadUiFromState(profileId) {
    const settings = profileState[profileId].settings || {};

    // Load defaults if empty (first run per profile)
    selectBotMode.value = settings.botMode || 'quest';
    inputQuestUrl.value = settings.questUrl || '';
    inputMaxRuns.value = settings.maxRuns || 0;
    selectBrowserType.value = settings.browserType || 'chromium';
    selectBattleMode.value = settings.battleMode || 'full_auto';
    checkboxEnableCustom.checked = settings.customSize || false;
    inputWindowWidth.value = settings.windowWidth || 500;
    inputWindowHeight.value = settings.windowHeight || 850;
    inputHonorTarget.value = formatHonorsInput(settings.honorTarget || '0');
    checkboxDisableSandbox.checked = settings.disableSandbox || false;

    updateUIForBotMode();
    updateUIForCustomSize();
}

function updateStatusDisplay() {
    const state = profileState[currentProfile];
    const isRunning = state.isRunning;

    statusBadge.className = `status-badge status-${isRunning ? 'Running' : 'Stopped'}`;
    statusBadge.textContent = isRunning ? 'Running' : 'Stopped';

    // Update buttons
    if (state.isBrowserOpen) {
        btnLaunch.textContent = 'Close Browser';
        btnLaunch.disabled = false; // Always allow closing
        btnLaunch.classList.add('btn-secondary'); // Optional styling
    } else {
        btnLaunch.textContent = 'Launch Browser';
        btnLaunch.disabled = false;
        btnLaunch.classList.remove('btn-secondary');
    }

    btnStart.disabled = isRunning || !state.isBrowserOpen;
    btnStop.disabled = !isRunning;

    // Disable inputs if running
    const inputs = [
        selectBotMode, inputQuestUrl, inputMaxRuns, selectBrowserType,
        selectBattleMode, inputHonorTarget, checkboxEnableCustom,
        inputWindowWidth, inputWindowHeight
    ];
    inputs.forEach(input => input.disabled = isRunning);
}

function refreshLogDisplay() {
    logContainer.innerHTML = ''; // Clear current
    const logs = profileState[currentProfile].logs || [];
    // Re-render last 100 logs or so to avoid lag
    logs.slice(-100).forEach(log => appendLogToDom(log));
    logContainer.scrollTop = logContainer.scrollHeight;
}

function refreshStatsDisplay() {
    const stats = profileState[currentProfile].stats;
    // Update stats UI elements using stats object
    // (Reusing existing logic but pulling from state)
    const completed = stats.battleCount || stats.completedQuests || stats.raidsCompleted || 0;
    const max = parseInt(profileState[currentProfile].settings.maxRuns) || 0; // estimate

    document.getElementById('completed-runs').textContent = completed;
    document.getElementById('avg-turns').textContent = stats.avgTurns || '0.0';

    // Recalculate time display
    let avgTimeDisplay = '--:--';
    if (stats.avgBattleTime > 0) {
        const avgMs = stats.avgBattleTime;
        const totalSeconds = Math.floor(avgMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        avgTimeDisplay = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    document.getElementById('avg-battle').textContent = avgTimeDisplay;

    // Update battle times list
    const battleTimesContainer = document.getElementById('battle-times-display');
    if (stats.battleTimes && stats.battleTimes.length > 0) {
        let html = ''; // ... build html similar to before
        // Ideally we abstract the stats HTML building into a helper
        battleTimesContainer.innerHTML = buildBattleTimesHtml(stats);
    } else {
        battleTimesContainer.innerHTML = '<div style="color: var(--text-secondary);">No battles yet</div>';
    }
}

function buildBattleTimesHtml(stats) {
    if (!stats.battleTimes || stats.battleTimes.length === 0) return '<div style="color: var(--text-secondary);">No battles yet</div>';

    const formatTime = (ms) => {
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    };

    const avgTime = formatTime(stats.avgBattleTime || 0);
    let html = `<div style="margin-bottom: 10px; color: var(--accent-green); font-weight: bold;">Average: ${avgTime}</div>`;
    html += '<div style="border-top: 1px solid var(--border); padding-top: 5px;">';

    stats.battleTimes.forEach((time, index) => {
        const formattedTime = formatTime(time);
        const turns = stats.battleTurns ? stats.battleTurns[index] : 0;
        html += `<div style="margin-bottom: 3px; color: var(--text-primary);">Battle ${index + 1}: ${formattedTime} (${turns} turns)</div>`;
    });
    html += '</div>';
    return html;
}

// Tab Click Listeners
tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const newTab = btn.dataset.tab;
        switchProfile(newTab);
    });
});

// Update loadSettings to load *all* profiles from localStorage if possible, or just init defaults
function loadSettings() {
    try {
        const saved = localStorage.getItem('ganenblue_settings_v2');
        if (saved) {
            const parsed = JSON.parse(saved);
            // Merge saved settings into profileState
            if (parsed.profile1) profileState.profile1.settings = parsed.profile1;
            if (parsed.profile2) profileState.profile2.settings = parsed.profile2;
        }

        // Load initial UI
        loadUiFromState(currentProfile);
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
}

function saveSettings() {
    // Save current UI to state first
    saveUiToState(currentProfile);

    const exportState = {
        profile1: profileState.profile1.settings,
        profile2: profileState.profile2.settings
    };
    localStorage.setItem('ganenblue_settings_v2', JSON.stringify(exportState));
}

function updateUIForBotMode() {
    const mode = selectBotMode.value;
    if (mode === 'quest') {
        questUrlGroup.style.display = 'block';
        maxRunsLabel.textContent = 'Max Quests';
        honorTargetGroup.style.display = 'none';
    } else if (mode === 'raid') {
        questUrlGroup.style.display = 'none';
        maxRunsLabel.textContent = 'Max Raids';
        honorTargetGroup.style.display = 'block';
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



// Auto-save on changes
selectBotMode.addEventListener('change', debouncedSave);
selectBrowserType.addEventListener('change', debouncedSave);
selectBattleMode.addEventListener('change', debouncedSave);
inputQuestUrl.addEventListener('input', debouncedSave);
inputMaxRuns.addEventListener('input', debouncedSave);
checkboxEnableCustom.addEventListener('change', debouncedSave);
inputWindowWidth.addEventListener('input', debouncedSave);
inputWindowHeight.addEventListener('input', debouncedSave);
inputHonorTarget.addEventListener('input', debouncedSave);
checkboxDisableSandbox.addEventListener('change', debouncedSave);

// Custom Size Toggle Handler
checkboxEnableCustom.addEventListener('change', () => {
    updateUIForCustomSize();
});

// Honor Target Formatting
function formatHonorsInput(value) {
    const numeric = value.toString().replace(/\D/g, '');
    if (!numeric) return '0';
    return parseInt(numeric, 10).toLocaleString('de-DE'); // Use de-DE or similar for dot separator
}

function cleanHonorsValue(value) {
    return value.toString().replace(/\D/g, '') || '0';
}

inputHonorTarget.addEventListener('input', (e) => {
    const cursor = e.target.selectionStart;
    const oldVal = e.target.value;
    const newVal = formatHonorsInput(e.target.value);
    e.target.value = newVal;

    // Adjust cursor position if dots were added/removed
    const diff = newVal.length - oldVal.length;
    e.target.setSelectionRange(cursor + diff, cursor + diff);
    debouncedSave();
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

// === Log Filtering ===
document.querySelectorAll('.btn-filter').forEach(btn => {
    btn.addEventListener('click', () => {
        // Toggle active button
        document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const filter = btn.dataset.filter;
        const logs = document.querySelectorAll('.log-entry');

        logs.forEach(log => {
            if (filter === 'all' || log.dataset.level === filter) {
                log.style.display = 'block';
            } else {
                log.style.display = 'none';
            }
        });

        // Auto-scroll to bottom of visible logs
        logContainer.scrollTop = logContainer.scrollHeight;
    });
});

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

// Update Tab Name Helper
function updateTabName(profileId, name) {
    if (!name) return;
    const tabBtn = document.querySelector(`.tab-button[data-tab="${profileId}"]`);
    if (tabBtn) {
        // Truncate if too long?
        tabBtn.textContent = name;
    }
}

// Save Credentials Button
const btnSaveCredentials = document.getElementById('btn-save-credentials');
const inputMobageEmail = document.getElementById('mobage-email');
const inputMobagePassword = document.getElementById('mobage-password');

btnSaveCredentials.addEventListener('click', async () => {
    const profile = currentProfile;
    const email = inputMobageEmail.value.trim();
    const password = inputMobagePassword.value.trim();

    if (!email || !password) {
        addLogToProfile(profile, { level: 'warn', message: 'Please enter both email and password', timestamp: new Date().toISOString() });
        return;
    }

    const result = await window.electronAPI.saveCredentials(profile, { email, password });

    if (result.success) {
        addLogToProfile(profile, { level: 'info', message: `[${profile}] ✓ Credentials saved successfully!`, timestamp: new Date().toISOString() });
        // Update tab name
        updateTabName(profile, email);
    } else {
        addLogToProfile(profile, { level: 'error', message: `Failed to save credentials: ${result.message}`, timestamp: new Date().toISOString() });
    }
});

// Load credentials helper
async function loadCredentialsForProfile(profileId) {
    try {
        // Clear fields first
        inputMobageEmail.value = '';
        inputMobagePassword.value = '';

        const result = await window.electronAPI.loadCredentials(profileId);

        if (result.success && result.credentials) {
            const email = result.credentials.email || '';
            inputMobageEmail.value = email;
            addLogToProfile(profileId, { level: 'info', message: `[${profileId}] ✓ Loaded saved email: ${email}`, timestamp: new Date().toISOString() });

            // Update tab name if email exists
            if (email) {
                updateTabName(profileId, email);
            }
        }
    } catch (error) {
        console.error('Error loading credentials:', error);
    }
}

// Initial Load
(async () => {
    // Load settings from local storage
    loadSettings();
    // Load credentials for initial profile
    loadCredentialsForProfile(currentProfile);

    // Also try to load credentials for the OTHER profile to update its tab name?
    // Good UX improvement:
    Object.keys(profileState).forEach(pid => {
        if (pid !== currentProfile) {
            window.electronAPI.loadCredentials(pid).then(res => {
                if (res.success && res.credentials && res.credentials.email) {
                    updateTabName(pid, res.credentials.email);
                }
            });
        }
    });
})();

// 1. Launch / Close Browser
btnLaunch.addEventListener('click', async () => {
    const profile = currentProfile;
    const currentState = profileState[profile].isBrowserOpen;

    if (currentState) {
        // CLOSE BROWSER
        if (!confirm(`Are you sure you want to close the browser for ${profile}? This will stop any running bots.`)) return;

        setButtonLoading(btnLaunch, true, 'Closing...');
        btnLaunch.disabled = true;
        addLogToProfile(profile, { level: 'info', message: `[${profile}] Closing browser...`, timestamp: new Date().toISOString() });

        const result = await window.electronAPI.closeBrowser(profile);

        setButtonLoading(btnLaunch, false);
        btnLaunch.disabled = false; // Re-enable

        if (result.success) {
            profileState[profile].isBrowserOpen = false;
            profileState[profile].isRunning = false; // Bot stops if browser closes

            // Update UI
            if (currentProfile === profile) {
                btnLaunch.textContent = 'Launch Browser';
                btnLaunch.classList.remove('btn-danger'); // Remove danger style if used
                btnStart.disabled = true;
                btnStop.disabled = true;
                updateStatusDisplay();
            }
            addLogToProfile(profile, { level: 'info', message: `[${profile}] Browser closed.`, timestamp: new Date().toISOString() });
            showToast(`[${profile}] Browser closed`, 'info');
        } else {
            addLogToProfile(profile, { level: 'error', message: `Failed to close: ${result.message}`, timestamp: new Date().toISOString() });
            showToast(`Failed to close: ${result.message}`, 'error');
        }

    } else {
        // LAUNCH BROWSER
        setButtonLoading(btnLaunch, true, 'Launching...');
        btnLaunch.disabled = true;

        // Log directly to state
        addLogToProfile(profile, { level: 'info', message: `[${profile}] Launching browser...`, timestamp: new Date().toISOString() });

        const browserType = selectBrowserType.value;
        const deviceSettings = {
            mode: checkboxEnableCustom.checked ? 'custom' : 'desktop',
            width: parseInt(inputWindowWidth.value),
            height: parseInt(inputWindowHeight.value),
            disable_sandbox: checkboxDisableSandbox.checked
        };

        const result = await window.electronAPI.launchBrowser(profile, browserType, deviceSettings);

        setButtonLoading(btnLaunch, false);

        if (result.success) {
            profileState[profile].isBrowserOpen = true;

            // Update UI only if still on same profile
            if (currentProfile === profile) {
                btnLaunch.textContent = 'Close Browser';
                btnLaunch.disabled = false; // Enable "Close" button
                showToast(`[${profile}] Browser launched!`, 'success');
                btnStart.disabled = false;
            }

            addLogToProfile(profile, { level: 'info', message: `[${profile}] Browser launched. Please login manually.`, timestamp: new Date().toISOString() });
        } else {
            addLogToProfile(profile, { level: 'error', message: `Launch failed: ${result.message}`, timestamp: new Date().toISOString() });
            showToast(`Launch failed: ${result.message}`, 'error');
            if (currentProfile === profile) {
                btnLaunch.disabled = false;
                btnLaunch.textContent = 'Launch Browser';
            }
        }
    }
});

// 2. Start Bot
btnStart.addEventListener('click', async () => {
    const profile = currentProfile;
    const botMode = selectBotMode.value;
    const settings = {
        botMode: botMode,
        questUrl: inputQuestUrl.value,
        maxRuns: inputMaxRuns.value,
        battleMode: selectBattleMode.value,
        honorTarget: parseInt(cleanHonorsValue(inputHonorTarget.value), 10) || 0
    };

    if (botMode === 'quest' && !settings.questUrl) {
        showToast('Please enter a Quest URL', 'warning');
        return;
    }

    profileState[profile].startTime = Date.now();
    profileState[profile].isRunning = true;

    if (currentProfile === profile) updateStatusDisplay();

    addLogToProfile(profile, { level: 'info', message: `[${profile}] Starting farming...`, timestamp: new Date().toISOString() });
    showToast(`[${profile}] Bot started!`, 'success');

    const result = await window.electronAPI.startBot(profile, settings);

    if (!result.success) {
        addLogToProfile(profile, { level: 'error', message: `Start failed: ${result.message}`, timestamp: new Date().toISOString() });
        profileState[profile].isRunning = false;
        if (currentProfile === profile) updateStatusDisplay();
    }
});

// Stop Bot
btnStop.addEventListener('click', async () => {
    const profile = currentProfile;
    addLogToProfile(profile, { level: 'info', message: `[${profile}] Stopping bot...`, timestamp: new Date().toISOString() });
    await window.electronAPI.stopBot(profile);

    profileState[profile].isRunning = false;
    if (currentProfile === profile) updateStatusDisplay();

    addLogToProfile(profile, { level: 'info', message: `[${profile}] Bot stopped`, timestamp: new Date().toISOString() });
});

// Log Updates
if (window.electronAPI && window.electronAPI.onLogUpdate) {
    window.electronAPI.onLogUpdate((log) => {
        // Strict Isolation Logic
        // We expect logs to be tagged with [profileId] or we infer from context if possible.
        // If the log message contains [profile1], it goes to profile1.
        // If it contains [profile2], it goes to profile2.
        // If it contains neither, we might ignore it or add to both (system logs).
        // User requested strict isolation: "log for profile 1 is only appear on profile 1"

        let targetProfile = null;

        if (log.message && typeof log.message === 'string') {
            if (log.message.includes('[profile1]')) {
                targetProfile = 'profile1';
                // Clean up the tag to avoid clutter? Optional.
            } else if (log.message.includes('[profile2]')) {
                targetProfile = 'profile2';
            }
        }

        if (targetProfile) {
            addLogToProfile(targetProfile, log);
        } else {
            // System log (no profile tag) - maybe show on active? or both?
            // Let's add to both for visibility of critical system errors
            addLogToProfile('profile1', log);
            addLogToProfile('profile2', log);
        }
    });
}

function addLogToProfile(profileId, log) {
    if (!profileState[profileId]) return;

    // Add to state
    profileState[profileId].logs.push(log);

    // Cap logs size
    if (profileState[profileId].logs.length > 500) {
        profileState[profileId].logs.shift();
    }

    // Only render if this is the CURRENTLY VIEWED profile
    if (currentProfile === profileId) {
        appendLogToDom(log);
    }
}

function appendLogToDom(log) {
    const entry = document.createElement('div');
    const level = log.level || 'info';
    entry.className = `log-entry log-level-${level}`;
    entry.dataset.level = level;

    const time = new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false });
    let message = log.message;

    // ... [existing colorization logic] ...
    // Multi-color tag mapping
    const tagColors = {
        'quest': 'quest', 'raid': 'quest', 'summon': 'quest',
        'battle': 'battle', 'turn': 'battle',
        'wait': 'wait', 'reload': 'wait', 'fa': 'wait',
        'cleared': 'success', 'summary': 'success', 'victory': 'success', 'loot': 'success', 'drop': 'success',
        'bot': 'bot'
    };

    message = message.replace(/\[(.*?)\]/g, (match, tag) => {
        const cleanTag = tag.toLowerCase().split(' ')[0];
        const colorClass = tagColors[cleanTag] || 'bot';
        return `<span class="log-tag log-tag-${colorClass}">${match}</span>`;
    });
    message = message.replace(/(successfully|✓)/gi, '<span class="log-highlight-success">$1</span>');

    entry.innerHTML = `<span class="log-time">${time}</span>${message}`;

    // Filter check
    const activeFilter = document.querySelector('.btn-filter.active').dataset.filter;
    if (activeFilter !== 'all' && activeFilter !== level) {
        entry.style.display = 'none';
    }

    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
}

function setRunningState(isRunning) {
    btnStart.disabled = isRunning;
    btnStop.disabled = !isRunning;

    statusBadge.className = `status-badge status-${isRunning ? 'Running' : 'Stopped'}`;
    statusBadge.textContent = isRunning ? 'Running' : 'Stopped';

    // Disable inputs while running
    const inputs = [
        selectBotMode,
        inputQuestUrl,
        inputMaxRuns,
        selectBrowserType,
        selectBattleMode,
        inputHonorTarget,
        checkboxEnableCustom,
        inputWindowWidth,
        inputWindowHeight
    ];

    inputs.forEach(input => {
        if (input) input.disabled = isRunning;
    });
}

// Reset Stats
btnResetStats.addEventListener('click', async () => {
    const profile = currentProfile;
    // Add reset animation class
    const statsGrid = document.getElementById('stats-grid');
    statsGrid.style.opacity = '0';
    statsGrid.style.transform = 'scale(0.98)';

    const result = await window.electronAPI.resetStats(profile);

    setTimeout(() => {
        if (result.success) {
            addLogToProfile(profile, { level: 'info', message: `[${profile}] Stats reset successfully`, timestamp: new Date().toISOString() });
            showToast('Stats reset successfully', 'success');

            // Reset local state
            profileState[profile].stats = {
                completedQuests: 0,
                raidsCompleted: 0,
                battleCount: 0,
                avgBattleTime: 0,
                avgTurns: 0,
                battleTimes: [],
                battleTurns: []
            };

            if (currentProfile === profile) {
                refreshStatsDisplay();
            }
        }
        statsGrid.style.opacity = '1';
        statsGrid.style.transform = 'scale(1)';
    }, 300);
});

// Poll for stats every second
setInterval(async () => {
    // Poll stats for ALL profiles to keep history updated even in background tab
    for (const pid of Object.keys(profileState)) {
        const result = await window.electronAPI.getStatus(pid);

        if (result.stats) {
            // Update state
            profileState[pid].stats = result.stats;
            profileState[pid].isRunning = (result.status === 'Running' || result.status === 'Paused');

            // If this is the ACTIVE profile, update the UI
            if (pid === currentProfile) {
                if (statusBadge.textContent !== result.status) {
                    updateStatusDisplay();
                }
                refreshStatsDisplay();
                updateProgressBar(
                    result.stats.battleCount || result.stats.completedQuests || result.stats.raidsCompleted || 0,
                    parseInt(profileState[pid].settings.maxRuns) || 0
                );
            }
        }
    }
}, 1000);
