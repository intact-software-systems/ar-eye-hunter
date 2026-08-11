# Rallar Black-Box Observability-Routed Evidence Plan

Status: proposed; design for review — **plan only, no code**. W7 of
[the assertion-coverage plan](./rallar-black-box-assertion-coverage-and-canonicalization-plan.md).
Done when this plan is reviewed and either scheduled or explicitly deferred
with a recorded reason.

## Problem

The `state-write-evidence` gates prove distributed correctness by reading
Postgres directly and scraping server logs:

- `api-v1-state-write-evidence-sql.ts` scans `resource_inbox` joined with
  `resource_inbox_results` by **payload substring** (`position(match in
  ri_resource)`, plus a digest twin for redacted secrets), reads
  `APP_OUTBOX`/`WS_OUTBOX` rows the same way, probes for intermediate mutation
  intents by `ilike`, and — for the overdue-recovery fixture — **mutates**
  completion history (`delete` the result row, reschedule `next_ts`).
- `api-v1-state-write-receipt-evidence.ts` constructs real shared-server
  repositories over the test's own SQL connection to cross-check receipts
  against queued commands.
- `api-v1-fairness-proof.ts` scrapes `app-inbox-phase` timing JSONL from the
  managed server logs to prove the `FAIRNESS` dequeue lane ran, because
  `selectedLane` lives only in a process-local `WeakMap`
  (`ResourceInboxAttemptTelemetry`) and is never persisted.

This is valuable but gray-box: brittle to persistence refactors (column and
envelope names are load-bearing), unavailable outside managed runs (the PGlite
path spawns a Deno subprocess against a snapshot tarball), and it substitutes
internal state for the client-visible contract. The admin
`/api/admin/support/explain/*` endpoints are the precedent for exposing
internal facts safely over HTTP.

## What the recipes actually consume (migration surface)

Only these evidence fields are asserted across the five recipes
(`api-v1-admin-operations`, `api-v1-auth-session`, `api-v1-crdt-app-inbox`,
`api-v1-state-write-convergence`, `api-v1-state-medium-scale-churn`):

| Field | Recipes |
| --- | --- |
| `atomicCompletionFailures: 0` | all five |
| `intermediateMutationIntentCount: 0` | all five |
| `completedAppInboxStatus: "COMPLETED"` | admin-operations, crdt-app-inbox, medium-scale |
| `completedAppInboxCount` / `failedAppInboxCount` | auth-session (1/1 single-use race) |
| `overdueRecoveryFixture.recovered/notBeforeSatisfied/overdueAtClaim` | state-write-convergence |
| `resourceOutbox.0` shape (ids, `status: "COMPLETED"`, `effectKind`) | state-write-convergence |
| `naturalBoundedRetryObserved: true` | medium-scale |
| fairness lane `selectedLane: "FAIRNESS"` (artifact post-processing) | state-write-convergence via `fairness-proof.json` |

Everything else in the evidence DTO is diagnostic payload, not an assertion.
The endpoint contract below is scoped to exactly this surface.

## Proposed endpoint contract

One admin/debug read endpoint on api-v1, following the `explain/*` shape:

```
POST /api/admin/support/evidence/app-inbox
```

Request (all fields required unless marked; mirrors the recipe spec but
replaces the free-text payload scan with explicit identity):

```jsonc
{
  "selector": {
    // Exact command identities, not substrings. One of:
    "commandIds": ["cmd-..."],            // preferred
    "requestIds": [{ "aggregateRef": {...}, "requestId": "..." }],
    // Compatibility selector for the transition only (see Decision D2):
    "matchDigest": "sha256:..."           // digest of the old `match` string
  },
  "commandTypes": ["GROUP_MEMBERSHIP_PUT"],
  "expectedEffectsByCommandType": { "...": ["group-presence-summary"] },
  "sampleLimit": 25                        // clamped server-side to [0, 25]
}
```

Response (`AdminSupportEvidenceResponse`, same envelope family as
`AdminSupportNarrativeResponse`: `generatedAtEpochMs`, `serverId`, `warnings`):

```jsonc
{
  "generatedAtEpochMs": 0,
  "serverId": "server-1a2b3c4d",
  "warnings": [],
  "appInbox": {
    "matchedCount": 0,
    "completedCount": 0,
    "failedCount": 0,
    "completedStatus": "COMPLETED",       // or "MIXED"
    "atomicCompletionFailureCount": 0,
    "intermediateMutationIntentCount": 0,
    "naturalBoundedRetryObserved": false,
    "rows": [ /* redacted metadata rows, <= sampleLimit */ ]
  },
  "receipts": [ /* commandId, commandHash, outcome, outboxIds, identityKind */ ],
  "outbox": {
    "linkedCount": 0,
    "effects": [ /* resourceId, topicId, typeId, status, effectKind, commandId */ ]
  },
  "overdueRecovery": {                     // present only when the fixture ran
    "recovered": true,
    "notBeforeSatisfied": true,
    "overdueAtClaim": true,
    "selectedLane": "FAIRNESS"             // requires Decision D1
  }
}
```

