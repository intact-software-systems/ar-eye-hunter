# Rallar Black-box Test Schema Compatibility Guide

This guide is for AI prompt authors, external tools, and SPA surfaces that
generate or validate `rallar-bb-test` browser-agent recipes.

## Current Contract

The current recipe schema version is `1`.

New recipes should include:

- `schemaVersion: 1`
- stable `recipeId` values
- stable `commandId` values for commands that should be easy to trace in
  reports, control-server events, and artifacts
- only fields accepted by `RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA`

Existing recipes without `schemaVersion` are still treated as legacy-compatible
v1 recipes. `validateRallarBlackBoxRecipeCompatibility(...)` returns a warning
for those recipes so tools can nudge authors toward explicit versioning without
breaking old fixtures.

Unsupported explicit recipe versions fail schema validation. Distributed run
manifests also use `schemaVersion: 1` and should include explicit v1 inline
recipes.

## Minimal Recipe Example

```json
{
  "schemaVersion": 1,
  "recipeId": "compat-health-v1",
  "commands": [
    {
      "kind": "health",
      "commandId": "health-v1"
    }
  ]
}
```

## Distributed Inline Recipe Example

```json
{
  "schemaVersion": 1,
  "distributedRunId": "compat-distributed-health-v1",
  "displayName": "Compatibility health smoke",
  "group": {
    "applicationId": "rallar-server",
    "workspaceId": "default",
    "groupId": "bb-group"
  },
  "recipes": [
    {
      "recipeId": "health-all-agents-v1",
      "role": "all-agents",
      "required": true,
      "recipe": {
        "schemaVersion": 1,
        "recipeId": "health-all-agents-v1",
        "commands": [
          {
            "kind": "health",
            "commandId": "distributed-health-v1"
          }
        ]
      }
    }
  ],
  "targetPolicy": {
    "mode": "all-online-group-members",
    "expectedParticipantCount": 1
  },
  "ackTimeoutMs": 5000,
  "startMode": "manual"
}
```

## Validation Flow

Use the lightweight schema validator before staging or executing generated
JSON:

- Recipes: `validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, value)`
- Recipe compatibility: `validateRallarBlackBoxRecipeCompatibility(value)`
- Distributed manifests:
  `validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, value)`
- Distributed manifest semantics:
  `validateDistributedRunManifestContract(value)`

Treat compatibility warnings as authoring feedback. Treat validation errors as
blocking failures.

## Golden Corpus

The stable v1 corpus lives at:

`packages/shared-test/rallar-bb-test/fixtures/schema/v1/golden-compatibility-corpus.json`

It contains valid and invalid examples for primitive commands, nested
`loop`/`parallel`, `wait`/`assert`, distributed manifests with inline recipes,
and representative AI-generated recipes. Schema changes should update this
corpus deliberately, not incidentally.

Run the focused compatibility checks with:

```text
npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts
```

## External Tool Rules

- Emit `schemaVersion: 1` for every new recipe and distributed manifest.
- Do not emit unknown top-level recipe fields.
- Put non-contract authoring hints under `metadata` when the schema allows it.
- Keep command IDs stable across repair prompts unless a command is split or
  removed.
- Prefer `room.*` or `app.*` test topics for live WS traffic. Avoid `rallar.*`
  because it is reserved for system traffic.
- Validate generated JSON before handing it to the SPA, control server, or
  browser agents.

## Upgrade Note Template

Use this template whenever the recipe or distributed manifest contract changes.

```text
Title:
Date:
Owner:

Change type:
- Compatible optional addition
- Compatible documentation clarification
- Breaking schema change
- Runtime semantic change

Affected schemas:
- RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA
- RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA
- Other:

Old shape:

New shape:

Migration:

Golden corpus updates:

Prompt/documentation updates:

Verification:
```

## Upgrade Notes

