# Phase 05: Bot Layer Logging Audit - Context

**Gathered:** 2026-03-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Audit and standardize all log messages in the "Bot" logic layer. This includes `src/bot/battle-handler.js`, `src/bot/quest-bot.js`, `src/bot/raid-bot.js`, and `src/bot/skip-bot.js`. The focus is on domain-specific tags and removal of enthusiastic formatting.
</domain>

<decisions>
## Implementation Decisions

### battle-handler.js
- Replace `[Wait]` with `[Battle]`.
- Enforce sentence case and remove trailing periods.
- Standardize result detection logs.

### bot logic (quest, raid, skip)
- Replace all generic `[Status]` tags with domain-specific tags:
    - `quest-bot.js` -> `[Quest]`
    - `raid-bot.js` -> `[Raid]`
    - `skip-bot.js` -> `[Skip]`
- Remove the `✓` prefix from success messages.
- Standardize cycle/loop logs (e.g. `[Quest] Starting run 1/10`).
- Consistent wording for bot start/stop/pause events.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Core Requirements
- `.planning/REQUIREMENTS.md` — Defines LOG-05.
- `implementation_plan.md` — The master style guide for this milestone.

</canonical_refs>

<code_context>
## Existing Code Insights

### Primary Files
- `src/bot/battle-handler.js`
- `src/bot/quest-bot.js`
- `src/bot/raid-bot.js`
- `src/bot/skip-bot.js`

### Target Patterns
- Search for `this.logger.info`, `this.logger.warn`, etc.
- Focus on loops and state transition messages.

</code_context>

<specifics>
## Specific Ideas
- All tags must be single capitalized words.
- All messages must be concise and use sentence case.
</specifics>

<deferred>
## Deferred Ideas
None.
</deferred>
