# Roadmap

## Milestone v3.3: Notifications

### Phase 12: Discord Cleanup
**Goal:** Remove raid start/end Discord notifications, keep captcha alerts only.
**Depends on:** Phase 11 (Layout Polish)
**Requirements:** DISC-01, DISC-02
**Success Criteria** (what must be TRUE):
  1. User receives no Discord notification when raid starts
  2. User receives no Discord notification when raid ends
  3. User receives Discord alert only when captcha is detected
**Status:** Complete

---

### Phase 13: System Notifications
**Goal:** Improve system notification clarity, fix sound issues, and optimize performance.
**Depends on:** Phase 12 (Discord Cleanup)
**Requirements:** NOTIF-01, NOTIF-02, NOTIF-03
**Success Criteria** (what must be TRUE):
  1. User sees clear, unambiguous notification messages
  2. Notification sound plays once per event (no duplicates)
  3. Notification rendering does not cause UI lag or stutter
**Status:** Pending

---

### Phase 14: Captcha Auto-Pause Flow
**Goal:** Auto-stop bot on captcha detection with resume capability after captcha cleared.
**Depends on:** Phase 12 (Discord Cleanup)
**Requirements:** CAPT-01, CAPT-02, CAPT-03
**Success Criteria** (what must be TRUE):
  1. User receives Discord webhook alert when captcha is detected
  2. Bot automatically stops execution when captcha appears
  3. User can resume bot operation after clearing the captcha
**Status:** Pending

---

## Milestone v3.2: UI Modernization

### Phase 8: Design System Foundation
**Goal:** Create UI-SPEC.md with color palette, typography, and spacing system; define component patterns.
**Requirements:** UI-01, UI-02
**Status:** Pending

---

### Phase 9: Dark Theme & Component Standardization
**Goal:** Refine dark theme with proper contrast ratios and standardize buttons/inputs per design contract.
**Requirements:** UI-03, UI-04, UI-05
**Status:** Complete

---

### Phase 10: Accessibility & Micro-interactions
**Goal:** Add ARIA labels to all interactive elements; implement CSS micro-interactions (focus states, scrollbars, selection).
**Requirements:** UI-06, UI-07
**Status:** Complete

---

### Phase 11: Layout Polish & Spacing Standardization
**Goal:** Tidy up the profile column layout — fix blank space after profile name, standardize button sizes, normalize margins/padding across P1 and P2 columns using CSS custom properties.
**Requirements:** UI-11
**Status:** Pending

---

## Milestone v3.1: Repository Hygiene (Complete)

### Phase 6: Repository Configuration
**Goal:** Add .editorconfig and .gitattributes.
**Requirements:** CONF-01, CONF-02
**Status:** Complete

### Phase 7: Source Structure & Docs
**Goal:** Barrel exports, README, CONTRIBUTING.
**Requirements:** SRC-01, SRC-02, DOCS-01, DOCS-02
**Status:** Complete

---

## Milestone v3.0: Logging & UI Standardization (Complete)

### Phase 5: Battle & Bot Log Standardization
**Goal:** Audit battle-handler and bot log tags.
**Requirements:** LOG-05, LOG-06, LOG-07
**Status:** Complete

---

## Progress Table

| Phase | Plans Complete | Status | Completed |
+|-------|----------------|--------|-----------|
+| 12. Discord Cleanup | 1/1 | Complete | 2026-03-19 |
+| 13. System Notifications | 0/0 | Not started | - |
+| 14. Captcha Auto-Pause Flow | 0/0 | Not started | - |
+| 11. Layout Polish | 1/1 | Complete | 2026-03-18 |
+| 10. Accessibility | 1/1 | Complete | 2026-03-18 |
+| 9. Dark Theme | 1/1 | Complete | 2026-03-17 |
+| 8. Design System | 1/1 | Complete | 2026-03-17 |
