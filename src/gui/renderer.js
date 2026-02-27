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
        // Per-profile log containers (tabbed)
        logContainers: {
            p1: null, // initialized after DOMContentLoaded
            p2: null,
            all: null
        },
        btnToggleP2: document.getElementById('btn-toggle-p2'),
        btnTestSound: document.getElementById('btn-test-sound'),
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
        raidTarget: document.getElementById(`raid-target-${pid}`),
        raidTargetGroup: document.getElementById(`raid-target-group-${pid}`),
        maxRuns: document.getElementById(`max-runs-${pid}`),
        maxRunsLabel: document.getElementById(`max-runs-label-${pid}`),
        // Zone (Xeno)
        zone: document.getElementById(`zone-${pid}`),
        zoneGroup: document.getElementById(`zone-group-${pid}`),
        battleMode: document.getElementById(`battle-mode-${pid}`),
        // Browser Settings
        browserType: document.getElementById(`browser-type-${pid}`),
        disableSandbox: document.getElementById(`disable-sandbox-${pid}`),
        // Stats
        statCompleted: document.getElementById(`completed-runs-${pid}`),
        statAvgBattle: document.getElementById(`avg-battle-${pid}`),
        statAvgTurns: document.getElementById(`avg-turns-${pid}`),
        statLastBattle: document.getElementById(`stat-last-battle-${pid}`),
        statRunTimer: document.getElementById(`run-timer-${pid}`),
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

    // Initialize per-profile log containers after DOM is ready
    dom.global.logContainers.p1 = document.getElementById('log-container-p1');
    dom.global.logContainers.p2 = document.getElementById('log-container-p2');
    dom.global.logContainers.all = document.getElementById('log-container-all');
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
        // Get checkbox element dynamically to avoid null reference on init
        const blockResourcesEl = document.getElementById(`block-resources-${pid}`);
        let blockResources = false;

        if (blockResourcesEl) {
            blockResources = blockResourcesEl.checked;
            log(pid, `Image Blocking: ${blockResources ? 'ENABLED (Fast Mode)' : 'DISABLED (Normal Mode)'}`, blockResources ? 'success' : 'info');
        } else {
            log(pid, `[Warning] Image Blocking setting not found, defaulting to OFF`, 'warning');
        }

        const settings = {
            botMode: els.mode.value,
            questUrl: els.questUrl.value.trim(),
            maxRuns: els.maxRuns.value,
            battleMode: els.battleMode.value,
            honorTarget: els.honorTarget.value,
            raidTargetUser: els.raidTarget ? els.raidTarget.value.trim() : '',
            zoneId: els.zone ? els.zone.value : null,
            blockResources: blockResourcesEl ? blockResourcesEl.checked : false,
            fastRefresh: document.getElementById(`fast-refresh-${pid}`)?.checked || false,
            refreshOnStart: document.getElementById(`refresh-on-start-${pid}`)?.checked ?? true
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
        els.mode, els.questUrl, els.maxRuns, els.battleMode, els.honorTarget, els.raidTarget,
        els.zone,
        els.browserType, els.disableSandbox,
        document.getElementById(`block-resources-${pid}`),
        document.getElementById(`fast-refresh-${pid}`),
        document.getElementById(`refresh-on-start-${pid}`)
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
    els.statusBadge.textContent = s.isRunning ? '▶' : '⏹';
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
    const mode = els.mode.value;
    const isQuestOrReplicard = mode === 'quest' || mode === 'replicard' || mode === 'xeno_replicard';

    els.questUrlGroup.style.display = isQuestOrReplicard ? 'block' : 'none';
    els.honorGroup.style.display = mode === 'raid' ? 'block' : 'none';
    els.raidTargetGroup.style.display = mode === 'raid' ? 'block' : 'none';
    els.zoneGroup.style.display = mode === 'xeno_replicard' ? 'block' : 'none';

    const label = els.maxRunsLabel;
    if (label) {
        if (mode === 'quest') label.textContent = 'Max Quests';
        else if (mode === 'raid') label.textContent = 'Max Raids';
        else if (mode === 'replicard') label.textContent = 'Max Runs';
        else if (mode === 'xeno_replicard') label.textContent = 'Max Runs';
    }
}

