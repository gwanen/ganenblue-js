# Requirements

## Milestone v3.2 Requirements: UI Modernization

### Design System
- [ ] **UI-01**: Create UI-SPEC.md with color palette, typography, spacing system
- [ ] **UI-02**: Define component patterns (buttons, inputs, panels, badges)

### Implementation
- [x] **UI-03**: Refine dark theme with proper contrast ratios (WCAG AA minimum)
- [x] **UI-04**: Standardize buttons/inputs per design contract
- [x] **UI-05**: Decide and implement log panel behavior (embedded vs separate window)

### Accessibility & Polish
- [x] **UI-06**: Add ARIA labels to all interactive elements
- [x] **UI-07**: Implement CSS micro-interactions (focus states, scrollbars, selection)

### Layout Polish
- [x] **UI-11**: Standardize profile-column layout — fix blank space after profile name/status badge, normalize button sizes in btn-group, enforce consistent margin/padding tokens across P1 and P2 columns, replace inline `style=` overrides with CSS classes.

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| UI-01 | Phase 8 | Pending |
| UI-02 | Phase 8 | Pending |
| UI-03 | Phase 9 | Complete |
| UI-04 | Phase 9 | Complete |
| UI-05 | Phase 9 | Complete |
| UI-06 | Phase 10 | Complete |
| UI-07 | Phase 10 | Complete |
| UI-11 | Phase 11 | Complete |

**Coverage:**
- v3.2 requirements: 8 total
- Mapped to phases: 8
- Unmapped: 0 ✓

## Milestone v3.1 Requirements: Repository Hygiene

### Configuration
- [x] **CONF-01**: Add .editorconfig with code style standards (indentation, charset, line endings)
- [x] **CONF-02**: Add .gitattributes for GitHub language stats (mark generated files correctly)

### Source Structure
- [x] **SRC-01**: Create barrel exports (index.js) in src/ modules for clean imports
- [x] **SRC-02**: Ensure all src/ modules have consistent export patterns

### Documentation
- [x] **DOCS-01**: Update README.md with project structure diagram showing src/, config/, data/ layout
- [x] **DOCS-02**: Add CONTRIBUTING.md with setup instructions, coding conventions, and PR guidelines

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| CONF-01 | Phase 6 | Complete |
| CONF-02 | Phase 6 | Complete |
| SRC-01 | Phase 7 | Complete |
| SRC-02 | Phase 7 | Complete |
| DOCS-01 | Phase 7 | Complete |
| DOCS-02 | Phase 7 | Complete |

**Coverage:**
- v3.1 requirements: 6 total
- Mapped to phases: 6
- Unmapped: 0 ✓

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
- [x] **LOG-01**: Implement `.log-level-success` green borders and document P1/P2 tag colors in CSS.
- [x] **LOG-02**: Pass `'success'` log level explicitly from GUI frontend loggers.

### Core Backend 
- [x] **LOG-03**: Consolidate `[Status]`, `[Gui]`, `[Performance]`, etc. tags into single-word domain concepts (`[Browser]`, `[System]`, `[Core]`).
- [x] **LOG-04**: Remove redundant punctuation (trailing periods, emojis) and enforce sentence case., no periods, concise descriptions) across `browser.js`, `login-handler.js`, `network-listener.js`, `page-controller.js`.

### Bot Logic
- [x] **LOG-05**: Audit and standardize `battle-handler.js` logging (Phase 5).
- [x] **LOG-06**: Domain-specific tag mapping for `quest-bot.js`, `raid-bot.js`, `skip-bot.js` (Phase 5).
- [x] **LOG-07**: Ensure all retry loops output clear counts (e.g. `Retrying (1/3)...`).
