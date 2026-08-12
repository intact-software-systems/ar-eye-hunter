# Repo Human Style Review Guide

Use this guide when reviewing all human-authored code written or refactored by
a human or AI anywhere in the repository.

The authoritative coding standard is
`.agents/skills/rallar-code-writing/references/repo-code-style.md`. Read it before
reviewing a change. This guide supplies the review sequence and checker usage; it
does not define a second version of the rules.

Record independent pull-request reviews in the
[PR Human Review Record v1](./pr-human-review-record.md). That record captures
exact-SHA review evidence and retained-legacy approval; this guide remains the
authoritative human review sequence.

Code is written first for human developers. Correctness, safety, security,
compatibility, and required performance remain mandatory; within those
constraints, human understandability is the governing review criterion.

The first review question is whether a human can locate the owner and follow
the dataflow, decisions, side effects, failures, and result without unnecessary
jumps. Mechanical compliance does not compensate for code that became harder
to understand.

> “The goal is not minimum syntax. The goal is minimum cognitive indirection.”

Cognitive indirection is an avoidable semantic hop through vocabulary,
ownership, files, abstractions, dataflow, decisions, callbacks, side effects,
failures, tests, compatibility layers, or legacy paths. Retain a hop only when
it exposes a real domain, lifecycle, policy, translation, compatibility,
protocol, or side-effect boundary. Review the owner-to-result path, not merely
syntax or file count.

Production code is the primary design artifact; tests are secondary evidence.
Tests protect independently stated observable behavior, public contracts, safety
and correctness invariants, and approved architecture boundaries. When an
improved production design breaks a coupled test without breaking an independent
requirement, rewrite, replace, or delete the test. Classify the failure first;
never restore inferior production structure merely to make a coupled test pass.

Run `npm run review:legacy -- <merge-base> <candidate-head>` for every changed
production review. It reports heuristic, changed-surface candidates only; a
clean report does not prove that no legacy exists and a report does not decide
whether a candidate is legitimate. Review the actual call paths, then give each
reported candidate exactly one final-ledger disposition: `removed`,
`minimized-boundary`, `resolved`, or `retained-pending-human-approval`. A
retained item still needs explicit human approval and a durable registry entry.

## Human review sequence

### 1. Read the change as dataflow

For each changed use case or route, identify in order:

1. external input;
2. boundary normalization and defaults;
3. validation and policy;
4. reads;
5. pure computation;
6. writes or publication;
7. response or returned result;
8. possible failures.

If one of these cannot be located from the top-level function and its immediate
calls, the change is not yet traceable.

### 2. Trace construction and callbacks

Start at the composition root and follow construction from top to bottom:

- Every dependency exists before its consumer is constructed.
- The graph is acyclic and each stateful or lifecycle capability has one visible
  owner.
- No definite-assignment assertion, mutable closure, setter, supplier, registry,
  service locator, or test-only factory hides late binding.
- A dependency bundle is supplied once rather than forwarded unchanged through
  wrapper layers.
- Tests replace dependencies through the same narrow ports used by production;
  no alternate factory, overload, or wiring path exists only for tests.

For every callback, state who invokes it, when it can run, how often it can run,
what values or state it captures, who owns any captured mutation, how it fails,
and who owns cleanup. Event, lifecycle, transaction, retry, resource-scope, and
protocol callbacks are often the correct boundary. Keep that boundary visible,
but move business policy, loops, multiple decisions, and multi-step I/O into a
direct named operation.

Follow one representative input through the callbacks and immediate calls. Its
domain name should remain stable until an explicit translation creates a new
representation. Request a rewrite when generic `input`, `options`, `context`,
`payload`, or `data` names make the reader reconstruct identity from nested
closures.

When a protocol discriminant already determines its payload shape, require the
existing discriminated type-to-payload relationship. Repeated case-local
assertions are not an acceptable substitute. One boundary narrowing may
establish that relationship but must not claim to validate fields it did not
inspect, silently add payload validation, or alter runtime error timing.

