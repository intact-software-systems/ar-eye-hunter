# Free-Tier Headless Browser Distributed Recipes

Findings captured on 2026-07-06. Re-check provider pricing, limits, and
acceptable-use terms before treating any free tier as an operational budget.

## Summary

Rallar can use free tiers for distributed recipe participation, but not as one
uniform deployment model. The current `rallar-black-box` headless worker is a
long-lived Node/Playwright process that launches a browser, opens one context per
agent, registers each agent with `apps/rallar-black-box-control-server`, and then
waits for recipe commands. That shape maps cleanly to VMs and containers, but
poorly to edge/serverless browser products that expect short tasks.

Recommended path:

1. Keep the existing Node/Playwright worker as the canonical runtime for
   long-lived recipe agents.
2. Add an explicit one-shot/lease mode so ephemeral providers can join, run a
   bounded distributed recipe, upload artifacts, and exit before free-tier
   limits or idle reapers bite.
3. Use Oracle Cloud Always Free or another real VM/container host for the first
   persistent remote pool.
4. Use GitHub Actions for scheduled or manually triggered burst runs.
5. Use Cloudflare Browser Run and Browserless Free only for short browser
   canaries until a spike proves they can run the RTC recipe surface reliably.
6. Treat Cloudflare Workers/Durable Objects/Queues as a coordination and wake-up
   layer, not as the primary place to run the existing headless worker.

## Current Rallar Fit

The repo already has most of the control plane:

- `packages/shared-test/rallar-bb-test/distributed-run.ts` owns the distributed
  manifest, target policies, lifecycle states, rollup rules, control-agent
  identity, fleet metadata, and group/member-to-agent matching.
- `apps/rallar-black-box-control-server` exposes distributed-run APIs over a
  lower-level `/runs` command/result/event store.
- `apps/rallar-black-box/scripts/headless-worker.ts` launches Playwright,
  opens browser agents, waits for control-server commands, and exits only on
  process signal.
- `apps/rallar-black-box/src/headless-worker-config.ts` already forwards
  provider, region, datacenter, host, pool, deployment, browser, OS, tag, and
  coordinate metadata to browser agents.
- `apps/rallar-black-box/manifests/hetzner/*.json` are useful templates for
  provider-neutral remote manifests; the names can stay historical, but the
  shape is not Hetzner-specific.

The missing piece is provider-aware lifecycle management. Free providers need
agents that advertise limits and shutdown intent, and the orchestrator needs to
avoid scheduling a 15-minute recipe onto a one-minute browser session.

## Provider Matrix

