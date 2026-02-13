# Ganenblue

A high-performance Granblue Fantasy automation framework built with **Node.js**, **Puppeteer-Extra**, and **Electron**.

> [!WARNING]
> **Disclaimer**: This project is for **educational, academic, and personal research purposes only**. It is not intended for unfair advantage in any commercial game. Use at your own risk. The authors are not responsible for any account labels, bans, or data loss.

## 🚀 Key Features
- **Stealth Core**: Human-mimicry via modern evasion plugins.
- **Multi-Mode**: Optimized for Quest Farming and Raid Backup.
- **Smart Battle**: Real-time turn tracking, honor targets, and animation skipping.
- **Resilient**: Auto-recovery for stuck states, party wipe awareness, and raid join reliability.
- **Visual Intelligence**: Color-coded activity logs and professionalized system messaging.
- **Interactive GUI**: Real-time stats, sound-testable alerts (pleasant rising sweep), and easy configuration.

## 🛠️ Quick Start

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Launch GUI**:
   ```bash
   npm start
   ```

3. **Configure**: Select mode, browser type, and battle settings in the dashboard.

## ⚙️ Configuration
Main settings are located in `config/default.yaml` and `config/selectors.yaml`. For auto-login, configure `config/credentials.yaml`.

## 📂 Structure
- `src/bot`: Core battle and automation logic.
- `src/gui`: Electron interface and UI logic.
- `src/core`: Browser and page interaction management.

---
**License**: MIT. For educational use only.
