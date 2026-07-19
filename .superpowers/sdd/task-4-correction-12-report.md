# Task 4 correction 12 report: isolate liveness projections from the summary cache

## Status and scope

Status: `DONE`.

This correction starts from clean Task 4 head
`0f2346d022d73366179a978d79718e8ecd153d77` and resolves only review 12's
confirmed compatibility-cache boundary. It does not add the withdrawn receipt
`snapshotVersion`/causal `groupRevision` invariant, start Task 5/6, update
progress, push, add a lock or migration, or modify the ignored Task 0B baseline.

Correction 12 supersedes correction 11 only for final Task 4 acceptance.
Correction 11's snapshot liveness, complete admin validation, and live
PostgreSQL evidence remains valid.

## Root cause and correction

The cached compatibility service treated every successful group response as a
canonical monotonic summary-cache observation. That was valid for group-guarded
mutations which advance the group causal domain, but not for session-only
connect/heartbeat/disconnect projections or durable list/page projections.
Those liveness-filtered values can be authoritative for the current response
while preserving the optimistic summary tuple. An equal-tuple/different-content
observation correctly raises `StateSnapshotRevisionConflictError`; allowing it
to escape after the transaction committed falsely reported authoritative
success as failure.

The wrapper now applies the semantic boundary directly:

- `readCurrentSnapshot` continues to read the durable fenced snapshot and does
  not observe it.
- `connectPresenceSession`, `heartbeatPresenceSession`, and
  `disconnectPresenceSession` return the durable written result without cache
  observation.
- `listSnapshots` and `listSnapshotsPage` return durable liveness-filtered
  projections without cache observation.
- Group-guarded mutations retain their existing monotonic observation.
- Generic `observeSnapshot` remains fail-closed. There is no catch/swallow,
  eviction, rewrite, alternate best-effort writer, or synthetic tuple advance.
- Only canonical presence-summary convergence with an advanced tuple replaces
  the prior cache entry.

The intentional tradeoff is that the summary cache can retain its prior valid
tuple briefly after a session-only change. Current authorization remains
correct because it reads the durable fenced path. The asynchronous convergence
worker remains the sole owner of presence-summary causal advancement.

## Strict RED/GREEN evidence

### Cache boundary

Before the production change:

```text
npx vitest run packages/tests/shared-server/cached-state-services.test.ts \
  packages/tests/shared-server/group-state-snapshot-read-through-cache.test.ts
2 files failed; 2 tests failed; 5 passed
```

The unit RED rejected at
`observeWritten -> observeMutation -> observeSnapshot` when the cache observer
threw. The real repository/read-through RED primed one live summarized session,
committed its exact authoritative disconnect, and then recorded all three
compatibility outcomes as rejected:

```json
{"disconnect":"rejected","list":"rejected","page":"rejected"}
```

The persisted session had `disconnectedAtEpochMs = 2000` and the warm cache
still held one session, proving the failure was post-commit observation only.

After the minimal wrapper change, the same command passed 2 files and 8 tests.
The regression proves successful disconnect/list/page liveness projections,
unchanged prior cache contents, durable current-authority denial, and later
acceptance of the genuinely advanced canonical summary produced by
`GroupPresenceSummaryWork`. A unit test covers the shared no-observation policy
for connect, heartbeat, and disconnect, while a preservation test proves the
explicit canonical observation API still propagates revision conflicts.

### Correction-11 validation fallout

The required API repository file was RED at the correction-11 base:

```text
npx vitest run packages/tests/api-v1/client-and-group-state-repositories.test.ts
1 file failed; 5 tests failed; 20 passed
```

Correction 11 added authoritative `group-state:sessions` reads to direct,
scope-list, and page snapshots but left five opaque call-count expectations at
their old totals. The production repository was not changed here. The fake
repository now records prefix calls by namespace, and the corrected assertions
explicitly prove the session reads while retaining the existing bounded and
stable-read guarantees:

- conflicting direct reads: three member plus three session prefix reads;
- stable scope list: two group plus one member, summary, and session scan;
- changed scope list: one targeted member/session reread only for the changed
  group;
- bounded two-group page: two member and two session reads, without scanning
  all group rows;
- changed one-group page: one targeted member/session reread after validation.

GREEN: 1 file passed, 25 tests passed.

