# Phase 6: Replicard Result Detection - Context

**Gathered:** 2026-03-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Add support for detecting single-player/Replicard result screens in `NetworkListener`. This involves identifying the `/result/content/index/` URL pattern and emitting the `battle:result` event.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion

- **URL Pattern**: Add `url.includes('/result/content/index/')` to the existing battle result logical OR block in `_handleResponse`.
- **Event Emission**: Ensure the event data matches existing `battle:result` payload (`{ url, time: Date.now() }`).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/core/network-listener.js` — `_handleResponse` already has a block for `/result.json` and `/resultmulti/content/index/`.

### Established Patterns
- Result screens emit `battle:result`.
- Logs for results distinguish between "Combat Result" and "Empty".

</code_context>

<specifics>
## Specific Ideas
- The user provided a sample URL: `https://game.granbluefantasy.jp/result/content/index/1959222574?_=1774016281023&t=1774016281750&uid=30842985`
- This confirms the `/result/content/index/` pattern is the key differentiator from `/resultmulti/`.

</specifics>

<deferred>
## Deferred Ideas
- None — straightforward detection fix.
</deferred>
