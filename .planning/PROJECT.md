# Ganenblue-JS

## Vision
A highly capable, stealth-focused browser automation bot for Granblue Fantasy that handles complex tasks like quest farming, raid backup joining, and skip nightmare farming without detection.

## Current Milestone (v3.0): Logging & UI Standardization

**Goal:** Standardize all log message copywriting, tag taxonomy, and the color/style system across the bot codebase.

**Target features:**
- Standardized, consistent terminology within bot logic (sentence case, no emojis).
- Unified tag taxonomy (`[Browser]`, `[Login]`, etc., removing ambiguous `[Status]` tags).
- Uniform Color styling (distinct P1/P2 logs, added `.log-level-success` borders).

## Key Features
- **Dual-Profile Support**: Run two instances simultaneously (p1, p2) with isolated browsers.
- **Network State Detection**: Intercepts GBF API responses for battle states rather than relying purely on DOM polling.
- **Advanced Stealth**: Human-like mouse movement via Bezier curves, Gaussian randomized clicks, and jitter delays.
- **SPA Navigation**: Smart handling of GBF's hash-based SPA router. 
- **Electron GUI**: Desktop interface with IPC bridge for controlling bot execution and streaming stats.
