# Semi-Auto to Full-Auto Activation Bug Investigation

## Issue Summary

Semi-auto battle incorrectly activates full auto mode during stuck recovery

## Log Sequence

```
4:14:56 PMP1[Battle] Engaging (semi_auto)
4:14:56 PMP1[Battle] Ready
4:15:01 PMP1[Semi Auto] Timeout (display-on missing). Refreshing
4:15:01 PMP1[Core] Reloading page...
4:15:17 PMP1[Battle] UI missing (stuck). Refreshing
4:15:17 PMP1[Core] Reloading page...
4:15:18 PMP1[Battle] Activating Full Auto
[Note: full auto appears in semi auto mode - wrong behavior]
```

## Root Cause Analysis

### Bug Location: battle-handler.js lines 906-932

The watchdog logic for detecting stuck battles (missing UI) unconditionally calls `handleFullAuto()` regardless of the current battle mode:

```javascript
// Watchdog Logic: Detect stuck battles (no network activity + no UI)
if (!attackState.isAttacking) {
  if (attackState.uiVisible) {
    missingUiCount = 0;
  } else {
    missingUiCount++;
    if (missingUiCount >= 6) {
      // ~18s with 3s checks
      this.logger.warn("[Battle] UI missing (stuck). Refreshing");
      await this.controller.reloadPage();
      await sleep(this.fastRefresh ? 100 : 200);
      this.controller.clearClickCache();
      try {
        await this.handleFullAuto(); // <-- BUG: Always calls FA regardless of mode!
      } catch (e) {
        this.logger.warn(`[Battle] Re-engagement failed: ${e.message}`);
      }
      lastFACheckTime = Date.now();
      missingUiCount = 0;
    }
  }
}
```

### Secondary Issue: display-on timeout

The "Timeout (display-on missing)" at line 464-468 is caused by `handleSemiAuto()` failing to find `.btn-attack-start.display-on` within 5 seconds. This may be related to speed optimizations (cachedClick with 15ms delay) causing the button to be clicked before it's fully ready.

## Fix Required

1. **Primary Fix (Line 919):** Add mode check - for semi_auto, set `networkTurnReady = true` so the main loop will handle re-engagement correctly (or call handleSemiAuto)

2. **Secondary Fix:** Consider whether cachedClick delay (15ms) is sufficient for display-on state changes

## Code Review of handleFullAuto Calls

| Line | Context               | Mode Check                 | Status  |
| ---- | --------------------- | -------------------------- | ------- |
| 239  | executeBattle         | Yes (mode === "full_auto") | OK      |
| 919  | Watchdog (UI missing) | **NO**                     | **BUG** |
| 947  | summonUsed handler    | Yes (mode !== "semi_auto") | OK      |
| 965  | abilityUsed handler   | Yes (mode !== "semi_auto") | OK      |
| 1007 | attackUsed handler    | Yes (mode !== "semi_auto") | OK      |
| 1030 | FA Persistence        | Yes (mode === "full_auto") | OK      |
| 1050 | FA Inactivity         | Yes (mode === "full_auto") | OK      |
| 1276 | checkStateAndResume   | Yes (mode === "full_auto") | OK      |

## Speed Optimization Impact

- `cachedClick()` uses only 15ms stability delay (line 472, 355)
- This may be too fast for the `.display-on` state to stabilize after page load
- Could contribute to the initial "Timeout (display-on missing)" at 4:15:01
