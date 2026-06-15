# Rallar Companion Coverage

`black-box-runner` should stay a JSON recipe executor for observable HTTP, WS,
RTC, ASSERT, and SET behavior. Deeper Rallar facade behavior belongs in
companion tests where the real package or browser/app layer can be exercised
directly.

## Coverage Layers

| Layer | Covers | Does Not Cover |
| --- | --- | --- |
| `black-box-runner` | Public network observations, provider sends/waits, reports, artifacts. | Rallar facade methods such as `auth.login`, `rooms.join`, `data.open`, `messages.room`, or `realtime.room`. |
| `rallar-bb-test` | Portable browser/control commands, visible/remote browser bridging, event normalization, local wait/assert evidence checks. | A second implementation of the Rallar browser facade or the full black-box-runner assertion engine. |
| `shared-web-facade` | Direct browser facade behavior: auth, rooms, people, messages, realtime, RTC, data. | Generic recipe execution. |
| `shared-server-facade` | Direct server facade behavior and application data/topic routing. | Browser-only UI or media behavior. |
| `app-specific` | UI workflows, browser storage, media/device behavior, and app orchestration. | Shared runner semantics. |

The executable manifest lives in
`packages/shared-test/rallar-bb-test/companion-coverage.ts`.

## Guardrails

Do not add recipe commands for direct facade methods. These names are
intentionally listed as non-commands:

- `auth.login`, `auth.register`, `auth.registerAndLogin`, `auth.logout`
- `rooms.create`, `rooms.join`, `rooms.leave`, `rooms.refresh`
- `people.refresh`
- `messages.rtc.send`, `messages.ws.send`, `messages.channel`, `messages.room`
- `realtime.sendJson`, `realtime.room`, `rtc.waitForOpen`
- `data.open`, `calls.start`, `media.start`

Use the existing recipe vocabulary instead:

- HTTP calls for REST API behavior.
- WS open/send/close for WebSocket behavior.
- RTC connect/send/wait/close for provider-backed delivery.
- Browser-agent `wait` and `assert` commands for local runtime evidence checks.
- ASSERT and SET for recipe-local checks and value passing.

Provider adapters and browser bridges may call Rallar facade methods internally,
but recipes should assert only the externally observable result.

## Companion Test Command

From the repository root:

```bash
npm run test:shared-black-box:companion
```

This runs the boundary/manifest tests, `rallar-bb-test` runtime tests, provider
parity tests, and the core shared-web facade suites that cover direct facade
behavior.
