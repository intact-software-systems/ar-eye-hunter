# Black-box runtime construction

## Purpose and approved direction

Finish the runtime construction finding in the RTC baseline integration without
changing command execution or capture behavior. The user approved retaining
`createRallarBlackBoxTestRuntime` for explicit dependencies and introducing
`createDefaultRallarBlackBoxTestRuntime` for callers that want defaults.

This deliberately changes the existing public construction signature. All
verified callers are updated together. There is no old default-capable
overload, deprecated export, forwarding alias, compatibility fallback, data
conversion, or transition period. The runtime remains one lifecycle owner.

This spec follows the repository's active-spec location in
[plans/README.md](../README.md). The broader
[RTC baseline plan](../../docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md)
retains its measurement requirements. Construction acceptance does not provide
deployed HOST/RUN acceptance or an accepted E3 cohort.

## Public construction contracts

The implementation remains in
[the existing runtime owner](../../packages/shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts).
The existing [public entry](../../packages/shared-test/rallar-bb-test/mod.ts)
continues to re-export that owner.

`CreateRallarBlackBoxTestRuntimeInput` requires these dependencies:

- `now: () => number`
- `sleep: (ms: number, signal?: AbortSignal) => Promise<void>`
- `idFactory: (prefix: string) => string`

Its executor, cleanup, ALM-usage reader, and congestion-counter reader remain
optional. Absence means that the runtime has no corresponding supplied
capability; it must not acquire a substitute executor, cleanup action, or
fabricated page reading.

`CreateRallarBlackBoxTestRuntimeOptions` retains its existing public name for
the distinct sparse override shape, expressed as `Partial` of the canonical
input. This is the default factory's input, not an alternative name for a
fully populated dependency contract. Existing browser-option types that use
this sparse shape keep that meaning.

`createRallarBlackBoxTestRuntime(input)` requires the input argument and all
three infrastructure dependencies. It selects no defaults. It snapshots the
seven dependency fields into a new owned object before constructing the
existing private runtime. The class uses the canonical input contract;
remove its duplicate dependency declaration. The private constructor remains
the stateful lifecycle boundary rather than becoming another public API.

`createDefaultRallarBlackBoxTestRuntime(options = {})` assembles the complete
input directly in its body, then calls the explicit factory. This function
owns override selection, the real sleep implementation, and the per-runtime
ID sequence. Remove `toRuntimeDependencies` and the separate sequential-ID
factory; do not relocate their default choices behind a new helper.

## Behavior that must be preserved

Default clock reads call `Date.now()` when the runtime asks for time. Do not
capture the current clock function once during construction. Supplied clock,
sleep, and ID callbacks are used directly and are not wrapped to add policy.

Default sleep remains the existing abort-aware implementation. Nonpositive
delays resolve before checking abort; an already aborted positive delay
rejects. Positive waits still own their timer and abort-listener cleanup.
Do not replace real sleep with a no-op in a partially deterministic caller.

Each default runtime owns an ID sequence beginning at one. Command, event,
recipe-body, and invocation prefixes share that sequence. Another runtime
starts its own sequence. Supplying an ID factory bypasses the default
sequence's use.

Both construction paths preserve the dependency snapshot. Reassigning
properties on the caller's input or options after construction cannot change
which callbacks the runtime uses. The snapshot copies references; it does
not deep-clone functions or install generic forwarding behavior.

Command admission, cache replay, capture precedence, control assignment,
recipe bodies, events, cancellation, and cleanup retain their current owners
and behavior. In particular, both awaited page-stat readers must still
complete before the assignment-owner publication fence. Selectors, presence
polls, message sends, retries, API payloads, and deadlines do not change.

## Consumers and ownership

The verified consumer inventory contains 160 calls in 50 files. The 157 calls
in 47 files that omit at least one required dependency move to the named
default factory. The three fully supplied calls keep the explicit factory:

- [Browser runtime composition](../../packages/shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts)
- [Assertion-outcome parity](../../packages/shared-test/rallar-bb-test/conformance/assertion-outcome-parity.ts)
- [Loop test](../../packages/tests/shared-test/rallar-bb-test-loop-until.test.ts)

Update imports and actual calls, including production browser/operator
consumers, Deno control tests, package tests, and test support. Preserve each
caller's existing selected dependencies. The deterministic test helper keeps
its supplied clock and ID callbacks and obtains the same real default sleep.

Update the construction description in
[shared-test architecture](../../packages/shared-test/architecture.md).
The minimum implementation scope is 49 existing code/documentation files;
required recursive standards remediation may expand it.

Every changed human-authored file is reviewed and remediated in full. Every
support file modified by that remediation enters closure recursively until
closure. Independent untouched code remains outside closure. Remove affected
legacy and duplicated policy within that boundary; a preserved test or prior
existence alone does not justify retention.

## Acceptance and validation

Use TDD for the new default entry and explicit construction contract. A native
compiler witness must reject omission of the input argument and each required
dependency independently, while accepting complete dependencies and genuinely
absent optional capabilities. Record the current signature's acceptance of
the forbidden calls as the contract RED. Compilation or test setup failures
from unrelated dependencies do not establish that RED.

Behavior tests must exercise default construction, each selective override,
per-runtime/shared-prefix IDs, dynamic default clock lookup, real abort-aware
sleep, and dependency-snapshot isolation. Identify immediate GREEN cases as
preservation coverage; do not claim a new runtime defect where none exists.
The existing runtime test owner supplies these assertions rather than a
parallel factory test system.

The direct behavior validation is the focused runtime construction and
lifecycle tests, including the existing stats, cancellation, and cleanup
cases. The affected-package validation includes native shared-test typing,
maintained package-test consumer typing, browser/operator builds, and Deno
control consumers. These are separate from the compiler refusal witness.

Run the affected capture, recipe, and ALM contracts after updating their
consumers. Preserve the existing assignment/publication-fence and page-reader
tests. Regenerated manifests must remain unchanged unless the canonical
writer demonstrates a required contract change; this design selects none.

Measure browser and headless bundles again with their canonical build and
Brotli procedure. Require the real budgets and publication checks to pass;
do not disable a check or infer size from the previous construction code.
Any measured budget issue is evidence to diagnose before accepting the slice.

The original source author implements the approved plan with TDD. The original
independent reviewer then reviews the corrected source for specification and
complete file quality. Root owns Git operations and source integration.
An accepted slice requires both verdicts, coherent consumer typing/builds,
and the actual immutable integration-range checks. Retain original failures
and report passed, failed, and skipped checks accurately.

## Scope and publication

The next two outcomes are the construction contract/default composition and
coherent consumer integration with independent review. Later work remains
source publication, deployed HOST/RUN verification, and governed RTC
measurement; it does not become an additional construction subsystem.

The existing feature merge is in progress. Save this spec for review without
altering its frozen source/index or committing an unreviewed merge. Commit
the reviewed documentation at the next valid feature publication boundary;
do not create a default-branch commit or manufacture a partial merge commit.
The PR remains the delivery record; no catalog or tracked progress ledger is
introduced. Delete this active spec before the PR that finishes these
construction outcomes merges, as the repository requires.

The user's E3 and unrelated-process cleanup hold remains in effect. This
construction approval authorizes neither a workload launch nor default-branch
commit/push. Required measurement counts, failure retention, and E3 acceptance
remain those in the RTC baseline plan.
