# Rallar Black Box Example Recipes

These recipes are meant for the SPA `Local Workbench` while running with `provider=browser-rallar`.

1. Log in to the Rallar Server from the SPA.
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
