# Rallar Repo Code Style

Universal structural rules in this standard govern all human-authored code in
the repository. TypeScript-specific rules additionally govern TypeScript and
JavaScript-family source where their syntax and tooling apply. `AGENTS.md`, repo
skills, human review guides, and automated checks must point here rather than
restating a different version of these rules.

## Contents

- [First principle: code is for human developers](#first-principle-code-is-for-human-developers)
- [Minimum cognitive indirection](#minimum-cognitive-indirection)
- [IDE causal navigation](#ide-causal-navigation)
- [Production code, tests, and legacy](#production-code-tests-and-legacy)
- [Scope and adoption](#scope-and-adoption)
- [Touched-file standards closure](#touched-file-standards-closure)
- [Formatting and spacing](#formatting-and-spacing)
- [Predictable file layout](#predictable-file-layout)
- [Feature ownership and repository organization](#feature-ownership-and-repository-organization)
- [File and primary symbol names](#file-and-primary-symbol-names)
- [File size and complexity](#file-size-and-complexity)
- [Canonical function vocabulary](#canonical-function-vocabulary)
- [Variables and local flow](#variables-and-local-flow)
- [Required fields and boundary defaults](#required-fields-and-boundary-defaults)
- [Factory inputs and visible defaults](#factory-inputs-and-visible-defaults)
- [Construction, dependencies, and callbacks](#construction-dependencies-and-callbacks)
- [Function inputs and outputs](#function-inputs-and-outputs)
- [`interface` and `type`](#interface-and-type)
- [Type names, aliases, and type-only namespaces](#type-names-aliases-and-type-only-namespaces)
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

## First principle: code is for human developers

Code is written first for human developers. Correctness, safety, security,
compatibility, and required performance are non-negotiable constraints.
Within those constraints, human understandability is the governing design criterion
for this standard.

Prefer code whose owner, inputs, defaults, decisions, side effects, failures,
and result can be located and followed directly from descriptive filenames,
symbols, and call paths. Do not apply a rule mechanically when doing so adds
pass-through abstractions, hides a decision, fragments one coherent dataflow,
or otherwise makes the code harder to review, debug, or change.

The rules below are defaults derived from this principle together with the
repository's correctness and operational requirements. Resolve concrete
tradeoffs through the direct owner-to-result path. Escalate only under the
enumerated touched-file standards closure conditions below.

## Minimum cognitive indirection

> “The goal is not minimum syntax. The goal is minimum cognitive indirection.”

Cognitive indirection is an avoidable semantic hop a reader must make to
understand vocabulary, ownership, files, abstractions, dataflow, decisions,
callbacks, side effects, failures, tests, compatibility layers, or legacy paths.
Prefer the shape whose owner-to-result path a human can trace with the fewest
such hops. Shorter syntax is not a benefit when it makes that path harder to
find or reconstruct.

Indirection is permitted only when it exposes a real domain, lifecycle, policy,
translation, compatibility, protocol, or side-effect boundary. Each retained
layer must name its boundary, preserve the dataflow and failure semantics, and
make the canonical owner easier to locate. A helper, alias, adapter, callback,
or file split that merely moves work elsewhere is cognitive overhead, not an
abstraction benefit.

## IDE causal navigation

An authoritative mutation must expose a causal path that an unfamiliar developer
can follow with ordinary IDE symbol navigation. Start a cold probe at a concrete
registration and use only Go to Definition and Find Usages to reach these five
landmarks:

1. the concrete operation entry;
2. the domain or update policy;
3. the first conditional write guard;
4. the exact durable result; and
5. the after-commit effect.

When a mutation intentionally has no after-commit effect, the fifth landmark is
the explicit commit return whose control flow proves that absence.

The probe scores one point for each reachable landmark. A 5/5 result means the
causal path is IDE-navigable; it does not claim that the implementation is
otherwise correct or simple. Record search escapes, ambiguous pivots, and named
deferred boundaries encountered. A search escape is any need to search for
an implementation name or inspect a directory manually. An ambiguous pivot is a
type-only definition whose Find Usages result offers multiple plausible business
implementations. A named deferred boundary is a transaction, queue, callback,
or effect edge whose callable owner is visible even though invocation occurs
later.

There is no global call-depth limit. Semantic depth remains governed by the
decision-depth and cognitive-indirection rules; the probe measures whether each
edge can be followed, not whether all valid designs have the same shape. Functional
style keeps named functions passed to `Either` or pipeline operators as navigable edges. Functional
composition does not need to be replaced by controllers, classes, or fluent APIs.
Inline work is acceptable when its decision and effect flow are visible at the
boundary.

Repository, transaction-writer, queue, clock, gateway, and sink contracts are
named effect ports. Reaching one is a boundary fact, not an ambiguous business
implementation pivot. The concrete adapter may still need its own focused probe
when that effect implementation changes.

Functional core, explicit imperative shell, named functional composition where
it makes failure flow clearer. This is an ownership rule, not a syntax rule:
imperative sequencing may be the clearest shell, while named `Either` or
pipeline edges may be the clearest expression of expected failure.

Do not erase a fixed, meaningful operation inventory unless the generic owner
contributes semantics that justify doing so. A callable collection remains a
truthful boundary when it is runtime-extensible, intentionally declarative data,
or its owner defines ordering, scheduling, lifecycle, retry, cleanup, or failure
semantics. Listener registries, lifecycle participants, middleware, plugins,
cleanup stacks, and named strategy tables are therefore not violations merely
because they invoke entries generically.

When an application composition root fixes distinct operations, converts them
to anonymous entries of one callable type, and passes them to an owner that only
invokes each entry, keep the inventory concrete through direct named calls or one
named aggregate. Follow transparent wrappers to the first real decision or
effect; adding a name around the same erased inventory does not restore
navigability. If static analysis cannot prove whether membership or invocation
semantics are runtime-owned, classify the edge for manual review instead of as a
violation. Never auto-fix a callable-inventory finding.

The navigation report uses three dispositions: high-confidence findings,
legitimate boundaries, and unknown/manual review. The detailed report remains
observational. The changed-range gate blocks only new or worsened high-confidence
registration-indirection and unnamed-deferred-edge findings in changed product
code under `apps/**` or `packages/**`. Existing high-confidence debt does not
block an unrelated change; legitimate boundaries and unknown/manual-review
classifications never block. Analyzer errors remain fatal, and the analyzer
never fixes or rewrites code.

## Production code, tests, and legacy

Production code is the primary design artifact; tests are secondary evidence.
Tests protect independently stated observable behavior, public contracts, safety
and correctness invariants, and approved architecture boundaries. They do not
own incidental file trees, helper names, call order, line counts, migration
history, or implementation topology.

When production design improves without breaking an independent requirement,
rewrite, replace, or discard the coupled test. First classify a failing test as
either a production regression or obsolete test coupling. Never restore inferior
production structure merely to make a coupled test pass.

Within the current work's affected production surface, legacy candidates include duplicate
predecessor implementations; deprecated entry points or exports; compatibility
aliases, adapters, routes, flags, modes, and fallbacks; migration bridges,
shims, and workarounds; parallel old/new implementations; rollback paths that
retain a predecessor; and historical vocabulary or types retained only for
compatibility.

During touched-file standards closure, actively remove affected legacy code when no
independent requirement or verified consumer requires it. Do not retain affected legacy solely
because it pre-existed, a coupled test protects it, or removal was not named in the request. Keep
independent untouched legacy outside closure. If removal would change a public API, persisted
format, protocol, migration contract, or verified consumer behavior, treat it as a compatibility or
migration decision; minimize it to a thin named boundary and require explicit maintainer approval
and a registry entry for continued retention.

At completion, each affected item is `removed`, `minimized-boundary`, `resolved`, or `retained`.
`minimized-boundary` means a thin, explicitly named compatibility boundary that
delegates to the canonical implementation and contains no duplicate business
logic. A retained item requires explicit authorized-maintainer approval and a durable registry
entry for its exact path and symbol; agent judgment, automation, an issue, silence, or approval for
older code does not suffice.

Independent untouched code remains outside the closure. Unrelated repository legacy is outside the
completion gate unless the work depends on it, expands it, materially touches it, or makes it part
of a changed production call path. Newly discovered in-scope legacy must be reviewed in the current
pull request and cannot be deferred through an issue to complete the work.

## Scope and adoption

- Universal structural rules apply to all human-authored code, including source,
  scripts, tests, fixtures, examples, configuration code, and support tooling,
  regardless of language or directory. These universal sections are the first
  principle; construction, dependencies, and callbacks; functional dataflow and
  state; services and responsibility boundaries; decision depth; comments and
  self-explanatory code; and review and automation.
- TypeScript-specific rules apply additionally to TypeScript and
  JavaScript-family source where their syntax and tooling apply. A closer domain
  guide may add stricter rules, but may not relax this baseline.
- Apply the standard to all new code and to the complete contents of every touched file. Do not expand an unrelated
  task into a repository-wide cleanup.
- The manual review gate is active now. The full-repository checker remains warning-only while legacy debt remains.
  No global strict checker mode is available. Feature-branch CI blocks only new or worsened findings against the merge
  base. For the file metrics — `file.cognitive-load`, `file.responsibility-count`, and the `file.length` navigation
  backstop — worsened means crossing a metric tier or same-tier growth of more than
  max(10% of the merge-base magnitude, 25 units); every other rule treats any magnitude growth as worsened.
- Checker tolerance is not authority to retain noncompliance and does not define touched-file standards closure.
- The full-repository checker reports tests, mocks, fixtures, and support tooling alongside
  production. Generated and vendored artifacts stay out of both the checker and the standard.
- Enforcement on tests is staged. Feature-branch CI blocks a changed test file only on
  `boundary.unknown` and `construction.forward-capture`; every other rule is
  reported for review without blocking. A rule joins that set once it has been measured against the
  test corpus, as `file.length` was. Staging is keyed on the path, so a directory-level layout
  finding under a test tree is staged the same way a file-level one is.
- A deliberate exception requires explicit human approval and a short rationale in the task handoff. Existing violations
  are not precedent.

Apply the first principle by keeping inputs, decisions, side effects, and
failures traceable without repeated jumps through generic helpers or
reconstruction of partially optional types.

## Touched-file standards closure

Touched-file standards closure is the positive execution path for maintenance,
features, fixes, refactors, tests, tooling, and documentation-owned code
contracts. Touched means every changed human-authored source, test, script,
fixture, example, and configuration file; generated and third-party files are
excluded.

Use this loop to implement the requested behavior and close the complete
touched-file standards surface:

1. Recover the requested behavior, current owner, representative dataflow, and
   applicable standards before editing.
2. Implement the requested behavior and resolve pre-existing and new
   noncompliance throughout each touched file.
3. When remediation changes a support file, that file enters the closure
   recursively; repeat until no changed human-authored file remains outside the
   closure.
4. Keep independent untouched code outside the closure. Do not turn local
   propagation into repository-wide cleanup.
5. Validate both the requested behavior and closure, including human review;
   warning-only or merge-base tolerance is evidence input, not the completion
   rule.

You must resolve the entire touched-file closure and validate both the requested
behavior and closure before completion. Do not ask for
permission merely because the noncompliance pre-existed or because remediation
is larger than the first diff estimate.

Escalate only for:

1. a genuine exception for a remaining real standards violation;
2. a public compatibility or migration decision;
3. an unresolved correctness or safety conflict; or
4. a failed post-consolidation navigation probe.

Do not escalate for pre-existing debt, deadline pressure, diff size, cleanup
volume, ownership recovery, package boundaries, substantial remediation, or
reprioritization alone. A product-semantics question is an escalation only when
it concretely creates the correctness, safety, public compatibility, or
migration decision above.

## Formatting and spacing

The root dprint configuration (`dprint.json`) is the only formatter, and it owns every tree in the
repository including the Deno applications. `deno fmt` is retired: no `deno.json` declares a `fmt`
block or `fmt` task, so there is no second formatter to fight over the same TypeScript. Suppress a
node with `// dprint-ignore`, or a whole file with `// dprint-ignore-file`.

`dprint.json` is the sole authority for indentation, line width, quotes, semicolons, trailing
commas, brace position, and import ordering. Those values are deliberately not restated here: a
second copy drifts, and the formatter is what actually decides. Run `npm run format` to apply it and
`npm run format:check` to verify.

Because the formatter decides line width, the checker no longer measures it — there is no
`line.width` rule. Width is not a review topic; reach for the layout, cognitive-load, and
type-organization rules when a line is hard to read for reasons a formatter cannot fix.

The standard still governs what the formatter does not decide:

- braces around control-flow bodies, including one-line bodies;
- one statement per line;
- no manual column alignment with runs of spaces.

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

## Feature ownership and repository organization

Organize by owned feature or capability before technical role. A feature folder
owns its entry service, facade, or route registration; its private contracts;
pure translations; factories; persistence adapters; and direct tests. Put a
responsibility in a nested folder only when that folder names a real subfeature
or boundary.

Place cross-runtime HTTP DTOs under the owning `packages/shared/api/<feature>`
path, browser product inputs and views under the owning
`packages/shared-web/browser/<feature>` path, and persistence records, storage
keys, exact reads, and snapshot assembly under the owning feature's
`persistence/` path. Keep command, read, computed, validation, and written
contracts beside the use case or service that owns their phase sequence. Keep
explicit-dependency factories beside their service and production-default
factories in application composition. Keep route request and response
translations beside the routes that own them.

Do not create repository-wide or package-wide `interfaces`, `types`,
`translators`, `factories`, `helpers`, or `utils` folders. Those words name
implementation roles, not owners. A private one-use contract stays beside its
behavior. An intentionally shared contract uses a descriptive feature contract
filename and is exported only through the intentional package boundary.

More than 20 direct production TypeScript files prompts an ownership review.
Four or more sibling files with the same meaningful feature prefix prompts a
feature-folder review. These thresholds do not require a folder or permit a
pass-through module. A new one-file folder requires a real public, runtime, or
ownership boundary.

A feature with more than 20 production modules or more than three materially
different control-flow families retains a durable repository navigation map.
The map links to current owners and their entry/exit paths; a historical PR body
is not a durable substitute.

Every feature folder has one obvious feature entry file named for its public
service, facade, or route-registration function. Prefer
`feature/subfeature/file.ts`; add another directory level only when it removes
a genuine mixed responsibility. Tests mirror the production feature path.

`room` is the product and browser term.
`group-state` is the authoritative API and server term. Translate between them
in the explicitly named browser boundary `room-group-state-translation.ts`.
Established protocol identities `GroupRef` and `roomRef` remain unchanged
unless an approved public-contract migration changes them.

## File and primary symbol names

TypeScript filenames use kebab-case, including files whose primary export is a
class or React component. Exact ecosystem-discovered configuration names such
as `vite.config.ts` and `prisma.config.ts` retain the names expected by their
tools.

A file basename matches its primary exported class, function, interface, type,
or capability after mechanical Pascal/camel-to-kebab conversion. An action
module is verb-first and uses the canonical vocabulary. Route registration uses
a descriptive name such as `registerGroupStateRoutes`, not an export named only
`init`. Lifecycle names include their capability, for example
`initRoomPresence`.

Generic filenames such as `utils.ts`, `types.ts`, `helpers.ts`, `contracts.ts`,
`runtime.ts`, and `middleware.ts` require a feature noun and role. Prefer
`group-state-service-contracts.ts` or `api-v1-http-middleware.ts`.

Established abbreviations API, CRDT, HTTP, RTC, SQL, URL, WebSocket, and WS are
allowed. Do not introduce local abbreviations such as `svc`, `mgr`, `cfg`,
`ctx`, `req`, `res`, `grp`, or `proc` in public or domain names.

Do not introduce historical implementation names such as `task10-*` or
`*-correction-17`. When the owning feature is migrated, rename existing test
files for the behavior or invariant they prove. This remains a human review
rule because tests are excluded from the default production checker.

`mod.ts` is a package compatibility boundary. Do not add nested barrels to
shorten imports. Internal code imports the owning file directly; public
consumers use the intentional package entry point.

## File size and complexity

A file owns one coherent responsibility that a developer can summarize in one
sentence. File density is measured by cognitive load — the checker's Sonar-style
cognitive-complexity sum over the whole file (`file.cognitive-load`) — because
decision density, not line count, is what makes a file hard to hold in your
head:

- cognitive load `<50`: normal target;
- cognitive load `50-109`: cohesion warning;
- cognitive load `110-329`: required separation review;
- cognitive load `>=330`: refactor or record an approved persistent exception in
  [the repo code-style exception registry](../../../../docs/repo-code-style-exceptions.md).

The tiers are calibrated on the production corpus (p85/p95/p99 of 1,676
production files). A file exporting `>=12` runtime values
(`file.responsibility-count`) prompts the same split review: many independent
value exports usually mean many independent reasons to change.

Physical length remains only as a navigation backstop (`file.length`): after
subtracting data-literal lines — behavior-free object and array literals
spanning three or more lines — a file stays at or under `1,200` physical lines,
or is refactored or recorded as an approved persistent exception. The computed
data-literal discount replaces registry entries for declarative files: large
schema, manifest, and lookup data needs no exception while the code around it
stays navigable.

Test files carry a `1,500`-line backstop instead. The tiers above are calibrated
on the production corpus; measured the same way, the test corpus is 13-23%
longer at every percentile and its p99 is 1,242 lines, so `1,500` preserves the
same "top ~1% of files" meaning the production number carries. No other file
metric is relaxed for tests: the test corpus is roughly half as cognitively
dense as production at every percentile (p95 49 against 75, p99 116 against
161), and `0.4%` of test files export twelve or more runtime values against
`2.5%` of production files. A cohesive suite is worth more than a split one,
and the cost of splitting it is not repaid by a metric tests already satisfy.

An existing file already inside a warning tier enters touched-file standards
closure when changed. Resolve its applicable tier and cohesion noncompliance
throughout the touched file, using a coherent responsibility split when needed.
Only a genuine remaining standards exception may retain a real violation.

For a general function, count from its declaration through its closing brace,
including blank lines and comments:

- `<=40` physical lines: normal target;
- `41-49` physical lines: warning;
- `50-60` physical lines: required separation review;
- `>60` physical lines: refactor or record an approved symbol-level exception in
  [the repo code-style exception registry](../../../../docs/repo-code-style-exceptions.md).

These thresholds apply to named functions, including test helpers and fixture
builders, which already satisfy them more often than production functions do
(`6.2%` over forty lines against `8.0%`). They do not apply to a `describe`,
`it`, or `test` body. Those are suite structure rather than functions: a
`describe` body has a median of 124 lines and a p85 of 363, so a forty-line
function target would demand splitting one cohesive suite across files, which
is the cognitive overhead this standard's first principle rejects. File metrics
govern the suite; the function thresholds govern the helpers it calls.

Route handlers retain the stricter `<=30`-line target. Split route modules by
business action, normally `*-read.ts`, `*-write.ts`, and `*-admin.ts`. Shared
HTTP error translation may use `*-errors.ts`. A route handler should normally
have estimated cyclomatic complexity at or below 8.

Cyclomatic complexity starts at 1 and adds one for each decision path: `if`
(including each `else if` once), non-default `case`, loop, and `catch`. `else`
alone does not add a path. The checker is a warning heuristic, not a substitute for reading the control flow.

Treat a file or function as too large when one or more of these qualitative
signals apply, even when it remains below a numeric threshold:

1. A developer cannot summarize its responsibility in one sentence.
2. It has several independent reasons to change.
3. Its imports naturally form unrelated groups.
4. A reader must jump repeatedly between distant sections.
5. Private helpers fall into distinct conceptual clusters.
6. Its tests require several unrelated setup modes.
7. It owns multiple lifecycles or state machines.
8. Changes commonly produce merge conflicts in unrelated areas.

Accepted exception categories are declarative schemas or protocol definitions,
static lookup data, carefully structured test scenarios, parser or
state-transition tables, approved export-only package barrels, and cohesive
algorithms whose steps are easier to follow together. Generated code remains
outside human-authored size enforcement.

Materially touched means behavior, contracts, control flow, state, lifecycle,
structure, or responsibility changed. Import-only, formatting-only, typo, and
path-only changes do not trigger exception registration. When a materially
touched file remains at or above cognitive load `330` or above the `1,200`-line
navigation backstop, or a materially touched `>60`-line function remains above
its threshold, record the approved exception in
[the registry](../../../../docs/repo-code-style-exceptions.md). Do not put size
justifications in source comments.

Size is a review signal, never an instruction to create pass-through files or
helper chains. A split is successful only when each resulting module or function
owns a coherent responsibility and makes the public API, state, dataflow, and
change ownership easier to locate.

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
        appData: { repository: input.appDataRepository }
    });
}

function createDefaultRallarServer(): RallarServerApplication {
    return createRallarServer({
        middleware: initialiseMiddleware(),
        repositories: createDefaultRallarRepositoryRegistry(),
        appDataRepository: createDefaultAppDataRepository()
    });
}
```

The default factory is a composition root: its purpose is to bring defaults and dependency choices into view.
Lower-level factories take explicit values.

## Construction, dependencies, and callbacks

Construction order must be visible and acyclic. Construct each dependency
before the consumer that receives it, then pass the completed dependency as a
value through a required, narrow port. A reader should be able to scan the
composition root from top to bottom and identify who creates, owns, and invokes
each capability.

Do not hide a construction cycle with a definite-assignment assertion, mutable
closure, setter injection, post-construction binding, forward-captured callback,
supplier introduced only to defer lookup, global registry, or service locator.
These shapes replace a structural dependency with a temporal invariant and make
use-before-wiring possible. Test-only factories or overloads must not create a
second construction path.

Resolve a cycle by changing ownership:

1. move the shared decision or state to the single unit that owns it;
2. depend in one direction on a smaller, lower-level port; or
3. combine units that share one lifecycle and cannot state independent
   responsibilities.

Compatibility and deadlines may constrain the public surface, but they do not
justify hidden late binding. Preserve an existing boundary with a thin adapter
only when that adapter has an explicit compatibility purpose and lifetime.

A callback is appropriate when another owner genuinely decides whether, when,
or how often work runs. Common examples are event delivery, lifecycle hooks,
transactions, retry attempts, resource scopes, and protocol/framework entry
points. Keep the registration or invocation boundary visible. Make callback
timing, invocation count, captured values, failure behavior, and cleanup clear
from its contract and owning call site.

When a protocol discriminant already determines its payload shape, express that
existing relationship as a discriminated type-to-payload relationship. Repeated
case-local assertions are not an acceptable substitute. One boundary narrowing
may establish an existing typed protocol relationship, but it must not claim to
validate fields it did not inspect, silently add payload validation, or alter
runtime error timing.

Keep a callback body short and specific to that boundary. When it contains
business policy, loops, several decisions, multi-step I/O, or a complete
workflow, move that work to a direct, descriptively named operation and pass or
call that operation at the boundary. Do not build a callback chain merely to
make functions injectable. Inject the narrow capabilities used by the named
operation and test the same production path with fakes.

Names must preserve the dataflow. Use `XxxServiceDependencies` for behavior
dependencies, `XxxServiceConfig` for behavior configuration, and a domain-named
DTO or stage record for data. Do not rename one value through generic
`input`, `options`, `context`, `payload`, or `data` parameters as it travels down
the call stack. Keep the domain name stable until an explicitly named `toXxx`
translation creates a different representation, then give the result its new
domain name.

Keep the mainline operation visible near the entry point. Extract a wrapper,
factory, or facade only when it owns a real lifecycle, policy, translation,
compatibility, or protocol boundary. A layer that accepts a dependency bundle
and forwards it unchanged does not improve testability. Test pure decisions as
values and test side-effect boundaries through their narrow production ports;
do not add factory injection or alternate wiring solely for tests.

Transaction, retry, lifecycle, and after-commit dependencies use a named port
declared beside the canonical owner. From a consumer, Go to Definition reveals
invocation, retry, commit, and failure semantics instead of an anonymously
duplicated signature. Capability cohesion is judged by responsibility, not
method count: several methods that own one transaction phase may form one
narrow capability, while several unrelated methods do not become cohesive
because the count is small.

For every materially different callback, transaction, retry, protocol, or
lifecycle family, complete a family-level code-derived trace as two distinct
timelines:

The two timelines separate registration from invocation.

1. A construction and registration timeline names each required or captured
   dependency's creation and owner, the callback registration point, the first
   point at which it can be invoked, and proves every required dependency exists
   before that point.
2. A runtime invocation timeline names:

- the external or protocol entry;
- callback registration owner and registration time;
- runtime invoker and callback invocation count or retry rule;
- representation translation and read, compute, validate, and write owners;
- transaction and retry owner and the first conditional guard;
- receipt, event, exact durable result, and final outbox writes;
- commit-return point and private after-commit data;
- after-commit effects, early exits, failures, and cleanup; and
- final caller-visible result and canonical versus compatibility paths.

One trace plus a variant inventory covers variants with the same control-flow
family. The trace is a code-only trace exercise: follow production symbols
without using a plan, inventory count, or source-text assertion as the answer.

The fail-closed rule is that mutable values do not escape a transaction callback
unless the transaction contract explicitly proves invocation count, retry
behavior, commit semantics, failure behavior, and why mutation is safe. Prefer
an immutable callback result whose durable projection is visibly separate from
private after-commit data.

Semantic tests are primary. Source inventories, exact-tree checks, string
assertions, and line/count ratchets are supplementary and temporary. Each
temporary ratchet records a named owner and removal condition and is
supplementary to semantic runtime or architecture assertions. Remove or replace it when semantic
assertions directly cover the same loss risk. No resulting-main workflow or post-merge ledger is
required.

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
        issues
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

## Type names, aliases, and type-only namespaces

TypeScript type design optimizes for human comprehension: a reader should understand a type
reference without following renaming aliases or reconstructing where a type came from.

Every named interface, class, enum, or named type has one canonical name. Use it directly at every
reference. Do not introduce a local or exported `type` alias, import rename, or re-export whose only
effect is to rename or shorten an existing named type. Qualification such as `CreateAccounts.Input`
is ownership information; do not remove it merely to shorten code. A `type` alias is justified only
when it defines a genuinely new type expression or semantic type — a union, intersection, tuple,
mapped, conditional, function, branded, `keyof`, or indexed-access type, or a semantic primitive
alias such as `type VertexId = string`.

When several contracts belong specifically to one class, prefer a type-only namespace with the same
canonical name declared immediately before the class, so a reader meets the vocabulary before the
implementation and every reference reads as `CreateAccounts.Input`. Associated namespaces contain
only erasable type declarations — never runtime values, functions, classes, or enums — and stay
compatible with `erasableSyntaxOnly`. Do not introduce new TypeScript enums; prefer string-literal
unions. Contracts owned by a function-based use case keep flat feature-prefixed names such as
`InvoiceInputDto`.

The detailed rules, examples, Deno lint boundary, and alias-refactoring guidance live in
[typescript-type-organization.md](./typescript-type-organization.md). The checker warns by default
for rename-only aliases (`types.rename-alias`), runtime namespace members
(`types.runtime-namespace`), and `enum` declarations (`types.enum-declaration`); canonical-name
choice, import renames, and namespace-before-class ordering remain manual review.

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

A service-like unit owns one coherent business capability, one ownership
boundary, and one reason to change. This does not mean adding a deployable
service, process, or network boundary.

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

For authoritative database or realtime service mutations, read
`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`
completely. That reference owns AppInbox transaction/retry rules, optimistic
compare-and-set semantics, permissive convergence, immutable facts, canonical
identity, and concurrency verification.

The local shape rule remains: expose a functional core through an explicitly
owned stateful shell, keep `read`, `compute`, `validate`, and
`write(transaction, computed)` visible, and represent expected decisions and
conflicts as typed values rather than exceptions.

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

The TypeScript checker reports `construction.forward-capture` by default when a
factory callback captures a local binding first assigned after construction.
The broader construction diagnostics remain opt-in because they have mixed
signal and require human interpretation. They identify reviewable syntax, not
proof of a dependency cycle, an unjustified callback, or a boundary-free facade.

For changed production code, record a construction-warning disposition for
every construction-detail warning by path, rule, and symbol: resolved
throughout the touched file or demonstrated false positive. The review rule is
that silence or a warning-only exit code is not a disposition. This human-review
requirement does not make every optional warning globally blocking; touched-file
standards closure does.
