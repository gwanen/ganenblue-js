# Debug Session: Intermittent Semi-Auto Timeout After Battle End

## Symptoms
- **Expected**: Bot should exit `waitForBattleEnd` immediately when `battle:result` or `battle:boss_died` is detected.
- **Actual**: Bot logs `[Semi Auto] Timeout (display-on missing)` and waits 10s before finally exiting.
- **Timeline**: Occurs intermittently after the latest snappiness/timeout changes.
- **Reproduction**: Fast battle conclusion where `start.json` and `result.json` are both intercepted during a reload.

## Investigation Log

### Hypothesis 1: Priority Inversion in `waitForBattleEnd`
In `src/bot/battle-handler.js`, the main battle loop checks for `networkTurnReady` (Priority 1) before `networkFinished/bossDied` (Priority 0).

**Evidence:**
```javascript
770:         // --- PRIORITY 1: Semi-Auto Detection (network-driven) ---
771:         if (isSemiAuto && networkTurnReady) {
...
786:         // --- PRIORITY 0: Network end-state signals (fastest) ---
787:         if (bossDied || partyWiped) { ... }
806:         if (networkFinished) { ... }
```

If both `networkTurnReady` and `networkFinished` become true in the same tick (due to a double-event or rapid reload), the bot enters `handleSemiAuto()`. Since the boss is actually dead, the `.display-on` attack button never appears, causing a **10-second timeout wait**. Only **after** this timeout does the loop continue to line 806 to see that the battle is over.

### Hypothesis 2: `networkTurnReady` logic error
When the boss dies, the page reloads. This reload might trigger a `start.json` which sets `networkTurnReady = true`. If the `result.json` hasn't been processed yet or is processed slightly later, the bot "thinks" a new turn started.

## Root Cause Found
The battle loop prioritizes attacking over ending. When both conditions are met (new turn + battle ended), the bot attempts an attack on a non-existent UI.

## Recommended Fix
Move Priority 0 (End-State Detection) to the absolute top of the `while` loop in `waitForBattleEnd`.

## Resolution
Fixed by re-ordering the `waitForBattleEnd` loop logic in `BattleHandler.js`. The bot now performs a non-blocking check for `bossDied` and `networkFinished` before entering the potentially blocking `handleSemiAuto` logic. 

**Status: Resolved**
