# Code Conventions

## Module System
- **ES Modules** throughout (`"type": "module"` in package.json)
- `import`/`export` syntax only — no `require()` in source files
- Exception: `src/core/index.js` and `src/bot/index.js` use `module.exports` (CJS barrel files for mixed compatibility)

## Code Style
- **Indentation:** 2 spaces (`.editorconfig`)
- **Line endings:** LF
- **Quotes:** Single quotes for JS strings
- **Semicolons:** Yes (used consistently)
- **Trailing whitespace:** Trimmed (except `.md` files)
- **Final newline:** Inserted

## Naming Conventions
- **Files:** kebab-case (`battle-handler.js`, `page-controller.js`)
- **Classes:** PascalCase (`BattleHandler`, `NetworkListener`)
- **Functions/variables:** camelCase (`handleFullAuto`, `lastActionTime`)
- **Constants:** camelCase (`maxWaitMs`, `hardReloadInterval`)
- **Private methods:** Underscore prefix (`_handleResponse`, `_isRaidUrl`, `_hasBattleListeners`)
- **Event names:** colon-separated namespace (`battle:result`, `raid:error`, `battle:boss_died`)

## Logging Conventions
Winston-based logging with bracketed tags:
```javascript
this.logger.info('[Battle] Activating Full Auto');
this.logger.warn('[Browser] Edge not found. Falling back to Chromium');
this.logger.error('[Error] [Login] Automation failed:', error.message);
this.logger.debug('[Network] Turn 5 started');
```

**Standard tags** (enforced by `scripts/audit-logs.js`):
`System`, `Bot`, `Battle`, `Quest`, `Raid`, `Safety`, `Browser`, `Wait`, `Error`, `Network`, `FA`, `SA`, `Summon`, `Target`, `Honor`, `Turn`, `Full`, `Cleared`, `Performance`, `Core`

**Format:** `[Tag] Message` — always a bracketed tag at the start.
**Scoped loggers:** Use `createScopedLogger(profileId)` from `logger.js` for profile-aware logging.

## Error Handling Patterns
- **Network errors:** Detected via `PageController.isNetworkError()` — checks message for `Navigation timeout`, `net::ERR`, `Session closed`, etc.
- **Retry with backoff:** `PageController.retryOnNetworkError(fn, maxRetries, operation)` — exponential backoff (2s, 4s, 6s)
- **Graceful degradation:** Most operations catch errors and return fallback values (e.g., `false`, `null`) rather than throwing
- **Detached frames:** Explicit handling via `isFrameAttached()` and `waitForFrameStable()` — critical after page reloads
- **Silent failures:** Some operations use `.catch(() => {})` for non-critical cleanup (e.g., `element.dispose()`, popup dismissal)

## Async Patterns
- `async/await` throughout — no raw Promises chains
- `Promise.race()` for competing signals (network vs DOM detection)
- `sleep()` utility with jitter for human-like timing
- `setTimeout` wrapped in Promises for timeouts with cleanup

## Class Structure Pattern
Classes follow a consistent pattern:
1. Constructor with options destructuring
2. Scoped logger assignment
3. State initialization
4. `start()` — main loop entry
5. `stop()` — cleanup and shutdown
6. `pause()` / `resume()` — session control
7. `getStats()` — current state reporting

## Configuration Pattern
- YAML-based config via `Config` singleton
- Dot notation access: `config.get('bot.quest_url')`
- Environment variable overrides: `QUEST_URL`, `HEADLESS`
- Selectors isolated in `config/selectors.yaml` — UI changes only require selector updates

## Stealth & Human-Like Behavior
- **Clicks (Standard):** Gaussian distribution around element center (sigma = 1/6 of element size) via `clickSafe()`
- **Clicks (Fast):** `cachedClick()` bypasses DOM lookups by caching bounding boxes; uses uniform random offset (±2px) and high-speed Bezier movement for time-critical actions (Auto/Attack).
- **Mouse movement:** Bezier curves with randomized control points; `fast` mode skips per-point delays.
- **Typing:** Variable delay per character (50-150ms)
- **Delays:** `randomDelay()` and `sleep()` with jitter (default 20%)
- **User agents:** Randomized via `user-agents` library
- **Stealth plugin:** `puppeteer-extra-plugin-stealth` applied at launch

## Memory Management
- `element.dispose()` after bounding box reads to prevent leaks
- Periodic `global.gc()` every 100 loop iterations (when exposed via `--expose-gc`)
- Hard page reload every 30 minutes to clear accumulated DOM/JS heap
- Listener cleanup in `finally` blocks
- Scoped profiles cleaned up on close and via orphan cleanup (24h cutoff)
