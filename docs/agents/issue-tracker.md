# Issue tracker: Linear

Issues and specs for this repo live in **Linear**.

## Command and scope

- Command: `linear` (resolve from `PATH`; this machine installs it at `/home/harlan/.cache/.bun/bin/linear`)
- Workspace: `harlanljones`
- Team: `HJ` (Harlan Jones — personal team; no dedicated team for this repo)
- Project: `omarchy-agents` (id `75b71f1e-e8b8-485d-8f74-4151b6cb2e4c`)

Run the command's `--version` and `--help` once at the start of a tracker session. The installed CLI's help is authoritative. If it is unavailable, do not substitute GitHub issues, local markdown, or direct API calls; report the setup gap and continue work that does not need the tracker.

## States and labels

Linear workflow states and labels are separate. Canonical triage roles such as `ready-for-agent` are labels; applying one does not move workflow state unless the invoking skill says to.

The triage label mapping lives in `docs/agents/triage-labels.md`.

## Common operations

- Create: `linear issue create --no-interactive --team HJ --project 75b71f1e-e8b8-485d-8f74-4151b6cb2e4c --title "..." --description-file <path>`
- Read: `linear issue view [ID] --json --no-download`
- Query: `linear issue query --team HJ --all-states --all-assignees --json`
  (`issue query` has no parent/project filter in CLI 2.5.0 — query the bounded team set as JSON, then filter rows whose `project.name === "omarchy-agents"`.)
- Comment: `linear issue comment add [ID] --body-file <path>`
- Incremental labels: `linear issue update [ID] --add-label "..."` / `--remove-label "..."`
- Claim: re-check open + unassigned + unblocked, then `linear issue update [ID] --assignee self` as the first write.
- Complete: resolution comment first, then `linear issue update [ID] --state completed`.

Use Markdown files for multi-line descriptions and comments. Never print or store the API token in the repository.

## Wayfinding operations

Used by `wayfinder`. The map is a Linear issue labelled `wayfinder:map`; its decision tickets are native child issues created with `--parent [MAP-ID]` and labelled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.

- Blocking: native Linear issue relations, e.g. `linear issue relation add [BLOCKED] blocked-by [BLOCKER]`.
- Frontier: open, unassigned child issues whose native relations contain no open blocker. Query a bounded issue set as JSON, filter by parent, then inspect relations for candidates.
- Resolve: add the answer as a resolution comment, move the child to the completed state, then merge a one-line linked gist into the map's `Decisions so far` section without overwriting concurrent edits.

Refer to issues by linked title in prose, not bare identifiers.
