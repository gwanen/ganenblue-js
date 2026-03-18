# Integrations

## External Services & APIs
- **Web Browser (Chromium)**: Driven by Puppeteer. The app acts as an automation client for a web-based game (Granblue Fantasy).
- **reCAPTCHA Solving**: Integrated via `puppeteer-extra-plugin-recaptcha`, implying the bot encounters and automatically solves standard captchas during runtime.

## Anti-Bot Evasion
- **Stealth Plugins**: Relies heavily on `puppeteer-extra-plugin-stealth` and user-agent randomization (`user-agents` package) to avoid bot detection mechanisms on the target platform.
- **Proxy Chains**: Provides support for routing traffic through proxies via `proxy-chain`, allowing IP rotation and evasion of IP-based rate limits.

## Environment configuration
- Configured via `.env` (using dotenv) and YAML config files (parsed via `js-yaml`). These typically define credentials, target URLs, and behavior flags.
