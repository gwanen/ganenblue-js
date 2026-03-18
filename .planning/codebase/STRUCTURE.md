# Codebase Structure

## Directory Layout
- **`src/`**: Main application source code.
  - **`src/gui/`**: Electron application, containing `main.js` (main process), `renderer.js` (UI logic), and `index.html`.
  - **`src/bot/`**: Specific automation flows.
    - `quest-bot.js`, `raid-bot.js`, `skip-bot.js` - High level task orchestrators.
    - `battle-handler.js` - Central hub for handling the battle combat loop.
  - **`src/core/`**: Core infrastructure wrappers around Puppeteer.
    - `browser.js` - Browser instantiation.
    - `login-handler.js` - Auth persistence.
    - `network-listener.js` - Background XHR interceptor / listener.
    - `page-controller.js` - Standardized page navigations and element queries.
  - **`src/cli/`**: Alternative command-line interface `index.js` for running bots statelessly or manually via terminal.
  - **`src/utils/`**: Shared utilities and helper functions.

- **`tests/`**: Contains Jest unit and integration tests.
  - Files are named contextually (`*.test.js`), e.g., `battle-handler-logic.test.js`.

- **`.planning/`**: GSD framework artifacts and codebase documentation.
  - Contains `codebase/` structural map, `PROJECT.md`, `ROADMAP.md`, etc.

- **`config/`, `data/`, `docs/`, `logs/`, `local/`**: Operational state directories for user data, bot configs, logs, and caching.
