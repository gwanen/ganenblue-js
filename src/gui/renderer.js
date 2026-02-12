// === Multi-Profile Renderer Logic ===

const profiles = ['p1', 'p2'];

const profileState = {
    p1: {
        isRunning: false,
        isBrowserOpen: false,
        startTime: null,
        stats: { completed: 0, battleCount: 0, avgBattleTime: 0 },
        settings: {}
    },
    p2: {
        isRunning: false,
        isBrowserOpen: false,
        startTime: null,
        stats: { completed: 0, battleCount: 0, avgBattleTime: 0 },
        settings: {}
    }
};

// === DOM Elements Cache ===
const dom = {
    global: {
        btnShowLogs: document.getElementById('btn-show-logs'),
        btnCloseLogs: document.getElementById('btn-close-logs'),
        btnClearLogs: document.getElementById('btn-clear-logs'),
        logsPanel: document.getElementById('logs-panel'),
        logContainer: document.getElementById('log-container'),
        btnToggleP2: document.getElementById('btn-toggle-p2'),
        globalStatus: document.getElementById('global-status')
    },
    p1: null,
    p2: null
};

// Defer DOM fetching until DOMContentLoaded
function initDomCache() {
    dom.p1 = getProfileElements('p1');
    dom.p2 = getProfileElements('p2');
}

function getProfileElements(pid) {
    return {
        // Name Input
        nameInput: document.getElementById(`profile-name-${pid}`),
        // Buttons
        btnLaunch: document.getElementById(`btn-launch-${pid}`),
        btnStart: document.getElementById(`btn-start-${pid}`),
        btnStop: document.getElementById(`btn-stop-${pid}`),
        btnReset: document.getElementById(`btn-reset-stats-${pid}`),
        statusBadge: document.getElementById(`status-badge-${pid}`),
        // Settings
        mode: document.getElementById(`bot-mode-${pid}`),
        questUrl: document.getElementById(`quest-url-${pid}`),
        questUrlGroup: document.getElementById(`quest-url-group-${pid}`),
        questUrlError: document.getElementById(`quest-url-error-${pid}`),
        honorTarget: document.getElementById(`honor-target-${pid}`),
        honorGroup: document.getElementById(`honor-target-group-${pid}`),
        maxRuns: document.getElementById(`max-runs-${pid}`),
        maxRunsLabel: document.getElementById(`max-runs-label-${pid}`),
        battleMode: document.getElementById(`battle-mode-${pid}`),
        // Browser Settings
        browserType: document.getElementById(`browser-type-${pid}`),
        disableSandbox: document.getElementById(`disable-sandbox-${pid}`),
        // Stats
        statCompleted: document.getElementById(`completed-runs-${pid}`),
        statAvgBattle: document.getElementById(`avg-battle-${pid}`),
        statRunTimer: document.getElementById(`run-timer-${pid}`),
        statAvgTurns: document.getElementById(`avg-turns-${pid}`),
        statRunRate: document.getElementById(`run-rate-${pid}`),
        // Credentials
        email: document.getElementById(`mobage-email-${pid}`),
        password: document.getElementById(`mobage-password-${pid}`),
        btnSaveCreds: document.getElementById(`btn-save-credentials-${pid}`)
    };
}

// === Initialization ===
document.addEventListener('DOMContentLoaded', async () => {
    initDomCache();

    // Load Settings & Credentials
    loadGlobalSettings();

    for (const pid of profiles) {
        await loadProfileSettings(pid);
        await loadCredentials(pid);
        setupProfileListeners(pid);
        updateProfileUI(pid);
    }

    setupGlobalListeners();
});

// === Profile Logic ===

