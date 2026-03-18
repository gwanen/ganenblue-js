# Contributing to Ganenblue-JS

Thank you for your interest in contributing!

## Development Setup

```bash
# Clone the repository
git clone https://github.com/gwanen/ganenblue-js.git
cd ganenblue-js

# Install dependencies
npm install

# Run in development mode
npm start

# Run CLI
npm run cli -- [command]
```

## Code Style

This project follows the `.editorconfig` settings:

- 2-space indentation
- UTF-8 charset
- LF line endings
- Trailing whitespace trimmed
- Final newline at EOF

## Project Structure

- `src/bot/` — Bot implementations (quest, raid, skip farming)
- `src/core/` — Browser automation core (Puppeteer wrappers)
- `src/gui/` — Electron GUI components
- `src/utils/` — Shared utilities (config, logging, random)
- `src/cli/` — Command-line interface

## Module Exports

Each module in `src/` has an `index.js` barrel export:

```javascript
// Import from barrel exports
const { QuestBot } = require("./src/bot");
const { Logger } = require("./src/utils");
```

## Commit Messages

Follow conventional commits:

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation changes
- `refactor:` — Code refactoring
- `test:` — Test additions/changes

## Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes following the commit message format
4. Push to your branch
5. Open a Pull Request

## Testing

Run tests with:

```bash
npm test
```

## Reporting Issues

Report bugs via GitHub Issues. Include:

- Steps to reproduce
- Expected vs actual behavior
- Browser and OS version
- Any relevant logs
