# Rallar Black Box Example Recipes

These recipes are meant for the SPA `Local Workbench` while running with `provider=browser-rallar`.

For the full command-center examples index, including shared-test runner recipes and artifact bundles, see
`apps/rallar-black-box/docs/examples-index.md`.
The SPA `Shared Test` tab also lists these app-local recipes next to selected shared-test runner entries.

1. Log in to the Rallar Server from the SPA login gate or `Auth` tab.
2. Load `rallar-server-group-ws-setup.recipe.json` and run it.
3. Load `rallar-server-rtc-connect-send.recipe.json` and run it.

The recipes use runtime placeholders resolved from the logged-in browser session:

- `{auth.clientId}`
- `{auth.username}`
- `{auth.sessionId}`
- `{auth.wsTicket}`
- `{config.apiBaseUrl}`
- `{config.wsBaseUrl}`

`{auth.wsTicket}` is special: when a `ws.open` URL contains it, the browser adapter first calls
`POST /api/auth/ws-ticket` with the current auth session and then opens `/api/ws/{auth.sessionId}` with the returned
ticket.

The REST create-group command is safe to run when `bb-group` already exists. The HTTP command records the server status
and body in the result; a `409` response does not stop the recipe by itself.

The broader shared-test runner catalog lives under `packages/shared-test/black-box-runner/examples/` and is indexed by
`packages/shared-test/black-box-runner/recipe-matrix.json`. Those recipes cover REST/WS/RTC examples, deterministic
memory-provider delivery, same-connection soak, seeded traffic replay, bounded parallel groups, and gated live
browser/remote-browser variants. The command-center Playwright suite also has a gated live three-browser RTC matrix via
`npm run test:e2e:rallar-black-box:full-stack:real:live-rtc-3`.
