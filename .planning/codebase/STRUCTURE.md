# Directory Structure

## Root Layout
```
ganenblue-js/
├── config/                  # YAML configuration files
│   ├── default.yaml         # Runtime config (bot, browser, stealth, logging, timeouts)
│   ├── selectors.yaml       # CSS selectors for GBF game UI
│   ├── credentials.yaml     # Login credentials (gitignored)
│   └── credentials.example.yaml
├── src/                     # Application source code
│   ├── bot/                 # Bot logic (quest, raid, skip, battle)
│   ├── cli/                 # CLI entry point
│   ├── core/                # Browser automation core
│   ├── gui/                 # Electron GUI
│   └── utils/               # Shared utilities
├── tests/                   # Jest test files
├── scripts/                 # Utility scripts (audit, profiling)
├── logs/                    # Runtime log output (gitignored)
├── .planning/               # GSD project planning (private)
└── package.json
```

## Source Directory (`src/`)

### `src/bot/` — Bot Logic
| File | Lines | Purpose |
|------|-------|---------|
| `index.js` | 11 | Barrel export: BattleHandler, QuestBot, RaidBot, SkipBot |
| `battle-handler.js` | 1314 | Core battle automation (Full Auto / Semi Auto modes) |
| `quest-bot.js` | 689 | Quest farming loop (navigate → supporter → battle → repeat) |
| `raid-bot.js` | 1067 | Raid backup loop (search → join → battle → repeat) |
| `skip-bot.js` | 198 | Skip nightmare result screens |

### `src/core/` — Browser Automation
| File | Lines | Purpose |
|------|-------|---------|
| `index.js` | 11 | Barrel export: Browser, LoginHandler, NetworkListener, PageController |
| `browser.js` | 379 | Browser lifecycle (launch, multi-browser detection, profile management) |
| `page-controller.js` | 516 | DOM interaction with human-like behavior, SPA navigation |
| `network-listener.js` | 203 | EventEmitter intercepting GBF API responses |
| `login-handler.js` | 259 | Automated Mobage login flow |

### `src/utils/` — Shared Utilities
| File | Lines | Purpose |
|------|-------|---------|
| `index.js` | 11 | Barrel export: Config, Logger, Notifier, Random |
| `config.js` | 62 | YAML config loader singleton with env var overrides |
| `logger.js` | 40 | Winston logger with scoped child loggers |
| `notifier.js` | 70 | Discord webhook notifications |
| `random.js` | 64 | Human-like delays, Bezier curves, Gaussian random |

### `src/cli/` — CLI Interface
| File | Lines | Purpose |
|------|-------|---------|
| `index.js` | 187 | Commander CLI with subcommands: start, raid, skip, config, test-stealth |
| `test-stealth.js` | — | Stealth detection test against sannysoft.com |

### `src/gui/` — Electron GUI
| File | Lines | Purpose |
|------|-------|---------|
| `index.js` | 33 | Electron app setup, BrowserWindow creation, IPC |
| `main.js` | — | Electron main process entry point |
| `renderer.js` | — | GUI renderer process |
| `preload.cjs` | — | Context-isolated preload script |
| `index.html` | — | GUI HTML shell |

## Config Directory (`config/`)
| File | Purpose |
|------|---------|
| `default.yaml` | Bot mode, browser settings, stealth, logging, timeouts, notifications |
| `selectors.yaml` | CSS selectors for quest, battle, raid, replicard, login screens |
| `credentials.yaml` | User login credentials (gitignored) |
| `credentials.example.yaml` | Template for credentials |

## Tests Directory (`tests/`)
| File | Purpose |
|------|---------|
| `battle-handler-logic.test.js` | BattleHandler flag logic tests (win priority, honor target, attack cooldown) |
| `battle-handler-preregistration.test.js` | Pre-registration event tests |
| `network-listener.test.js` | NetworkListener URL parsing and event emission tests |
| `notifier.test.js` | Discord notification tests |

## Scripts Directory (`scripts/`)
| File | Purpose |
|------|---------|
| `audit-logs.js` | Log standardization auditor — scans for missing/non-standard tags |
| `profile-performance.js` | Performance profiling utility |

## Naming Conventions
- **Files:** kebab-case (`battle-handler.js`, `page-controller.js`)
- **Classes:** PascalCase (`BattleHandler`, `PageController`)
- **Exports:** Default exports for classes, named exports for utility functions
- **Barrel files:** Each subdirectory has `index.js` re-exporting its modules
- **Config files:** kebab-case YAML
