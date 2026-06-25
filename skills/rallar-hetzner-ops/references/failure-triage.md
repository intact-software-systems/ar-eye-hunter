# Failure Triage

Use this order:

1. Read `analysis/analysis.json`.
2. Read `analysis/fix-proposal.md`.
3. Open the cited evidence file.
4. Map the minimal fix area:
   - `distributed targeting`: manifest target policy or agent identity scope.
   - `headless agent readiness`: login, registration, CORS, service status.
   - `distributed barrier`: missing synchronized readiness.
   - `RTC/TURN`: ICE, TURN, peer discovery, lane routing, RTC delivery.
   - `API/CORS/auth`: login, API config, WebSocket ticketing, allowed origins.
   - `recipe assertion`: expected vs observed payload or wait/assert command.
   - `control-server/runtime`: orchestration or artifact export behavior.
5. Propose one minimal fix and one focused verification command.

Do not propose broad refactors from one run. If evidence is missing, ask for a
rerun with the same manifest and artifacts retained.
