# Failure Triage

Use this order:

1. Open the GitHub **Hetzner operation diagnostics** job summary.
2. Download `hetzner-operation-<distributed-run-id>` and read
   `operation-report.json`.
3. If `recipeStarted` is false, use its `stage`, `failureCategory`, `component`,
   `evidenceExcerpt`, and `nextAction`. Do not request distributed analysis;
   no recipe artifact should exist.
4. For `manifest-scope`, compare `sourceGroupRef`, `effectiveGroupRef`,
   `groupIsolationMode`, both manifest hashes, and
   `materialized-manifest.json`. A mismatch is a preparation failure; do not
   reset the database or retry the recipe in the source group.
5. If `recipeStarted` is true, read `analysis/analysis.json`, then
   `analysis/fix-proposal.md`, then the cited evidence file.
6. Map the minimal fix area:
   - `dependency-repository`, `browser-dependencies`, `browser-installation`,
     `browser-verification`: controller preparation before any recipe.
   - `deployment-readiness`, `service-health`, `ssh`: deployment or controller
     infrastructure before agent startup.
   - `distributed targeting`: manifest target policy or agent identity scope.
   - `headless agent readiness`: login, registration, CORS, service status.
   - `distributed barrier`: missing synchronized readiness.
   - `RTC/TURN`: ICE, TURN, peer discovery, lane routing, RTC delivery.
   - `API/CORS/auth`: login, API config, WebSocket ticketing, allowed origins.
   - `recipe assertion`: expected vs observed payload or wait/assert command.
   - `control-server/runtime`: orchestration or artifact export behavior.
7. Propose one minimal fix and one focused verification command.

Do not propose broad refactors from one run. If the operation report itself is
missing, use the named failing GitHub step and request a same-ref rerun. Do not
describe absent distributed artifacts as missing evidence when
`recipeStarted` is false.

## Assertion parity failure codes

- `RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED` — an absence wait found a matching
  event after holding its full window. Category `assertion-absence`; minimal
  fix area `absence wait window or leaked traffic source`. Read the offending
  redacted event in the command result before changing recipe scope.
- `RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED` — an until loop ran out of
  count/duration/deadline bounds without a fully passing attempt. Category
  `convergence-polling`; minimal fix area `convergence polling bounds or
  backend convergence`. The error details carry the attempt count and the
  last failing child result.
- `missing-assertion-capability` staging blockers — a targeted agent does not
  advertise a required assertion feature. Category `capability-gating`;
  minimal fix area `agent assertion capability rollout`. Roll the fleet
  forward (Hetzner: rerun `08-rollout-controller.sh` + worker restart) or
  remove the gated feature from the manifest.
