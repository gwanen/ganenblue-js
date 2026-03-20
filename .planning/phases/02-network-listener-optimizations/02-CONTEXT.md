# Phase 2: Network Listener Optimizations - Context

**Gathered:** 2026-03-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Reduce CPU and memory overhead in the `NetworkListener._handleResponse` pipeline by filtering earlier, parsing later, and short-circuiting on resource types. Pure infrastructure optimization — no user-facing behavior changes.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion

All implementation choices are at Claude's discretion — pure infrastructure phase.

</decisions>

<code_context>

## Existing Code Insights

### Reusable Assets

- `src/core/network-listener.js` — `_handleResponse` method (~130 lines), `_hasBattleListeners()` guard, `_isRaidUrl()` helper
- `src/core/network-listener.js` — existing URL pattern checks for battle results, start.json, action results

### Established Patterns

- URL string checks run sequentially (no ordering optimization)
- `_hasBattleListeners()` guards only the attack/ability/summon/fatal_chain result block
- JSON parsing via `response.json()` called regardless of content-length
- resourceType check done AFTER first URL check (non-optimal ordering)

### Integration Points

- `NetworkListener` class — `_handleResponse` is the sole entry point
- `BattleHandler` — subscribes to battle events emitted by NetworkListener
- Playwright's `response.request().resourceType()` — returns string type

</code_context>

<specifics>
## Specific Ideas

- Swap resourceType check before URL check (~33% fewer string operations on non-GBF responses)
- Add `battle:result` and `raid:*` events to `_hasBattleListeners()` guard
- Content-length pre-check before JSON parse (skip responses >100KB)
- Lazy scenario parsing — only scan for terminal cmd instead of full Array.find on every response
- Reorder URL filters for early bailout on most-common cases

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>
