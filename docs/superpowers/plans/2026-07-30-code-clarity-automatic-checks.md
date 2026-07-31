# Code Clarity Automatic Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AST-based code-quality findings that catch hidden late-bound construction and expose risky callback/pass-through shapes without pretending semantic heuristics prove architecture quality.

**Architecture:** Add one focused Babel-AST rule module beside the existing checker modules. Enable only the high-signal forward-capture rule in the default and changed-file checks; expose broader definite-assignment, nested-callback, and pass-through diagnostics behind `--construction-details` until baseline calibration proves acceptable signal.

**Tech Stack:** Node.js ESM, `@babel/parser` already present in the repository, Vitest fixture tests, existing merge-base changed-style checker.

## Global Constraints

- Execute after the universal scope-fix plan is merged; start from the latest `origin/main` on a separate feature branch.
- Do not add dependencies, production runtime code, public APIs, or directory-specific policy.
- Parse TypeScript, TSX, MTS, CTS, and MJS surfaces already supported by the checker; unsupported languages remain under human review.
- Keep full-repository findings warning-only. Only new or worsened default findings are blocking through the existing changed-file comparison.
- Do not label import cycles as construction cycles. Do not claim callback legitimacy, ownership, or stable semantic dataflow can be proven mechanically.
- Keep every checker implementation file at or below 400 lines and every line at or below 100 characters.
- Default rule: `construction.forward-capture`.
- Opt-in rules: `construction.definite-assignment`, `control.nested-callback-depth`, and `abstraction.pass-through`.
- Nested callback detail threshold: three direct call-argument callback boundaries.

---

### Task 1: Specify AST rule behavior with failing unit fixtures

**Files:**

- Modify: `packages/tests/repo/repo-style-check.test.ts`

**Interfaces:**

- Produces:

```js
export const constructionRuleIds = Object.freeze({
  forwardCapture: 'construction.forward-capture',
  definiteAssignment: 'construction.definite-assignment',
  nestedCallbackDepth: 'control.nested-callback-depth',
  passThrough: 'abstraction.pass-through',
});

export function scanConstructionRules(source, options) {}
```

`source` is `{ file: string, raw: string }`; `options` is `{ details: boolean }`; the result is `Array<{ ruleId: string, message: string }>`.

- [ ] **Step 1: Add RED fixtures for the default forward-capture rule**

Add fixture tests that expect `construction.forward-capture` for both forms:

```ts
export function createRuntime() {
  let service!: Service;
  const consumer = createConsumer({ readService: () => service });
  service = createService();
  return { consumer, service };
}
```

```ts
export function createRuntime() {
  let send!: Send;
  const inbound = createInbound((message) => send(message));
  const outbound = createOutbound();
  send = outbound.send;
  return { inbound, outbound };
}
```

The message must include the captured binding, construction call, declaration line, and later assignment line.

- [ ] **Step 2: Add negative fixtures for legitimate deferred boundaries**

Assert no default finding for direct acyclic construction, an event callback using already-created dependencies, and a Promise resolver:

```ts
const service = createService();
const consumer = createConsumer({ readService: () => service });
```

```ts
let resolveDone!: () => void;
const done = new Promise<void>((resolve) => {
  resolveDone = resolve;
});
```

The Promise case may appear in opt-in definite-assignment output, but must not produce `construction.forward-capture`.

- [ ] **Step 3: Add RED fixtures for opt-in detail rules**

Run fixtures with `--construction-details` and assert:

- a local `let value!: Type` produces `construction.definite-assignment`;
- three nested direct call-argument callbacks produce `control.nested-callback-depth` with magnitude 3;
- a callable whose only body is `return target(input)` or `return await target(input)` produces `abstraction.pass-through`;
- the same fixtures do not produce those rule IDs without the flag.

- [ ] **Step 4: Run the focused tests and verify RED**

```bash
npx vitest run packages/tests/repo/repo-style-check.test.ts
```

Expected: FAIL because the rule module and CLI option are not wired yet.

---

### Task 2: Implement the AST analysis module

**Files:**

- Create: `scripts/repo-style-check/construction-rules.mjs`
- Test: `packages/tests/repo/repo-style-check.test.ts`

**Interfaces:**