For transaction, retry, lifecycle, and after-commit dependencies, require a
named port declared beside the canonical owner. From a consumer, Go to Definition
must reveal invocation, retry, commit, and failure semantics instead of an
anonymously duplicated signature. Judge capability cohesion by responsibility,
not method count: methods that own one transaction phase may form one narrow
capability, while unrelated methods do not become cohesive merely because the
count is small.

Complete a code-only trace exercise for every materially different callback,
transaction, retry, protocol, or lifecycle family as two distinct timelines.
The construction and registration timeline names each required or captured
dependency's creation and owner, callback registration, earliest possible
invocation, and proves all required dependencies exist first. The runtime
invocation timeline records the external entry, runtime invoker and
invocation/retry rule, translation and phase owners, transaction/retry owner and
first guard, atomic writes, commit return, private after-commit data,
after-commit effects, early exits, failures, cleanup, caller-visible result, and
canonical versus compatibility paths. Start from production symbols, not a
plan, inventory, or source-text assertion. Shared variants use one trace plus a
variant inventory.

The fail-closed rule is that mutable values do not escape a transaction callback
unless its contract proves invocation count, retry behavior, commit semantics,
failure behavior, and why mutation is safe. Prefer an immutable returned result
whose durable projection is visibly separate from private after-commit data.

This is a semantic human-review step. The checker does not prove that a
construction graph is acyclic, a callback is justified, or names preserve one
dataflow. Add automation only as a separately reviewed change with demonstrated
signal and acceptable false positives.

### 3. Check contracts before implementation details

- Domain, command, persisted, event, snapshot, and response values are required
  by default.
- Optional request fields are normalized at the boundary.
- Genuine alternatives use separate contracts or a discriminated union.
- Plain object contracts use `interface`; aliases with union, mapping,
  intersection, tuple, function, or primitive behavior use `type`.
- A function with more than three positional parameters uses one named input
  interface.
- A meaningful multi-field result has a named output interface.

Do not accept an optional field because it reduces test setup or allows a partial
object to compile.

### 4. Read names as behavioral contracts

Compare each new function prefix with the canonical vocabulary table in the
standard. In particular:

- `to` and `compute` are pure;
- `validate` returns all issues;
- `read` and `write` cross an observable boundary;
- `get` and `set` are in-memory only;
- `create` takes explicit input, while `createDefault` exposes default assembly
  at the composition root.

Request a rename when a reader would need a thesaurus, repository archaeology,
or the function body to understand the verb.

### 5. Find important decisions

Locate defaults, authorization, policy, invariants, and retry classification.
Apply the decision-depth thresholds in the authoritative standard.

Do not accept a critical choice hidden behind generic pipeline, context,
orchestration, handler, or helper layers. Moving a decision into another file is
not an improvement unless its owner and name become clearer.

### 6. Inspect failure flow

- `validateXxx` returns issues and does not throw.
- Expected failures use `Either`.
- Side-effect boundaries normalize caught values to `Error` and return `Either`;
  its left includes `RuntimeFailure` when an operational exception can occur.
- The caller or central policy classifies retryability.
- Optimistic conflicts are expected typed outcomes rather than exceptions.
- Batch processing may preserve one left/right result per item.

List the failures you believe can occur. If the code has additional hidden
failure paths, request another pass.

### 7. Inspect state and responsibility

- No caller-owned object is silently mutated.
- Stateful objects state what they own and how lifecycle ends.
- Services have one capability and one reason to change.
- Control does not bounce `A -> B -> A` or `A -> B -> C -> A`.
- A file split creates responsibility boundaries rather than pass-through files.

Existing architecture can explain a constraint, but it does not excuse adding a
new violation.

### 8. Inspect layout

