# GANENBLUE-JS

## What This Is

GANENBLUE-JS is a Granblue Fantasy automation bot built with Puppeteer (JS) and Electron. It automates quest farming, raid backups, and skip nightmare runs by controlling a Chromium browser and interacting with GBF's DOM and API responses. The bot supports Full Auto, Semi Auto, and skip modes with human-like stealth behavior.

## Core Value

The bot must reliably automate GBF battles end-to-end without manual intervention, with animation-skipping refreshes that speed up farming runs.

## Requirements

### Validated

- ✓ Browser automation with stealth plugin (Puppeteer + user-agents)
- ✓ Multi-browser support (Chromium, Chrome, Edge, Brave, Firefox)
- ✓ Full Auto mode — click FA button, monitor battle via network + DOM
- ✓ Semi Auto mode — click attack per turn, refresh after each
- ✓ Skip Nightmare mode — auto-clear result screens
- ✓ Raid backup search, join, and concurrent-limit handling
- ✓ Summon refresh — reload page after summon to skip animation
- ✓ Attack refresh — reload page after attack to skip animation
- ✓ Network listener — intercept GBF API responses for game state
- ✓ Discord webhook notifications (errors, CAPTCHA)
- ✓ CLI interface with Commander subcommands
- ✓ Electron GUI with IPC communication
- ✓ YAML config with env var overrides
- ✓ Profile-scoped logging with Winston
- ✓ **Skill Refresh:** Reload page after skill usage in FA mode — v1.0
- ✓ **Network Listener Optimizations:** Early filtering and lazy parsing — v1.0
- ✓ **Ultra-Snappy Interaction:** cachedClicks + 50ms poll — v1.0
- ✓ **Logging Standardization:** Global Rigid Formal style — v1.0
- ✓ **Replicard Stability:** Hash-routing + Quick Select — v1.0
- ✓ **Result Detection:** SP/Replicard result patterns — v1.0

### Active

- (Planning next milestone ...)

### Out of Scope

- Semi Auto skill refresh — FA only for now
- Proxy rotation — library included but not implemented
- Multi-profile coordination — no IPC between instances

## Context

- **Ecosystem:** GBF is a browser-based SPA with hash routing (`#quest`, `#raid`, etc.)
- **Performance:** Achieved ~20% faster turn-cycling via snappiness optimizations in v1.0.
- **Reliability:** Dedicated support for Replicard Sandbox mechanics and result detection.
- **Tech stack:** JavaScript ES Modules, Puppeteer, Electron.

## Key Decisions

| Decision                  | Rationale                                                                   | Outcome   |
| ------------------------- | --------------------------------------------------------------------------- | --------- |
| Refresh after every skill | Simplest approach, matches summon refresh behavior                          | ✓ Good    |
| Full Auto only            | Semi Auto already has per-attack refresh, skill refresh adds no value there | ✓ Good    |
| Config + GUI toggle       | User requested toggleable via GUI panel                                     | ✓ Good    |
| Quick Select support      | Handle Replicard's unique supporter selection screen                        | ✓ Good    |
| Rigid Formal Logging      | Improve debuggability and professional console appearance                   | ✓ Good    |

---

_Last updated: 2026-03-21 after v1.0 Replicard & Performance Milestone_
