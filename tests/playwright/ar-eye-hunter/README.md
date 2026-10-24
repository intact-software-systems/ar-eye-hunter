# AR Eye room workflow tests

The CI room journey uses visible sign-in, New Arena, Quick Join, director appointment,
and match controls against the built SPA and a real local API. It checks unavailable,
HTTP failure and retry, admission, switching from an existing room despite a last-owner
cleanup denial, and the guest receiving the host's running match:

```sh
RALLAR_ARENA_FULL_STACK=1 npx playwright test --config apps/ar-eye-hunter-v1/playwright.config.ts tests/playwright/ar-eye-hunter/quick-join.spec.ts --project=desktop-delivery
```

Verify the actual deployed SPA and its configured API separately. Supply a provisioned
test account through `RALLAR_ARENA_TEST_USERNAME` and `RALLAR_ARENA_TEST_PASSWORD` in
the environment, then run:

```sh
RALLAR_ARENA_DEPLOYED_URL=https://ar-eye-hunter.pages.dev npx playwright test --config apps/ar-eye-hunter-v1/playwright.deployed.config.ts
```

This check signs in and clicks Quick Join. It may join an available public room; use
an account designated for this verification. It does not create an account or a room.
Missing credentials fail the run. Authentication requests are excluded from tracing.
The test requires an actual admission result and visible feedback, so a healthy
configuration endpoint or a green build cannot conceal a missing Quick Join route.
An unavailable result proves deployed admission reachability, not multiplayer play;
the local two-browser journey proves shared-match participation.