Apply the formatting, spacing, file-order, file-size, handler-size, and
complexity sections of the standard. Blank lines should expose phases in long
factories and composition roots.

Start at the obvious feature entry file and follow one representative input to
its result. Compare each filename with its primary exported symbol, verify that
contracts, translations, factories, persistence adapters, and direct tests are
co-located with the feature that owns it.
Inspect the room/group-state translation boundary when browser room code reaches
authoritative group-state contracts.

A feature with more than 20 production modules or more than three materially
different control-flow families retains a durable repository navigation map;
a historical PR body is not a durable substitute. For an explicit timing or
decorator owner, require a closed operation-name type and exhaustive operation
inventory. Timing identity fields are deliberately populated, deliberately
retained for compatibility, or removed only through separately approved
observable-behavior work.

Use this size and cohesion review sequence:

1. Summarize the file responsibility in one sentence.
2. Apply the cognitive-load tier, responsibility threshold, and navigation
   backstop from the authoritative standard.
3. Inspect the eight qualitative cohesion signals.
4. Identify real responsibility boundaries before proposing extraction.
5. Check whether an exception applies and is approved.
6. Prefer the organization that makes the public API, state, dataflow, and
   change ownership fastest to locate.

The eight signals are an unclear one-sentence responsibility, independent
reasons to change, unrelated import groups, repeated jumps between distant
sections, distinct private-helper clusters, unrelated test setup modes,
multiple lifecycles or state machines, and merge-conflict hotspots in unrelated
areas. These signals can justify review below a numeric threshold; line count
alone never justifies a pass-through split.

When a materially touched file or function remains above the hard tier, verify
that the human-approved rationale is recorded in the
[repo code-style exception registry](./repo-code-style-exceptions.md). Do not
register untouched legacy debt or place the justification in a source comment.

Prefer self-explanatory names and structure. Ask for a comment only when it
records a non-obvious invariant, external constraint, safety reason, or tradeoff.

### 9. Check change scope

- New and changed code follows the standard.
- Unrelated legacy code is not reformatted or refactored without authorization.
- An existing over-threshold file does not grow silently.
- Any deliberate exception has explicit human approval and appears in the
  completion handoff and, when required by the hard size tier, the
  [repo code-style exception registry](./repo-code-style-exceptions.md).

Semantic tests are primary. Source inventories, exact-tree checks, string
assertions, and line/count ratchets are supplementary and temporary. Verify each
temporary ratchet has a named owner and removal condition, remains supplementary
to semantic runtime or architecture assertions, and is removed or replaced after
the move's resulting-main workflow and later ledger are published when semantic
assertions cover the same loss risk.

### 10. Review affected production legacy

For the active plan's affected production surface, inspect duplicate predecessor
implementations; deprecated entry points and exports; compatibility aliases,
adapters, routes, flags, modes, and fallbacks; bridges, shims, and workarounds;
parallel old/new paths; rollback paths; and historical vocabulary or types kept
only for compatibility. Do not infer that a clean vocabulary scan proves the
absence of legacy: trace actual production call paths.

Unapproved production legacy may exist only while an active plan explicitly owns
its disposition. Every affected item must be `removed`, `minimized-boundary`,
`resolved`, or `retained-pending-human-approval`. A minimized boundary is thin,
explicitly named, delegates to the canonical implementation, and contains no
duplicate business logic. Unrelated untouched legacy is outside the completion
gate unless the plan depends on, expands, materially touches, or routes changed
production flow through it.

Never allow an issue, reviewer silence, prior approval, agent judgment, or an
automated result to approve retained legacy. For every retained item, verify the
human approved its exact path and symbol, purpose and consumer dependency,
unsafe-removal reason, minimization, canonical owner, compatibility tests,
named owner, review/removal condition, and current candidate SHA. A production
change invalidates that approval and requires the complete review again.

## Warning-only checker

The TypeScript checker automates only syntax it can parse. The preceding human
review sequence remains language-neutral and applies to all human-authored code.

