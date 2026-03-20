# Technology Stack

## Language & Runtime
- **Language:** JavaScript (ES Modules / ESM)
- **Module system:** `"type": "module"` in package.json
- **Runtime:** Node.js (CLI) + Electron (GUI)
- **Entry point CLI:** `src/cli/index.js` (shebang: `#!/usr/bin/env node`)
- **Entry point GUI:** `src/gui/main.js` (Electron)

## Core Frameworks & Libraries

| Library | Version | Purpose |
|---------|---------|---------|
| puppeteer | ^24.37.2 | Browser automation (Chromium) |
| puppeteer-extra | ^3.3.6 | Plugin system for puppeteer |
| puppeteer-extra-plugin-stealth | ^2.11.2 | Anti-detection stealth plugin |
| puppeteer-extra-plugin-recaptcha | ^3.6.8 | reCAPTCHA handling |
| user-agents | ^1.1.669 | Random user agent generation |
| electron | ^40.2.1 | Desktop GUI framework |
| commander | ^14.0.3 | CLI argument parsing |
| js-yaml | ^4.1.1 | YAML config parsing |
| dotenv | ^17.2.4 | Environment variable loading |
| winston | ^3.19.0 | Structured logging |
| proxy-chain | ^2.7.1 | Proxy server utilities |

## Dev Dependencies

| Library | Version | Purpose |
|---------|---------|---------|
| jest | ^30.2.0 | Test runner (ESM mode) |
| eslint | ^10.0.0 | Linting |
| prettier | ^3.8.1 | Code formatting |
| esbuild | ^0.27.3 | Bundling |
| electron-builder | ^26.8.1 | Electron packaging |
| nodemon | ^3.1.11 | Dev auto-reload |

## Configuration System
- **Runtime config:** `config/default.yaml` — loaded via `Config` class (`src/utils/config.js`)
- **CSS selectors:** `config/selectors.yaml` — game UI selectors, also loaded by Config
- **Credentials:** `config/credentials.yaml` — user login (gitignored)
- **Env overrides:** `QUEST_URL`, `HEADLESS` env vars override YAML values via `dotenv`

## Build & Scripts
- `npm run start` — launch Electron GUI
- `npm run cli` — run CLI bot
- `npm test` — Jest with `--experimental-vm-modules` (ESM support)
- `npm run dist` — Electron-builder for Windows (NSIS installer)
- `npm run audit:logs` — custom log standardization auditor (`scripts/audit-logs.js`)

## Key Files
- `package.json` — project root, ESM config
- `jest.config.js` — minimal: `{ testEnvironment: 'node', transform: {} }`
- `.editorconfig` — 2-space indent, LF line endings, UTF-8
