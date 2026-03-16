# Ganenblue-JS Context

A Granblue Fantasy automation tool built with Node.js, Electron, and Puppeteer.

## Project Overview

Ganenblue-JS is a browser automation bot for Granblue Fantasy that handles quest farming, raid backup joining, and skip nightmare farming. It features dual-profile support for simultaneous grinding, stealth detection avoidance, and real-time statistics tracking.

## Architecture

```
src/
├── bot/                    # Bot automation logic
│   ├── battle-handler.js   # Core battle execution (turn tracking, attack sequences, result detection)
│   ├── quest-bot.js        # Quest farming mode (quests, replicard, xeno)
│   ├── raid-bot.js         # Raid backup mode (join raids, battle, collect honors)
│   └── skip-bot.js         # Skip nightmare mode
├── core/                   # Core infrastructure
│   ├── browser.js          # Browser lifecycle management (Puppeteer + Stealth)
│   ├── login-handler.js    # Auto-login flow (Mobage credentials)
│   ├── network-listener.js # EventEmitter for GBF network responses
│   └── page-controller.js  # High-level page operations (navigation, clicking, SPA handling)
├── gui/                    # Electron GUI
│   ├── main.js            # Main process (IPC handlers, window management, bot orchestration)
│   ├── renderer.js        # Renderer process
│   ├── preload.cjs        # Context bridge for IPC
│   └── index.html         # UI
├── cli/                    # CLI interface
│   ├── index.js           # Commander.js CLI entry point
│   └── test-stealth.js    # Stealth detection test
└── utils/                  # Shared utilities
    ├── config.js          # YAML configuration loader
    ├── logger.js          # Winston logger with profile scoping
    ├── notifier.js        # Discord webhook notifications
    └── random.js          # Human-like randomization (Bezier curves, delays)

config/
├── default.yaml           # Main configuration (browser, bot, timeouts)
├── selectors.yaml        # CSS selectors for game UI (update on game patches)
├── credentials.yaml      # Login credentials (profiles structure)
└── credentials.example.yaml

tests/                     # Jest test files
```

## Key Patterns

### Network-Based State Detection

The `NetworkListener` class intercepts GBF API responses to detect game state changes without DOM polling:

- `battle:result` - Battle finished (result.json or empty.js)
- `battle:start` - Battle started (turn from start.json)
- `battle:boss_died` - Victory detected in attack/ability/summon results
- `battle:party_wiped` - Defeat detected
- `battle:attack_used`, `battle:ability_used`, `battle:summon_used` - Action tracking
- `raid:error` - Join errors (full, pending, concurrent limit)
- `raid:supporter_screen` - Supporter selection page loaded

### Profile-Based Multi-Instance

Supports running 2 profiles simultaneously (`p1`, `p2`). Each profile has:
- Scoped logger with profile prefix
- Separate BrowserManager instance
- Separate bot instance
- Stats tracking per profile

### SPA Navigation

GBF uses hash-based SPA routing (`#raid/123`, `#quest/assist`). Use `PageController.gotoSPA()` instead of `page.goto()` to:
1. Force hashchange events when already on target URL
2. Wait for loading overlay to disappear
3. Handle SPA router edge cases

### Human-Like Mouse Movement

`PageController.clickSafe()` uses:
- Gaussian-distributed click positions (not exact center)
- Bezier curve mouse trajectories
- Variable delays with jitter

### Battle Handler

`BattleHandler.executeBattle()` handles:
1. Pre-registered network events (race conditions from navigation)
2. Turn tracking via network + DOM fallback
3. Full Auto / Semi Auto mode switching
4. Result screen detection (result.json vs empty.js)
5. Honor tracking and target-based stopping

### Error Recovery

Network errors use `retryOnNetworkError()` with exponential backoff. Common patterns:
- Detached frame → force page reload
- Stale result page → re-navigate to quest URL
- Raid full/ended → refresh backup list
- Concurrent raid limit → 15s cooldown

## Configuration

```yaml
# default.yaml structure
bot:
  battle_mode: full_auto  # full_auto | semi_auto
  bot_mode: quest         # quest | raid | replicard
  max_quests: 0           # 0 = unlimited

browser:
  browser_type: chromium # chromium | chrome | edge | brave | firefox
  headless: false

timeouts:
  battle_max: 600000     # 10 minutes per battle

notifications:
  discord_webhook: ""    # Optional Discord notifications
```

## CLI Commands

```bash
npm run cli start --url <quest_url> --max <count> --mode full_auto
npm run cli raid --max <count> --mode full_auto
npm run cli skip --url <result_page_url> --max <count>
npm run cli config
npm run cli test-stealth
```

## GUI IPC Channels

| Channel | Purpose |
|---------|---------|
| `browser:launch` | Launch browser for profile |
| `browser:close` | Close browser instance |
| `bot:start` | Start bot with settings |
| `bot:stop` | Stop bot |
| `bot:get-status` | Get current stats |
| `bot:reset-stats` | Reset statistics |
| `credentials:save` | Save profile credentials |
| `credentials:load` | Load profile credentials |

## Testing

```bash
npm test
```

Tests use Jest with ES modules. Key test files:
- `battle-handler-logic.test.js` - Battle logic unit tests
- `network-listener.test.js` - Network event parsing tests
- `battle-handler-preregistration.test.js` - Pre-registered event race conditions

## Development Notes

### Adding New Bot Mode

1. Create new bot class in `src/bot/`
2. Extend pattern from `QuestBot` or `RaidBot`
3. Register in `src/gui/main.js` IPC handler
4. Add mode to CLI in `src/cli/index.js`

### Updating Selectors

When GBF UI changes, update `config/selectors.yaml`. All bots reference selectors via `config.selectors.battle`, `config.selectors.quest`, etc.

### Stealth Considerations

- Use `randomDelay()` for variable timing
- Avoid exact click positions via `getNormalRandom()`
- Mouse movements use Bezier curves via `generateBezierCurve()`
- `clickSafe({ fast: true })` skips human-like delays for non-critical actions

### Memory Management

- Browser profiles stored in temp directory, cleaned on close
- `NetworkListener.setMaxListeners(100)` for complex monitoring
- CDP sessions detached after use in `disableBackgroundThrottling()`
- Element handles disposed after bounding box extraction

## Common Files to Edit

| Purpose | File |
|---------|------|
| Battle timing/detection | `src/bot/battle-handler.js` |
| Quest flow | `src/bot/quest-bot.js` |
| Raid flow | `src/bot/raid-bot.js` |
| Network events | `src/core/network-listener.js` |
| Page operations | `src/core/page-controller.js` |
| Browser config | `config/default.yaml` |
| UI selectors | `config/selectors.yaml` |
| GUI layout | `src/gui/index.html`, `src/gui/renderer.js` |
| CLI commands | `src/cli/index.js` |