Run from the repository root:

```bash
npm run check:repo-style
```

The default run scans production TypeScript under `apps/**` and `packages/**`.
It reports warnings and exits successfully even when findings exist. It is a
review aid, not a CI gate. Output is capped at 200 displayed findings while the
summary retains the full count; use a focused `--root` when the cap is reached.

Current default warnings cover:

- production files over the line-count threshold;
- lines over the configured width;
- route handler size and estimated complexity;
- optional fields in `*Command` contracts;
- supported function and arrow-function declarations with more than three
  positional parameters;
- discouraged compound service names;
- factories that hide several defaults behind optional inputs;
- long unsegmented blocks in supported factory forms;
- callbacks passed to `createXxx` factories that capture a local binding first
  assigned after construction (`construction.forward-capture`);
- potential `unknown` propagation;
- type aliases that only rename an existing named or qualified type
  (`types.rename-alias`);
- namespaces that contain runtime members instead of only erasable type
  declarations (`types.runtime-namespace`);
- TypeScript `enum` declarations, which are not erasable syntax
  (`types.enum-declaration`);
- directories with more than 20 direct production TypeScript files
  (`layout.directory-density`);
- meaningful filename-prefix clusters in those dense directories
  (`layout.feature-prefix-cluster`);
- non-kebab TypeScript filenames (`layout.filename-style`);
- generic filenames without an owning feature noun and role
  (`layout.generic-filename`);
- exported route registration functions named only `init`
  (`layout.generic-route-init`);
- `mod.ts` files outside the approved package compatibility boundaries
  (`layout.unapproved-mod`).

Run the layout-only command to isolate these structural review signals from
existing file-level warning debt:

```bash
npm run check:repo-style:layout
```

Directory and prefix findings are ownership prompts.
It is not an instruction to create folders or pass-through modules mechanically.
High-volume filename findings are grouped warnings, while the layout summary
reports affected counts for every active rule. Thus one displayed warning can
account for several affected files without hiding the debt measure.

Some rules remain manual because a text heuristic cannot reliably determine
semantics: decision depth, purity, side effects, responsibility boundaries,
meaningful absence, useful inlining, and whether blank-line groups belong
together. Type-organization judgment also stays manual: canonical-name choice,
justified import renames, and namespace-before-class ordering.

### Optional noisy checks

Run detailed construction-shape checks when reviewing late binding, callback
depth, or boundary-free wrappers:

```bash
npm run check:repo-style:construction-details
```

This adds `construction.definite-assignment`,
`control.nested-callback-depth`, and `abstraction.pass-through`. The default
`construction.forward-capture` rule remains active with or without this option.
The broader rules stay opt-in because repository calibration found mixed signal.

These findings identify syntax shapes for human review. They do not prove a
construction graph is cyclic, a callback is unjustified, or a facade lacks a
real boundary.

For changed production code, the review map lists every construction-detail
warning by path, rule, and symbol and records one construction-warning
disposition: fixed, demonstrated false positive, or accepted existing debt with
no new/worsened magnitude and an owner. The review rule is that silence or a
warning-only exit code is not a disposition. This evidence does not make every
optional warning globally blocking.

Run output-contract naming checks only when useful for the workstream:

```bash
npm run check:repo-style:output-contracts
```

Run the plain-object `type` to `interface` migration check only when reviewing
contract declarations:

```bash
npm run check:repo-style:object-interfaces
```

Run detailed layout checks when primary-symbol naming and vocabulary boundaries
are in scope:

```bash
npm run check:repo-style:layout-details
```

This adds only `layout.primary-export-name`, `layout.browser-room-boundary`, and
`layout.server-group-state-vocabulary`. Browser product code uses room language,
while authoritative API and server code uses group-state language. The explicit
`room-group-state-translation.ts` boundary owns that translation; established
protocol identities `GroupRef` and `roomRef` remain unchanged. These detailed
checks are opt-in because existing compatibility debt can make them noisy.

