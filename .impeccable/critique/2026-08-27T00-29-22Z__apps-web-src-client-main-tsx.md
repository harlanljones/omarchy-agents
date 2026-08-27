---
timestamp: 2026-08-27T00-29-22Z
slug: apps-web-src-client-main-tsx
---
# Critique — Omarchy Agents console (`apps/web/src/client/main.tsx`)

> Degraded run: code + deterministic detector review (no live-browser overlay in this environment).

## Design Health: 34/40 (Good)

| H | Score | Note |
|---|---|---|
| Visibility | 4 | Skeletons, busy/loading, health, aria-busy |
| Match world | 3 | Domain jargon unglossed for newcomers |
| Control | 3 | Nav, reset filters, skip link, Esc closes drawer |
| Consistency | 4 | One coherent system, documented in DESIGN.md |
| Error prevention | 3 | Numeric inputs strip non-digits; retry paths |
| Recognition | 3 | Labeled nav desktop+mobile; icon marks decorative |
| Flexibility | 3 | Keyboard 1-5 + Esc added |
| Aesthetic | 4 | Dense, intentional "evidence control room" |
| Error recovery | 4 | ErrorBoundary wrap added; clear retry |
| Help | 3 | Keyboard help added in Settings; no first-run guide |

Upgrades vs prior pass: error recovery (+1, ErrorBoundary), flexibility (+1, keyboard), help (+1, Settings help).

## Specificity: Strong
Non-interchangeable with a generic admin template. Concept, palette, type, components reinforce "local, quiet, evidence-first." Deterministic detector: **0 findings** after document reconciliation.

## What works
1. Ruled, scannable data regions (lab readout, not card soup).
2. Truthfulness in status (indexed vs metrics-only; no fabricated forecasts).
3. Accessibility fundamentals (focus, reduced-motion, skip link, 44px targets).

## Priority issues
- [P2] No first-run guidance / onboarding; cold-start newcomers hit unglossed jargon.
- [P3] Shortcuts documented in Settings but no on-surface hint.
- [P3] "Binding limit / metrics-only / redacted" unglossed; tooltip layer lifts H2+H10.

## Personas
- Alex (power): satisfied (keyboard + dense).
- Jordan (first-timer): weakest (jargon, no onboarding).
- Sam (a11y): well served.
- Casey (mobile): solid.

## Open questions
1. Onboarding vs contextual tooltips vs lean on Settings help?
2. Keep technical register or add plain-language hints?
3. Address only P2, or P2+P3 this pass?

## Next
Close with /impeccable polish (final visual pass).