function setupProfileListeners(pid) {
    const els = dom[pid];

    // Launch Browser
    els.btnLaunch.addEventListener('click', async () => {
        if (profileState[pid].isBrowserOpen) {
            if (!confirm(`Close browser for ${pid}?`)) return;
            setLoading(els.btnLaunch, true, 'Closing...');
            await window.electronAPI.closeBrowser(pid);
            profileState[pid].isBrowserOpen = false;
            profileState[pid].isRunning = false;
            log(pid, 'Browser closed', 'info');
            setLoading(els.btnLaunch, false);
        } else {
            setLoading(els.btnLaunch, true, 'Launching...');
            const browserType = els.browserType ? els.browserType.value : 'chromium';
            const settings = {
                width: 500,
                height: 850,
                disable_sandbox: els.disableSandbox ? els.disableSandbox.checked : false
            };

            const res = await window.electronAPI.launchBrowser(pid, browserType, settings);
            setLoading(els.btnLaunch, false);
            if (res.success) {
                profileState[pid].isBrowserOpen = true;
                log(pid, `Browser launched (${browserType})`, 'success');
            } else {
                log(pid, `Launch failed: ${res.message}`, 'error');
            }
        }
        updateProfileUI(pid);
    });

    // Start Bot
    els.btnStart.addEventListener('click', async () => {
        const settings = {
            botMode: els.mode.value,
            questUrl: els.questUrl.value.trim(),
            maxRuns: els.maxRuns.value,
            battleMode: els.battleMode.value,
            honorTarget: els.honorTarget.value
        };

        if (settings.botMode === 'quest' && !settings.questUrl) {
            showToast('Quest URL required', 'error');
            return;
        }

        profileState[pid].isRunning = true;
        profileState[pid].startTime = Date.now();
        updateProfileUI(pid);
        log(pid, 'Starting bot...', 'info');

        const res = await window.electronAPI.startBot(pid, settings);
        if (!res.success) {
            profileState[pid].isRunning = false;
            updateProfileUI(pid);
            log(pid, `Start failed: ${res.message}`, 'error');
        }
    });

    // Stop Bot
    els.btnStop.addEventListener('click', async () => {
        await window.electronAPI.stopBot(pid);
        profileState[pid].isRunning = false;
        updateProfileUI(pid);
        log(pid, 'Bot stopped', 'warn');
    });

    // Reset Stats
    els.btnReset.addEventListener('click', () => {
        window.electronAPI.resetStats(pid);
        profileState[pid].stats = { completed: 0, battleCount: 0, avgBattleTime: 0 };
        updateStatsDisplay(pid);
        log(pid, 'Stats reset', 'info');
    });

    // Save Credentials
    els.btnSaveCreds.addEventListener('click', async () => {
        const email = els.email.value.trim();
        const password = els.password.value;
        if (!email || !password) return showToast('Email & Password required', 'warn');
        await window.electronAPI.saveCredentials(pid, { email, password });
        log(pid, 'Credentials saved', 'success');
    });

    // Settings Change (Auto-Save)
    // Auto-save settings on change
    const inputs = [
        els.nameInput,
        els.mode, els.questUrl, els.maxRuns, els.battleMode, els.honorTarget,
        els.browserType, els.disableSandbox
    ];
    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', () => {
                saveProfileSettings(pid);
                updateFormVisibility(pid);
            });
        }
    });

    // URL Validation
    els.questUrl.addEventListener('input', () => {
        const url = els.questUrl.value;
        const valid = !url || url.includes('game.granbluefantasy.jp');
        els.questUrlError.classList.toggle('show', !valid);
        els.questUrl.classList.toggle('input-error', !valid);
    });
}

function updateProfileUI(pid) {
    const s = profileState[pid];
    const els = dom[pid];

    // Status Badge
    els.statusBadge.textContent = s.isRunning ? '▶' : '⏹'; // Using icons as requested
    els.statusBadge.className = `status-badge status-${s.isRunning ? 'Running' : 'Stopped'}`;

    // Buttons
    els.btnLaunch.textContent = s.isBrowserOpen ? 'Close Browser' : 'Open Browser';
    els.btnStart.disabled = s.isRunning || !s.isBrowserOpen;
    els.btnStop.disabled = !s.isRunning;

    // Form Visibility
    updateFormVisibility(pid);
}

function updateFormVisibility(pid) {
    const els = dom[pid];
    const isQuest = els.mode.value === 'quest';

    els.questUrlGroup.style.display = isQuest ? 'block' : 'none';
    els.honorGroup.style.display = isQuest ? 'none' : 'block';

    const label = els.maxRunsLabel;
    if (label) label.textContent = isQuest ? 'Max Quests' : 'Max Raids';
}

