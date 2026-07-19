# Task 4 correction 15 report: bind production retry evidence

## Status and scope

Status: implementation, validation, and fresh correction-level review complete.

This correction starts at clean correction-14 head
`270548e0a6dfc5546adc32bb6e1237e0acfb52f9`. It closes the two correction-15
review findings without changing artifact schema v3, workload shape or scale,
candidate gates, the immutable Task 0B baseline, public service signatures, or
production persistence architecture.

Correction 15 supersedes correction 14 only for final Task 4 acceptance.

## Exact RED evidence

The comparator regression was run before its implementation. The selected test
failed with five soft assertion failures: orphan, accepted-prerequisite,
different-client, synthetic-chain, and reordered-command artifacts all returned
`[]` instead of the required causal-evidence errors.

The first fresh review then reproduced a deeper stable-identity spoof: swapping
the IDs and exact production histories of two exhausted membership commands in
different canonical client slots still returned `[]`. A new assertion witnessed
that RED before raw-slot binding was added; the selected comparator test then
passed GREEN.

The trusted-slot regression was also run against the old read path. A corrupt
session candidate with `principalId: candidate-principal` caused the admission
read to use the candidate slot and omitted the authenticated `alice` admission
slot. The mutation failed closed later, but the read itself had already trusted
candidate row data.

The durable skill assertion was added before guidance. The integrity suite
failed 1/8 because the performance skill did not yet state that labels alone
cannot prove causal non-invocation.

## Implementation

### Causal prerequisite evidence

`scripts/perf/compare-api-v1-state-write-results.mjs` now parses the producer's
stable command identity as the exact command prefix plus numeric client ordinal.
Every raw record must preserve canonical mutation/client slot order, its encoded
ordinal must equal that raw client slot, and all commands must share one sample
prefix. This prevents moved or swapped IDs/histories from redefining identity.
An allowed synthetic terminal must resolve to the raw same-client predecessor:

- `presence-connect`, `presence-heartbeat`, and `presence-disconnect` may depend
  on that client's `membership` command;
- `presence-heartbeat` and `presence-disconnect` may depend on that client's
  `presence-connect` command.

The predecessor must occur earlier in the raw sample, have raw status
`exhausted`, and end in a real `group-state-service.mutation.conflict` history:
one or more nonterminal production conflicts followed by the terminal production
exhaustion. A synthetic prerequisite chain, a label-only spoof, an accepted or
different-client predecessor, and a raw-order spoof are rejected.

Tests cover orphan, different-client, accepted predecessor, synthetic chain,
ordering spoof, and both valid same-client causal pairs. Two older permissive
fixtures were upgraded to establish the same-client production exhaustion they
claim rather than weakening the new validator.

### Trusted group read slot

`readGroupMutation` now derives heartbeat/disconnect target identity only from
`command.input.principalId ?? command.input.actorPrincipalId`. It never uses the
candidate presence row to choose member or admission keys. Connect continues to
use its mandatory command principal, explicit-target commands retain their
target, and expiry/socket-cleanup maintenance retains its explicit input
principal with a null actor.

The repository-spy regression corrupts the stored session principal and proves
both heartbeat and disconnect read the authenticated actor's member/admission
slots, never the corrupt candidate principal's slots, and then fail closed on
the canonical principal mismatch.

### Durable guidance

The performance-analysis skill now records the generic rule that synthetic
prerequisite/non-invocation evidence must link to an earlier same-subject
predecessor with real production exhaustion; labels alone are not causal proof.
The repo integrity test pins that guidance.

## Validation evidence

Fresh final results before review:

```text
Focused comparator/group regressions: 2 files, 113 tests passed
Full performance artifact contract after review fix: 42 passed
Combined full shared-server and skill-integrity Vitest: 57 files passed,
  2 configured skipped; 588 tests passed, 7 configured skipped
Root/workspace npm run typecheck: passed
Shared-server lint/typecheck: passed
Native Deno producer check: passed
API-v1 deno task test: 206 passed, 0 failed
API-v1 deno task check: passed
API-v1 deno task lint: passed, 76 files checked
PGlite adapter: 18 passed, 0 failed
Live PostgreSQL presence/concurrency: 6 passed, 0 failed
Memory API-v1 black-box matrix: 11 passed, 0 failed, 0 skipped;
  group-presence 17 successful steps
git diff --check: passed
```

The unchanged-scale native producer completed with
`--backend=postgres --warmup=1 --runs=3 --concurrency=10`; the ignored artifact
is `tmp/perf/api-v1-state-write-correction-15.json`. Imported standalone
validation returned `[]`.

```text
uncontended: accepted 2100, conflicted 0, exhausted 0
shared: accepted 1915, conflicted 403, exhausted 185
hot: accepted 1128, conflicted 961, exhausted 972
all workloads: dbwFindings exactly [DBW-06, DBW-12]
```

The shared/hot synthetic prerequisite terminals in this artifact resolve to
earlier same-client raw commands whose exact production histories end in real
conflict exhaustion. The artifact remains a Task 4 diagnostic, not a Task 10
candidate pass.

The immutable Task 0B baseline SHA-256 remains exact:

```text
ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7
```

Architecture inspection found no added database/advisory locks, direct state
publication, scope/key leakage, benchmark-only evidence source, schema change,
or candidate-gate waiver.

## Fresh correction-level review

A fresh read-only correction-level reviewer inspected the complete working tree
from `270548e0a6dfc5546adc32bb6e1237e0acfb52f9`, including ignored reports and
artifacts. Its initial adversarial probe found the Important cross-client
ID/history swap described above. After the RED→GREEN raw-slot/common-prefix fix,
the reviewer re-ran the probe, confirmed both real artifacts validate `[]`,
confirmed the baseline hash, found no remaining Critical, Important, or Minor
issues, and returned:

```text
PASS
APPROVED
YES
```
