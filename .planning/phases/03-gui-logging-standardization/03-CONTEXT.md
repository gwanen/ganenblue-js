# Phase 03: GUI Logging Standardization - Context

**Gathered:** 2026-03-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Standardize the GUI logging panel by adding success-level styling, ensuring consistent P1/P2 colors, and consolidating redundant GUI tags. This phase focuses entirely on `index.html`, `renderer.js`, and `main.js`.
</domain>

<decisions>
## Implementation Decisions

### Styling
- Provide CSS class `.log-level-success` with a green left border using `var(--accent-green)`.
- Ensure P1 profile label tag explicitly uses `--accent-blue` (#60a5fa) and P2 uses `--accent-red` (#f87171) in the `renderer.js` logic and `index.html` inline styles.
- Create explicit `.log-tag-browser` color rule relying on blue (`--accent-blue`).
- Repurpose the miscolored `.log-tag-status` (emerald green) to `.log-tag-cleared`.

### Wording & Tags
- `main.js`: Replace all `[Gui]` tags with `[System]`. Refactor the `Finished:` log to: `Done — Quests: X | Raids: Y`.
- `renderer.js`: Pass `'success'` into `this.log(level, msg)` directly where appropriate (e.g. settings saved).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Core Requirements
- `.planning/REQUIREMENTS.md` — Defines LOG-01 and LOG-02.
- `implementation_plan.md` — The extensively detailed styling guide from our previous discussion.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/gui/index.html`: Contains `.log-tag-*` and `.log-level-*` CSS rules (lines 350-475).
- `src/gui/renderer.js`: Contains `log(level, msg)` function that creates DOM nodes for the log panel.
- `src/gui/main.js`: Main process IPC event handlers containing `[Gui]` and `[Status]` logger calls.

</code_context>

<specifics>
## Specific Ideas
- The new green border should visually map the width and style of existing `.log-level-info` (blue border).
</specifics>

<deferred>
## Deferred Ideas
None — discussion stayed completely within phase scope.
</deferred>
