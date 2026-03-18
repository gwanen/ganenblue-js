# Tech Stack

## Core Technologies
- **Language**: JavaScript (Node.js, ES Modules)
- **Runtime**: Node.js (v18+)
- **Desktop Framework**: Electron (`^40.2.1`)
- **Browser Automation**: Puppeteer (`^24.37.2`)
- **Bundler / Build**: ESBuild (`^0.27.3`), Electron-Builder (`^26.8.1`)

## Key Libraries
- `puppeteer-extra` alongside `puppeteer-extra-plugin-stealth` and `puppeteer-extra-plugin-recaptcha` for advanced browser automation evasion.
- `winston` (`^3.19.0`) for application logging.
- `js-yaml` (`^4.1.1`) for configuration parsing.
- `proxy-chain` (`^2.7.1`) for proxy management.
- `dotenv` (`^17.2.4`) for environment variables.
- `commander` (`^14.0.3`) for CLI argument parsing.

## Code Quality & Testing
- `jest` (`^30.2.0`) for unit and integration testing.
- `eslint` (`^10.0.0`) and `prettier` (`^3.8.1`) for linting and code formatting.

## Configuration
- Project uses `"type": "module"` indicating native ESM support.
- Entry points: GUI starts from `src/gui/main.js`, and CLI is at `src/cli/index.js`.
