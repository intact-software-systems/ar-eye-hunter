# Hetzner RTC Recipe Lifecycle Hardening Plan

**Goal:** Prevent live multi-agent Hetzner recipes from racing startup or
teardown, and make RTC room-refresh behavior visible in black-box artifacts.

**Architecture:** The Hetzner manifest catalog owns distributed start barriers
and the provider-parity overlap hold. The RTC readiness coordinator owns
bounded `refreshRoom` retries and their counters. The browser command adapter
serializes the complete readiness evidence into command results.

## Constraints

- Preserve recipe IDs, all-agent provider-parity targeting, provider choice,
  authentication behavior, and the 10-second parity readiness window.
- Enable the existing 15-second barrier for every live multi-agent manifest;
  preserve explicit barriers on simulated diagnostics.
- Keep every provider-parity peer alive for 12 seconds before close/reset by
  sampling health once per second.
- Count refresh attempts, completed successes, and retryable failures without
  changing retry classification or timeout/abort behavior.
- Do not convert the other small RTC recipes to role-based recipes. Principal
  and high-rate recipes already own their role-specific lifecycle holds.

## Implementation

- [x] Add failing regression tests for live barriers and parity overlap.
- [x] Make live multi-agent barriers a catalog construction invariant.
- [x] Insert the parity health loop immediately before close/reset and
  regenerate checked-in manifests.
- [x] Add failing artifact assertions for room-refresh counters.
- [x] Add counters to `RtcConnectReadinessResult` and keep readiness functions
  below the repository function-size threshold.
- [x] Serialize the counters at the browser artifact boundary after the
  required size-exception decision in
  [issue #142](https://github.com/intact-software-systems/ar-eye-hunter/issues/142).
- [x] Pass focused tests, typecheck, manifest generation check, and changed-file
  repository-style review.
- [x] Pass `npm run test:unit`, `npm run test:ci`, and `npm run build` on the
  final uncommitted tree.
- [ ] Publish the final feature commit to one draft PR and verify Branch
  Release Gate for its exact SHA.
- [ ] After merge, verify Run Hetzner Supported Distributed Manifests for the
  resulting exact default-branch SHA.

## Compatibility Checkpoint

Implementation started from `origin/main` at
`726edc7c33386f9282f6594ec4b5c3c02033fbf1`. Compared with the earlier planning
base, the intervening default-branch commits did not change manifest ownership,
RTC readiness contracts, recipe identities, or the required validation paths.
Outcome: **Compatible — no plan delta**.

## Persistent Size Exceptions

- Approved by the task requester on 2026-08-09: keep
  `apps/rallar-black-box/src/hetzner-distributed-manifests.ts` cohesive as the
  ordered static manifest catalog; review at 1,200 lines or a second generated
  suite.
- Approved by the task requester on 2026-08-09 in issue #142: keep the legacy
  browser-rallar command dispatch and result-projection table cohesive; revisit
  when its command families are decomposed or the file exceeds 3,100 lines.
