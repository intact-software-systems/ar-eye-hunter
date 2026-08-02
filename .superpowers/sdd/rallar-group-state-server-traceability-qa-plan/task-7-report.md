# Task 7 report — explicit group-state timing operations

## Scope

Task 7 starts from exact commit
`3a730b845a78a268f1c1e19dc9b3edb7a54619cb` and tree
`a96ca6935840752328f26980fa72dcfdf59472f4`. It moves only the existing
group-state timing representation into
`group-state/group-state-service-timing.ts` and makes
`createGroupStateRuntime` call that owner directly. It changes no public
package export, domain operation, persisted value, AppInbox lifecycle,
dependency, workflow, checker behavior, or later-task owner.

## TDD evidence

The predecessor selection passed five timing behavior cases before production
edits. The isolated future-owner case then failed only because
`group-state-service-timing.ts` did not exist. After the explicit owner was
implemented, the complete timing suite passes six cases.

The accepted test path proves all 15 asynchronous operations independently:

- the underlying service operation is called exactly once;
- its exact return identity or exact rejection object is preserved;
- exactly one success or error timing event follows that call;
- component, operation, service ID, request, scope, group, principal, and
  session projections match the predecessor behavior; and
- synchronous `compute` and `validate` remain the original function values and
  produce no timing event.

The no-timing branch returns the exact input service object. Optional
`listRecentEvents` stays absent when it was absent on the input service.

## Review-fix round 1

The first independent review reported Critical 0 / Important 1: the literal
operation list was not tied bidirectionally to every Promise-returning
`GroupStateService` key, and the fake recorded operation names but not exact
argument tuples. The focused correction started RED with three failures and
one pass: the tuple inventory was absent for every operation and both explicit
optional-method tests lacked that invocation evidence.

`PromiseReturningMethodKey` now derives method keys from the complete service
contract, uses `Exclude<Method, undefined>` so optional async operations remain
covered, and excludes synchronous functions and data properties. The exact
coverage constant rejects both missing and extra keys; the test also requires
runtime uniqueness. Therefore a future required or optional Promise-returning
method breaks the contract until the explicit adapter and inventory add it.

The fake records every exact argument tuple through an operation-specific
generic contract. The invocation table owns one stable tuple per operation, and
the contract suite compares every object and value with identity semantics.
The optional `listRecentEvents` case separately proves the present wrapper's
arguments/result/details and the absent shape's missing method, zero calls, and
zero timing events. No production source changed in this review fix.

## Implementation ownership

`createTimedGroupStateService` is the single real instrumentation boundary.
The public input contains only the complete service, optional sink, and service
ID fixed by Section 6.2. Cohesive private operation-family owners make every
timed call directly discoverable. A single timing operation helper owns the
genuine deferred action passed to `timeRallarAsync`; it does not select or
discover a method at runtime.

`group-state-service.ts` now owns only service construction and passes the
complete service to the timing owner. The superseded `Proxy`, `Reflect.get`,
property-name dispatch, variadic argument contract, `Function.apply`, and
generic invocation projection are deleted. No new package barrel or public
package export was added.

## Validation

- Predecessor timing selection: 1 file / 5 tests passed; the future owner was
  skipped.
- Isolated Task 7 RED: 1 named failure because the target owner was absent.
- Initial Task 7 timing GREEN: 1 file / 6 tests passed.
- Review-fix RED: 1 new contract file / 3 failed and 1 passed.
- Complete review-fix timing GREEN: 2 files / 10 tests passed.
- Timing, idempotency, handler, AppInbox, operation, transaction-failure,
  source/tree, and active-path batch: 17 files / 172 tests passed.
- Focused timing test TypeScript compilation passed, including the exact
  type-level operation equality and optional-method probe.
- Source/mechanical/function/module/import/cycle ratchets: 14 tests passed as
  part of the focused runs; every new or changed module is at most 400 lines
  and every new or changed function/callback is at most 60 lines.
- Shared-server TypeScript passed with no emit.
- Changed-style comparison against exact base
  `a7a5f488cd185a7f2cc6bd814c319f97d5401d03` passed with no new findings.
- The focused construction-detail scan reported no finding in either changed
  timing/service owner; its 95 warnings are unchanged group-state debt outside
  Task 7.
- The combined future-only selection passes timing and retains exactly 13
  Task 8–10 target failures with 12 passing predecessor/Task 6–7 cases.

Prettier, diff, final line, and final cycle checks passed after this factual
evidence was formatted. Independent review and the final commit/tree remain
external publication evidence until they exist.

## Self-review

Critical 0 / Important 0. The derived operation list is exact in both
directions, all argument tuples use identity assertions, direct navigation
reaches every underlying method, the no-sink and optional-method shapes are
preserved, and no later task or public surface is included. Independent scoped
re-review is pending.
