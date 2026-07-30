# Repo Human Style Review Guide

Use this guide when reviewing TypeScript written or refactored by a human or AI
anywhere in the repository.

The authoritative coding standard is
`.agents/skills/rallar-code-writing/references/repo-code-style.md`. Read it before
reviewing a change. This guide supplies the review sequence and checker usage; it
does not define a second version of the rules.

Code is written first for human developers. Correctness, safety, security,
compatibility, and required performance remain mandatory; within those
constraints, human understandability is the governing review criterion.

The first review question is whether a human can locate the owner and follow
the dataflow, decisions, side effects, failures, and result without unnecessary
jumps. Mechanical compliance does not compensate for code that became harder
to understand.

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

### 2. Check contracts before implementation details

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

### 3. Read names as behavioral contracts

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

### 4. Find important decisions

Locate defaults, authorization, policy, invariants, and retry classification.
Apply the decision-depth thresholds in the authoritative standard.

Do not accept a critical choice hidden behind generic pipeline, context,
orchestration, handler, or helper layers. Moving a decision into another file is
not an improvement unless its owner and name become clearer.

### 5. Inspect failure flow

- `validateXxx` returns issues and does not throw.
- Expected failures use `Either`.
- Side-effect boundaries normalize caught values to `Error` and return `Either`;
  its left includes `RuntimeFailure` when an operational exception can occur.
- The caller or central policy classifies retryability.
- Optimistic conflicts are expected typed outcomes rather than exceptions.
- Batch processing may preserve one left/right result per item.

List the failures you believe can occur. If the code has additional hidden
failure paths, request another pass.

### 6. Inspect state and responsibility

- No caller-owned object is silently mutated.
- Stateful objects state what they own and how lifecycle ends.
- Services have one capability and one reason to change.
- Control does not bounce `A -> B -> A` or `A -> B -> C -> A`.
- A file split creates responsibility boundaries rather than pass-through files.

Existing architecture can explain a constraint, but it does not excuse adding a
new violation.

### 7. Inspect layout

Apply the formatting, spacing, file-order, file-size, handler-size, and
complexity sections of the standard. Blank lines should expose phases in long
factories and composition roots.

Start at the obvious feature entry file and follow one representative input to
its result. Compare each filename with its primary exported symbol, verify that
contracts, translations, factories, persistence adapters, and direct tests are
co-located with the feature that owns it.
Inspect the room/group-state translation boundary when browser room code reaches
authoritative group-state contracts.

Use this size and cohesion review sequence:

1. Summarize the file responsibility in one sentence.
2. Apply the numeric tier from the authoritative standard.
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

### 8. Check change scope

- New and changed code follows the standard.
- Unrelated legacy code is not reformatted or refactored without authorization.
- An existing over-threshold file does not grow silently.
- Any deliberate exception has explicit human approval and appears in the
  completion handoff and, when required by the hard size tier, the
  [repo code-style exception registry](./repo-code-style-exceptions.md).

## Warning-only checker

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
- potential `unknown` propagation;
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
together.

### Optional noisy checks

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
base and fail only for new or worsened findings:

```bash
npm run check:repo-style:changed -- origin/main
```

The comparison enables the optional contract and detailed layout checks for
changed production code. Existing findings may remain unchanged, improve, or
disappear without blocking the branch.

## Review outcome

End the review with:

- accepted behavior and why it is traceable;
- requested changes, each tied to the authoritative standard;
- checker warnings reviewed and whether they apply;
- explicit exceptions approved by the human;
- validation commands passed, failed, or skipped.

A clean checker run does not replace this review. A warning does not require a
mechanical rewrite when the human review shows the heuristic does not apply.
