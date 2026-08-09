# Client-State Workspace Key Injectivity Design

## Decision

Client-state persistence is disposable pre-production and test data. Correct the
repository format directly and reset affected development or test databases. Do
not add backfill commands, old/new read fallbacks, dual writes, inventory tools,
or legacy-row classification.

## Problem

Canonical client-state contracts require a nonempty `workspaceId`, but two
persistence boundaries still preserve an older missing-workspace sentinel:

- runtime-state keys use `workspaceId ?? '_'`;
- SQL client events use `workspaceId ?? '_'`.

That makes a missing workspace and the valid workspace ID `_` select the same
physical identity. Persisted client decoders can also fill an omitted
`workspaceId` from the requested slot, which hides the ambiguity instead of
failing closed.

## Design

One client-state persistence owner encodes workspace IDs for every physical
client-state identity. The encoding is:

| Workspace ID | Stored component |
| --- | --- |
| `_` | `%5F` |
| `%5F` | `%255F` |
| `a:b` | `a%3Ab` |
| `a%b` | `a%25b` |
| `a/b` | `a%2Fb` |
| `default` | `default` |

The encoder accepts only nonempty strings. There is no encoded representation
for an absent client workspace.

Runtime principal, instance, session, and idempotency keys use that component.
SQL client-event writers, readers, collision checks, and scoped admin counts use
the same component. Persisted principal, instance, session, and event decoders
require `workspaceId` to be present and validate it against the decoded or
requested physical slot.

Existing compatibility export paths may continue to re-export the canonical
functions because all consumers in this repository are updated together. They
do not preserve the old storage representation or missing-workspace behavior.

## Failure Behavior

- Missing, empty, malformed, or noncanonical workspace identities fail closed.
- A noncanonical percent alias is rejected rather than normalized.
- A stored value whose workspace differs from its physical slot remains typed
  invariant corruption.
- Destination collision resolution and persisted-data repair are out of scope;
  affected disposable databases are reset.

## Verification

Tests prove:

- exact workspace encodings and round trips;
- pairwise non-collision for principal, instance, session, and idempotency keys;
- prefix/list isolation across lookalike workspace IDs;
- omission rejection at key and persisted-value boundaries;
- SQL event isolation and header-column/value agreement in PGlite;
- scoped admin event counts use the canonical encoding;
- live PostgreSQL runtime-state prefix isolation;
- unchanged client mutation behavior through the three-process medium-scale
  profile and final repository gates.

## Repository Scope

This is one implementation PR. It changes current source, tests, active client
persistence documentation, and the REST convergence plan's deferred-work record.
It creates no database schema migration and no reusable migration framework.