function updateStatsDisplay(pid) {
    const s = profileState[pid].stats;
    const els = dom[pid];

    if (!s) return;

    // Completed
    els.statCompleted.textContent = s.completed || 0;

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

    // Last Battle Time
    if (s.lastBattleTime > 0) {
        const secs = Math.floor(s.lastBattleTime / 1000);
        const m = Math.floor(secs / 60);
        const sc = secs % 60;
        const timeStr = `${m}:${sc.toString().padStart(2, '0')}`;
        if (els.statLastBattle) els.statLastBattle.textContent = timeStr;
    } else {
        if (els.statLastBattle) els.statLastBattle.textContent = '--:--';
    }

    // Timer & Rate
    const startTime = profileState[pid].startTime;
    if (startTime && profileState[pid].isRunning) {
        const diff = Date.now() - startTime;
        const seconds = Math.floor(diff / 1000);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const sc = seconds % 60;
        els.statRunTimer.textContent = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sc.toString().padStart(2, '0')}`;

        // Rate
        if (s.rate) {
            els.statRunRate.textContent = s.rate;
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
        const activeTab = window.activeLogTab || 'p1';
        // Clear the active profile tab
        const activeContainer = dom.global.logContainers[activeTab];
        if (activeContainer) activeContainer.innerHTML = '';
        // Also clear the 'all' tab since it mirrors everything
        if (activeTab !== 'all' && dom.global.logContainers.all) {
            dom.global.logContainers.all.innerHTML = '';
        }
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

    // Test Sound Button
    dom.global.btnTestSound.addEventListener('click', () => {
        playAlertSound();
    });

}

// === Logging System ===

function log(pid, message, level = 'info') {
    const time = new Date().toLocaleTimeString();
    const tagColor = pid === 'p1' ? 'var(--accent-blue)' : pid === 'p2' ? 'var(--accent-red)' : 'var(--text-secondary)';

    let coloredMessage = message.replace(/\[([a-zA-Z0-9]+)\]/g, (match, tag) => {
        const lowerTag = tag.toLowerCase();
        return `<span class="log-tag log-tag-${lowerTag}">[${tag}]</span>`;
    });

    const profileLabel = pid !== 'sys' ? `<span class="log-tag" style="color: ${tagColor}">${pid.toUpperCase()}</span>` : '';
    const entryHTML = `<span class="log-time">${time}</span>${profileLabel}<span class="log-message">${coloredMessage}</span>`;

    // Append to the profile-specific container
    const targetPid = (pid === 'p1' || pid === 'p2') ? pid : 'p1';
    const profileContainer = dom.global.logContainers[targetPid];
    const allContainer = dom.global.logContainers.all;

    function appendTo(container) {
        if (!container) return;
        const entry = document.createElement('div');
        entry.className = `log-entry log-level-${level}`;
        entry.innerHTML = entryHTML;
        container.appendChild(entry);
        // Auto-scroll only the currently active tab
        if (container === dom.global.logContainers[window.activeLogTab]) {
            container.scrollTop = container.scrollHeight;
        }
        // Memory Guard: cap at 300 entries per container
        if (container.children.length > 300) {
            container.removeChild(container.firstChild);
        }
    }

    appendTo(profileContainer);
    appendTo(allContainer);
}

// === IPC Event Handlers ===

if (window.electronAPI) {
    window.electronAPI.onLogUpdate((data) => {
        // data = { level, message, ... }
        let pid = 'sys';
        let msg = data.message;

        // Profile detection (check explicit ID first, then scan message)
        if (data.profileId && (data.profileId === 'p1' || data.profileId === 'p2')) {
            pid = data.profileId;
        } else if (msg.match(/\[p1\]/i) || msg.match(/\[bot\]\s*\[p1\]/i)) {
            pid = 'p1';
        } else if (msg.match(/\[p2\]/i) || msg.match(/\[bot\]\s*\[p2\]/i)) {
            pid = 'p2';
        }

        // Strip redundant [P1]/[P2] from the message body — the tab label already shows the profile
        msg = msg.replace(/^\[P[12]\]\s*/i, '').replace(/\[P[12]\]\s*/gi, '').trim();

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
                    lastBattleTime: s.lastBattleTime || 0,
                    startTime: s.startTime,
                    rate: s.rate
                };

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
        playAlertSound();
    });
}

function playAlertSound() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;

        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        // Alert pattern: Pleasant "Rising Sweep" ping
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(440, ctx.currentTime); // A4
        oscillator.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.3); // A5

        // Envelope: Snappy attack, smooth decay
        gainNode.gain.setValueAtTime(0, ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 0.05);
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);

        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.3);
    } catch (e) {
        console.error('Failed to play sound:', e);
    }
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
        if (s.raidTarget && els.raidTarget) els.raidTarget.value = s.raidTarget;
        if (s.zoneId && els.zone) els.zone.value = s.zoneId;
        // Browser Settings
        if (s.browserType && els.browserType) els.browserType.value = s.browserType;
        if (s.disableSandbox !== undefined && els.disableSandbox) els.disableSandbox.checked = s.disableSandbox;
        if (s.fastRefresh !== undefined) {
            const frEl = document.getElementById(`fast-refresh-${pid}`);
            if (frEl) frEl.checked = s.fastRefresh;
        }
        if (s.refreshOnStart !== undefined) {
            const rsEl = document.getElementById(`refresh-on-start-${pid}`);
            if (rsEl) rsEl.checked = s.refreshOnStart;
        }
        if (s.blockResources !== undefined) {
            const brEl = document.getElementById(`block-resources-${pid}`);
            if (brEl) brEl.checked = s.blockResources;
        }
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
        raidTarget: els.raidTarget ? els.raidTarget.value : '',
        zoneId: els.zone ? els.zone.value : null,
        // Browser Settings
        browserType: els.browserType ? els.browserType.value : 'chromium',
        disableSandbox: els.disableSandbox ? els.disableSandbox.checked : false,
        blockResources: document.getElementById(`block-resources-${pid}`)?.checked || false,
        fastRefresh: document.getElementById(`fast-refresh-${pid}`)?.checked || false,
        refreshOnStart: document.getElementById(`refresh-on-start-${pid}`)?.checked ?? true
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
