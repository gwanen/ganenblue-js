# Conventions

## Code Style
- **Modules**: The project strictly uses ES Modules (`import`/`export`) rather than CommonJS.
- **Async/Await**: Preferred over Promises `.then()` caching since browser automation operations are heavily timing-dependent.
- **Linting**: Enforced with ESLint and Prettier.

## Patterns
- **Bot Orchestration**: Modules in `src/bot/` are generally class-based or export a main execution factory function that receives a config object and a browser instance.
- **Separation of Concerns**: DOM operations should be performed via `page-controller.js`. Network sniffing should be done via `network-listener.js`. Bot logic should reside in `src/bot/` and not directly in `src/core/`.

## Error Handling
- Bots should fail gracefully with adequate logging (via `winston`).
- Puppeteer `TimeoutError`s are common due to lag or unexpected UI changes; they should be caught and logged, ideally falling back to a known safe state (e.g., refreshing the page or navigating back to the home screen).
