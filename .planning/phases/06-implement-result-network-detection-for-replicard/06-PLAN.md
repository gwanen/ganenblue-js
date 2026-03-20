# Phase 6: Replicard Result Detection - Plan

Add network detection for single-player result screens in GBF (specifically observed in Replicard Sandbox) to ensure the bot can respond to battle completion events.

## Proposed Changes

### [Network Listener]
#### [MODIFY] [network-listener.js](file:///c:/Users/kelon/Documents/GBF/ganenblue-js/ganenblue-js/src/core/network-listener.js)
- Update the condition for `battle:result` event emission in `_handleResponse`.
- **Target Line**: ~86
- **New Pattern**: Add `url.includes('/result/content/index/')` to the logical OR block.

## Verification Plan

### Automated Tests
- Update `tests/network-listener.test.js` to include a test case for the new result URL pattern.
- **Command**: `npm test tests/network-listener.test.js`

### Manual Verification
- Run the bot on a Replicard Sandbox node.
- **Expected Outcome**: The bot should detect the result screen immediately after the battle refresh and log `[Status] Signal: Combat Result (Rewards) detected`.
