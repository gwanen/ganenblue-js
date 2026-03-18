# Codebase Concerns

## Automation Fragility
- **DOM Dependencies**: Scripts in `battle-handler.js` and `page-controller.js` rely on specific CSS selectors to interact with the game. If the target game updates its UI structure or class names, the bot will break.
- **Timing and Latency**: Race conditions represent a major concern. The bot relies on network listening and explicit waits. Network latency or game server load can cause misalignments between bot actions and game state.

## Security & Maintenance
- **ToS Violation Risk**: The use of this software fundamentally breaches the Terms of Service of the target game. Detection evasion mechanisms (like stealth plugins and randomized human-like delays) require constant maintenance to stay ahead of new detection vectors.
- **Puppeteer Headaches**: Browser updates or Puppeteer package bumps occasionally break the stealth plugins or introduce memory leaks.

## Technical Debt
- **Battle Handler Complexity**: `battle-handler.js` is quite large (nearly 60kb). Managing state (turns, skill cooldowns, summons) within a single file could become a major maintenance bottleneck. Refactoring it into smaller modules (e.g., `skill-manager.js`, `summon-manager.js`) may be required soon.
- **Error Recovery**: Catching all potential edge cases during an automated run (captchas popping up, disconnects, mid-battle errors) requires highly stateful tracking which can be fragile.
