# Phase 2: Network Listener Optimizations - Plan

**Created:** 2026-03-20
**Status:** In Progress

## Goal

Reduce CPU and memory overhead in `_handleResponse` — no behavior change, pure performance.

## Changes

### 1. Swap resourceType before URL check (2 lines)

**File:** `src/core/network-listener.js`
**Location:** `_handleResponse` lines 78-83

Move `response.request().resourceType()` call BEFORE the `granbluefantasy.jp` URL check. Rationale: `resourceType()` is a cheap property access (Puppeteer caches it), while `url.includes()` does string search on every response. Swapping means we bail on images/stylesheets/fonts with zero string ops.

```js
// BEFORE: url.includes → resourceType (string ops on all responses)
if (!url.includes("granbluefantasy.jp")) return;
const type = response.request().resourceType();

// AFTER: resourceType → url.includes (bail early on non-fetch/xhr/script)
const type = response.request().resourceType();
if (type !== "fetch" && type !== "xhr" && type !== "script") return;
if (!url.includes("granbluefantasy.jp")) return;
```

### 2. Extend \_hasBattleListeners() guard (4 lines)

**File:** `src/core/network-listener.js`
**Location:** `_hasBattleListeners` lines 61-69

Add `battle:result` and `raid:*` events to the guard. Currently only `battle:boss_died`, `battle:party_wiped`, `battle:attack_used`, `battle:summon_used`, `battle:ability_used` are checked. But `battle:result` and `raid:error` listeners also indicate we're in battle mode. Adding them prevents unnecessary JSON parsing when only battle:result or raid:\* listeners are active.

```js
_hasBattleListeners() {
    return (
        this.listenerCount('battle:boss_died') > 0 ||
        this.listenerCount('battle:party_wiped') > 0 ||
        this.listenerCount('battle:attack_used') > 0 ||
        this.listenerCount('battle:summon_used') > 0 ||
        this.listenerCount('battle:ability_used') > 0 ||
        this.listenerCount('battle:result') > 0 ||
        this.listenerCount('raid:error') > 0
    );
}
```

### 3. Content-length check before JSON parse (5 lines)

**File:** `src/core/network-listener.js`
**Location:** Inside the attack/ability/summon/fatal_chain block, before `response.json()` (line 155)

Add a content-length header check. GBF can send 500KB+ responses for large raids. If we know the response is oversized, skip JSON parse — we only need terminal cmd and honor, which are small.

```js
// Skip JSON parse for oversized responses — we only need terminal signals
const contentLength = parseInt(response.headers()["content-length"] || "0", 10);
if (contentLength > 102400) {
  // 100KB threshold
  return;
}
```

### 4. Lazy scenario parsing (10 lines)

**File:** `src/core/network-listener.js`
**Location:** Inside the attack/ability/summon/fatal_chain block, scenario check (lines 164-175)

Replace `Array.find()` with a `for` loop that short-circuits on terminal cmd. `Array.find()` creates a function closure per iteration. A plain `for` loop with `break` is faster for large scenario arrays.

```js
// BEFORE: Array.find with closure per iteration
const terminal = json.scenario.find(
  (s) =>
    s.cmd === "win" ||
    (s.cmd === "die" && (s.to === "enemy" || s.to === "boss")) ||
    s.cmd === "lose",
);

// AFTER: for loop with early break
let terminal = null;
for (const s of json.scenario) {
  if (
    s.cmd === "win" ||
    s.cmd === "lose" ||
    (s.cmd === "die" && (s.to === "enemy" || s.to === "boss"))
  ) {
    terminal = s;
    break;
  }
}
```

### 5. Reorder URL filters (reorder)

**File:** `src/core/network-listener.js`
**Location:** URL checks in `_handleResponse` (lines 86-195)

Reorder URL checks by frequency of occurrence:

1. **Raid/quest action results** (most common during battle) — move UP
2. **Battle result / empty.js** (rare, end-of-battle) — move DOWN
3. **Supporter BGM** (rare, once per battle) — keep at end

This is a micro-optimization — during battle, 90%+ of responses are action results. Checking them first means fewer string comparisons.

## Files Modified

- `src/core/network-listener.js` — all 5 optimizations

## Verification

- Run `npm test` — all 51 tests must pass
- No behavior change — same events emitted, same data structures
- Manual smoke test: run bot in FA mode, verify battle completes normally
