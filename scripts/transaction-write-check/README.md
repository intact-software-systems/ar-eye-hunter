# Transaction write check

`npm run check:transaction-writes` checks authored `packages/**` and
`apps/api-v1/src/**` execution paths for high-confidence work that must happen
before a write-capable transaction starts.

The checker reports:

- `transaction.precomputable-work` for clocks, randomness, serialization,
  hashing, sorting/canonicalization, and named compute/prepare builders reached
  through a resolved transaction callback, transaction-write function, or its
  transitive authored helper and invoked callback closure, plus parameter-only
  persisted-value construction passed directly to a write;
- `transaction.unresolved-provenance` when a reachable callback, callable
  parameter, or authored declaration cannot be resolved to an inspectable
  local body;
- `transaction.inner-retry` when a write transaction is opened from a
  `for`, `while`, or `do` loop. `for-of` iteration of prepared writes remains
  allowed.

It recognizes PostgreSQL/PGlite `begin` and `transaction` callbacks, the
`runInPSqlTransaction` wrapper, IndexedDB `readwrite` transactions, IndexedDB
upgrade callbacks, AppInbox `writeComputedMutation` callbacks resolved by their
receiver type and API, and callback identifiers that resolve to authored source.
One symbol-resolved worklist follows authored functions, methods,
function-valued declarations, transaction-bound callback arguments, and
immediately executing collection callbacks to a fixed point while preserving
the originating transaction boundary. Merely constructing a callback does not
make its body transaction work.

Unknown dynamic or external callback provenance fails closed. Direct
transaction-bound write dispatch remains allowed when the call receives the
transaction explicitly, and a small path/owner/parameter table records reviewed
transaction-forwarding callbacks. Suspiciously named
compute/prepare/serialize/hash helpers still fail at their call site. Readonly
IndexedDB transactions, tests, fixtures, mocks, generated/vendor code,
`packages/shared-test/**`, and `packages/shared-rtc-bench/**` are excluded.

Only exact PostgreSQL ResourceInbox owner methods named in the analyzer are
governed by their specialized SQL review and semantic tests. Whole files and
directories are not exempt. Arbitrary callback-bearing methods and new files in
the same directory remain fail-closed until their bounded policy is reviewed.

This is intentionally a narrow check. It does not attempt whole-program
implementation resolution for injected interfaces, general dynamic dispatch,
or SQL semantic proof. Database-result refinements remain a human-review
boundary. The checker has no exception or fingerprint registry: an unresolved
call must become statically inspectable or be encoded as one narrowly reviewed
transaction operation. Extend the checker only with a focused failing fixture
and a demonstrated production class of error.
