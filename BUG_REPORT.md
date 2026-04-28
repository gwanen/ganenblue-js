# Bug Report - Ganenblue-JS

**Date:** 2026-04-28  
**Version:** 1.0.0

---

## 🔴 CRITICAL BUGS

### 1. Memory Leak: `battle:result` Listener Not Cleaned Up in `raid-bot.js`
**File:** `src/bot/raid-bot.js`  
**Location:** Lines 186-191 (start) and 1165-1181 (stop)  
**Severity:** CRITICAL

**Issue:**
In the `start()` method, the bot registers a listener for `battle:result`:
```javascript
this.controller.network.on("battle:result", this.onBattleResult);  // Line 190
```

However, in the `stop()` method, this listener is **never removed**:
```javascript
stop() {
  // ...removes raid:error, battle:start, raid:supporter_screen
  // BUT MISSING: this.controller.network.removeListener("battle:result", this.onBattleResult);
}
```

**Impact:** 
- Each raid session accumulates another listener without cleanup
- Long-running raid sessions will have dozens of duplicate listeners
- Memory leak increases with session duration
- NetworkListener already warns about this (line 30-31 of network-listener.js)

**Fix:**
```javascript
stop() {
    // ... existing code ...
    if (this.controller.network) {
        this.controller.network.removeListener("raid:error", this.onRaidError);
        this.controller.network.removeListener("battle:start", this.onBattleStart);
        this.controller.network.removeListener("raid:supporter_screen", this.onSupporterScreen);
        this.controller.network.removeListener("battle:result", this.onBattleResult);  // ADD THIS
    }
}
```

---

### 2. Memory Leak: Quest-Bot Network Listeners Not Cleaned Up
**File:** `src/bot/quest-bot.js`  
**Location:** Lines 86-92 (start) and missing cleanup in stop()  
**Severity:** CRITICAL

**Issue:**
Network listeners are registered but never removed:
```javascript
// start() method - listeners registered
this.controller.network.on("raid:error", this.onRaidError);
this.controller.network.on("raid:supporter_screen", this.onSupporterScreen);

// stop() method - NO CLEANUP
stop() {
    this.isRunning = false;
    this.battle.stop();
    this.controller.stop().catch(/* ... */);
    // Missing listener cleanup
}
```

**Impact:**
- Same listener accumulation as raid-bot
- Affects quest farming sessions

**Fix:**
Add cleanup to `stop()` method in quest-bot.js:
```javascript
stop() {
    this.isRunning = false;
    if (this.battle) this.battle.stop();
    
    if (this.controller.network) {
        this.controller.network.removeListener("raid:error", this.onRaidError);
        this.controller.network.removeListener("raid:supporter_screen", this.onSupporterScreen);
    }
    
    this.controller.stop().catch(e => 
        this.logger.warn("[Performance] Failed to stop controller", e)
    );
    this.logger.info("[System] Shutdown requested");
}
```

---

### 3. Listener Cleanup Race Condition in `clearPendingBattles()`
**File:** `src/bot/raid-bot.js`  
**Location:** Lines 798-838  
**Severity:** HIGH

**Issue:**
The promise-based listener setup has a potential race condition:
```javascript
await new Promise((resolve) => {
    let resolved = false;
    
    const hardTimeout = setTimeout(() => {
        if (!resolved) {
            resolved = true;
            this.controller.network?.off("battle:result", onResult);  // Line 804
            resolve(null);
        }
    }, 5000);
    
    const onResult = ({ rewards, url: resultUrl }) => { /* ... */ };
    this.controller.network?.on("battle:result", onResult);  // Line 838
});
```

**Problem:**
- If `this.controller.network` becomes null/undefined during the promise, the listener removal at line 804 silently fails
- The listener remains attached indefinitely
- Network listener cleanup won't remove listeners attached with `.on()` if called via optional chaining

**Impact:**
- Listeners accumulate during pending battle clearing
- Can affect long raid sessions with many pending battles

**Fix:**
Check for network before cleanup:
```javascript
const hardTimeout = setTimeout(() => {
    if (!resolved && this.controller.network) {
        resolved = true;
        this.controller.network.off("battle:result", onResult);
        resolve(null);
    }
}, 5000);
```

---

## 🟡 HIGH PRIORITY BUGS

### 4. Missing Error Cleanup in raid-bot.js `start()` Method
**File:** `src/bot/raid-bot.js`  
**Location:** Lines 186-191  
**Severity:** HIGH

**Issue:**
The `start()` method registers listeners but the outer try/catch's finally block calls `stop()` which may not properly clean them up if an exception occurs during listener attachment.

**Impact:**
If an error occurs after registering some listeners but before all are registered, cleanup may be incomplete.

---

### 5. BattleHandler Missing Network Listener Cleanup
**File:** `src/bot/battle-handler.js`  
**Severity:** HIGH

