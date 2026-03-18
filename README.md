# Ganenblue-JS

A highly capable, stealth-focused browser automation bot for Granblue Fantasy that handles complex tasks like quest farming, raid backup joining, and skip nightmare farming without detection.

## Project Structure

```
ganenblue-js/
├── src/
│   ├── bot/              # Bot implementations
│   │   ├── battle-handler.js
│   │   ├── quest-bot.js
│   │   ├── raid-bot.js
│   │   ├── skip-bot.js
│   │   └── index.js      # Barrel export
│   ├── cli/              # CLI entry points
│   │   ├── index.js      # Main CLI (gbf-bot)
│   │   └── test-stealth.js
│   ├── core/             # Core browser automation
│   │   ├── browser.js
│   │   ├── login-handler.js
│   │   ├── network-listener.js
│   │   ├── page-controller.js
│   │   └── index.js      # Barrel export
│   ├── gui/              # Electron GUI
│   │   ├── index.html
│   │   ├── main.js
│   │   ├── preload.cjs
│   │   ├── renderer.js
│   │   └── index.js      # Barrel export
│   └── utils/            # Shared utilities
│       ├── config.js
│       ├── logger.js
│       ├── notifier.js
│       ├── random.js
│       └── index.js      # Barrel export
├── config/               # Configuration files
│   ├── default.yaml
│   ├── selectors.yaml
│   └── credentials.example.yaml
├── data/                 # Browser profiles, user data
├── logs/                 # Application logs
├── tests/                # Test files
├── .planning/            # Project planning (gitignored)
│   ├── LOG-STANDARDIZATION-WORKFLOW.md
│   └── LOG-QUICK-REFERENCE.md
├── scripts/              # Utility scripts
│   └── audit-logs.js
├── .editorconfig         # Code style
├── .gitattributes        # Git metadata
├── .gitignore
├── package.json
└── README.md
```

## Quick Start

1. **Clone**: `git clone https://github.com/gwanen/ganenblue-js.git`
2. **Install**: `npm install`
3. **Launch GUI**: `npm start`
4. **CLI Usage**: `npm run cli -- raid --max 100`

## Features

- **Dual-Profile Support**: Run two instances simultaneously (p1, p2) with isolated browsers
- **Network State Detection**: Intercepts GBF API responses for battle states
- **Advanced Stealth**: Human-like mouse movement, Gaussian randomized clicks, jitter delays
- **SPA Navigation**: Smart handling of GBF's hash-based SPA router
- **Electron GUI**: Desktop interface with IPC bridge for controlling bot execution
- **Standardized Logging**: Consistent log tags and colors across all bot modes

## Development

### Log Standardization

All log messages follow a standardized tag taxonomy for consistent GUI display.

**Quick Reference:** See `.planning/LOG-QUICK-REFERENCE.md`

**Full Workflow:** See `.planning/LOG-STANDARDIZATION-WORKFLOW.md`

**Audit Logs:** Run `npm run audit:logs` to check for non-compliant log messages.

```bash
# Check log standardization
npm run audit:logs
```

## Configuration

Edit `config/default.yaml` for bot settings.Selectors in `config/selectors.yaml` may need updates if GBF UI changes.

## License

CC BY-NC 4.0 — Educational and personal research only.
