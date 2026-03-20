# External Integrations

## Target Platform: Granblue Fantasy (GBF)
- **URL:** `https://game.granbluefantasy.jp/`
- **Type:** Browser-based game (SPA with hash routing)
- **Login provider:** Mobage (via `login-handler.js`)
- **Credentials:** Stored in `config/credentials.yaml` (gitignored). Uses a `profiles` key structure: `profiles.p1.email`, `profiles.p1.password`, etc. Supports legacy `profile1`/`profile2` mapping.

### Authentication Flow (`src/core/login-handler.js`)
1. Click login button on GBF home page
2. Select Mobage authentication platform
3. Open new tab for Mobage login page
4. Fill email/password with human-like typing
5. Submit and wait for reCAPTCHA
6. Close Mobage tab, return to GBF

### GBF API Endpoints (Intercepted via NetworkListener)
The bot intercepts GBF's internal REST API responses to detect game state:

| Endpoint Pattern | Detection | File |
|-----------------|-----------|------|
| `/rest/raid/*` or `/rest/multiraid/*` | Raid/quest battle state | `src/core/network-listener.js:52` |
| `/result.json` or `/resultmulti/content/index/` | Battle end (rewards) | `src/core/network-listener.js:86` |
| `js/view/result/empty.js` | Battle end (empty result) | `src/core/network-listener.js:86` |
| `/start.json` | Turn number, raid join errors | `src/core/network-listener.js:99` |
| `/quest/check_multi_start` | Raid join validation (full/pending/concurrent) | `src/core/network-listener.js:115` |
| `/quest/raid_deck_data_create` | Deck creation errors | `src/core/network-listener.js:134` |
| `*_attack_result.json` | Attack result, honor, boss death | `src/core/network-listener.js:145` |
| `ability_result.json` | Ability usage result | `src/core/network-listener.js:145` |
| `summon_result.json` | Summon usage result | `src/core/network-listener.js:145` |
| `fatal_chain_result.json` | Chain burst result | `src/core/network-listener.js:145` |
| `/rest/sound/quest_supporter_bgm` | Supporter selection screen | `src/core/network-listener.js:191` |

## Discord Notifications (`src/utils/notifier.js`)
- **Integration:** Discord Webhook (user-provided URL)
- **Config key:** `notifications.discord_webhook`
- **Messages:**
  - Error notifications (`notifyError`) — red embed
  - Captcha alerts (`notifyCaptcha`) — yellow embed, `@everyone` mention
- **Avatar:** Placeholder from jscad GitHub (not customized)

## Browser Support (`src/core/browser.js`)
Multiple browser executables supported via detection functions:

| Browser | Detection Method | Class Method |
|---------|-----------------|--------------|
| Chromium (default) | Puppeteer bundled | Default |
| Google Chrome | Windows paths | `getChromePath()` |
| Microsoft Edge | Windows paths | `getEdgePath()` |
| Brave | Windows paths | `getBravePath()` |
| Firefox | Windows paths | `getFirefoxPath()` |
| Custom | `executable_path` config | Direct config |

## Proxy Support
- Library: `proxy-chain` (^2.7.1) — listed as dependency but usage not found in source
- Likely intended for future proxy rotation feature

## File System Dependencies
- `config/credentials.yaml` — user login credentials (gitignored)
- `config/default.yaml` — runtime configuration
- `config/selectors.yaml` — CSS selectors for game UI
- `logs/` — winston log output (gitignored)
- `data/profiles/` — browser session data (gitignored)
- `screenshots/` — error screenshots (gitignored)
