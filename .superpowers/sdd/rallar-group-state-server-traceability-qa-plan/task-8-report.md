# Task 8 report — construction-valid topology and RTC registration

## Scope and consumer inventory

Task 8 starts from exact commit
`5e0a9fc5576c6975cd06de7b0280135eb1badf9d` and tree
`b174d510666090d4a009cffc03d78b5367b2cff8`. The inventory covers the
package-exported `AppGroupInboxService`, API-v1 construction and route consumers,
PGlite and PostgreSQL worker fixtures, shared-server queue/convergence harnesses,
the governed performance harness, examples, tests, source ratchets, and active
documentation. No runtime consumer processes topology or RTC RTT work before
calling the corresponding setter. API-v1 explicitly preserves configuration in
`topology` then `rtc-rtt` order before the worker starts.

## TDD evidence

The predecessor registration test passed its two setter/source-characterization
cases, and the registration, middleware, topology, operation, RTC, authority,
and retry behavior batch passed seven files / 80 tests. The isolated future
case then failed only because the two deferred registration operations were
absent and callbacks still resolved optional facade state.

The target lifecycle suite passes five cases. It proves construction registers
only the group and cleanup family in its exact predecessor order, the first
topology setter call registers the five topology operations in exact order, the
first RTC setter call registers its one operation, and same-object repetitions
add no registration. Different objects retain the exact predecessor errors.
Each callback receives the exact supplied mandatory object even after the test
clears the facade's identity-guard field, proving invocation does not read that
optional state. The combined future-only selection now passes registration and
retains exactly twelve Task 9–10 failures with seventeen passing cases.

## Implementation ownership

`AppGroupInboxService` retains its public class, positional constructor,
setters, methods, package path, and optional identity-guard fields. Construction
calls `registerGroupStateMessageHandlers`. The topology and RTC setters call
`registerTopologyStateMessageHandlers(service)` and
`registerRtcRttStateMessageHandler(dependencies)` exactly once, and those
callbacks close over their required parameter. No supplier, registry, service
locator, compatibility hop, new public surface, or mutable invocation-time
dependency was added.

## Validation

- Predecessor setter characterization: 1 file / 2 tests passed.
- Predecessor registration/middleware/topology/operation/RTC batch: 7 files /
  80 tests passed.
- Isolated Task 8 RED: one named failure for the absent deferred-registration
  operations.
- Target lifecycle suite: 1 file / 5 tests passed.
- Final focused registration, middleware, topology, operation, RTC, authority,
  retry, AppInbox, and topology-management batch: 11 files / 119 tests passed.
- Source, mirrored-tree, active-path, function/module-limit, import, and runtime
  cycle ratchets: 3 files / 15 tests passed.
- API-v1 lifecycle: 4 / 4 passed and Deno check passed. Its exact recorded
  lifecycle remains `topology`, `rtc-rtt`, `start`.
- Focused PGlite queue processing: 2 / 2 passed, covering topology retry/CAS,
  receipts/outboxes, stable command reuse, RTC RTT processing, and terminal
  authority rejection.
- Future-only selection: 2 files passed, 1 failed only on the twelve planned
  Task 9–10 target cases; 17 cases passed.
- Shared-server TypeScript passed with no emit.
- Changed-style comparison against exact base
  `a7a5f488cd185a7f2cc6bd814c319f97d5401d03` passed with no new finding.

The focused construction-detail output has no Task 8 construction finding.
`boundary.unknown` on the unchanged group callback is a demonstrated protocol
boundary, and `abstraction.pass-through` on the unchanged
`isTopologyConfigInboxType` predicate is an existing facade-owned routing-policy
signal with no new magnitude. The final Prettier, diff, and line checks pass.
Independent scoped review remains external until it exists.

## Self-review

Critical 0 / Important 0. Public setter identity and error behavior, family
registration order, callback input identity, and the supported composition
lifecycle are explicit. Transaction, retry, receipt, outbox, result, topology,
and RTC algorithms remain unchanged. Independent scoped review is pending.