| Provider                                                  | Fit                                   | Free/near-free shape                                                                                                                                                                                                       | Pros                                                                                                                         | Cons                                                                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oracle Cloud Always Free                                  | Best persistent free pool             | Up to two AMD micro VMs and Ampere A1 allowance equivalent to 2 OCPUs / 12 GB memory, plus 200 GB block volume and 10 TB outbound data/month in Always Free docs                                                           | Real VM, outbound WSS works, enough memory for a small Chromium fleet, can run systemd/Docker, persistent logs               | Capacity can be unavailable, idle Always Free instances may be reclaimed, account setup requires card/phone, ARM image/browser dependency validation needed                                         |
| GitHub Actions                                            | Best burst pool                       | Public repos use standard hosted runners free; private Free plan has 2,000 minutes/month and 500 MB artifact storage; hosted jobs can run up to 6 hours                                                                    | Already has Playwright-friendly Linux runners, secrets, artifacts, manual/scheduled triggers, matrix fan-out, no server ops  | Not a daemon, runner region/IP is not a controllable product feature, private quota is easy to burn with browser jobs, outbound-only                                                                |
| Cloudflare Browser Run                                    | Good short canary; uncertain RTC pool | Workers Free includes 10 minutes/day of browser time, 3 concurrent browser sessions, one new browser every 20 seconds, 60s default timeout with keep-alive up to 10 minutes                                                | No container to maintain, close to the edge, Playwright and CDP support, great for health/screenshot/registration probes     | Existing Node worker cannot run as-is, browser minutes are tiny, Worker Free has 10 ms CPU and 100k requests/day, WebRTC/data-channel behavior must be proven, not suitable for idle control agents |
| Browserless Free                                          | Good short CDP canary                 | Free plan lists 1k units/month, 2 concurrent browsers, 1-minute max session time, Chrome/WebKit/Firefox endpoints                                                                                                          | Standard Playwright can connect over CDP from a normal runner, managed browser infrastructure, multi-browser engine coverage | Two-browser concurrency blocks three-agent recipes, 1-minute session cap forces very short manifests, units are browser-time based, not a place to run repo code                                    |
| Google Cloud Run                                          | Good short container pool             | Free tier has request-based 180k vCPU-s, 360k GiB-s, and 2M requests/month; instance-based tier has 240k vCPU-s and 450k GiB-s/month; request timeout up to 60 minutes; WebSockets supported as long-running HTTP requests | Runs the existing Dockerized Node worker, scales to zero, official WebSocket support, easy regional deployment               | Billing account required, WebSocket/always-on workers consume active time, 60-minute request timeout means reconnect/lease logic is required                                                        |
| Azure Container Apps                                      | Good short container pool             | Consumption plan first 180k vCPU-s, 360k GiB-s, and 2M requests/month free; scales to zero                                                                                                                                 | Container-native, good for one-shot workers/jobs, easy secret management                                                     | Browser image may need more memory than the smallest free-friendly shape, idle/active billing thresholds matter, account/budget controls required                                                   |
| AWS Lambda                                                | Limited one-shot probe                | 1M requests/month and 400k GB-s/month free; 15-minute max timeout; up to 10 GB container image                                                                                                                             | Can run packaged Chromium for short tasks, huge ecosystem                                                                    | Poor match for a control-agent WebSocket that waits for commands; no persistent process; packaging/debugging browser dependencies is fiddly                                                         |
| Render Free                                               | Poor browser-worker fit               | 750 free instance hours/workspace/month; free web services spin down and have ephemeral filesystem                                                                                                                         | Simple web deployments; could host a toy control/UI demo                                                                     | Spin-down breaks control agents, high service-initiated traffic can suspend service, free web service memory is a bad fit for Chromium                                                              |
| Fly.io / Koyeb / Railway                                  | Not a current free-tier target        | Current public pricing is usage/plan based or legacy-only for free allowances                                                                                                                                              | Good paid/cheap container platforms if budget appears                                                                        | Do not plan a no-cost roadmap around them for new accounts                                                                                                                                          |
| Vercel / Netlify / Deno Deploy / plain Cloudflare Workers | Control plane only                    | Free web/function tiers                                                                                                                                                                                                    | Good for static UI, control shims, webhooks, or signed launch endpoints                                                      | Not suitable for running real headless Chromium participation                                                                                                                                       |

## Recommended Architecture

Use three pools, all speaking the same Rallar control protocol:

1. Persistent pool: one or two VM/container agents running the existing
   `worker:headless` script. Start with Oracle Always Free, then add a tiny paid
   Hetzner/Fly/Cloud Run fallback if the free VM is unavailable.
2. Burst pool: GitHub Actions or Cloud Run/Azure jobs that run only when a
   distributed recipe is queued. They should register, wait for stage/start,
   run, publish artifacts, and exit.
3. Probe pool: Cloudflare Browser Run or Browserless Free sessions that run
   very small `health`, `ws.open/ws.send`, and maybe `rtc.connect` canaries. Do
   not depend on these for long RTC streams until the spike passes.

All pools should connect outbound to public HTTPS/WSS endpoints:

- `RALLAR_BLACK_BOX_SPA_URL=https://blackbox.example.com`
- `RALLAR_BLACK_BOX_CONTROL_URL=wss://blackbox-control.example.com/control`
- `RALLAR_API_BASE_URL=https://api.example.com`
- `RALLAR_BLACK_BOX_RUN_ID=free-tier-run-001`
- `RALLAR_BLACK_BOX_ROOM_ID=free-tier-room`

Do not put server-only tokens into Vite bundles. Prefer short-lived run tokens
or restored-session tokens over long-lived username/password query parameters.
For production-like tests, enable `RALLAR_PRODUCTION_HARDENING=1` on the
control server and use TLS, allowed origins, allowed command kinds, and read
tokens.

## Roadmap

### Phase 0: Local Baseline And Provider Spikes

Goal: prove the same recipe can run locally and on at least one free remote
provider without changing recipe semantics.

- Run the existing full-stack memory distributed tests locally.
- Run the existing Node worker against a public control server from a laptop or
  temporary VM.
