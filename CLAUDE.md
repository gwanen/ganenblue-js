# Ganenblue-JS: Granblue Fantasy Automation Bot

**Version:** 1.0.0  
**Type:** Node.js + Electron application  
**Package Manager:** npm  
**Language:** JavaScript (ES modules)

## Project Overview

Ganenblue-JS is a browser automation bot for [Granblue Fantasy](https://granbluefantasy.jp/), a Japanese online RPG. It automates farming, raid backup farming, and battle sequences using Puppeteer for headless browser control and network monitoring.

**Key Capabilities:**
- Quest farming automation (repeatable quests)
- Raid backup assist farming (joining other players' raids)
- Full-auto and semi-auto battle modes
- Loot tracking (red/blue chests, gold bricks)
- Multi-profile support
- Network event monitoring for game state detection
- Headless or visible browser modes
- Both CLI and Electron GUI interfaces

## Technology Stack

**Core Dependencies:**
- **puppeteer** - Headless Chrome browser automation
- **puppeteer-extra** - Plugin system for Puppeteer (stealth, ReCAPTCHA handling)
- **commander** - CLI argument parsing
- **winston** - Structured logging
- **js-yaml** - YAML config file parsing
- **electron** - Desktop GUI framework
- **proxy-chain** - HTTP/HTTPS proxy support
- **user-agents** - User agent randomization
- **dotenv** - Environment variable loading

**Dev Dependencies:**
- **electron-builder** - Desktop app packaging
- **jest** - Testing framework
- **eslint** - Code linting
- **prettier** - Code formatting
- **esbuild** - JavaScript bundler
- **nodemon** - Auto-restart on file changes

## Project Structure

```
ganenblue-js/
├── src/
│   ├── bot/              # Bot modules for different automation modes
│   │   ├── index.js      # Module exports
│   │   ├── battle-handler.js    # Combat logic & battle state management
│   │   ├── quest-bot.js         # Quest farming orchestration
│   │   ├── raid-bot.js          # Raid backup assist farming
│   │   └── skip-bot.js          # Skill/spell skipping automation
│   │
│   ├── core/             # Core browser automation & game monitoring
│   │   ├── index.js               # Module exports
│   │   ├── browser.js             # Puppeteer browser manager
│   │   ├── login-handler.js       # Account authentication
│   │   ├── network-listener.js    # Network event detection & emission
│   │   └── page-controller.js     # DOM interaction & element control
│   │
│   ├── gui/              # Electron desktop application
│   │   ├── main.js       # Electron main process entry
│   │   ├── index.js      # GUI window creation & IPC setup
│   │   └── renderer.js   # Frontend UI logic
│   │
│   ├── cli/              # Command-line interface
│   │   ├── index.js      # CLI command definitions (Commander)
│   │   └── test-stealth.js   # Stealth plugin testing utility
│   │
│   └── utils/            # Shared utilities
│       ├── config.js     # YAML config loading & environment overrides
│       ├── logger.js     # Winston logging setup & scoped loggers
│       ├── memory-watchdog.js  # Memory usage monitoring
│       ├── notifier.js   # Desktop/console notifications
│       └── random.js     # Delay & randomization utilities
│
├── config/               # Configuration files
│   ├── default.yaml      # Main bot configuration
│   ├── selectors.yaml    # CSS selectors for DOM elements
│   ├── credentials.yaml  # Account login info (git-ignored)
│   └── credentials.example.yaml  # Credentials template
│
├── scripts/              # Utility scripts
│   └── audit-logs.js     # Log analysis tool
│
├── package.json          # Project metadata & scripts
└── .env.example          # Environment variables template
```

## Key Modules

### Core Browser Automation (`src/core/`)

**Browser (`browser.js`)**
- Manages Puppeteer browser instance lifecycle
- Configures stealth plugin to avoid bot detection
- Handles proxy configuration & user agent randomization
- Manages multiple pages/tabs

**PageController (`page-controller.js`)**
- DOM interaction wrapper around Puppeteer Page
- Methods: click selectors, fill inputs, wait for elements
- Resource blocking (disable image/CSS loading for speed)
- Turbo CSS mode for faster page rendering
- Error handling & retry logic

**NetworkListener (`network-listener.js`)**
- Monitors network responses for game API calls
- Emits events when specific responses arrive:
  - `battle:start` - Battle begins
  - `battle:result` - Battle ends with loot/rewards
  - `raid:error` - Raid entry failed (soldier/time limit)
  - `supporter:screen` - Raid supporter selection screen
  - Event parameters contain raw API response data
- EventEmitter-based architecture for loose coupling

**LoginHandler (`login-handler.js`)**
- Account authentication flow
- Handles browser cache & session management

### Bot Modules (`src/bot/`)

**BattleHandler (`battle-handler.js`)**
- Orchestrates combat sequences
- Supports full-auto (all turns automatic) and semi-auto (manual ability use)
- Skill/summon refresh logic
- Auto-attack configuration
- Turn management & battle state tracking
- Tracks battle duration & turn count

**QuestBot (`quest-bot.js`)**
- Automation for repeatable quests
- Quest URL validation & navigation
- Loot tracking (rewards, drops, rare items)
- Multi-quest looping with configurable limits
- Pause/resume support

**RaidBot (`raid-bot.js`)**
- Raid backup assist automation (joins other players' raids)
- Supporter list scanning & filtering (by name, difficulty, element)
- Raid entry error handling:
  - Soldier limit reached (too many players)
  - Battle already completed
  - Recovers with retry logic
- Raid refresh to update the list
- Loot tracking: red chests, blue chests, gold bricks
- Honors/points tracking

**SkipBot (`skip-bot.js`)**
- Automated skill/spell usage during battles
- Predefined skill sequences per battle

### Configuration System (`src/utils/config.js`)

- Loads `config/default.yaml` on startup
- Loads game selectors from `config/selectors.yaml`
- Merges environment variable overrides (e.g., `QUEST_URL=...`)
- Dot-notation access: `config.get('bot.quest_url')`
- Runtime updates: `config.set('bot.quest_url', 'https://...')`

### Logging System (`src/utils/logger.js`)

- Winston-based structured logging
- Log levels: info, warn, error, debug
- Scoped loggers for profile tracking: `createScopedLogger('p1')`
- Contextual prefixes: `[Quest]`, `[Raid]`, `[Error]`, etc.
- File & console output

### Notification System (`src/utils/notifier.js`)

- Desktop notifications (OS-level)
- Console notifications (CLI)
- Configurable message styling

### Utilities (`src/utils/`)

- **random.js** - `sleep()`, `randomDelay()` for natural timing
- **memory-watchdog.js** - RAM monitoring to prevent memory leaks
- **config.js** - Configuration management (see above)
- **logger.js** - Logging setup (see above)

## Running the Bot

### CLI Mode

```bash
# Start quest farming
npm cli -- start --url "https://game.granbluefantasy.jp/#quest/..." -n 50 -m full_auto

# Start raid backup farming
npm cli -- raid -n 100 -m full_auto
```

**Available CLI Commands:**
- `start` - Quest farming
- `raid` - Raid backup farming
- `--headless` - Run in headless mode (no visible browser)
- `-n, --max` - Max runs (0 = unlimited)
- `-m, --mode` - Battle mode (full_auto or semi_auto)

### GUI Mode (Electron)

```bash
npm start
```

Launches Electron desktop app with interactive UI controls.

### Development

```bash
npm test            # Run Jest tests
npm audit:logs      # Analyze bot logs
```

### Build Desktop App

```bash
npm dist            # Build NSIS installer for Windows
npm pack            # Build portable (no installer)
```

## Configuration

### `config/default.yaml`

Main configuration file. Structure:

```yaml
browser:
  headless: false
  timeout: 30000
  blockImages: false

bot:
  quest_url: ""
  max_quests: 0
  battle_mode: full_auto
  honor_target: 0

raid:
  max_raids: 0
  target_user: null
  auto_refresh: true
  refresh_interval: 30000
```

### `config/selectors.yaml`

CSS selectors for game elements (quest button, raid list, etc.). Maps UI element locations for reliable DOM queries across game updates.

### `config/credentials.yaml`

Account login credentials (git-ignored, use `credentials.example.yaml` as template):

```yaml
email: your-email@example.com
password: your-password
```

### Environment Variables (`.env`)

```bash
QUEST_URL=https://game.granbluefantasy.jp/#quest/...
HEADLESS=true
RAID_MAX=100
```

## Key Concepts

### Loot Tracking

The bot tracks battle rewards through network event monitoring:

- **Red Chests** - Common drops (bucket type `"4"`)
- **Blue Chests** - Rare drops (bucket type `"11"`)
- **Gold Bricks** - Crucial upgrade materials (item name `"Gold Brick"`)

Loot data comes from the `battle:result` network event.

### Error Handling

Network-based error detection:
- Raid soldier limit reached → Auto-retry from backup list
- Battle already started → Skip, refresh list, retry
- Connection timeout → Exponential backoff retry

### Multi-Profile Support

Bot can run multiple profiles simultaneously:
- Each profile has isolated logger: `createScopedLogger('p1')`, `createScopedLogger('p2')`
- Separate session management
- Independent configuration per profile

### Memory Management

- `MemoryWatchdog` monitors RAM usage
- Garbage collection hints on high memory
- Listener leak detection in NetworkListener (warns if count > 20 per event)

### Stealth Mode

Uses `puppeteer-extra-stealth` plugin to:
- Hide headless Chrome detection
- Randomize user agents
- Avoid bot fingerprinting
- Evade anti-bot detection

## Development Notes

### Design Patterns

1. **EventEmitter** - NetworkListener emits game events (battles, raids, errors)
2. **Dependency Injection** - Bots accept page, logger, controller as constructor params
3. **Scoped Logging** - All logs include profile ID for traceability
4. **Configuration Management** - Centralized config with environment overrides
5. **Resource Cleanup** - All browser/listener instances cleaned up on shutdown

### Adding New Features

**To add a new bot mode:**
1. Create `src/bot/new-mode-bot.js` extending the base pattern
2. Integrate with NetworkListener event emissions
3. Add CLI command in `src/cli/index.js`
4. Update selectors in `config/selectors.yaml` if needed
5. Add configuration options to `config/default.yaml`

**To monitor new game events:**
1. Identify the API endpoint in browser DevTools
2. Add pattern detection in `NetworkListener._handleResponse()`
3. Emit new event: `this.emit('new:event', data)`
4. Subscribe in bot: `listener.on('new:event', handler)`

### Common Issues

- **Selector mismatches** - Game UI changes break CSS selectors → Update `selectors.yaml`
- **Bot detection** - Stealth plugin failure → Check Puppeteer version, disable headless testing
- **Memory leaks** - Long bot runs → Check NetworkListener listener counts, enable memory-watchdog
- **Network timeouts** - Slow connection → Increase timeout in `config/default.yaml`

## Testing

```bash
npm test            # Run all Jest tests
npm test -- --watch # Watch mode for TDD
```

Tests located in `__tests__/` directories parallel to source files.

## Deployment

### Desktop Application

```bash
npm dist
# Output: dist/Ganenblue-JS-Setup-1.0.0.exe
```

NSIS installer with auto-update support.

### Command-Line Tool

Install as global npm tool:

```bash
npm install -g .
gbf-bot start --url "https://..." -n 50
```

## Security Notes

- **Credentials** - Never commit `config/credentials.yaml`. Use `.env` or pass via CLI.
- **Session tokens** - Stored in Puppeteer cache, not logged.
- **Network monitoring** - Only reads API responses, doesn't modify requests.
- **Proxy support** - Configured in browser settings for anonymity.

## Stack Alternatives

Current stack is the right call for this use case. Notable alternatives if pain points arise:

- **Playwright** > Puppeteer — better multi-tab handling, built-in wait strategies. Stealth plugins less mature; GBF requires Chrome specifically so multi-browser support is moot.
- **Pino** > Winston — 5-10x faster logging, lower overhead at high raid volumes.
- **Tauri** > Electron — smaller bundle, lower RAM, Rust backend. High migration cost for marginal desktop-tool benefit.

## License

ISC

## Author

Ganendra