function updateStatsDisplay(pid) {
    const s = profileState[pid].stats;
    const els = dom[pid];

    if (!s) return;

    // Completed
    els.statCompleted.textContent = (s.completedQuests || s.raidsCompleted || 0);

    // Avg Battle Time
    if (s.avgBattleTime > 0) {
        const secs = Math.floor(s.avgBattleTime / 1000);
        const m = Math.floor(secs / 60);
        const sc = secs % 60;
        els.statAvgBattle.textContent = `${m}:${sc.toString().padStart(2, '0')}`;
    } else {
        els.statAvgBattle.textContent = '--:--';
    }

    // Avg Turns
    els.statAvgTurns.textContent = s.avgTurns || '-.-';

    // Timer & Rate
    if (s.startTime && profileState[pid].isRunning) {
        const diff = Date.now() - s.startTime;
        const seconds = Math.floor(diff / 1000);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const sc = seconds % 60;
        els.statRunTimer.textContent = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sc.toString().padStart(2, '0')}`;

        // Rate (per hour)
        if (s.rate) {
            els.statRunRate.textContent = s.rate;
        } else if (diff > 10000) {
            // Fallback client-side calculation (shouldn't be needed often)
            const hours = diff / 3600000;
            const completed = (s.completed || 0);
            const rate = (completed / hours).toFixed(1);
            els.statRunRate.textContent = `${rate}/h`;
        } else {
            els.statRunRate.textContent = '0.0/h';
        }
    } else if (!profileState[pid].isRunning) {
        // Keep last values or reset? Usually reset on stop/start, so keeping last known is fine for now
        // or we could show static if we stored end time.
        // For now, if stopped, we might want to just show what we have, but time won't update.
    }
}

// === Global / Shared Logic ===

function setupGlobalListeners() {
    dom.global.btnShowLogs.addEventListener('click', () => {
        // Toggle behavior
        dom.global.logsPanel.classList.toggle('hidden');
        // 📜 = Scroll (Show), ✕ = Close (Hide)
        dom.global.btnShowLogs.textContent = dom.global.logsPanel.classList.contains('hidden') ? '📜' : '✕';
        dom.global.btnShowLogs.title = dom.global.logsPanel.classList.contains('hidden') ? 'Show Logs' : 'Hide Logs';
    });

    dom.global.btnCloseLogs.addEventListener('click', () => {
        dom.global.logsPanel.classList.add('hidden');
        dom.global.btnShowLogs.textContent = '📜';
        dom.global.btnShowLogs.title = 'Show Logs';
    });

    dom.global.btnClearLogs.addEventListener('click', () => {
        dom.global.logContainer.innerHTML = '';
        log('sys', 'Logs cleared', 'info');
    });

    // Hide/Show P2
    if (dom.global.btnToggleP2) {
        dom.global.btnToggleP2.addEventListener('click', () => {
            const splitView = document.querySelector('.split-view');
            const colP2 = document.getElementById('col-p2');

            if (colP2.style.display === 'none') {
                // Show Dual
                colP2.style.display = 'flex';
                splitView.style.gridTemplateColumns = '1fr 1fr';
                dom.global.btnToggleP2.textContent = '👁️'; // Keep eye icon
                dom.global.btnToggleP2.title = 'Hide Profile 2';
                // Show Title
                document.querySelector('.header h1').style.display = 'block';
                window.electronAPI.resizeWindow(460, 700);
            } else {
                // Hide Single
                colP2.style.display = 'none';
                splitView.style.gridTemplateColumns = '1fr';
                dom.global.btnToggleP2.textContent = '👁️'; // Keep eye icon
                dom.global.btnToggleP2.title = 'Show Profile 2';
                // Hide Title
                document.querySelector('.header h1').style.display = 'none';
                window.electronAPI.resizeWindow(230, 700);
            }
        });
    }
}

// === Logging System ===

function log(pid, message, level = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry log-level-${level}`;

    const time = new Date().toLocaleTimeString();
    const tagColor = pid === 'p1' ? 'var(--accent-blue)' : 'var(--accent-red)'; // Distinguish profiles

    entry.innerHTML = `
        <span class="log-time">${time}</span>
        <span class="log-tag" style="color: ${tagColor}">[${pid.toUpperCase()}]</span>
        <span class="log-message">${message}</span>
    `;

    dom.global.logContainer.appendChild(entry);
    dom.global.logContainer.scrollTop = dom.global.logContainer.scrollHeight;

    // Memory Guard: Limit logs to 200 entries
    if (dom.global.logContainer.children.length > 200) {
        dom.global.logContainer.removeChild(dom.global.logContainer.firstChild);
    }
}

// === IPC Event Handlers ===

