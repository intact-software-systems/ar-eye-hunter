# Rallar Repo Code Style

This is the authoritative coding standard for TypeScript in this repository.
`AGENTS.md`, repo skills, human review guides, and automated checks must point here rather than restating a different
version of these rules.

## Contents

- [Scope and adoption](#scope-and-adoption)
- [Formatting and spacing](#formatting-and-spacing)
- [Predictable file layout](#predictable-file-layout)
- [File size and complexity](#file-size-and-complexity)
- [Canonical function vocabulary](#canonical-function-vocabulary)
- [Variables and local flow](#variables-and-local-flow)
- [Required fields and boundary defaults](#required-fields-and-boundary-defaults)
- [Factory inputs and visible defaults](#factory-inputs-and-visible-defaults)
- [Function inputs and outputs](#function-inputs-and-outputs)
- [`interface` and `type`](#interface-and-type)
- [Narrowing, `unknown`, and assertions](#narrowing-unknown-and-assertions)
- [Validation, expected failure, and `Either`](#validation-expected-failure-and-either)
- [Runtime exceptions and retry classification](#runtime-exceptions-and-retry-classification)
- [Functional dataflow and state](#functional-dataflow-and-state)
- [Services and responsibility boundaries](#services-and-responsibility-boundaries)
- [Decision depth](#decision-depth)
- [Database write safety](#database-write-safety)
- [Configuration sources](#configuration-sources)
- [Comments and self-explanatory code](#comments-and-self-explanatory-code)
- [Review and automation](#review-and-automation)

## Scope and adoption

- The standard applies to TypeScript under `apps/**`, `packages/**`, `scripts/**`, examples, tests, and support tooling.
  A closer domain guide may add stricter rules, but may not relax this baseline.
- Apply the standard to all new code and to code changed during a task. Do not expand an unrelated task into a
  repository-wide cleanup.
- The manual review gate is active now. Automated checks report warnings while legacy debt remains. No strict checker
  mode or CI gate is available yet.
- Tests, mocks, stories, fixtures, and generated artifacts are excluded from the default production-code checker, but
  not from the human-readable standard.
- A deliberate exception requires explicit human approval and a short rationale in the task handoff. Existing violations
  are not precedent.

The goal is human traceability: a reader should be able to follow inputs, decisions, side effects, and failures without
repeatedly jumping through generic helpers or reconstructing partially optional types.

## Formatting and spacing

Use the nearest configured formatter. The repository TypeScript baseline is:

- 2-space indentation;
- 100-character line width;
- semicolons;
- single quotes;
- trailing commas in multiline declarations, calls, objects, arrays, and types;
- braces around control-flow bodies, including one-line bodies;
- one statement per line;
- no manual column alignment with runs of spaces.

Use `deno fmt` where the nearest `deno.json` owns the source path. Use the root Prettier configuration elsewhere.
Deno-owned application trees are listed in
`.prettierignore` so the two formatters do not rewrite the same TypeScript.

Imports use these groups, separated by one blank line:

1. platform and external package imports;
2. shared workspace/package imports;
3. local relative imports.

When an import has more than two named symbols, put one symbol on each line. Remove unused imports. Do not reorder or
reformat unrelated code merely to make an otherwise narrow change look uniform.

Use one blank line between code segments with different jobs, for example:

- boundary decoding;
- dependency and service wiring;
- policy decisions;
- reads;
- computation;
- writes;
- response mapping.

Do not put blank lines between statements that form one small operation. Do not use repeated blank lines. In long
factories, spacing must reveal the composition phases without creating more helper indirection.

## Predictable file layout

Use this order for non-trivial files:

1. imports;
2. exported interfaces, types, and constants;
3. private interfaces, types, and constants;
4. public factory, lifecycle, or route-registration functions;
5. use-case functions;
6. pure `to`, `compute`, and `validate` helpers;
7. side-effecting `read` and `write` adapters;
8. response and error mapping.

Keep a contract close to the behavior that owns it. Export through a barrel only when the contract is intentionally
public. Do not create a type-only file for a single private shape when colocating it makes navigation easier.

## File size and complexity

- 400 physical lines is the TypeScript-file review threshold, including blank lines and comments. A new TypeScript file
  should stay at or below it.
- An existing TypeScript file above 400 lines must not grow without explicit human approval. When a change materially
  touches more than one responsibility, split it along those responsibilities as part of the change.
- Split route modules by business action, normally `*-read.ts`, `*-write.ts`, and
  `*-admin.ts`. Shared HTTP error translation may use `*-errors.ts`.
- A route handler should normally stay at or below 30 physical lines.
- A route handler should normally have estimated cyclomatic complexity at or below 8.

Cyclomatic complexity starts at 1 and adds one for each decision path: `if`
(including each `else if` once), non-default `case`, loop, and `catch`. `else`
alone does not add a path. The checker is a warning heuristic, not a substitute for reading the control flow.

File length is a signal, not a reason to create pass-through modules. A split is successful only when each resulting
module owns a coherent responsibility.

## Canonical function vocabulary

Use the same common verbs for the same semantics. Do not choose a synonym merely because it is more precise in English.

| Prefix                           | Required meaning                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `toXxx`                          | Pure translation from one explicit representation to another.                                                                  |
| `computeXxx`                     | Pure, deterministic, non-trivial calculation from explicit input.                                                              |
| `validateXxx`                    | Pure check returning all issues; an empty array means valid.                                                                   |
| `readXxx`                        | Fetch with an observable boundary effect: repository, database, file, remote API, or read-through cache.                       |
| `writeXxx`                       | Persist or send a value across an observable boundary.                                                                         |
| `getXxx`                         | In-memory read only; no I/O, computation, or mutation.                                                                         |
| `setXxx`                         | In-memory validation and assignment only; no I/O or hidden computation. Return `boolean` or `Either` when assignment can fail. |
| `createXxx`                      | Construct or wire a value from explicit, fully populated input.                                                                |
| `createDefaultXxx`               | Assemble the named default input at a composition root, then call `createXxx`.                                                 |
| `resolveXxx`                     | Pure selection of an identity, scope, or value from explicit or already in-memory input.                                       |
| `initXxx`, `startXxx`, `stopXxx` | Explicit lifecycle side effects.                                                                                               |

If `resolveXxx` needs a database, file, remote API, or read-through cache, name it
`readXxx`. Prefer `toXxx` over named `mapXxx`, `convertXxx`, or `transformXxx`
helpers. Prefer `computeXxx` over `deriveXxx`, `calculateXxx`, or `buildXxx` when the function performs a calculation.

Use a widely understood domain operation such as `append`, `delete`, `publish`,
`revoke`, `join`, or `leave` when that operation is more informative than generic
`write`. Its side effect must still be clear from the full name and contract.

Reserve `assertXxx` for a programmer invariant that intentionally throws when the program is internally inconsistent.
Expected authorization or policy denial uses `validateXxx` issues or an `Either` result so the caller chooses the
outcome.

Avoid vague verbs and nouns:

- `handle`, `process`, `execute`, `perform`, `util`, `helper`, `data`, `thing`;
- unexplained abbreviations such as `svc`, `mgr`, `cfg`, `ctx`, `req`, `res`,
  `grp`, `authn`, `authz`, and `proc`;
- invented or translated words that require repository knowledge to understand.

Short callback names such as `value`, `entry`, `left`, and `right` are acceptable when their meaning is obvious within a
few lines. Public and domain names use complete words.

## Variables and local flow

- Use `const` by default.
- Use `let` only for narrow local mutation such as a loop, accumulator, or state-machine step. Keep the mutable scope
  visible and small.
- Inline a one-use value when the called function name explains the expression and the resulting line remains readable.
- Keep a named `const` when it names a domain decision, separates dataflow stages, avoids repeated work, or makes
  failure handling clearer.
- Do not create aliases that merely rename a value for two or three lines.
- Do not mutate an object received from a caller. Return a new value or use an explicitly stateful in-memory API.

## Required fields and boundary defaults

Required fields are the default for domain, command, service, persisted, replicated, queued, event, snapshot, and
response contracts.

An optional field is valid only when absence has distinct domain meaning. It is not valid because it makes construction,
tests, compatibility, or AI-generated code easier.

Use separate contracts for separate completeness states:

- external request/query/patch input may be sparse when the external contract permits omission;
- boundary normalization applies defaults and returns a fully populated command;
- authoritative output remains complete;
- alternatives with different valid fields use a discriminated union.

Contractual HTTP defaults belong in
`apps/api-v1/resources/api-v1-openapi.yaml`. The boundary decoder must apply the same defaults before domain code runs.
Operational defaults come from typed configuration, not deep helper fallbacks.

Use `T | undefined` only for true semantic absence. Use `null` only when an external contract requires it, then
normalize it at the boundary. Do not add an
`Option` or `Maybe` abstraction by default; required values, `T | undefined`, and `Either` cover the normal repository
cases.

## Factory inputs and visible defaults

Do not make every factory input optional and hide production decisions inside the factory. Use one required input
contract and a separate default factory:

```ts
interface CreateRallarServerInput {
  readonly middleware: Middleware;
  readonly repositories: RallarRepositoryRegistry;
  readonly appDataRepository: AppDataRepositoryLike;
}

function createRallarServer(input: CreateRallarServerInput): RallarServerApplication {
  return createRallarServerApplication({
    runtime: input.middleware,
    repositories: input.repositories,
    appData: { repository: input.appDataRepository },
  });
}

function createDefaultRallarServer(): RallarServerApplication {
  return createRallarServer({
    middleware: initialiseMiddleware(),
    repositories: createDefaultRallarRepositoryRegistry(),
    appDataRepository: createDefaultAppDataRepository(),
  });
}
```

The default factory is a composition root: its purpose is to bring defaults and dependency choices into view.
Lower-level factories take explicit values.

## Function inputs and outputs

A function may have at most three positional parameters. At four parameters, replace them with one named input
interface. Do not evade this rule with tuples, rest parameters, or an untyped options bag.

Use predictable contract names:

| Function          | Input contract when needed | Multi-field success contract        |
| ----------------- | -------------------------- | ----------------------------------- |
| `readInvoice`     | `InvoiceInputDto`          | `InvoiceRead`                       |
| `computeInvoice`  | `InvoiceRead`              | `InvoiceComputed`                   |
| `validateInvoice` | `InvoiceComputed`          | `readonly InvoiceValidationIssue[]` |
| `writeInvoice`    | `InvoiceComputed`          | `InvoiceWritten`                    |
| `toInvoice`       | `ToInvoiceInput`           | `Invoice`                           |

`Dto` marks a readonly, data-only value that crosses an operation, service, transport, persistence, or process boundary.
The suffix tells callers to provide values and properties instead of assembling behavior at every call site. A DTO
contains properties, not callbacks, repositories, services, clocks, loggers, providers, or other behavior-bearing
dependencies. Put injected capabilities in `XxxServiceDependencies` and behavior configuration in `XxxServiceConfig`,
not in a DTO. Provide a service dependency bundle once when creating the service; do not make each operation caller
resupply it.

Use an immutable workflow-stage record when later stages need the complete provenance of one use-case flow. Each stage
contains its immediate predecessor exactly once under the property named for that predecessor and adds only the values
owned by the new stage. Use the predictable chain `input -> read -> computed -> written`. Do not flatten or copy fields
from prior stages into later records.

```ts
interface InvoiceInputDto {
  readonly invoiceId: InvoiceId;
}

interface InvoiceRead {
  readonly input: InvoiceInputDto;
  readonly invoice: InvoiceRecord;
}

interface InvoiceComputed {
  readonly read: InvoiceRead;
  readonly totals: InvoiceTotals;
}

interface InvoiceWritten {
  readonly computed: InvoiceComputed;
  readonly writeResult: InvoiceWriteResult;
}

interface InvoiceValidationFailure {
  readonly computed: InvoiceComputed;
  readonly issues: readonly InvoiceValidationIssue[];
}

type InvoiceComputationResult = Either<InvoiceValidationFailure, InvoiceComputed>;
```

The property chain is deliberate provenance, not hidden control-flow indirection. For example,
`written.computed.read.input.invoiceId` explains where the identifier entered the flow. Keep a stage chain inside its
own use case. Do not turn it into a general domain object, persist it, or return it over an external API by default. Do
not retain streams, large binary values, secrets, or massive collections merely to preserve provenance.

A use-case function keeps each phase and the validation decision visible:

```ts
const read = readInvoice(input);
const computed = computeInvoice(read);
const issues = validateInvoice(computed);

if (issues.length > 0) {
  return Either.ofLeft<InvoiceValidationFailure, InvoiceWritten>({
    computed,
    issues,
  });
}

return Either.ofRight<InvoiceValidationFailure, InvoiceWritten>(writeInvoice(computed));
```

For array input, use an `InvoiceBatchService`. Optimize boundary effects in `readInvoiceBatch` and `writeInvoiceBatch`.
Keep item behavior canonical: `computeInvoiceBatch` calls `computeInvoice` and `validateInvoice` for each item and keeps
one self-contained `InvoiceComputationResult` per identifier:

```ts
const computationByInvoiceId = new Map<InvoiceId, InvoiceComputationResult>();
```

Declare a named interface for a meaningful multi-field return. Small private scalar or tuple returns may remain inline
when the meaning is immediately obvious.

## `interface` and `type`

Use `interface` for concrete object contracts:

- request, command, response, DTO, snapshot, event, and config objects;
- service capabilities and dependency bundles;
- named multi-field function inputs and outputs.

Use `type` when TypeScript alias behavior is required:

- discriminated or primitive unions;
- intersections used for intentional composition;
- mapped and utility types;
- tuples, function signatures, and primitive aliases.

Do not prefix interfaces with `I`. Do not split one interface across declaration merging. An interface improves shape
discovery but does not create a runtime implementation; navigation still starts from the function or service that owns
the behavior.

The plain-object `type` preference is a manual review rule. Its automated check is opt-in while existing code makes the
signal noisy.

## Narrowing, `unknown`, and assertions

`unknown` belongs only at an untrusted boundary: decoded JSON, environment input, framework data, or a caught exception.
It must not propagate into domain logic.

Validate the raw value, then use an explicit `as DomainType` assertion at the boundary handoff. An `as` assertion
without a preceding runtime check is not validation. Avoid double assertions such as `as unknown as X` in new code.

Normalize caught values once:

```ts
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
```

Domain error contracts carry `Error` or a named serializable cause, not
`unknown`.

## Validation, expected failure, and `Either`

`validateXxx` always returns all issues and never throws:

```ts
function validateCreateReport(input: CreateReportInput): readonly ValidationIssue[] {
  return input.retentionDays > 0
    ? []
    : [{ code: 'invalid-retention-days', message: 'Retention days must be positive' }];
}
```

Use `Either<Left, Right>` from `packages/shared/resilience/Either.ts` for an expected operation that may fail:

- left contains a message or reusable error object;
- right contains the successful value;
- use `Either.ofLeft` and `Either.ofRight`, not `new Either`;
- the caller decides whether to fold, continue, retry, collect batch results, or throw;
- a batch may keep one `Either` per item so valid and invalid items remain independently visible.

Validation itself returns issues. A boundary or use case converts non-empty issues to `Either.ofLeft(issues)` when it
needs a success/failure pipeline. A `computeXxx` function may directly return `Either` when the computation has an
expected failure that is not merely a list of validation issues.

Do not throw expected validation, policy, not-found, conflict, or capacity failures. If the caller must cross an
exception-based framework boundary, the caller may deliberately throw from the left value there.

## Runtime exceptions and retry classification

Catch operational exceptions at the nearest side-effect boundary and return a typed failure. Do not catch separately in
every pure helper.

```ts
interface RuntimeFailure {
  readonly code: string;
  readonly operation: string;
  readonly cause: Error;
}

type FailureDisposition = 'retryable' | 'non-retryable' | 'manual';
```

Use `Either<RuntimeFailure, T>` when runtime failure is the only failure kind. When the operation also has expected
domain failures, use a named discriminated left union that includes `RuntimeFailure`; do not introduce another result
abstraction. Convert caught values with `toError` before creating the left.

The operation boundary records what failed. The caller or a central
`classifyRuntimeFailure` policy decides the disposition. Do not put a guessed
`retryable` boolean on a low-level exception and then claim the caller decided.

Optimistic concurrency conflicts are expected typed outcomes, not runtime exceptions. Transient database or network
exceptions are runtime failures. Code bugs and invalid persisted state are normally non-retryable after classification.
Do not deliberately swallow process termination or unrecoverable runtime failures such as out-of-memory conditions.

## Functional dataflow and state

- Prefer data-in/data-out functions and immutable values.
- Keep parsing, validation, policy, computation, and translation pure.
- Keep side effects in narrow adapters named for the effect.
- Do not pass a bag of services to a function that silently mutates those services or other caller-owned objects.
- Do not create helper chains whose only purpose is to move control elsewhere.
- Keep a stateful object only when it explicitly owns lifecycle, connection, subscription, cache, repository, or runtime
  state.
- A `getXxx` method reads owned memory only.
- A `setXxx` method accepts the value to store, may validate it, performs no hidden computation or I/O, and never
  partially updates on failure.

Inject clocks, IDs, random sources, repositories, transports, storage, and providers when they are dependencies. Resolve
production defaults once at the composition root.

## Services and responsibility boundaries

A service-like unit should be micro-service-sized in responsibility: one business capability, one ownership boundary,
and one reason to change. This does not mean adding a deployable service, process, or network boundary.

Use:

- `XService` for a cohesive service capability;
- `XServiceConfig` for behavior configuration;
- `XServiceDependencies` for injected dependencies;
- `XCommandService` or `XRouteService` only when the action split is real.

Avoid generic service roles such as `Manager`, `Coordinator`, `Orchestrator`,
`Broker`, and `Dispatcher`. `Controller`, `Gateway`, and `Facade` are allowed only for a real boundary with that
established meaning; do not use compound names such as `XFacadeService` or `XControllerService`.

Do not move behavior back and forth between services to avoid a loop or branch. Flows such as `A -> B -> A` and
`A -> B -> C -> A` are design smells. Split the domain responsibility so one unit owns the decision instead of adding
another indirection.

Refactoring must preserve single responsibility and separation of concerns. Weakening either requires explicit human
approval.

## Decision depth

Defaults, authorization, policy, retry classification, and invariant decisions must be visible high in the call stack.

- Preferred: boundary -> one named decoder/validator -> decision.
- Warning: the decision is three helper calls below the boundary.
- Strong smell: the decision is four or more helper calls below the boundary.

Count semantic helper calls, not framework callbacks. A helper with a generic name does not make a hidden decision
acceptable. Move request defaults into the request-to-command conversion and keep critical policy in a clearly named
pure function called directly by the use case or route.

## Database write safety

- Create with conditional insert.
- Update with expected-revision compare-and-set.
- Delete or expire with expected-revision conditional delete.
- A stale expiry read must not delete a value that has since been refreshed.
- Never use a read-derived unconditional upsert for shared authoritative state.
- Bound optimistic retries. Every retry must re-read and rerun authorization, policy, capacity, lifecycle, and invariant
  decisions.
- Make idempotency records immutable per request key; the losing writer reads the winner rather than overwriting it.
- Database row, table, and advisory locks require explicit human approval, a documented invariant and measured need, a
  bounded critical section, and a review or removal condition.

Tests must prove overlap, stale input, retry exhaustion, and deterministic final convergence, not merely that one writer
waited.

## Configuration sources

Prefer typed JSON for runtime configuration:

1. `defaults-config.json` provides required operational defaults;
2. an environment-specific file such as `prod-config.json` overrides them;
3. a small explicit environment-variable allowlist supplies deployment identity, secret references, and values that must
   differ outside source control.

Keep contractual request defaults in OpenAPI. Keep secrets out of committed JSON. Load and validate configuration at the
application boundary, then pass a fully populated config object through required interfaces. Do not read environment
variables deep in the call stack.

JSON is the runtime default because it has unambiguous parsing and simple typed loading. YAML remains appropriate for
OpenAPI and human-authored tooling where its features are useful.

## Comments and self-explanatory code

Prefer no comment when names and structure can explain the behavior. A comment is justified only for a non-obvious
invariant, external constraint, safety reason, or deliberately surprising tradeoff. Explain why, not what the next line
does. Do not add narration comments to AI-generated code.

## Review and automation

Use `docs/repo-human-style-guide.md` for the human review sequence and checker commands. The checker is intentionally
warning-only by default. A warning is a review prompt, not proof that code is wrong, and a clean checker result is not
proof that code satisfies this standard.