- Consumes: the exact exported API and fixtures from Task 1.
- Produces: deterministic findings sorted by source location and rule ID.

- [ ] **Step 1: Parse supported source deterministically**

Use `@babel/parser` with `sourceType: 'module'`, the `typescript` plugin for TypeScript-family files, `typescript` plus `jsx` for TSX, and no language plugin for MJS. Reuse the file-extension decision already established in `layout-rules.mjs`. A parse failure must surface as the existing checker failure, not be silently ignored.

- [ ] **Step 2: Implement lexical binding and callback reference collection**

Within each function-like scope, record:

```js
{
  name,
  declarationStart,
  definite,
  initializer,
  assignmentStarts,
  referenceStarts,
}
```

Treat parameters and declarations inside a callback as callback-local. A capture is an identifier reference resolved to an outer function-like scope. Ignore property keys, type-only identifiers, import/export specifiers, labels, and non-computed member-property names.

- [ ] **Step 3: Implement `construction.forward-capture`**

For each callback directly contained in an argument to a construction call whose terminal callee name matches `create[A-Z]`, report when the callback captures a local binding whose first value-producing assignment occurs after the construction call ends. Include callbacks nested inside the construction argument object.

Do not report when the binding has an initializer before the call. Do not scan `new Promise` as a construction factory for this rule. Emit at most one finding per captured binding and construction call.

- [ ] **Step 4: Implement opt-in metrics**

When `options.details` is true:

- report each local definite-assignment declaration;
- count only function/arrow expressions that are direct arguments, or descendants of an argument object, of `CallExpression`/`NewExpression` nodes; report depth >=3 at the outermost offending callback;
- report named functions, assigned arrows, and object methods whose body contains exactly one returned call/awaited call and forwards every parameter unchanged in the same order.

Messages must contain stable numeric magnitudes for depth but must not claim the code is incorrect.

- [ ] **Step 5: Run unit fixtures and verify the module GREEN**

```bash
npx vitest run packages/tests/repo/repo-style-check.test.ts
```

Expected: the new positive, negative, default, and opt-in fixtures pass.

- [ ] **Step 6: Commit the isolated analyzer and fixtures**

```bash
git add scripts/repo-style-check/construction-rules.mjs \
  packages/tests/repo/repo-style-check.test.ts
git commit -m "feat: add construction clarity analysis"
```

---

### Task 3: Wire default and opt-in findings into both checker modes

**Files:**

- Modify: `scripts/repo-style-check/repository-scan.mjs`
- Modify: `scripts/repo-style-check.mjs`
- Modify: `scripts/check-changed-repo-style.mjs`
- Modify: `package.json`
- Modify: `packages/tests/repo/repo-style-changed-check.test.ts`
- Test: `packages/tests/repo/repo-style-check.test.ts`

**Interfaces:**

- Consumes: `scanConstructionRules(source, { details })`.
- Produces: default forward-capture findings, opt-in detail findings, and unchanged merge-base subtraction semantics.

- [ ] **Step 1: Pass file-aware sources into per-file scanning**

Change the private scanner from `scanFile(raw, options)` to `scanFile(source, options)`, destructure `file` and `raw`, then append `scanConstructionRules(source, { details: options.constructionDetails })` findings. Preserve all existing rule order and finding shapes.

- [ ] **Step 2: Add the CLI option and package command**

Add `constructionDetails: args.has('--construction-details')` to `repo-style-check.mjs` and this package script:

```json
"check:repo-style:construction-details": "node scripts/repo-style-check.mjs --construction-details"
```

Set `constructionDetails: false` explicitly in `check-changed-repo-style.mjs`; only `construction.forward-capture` participates in incremental blocking.

- [ ] **Step 3: Prove changed-file enforcement**

Add changed-check fixtures proving:

1. an unchanged legacy forward-capture finding passes;
2. a newly added forward capture fails with its rule ID;
3. removing a forward capture passes;
4. opt-in-only patterns do not fail the changed checker.

- [ ] **Step 4: Run focused checker tests**

