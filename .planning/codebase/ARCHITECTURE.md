# Architecture

## High-Level Pattern
The application follows a **Two-Tier Desktop/Automation** architecture: Let's call it a "Controller (Electron)" orchestrating a "Headless Client (Puppeteer)".

## Components
1. **User Interface (GUI Tier)**
   - Built on Electron.
   - Provides an interface for the user to configure the bot, select tasks, and view logs.
   - Communicates with the core engine via IPC or local API.
   - Entry point: `src/gui/main.js`

2. **Core Engine (Automation Tier)**
   - **Browser Management (`src/core/browser.js`)**: Initializes and maintains the Puppeteer instance, applying stealth plugins and configuring proxy/user-agent settings.
   - **Low-Level Controllers (`src/core/page-controller.js`, `network-listener.js`)**: Abstract away direct DOM manipulation and network interception. `network-listener.js` listens to specific XHR/fetch requests from the game to infer state (e.g., raid drops, boss hp) without relying solely on screen scraping.
   - **Authentication (`src/core/login-handler.js`)**: Manages the authentication state across sessions.

3. **Bot Logic / Execution (Task Tier)**
   - Modular bots handle specific workflows defined in `src/bot/`.
   - Examples include `quest-bot.js`, `raid-bot.js`, and `skip-bot.js`.
   - Operations during fights are mostly delegated to `battle-handler.js`, which centralizes the complex logic of turns, skill usage, summons, and targeting.

## Data Flow
- **Input**: User configures behavior via GUI -> App state updates.
- **Execution**: A bot module (e.g., `raid-bot.js`) is invoked. It uses `browser.js` to get a page handle.
- **Observation & Action**: `network-listener.js` detects when a battle starts or ends. `battle-handler.js` executes clicks on the DOM via `page-controller.js`.
