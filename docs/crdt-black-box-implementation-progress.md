# CRDT Black Box Implementation Progress

Date: 2026-06-05

Source plan:

- `plans/rallar-crdt-black-box-apps-support-plan.md`

## Milestone Checklist

- [x] Read relevant docs, package scripts, repository structure, tests, and
  current Black Box/control-server architecture before coding.
- [x] Improve CRDT Health operator tooling in `apps/rallar-black-box`.
- [x] Surface CRDT recipes and `live-crdt` profile support in the app.
- [x] Improve CRDT command authoring and result diagnostics.
- [x] Add CRDT capability-aware distributed targeting.
- [x] Keep the control server provider-neutral while improving CRDT artifact
  labeling and diagnostics preservation.
- [x] Add or update focused tests for each meaningful change.
- [x] Run relevant build, typecheck, and test commands.
- [x] Record verified results, blocked items, and remaining limitations.

## Work Completed

- Created this implementation progress document and tied it to the app support
  plan.
- Added optional CRDT runtime capability metadata to control-agent identity:
  `capabilities.crdt.supported`, reported transports, runtime surface, and API
  base readiness.
- Preserved CRDT capability metadata through control protocol parsing,
  register/heartbeat identity snapshots, control-server snapshots, and OpenAPI.
- Added distributed target filtering for selected CRDT recipes. Agents that
  match the group but do not report CRDT runtime/transport support now show
  `missing-crdt-runtime` or `missing-crdt-transport`.
- Added CRDT preflight warning/badge output for recipes containing `crdt.*`
  commands.
- Added visible CRDT capability details to distributed target rows.
- Improved control-server artifacts so CRDT command results use transport
  `CRDT`, CRDT handles are used as the result connection where available, and
  CRDT diagnostics are exported as `crdt-diagnostic` instead of generic
  `rtc-diagnostic`.
- Added CRDT command presets for Run Manager: local CRDT open, clean-health
  wait, and CRDT health.
- Added CRDT Health selected-document metadata and copyable admin HTTP recipes
  for integrity, debug export, backup export, compact, rebuild, archive,
  quarantine, and destroy workflows.
- Added CRDT badges for shared-test recipe catalog rows and surfaced the
  `live-crdt` profile on matching catalog entries.
- Extended Flow Builder runner export passthrough so `crdt.*` commands are
  valid exported command steps.

## Verification Log

- `npx vitest run packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts`
  - Passed: 2 files, 24 tests.
- `cd apps/rallar-black-box-control-server && deno test test/swagger-routes.test.ts`
  - Passed: 5 tests.
- `cd apps/rallar-black-box-control-server && deno test test/control-artifacts.test.ts`
  - Passed: 2 tests after correcting the CRDT fixture to use the typed result
    shape.
- `cd apps/rallar-black-box-control-server && deno task check`
  - Passed for `src/main.ts`, control-service tests, swagger-route tests, and
    control-artifact tests.
- `npm run test:rallar:control`
  - Passed: 25 Deno tests.
- `npx vitest run packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/flow-builder.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts`
  - Passed: 6 files, 46 tests.
- `npm run build:rallar`
  - Passed. Vite emitted the existing large chunk warning.
- `npm run check:rallar:control`
  - Passed.
- `git diff --check`
  - Passed.

## Remaining Limitations

- CRDT support in these apps remains operator/testing support, not a product
  collaborative editor.
- Control-server CRDT handling remains provider-neutral by design; it does not
  parse, merge, compact, apply, or administer CRDT documents.
- Capability metadata is advisory and backward compatible. Older agents that do
  not report CRDT support are blocked for selected CRDT recipes but remain valid
  for non-CRDT recipes.
- Live CRDT behavior still depends on the existing gated shared-test recipes and
  real environment gates for API, credentials, WS, RTC, durable catch-up, and
  admin authorization.
- No dedicated graphical CRDT operation builder was added; command authoring
  continues to use schema examples, presets, and recipe JSON.