if (window.electronAPI) {
    window.electronAPI.onLogUpdate((data) => {
        // data = { level, message, ... }
        // Attempt to extract profile from message if wrapper didn't strictly structure it
        let pid = 'sys';
        let msg = data.message;

        if (msg.includes('[p1]') || msg.includes('[profile1]')) pid = 'p1';
        else if (msg.includes('[p2]') || msg.includes('[profile2]')) pid = 'p2';
        else if (msg.includes('[Bot] [p1]')) pid = 'p1';
        else if (msg.includes('[Bot] [p2]')) pid = 'p2';

        // Clean msg tag if preferred, or just leave it
        log(pid, msg, data.level);
    });

    window.electronAPI.onStatusUpdate((data) => {
        // data = { profileId, status, stats }
        const pid = data.profileId;
        if (profileState[pid]) {
            if (data.status === 'Stopped' || data.status === 'Error') {
                profileState[pid].isRunning = false;
            }

            // Update stats if provided
            if (data.stats) {
                const s = data.stats;
                profileState[pid].stats = {
                    completed: s.completedQuests || s.raidsCompleted || 0,
                    battleCount: s.battleCount || 0,
                    avgBattleTime: s.avgBattleTime || 0,
                    avgTurns: s.avgTurns || 0,
                    rate: s.rate // Store rate from main process
                };

                // Update Time Display directly if duration is provided
                if (s.duration) {
                    const timerEl = document.getElementById(`run-timer-${pid}`);
                    if (timerEl) timerEl.textContent = s.duration;
                }

                updateStatsDisplay(pid);
            }
            updateProfileUI(pid);
        }
    });

    // Sound (if supported)
    window.electronAPI.onPlaySound && window.electronAPI.onPlaySound(() => {
        // simple beep
    });
}

// === Persistence ===

function loadGlobalSettings() {
    // e.g. compact mode
}

async function loadProfileSettings(pid) {
    const saved = localStorage.getItem(`settings_${pid}`);
    if (saved) {
        const s = JSON.parse(saved);
        profileState[pid].settings = s;
        // Apply to DOM
        const els = dom[pid];
        if (s.profileName && els.nameInput) els.nameInput.value = s.profileName; // Restore Name
        if (s.botMode) els.mode.value = s.botMode;
        if (s.questUrl) els.questUrl.value = s.questUrl;
        if (s.maxRuns) els.maxRuns.value = s.maxRuns;
        if (s.battleMode) els.battleMode.value = s.battleMode;
        // Browser Settings
        if (s.browserType && els.browserType) els.browserType.value = s.browserType;
        if (s.disableSandbox !== undefined && els.disableSandbox) els.disableSandbox.checked = s.disableSandbox;
    }
}

function saveProfileSettings(pid) {
    const els = dom[pid];
    const s = {
        profileName: els.nameInput ? els.nameInput.value : `Profile ${pid === 'p1' ? '1' : '2'}`,
        botMode: els.mode.value,
        questUrl: els.questUrl.value,
        maxRuns: els.maxRuns.value,
        battleMode: els.battleMode.value,
        // Browser Settings
        browserType: els.browserType ? els.browserType.value : 'chromium',
        disableSandbox: els.disableSandbox ? els.disableSandbox.checked : false
    };
    localStorage.setItem(`settings_${pid}`, JSON.stringify(s));
}

async function loadCredentials(pid) {
    const res = await window.electronAPI.loadCredentials(pid);
    if (res.success && res.credentials) {
        // pid is 'p1' or 'p2'
        dom[pid].email.value = res.credentials.email || '';
        dom[pid].password.value = res.credentials.password || '';
    } else {
        // Check if legacy formatting exists? No, assuming main process handles it or returns null
        // If we want to support 'profile1' -> 'p1' migration, it should happen in main.js
        console.log(`No credentials found for ${pid}`);
    }
}

// === Helpers ===
function setLoading(btn, isLoading, text) {
    if (isLoading) {
        btn.dataset.original = btn.textContent;
        btn.textContent = text;
        btn.disabled = true;
    } else {
        btn.textContent = btn.dataset.original || 'Action';
        btn.disabled = false;
    }
}

function showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast toast-${type} show`;
    t.innerHTML = `<span class="toast-message">${msg}</span>`;
    document.getElementById('toast-container').appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

// Global scope for collapse toggles (onclick in HTML)
window.toggleSection = function (id) {
    const content = document.getElementById(`${id}-content`);
    const chevron = document.getElementById(`${id}-chevron`);
    const isOpen = content.classList.contains('open');

    if (isOpen) {
        content.classList.remove('open');
        chevron.textContent = '▼';
    } else {
        content.classList.add('open');
        chevron.textContent = '▲';
    }
};
