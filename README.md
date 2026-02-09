# GBF Bot (JavaScript)

A high-performance, stealth-focused Granblue Fantasy automation bot built with **Node.js**, **Puppeteer-Extra**, and **Electron**.

## 🚀 Features

- **Stealth Automation**: Uses `puppeteer-extra-plugin-stealth` and custom evasion techniques to mimic human behavior.
- **Smart Logic**: Handles battle states, result screens, and summon selection automatically.
- **Full Auto & Semi Auto**: Supports both combat modes.
- **Robust Logging**: Uses **Winston** for detailed and rotatable logs.
- **Environment Config**: Secure configuration using **Dotenv**.
- **GUI Dashboard**: Electron-based interface for easy configuration and monitoring.
- **CLI Mode**: Headless operation for advanced users.
- **Configurable**: YAML-based configuration for easy customization.

## 🛠️ Installation

1.  **Prerequisites**: Ensure you have [Node.js](https://nodejs.org/) (v16+) installed.
2.  **Install Dependencies**:
    ```bash
    npm install
    # OR
    pnpm install
    ```

## 🖥️ Usage

### GUI Mode (Recommended)
Launch the desktop dashboard:
```bash
npm start
```
- **Quest URL**: Enter the URL of the quest you want to farm.
- **Max Quests**: Set the number of runs (0 for unlimited).
- **Battle Mode**: Choose between "Full Auto" and "Semi Auto".
- **Start Bot**: Launches a controlled browser window to perform the automation.

### CLI Mode
Run the bot directly from the terminal (useful for headless servers):
```bash
# View help
npm run cli -- --help

# Start farming
npm run cli -- start --url "http://game.granbluefantasy.jp/#quest/supporter/..." --max 5 --mode full_auto
```

## ⚙️ Configuration

Start by verifying your settings in `config/default.yaml`. You can override these via the GUI or CLI arguments.
Key settings:
- `browser.headless`: Run without a visible window (default: `false` for debugging).
- `stealth.randomize_viewport`: Randomize window size for stealth.

## 📂 Project Structure

- `src/core/`: Core browser automation logic.
  - `browser.js`: Browser initialization and management.
  - `page-controller.js`: Page interaction and navigation wrappers.
- `src/bot/`: Game-specific logic.
  - `quest-bot.js`: Main quest loop orchestration.
  - `battle-handler.js`: Combat logic and state management.
- `src/gui/`: Electron application source.
  - `main.js`: Electron main process.
  - `renderer.js`: UI logic.
- `src/cli/`: Command-line interface entry point.
- `src/utils/`: Utility functions.
  - `logger.js`: Winston logger configuration.
  - `config.js`: Configuration loader (YAML + Env).
  - `random.js`: Randomization helpers for human-like behavior.
- `config/`: Configuration files and CSS selectors.

## ⚠️ Disclaimer
This tool is for educational purposes only. Use fewer runs and realistic delays to avoid account restrictions.
