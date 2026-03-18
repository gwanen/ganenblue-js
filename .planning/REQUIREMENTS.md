# Requirements

## Implemented (v1)
- **[REQ-001] Quest Automation**: `quest-bot.js` capable of running replicard, xeno, and standard quests.
- **[REQ-002] Raid Backup**: `raid-bot.js` handling join limits, support summons, and honor target stopping.
- **[REQ-003] Skip Nightmare**: `skip-bot.js` for skipping nightmare prompts and claiming loot.
- **[REQ-004] Stealth Mechanics**: Mouse movement, delays, and plugin configuration.
- **[REQ-005] Electron GUI**: Profile management and statistical readouts.

## Implemented (v2)
- **[REQ-006] Auto logic flow creation**: Streamlining Full Auto and Semi Auto mode boundaries.
- **[REQ-007] Battle delay reduction**: Optimizing button coordinate caching.

## Milestone v3.0 Requirements: Logging & UI

### Styling
- [ ] **LOG-01**: Implement `.log-level-success` green borders and document P1/P2 tag colors in CSS.
- [ ] **LOG-02**: Pass `'success'` log level explicitly from GUI frontend loggers.

### Core Backend 
- [ ] **LOG-03**: Consolidate `[Status]`, `[Gui]`, `[Performance]`, etc. tags into single-word domain concepts (`[Browser]`, `[System]`, `[Core]`).
- [ ] **LOG-04**: Standardize Core log messages (Sentence case, no periods, concise descriptions) across `browser.js`, `login-handler.js`, `network-listener.js`, `page-controller.js`.

### Bot Logic
- [ ] **LOG-05**: Standardize Bot log messages (Sentence case, no periods, concise descriptions) across `battle-handler.js`, `quest-bot.js`, `raid-bot.js`, `skip-bot.js`.
- [ ] **LOG-06**: Ensure all retry loops output clear counts (e.g. `Retrying (1/3)...`).