Rows expose **metadata only** — `readPayloadMetadata`-style
(`byteLength`, `jsonKind`, `topLevelKeys`, `redacted: true`) — never
`ri_resource` bodies, matching the standing rules ("redacted payload metadata,
not raw payload"; "do not expose queue raw-payload opt-outs").

## Auth model

`AUTH_ADMIN_CLIENT_IDS` allow-list via `requireApiAdminSession`, exactly like
`explain/*`. **Not** the black-box operator token: that JWT targets the
control-server audience/scope and production hardening treats it as a
different concern. Consequence for recipes: `auth-session`,
`state-write-convergence`, and `state-medium-scale-churn` currently hold no
admin credentials and must add an admin login step during migration
(`AUTH_STATIC_CLIENTS_MODE=demo` already provides the `admin` demo client in
managed runs).

## Which facts are safe to expose

Safe (bounded, redacted, already precedented by `explain/queue-item`):

- inbox/result status pairs, attempt counts, timing columns, per-type counts;
- receipt identities (`commandId`, `commandHash`, `outboxIds`, outcome);
- outbox effect kinds and linkage counts;
- the negative-existence intent probe (a count, no payloads).

Unsafe or gated:

- **Raw payload bodies and free-text substring search.** The current `match`
  selector is a payload-substring oracle over every queued command — the test
  harness even hashes redacted secrets to keep finding them. The endpoint
  accepts exact identities (or a digest during transition), never free text.
- **The overdue-recovery fixture.** It is a destructive write (deletes a
  result row, rewinds `next_ts`). It must NOT become an HTTP capability.
  Decision D3 keeps it in the harness.
- **Fairness lane.** Not persisted anywhere today; exposing it requires D1.

## Decisions needed

- **D1 — persist attempt telemetry or keep log scraping.** `selectedLane`
  exists only process-locally. Options: (a) persist a bounded per-row attempt
  telemetry column/row on completion (schema change, AppInbox write-path
  touch); (b) a process-local `/evidence/attempt-telemetry` endpoint labeled
  `processLocal: true` like the WS facts (works only when the asserting recipe
  can target the claiming node — not guaranteed in a 3-node cluster); (c) keep
  the fairness proof on log scraping. Recommendation: (c) now, (a) as its own
  later plan — the fairness proof is coordinator-owned artifact analysis, not
  a recipe step, so it does not block converting the recipe-visible fields.
- **D2 — transition selector.** The five recipes select by `match` strings
  (e.g. `{applicationId}`, a raw single-use ticket). Receipts and commandIds
  are captured in outputs today only partially. Option: recipes capture
  `commandId`s from mutation responses (already returned in receipts) and pass
  `commandIds`; the digest selector exists only if some command cannot be
  identified that way, and is removed at the end of the migration.
- **D3 — fixture stays in the harness.** The overdue-recovery fixture keeps
  its direct SQL write (it is test-only tooling), which means the
  state-write-convergence recipe stays gray-box for that one step until a
  server-side test hook is designed separately, or the fixture is re-expressed
  as an ordinary retry scenario. Recording this keeps "black-box" honest
  rather than pretending the endpoint removed the dependency.

## Migration path

1. Land the endpoint (route + `AdminSupportService` extension + OpenAPI +
   `swagger-routes` + governance tests). `PSqlAdminSupportReader` grows two
   bounded reads: by-command-identity join, and per-type outbox linkage. New
   negative-existence intent count. No substring scan.
2. Recipes capture `commandId`s at their mutation steps; add admin login where
   missing.
3. Convert one recipe (`api-v1-crdt-app-inbox`, smallest, already
   admin-authenticated) from `set.state-write-evidence` to
   `http` + `expect`/ASSERT against the endpoint; keep the SQL evidence step in
   place for one release as a parity check (both must agree), then delete it.
4. Convert `api-v1-admin-operations`, `api-v1-auth-session` (digest selector
   if the consumed ticket cannot be re-identified), then the two convergence
   gates minus the fixture step (D3) and fairness proof (D1).
5. Retire `STRICT_STATE_WRITE_EVIDENCE_SOURCE`'s reservation of the
   `stateWriteEvidence` output name once no recipe uses the collector, and
   remove the PGlite snapshot subprocess path.
6. W8 re-tiers converted recipes from tier-2 (SQL evidence) toward tier-1
   (API black-box) as each conversion lands.

Guardrails throughout: `minimumMatchedRows: 600` and every asserted field of
the medium-scale gate survive unchanged; conversions are cutovers of the
evidence *source*, never of the asserted *values*; `npm run
test:repo-governance` and the full black-box gates on every step.

## Non-goals

- No latency SLOs, no new production benchmarks.
- No self-service (non-admin) evidence access; scoped tokens are a later
  concern, as in the debug-support plan.
- No replacement of the fairness-proof artifact lifecycle in this plan.
