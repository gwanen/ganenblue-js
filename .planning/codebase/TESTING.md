# Testing

## Framework & Tooling
- **Primary Framework**: `Jest` running with `--experimental-vm-modules` to support native ECMAScript Modules (ESM).
- **Test Location**: All tests reside in the `/tests` directory at the project root.

## Testing Strategy
- **Unit Testing**: Complex deterministic logic, such as network event parsing and battle decision making, is isolated and tested (e.g., `battle-handler-logic.test.js`, `network-listener.test.js`).
- **Mocking**: Puppeteer's Page and Browser objects are heavily mocked in unit tests to simulate browser responses without starting an actual headless browser.
- **Coverage**: Currently focuses on the most complex and fragile parsers (`network-listener.js` and `battle-handler.js`).

## Running Tests
Run all tests via npm:
```bash
npm run test
```
