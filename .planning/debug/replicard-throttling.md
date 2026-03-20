# Debug Session: Replicard Throttling / Latency

## Symptoms
- **Expected**: "Ultra-Snappy" (sub-100ms) transitions between quest steps.
- **Actual**: 
    - 3-second delay between "Engaging target" and "Engagement screen detected".
    - 3-5 second delay between "Supporter selection confirmed" and "Battle engagement initiated".
- **Timeline**: Noticed after the Replicard Reliability Fixes (Phase 5).
- **Reproduction**: Run semi_auto bot in Replicard Sandbox.

## Investigation Log

### Hypothesis 1: Redundant `sleep` in `startReplicardBattle`
The newly added logic in `startReplicardBattle` might have introduced hardcoded delays or slow polling intervals.

### Hypothesis 2: `validatePostClick` polling is too slow
The `validatePostClick` method in `quest-bot.js` might be waiting too long for the URL transition or using a slow `sleep(50)` loop.

### Hypothesis 3: `waitForFrameStable` or `sleep(800)` after popups
There are several `sleep(800)` and `waitForFrameStable(500)` calls in `validatePostClick` that might be firing unnecessarily.

## Evidence Audit (from User Logs)
Step 14:
- 8:56:57: Navigation (SPA)
- 8:56:58: Engaging target (+1s)
- 8:57:01: Engagement screen detected (+3s) -> **SLOW**
- 8:57:01: Supporter selection confirmed
- 8:57:06: Battle engagement initiated (+5s) -> **VERY SLOW**

## Root Cause Found
The "throttling" was caused by:
1.  **3-second timeout** in `startReplicardBattle` checking for map monsters that don't exist in direct-link farming.
2.  **Hardcoded 800ms sleeps** in `validatePostClick` after popup dismissals.
3.  **Slow 100ms polling** in `waitForFrameStable` affecting all SPA transitions.

## Resolution
- Tightened all polling intervals to 10-20ms.
- Reduced map monster timeout to 500ms.
- Replaced 800ms sleeps with 50ms snappiness yields.
- Tightened SPA/Reload stability guards.

**Status: Resolved**
