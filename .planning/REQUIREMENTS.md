# Requirements: Refresh on Skills

**Defined:** 2026-03-20
**Core Value:** The bot must reliably automate GBF battles end-to-end, with animation-skipping refreshes that speed up farming runs.

## v1 Requirements

### Skill Refresh

- [ ] **SKILL-01**: Bot reloads page after each individual skill usage in Full Auto mode to skip skill animations
- [ ] **SKILL-02**: Skill refresh is toggleable via GUI checkbox (default: OFF)
- [ ] **SKILL-03**: Skill refresh state persists across sessions via localStorage (same pattern as summonRefresh/fastRefresh)
- [ ] **SKILL-04**: Skill refresh follows the exact same pattern as summonRefresh (constructor option, network flag, reload block)
- [ ] **SKILL-05**: Skill refresh is Full Auto only — not applied in Semi Auto mode

## v2 Requirements

(None)

## Out of Scope

| Feature                       | Reason                                                                  |
| ----------------------------- | ----------------------------------------------------------------------- |
| Semi Auto skill refresh       | SA already has per-attack refresh, skill refresh adds no value          |
| Per-skill-slot configuration  | All-or-nothing is simpler for v1; can add later                         |
| YAML config for skill refresh | GUI toggle + localStorage is sufficient (matches summonRefresh pattern) |

## Traceability

| Requirement | Phase   | Status  |
| ----------- | ------- | ------- |
| SKILL-01    | Phase 1 | Pending |
| SKILL-02    | Phase 1 | Pending |
| SKILL-03    | Phase 1 | Pending |
| SKILL-04    | Phase 1 | Pending |
| SKILL-05    | Phase 1 | Pending |

**Coverage:**

- v1 requirements: 5 total
- Mapped to phases: 5
- Unmapped: 0

---

_Requirements defined: 2026-03-20_
