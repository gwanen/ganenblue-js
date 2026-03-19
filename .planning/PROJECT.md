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

### Active

- [ ] Skill refresh — reload page after each skill usage in Full Auto mode to skip skill animations
- [ ] Skill refresh config option in `config/default.yaml`
- [ ] Skill refresh toggle in Electron GUI panel

### Out of Scope

- Semi Auto skill refresh — FA only for now
- Proxy rotation — library included but not implemented
- Multi-profile coordination — no IPC between instances

## Context

- **Ecosystem:** GBF is a browser-based SPA with hash routing (`#quest`, `#raid`, etc.)
- **Animation patterns:** GBF plays CSS animations for attacks, summons, and skills. The bot skips these by reloading the page immediately after the server processes the action.
- **Existing refresh patterns:** `summonRefresh` and `fastRefresh` already handle summon and attack animations. `skillRefresh` fills the gap for individual skill usage animations.
- **Network signals:** `battle:ability_used` event already exists in `NetworkListener` — fires when skill JSON (`ability_result.json`) is intercepted. This will drive the skill refresh.
- **Battle loop:** `waitForBattleEnd()` in `battle-handler.js` is the main event loop that checks flags and triggers reloads.

## Constraints

- **Tech stack:** JavaScript ES Modules, Puppeteer, Electron — no TypeScript
- **Pattern:** Follow existing `summonRefresh` pattern exactly (constructor option, flag in network handler, reload block in waitForBattleEnd)
- **GUI:** Add toggle to existing Electron panel alongside `fastRefresh` and `summonRefresh`
- **Full Auto only:** Skill refresh only applies when `mode !== 'semi_auto'`

## Key Decisions

| Decision                  | Rationale                                                                   | Outcome   |
| ------------------------- | --------------------------------------------------------------------------- | --------- |
| Refresh after every skill | Simplest approach, matches summon refresh behavior                          | — Pending |
| Full Auto only            | Semi Auto already has per-attack refresh, skill refresh adds no value there | — Pending |
| Config + GUI toggle       | User requested toggleable via GUI panel                                     | — Pending |

---

_Last updated: 2026-03-20 after initialization_