- Spike Cloudflare Browser Run with one `health` registration and record:
  browser startup latency, session timeout behavior, whether `/headless/`
  registers, and whether WebRTC data channels can establish.
- Spike Browserless Free with two short agents using CDP and a 30-45 second
  smoke manifest.
- Spike GitHub Actions with `workflow_dispatch` and two browser contexts in one
  job.

Exit criteria:

- A provider evidence table has concrete pass/fail rows for `health`,
  `ws.open/ws.send`, `rtc.connect`, and `rtc.stream 10s`.
- At least one free provider can run a two-agent `rtc-smoke` manifest against a
  public Rallar stack.

### Phase 1: Agent Lease And Exit Semantics

Goal: make ephemeral agents first-class instead of hoping a job timeout cleans
them up.

- Add worker config for `RALLAR_BLACK_BOX_EXIT_MODE`:
  - `signal`: current behavior.
  - `after-first-terminal-distributed-run`: exit when the targeted distributed
    run reaches `passed`, `failed`, `cancelled`, or `timed-out`.
  - `after-idle-ms`: exit after no command activity for a configured period.
- Add optional `RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID`.
- Add identity capability fields:
  - `maxSessionSeconds`
  - `supportsLongLivedAgent`
  - `supportsWebRtcDataChannel`
  - `supportsRtcStream`
  - `providerFreeTier`
  - `leaseExpiresAtEpochMs`
- Update target resolution so expiring agents are visible but not targetable for
  recipes that exceed their advertised lease.

Exit criteria:

- GitHub Actions and Cloud Run jobs terminate cleanly after a run.
- The Distributed Recipes UI can explain why a free-tier agent is not targetable
  for a long recipe.

### Phase 2: Browser Launcher Abstraction

Goal: keep existing local Playwright behavior while enabling CDP/browser-service
providers.

- Introduce a small launcher boundary around the current Playwright browser
  launch call.
- Support:
  - `local-playwright`: current `chromium/firefox/webkit.launch`.
  - `cdp-playwright`: connect to Browserless or another remote browser endpoint.
  - `cloudflare-browser-run`: separate Worker template using
    `@cloudflare/playwright` because it cannot run the current Node script
    unchanged.
- Keep the browser-agent page contract the same: every provider still opens the
  `/headless/` SPA with URL parameters and uses the control protocol through the
  browser app.

Exit criteria:

- The same worker config can launch local Chromium or connect to a remote CDP
  browser.
- Browserless Free can run a two-agent, one-minute-safe recipe.

### Phase 3: Deployment Templates

Goal: make provider experiments reproducible.

Add templates under a provider-neutral directory such as
`apps/rallar-black-box/deploy/free-tier/`:

- `docker/Dockerfile` for the Node/Playwright worker.
- `github-actions/free-tier-distributed-recipe.yml` for `workflow_dispatch` and
  scheduled bursts.
- `oracle-cloud/systemd/rallar-black-box-worker.service` for an Always Free VM.
- `cloud-run/service.yaml` and a job-oriented launch script.
- `azure-container-apps/containerapp.bicep` or `az containerapp` notes.
- `cloudflare-browser-run/` Worker template for health and RTC smoke probes.
- `browserless/README.md` for CDP endpoint wiring and one-minute manifests.

Exit criteria:

- A clean account can deploy at least one remote agent pool using only the docs
  and templates.
- Every template labels fleet metadata (`fleetProvider`, `fleetRegion`,
  `fleetDatacenter`, `fleetAgentPoolId`, `fleetDeploymentId`, `fleetTags`).

### Phase 4: Cost And Reliability Guardrails

Goal: keep free-tier experiments from silently turning into surprise bills or
misleading signal.

- Add provider budgets to manifests or run metadata:
  - max browser seconds
  - max wall-clock run seconds
  - max concurrent agents
  - max artifact bytes
- Add warning classifications for:
  - session cap reached
  - provider startup timeout
  - provider idle reaped
  - likely TURN-required network
  - browser service quota exceeded
- Add artifact analysis rows for provider/region/browser/OS and selected RTC
  candidate pair when available.
- Keep generated profile/artifact files out of git unless explicitly requested.

Exit criteria:

- Failed free-tier runs show whether the failure is Rallar behavior, browser
  provider behavior, network/TURN behavior, or quota exhaustion.

### Phase 5: Broaden Regions And Graduate Winners

