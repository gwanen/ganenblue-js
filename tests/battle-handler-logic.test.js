/**
 * Logic tests for BattleHandler loop priorities and edge cases.
 *
 * These tests do NOT import BattleHandler (which has side-effect imports:
 * config.js reads YAML files, logger.js creates directories).
 * Instead, we replicate the exact flag-checking logic from waitForBattleEnd()
 * using EventEmitter + the same patterns — keeping tests fast and isolated.
 *
 * Tests:
 * 1. Win Priority      — bossDied/partyWiped checked BEFORE summonUsed
 * 2. Honor Target      — honorReached flag set when honor >= target
 * 3. Attack Cooldown   — 2s debounce prevents double refresh on rapid attacks
 */

import { describe, test, expect } from "@jest/globals";
import EventEmitter from "events";

// ---------------------------------------------------------------------------
// Helpers — replica of waitForBattleEnd() flag logic
// ---------------------------------------------------------------------------

function makeFlags() {
  return {
    bossDied: false,
    partyWiped: false,
    summonUsed: false,
    abilityUsed: false,
    attackUsed: false,
    networkFinished: false,
  };
}

/**
 * Wire up event handlers exactly as waitForBattleEnd() does
 * and return the flag bag + a tear-down function.
 */
function wireHandlers(network) {
  const flags = makeFlags();
  let previousHonors = 0;
  let honorTargetReached = false;

  const updateHonor = (raw) => {
    if (raw !== null && raw > previousHonors) previousHonors = raw;
  };

  const onBossDied = ({ honor } = {}) => {
    updateHonor(honor);
    flags.bossDied = true;
  };
  const onPartyWiped = ({ honor } = {}) => {
    updateHonor(honor);
    flags.partyWiped = true;
  };
  const onSummon = ({ honor } = {}) => {
    updateHonor(honor);
    flags.summonUsed = true;
  };
  const onAbility = () => {
    flags.abilityUsed = true;
  };
  const onAttack = () => {
    flags.attackUsed = true;
  };
  const onResult = () => {
    flags.networkFinished = true;
  };

  network.on("battle:boss_died", onBossDied);
  network.on("battle:party_wiped", onPartyWiped);
  network.on("battle:summon_used", onSummon);
  network.on("battle:ability_used", onAbility);
  network.on("battle:attack_used", onAttack);
  network.once("battle:result", onResult);

  const teardown = () => {
    network.off("battle:boss_died", onBossDied);
    network.off("battle:party_wiped", onPartyWiped);
    network.off("battle:summon_used", onSummon);
    network.off("battle:ability_used", onAbility);
    network.off("battle:attack_used", onAttack);
    network.off("battle:result", onResult);
  };

  return { flags, teardown, getHonors: () => previousHonors };
}

/**
 * Replica of the PRIORITY 0 block — returns what the loop would do.
 * Returns 'hard_reload' if boss died/party wiped, 'summon_refresh' if
 * only summonUsed, or 'continue' if nothing actionable.
 *
 * This is the EXACT priority order from battle-handler.js:
 *   1. bossDied || partyWiped → hard reload (highest priority)
 *   2. summonUsed             → soft reload (summon refresh)
 *   3. abilityUsed            → soft reload (skill refresh)
 *   4. else                   → keep looping
 */
function loopPriorityCheck(
  flags,
  { summonRefresh = true, skillRefresh = false } = {},
) {
  if (flags.bossDied || flags.partyWiped) return "hard_reload";
  if (flags.summonUsed && summonRefresh) return "summon_refresh";
  if (flags.abilityUsed && skillRefresh) return "ability_refresh";
  return "continue";
}

/**
 * Replica of honor-target check logic after boss death.
 */
function checkHonorTarget(honors, target, prevReached) {
  if (prevReached) return true;
  if (target > 0 && honors >= target) return true;
  return false;
}

/**
 * Replica of the attack cooldown guard.
 */
function shouldReloadForAttack(lastRefreshTime, now, cooldownMs = 2000) {
  return now - lastRefreshTime >= cooldownMs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Priority: Boss Died trumps Summon Refresh", () => {
  test("bossDied + summonUsed both set → loopPriorityCheck returns hard_reload", () => {
    const network = new EventEmitter();
    const { flags, teardown } = wireHandlers(network);

    network.emit("battle:summon_used", { honor: 500 });
    network.emit("battle:boss_died", { honor: 1500 });

    expect(loopPriorityCheck(flags)).toBe("hard_reload");
    teardown();
  });

  test("only summonUsed → returns summon_refresh", () => {
    const network = new EventEmitter();
    const { flags, teardown } = wireHandlers(network);

    network.emit("battle:summon_used", { honor: 500 });

    expect(loopPriorityCheck(flags)).toBe("summon_refresh");
    teardown();
  });

  test("partyWiped + summonUsed → hard_reload (wipe takes priority)", () => {
    const network = new EventEmitter();
    const { flags, teardown } = wireHandlers(network);

    network.emit("battle:summon_used", { honor: 200 });
    network.emit("battle:party_wiped", { honor: 200 });

    expect(loopPriorityCheck(flags)).toBe("hard_reload");
    teardown();
  });

  test("summonRefresh disabled → summonUsed returns continue", () => {
    const network = new EventEmitter();
    const { flags, teardown } = wireHandlers(network);

    network.emit("battle:summon_used", { honor: 500 });

    expect(loopPriorityCheck(flags, { summonRefresh: false })).toBe("continue");
    teardown();
  });

  test("nothing fired → continue", () => {
    const network = new EventEmitter();
    const { flags, teardown } = wireHandlers(network);

    expect(loopPriorityCheck(flags)).toBe("continue");
    teardown();
  });
});