All optional checks in this section are off in the default run because current
repository debt makes them noisy.

### Focused and expanded scans

Scan API-v1 source explicitly:

```bash
npm run check:repo-style:src
```

Scan all reachable TypeScript from the repository root:

```bash
npm run check:repo-style -- --root .
```

The full-root command includes production support code outside `apps/**` and
`packages/**`; it still excludes non-production and generated paths.

### Exclusions

The checker excludes test, spec, mock, fixture, story, and generated paths or
filenames. This includes common forms such as `__tests__`, `mocks`, `fixtures`,
`generated-types`, `__generated__`, `codegen`, `*.generated.ts`,
`*.generated.d.ts`, `*.gen.ts`, and `*.pb.ts`. It also excludes test-runner
configuration files for Playwright, Vitest, Jest, and Cypress.

These are checker exclusions only. Humans should still write readable tests and
support artifacts.

### No global strict mode yet

Global full-repository strict enforcement is not implemented. Passing
`--strict` is rejected rather than silently turning every warning into a build
gate. Adding a global strict package command or full-repository CI gate requires
a separate human decision after warning debt and false-positive rates are
understood. The merge-base feature-branch gate below is active.

### Changed-file enforcement

The full-repository scan remains warning-only so legacy debt does not block
unrelated work. Feature branches run a separate comparison against their merge
base and fail only for new or worsened findings. For the file metrics —
`file.cognitive-load` (tiers 50/110/330), `file.responsibility-count`
(threshold 12 runtime value exports), and the `file.length` navigation backstop
(1,200 physical lines after the data-literal discount) — worsened means
crossing a metric tier or same-tier growth of more than max(10% of the
merge-base magnitude, 25 units); every other rule treats any magnitude growth
as worsened:

```bash
npm run check:repo-style:changed -- origin/main
```

The comparison enables the optional contract and detailed layout checks for
changed production code. Existing findings may remain unchanged, improve, or
disappear without blocking the branch.

#### Reviewed changed-file dispositions

Narrow false positives that have completed human review are recorded in
`scripts/repo-style-check/reviewed-dispositions.mjs`. A disposition matches only
the exact normalized path, rule identifier, and checker-owned symbol. The
checker produces that symbol from source structure and never parses or
substring-matches human-readable finding messages. Findings owned by the module
itself carry no symbol; a reviewed module-owner disposition records that absent
symbol explicitly and still leaves every function-owned finding blocking.

Dormant entries are allowed when their reviewed feature has not reached the
branch yet. They do not suppress a similarly named finding elsewhere. Every
unmatched finding remains blocking, including a finding with a different path,
rule, or symbol beside an otherwise reviewed finding.

## Review outcome

Review pressure exists at more than 100 changed files, more than 10,000 changed
lines, more than 20 changed production modules, or more than three materially
different control-flow families. Require a written stacked-versus-single
decision rather than an automatic split. If one large pull request is accepted,
require a one-screen read-first map of entry owners, transaction and exit
owners, compatibility surfaces, review slices, and exact current evidence.
Stale head, tree, or workflow evidence blocks completion until corrected.

End the review with:

- accepted behavior and why it is traceable;
- construction cycles ruled out or resolved, with ownership made explicit;
- callbacks retained or replaced, including their invocation and lifecycle
  rationale;
- family-level construction/registration and runtime-invocation trace evidence,
  with the variant inventory required by the authoritative trace contract above;
- test fakes use the production ports without alternate test-only wiring;
- requested changes, each tied to the authoritative standard;
- checker warnings reviewed and whether they apply;
- explicit exceptions approved by the human;
- validation commands passed, failed, or skipped.

A clean checker run does not replace this review. A warning does not require a
mechanical rewrite when the human review shows the heuristic does not apply.
