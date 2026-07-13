---
name: rallar-hetzner-ops
description: Use when running, debugging, or analyzing Hetzner-hosted Rallar black-box distributed recipes, headless browser agents, GitHub Actions recipe runs, fleet reports, or remote controller artifacts.
---

# Rallar Hetzner Ops

Use this for remote Hetzner controller work involving `rallar-black-box`,
headless browser agents, distributed run manifests, GitHub Actions, and
artifact analysis.

For already-running worldwide agents, keep the workflow distinct from Hetzner
VM lifecycle management. Use checked-in manifests under
`apps/rallar-black-box/manifests/world-fleet` and the no-spawn runner
`apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts`; do not
start, stop, install, or restart headless agents for that flow.

## Start Here

- For workflow usage and operator commands, read
  `references/github-action-workflow.md`.
- For artifact interpretation, read `references/artifact-analysis.md`.
- For failed runs, read `references/failure-triage.md`.
- For passed runs and performance summaries, read
  `references/performance-thresholds.md`.

## Rules

- Prefer the GitHub workflow `Run Hetzner Distributed Recipe` for remote runs.
- Prefer the no-spawn world-fleet runner when agents are already connected to a
  shared control server/control run.
- Use checked-in distributed manifest JSON files. Do not paste secrets or admin
  tokens into prompts, manifests, workflow inputs, or URLs.
- Treat `scripts/hetzner/controller/*.sh` as the source of truth for VM service
  management.
- Inspect uploaded artifacts before proposing fixes.
- If the run failed, cite the failure evidence file, command id, affected
  agents, and minimal fix area.
- If the run passed, summarize performance from `performance.md` or
  `analysis.json`.
- Use `rallar-testing` to choose verification commands for any proposed code
  or config fix.

## Typical Flow

1. Select or create a distributed manifest.
2. Dispatch `.github/workflows/hetzner-distributed-recipe.yml`.
3. Download the distributed artifact and analysis artifacts.
4. Read `analysis/analysis.json` first.
5. For failures, read `analysis/fix-proposal.md` and the cited raw artifact.
6. For success, read `analysis/performance.md`.
7. Propose the smallest code, recipe, config, or infra fix that matches the
   evidence.

## World-Fleet No-Spawn Flow

1. Confirm all agents are already connected to the same control server and
   `controlRunId`.
2. Select a manifest under `apps/rallar-black-box/manifests/world-fleet`.
3. Run `npx tsx apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts --control <url> --manifest <path> --control-run-id <live-control-run-id> --token "$RALLAR_CONTROL_ADMIN_TOKEN"`.
4. Inspect the exported `artifact-bundle.json`, `target-resolution.json`,
   `distributed-run.json`, `report.json`, `failures.json`, and
   `metadata.json`.
5. Run the distributed artifact analyzer separately before expecting
   `analysis/analysis.json`, `analysis/fix-proposal.md`, or
   `analysis/performance.md`.
