# Rallar Black Box Browser-Agent Auth Recovery Design

## Goal

Make the Recipe Console's **Open 3 browser agents** flow recover correctly when
Chrome has a locally stored operator session that the Rallar API rejects. The
operator must be returned to the existing login screen instead of being left in
a false "Session active" state where every launch attempt fails.

## Confirmed Failure

The supplied production route was reproduced in Chrome. The Recipe Console
displayed `Session active` for `bob`, enabled **Open 3 browser agents**, and then
reported:

```text
API POST /api/auth/agent-session-tickets failed: 401
{"error":"Unauthorized: Invalid or expired access token"}
```

No browser-agent tab reached its launch URL. The temporary `about:blank` popup
reservations were closed by the existing cleanup path.

The parent application trusts any `AuthSession` returned by browser storage.
Storage validation can reject a session whose client-side expiry is past, but it
cannot know that the server has revoked or otherwise invalidated a future-dated
token. The browser-agent launch service then calls
`issueAgentSessionTicketsAt(...)` directly. Unlike normal Rallar facade
operations, that low-level request does not feed HTTP 401 back into the app's
auth lifecycle, so the rejected session remains rendered as active.

## Considered Approaches

### 1. Invalidate the app session when ticket issuance returns 401

This is the selected approach. The browser-agent launch service reports an
authentication-invalid event to the app when the protected ticket endpoint
returns HTTP 401. The app clears the rejected stored session and its React auth
state, which activates the existing login gate. The existing popup-release path
continues to close any reserved blank tabs.

This is narrow, preserves the current launch API and popup design, and recovers
both expired and server-revoked tokens without adding a new network request to
every page load.

### 2. Keep the stale session and only improve the inline error

This would explain the failure but leave the operator trapped in a state that
cannot succeed until they manually log out. It does not fix the false active
session and is rejected.

### 3. Validate every restored session during application startup

This would require a suitable protected validation endpoint and add startup
latency. It would still need runtime 401 handling for sessions invalidated after
startup. It is broader than the observed failure and is rejected.

## Design

### Browser-agent launch boundary

`createBrowserAgentLaunchService(...)` gains an optional authentication-invalid
callback. Ticket issuance is wrapped so that:

- an `ApiHttpError` with status `401` invokes the callback once and then
  rethrows the original error;
- aborts, network failures, malformed successful responses, control-token
  failures, and non-401 API responses do not invalidate the operator session;
- HTTP 403 does not clear the session because it may represent a valid principal
  that lacks permission rather than an invalid token.

The callback remains optional so simulated launches, legacy consumers, and
existing unit fixtures keep their current behavior.

### App auth ownership

The callback is passed through `RecipeConsoleApp` and
`ControlConnectionProvider` to the launch service. `App` remains the owner of
the authoritative React auth state and browser auth storage. On an invalid
session notification it will:

1. clear the rejected browser-stored session;
2. clear the in-memory `authSession` state;
3. stop any auth-busy state;
4. allow the existing `requiresLogin && !authSession` branch to render
   `LoginScreen`.

The handler is idempotent. Repeated notifications after the first clear have no
additional effect. It does not send a logout request with a token the server has
already rejected.

### Popup lifecycle

The existing launch hook continues to reserve popup windows synchronously from
the human click. When ticket preparation fails, its existing error path releases
and closes every reserved blank popup. Auth invalidation changes the parent view
to the login screen; it does not leave blank tabs or treat any agent as launched.

After the operator signs in again, the existing launch service is rebuilt with
the fresh session. A new **Open 3 browser agents** click mints three ticket/token
pairs and navigates the three reserved tabs as before.

## Error Presentation

The immediate 401 causes a transition to the existing login screen, which is
the actionable recovery surface. The raw rejected-token response is not kept as
the primary Recipe Console state because that console is unmounted once auth is
invalidated. Non-401 failures keep the current inline launch-status behavior.

## Compatibility and Scope

- No public package export changes are required.
- Simulated-provider launch behavior is unchanged.
- Valid browser-Rallar sessions use the same ticket, control-token, and popup
  flow.
- Control-server authorization and token brokerage are unchanged.
- This change does not add token refresh, automatic credential replay, popup
  permission workarounds, or a new authentication endpoint.

## Test Strategy

1. Add a focused service test that injects a ticket issuer throwing
   `ApiHttpError(401)`, proves the invalidation callback runs exactly once, and
   proves the original error is preserved.
2. Add a neighboring negative test proving a non-401 ticket failure does not
   invalidate the session.
3. Add a visible-control Playwright regression that starts the Recipe Console
   with a future-dated stored session, makes the agent-ticket endpoint return
   401, clicks **Open 3 browser agents**, and verifies the existing login screen
   appears and no reserved child pages remain.
4. Keep the existing successful three-agent Playwright flow as proof that valid
   launch behavior is preserved.
5. Run the focused Rallar black-box Vitest file, the focused Recipe Console
   Playwright spec, the app type-check/build selected by `rallar-testing`, and
   relevant broader tests if the touched boundaries require them.

## Acceptance Criteria

- The reproduced stale-session launch cannot remain in a false active-session
  state after the API returns 401.
- All reserved blank popups are cleaned up on the failed attempt.
- The operator sees the existing login screen and can authenticate again.
- A valid session still opens and registers exactly three browser agents.
- Automated tests cover both invalidation and non-invalidation cases.