```text
Title: rtc.send.expect fails closed on the control-protocol path
Date: 2026-08-11
Owner: rallar-bb-test distributed assertion parity plan, workstream D0

Change type:
- Breaking schema change (removal of a silently ignored optional field)

Affected schemas:
- RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA
- RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA (rtc.send branch)
- validateRallarBlackBoxTestCommand rtc.send allowlist

Old shape:
rtc.send accepted an optional `expect` field. No agent runtime ever read it,
so a control-dispatched recipe carrying it validated green while asserting
nothing.

New shape:
rtc.send rejects `expect` at schema validation and control-protocol
validateKeys ("rtc.send has unsupported field: expect."). The TypeScript
field remains for the in-process black-box-runner adapter, which bypasses
network validation and records runner-side expectations.

Migration:
Remove `expect` from distributed rtc.send commands; move authoring hints
into `metadata`. Delivery expectations belong in `wait`/`assert` commands.

Golden corpus updates:
Added invalid recipe case `rtc-send-expect-rejected`.

Prompt/documentation updates:
rtc.send capability metadata no longer lists `expect`; capability
description no longer mentions recorded expectations.

Verification:
npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts
npx vitest run packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts
npx vitest run packages/tests/shared-test/rallar-bb-test-rtc-send-expect-fail-closed.test.ts
```

```text
Title: wait gains an optional absent: true absence mode
Date: 2026-08-11
Owner: rallar-bb-test distributed assertion parity plan, workstream D1

Change type:
- Compatible optional addition (with a fail-closed rollout edge)

Affected schemas:
- RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA
- RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA (wait branch)
- validateRallarBlackBoxTestCommand wait allowlist

Old shape:
wait matched only positively: it succeeded when an event matched and timed
out otherwise. Non-delivery could not be asserted.

New shape:
wait accepts optional absent: true. The agent holds the full wait window,
then scans the whole event buffer once; any match (buffered or new) fails
with RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED carrying the offending redacted
event, an empty scan succeeds with matched: false, absent: true. Only the
literal true is accepted. Semantics mirror the runner's expect.absent.

Migration:
No change for existing recipes. Recipes using absent: true dispatched to
agents built before this change fail closed at validateKeys with
"wait has unsupported field: absent." — intended behavior. World-fleet
manifests must not adopt absence waits until the D4 capability gate exists.

Golden corpus updates:
golden-composite-wait-assert-v1 gained an absent wait command
(golden-wait-absent-v1).

Prompt/documentation updates:
New "Prompt: Distributed Absence Wait" section; wait capability metadata
lists absent; schema-and-capabilities.md documents the hold-then-scan
semantics; composite-conformance matrix gained wait-absence-hold and
wait-absence-violated cases.

Verification:
npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts
npx vitest run packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts
npx vitest run packages/tests/shared-test/rallar-bb-test-wait-absence.test.ts
npx vitest run packages/tests/shared-test/rallar-bb-test-composite-conformance.test.ts
```

```text
Title: assert gains gt, lt, between, length, matches, and JSON shape operators
Date: 2026-08-11
Owner: rallar-bb-test distributed assertion parity plan, workstream D2

Change type:
- Compatible optional addition (widened operator enum, fail-closed on old agents)

Affected schemas:
- RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA
- RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA (assert operator enum)
- validateRallarBlackBoxTestCommand assert operator list

Old shape:
assert supported equals, notEquals, contains, exists, gte, lte with
JSON.stringify equality as the only comparison primitive.

New shape:
The operator enum adds gt, lt, between ([low, high] inclusive), length
(arrays/strings), matches (regular-expression source), matchesShape
(json-compare compatible), and matchesShapeComplete (compatible-complete;
arrays must be complete, so unexpected array elements fail). New numeric
operators follow runner-comparator parity and coerce with Number(). The
historical six operators keep their exact semantics and quirks.

Migration:
No change for existing recipes. Recipes using the new operators dispatched to
agents built before this change fail closed at operator validation —
intended. World-fleet manifests must not adopt the new operators before the
D4 capability gate.

Golden corpus updates:
golden-composite-wait-assert-v1 gained gt, between, matches, matchesShape,
and length examples; new invalid case assert-operator-unknown.

Prompt/documentation updates:
New "Prompt: Extended Assert Operators" section; assert capability
description updated; schema-and-capabilities.md documents operator
semantics; composite-conformance matrix gained assert-shape-complete-violated.

Verification:
npx vitest run packages/tests/shared-test/rallar-bb-test-assert-operators.test.ts
npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts
npx vitest run packages/tests/shared-test/rallar-bb-test-composite-conformance.test.ts
```