```bash
npx vitest run \
  packages/tests/repo/repo-style-check.test.ts \
  packages/tests/repo/repo-style-changed-check.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit checker integration**

```bash
git add scripts/repo-style-check/repository-scan.mjs \
  scripts/repo-style-check.mjs \
  scripts/check-changed-repo-style.mjs \
  package.json \
  packages/tests/repo/repo-style-check.test.ts \
  packages/tests/repo/repo-style-changed-check.test.ts
git commit -m "feat: detect late-bound construction callbacks"
```

---

### Task 4: Calibrate every finding before documenting enforcement

**Files:**

- Modify only if calibration requires rule corrections: `scripts/repo-style-check/construction-rules.mjs`
- Modify corresponding tests for every correction.

**Interfaces:**

- Consumes: default and opt-in checker output across the full repository.
- Produces: reviewed warning counts with no unexplained false positives in the default rule.

- [ ] **Step 1: Capture default and detailed baselines**

```bash
npm run check:repo-style -- --root .
npm run check:repo-style:construction-details -- --root .
```

Record counts by rule ID and inspect every `construction.forward-capture` finding. Sample at least 20 findings from each opt-in rule, or all findings when fewer than 20 exist.

- [ ] **Step 2: Apply the promotion criteria**

Keep `construction.forward-capture` default only if every reported case contains a real assignment-after-capture temporal dependency. Fix parser mistakes rather than adding directory or domain allowlists.

Keep the other three rules opt-in regardless of apparent quality in this change. A later reviewed change may promote one only with documented baseline counts and examples of both true and false positives.

- [ ] **Step 3: Re-run focused tests after any correction**

```bash
npx vitest run \
  packages/tests/repo/repo-style-check.test.ts \
  packages/tests/repo/repo-style-changed-check.test.ts
```

Expected: all tests pass and the default baseline contains no semantic misclassification of assignment order.

---

### Task 5: Document checker boundaries and lock governance integrity

**Files:**

- Modify: `docs/repo-human-style-guide.md`
- Modify: `.agents/skills/rallar-code-writing/references/repo-code-style.md`
- Modify: `packages/tests/repo/repo-code-style-integrity.test.ts`
- Modify: `packages/tests/repo/repo-style-check.test.ts`

**Interfaces:**

- Consumes: calibrated rule behavior from Task 4.
- Produces: accurate user documentation and integrity assertions for rule exposure.

- [ ] **Step 1: Update the checker documentation**

Add `construction.forward-capture` to default warnings. Add `check:repo-style:construction-details` under optional noisy checks with all three opt-in rule IDs. State explicitly:

```markdown
These findings identify syntax shapes for human review. They do not prove a
construction graph is cyclic, a callback is unjustified, or a facade lacks a
real boundary.
```

- [ ] **Step 2: Update integrity tests and checker file inventory**

Assert the package command, default rule ID, opt-in rule IDs, semantic-boundary statement, and new `construction-rules.mjs` inventory entry. Preserve the test that every checker implementation file is <=400 lines with no over-100-character lines.

- [ ] **Step 3: Run governance and changed-file validation**

```bash
npm run test:repo-governance
npm run check:repo-style:changed -- origin/main HEAD
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit documentation and integrity coverage**

```bash
git add docs/repo-human-style-guide.md \
  .agents/skills/rallar-code-writing/references/repo-code-style.md \
  packages/tests/repo/repo-code-style-integrity.test.ts \
  packages/tests/repo/repo-style-check.test.ts
git commit -m "docs: explain construction checker boundaries"
```

---

### Task 6: Complete repository and publication gates

**Files:**

- Verify only; no planned file changes.

**Interfaces:**

- Consumes: the final checker branch.
- Produces: exact local and remote evidence for the same final commit.

- [ ] **Step 1: Run final local gates on the unchanged tree**

```bash
npm run test:unit
npm run test:ci
npm run build
```

Expected: all commands exit 0. Any edit after these commands invalidates them.

- [ ] **Step 2: Publish and update the draft pull request**

Push the feature branch and update its draft PR with the calibrated counts, sampled false-positive assessment, default-versus-opt-in split, and exact validation results.

- [ ] **Step 3: Record remote completion evidence**

Require **Branch Release Gate** to pass for the exact final feature commit. After merge, require **Run Hetzner Supported Distributed Manifests** to pass for the resulting default-branch commit. Record both full SHAs before marking this plan complete.