**Issue:**
The BattleHandler class receives a controller with an active network listener (from parent bot) but has no visible cleanup mechanism. If BattleHandler subscribes to events, they're never unsubscribed.

**Current Code:**
```javascript
class BattleHandler {
    constructor(page, options = {}) {
        this.controller = options.controller || new PageController(page);
        // ... no stop() method that cleans up network listeners
    }
    
    stop() {
        this.stopped = true;  // Only sets flag, doesn't clean listeners
    }
}
```

**Impact:**
If BattleHandler adds listeners (currently it doesn't, but it's architecturally vulnerable), they would leak.

---

## 🟠 MEDIUM PRIORITY BUGS

### 6. Event Listener `battle:result` Removed in `stop()` But Never Added
**File:** `src/bot/raid-bot.js`  
**Location:** Line 1181 (attempted removal in stop)  
**Severity:** MEDIUM (Logic Issue)

**Current Code (stop method):**
```javascript
stop() {
    // ... other cleanup ...
    if (this.controller.network) {
        this.controller.network.removeListener("raid:error", this.onRaidError);
        this.controller.network.removeListener("battle:start", this.onBattleStart);
        this.controller.network.removeListener("raid:supporter_screen", this.onSupporterScreen);
        // battle:result listener NOT removed (because it was never registered)
    }
}
```

**Issue:**
The listener is added in `start()` (line 190) but the code structure suggests developers expected it to be removed. Currently it's not in the stop() removal list, which is the root cause of bug #1.

---

### 7. Unsafe Optional Chaining in Network Event Binding
**File:** `src/bot/raid-bot.js`  
**Location:** Lines 804, 820, 831, 838  
**Severity:** MEDIUM

**Issue:**
```javascript
this.controller.network?.off("battle:result", onResult);  // Line 804
this.controller.network?.on("battle:result", onResult);   // Line 838
```

Using optional chaining hides errors. If `this.controller.network` is null, the listener operations silently fail.

**Better Approach:**
```javascript
if (this.controller.network) {
    this.controller.network.off("battle:result", onResult);
}
```

---

## 🔵 LOW PRIORITY BUGS / CODE QUALITY

### 8. Inconsistent Logger Prefix in NetworkListener
**File:** `src/core/network-listener.js`  
**Location:** Line 31  
**Severity:** LOW

**Issue:**
Typo in log message:
```javascript
if (this.listenerCount('battle:result') > 50) {
    this.logger.warn('[Warn] Core: Potential listener leak detected (combat:result)');
    //                                                               ^^^^^^ should be "battle:result"
}
```

---

### 9. Hardcoded Timeout Values
**File:** `src/bot/raid-bot.js`  
**Location:** Multiple locations (3000ms, 5000ms, 100ms)  
**Severity:** LOW

**Issue:**
Timeout values are hardcoded throughout the file. Should be configurable constants.

Example:
```javascript
await this.waitForRaidError(3000);  // Hardcoded
```

---

## 📋 TESTING RECOMMENDATIONS

1. **Test long raid sessions** (100+ raids) and monitor listener count:
   ```javascript
   console.log(networkListener.listenerCount('battle:result'));  // Should stay < 5
   ```

2. **Test bot restart cycles:**
   - Start raid bot
   - Stop after 5 raids
   - Restart immediately
   - Repeat 5 times → Check listener count is stable

3. **Test memory growth:**
   - Run raid bot for 8+ hours
   - Monitor RSS memory via memory-watchdog
   - Should not exceed ~500MB

4. **Test browser disconnection:**
   - Kill browser process during raid
   - Verify stop() completes without hanging

---

## 📝 SUMMARY TABLE

| Bug ID | File | Severity | Type | Fix Time |
|--------|------|----------|------|----------|
| 1 | raid-bot.js | CRITICAL | Memory Leak | 5 min |
| 2 | quest-bot.js | CRITICAL | Memory Leak | 5 min |
| 3 | raid-bot.js | HIGH | Race Condition | 10 min |
| 4 | raid-bot.js | HIGH | Exception Safety | 10 min |
| 5 | battle-handler.js | HIGH | Arch Vulnerability | 15 min |
| 6 | raid-bot.js | MEDIUM | Logic Consistency | 2 min |
| 7 | raid-bot.js | MEDIUM | Error Handling | 10 min |
| 8 | network-listener.js | LOW | Typo | 1 min |
| 9 | raid-bot.js | LOW | Code Quality | 15 min |

---

## 🚀 RECOMMENDED FIX ORDER

1. **Fix #1 & #2 FIRST** (Memory leaks) - Critical for long-running sessions
2. **Fix #3** (Race condition) - Affects pending battle clearing
3. **Fix #7** (Optional chaining) - Better error visibility
4. **Fix #5** (BattleHandler architecture) - Defensive design
5. **Fix remaining items** - Polish & code quality
