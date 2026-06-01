# Distributed Recipe Full-Stack QA

This runbook describes the Playwright coverage for distributed recipe execution through
`apps/rallar-black-box-control-server` and browser control agents.

## Quick Command

```bash
npm run test:e2e:rallar-black-box:full-stack:real:distributed
```

That command runs `tests/playwright/rallar-black-box/full-stack-distributed-recipes.spec.ts`.
It starts or reuses the SPA, control server, and API-v1 through the full-stack Playwright config.
The root command also enables the live distributed slice. In the local API-v1 fixture environment it uses the bundled
`alice/secret`, `bob/secret`, and `charlie/secret` users unless per-agent credentials are supplied.

## Simulated Coverage

The simulated part runs whenever `RALLAR_BLACK_BOX_FULL_STACK=1` is set:

- opens three browser contexts as connected control agents
- resolves targets from the reported application/workspace/group identity
- stages and starts an all-agent ACK recipe
- verifies distributed-run artifacts and historical run display
- covers schema failure, missing target count, ACK timeout, disconnect-after-stage, and one-agent failure rollup

## Live Real-Data Coverage

The live part is opt-in because it sends real HTTP, WS, and RTC traffic:

```bash
RALLAR_BLACK_BOX_FULL_STACK=1 \
RALLAR_BLACK_BOX_DISTRIBUTED_RECIPES=1 \
VITE_RALLAR_API_BASE_URL=http://localhost:8080 \
VITE_RALLAR_APPLICATION_ID=rallar-server \
VITE_RALLAR_WORKSPACE_ID=default \
VITE_RALLAR_ROOM_ID=rallar-bb-live \
VITE_RALLAR_AGENT_A_USERNAME=alice \
VITE_RALLAR_AGENT_A_PASSWORD=secret \
VITE_RALLAR_AGENT_B_USERNAME=bob \
VITE_RALLAR_AGENT_B_PASSWORD=secret \
VITE_RALLAR_AGENT_C_USERNAME=charlie \
VITE_RALLAR_AGENT_C_PASSWORD=secret \
npx playwright test \
  --config apps/rallar-black-box/playwright.full-stack.config.ts \
  tests/playwright/rallar-black-box/full-stack-distributed-recipes.spec.ts
```

For local API-v1 runs these username/password values are defaults, so they can be omitted. The live section still stays
behind `RALLAR_BLACK_BOX_DISTRIBUTED_RECIPES=1` because it sends real WS and RTC payloads.

The live test creates a unique group from `VITE_RALLAR_ROOM_ID`, joins all three
users, runs an all-agent ACK recipe resolved from that group, sends a WS payload
from one browser and verifies the other browsers receive it, connects RTC and
verifies a broadcast realtime payload reaches the other browsers, then runs a
one-second `rtc-realtime` composite recipe. The realtime leg verifies effective
20 Hz frame rows, loop drilldown evidence, at least one received position
payload, and visible runtime warnings in the Distributed Recipes monitor.

Each live WS, RTC, and realtime payload carries the distributed-run ID so
asynchronous receive events can be linked back to the selected distributed run.
The Playwright test writes warning-regression JSON attachments and captures
browser console warnings/errors as `distributed-live-console-warnings.json`.
Known harmless WS/RTC warnings are retained as artifacts; the regression report
fails only on configured high-severity runtime diagnostics.

The live WS recipe uses a `room.*` topic. Rallar Server treats `rallar.*` as a
reserved system namespace for dynamic WS routing, so user-authored distributed
recipes should use `room.*` or `app.*` topics when they expect server fanout.

Restored-session variables can replace username/password per agent:

- `VITE_RALLAR_AGENT_A_TOKEN`
- `VITE_RALLAR_AGENT_A_CLIENT_ID`
- `VITE_RALLAR_AGENT_A_SESSION_ID`
- `VITE_RALLAR_AGENT_A_USERNAME`

Use the matching `B` and `C` names for the other agents.
