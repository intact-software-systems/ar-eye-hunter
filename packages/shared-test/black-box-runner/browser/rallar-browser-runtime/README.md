# Black-box browser runtime

[`black-box-rallar-runtime.ts`](./black-box-rallar-runtime.ts) installs the browser command runtime
and owns connection setup, command entry, and cleanup.
[`browser-rallar-runtime-composition.ts`](./browser-rallar-runtime-composition.ts) constructs its
private browser dependencies; browser middleware stays inside that composition.

- Authentication and connection preparation enter through
  [`black-box-rallar-authentication.ts`](./black-box-rallar-authentication.ts) and
  [`black-box-rallar-connection-state.ts`](./black-box-rallar-connection-state.ts).
- Message operations and delivery observations belong to
  [`messaging-controller.ts`](./messaging-controller.ts).
- CRDT, director, and formation commands belong to their respective controllers:
  [`black-box-rallar-crdt-controller.ts`](./black-box-rallar-crdt-controller.ts),
  [`director-controller.ts`](./director-controller.ts), and
  [`formation-controller.ts`](./formation/formation-controller.ts).
- Health enters [`black-box-rallar-health-reader.ts`](./black-box-rallar-health-reader.ts).
  When RTC diagnostics are requested, [`read-black-box-rtc-causal-state.ts`](./read-black-box-rtc-causal-state.ts)
  projects existing middleware read ports into session identity, current manager peer sets and
  counters, and attempts for desired or known peers. Missing middleware produces no projection.
- Existing WS/RTC lifecycle subscriptions and ALM diagnostic relays in the runtime publish through
  [`black-box-rallar-diagnostics.ts`](./black-box-rallar-diagnostics.ts). Errors cross
  [`black-box-rallar-serialized-error.ts`](./black-box-rallar-serialized-error.ts).
  The Playwright control client owns optional failure sidecars and their bounded allowlist; the
  browser runtime adds no subscriptions or event retention for those sidecars.

The command and result vocabulary lives in
[`black-box-rallar-operation-contracts.ts`](./black-box-rallar-operation-contracts.ts), with the
callable runtime surface in [`black-box-rallar-runtime-contract.ts`](./black-box-rallar-runtime-contract.ts).
Browser-runtime behavior is exercised by `packages/tests/rallar-black-box/browser-rallar-runtime.test.ts`;
readiness sidecars by `packages/tests/rallar-black-box/live-rtc-control-client.test.ts`.
