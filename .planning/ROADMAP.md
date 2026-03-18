# Roadmap

## Current Milestone (v3.0): Logging & UI Standardization

### Phase 3: GUI Logging Standardization
*Goal: Add success log levels and ensure profile styling is uniform.*
- **Requirements:** LOG-01, LOG-02
- **Success Criteria:**
  1. `index.html` has `.log-level-success` bound to `--accent-green`.
  2. `main.js` and `renderer.js` use `[System]` instead of `[Gui]` or `[Status]`.
  3. Log output visually aligns with the color specification.

### Phase 4: Core Layer Logging Audit
*Goal: Enforce text styling and remove ambiguous tags from the core backend wrappers.*
- **Requirements:** LOG-03, LOG-04
- **Success Criteria:**
  1. `[Status]` tag is completely removed from `browser.js` and `login-handler.js`.
  2. All core handlers use sentence case with no trailing punctuation.
  3. `login-handler.js` properly ends async ongoing events with `...`

### Phase 5: Bot Layer Logging Audit
*Goal: Standardize high-volume tactical strings.*
- **Requirements:** LOG-05, LOG-06
- **Success Criteria:**
  1. `battle-handler.js` retry logs conform to the `(1/3)` convention instead of `attempt 1/3`.
  2. `[Wait]` strings converted to appropriate domain tags.
  3. All tests pass successfully and no logical regressions exist.

---

## Past Milestones

### Milestone v2.0
*Focus: Caching button coordinates, streamlining the battle loop, and reducing interaction delays.*
- Phase 1: Battle Core Optimizations
- Phase 2: Enhanced Click Randomization
