# Ganenblue

A high-performance, stealth-focused Granblue Fantasy automation bot built with **Node.js**, **Puppeteer-Extra**, and **Electron**.

## 🚀 Features

### Core Automation
- **Stealth Automation**: Uses `puppeteer-extra-plugin-stealth` and custom evasion techniques to mimic human behavior
- **Multi-Mode Support**: Quest Farming and Raid Backup modes
- **Smart Battle Logic**: Automatic battle handling with Full Auto & Semi Auto support
- **Battle Timer**: Track individual battle times and average completion time
- **Error Recovery**: Handles rematch fails, character death, and error popups automatically

### GUI Dashboard
- **Electron-based Interface**: Easy-to-use desktop application
- **Bot Mode Selection**: Switch between Quest and Raid modes
- **Real-time Statistics**: Live battle times, completion counts, and averages
- **Control Buttons**:
  - Launch Browser / Start Farming / Stop
  - Reset Stats: Clear battle timers and statistics
  - Reload App: Restart app to load code changes
- **Dynamic UI**: Shows/hides relevant fields based on bot mode

### Battle Features
- **Optimal Resolution**: Automatically sets viewport to 1000x1799 for farming
- **Animation Skipping**: Refreshes during attack animations for faster battles
- **Auto-Recovery**: Handles stuck states and missing UI elements
- **Death Detection**: Automatically skips to next raid when character dies
- **Result Detection**: Multiple methods to detect battle completion

### Configuration
- **YAML-based Config**: Easy customization via `config/default.yaml` and `config/selectors.yaml`
- **Environment Variables**: Override settings with `.env` file
- **Robust Logging**: Winston-based logging with rotation

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

**Configuration:**
1. **Bot Mode**: Select "Quest Farming" or "Raid Backup"
2. **Quest URL** (Quest mode only): Enter the quest URL to farm
3. **Max Runs**: Set the number of runs (0 for unlimited)
4. **Battle Mode**: Choose "Full Auto" or "Semi Auto"

**Controls:**
- **Open Browser**: Launch the controlled browser window
- **Start Farming**: Begin automation with current settings
- **Stop**: Pause the bot (keeps statistics)
- **Reset Stats**: Clear battle times and completion counts
- **Reload App**: Restart the application (useful for development)

**Statistics Display:**
- Quests/Raids completed
- Individual battle times (Battle 1: 02:15, Battle 2: 01:45, etc.)
- Average battle time across all battles

### CLI Mode

#### Quest Mode
```bash
# View help
npm run cli -- quest --help

# Start quest farming
npm run cli -- quest --url "http://game.granbluefantasy.jp/#quest/supporter/..." --max 5 --mode full_auto

# Headless mode
npm run cli -- quest --url "..." --max 10 --headless
```

#### Raid Mode
```bash
# View help
npm run cli -- raid --help

# Start raid farming
npm run cli -- raid --max 10 --mode full_auto

# Unlimited raids
npm run cli -- raid --mode full_auto
```

## ⚙️ Configuration

### Config Files
- `config/default.yaml`: Main configuration (max runs, headless mode, etc.)
- `config/selectors.yaml`: CSS selectors for game elements
- `.env`: Environment variables (optional)

### Key Settings
```yaml
# config/default.yaml
max_quests: 0        # 0 = unlimited
max_raids: 0         # 0 = unlimited
headless: false      # Show browser window
```

### Browser Resolution
The bot automatically sets the viewport to **1000x1799** when starting to farm, optimizing element visibility and interaction.

## 📂 Project Structure

```
src/
├── core/                 # Core automation
│   ├── browser.js       # Browser management
│   └── page-controller.js # Page interactions
├── bot/                 # Bot logic
│   ├── quest-bot.js     # Quest farming bot
│   ├── raid-bot.js      # Raid backup bot
│   └── battle-handler.js # Battle automation
├── gui/                 # Electron GUI
│   ├── main.js          # Main process
│   ├── renderer.js      # UI logic
│   ├── preload.cjs      # IPC bridge
│   └── index.html       # Interface
├── cli/                 # CLI interface
│   └── index.js         # Command handlers
└── utils/               # Utilities
    ├── logger.js        # Winston logger
    ├── config.js        # Config loader
    └── random.js        # Randomization

config/
├── default.yaml         # Main config
└── selectors.yaml       # CSS selectors
```

## 🎯 How It Works

### Quest Mode
1. Navigate to quest URL
2. Select summon
3. Start battle (Full Auto or Semi Auto)
4. Wait for battle completion
5. Skip result screen (optimization)
6. Repeat

### Raid Mode
1. Navigate to raid backup page
2. Find available raid
3. Join raid (handles full raids automatically)
4. Select summon
5. Battle with auto-recovery
6. Handle edge cases (rematch fails, character death)
7. Repeat

### Battle Intelligence
- Detects URL changes to `#result` for completion
- Refreshes on attack animations to skip delays
- Handles missing UI by auto-refreshing
- Detects and handles:
  - Rematch fail popups (battle ended by others)
  - Character death (cheer button)
  - Error popups
  - Stuck states

## 🛡️ Error Handling

The bot automatically handles:
- **Rematch Fail**: Battle already completed → refresh and continue
- **Character Death**: `.btn-cheer` detected → skip to next raid
- **Full Raids**: Error popup → refresh and find new raid
- **Missing UI**: Attack/Cancel buttons missing → auto-refresh
- **Stuck States**: No response after 10s → page refresh

## 📊 Battle Timer

- Tracks each battle duration in MM:SS format
- Displays individual times: "Battle 1: 02:15"
- Calculates and shows average battle time
- Resets automatically on "Start Farming"
- Manual reset via "Reset Stats" button

## ⚠️ Disclaimer

This tool is for **educational purposes only**. Use responsibly:
- Use realistic delays between runs
- Avoid excessive farming
- Be aware of game terms of service
- Account safety is your responsibility

## 🔧 Development

### Hot Reload
Click "Reload App" in the GUI to restart and load code changes without closing the terminal.

### Logging
Logs are stored in `logs/` directory with automatic rotation. Check `combined.log` for all events and `error.log` for errors only.

## 📝 License

MIT License - Use at your own risk.