Goal: convert proven free-tier experiments into a durable low-cost fleet.

- Promote the best free VM/container provider to a small paid baseline if
  reliability matters.
- Keep free providers as canaries and comparison points.
- Add a TURN strategy from `playground/COTURN_HETZNER_VS_METERED.md` before
  judging cross-provider WebRTC stability.
- Add multi-region recipe manifests only after two-agent smoke is stable per
  provider.

Exit criteria:

- The project can run a scheduled nightly distributed recipe with at least two
  different network/provider origins and export artifacts automatically.

## Implementation Plan

### Task 1: Record Provider Capabilities In Agent Identity

Files:

- Modify `packages/shared-test/rallar-bb-test/distributed-run.ts`.
- Modify `packages/shared-test/rallar-bb-test/schema.ts`.
- Modify `packages/tests/shared-test/rallar-bb-test-distributed-run.test.ts`.
- Modify `packages/tests/rallar-black-box/control-client.test.ts`.

Implementation:

- Extend `RallarBlackBoxControlAgentCapabilities` with a browser/runtime
  capability object.
- Add optional fields for max session seconds, lease expiry, provider free-tier
  label, and supported recipe profiles.
- Keep fields optional for compatibility with existing agents.
- Add tests showing old agents still validate, new agents preserve capability
  metadata, and target resolution can read lease metadata.

Validation:

- `npx vitest run packages/tests/shared-test/rallar-bb-test-distributed-run.test.ts packages/tests/rallar-black-box/control-client.test.ts`
- `npm --workspace @ar-eye-hunter/shared-test run check:ts`

### Task 2: Add One-Shot Exit Modes To The Headless Worker

Files:

- Modify `apps/rallar-black-box/src/headless-worker-config.ts`.
- Modify `apps/rallar-black-box/scripts/headless-worker.ts`.
- Modify `packages/tests/rallar-black-box/headless-worker-config.test.ts`.
- Modify `packages/tests/rallar-black-box/headless-worker-script.test.ts`.

Implementation:

- Add `RALLAR_BLACK_BOX_EXIT_MODE`, `RALLAR_BLACK_BOX_IDLE_EXIT_MS`, and
  `RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID`.
- Poll `/distributed-runs/{id}` when a target distributed run is configured.
- Exit cleanly once the run reaches a terminal lifecycle state.
- Preserve the current signal-only behavior as the default.
- Redact any new token-like query or log fields.

Validation:

- `npx vitest run packages/tests/rallar-black-box/headless-worker-config.test.ts packages/tests/rallar-black-box/headless-worker-script.test.ts`
- `npm --workspace rallar-black-box run typecheck`

### Task 3: Add A Browser Launcher Boundary

Files:

- Create `apps/rallar-black-box/src/headless-browser-launcher.ts`.
- Modify `apps/rallar-black-box/scripts/headless-worker.ts`.
- Modify `apps/rallar-black-box/src/headless-worker-config.ts`.
- Add tests under `packages/tests/rallar-black-box/headless-browser-launcher.test.ts`.

Implementation:

- Move local Playwright launch into a new `createHeadlessBrowserLauncher`
  helper.
- Add a CDP mode for remote browser services with:
  - `RALLAR_BLACK_BOX_BROWSER_LAUNCH_MODE=cdp`
  - `RALLAR_BLACK_BOX_CDP_ENDPOINT`
  - `RALLAR_BLACK_BOX_CDP_TOKEN`
- Keep the local launch path as default.
- Do not add Cloudflare Browser Run to the Node worker path; implement that as a
  separate Worker template because it uses Cloudflare's Playwright fork and
  Workers runtime constraints.

Validation:

- `npx vitest run packages/tests/rallar-black-box/headless-browser-launcher.test.ts packages/tests/rallar-black-box/headless-worker-config.test.ts`
- `npm --workspace rallar-black-box run typecheck`

### Task 4: Add Provider Deployment Templates

Files:

- Create `apps/rallar-black-box/deploy/free-tier/docker/Dockerfile`.
- Create `apps/rallar-black-box/deploy/free-tier/github-actions/free-tier-distributed-recipe.yml`.
- Create `apps/rallar-black-box/deploy/free-tier/oracle-cloud/systemd/rallar-black-box-worker.service`.
- Create `apps/rallar-black-box/deploy/free-tier/cloud-run/service.yaml`.
- Create `apps/rallar-black-box/deploy/free-tier/azure-container-apps/README.md`.
- Create `apps/rallar-black-box/deploy/free-tier/browserless/README.md`.
- Create `apps/rallar-black-box/deploy/free-tier/cloudflare-browser-run/README.md`.

