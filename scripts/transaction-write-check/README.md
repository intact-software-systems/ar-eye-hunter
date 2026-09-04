# Transaction write check

`npm run check:transaction-writes` checks authored `packages/**` and
`apps/api-v1/src/**` execution paths for high-confidence work that must happen
before a write-capable transaction starts.

The checker reports:

- `transaction.precomputable-work` for clocks, randomness, serialization,
  hashing, sorting/canonicalization, and named compute/prepare builders reached
  from a resolved transaction callback or transaction-write function;
- `transaction.inner-retry` when a write transaction is opened from any loop;
- `transaction.unresolved-provenance` when transaction work invokes a
  caller-supplied function whose behavior cannot be proven locally.

It recognizes PostgreSQL/PGlite `begin` and `transaction` callbacks, the
`runInPSqlTransaction` wrapper, IndexedDB `readwrite` transactions, IndexedDB
upgrade callbacks, AppInbox computed-write callbacks, and callback identifiers
that resolve to authored source.
It follows resolved authored function, method, and function-valued variable
bodies recursively to a fixed point. A closure is followed only when it is
invoked from the transaction path; callbacks passed to immediately executing
collection methods are also inspected. Authored declarations without an
inspectable body fail closed unless the call is a transaction-bound persistence
operation that receives the transaction explicitly. Readonly IndexedDB
transactions, tests, fixtures, generated/vendor code, `packages/shared-test/**`,
and `packages/shared-rtc-bench/**` are excluded.
Exact PostgreSQL ResourceInbox owner methods in the analyzer are governed by
their specialized SQL review and semantic tests. Whole files and directories
are not exempt. Arbitrary callback-bearing methods such as `enqueueIf` and
`enqueueOrUpdate` remain fail-closed; a new method is analyzed until its bounded
SQL policy is reviewed and encoded explicitly.

The checker does not claim whole-program implementation resolution for injected
interfaces, general dynamic dispatch, or PostgreSQL semantic proof. Direct
transaction-bound write dispatch is therefore also reviewed at the concrete
writer, and database-result refinements remain a human-review boundary. The
checker has no exception registry: a precomputable-work finding must be fixed,
and an unresolved call must either become statically inspectable or be encoded
as one narrowly reviewed transaction operation. Extend the checker only with a
focused failing fixture and a demonstrated production class of error.
