# Phase 04: Core Layer Logging Audit - Context

**Gathered:** 2026-03-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Audit and standardize all log messages in the "Core" layer of the bot. This includes `src/core/browser.js`, `src/core/login-handler.js`, `src/core/network-listener.js`, and `src/core/page-controller.js`. The goal is to enforce tag consistency, sentence case, and remove redundant emojis or punctuation.
</domain>

<decisions>
## Implementation Decisions

### browser.js
- Replace all `[Status]` tags with `[Browser]`.
- Standardize launch/fallback messages (e.g., replace `[Status] Edge not found` with `[Browser] Edge not found`).
- Enforce sentence case and remove trailing periods.

### login-handler.js
- Remove double-nested tags like `[Status] [Login]` -> `[Login]`.
- Remove the `✓` prefix from success messages.
- Replace enthusiastic success messages (e.g., `✓ Automated login completed successfully!`) with clean, concise versions (e.g., `Login complete`).
- Use `...` only for ongoing actions (e.g., `Waiting for login button...`).

### network-listener.js
- Replace `[Memory]` tags with `[System]` for memory-related warnings.
- Standardize "Join error detected" messages across different detection paths.

### page-controller.js
- Replace `[Wait]` tags with domain-specific tags (usually `[Core]`).
- Replace `[Network]` tags for navigation errors with `[Core]`.
- Replace `[Performance]` tags with `[Browser]`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Core Requirements
- `.planning/REQUIREMENTS.md` — Defines LOG-03 and LOG-04.
- `implementation_plan.md` — The master style guide for this milestone.

</canonical_refs>

<code_context>
## Existing Code Insights

### Primary Files
- `src/core/browser.js`
- `src/core/login-handler.js`
- `src/core/network-listener.js`
- `src/core/page-controller.js`

### Target Patterns
- Search for `this.logger.info`, `this.logger.warn`, and `this.logger.error`.
- Identify strings with bracketed tags `[...]`.

</code_context>

<specifics>
## Specific Ideas
- Ensure all retry messages follow the `(N/M)` convention (e.g., `Retrying (1/3)`).
- All tags must be single capitalized words.
</specifics>

<deferred>
## Deferred Ideas
None — focus is strictly on the Core layer string audit.
</deferred>
