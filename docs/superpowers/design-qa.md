# Design QA — Evidence-backed Experiments review screen

## Scope

Visual and behavioral acceptance of the `/experiments` review screen against the approved
mock `docs/screenshots/experiment-review-concept.png`, using the built SPA served from an
isolated QA database.

## Environment

- Built app: `dist/` via `vite build`, served on `http://127.0.0.1:4599`.
- QA database: `/tmp/omarchy-agents-experiment-qa.sqlite` (seeded by
  `apps/web/tests/fixtures/seed-experiment-review.ts` — a `ready_for_review` experiment
  "Reduce repeated tool retries", 4 baseline + 4 trial sessions).
- Browser: Playwright Chromium (headless), deviceScaleFactor 1.

## Automated verification (18/18 passed)

| Check | Result |
| --- | --- |
| desktop-1440: no document horizontal overflow | pass (scrollW=1440) |
| tablet-1100: no document horizontal overflow | pass (scrollW=1100) |
| mobile-720: no document horizontal overflow | pass (scrollW=720) |
| mobile-390: no document horizontal overflow | pass (scrollW=390) |
| desktop-1440: analyst rail absent on experiments | pass (count=0) |
| mobile-390: mobile-nav excludes Limits, includes Experiments | pass |
| mobile-390: Save conclusion ≥44px height | pass (44) |
| desktop-1440: history trigger aria-haspopup=menu | pass |
| desktop-1440: history menu opens on click | pass |
| desktop-1440: Escape closes history menu | pass |
| desktop-1440: ledger renders rows | pass (8) |
| desktop-1440: Trial filter isolates trial rows | pass (4) |
| desktop-1440: evidence link targets `/logs?session=` | pass |
| reduced-motion: no lengthier transitions in review | pass (≤0.00001s) |
| desktop-1440: save initially enabled | pass |
| desktop-1440: save failure shows error | pass |
| desktop-1440: note retained after save failure | pass |
| desktop-1440: outcome retained after save failure | pass |

### Missing-session state (verified)

Deleting one indexed trial session (`t_2d9e4c73`) leaves its ledger row visible with class
`missing`, date `—`, and membership preserved (the session ID remains listed). Re-running the
fixture restores the full 8-session state.

## Combined reference/implementation comparison (1487×1058)

- Reference: `docs/screenshots/experiment-review-concept.png` (1487×1058).
- Implementation capture: viewport set to 1487×1058 of `/experiments`.
- Combined image: `/tmp/opencode/combined-1487.png` (reference + implementation side by side).

**Pixel-fidelity verdict: PASSED (human-confirmed).** The combined reference/implementation
comparison at 1487×1058 was reviewed and approved by the user on 2026-08-31. No material
mismatches remained in page geometry, title scale, row density, evidence-thread alignment,
metric separators, table clipping, decision spacing, button color, borders, focus visibility,
or text weights. This supplements the programmatic checks, which also found no material DOM or
geometric mismatches.

## Notes

- Non-deployed; evaluated against the isolated QA database only.
- Full test/typecheck/build gate passes (`bun run check`, `git diff --check`).
