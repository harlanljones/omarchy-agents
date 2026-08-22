# Omarchy Agents

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Bun, React, Vite, Hono, SQLite, Zod, Visx, and TanStack Virtual. The application and all source data stay on the local Omarchy machine.

## Users

One private user, Harlan, reviewing personal AI-agent usage from the desktop or an authenticated remote browser. The core job is to understand where agent time and tokens went, inspect the underlying work, and decide what to improve.

## Product Purpose

Unify provider standings, historical trends, searchable redacted transcripts, and a citation-bound local analyst. Success means a ranking can be traced to local evidence and an analyst claim can be opened at the exact session event that supports it.

## Positioning

This is an evidence console over local agent activity: it combines the existing Omarchy leaderboard semantics with transcript-level proof and a local-only analyst that cannot silently change configuration.

## Operating Context

The app runs on an Omarchy Linux workstation, reads local Claude, Codex, Cline, Antigravity, OpenCode, Fireworks, and usage-collector stores, and is reached remotely through Cloudflare Tunnel and Access. Nightly analysis runs at 03:15 local time; refreshes use the fixed `omarchy-agent-usage-update --force` command.

## Capabilities and Constraints

- Local SQLite is the normalized index; raw text remains on the workstation at rest.
- Rankings preserve the desktop Today, 7 days, and All-time semantics, with 30-day and custom history where indexed data supports it.
- Unknown fields are retained; malformed records are isolated as diagnostics.
- Secret-like content is redacted before persistence or streaming.
- The analyst is read-only, bounded to eight tool iterations, and must cite evidence returned by tools.
- Suggestions may be opened, accepted, or dismissed but never mutate agent files or settings.
- Remote requests require a valid Cloudflare Access JWT for `harlanljones@gmail.com`; loopback use remains unauthenticated.

## Brand Commitments

Use the Omarchy Agents name with the existing trophy and provider marks, restrained provider colors, and dark Omarchy console vocabulary. Information is dense, calm, and operational rather than decorative.

## Evidence on Hand

- Existing ranking implementation: `apps/omarchy-agent-leaderboard/Model.js`
- Existing shell interface and palette: `apps/omarchy-agent-leaderboard/Panel.qml`
- Shared provider/trophy assets: `packages/provider-assets/assets/`
- Local usage records and transcript databases are runtime inputs and are never committed.

## Product Principles

- Every important claim is inspectable.
- Partial truth is labeled; missing coverage is never estimated.
- Metrics remain useful while indexing catches up.
- Remote convenience does not weaken local privacy.
- Analysis advises; the human changes the system.

## Accessibility & Inclusion

Meet WCAG 2.2 AA with complete keyboard operation, visible focus, reduced-motion behavior, non-color status cues, text chart summaries, and semantic tables.
