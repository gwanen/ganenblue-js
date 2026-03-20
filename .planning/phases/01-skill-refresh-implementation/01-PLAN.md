# Phase 1: Skill Refresh Implementation - Plan

**Created:** 2026-03-20
**Phase:** 1 — Skill Refresh Implementation
**Context:** `.planning/phases/01-skill-refresh-implementation/01-CONTEXT.md`

## Tasks

### Task 1: Add `skillRefresh` option to BattleHandler constructor

**File:** `src/bot/battle-handler.js:16-17`

Add after `summonRefresh`:

```javascript
this.skillRefresh =
  options.skillRefresh !== undefined ? options.skillRefresh : false;
```

Default: false (matches user requirement — checkbox default is OFF).

### Task 2: Add `onAbilityUsed` network handler

**File:** `src/bot/battle-handler.js` (after `onAbilityOrSummon` handler, around line 614)

Add new handler:

```javascript
const onAbilityUsed = ({ honor } = {}) => {
  abilityUsed = true;
  this.options.lastActionTimeRef.value = Date.now();
  this.options.faThresholdRef.value = 5000;
  lastFACheckTime = Date.now();
};
```

Register in the listener block (around line 655):

```javascript
this.controller.network.on("battle:ability_used", onAbilityUsed);
```

Also declare `let abilityUsed = false;` in the flag declarations (around line 554).

### Task 3: Add ability refresh reload block in waitForBattleEnd loop

**File:** `src/bot/battle-handler.js` (after summon refresh block, around line 819)

Insert after the summon refresh block, before the attack refresh block:

```javascript
// 0.6. Ability Used: Reload immediately to skip skill animation (if enabled, Full Auto only)
if (mode !== 'semi_auto' && abilityUsed) {
    abilityUsed = false;
    if (this.skillRefresh) {
        this.logger.info('[Ability] Refreshing page after skill usage');
        await this.controller.reloadPage();
        await sleep(this.fastRefresh ? 200 : 500);
        lastFACheckTime = Date.now();

        const resumeResult = await this.checkStateAndResume(mode);
        if (resumeResult === true) {
            return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors, honorReached: honorTargetReached };
        }
        // FA was re-engaged, lastActionTime updated via ref in handleFullAuto
        continue;
    }
}
```

### Task 4: Unregister ability listener in cleanup

**File:** `src/bot/battle-handler.js` (around line 936)

Add after summon listener cleanup:

```javascript
this.controller.network.off("battle:ability_used", onAbilityUsed);
```

### Task 5: Add GUI checkbox in index.html (Profile 1)

**File:** `src/gui/index.html` (in p1 Options section, after summon-refresh-p1 checkbox)

Add after the summon-refresh checkbox:

```html
<label class="checkbox-container mt-xs">
  <input type="checkbox" id="skill-refresh-p1" />
  <span>Refresh on Skill</span>
</label>
```

### Task 6: Add GUI checkbox in index.html (Profile 2)

**File:** `src/gui/index.html` (in p2 Options section, after summon-refresh-p2 checkbox)

Same as Task 5 but with `skill-refresh-p2`.

### Task 7: Add skillRefresh to renderer.js save function

**File:** `src/gui/renderer.js:700` (in `saveProfileSettings`)

Add to the settings object:

```javascript
skillRefresh: document.getElementById(`skill-refresh-${pid}`)?.checked ?? false;
```

### Task 8: Add skillRefresh to renderer.js load function

**File:** `src/gui/renderer.js:672-675` (in `loadProfileSettings`)

Add after summonRefresh loading:

```javascript
if (s.skillRefresh !== undefined) {
  const skrEl = document.getElementById(`skill-refresh-${pid}`);
  if (skrEl) skrEl.checked = s.skillRefresh;
}
```

### Task 9: Add skillRefresh to inputs change listener

**File:** `src/gui/renderer.js:312` (in `setupProfileListeners`)

Add to the inputs array:

```javascript
document.getElementById(`skill-refresh-${pid}`);
```

### Task 10: Pass skillRefresh to startBot

**File:** `src/gui/renderer.js:254` (in `btnStart` click handler)

Add to settings object:

```javascript
skillRefresh: document.getElementById(`skill-refresh-${pid}`)?.checked ?? false;
```

### Task 11: Update tests

**File:** `tests/battle-handler-logic.test.js`

Add test case for `abilityUsed` flag behavior (mirrors summonUsed tests).

## Verification

1. Build check: `npm test` passes
2. Manual: Launch GUI → Options → "Refresh on Skill" checkbox visible, unchecked by default
3. Manual: Toggle checkbox → save → reload → state persists
4. Manual: Start FA bot with skill refresh ON → skills trigger page reload
5. Manual: Start SA bot → skill refresh does NOT trigger
