# Failure Triage

Use this order:

1. Open the GitHub **Hetzner operation diagnostics** job summary.
2. Download `hetzner-operation-<distributed-run-id>` and read
   `operation-report.json`.
3. If `recipeStarted` is false, use its `stage`, `failureCategory`, `component`,
   `evidenceExcerpt`, and `nextAction`. Do not request distributed analysis;
   no recipe artifact should exist.
4. If `recipeStarted` is true, read `analysis/analysis.json`, then
   `analysis/fix-proposal.md`, then the cited evidence file.
5. Map the minimal fix area:
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
6. Propose one minimal fix and one focused verification command.

Do not propose broad refactors from one run. If the operation report itself is
missing, use the named failing GitHub step and request a same-ref rerun. Do not
describe absent distributed artifacts as missing evidence when
`recipeStarted` is false.
