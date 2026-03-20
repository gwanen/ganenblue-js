# Phase 1: Skill Refresh Implementation - Context

**Gathered:** 2026-03-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Add configurable skill refresh to Full Auto battles. After each skill usage, reload the page to skip skill animations. Toggle via GUI checkbox (default: OFF) with localStorage persistence. Follow existing `summonRefresh` pattern exactly.

</domain>

<decisions>
## Implementation Decisions

### Race Condition Handling

- When `battle:ability_used` fires, set `abilityUsed = true` flag
- Check flag AFTER Priority 0 (boss died / party wiped / network finished) in waitForBattleEnd loop
- Only refresh if no higher-priority event is pending

### GUI Placement

- Checkbox goes after "Refresh on Summon" in Options section
- Checkbox label: "Refresh on Skill"
- Default: unchecked (OFF)
- State persists via localStorage (same pattern as summonRefresh)

### Logging

- Use `[Ability]` tag for skill refresh log messages
- Example: `this.logger.info('[Ability] Refreshing page after skill usage')`

### Debounce

- No debounce needed — FA processes one ability at a time
- No pre-registration of ability events (abilities don't fire during page transitions)

</decisions>

<code_context>

## Existing Code Insights

### Reusable Assets

- `battle-handler.js` — `summonRefresh` pattern (constructor option → network flag → reload block)
- `renderer.js` — localStorage save/load pattern for toggles
- `index.html` — checkbox markup pattern in Options section

### Established Patterns

- Network event handlers set flags → waitForBattleEnd loop checks flags → reload if enabled
- GUI toggles: checkbox with `id="summon-refresh-${pid}"`, saved in `saveProfileSettings`, loaded in `loadProfileSettings`, passed to `startBot`

### Integration Points

- `BattleHandler` constructor — add `skillRefresh` option
- `waitForBattleEnd` loop — add reload block after summon refresh, before attack refresh
- `index.html` Options section — add checkbox for both p1 and p2
- `renderer.js` — add to save, load, inputs array, and startBot settings

</code_context>

<specifics>
## Specific Ideas

- Follow `summonRefresh` pattern exactly
- `battle:ability_used` network event already exists — just needs flag + reload logic
- Separate `onAbilityUsed` handler from existing `onAbilityOrSummon` timing handler

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>
