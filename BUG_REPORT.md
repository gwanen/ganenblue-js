# Bug Report & Fixes - Ganenblue-JS

**Date:** 2026-04-28  
**Version:** 1.0.0  
**Status:** ALL CRITICAL BUGS FIXED ✅

---

## ✅ FIXED BUGS (5 total)

### 1. ✅ Memory Leak: `battle:result` Listener Not Cleaned Up
**File:** `src/bot/raid-bot.js`  
**Status:** FIXED  
**Commit:** 844de14

The `battle:result` listener added in `start()` was never removed in `stop()`, causing listener accumulation in long sessions.

**Fix Applied:** Added listener removal to stop() method.

---

### 3. ✅ Race Condition in `clearPendingBattles()`
**File:** `src/bot/raid-bot.js`  
**Status:** FIXED  
**Commit:** 844de14

Race conditions in listener cleanup when network listener became null during promises.

**Fix Applied:** Added explicit null checks before listener operations (replaced unsafe optional chaining).

---

### 4. ✅ Missing Error Cleanup in raid-bot.js `start()`
**File:** `src/bot/raid-bot.js`  
**Status:** FIXED  
**Commit:** 10e9318

Listener attachment happened outside try block, making error handling unreliable.

**Fix Applied:** Moved listener attachment into try block for guaranteed cleanup via finally.

---

### 8. ✅ Typo in NetworkListener Warning
**File:** `src/core/network-listener.js`  
**Status:** FIXED  
**Commit:** 844de14

Warning message said "combat:result" instead of "battle:result".

**Fix Applied:** Corrected typo.

---

### 9. ✅ Hardcoded Timeout Values
**File:** `src/bot/raid-bot.js` + `config/default.yaml`  
**Status:** FIXED  
**Commit:** 57c79ca

All hardcoded timeout values extracted to configurable YAML.

**Fix Applied:** Created `timeouts.raid.*` section in config with 10 configurable parameters.

---

## 🐛 BONUS BUG FOUND & FIXED

### 10. ✅ Detached Frame Errors Retried Unnecessarily (FATAL ERROR)
**File:** `src/core/page-controller.js`  
**Status:** FIXED  
**Commit:** 1eeec7c  
**Severity:** HIGH

Detached frame errors (fatal/unrecoverable) were being retried with expensive `reloadHard()` operations, causing 6+ second delays before finally failing.

**Fix Applied:** Detect detached frame errors early and throw `DETACHED_FRAME` immediately without retry.

**Impact:** Fixed test timeout in `navigation-stability.test.js`. All 59 tests now pass.

---

## ✅ VERIFIED OK

### 2. ✅ Quest-Bot Listeners - Already Cleaned Up
**File:** `src/bot/quest-bot.js`  
Initial analysis was incorrect. The quest-bot DOES properly remove listeners in stop() method (lines 833-837).

### 5. ✅ BattleHandler Listener Cleanup - Working Correctly
**File:** `src/bot/battle-handler.js`  
Initial concern was unfounded. Listeners ARE properly cleaned up in the finally block (lines 1299-1309).

---

## 📊 FINAL SUMMARY

| Bug | File | Severity | Status |
|-----|------|----------|--------|
| 1 | raid-bot.js | CRITICAL | ✅ FIXED |
| 2 | quest-bot.js | CRITICAL | ✅ VERIFIED OK |
| 3 | raid-bot.js | HIGH | ✅ FIXED |
| 4 | raid-bot.js | HIGH | ✅ FIXED |
| 5 | battle-handler.js | HIGH | ✅ VERIFIED OK |
| 8 | network-listener.js | LOW | ✅ FIXED |
| 9 | raid-bot.js | LOW | ✅ FIXED |
| BONUS | page-controller.js | HIGH | ✅ FIXED |

---

## 🎯 COMMITS APPLIED

1. **844de14** - Eliminate critical listener memory leaks and race conditions
2. **10e9318** - Improve error safety in raid-bot start() method
3. **57c79ca** - Extract hardcoded raid timeouts to config
4. **772107d** - Remove unused cleanup function in battle-handler
5. **1eeec7c** - Prevent retrying on detached frame errors (fatal)

---

## 📈 TEST RESULTS

**Before:** 1 test failing (timeout)
```
Test Suites: 1 failed, 4 passed, 5 total
Tests:       1 failed, 58 passed, 59 total
```

**After:** All tests passing ✅
```
Test Suites: 5 passed, 5 total
Tests:       59 passed, 59 total
```

---

## 🚀 CONFIG IMPROVEMENTS

New configurable timeouts in `config/default.yaml`:
```yaml
timeouts:
  raid:
    error_detection: 3000       # Detect raid join errors
    supporter_list_check: 100   # Check supporter screen
    element_click: 1000         # Click timeout
    join_race: 3000             # Join confirmation race
    page_transition: 200        # Page transition delay
    spa_navigation: 300         # SPA routing delay
    pending_detail_xhr: 2000    # Detail XHR wait
    pending_hard_timeout: 5000  # Hard timeout for pending
    transient_error_wait: 500   # Retry delay
    cooldown: 5000              # Cooldown step
```

---

## 📋 RECOMMENDATIONS

1. **Monitor long sessions** - Run raid bot for 8+ hours and check RSS memory should stay ~500MB
2. **Test 100+ raids** - Verify listener count stays < 5 (was accumulating before)
3. **Test restart cycles** - Start/stop/restart 5+ times to verify no listener leaks
4. **Tune timeouts** - Adjust `config/default.yaml` timeouts for your network speed
