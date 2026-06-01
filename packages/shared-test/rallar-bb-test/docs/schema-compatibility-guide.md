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