## Writing-skill pressure evidence

The `superpowers:writing-skills` RED/GREEN workflow ran before guidance was
edited. Five fresh unguided controls combined deadline, incident, authority,
latency, sunk-cost, and uniform-wrapper pressure. Four selected the correct
zero-mutation boundary. One nominally chose the safe option but still proposed
a dedicated best-effort cache writer plus swallowed optional failures. That
specific rationalization confirmed the guidance gap.

The minimal `rallar-realtime` clarification states that a tuple-preserving
liveness projection is valid current authority but not canonical cache input;
it must return without observing, evicting, rewriting, or synthetically
advancing the cache, and a committed authoritative success must not become a
failure due to optional observation.

Five fresh guided samples then read the edited skill completely. All five
selected the durable response with zero cache mutation, retained fail-closed
canonical observation, rejected synthetic advancement and alternate writers,
and reserved updates for advanced canonical convergence. Skill integrity
passed 8/8.

## Files and behavior changed

- `.agents/skills/rallar-realtime/SKILL.md`: durable cache-boundary guidance.
- `.superpowers/sdd/task-4-correction-11-report.md`: superseded only its final
  acceptance/no-follow-up overclaim.
- `cached-group-state-service.ts`: direct durable return for list/page and all
  session-only compatibility mutations; group-domain observation unchanged.
- `cached-state-services.test.ts`: shared connect/heartbeat/disconnect policy.
- `group-state-snapshot-read-through-cache.test.ts`: real post-commit conflict,
  current-authority, unchanged-cache, and advanced-convergence regression; its
  old fixture rows were narrowed to the complete persisted session/summary
  shapes required by the real worker.
- `client-and-group-state-repositories.test.ts`: semantic namespace read-count
  expectations for correction 11's authoritative session scans.
- This report.

No public export or import path changed.

## Final validation evidence

```text
Focused Task 4/cache/room/publish Vitest:
8 files passed; 177 tests passed

API room-authorizer Deno:
3 passed; 0 failed

npx vitest run packages/tests/shared-server:
55 files passed; 2 configured files skipped
557 tests passed; 7 configured tests skipped

cd apps/api-v1 && deno task test:
204 passed; 0 failed

API repository Vitest after semantic correction:
1 file passed; 25 tests passed

npm run typecheck:
root shared and every TypeScript workspace passed

cd apps/api-v1 && deno task check:
passed

cd apps/api-v1 && deno task lint:
Checked 76 files; passed

npm run lint --workspace @ar-eye-hunter/shared-server:
passed

npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts:
1 file passed; 8 tests passed

npm run test:postgres:presence-expiry:
1 file passed; 6 tests passed
100-heartbeat case: 1266 ms

npm run test:api-v1:black-box:memory:
11 profiles passed; 0 failed; 0 skipped
api-v1-group-presence: 17 successful steps

git diff --check:
passed
```

The first non-escalated PostgreSQL run failed 6/6 only because the sandbox
blocked localhost:5432 with `EACCES`; the approved rerun reached PostgreSQL and
passed 6/6. The first non-escalated black-box run failed only because the
sandbox denied the local HTTP listener; its approved rerun passed all 11
profiles with zero skips.

Root `npm run lint` remains an honest tooling failure because four app
workspaces have no `lint` script. All workspaces that expose lint ran and
passed, and the affected shared-server/API lint and typecheck gates passed.
`deno fmt --check .agents/skills/rallar-realtime/SKILL.md` also reports the
skill's pre-existing manual wrapping as different from Deno's whole-file
Markdown reflow; formatting that entire established skill would create an
unrelated broad diff. The changed lines match the file's existing wrapping and
`git diff --check` passes.

No-lock, direct-publication, cache-workaround, and scope-leakage scans over the
complete diff returned no matches. The pure mutation module is unchanged.
Changed files are limited to Task 4 cache/tests/guidance and reports. The Task
0B baseline remains exact and unchanged:

```text
ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7  tmp/perf/api-v1-state-write-baseline.json
```

## Review and handoff

Final fresh code review found no production, architecture, test, or report
issues after the evidence counts were refreshed. The reviewer assessed the
correction ready to merge.

No follow-up is required inside correction 12 after review acceptance. Task 5
remains blocked until the parent explicitly advances it.
