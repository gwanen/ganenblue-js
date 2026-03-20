# Technical Concerns & Known Issues

## Module System Inconsistency
- `src/core/index.js` and `src/bot/index.js` use `module.exports` (CommonJS) while all other source files use ES Module `export default`
- Works because Node.js allows CJS/ESM interop, but creates confusion and may break with stricter ESM enforcement

**Files:** `src/core/index.js:5`, `src/bot/index.js:5`

## Memory Leak Risks
- `page.$()` returns ElementHandle that must be explicitly disposed — missing `.dispose()` calls can leak
- NetworkListener's `setMaxListeners(150)` silences Node.js warnings but indicates many listeners may accumulate
- Caching `boundingBox()` in `BattleHandler.cachedCoords` (Map) grows unbounded within a battle — cleared on new battle, but long battles with many selectors could accumulate stale entries

**Files:** `src/core/page-controller.js:199-202`, `src/core/network-listener.js:12`, `src/bot/battle-handler.js:18`, `src/core/page-controller.js:196` (cachedClick)

## Credential Storage
- Login credentials stored in plaintext YAML (`config/credentials.yaml`)
- While gitignored, no encryption or OS keychain integration
- No credential rotation or expiry handling

**Files:** `config/credentials.yaml`, `src/core/browser.js:294-324`

## Hardcoded Browser Paths (Windows Only)
- All browser detection functions (`getEdgePath`, `getChromePath`, `getBravePath`, `getFirefoxPath`) use Windows-specific paths
- No macOS or Linux support
- `process.env.LOCALAPPDATA` used for user-local installs

**Files:** `src/core/browser.js:32-103`

## CSS Selector Fragility
- Game UI selectors in `config/selectors.yaml` are tightly coupled to GBF's DOM structure
- Any game UI update can break automation
- No fallback selectors or selector health checking
- Some selectors are brittle: `.lis-supporter:nth-child(1) .btn-supporter-use` (position-dependent)

**Files:** `config/selectors.yaml`

## BattleHandler Complexity
- `battle-handler.js` is 1314 lines — the largest and most complex file.
- `waitForBattleEnd()` is a massive while loop (~800 lines) with many flag-based state transitions.
- Dynamic timeout thresholds (`faInactivityThreshold`) add complexity
- Pre-registration flags (`_preSummonUsed`, `_preBossDied`, etc.) create a parallel state system that must stay in sync with network listeners

**Files:** `src/bot/battle-handler.js:493-939`

## No Error Recovery Beyond Refresh
- Primary recovery strategy for all failure modes is page reload
- No structured retry strategies for different error types
- No circuit breaker pattern — a permanently broken state will trigger infinite reload loops
- CAPTCHA detection pauses but requires manual resume

**Files:** `src/bot/battle-handler.js:948-1017`, `src/bot/quest-bot.js:544-556`

## Silent Error Swallowing
- Many `.catch(() => {})` blocks silently ignore errors
- NetworkListener's `_handleResponse` has a top-level try/catch that swallows all errors
- Makes debugging difficult when things go wrong

**Files:** `src/core/network-listener.js:197-199`

## No Multi-Profile Orchestration
- Profile-scoped logging exists (`createScopedLogger`) but no coordination between profiles
- Concurrent profile runs could collide on shared resources
- No IPC mechanism for multi-instance management

## Test Coverage Gaps
- No tests for Bot classes, PageController, BrowserManager, LoginHandler, Config
- BattleHandler tests replicate logic instead of importing the actual class (side-effect import issue)
- No integration or E2E tests
- No coverage tooling configured

## TODO/FIXME Comments
- `src/core/browser.js:347` — Fix #4: Orphaned profile cleanup was previously a stub
- `src/core/page-controller.js:53` — Memory optimization comment about CDP session cleanup
- Various "Fix" comments in battle-handler.js referencing specific numbered issues (Fix #3, etc.)

## Dependency Bloat Risk
- `puppeteer` + `puppeteer-extra` + 2 plugins + `user-agents` = significant install size
- `proxy-chain` listed as dependency but not visibly used in source
- `esbuild` dev dependency but no build scripts in package.json