Implementation:

- Use the existing `npm --workspace rallar-black-box run worker:headless`
  script for Docker, OCI, GitHub Actions, Cloud Run, and Azure.
- Include minimum env var examples and provider-specific fleet metadata.
- Include a short warning beside every free-tier-specific limit.
- For Cloudflare Browser Run, document a spike first: `health`, `ws.send`, then
  `rtc.connect`. Only add recipe orchestration after the spike proves WebRTC.

Validation:

- `npm --workspace rallar-black-box run typecheck`
- `git diff --check -- apps/rallar-black-box/deploy/free-tier`

### Task 5: Add Leases To Control-Server Targeting

Files:

- Modify `apps/rallar-black-box-control-server/src/control-service.ts`.
- Modify `apps/rallar-black-box-control-server/src/main.ts`.
- Modify `apps/rallar-black-box-control-server/src/routes/swagger-routes.ts`.
- Modify `apps/rallar-black-box-control-server/test/control-service.test.ts`.
- Modify `apps/rallar-black-box-control-server/test/api-black-box.test.ts`.

Implementation:

- Preserve capability metadata on register and heartbeat snapshots.
- Add target-resolution warnings for agents whose lease expires before the
  recipe's estimated deadline.
- Add an optional `estimatedRunDurationMs` or `maxRecipeDurationMs` metadata path
  for manifests so the server can make a deterministic targetability decision.
- Keep older manifests and agents accepted.

Validation:

- `cd apps/rallar-black-box-control-server && deno task check`
- `cd apps/rallar-black-box-control-server && deno task test`

### Task 6: Show Provider Fit In The SPA Monitor

Files:

- Modify `apps/rallar-black-box/src/distributed-recipes.ts`.
- Modify `apps/rallar-black-box/src/control-agent-board.ts`.
- Modify `apps/rallar-black-box/src/fleet-world-map.tsx`.
- Modify related tests under `packages/tests/rallar-black-box`.

Implementation:

- Display provider, region, datacenter, pool, browser, OS, and lease expiry on
  agent rows.
- Add a "not targetable" explanation when a free-tier session is too short for
  the selected recipe.
- Add artifact warnings for quota/timeout/provider-limit failures.

Validation:

- `npx vitest run packages/tests/rallar-black-box/control-agent-board.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts`
- `npm --workspace rallar-black-box run typecheck`
- `npm run test:rallar:full-stack:memory`

### Task 7: Run Provider Acceptance Tests

Acceptance sequence:

1. Local memory full-stack distributed recipe.
2. GitHub Actions two-agent `health` manifest.
3. GitHub Actions two-agent `rtc-smoke` manifest.
4. Oracle Always Free two-agent `rtc-smoke` manifest.
5. Cloudflare Browser Run one-agent registration and `health`.
6. Browserless Free two-agent short `ws.send` or `rtc.connect` smoke.
7. Three-agent `rtc-realtime` only after two independent two-agent provider
   runs pass.

Acceptance commands:

- `npm run test:rallar:full-stack:memory`
- `npm run test:rallar:full-stack:postgres:distributed`
- `npm --workspace @ar-eye-hunter/shared-test run bb:matrix:live:preflight`

## First Experiments

### Oracle Always Free Worker

Start with one Ubuntu ARM VM, 2 OCPUs, 12 GB memory if capacity is available.
Install Node, Playwright dependencies, clone the repo, and run the worker under
systemd or Docker.

Example env shape:

```bash
RALLAR_BLACK_BOX_SPA_URL=https://blackbox.example.com
RALLAR_BLACK_BOX_CONTROL_URL=wss://blackbox-control.example.com/control
RALLAR_API_BASE_URL=https://api.example.com
RALLAR_BLACK_BOX_RUN_ID=oracle-free-run-001
RALLAR_BLACK_BOX_ROOM_ID=free-tier-room
RALLAR_BLACK_BOX_AGENT_PREFIX=oci-a1-free
RALLAR_BLACK_BOX_AGENT_COUNT=2
RALLAR_BLACK_BOX_USERNAME=agent-user
RALLAR_BLACK_BOX_PASSWORD=agent-password
RALLAR_AGENT_PROVIDER=oracle-cloud
RALLAR_AGENT_REGION=home-region
RALLAR_AGENT_DATACENTER=oci-home-region
RALLAR_AGENT_POOL_ID=free-persistent-a
RALLAR_AGENT_TAGS=free-tier,persistent,rtc
```