describe("Priority: Ability Refresh (Skill Refresh)", () => {
  test("abilityUsed + skillRefresh enabled → returns ability_refresh", () => {
    const network = new EventEmitter();
    const { flags, teardown } = wireHandlers(network);

    network.emit("battle:ability_used", { honor: 300 });

    expect(loopPriorityCheck(flags, { skillRefresh: true })).toBe(
      "ability_refresh",
    );
    teardown();
  });

  test("abilityUsed but skillRefresh disabled → returns continue", () => {
    const network = new EventEmitter();
    const { flags, teardown } = wireHandlers(network);

    network.emit("battle:ability_used", { honor: 300 });

    expect(loopPriorityCheck(flags, { skillRefresh: false })).toBe("continue");
    teardown();
  });

  test("bossDied + abilityUsed → hard_reload (boss takes priority)", () => {
    const network = new EventEmitter();
    const { flags, teardown } = wireHandlers(network);

    network.emit("battle:ability_used", { honor: 300 });
    network.emit("battle:boss_died", { honor: 1500 });

    expect(loopPriorityCheck(flags, { skillRefresh: true })).toBe(
      "hard_reload",
    );
    teardown();
  });

  test("summonUsed + abilityUsed → summon_refresh (summon takes priority)", () => {
    const network = new EventEmitter();
    const { flags, teardown } = wireHandlers(network);

    network.emit("battle:ability_used", { honor: 300 });
    network.emit("battle:summon_used", { honor: 500 });

    expect(
      loopPriorityCheck(flags, {
        summonRefresh: true,
        skillRefresh: true,
      }),
    ).toBe("summon_refresh");
    teardown();
  });

  test("partyWiped + abilityUsed → hard_reload (wipe takes priority)", () => {
    const network = new EventEmitter();
    const { flags, teardown } = wireHandlers(network);

    network.emit("battle:ability_used", { honor: 300 });
    network.emit("battle:party_wiped", { honor: 200 });

    expect(loopPriorityCheck(flags, { skillRefresh: true })).toBe(
      "hard_reload",
    );
    teardown();
  });
});

describe("Honor Target", () => {
  test("honors >= target → honorReached = true", () => {
    expect(checkHonorTarget(6000, 5000, false)).toBe(true);
  });

  test("honors < target → honorReached = false", () => {
    expect(checkHonorTarget(2000, 5000, false)).toBe(false);
  });

  test("honors exactly == target → honorReached = true", () => {
    expect(checkHonorTarget(5000, 5000, false)).toBe(true);
  });

  test("no target (0) → always false (feature disabled)", () => {
    expect(checkHonorTarget(99999, 0, false)).toBe(false);
  });

  test("already reached → stays true even with lower honor", () => {
    expect(checkHonorTarget(100, 5000, true)).toBe(true);
  });

  test("honor accumulates via updateHonor before target check", () => {
    const network = new EventEmitter();
    const { flags, teardown, getHonors } = wireHandlers(network);

    network.emit("battle:boss_died", { honor: 7500 });

    const reached = checkHonorTarget(getHonors(), 5000, false);
    expect(reached).toBe(true);
    teardown();
  });
});

describe("Attack Cooldown (Double Refresh Prevention)", () => {
  const COOLDOWN = 2000;

  test("first attack → always reloads (lastRefreshTime = 0)", () => {
    const now = Date.now();
    expect(shouldReloadForAttack(0, now, COOLDOWN)).toBe(true);
  });

  test("second attack within 2s → blocked", () => {
    const now = Date.now();
    const lastRefresh = now - 1500; // 1.5s ago
    expect(shouldReloadForAttack(lastRefresh, now, COOLDOWN)).toBe(false);
  });

  test("second attack after 2s → allowed", () => {
    const now = Date.now();
    const lastRefresh = now - 2001; // just over 2s
    expect(shouldReloadForAttack(lastRefresh, now, COOLDOWN)).toBe(true);
  });

  test("exactly at 2s boundary → allowed (>=, not >)", () => {
    const now = Date.now();
    const lastRefresh = now - 2000;
    expect(shouldReloadForAttack(lastRefresh, now, COOLDOWN)).toBe(true);
  });

  test("rapid double attack events: second is blocked by cooldown", () => {
    const network = new EventEmitter();
    const { flags, teardown } = wireHandlers(network);

    let reloadCount = 0;
    let lastRefreshTime = 0;

    // Simulate two attack events hitting the loop in quick succession
    network.on("battle:attack_used", () => {
      const now = Date.now();
      if (shouldReloadForAttack(lastRefreshTime, now, COOLDOWN)) {
        reloadCount++;
        lastRefreshTime = now;
      }
    });

    network.emit("battle:attack_used", {});
    network.emit("battle:attack_used", {}); // rapid second — should be blocked

    expect(reloadCount).toBe(1); // Only one reload fired
    teardown();
  });
});
