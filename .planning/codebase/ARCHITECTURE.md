# Architecture

## Pattern: Layered Bot Architecture

The application follows a layered architecture with clear separation between browser automation, game logic, and user interfaces.

```
┌─────────────────────────────────────────────────┐
│                  Interfaces                      │
│         CLI (commander) │ GUI (Electron)         │
├─────────────────────────────────────────────────┤
│                   Bots Layer                     │
│    QuestBot │ RaidBot │ SkipBot │ BattleHandler  │
├─────────────────────────────────────────────────┤
│                  Core Layer                      │
│  PageController │ NetworkListener │ Browser      │
│  LoginHandler                                    │
├─────────────────────────────────────────────────┤
│                  Utils Layer                     │
│    Config │ Logger │ Notifier │ Random           │
└─────────────────────────────────────────────────┘
```

## Layers

### 1. Interface Layer
Two entry points provide different user experiences:

- **CLI** (`src/cli/index.js`): Commander-based with subcommands: `start`, `raid`, `skip`, `config`, `test-stealth`. Each subcommand creates a Browser instance, navigates to GBF, and runs the appropriate bot.
- **GUI** (`src/gui/index.js`): Electron app with BrowserWindow. Uses IPC (`ipcMain`) for renderer communication. Manages multiple bot instances (p1, p2) via a `Map` in `src/gui/main.js`. Supports automatic window tiling for dual-profile setups.

### 2. Bots Layer
Each bot is a state machine that orchestrates quest/raid cycles:

- **QuestBot** (`src/bot/quest-bot.js`): Farming loop — navigate to quest URL, select supporter, battle, repeat. Tracks stats (battles, turns, durations).
- **RaidBot** (`src/bot/raid-bot.js`): Backup raid loop — find available raids, join, battle, return to assist page. Handles concurrent limits, pending battles, honor targets.
- **SkipBot** (`src/bot/skip-bot.js`): Skip nightmare mode — click through results screens (Play Again → Claim Loot → OK dismissals).
- **BattleHandler** (`src/bot/battle-handler.js`): Core battle logic — Full Auto and Semi Auto modes, turn tracking, honor monitoring, animation skipping via page reloads, FA inactivity watchdog.

### 3. Core Layer
Browser automation abstractions:

- **BrowserManager** (`src/core/browser.js`): Launch browser with stealth options, manage user data directories, handle login flow. Supports multiple browser types (Chromium, Chrome, Edge, Brave, Firefox). In GUI mode, `main.js` orchestrates multiple `BrowserManager` instances per profile.
- **PageController** (`src/core/page-controller.js`): Element interaction with human-like behavior — Gaussian-distributed clicks, Bezier mouse curves, retry logic, frame stability checks, SPA navigation helpers (`gotoSPA`, `reloadPage`).
- **NetworkListener** (`src/core/network-listener.js`): EventEmitter that intercepts GBF API responses. Parses JSON for game state signals (boss death, party wipe, turn changes, honor gains). High-performance: pre-filters URLs before expensive parsing.
- **LoginHandler** (`src/core/login-handler.js`): Automated Mobage login flow with field validation, DOM bypass fallback, reCAPTCHA wait.

### 4. Utils Layer
Shared utilities:

- **Config** (`src/utils/config.js`): YAML config loader singleton. Merges `default.yaml`, `selectors.yaml`, and environment variables. Provides `get()`/`set()` with dot notation.
- **Logger** (`src/utils/logger.js`): Winston-based with console + file transports. Supports scoped loggers via `createScopedLogger(profileId)`.
- **Notifier** (`src/utils/notifier.js`): Discord webhook integration for error/captcha alerts.
- **Random** (`src/utils/random.js`): Human-like delay functions, Bezier curve generation, Gaussian random, typing simulation.

## Data Flow

```
User (CLI/GUI)
  → Bot.start()
    → BrowserManager.launch()
      → LoginHandler.performLogin() (if credentials exist)
    → Bot.runSingle[Quest|Raid]()
      → PageController.gotoSPA() (navigate to game)
      → NetworkListener.start() (intercept API responses)
      → BattleHandler.executeBattle()
        → handleFullAuto() or handleSemiAuto()
        → waitForBattleEnd() (event-driven loop)
          → NetworkListener emits: battle:result, battle:boss_died, etc.
          → Page reloads to skip animations
      → Stats update
    → Repeat
```

## Key Abstractions

### PageController (central abstraction)
All DOM interaction goes through PageController. Key responsibilities:
- Human-like click behavior (Gaussian distribution, Bezier mouse movement)
- Retry logic with network error detection
- Frame stability management after reloads
- SPA navigation (`gotoSPA` for hash-based routing)
- Resource blocking (image/media/font)

### NetworkListener (event-driven game state)
Extends EventEmitter. Listens to Puppeteer `response` events, filters by GBF domain and resource type (fetch/xhr/script), parses JSON to emit semantic events:
- `battle:result` — battle ended
- `battle:boss_died` — boss defeated
- `battle:party_wiped` — party wiped
- `battle:start` — new turn started (with turn number)
- `battle:attack_used` / `battle:summon_used` / `battle:ability_used`
- `raid:error` — join failed (full/pending/concurrent)
- `raid:supporter_screen` — supporter selection page loaded

### BattleHandler (state machine)
Manages the battle lifecycle:
1. Load detection (network signal vs DOM button race)
2. Pre-register battle events
3. Execute mode (full_auto or semi_auto)
4. Wait for battle end (event-driven loop with dynamic thresholds)
5. Return stats (duration, turns, honors)

## Entry Points
- `src/cli/index.js` — CLI binary (shebang, Commander)
- `src/gui/main.js` — Electron main process
