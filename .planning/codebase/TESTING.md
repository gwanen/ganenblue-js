# Testing Practices

## Framework
- **Test runner:** Jest v30.2.0
- **Environment:** Node.js (`testEnvironment: 'node'`)
- **ESM support:** `--experimental-vm-modules` flag in npm test script
- **Config:** `jest.config.js` — minimal: `{ testEnvironment: 'node', transform: {} }`

## Test Structure
Tests are in `tests/` directory at project root (not co-located with source).

| Test File | Tests For | Approach |
|-----------|-----------|----------|
| `network-listener.test.js` | NetworkListener URL parsing, event emission | Mock page/response factory |
| `battle-handler-logic.test.js` | BattleHandler flag priorities, honor targeting, attack cooldown | Logic replication (no imports) |
| `battle-handler-preregistration.test.js` | Pre-registration event handling | Logic replication |
| `notifier.test.js` | Discord notification sending | Mock fetch, mock config |

## Testing Patterns

### Mock Page Factory (NetworkListener tests)
```javascript
function makeResponse({ url, type = 'fetch', json = null, headers = {} }) {
    return {
        url: () => url,
        request: () => ({ resourceType: () => type }),
        json: async () => json,
        headers: () => ({ 'content-type': 'application/json', ...headers }),
    };
}
```
No real browser needed — inject fake response objects directly into `_handleResponse()`.

### Logic Replication (BattleHandler tests)
BattleHandler has side-effect imports (config.js reads YAML, logger.js creates directories). Tests replicate the exact flag-checking logic using EventEmitter:
```javascript
function wireHandlers(network) {
    const flags = makeFlags();
    // Wire up event handlers exactly as waitForBattleEnd() does
    network.on('battle:boss_died', ({ honor }) => { flags.bossDied = true; });
    // ... etc
    return flags;
}
```

### Config Mocking (Notifier tests)
```javascript
jest.spyOn(config, 'get').mockImplementation((key) => {
    if (key === 'notifications.discord_webhook') return 'https://discord.com/api/webhooks/mock';
    return null;
});
```

## What's Tested
- NetworkListener URL filtering and JSON parsing
- Event emission for battle states (boss death, party wipe, attack, summon, ability)
- Ability usage specific signals (ability_result.json, fatal_chain_result.json)
- BattleHandler loop priority logic (win signals before honor checks)
- Honor target detection
- Attack refresh cooldown (2s debounce)
- Pre-registration flags from network events
- Discord notification payload format

## What's NOT Tested
- PageController (needs real browser)
- BrowserManager (needs real browser)
- Bot classes (QuestBot, RaidBot, SkipBot) — integration-heavy
- LoginHandler (needs real browser + credentials)
- GUI (Electron) — no test infrastructure
- Config YAML loading (reads real files)
- Logger (creates real directories)

## Coverage
- No coverage configuration or tooling currently set up
- No coverage targets defined
- No CI/CD integration for test results

## Running Tests
```bash
npm test                                          # All tests
npm test -- --testPathPattern=network-listener    # Single file
```
