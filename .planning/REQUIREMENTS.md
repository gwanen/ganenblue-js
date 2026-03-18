# Requirements: Ganenblue-JS

**Defined:** 2026-03-19
**Core Value:** Browser automation for Granblue Fantasy that handles quest farming, raid backup, and skip nightmare farming without detection

## v3.3 Requirements: Notifications

### Discord Integration

- [ ] **DISC-01**: Remove raid start/end Discord notifications
- [ ] **DISC-02**: Send Discord alert only on captcha detection

### System Notifications

- [ ] **NOTIF-01**: Audit and rewrite notification copy for clarity
- [ ] **NOTIF-02**: Fix duplicate notification sound issue
- [ ] **NOTIF-03**: Optimize notification performance (reduce lag)

### Captcha Flow

- [ ] **CAPT-01**: Trigger Discord webhook on captcha detection
- [ ] **CAPT-02**: Auto-stop bot via stop function on captcha
- [ ] **CAPT-03**: Add resume mechanism after captcha cleared

## v3.2 Requirements: UI Modernization (Complete)

### Design System
- [x] **UI-01**: Create UI-SPEC.md with color palette, typography, spacing system
- [x] **UI-02**: Define component patterns (buttons, inputs, panels, badges)

### Implementation
- [x] **UI-03**: Refine dark theme with proper contrast ratios (WCAG AA minimum)
- [x] **UI-04**: Standardize buttons/inputs per design contract
- [x] **UI-05**: Decide and implement log panel behavior (embedded vs separate window)

### Accessibility & Polish
- [x] **UI-06**: Add ARIA labels to all interactive elements
- [x] **UI-07**: Implement CSS micro-interactions (focus states, scrollbars, selection)

### Layout Polish
- [x] **UI-11**: Standardize profile-column layout — fix blank space after profile name/status badge, normalize button sizes in btn-group, enforce consistent margin/padding tokens across P1 and P2 columns, replace inline `style=` overrides with CSS classes.

## v3.1 Requirements: Repository Hygiene (Complete)

### Configuration
- [x] **CONF-01**: Add .editorconfig with code style standards (indentation, charset, line endings)
- [x] **CONF-02**: Add .gitattributes for GitHub language stats (mark generated files correctly)

### Source Structure
- [x] **SRC-01**: Create barrel exports (index.js) in src/ modules for clean imports
- [x] **SRC-02**: Ensure all src/ modules have consistent export patterns

### Documentation
- [x] **DOCS-01**: Update README.md with project structure diagram showing src/, config/, data/ layout
- [x] **DOCS-02**: Add CONTRIBUTING.md with setup instructions, coding conventions, and PR guidelines

## Out of Scope

| Feature | Reason |
|---------|--------|
| Push notifications (browser/desktop) | Focus on Discord + system tray only |
| SMS/Email alerts | Out of scope for browser automation |
| Captcha auto-solve | Requires user intervention, not bot capability |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DISC-01 | Phase 12 | Pending |
| DISC-02 | Phase 12 | Pending |
| NOTIF-01 | Phase 13 | Pending |
| NOTIF-02 | Phase 13 | Pending |
| NOTIF-03 | Phase 13 | Pending |
| CAPT-01 | Phase 14 | Pending |
| CAPT-02 | Phase 14 | Pending |
| CAPT-03 | Phase 14 | Pending |

**Coverage:**
- v3.3 requirements: 8 total
- Mapped to phases: 8
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-19*