### GitHub Actions Burst Worker

Use one job with `RALLAR_BLACK_BOX_AGENT_COUNT=2` first. Matrix fan-out should
come later because one job with two browser contexts is cheaper and easier to
debug.

Useful guardrails:

- `timeout-minutes: 20`
- `RALLAR_BLACK_BOX_EXIT_MODE=after-first-terminal-distributed-run`
- Short-lived run/control tokens in Actions secrets.
- Upload distributed-run artifacts even on failure.

### Cloudflare Browser Run Probe

Do not port the whole worker first. Create a tiny Worker that:

1. Launches Cloudflare Playwright.
2. Opens the Rallar `/headless/` page with one agent.
3. Waits for control registration.
4. Runs `health`.
5. Closes the browser in `finally`.

Only after that passes should it attempt `ws.send`, then `rtc.connect`. The
free tier is small enough that failed browser closes and idle sessions can burn
the whole daily budget.

### Browserless Free Probe

Use standard Playwright from GitHub Actions or local Node and connect to the
Browserless endpoint. Keep the manifest under one minute and two concurrent
browsers. This is a good comparison point for Cloudflare Browser Run because it
keeps the driver in familiar Node code.

## Security Notes

- Prefer run tokens and restored sessions over embedding username/password in
  agent URLs.
- Keep `RALLAR_BLACK_BOX_CONTROL_TOKEN`, admin tokens, and operator secrets out
  of `VITE_*`.
- Enable `RALLAR_PRODUCTION_HARDENING=1` outside local testing.
- Set `RALLAR_BLACK_BOX_ALLOWED_ORIGINS`, command allow-lists, HTTP/WS
  destination allow-lists, and read tokens for public control servers.
- Treat free-tier agents as untrusted internet clients. They should get the
  minimum command set needed for the recipe profile.
- Add budget alerts wherever the provider supports them, even when the expected
  cost is zero.

## Open Questions

- Does Cloudflare Browser Run allow reliable WebRTC data-channel connectivity
  for the Rallar browser runtime, or does it need TURN for every cross-provider
  run?
- Is Playwright Chromium on OCI ARM stable enough for long repeated RTC runs,
  or should the persistent free pool use x86 despite smaller free capacity?
- Should the control server own recipe duration estimates, or should manifests
  declare them explicitly per recipe/profile?
- Should free-tier agents be allowed to auto-register accounts, or should all
  remote agents use pre-issued restored-session tokens?
- How much artifact data can be retained before GitHub Actions, Cloudflare, or
  Render-style free storage limits distort runs?

## Sources Checked

- Cloudflare Browser Run limits:
  https://developers.cloudflare.com/browser-run/limits/
- Cloudflare Browser Run pricing:
  https://developers.cloudflare.com/browser-run/pricing/
- Cloudflare Browser Run Playwright:
  https://developers.cloudflare.com/browser-run/playwright/
- Cloudflare Workers limits:
  https://developers.cloudflare.com/workers/platform/limits/
- GitHub Actions billing:
  https://docs.github.com/en/billing/concepts/product-billing/github-actions
- GitHub Actions limits:
  https://docs.github.com/en/actions/reference/limits
- Oracle Cloud Always Free resources:
  https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Google Cloud Run pricing:
  https://cloud.google.com/run/pricing
- Google Cloud Run WebSockets:
  https://cloud.google.com/run/docs/triggering/websockets
- Google Cloud Run request timeout:
  https://cloud.google.com/run/docs/configuring/request-timeout
- Azure Container Apps pricing:
  https://azure.microsoft.com/en-us/pricing/details/container-apps/
- AWS Lambda pricing:
  https://aws.amazon.com/lambda/pricing/
- AWS Lambda quotas:
  https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
- Browserless pricing:
  https://www.browserless.io/pricing
- Render free services:
  https://render.com/docs/free
- Fly.io pricing:
  https://fly.io/docs/about/pricing/
- Koyeb pricing:
  https://www.koyeb.com/pricing
