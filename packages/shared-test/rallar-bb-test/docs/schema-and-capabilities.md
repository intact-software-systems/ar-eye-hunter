# Rallar Black-box Test Schemas And Capabilities

`packages/shared-test/rallar-bb-test/schema.ts` is the machine-readable contract
for browser-agent commands and recipes. It sits beside `types.ts`:

- `types.ts` defines the TypeScript runtime contract.
- `schema.ts` defines command capability metadata and JSON Schema objects for
  UI validation, control-server documentation, runner handoff, and future
  distributed-run manifests.

## Schema Catalog

The exported catalog is `RALLAR_BLACK_BOX_SCHEMA_CATALOG`.

It currently contains:

- `RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA`
- `RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA`
- `RALLAR_BLACK_BOX_CONTROL_COMMAND_ENVELOPE_SCHEMA`
- `RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA`

`packages/shared-test/black-box-runner/schema.ts` owns the separate
`BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA`. That schema describes runner
scenarios with `variables`, `connections`, and `steps`. It intentionally stays
provider-neutral and does not mirror Rallar facade internals.

The distributed-run manifest and lifecycle contract are documented in
`packages/shared-test/rallar-bb-test/docs/distributed-run-contract.md`.

Prompting guidance for using these schemas with AI recipe generation is in
`packages/shared-test/rallar-bb-test/docs/ai-recipe-prompt-guide.md`.

## Capability Metadata

`RALLAR_BLACK_BOX_COMMAND_CAPABILITIES` has one entry for every
`RALLAR_BLACK_BOX_TEST_COMMAND_KINDS` value:

- command kind and human title
- required and optional fields
- supported provider modes
- supported runtime surfaces
- live-service requirements
- expected artifacts/evidence
- a validating example command

The capabilities are the source for UI help, catalog filtering, and future
distributed recipe preflight checks.

## Validation

Use `validateJsonSchema(schema, value)` for lightweight browser-safe validation.
Use `formatJsonSchemaValidationErrors(errors)` for operator-facing errors.

Current automated coverage validates:

- every capability example
- app-local SPA recipe examples
- local recipe fixtures
- Manual Rallar recipe snippets
- Flow Builder SPA recipe exports
- Flow Builder black-box-runner scenario exports
- Run Manager command presets
- every shared-test black-box-runner example recipe
- control-server OpenAPI command examples
- control command envelopes
- distributed-run manifest examples
- distributed-run lifecycle states, domain validation, and rollup behavior
- group-member to control-agent matching and target-policy filtering

## Compatibility Rules

Treat schema changes as public command-center contract changes.

- Adding optional fields to an existing command is compatible.
- Tightening a field type is a breaking change unless all shipped recipes and
  examples already satisfy it.
- Adding a new command kind requires:
  - a TypeScript command type in `types.ts`
  - capability metadata
  - a command schema branch
  - at least one validating example
  - command-center and runtime tests
- Removing or renaming a command kind is breaking and should require an
  explicit migration note.
- Runner scenario schema changes should preserve the generic HTTP/WS/RTC/ASSERT
  boundary. Do not add Rallar-specific facade operations to the runner core.

## Ownership

`rallar-bb-test` owns browser-agent command and recipe schemas.

`black-box-runner` owns scenario schemas for external runner recipes.

`apps/rallar-black-box` should consume these schemas for JSON editors,
preflight validation, catalog badges, and distributed-run authoring. The SPA
should not keep separate command-shape validators except for UI-specific checks.

`apps/rallar-black-box-control-server` should expose the shared command schema
in OpenAPI and validate inbound command payloads before queueing.
