# Hetzner Per-Run Group Isolation

Status: Implementation and review findings addressed on
`codex/hetzner-per-run-group-isolation`. Final repository and publication
gates remain required for the exact feature commit.

## Goal

Make every spawned Hetzner recipe independent from database state left by
earlier runs without resetting the database. Materialize one deterministic,
unique group scope per workflow run attempt, bind workers and every executable
manifest reference to that scope, retain completed groups for normal expiry,
and expose the source and effective scopes in human-readable diagnostics.

## Implementation

- [x] Materialize a run-specific manifest without modifying the checked-in
      source manifest.
- [x] Isolate blank-room Hetzner runs; preserve explicit room overrides and
      preserve manifest groups for external-agent runs.
- [x] Validate every executable manifest identity before worker startup and
      reject a mismatch rather than partially rewriting it remotely.
- [x] Use the same materialized manifest as the worker and distributed-run
      scope authority.
- [x] Nest RTC command completion timeouts five seconds outside their readiness
      timeout and regenerate checked-in manifests.
- [x] Extend operation diagnostics to schema v2 with source/effective groups,
      isolation mode, both manifest hashes, the materialized manifest, and a
      distinct manifest-scope failure category.
- [x] Update operator guidance and controller documentation.
- [ ] Pass focused tests and `npm run check:repo-style` on the final tree.
- [ ] Pass `npm run test:unit`, `npm run test:ci`, and `npm run build` on the
      unchanged final tree. Earlier passes predate the final review fixes and
      are intentionally not accepted as final evidence.
- [ ] Publish a draft pull request and pass Branch Release Gate on the exact
      feature commit.
- [ ] After review and integration, pass Run Hetzner Supported Distributed
      Manifests on the exact default-branch commit.

## Design Decisions

- Do not reset the database between recipes. Isolation comes from a fresh group
  identity, so recipes remain valid against persistent or in-memory storage and
  cannot erase unrelated state.
- Derive the isolated group from repository, workflow run id and attempt,
  control run id, source manifest hash, and source `GroupRef`. The same inputs
  reproduce the same group; a rerun attempt receives a different group.
- An explicit `room_id` is an operator request for a stable shared group and is
  therefore never replaced. External and mixed no-spawn use preserves the
  complete checked-in `GroupRef` when no override is supplied; workflow
  application/workspace defaults cannot rewrite it.
- Fence split topology preparation with the source-manifest hash. The
  materialized hash intentionally changes with run/control identifiers and is
  therefore diagnostic evidence, not a prepare/run compatibility key.
- Do not delete completed run groups. Existing lifecycle and expiry behavior is
  authoritative; retained scope and hashes improve post-run investigation.

## Verification Evidence

- Baseline focused suite: 4 files and 107 tests passed.
- TDD red runs proved the materializer, timeout nesting, workflow integration,
  and diagnostics-v2 contract were absent.
- Pre-review focused implementation, fixture, Hetzner/world-fleet
  generated-manifest, provider-parity, and skill-integrity suite: 6 files and
  173 tests passed.
- Pre-review `npm run check:repo-style` passed with the repository's existing
  warning-only findings.
- Pre-review `npm run test:unit` passed: 552 files passed, 4 skipped; 5,540 tests passed,
  18 skipped.
- Pre-review `npm run test:ci` passed after an outside-sandbox rerun allowed its required
  local IPC sockets and loopback listeners. The first complete attempt exposed
  a missing lockfile-declared peer package in the worktree install; reinstalling
  workspace dependencies from the unchanged lockfile corrected the environment.
- Pre-review `npm run build` passed for every workspace. Existing bundle-size notices were
  warning-only.
- Final review found three important scope/fencing gaps. Regression tests now
  cover embedded executable paths/request identities, stable source-hash
  topology fencing, and full-`GroupRef` preservation; the focused workflow
  suite passes 85 tests after the fixes.
