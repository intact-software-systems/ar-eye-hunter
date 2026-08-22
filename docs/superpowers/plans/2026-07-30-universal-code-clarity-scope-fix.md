# Universal Code Clarity Scope Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the human-readability, construction, callback, naming, and testability guidance explicitly govern all human-authored code while retaining TypeScript-specific rules as language additions.

**Architecture:** Keep `AGENTS.md` as the universal entry point, make the `rallar-code-writing` skill trigger for every human-authored code change, and distinguish universal structural doctrine from TypeScript mechanics in the authoritative reference and review guide. Do not create another competing style standard.

**Tech Stack:** Markdown, repo-local Codex skills, Vitest governance tests.

## Global Constraints

- Execute on `codex/universal-code-clarity-guidance` before it is merged. Begin only when the worktree is clean and the local branch matches its remote tip.
- Change governance documentation and its integrity tests only; do not change production code, checker behavior, public APIs, or runtime behavior.
- “All code” means all human-authored source, scripts, tests, fixtures, examples, configuration code, and support tooling regardless of language or directory.
- Language-specific rules apply only when that language is used; they may tighten but never relax the universal human-understandability rules.
- Preserve existing domain-specific doctrine, including AppInbox and product-boundary rules.
- Keep one authority chain: `AGENTS.md` -> `rallar-code-writing` -> `repo-code-style.md` -> `repo-human-style-guide.md`.

---

### Task 1: Lock the universal scope contract with failing governance tests

**Files:**

- Modify: `packages/tests/repo/repo-code-style-integrity.test.ts`

**Interfaces:**

- Consumes: the four authority documents named in the global authority chain.
- Produces: regression assertions that reject a TypeScript-only interpretation of the universal structural rules.

- [ ] **Step 1: Add a focused failing test**

Add a test named `applies universal human-readability doctrine to every human-authored code surface`. It must read `AGENTS.md`, the skill, authoritative standard, and human guide, then assert these exact concepts:

```ts
expectAll(agents, [
    'all human-authored code',
    'ownership, dataflow, decisions, side effects, failures, and call paths'
]);
expectAll(codeWriting, ['all human-authored code', 'TypeScript-specific rules']);
expectAll(canonicalStyle, [
    'Universal structural rules',
    'all human-authored code',
    'TypeScript-specific rules'
]);
expectAll(humanGuide, ['all human-authored code', 'TypeScript checker']);
```

Also assert that the skill frontmatter description contains `all human-authored code` so Codex selects it outside TypeScript work.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run packages/tests/repo/repo-code-style-integrity.test.ts
```

Expected: FAIL because the current skill, reference, and review guide still describe their scope as TypeScript-only.

---

### Task 2: Make the authority chain universal without duplicating doctrine

**Files:**

- Modify: `AGENTS.md`
- Modify: `.agents/skills/rallar-code-writing/SKILL.md`
- Modify: `.agents/skills/rallar-code-writing/references/repo-code-style.md`
- Modify: `docs/repo-human-style-guide.md`
- Test: `packages/tests/repo/repo-code-style-integrity.test.ts`

**Interfaces:**

- Consumes: the failing assertions from Task 1.
- Produces: one universal doctrine with TypeScript-specific mechanics clearly identified as additions.

- [ ] **Step 1: Clarify the universal entry point in `AGENTS.md`**

In `Primary Code Goal`, add one compact paragraph with this meaning:

```markdown
These human-understandability rules govern all human-authored code, including
source, scripts, tests, examples, configuration code, and support tooling. A
language-specific standard may add mechanics for that language but may not
relax visible ownership, dataflow, decisions, side effects, failures, or call
paths.
```

Keep the existing TypeScript routing sentence immediately afterward.

- [ ] **Step 2: Expand the skill trigger and separate universal from TypeScript rules**

Change the skill frontmatter description to begin:

```yaml
description: Use when writing, generating, refactoring, or reviewing any human-authored code in the Rallar repository; TypeScript-specific rules also apply to TypeScript surfaces.
```

In `Start Here`, state that the first principle, construction/callback rules, responsibility boundaries, explicit dataflow, and testability doctrine apply to all human-authored code. State separately that TypeScript changes must read and follow every TypeScript-specific section of `repo-code-style.md`.

Do not duplicate the construction or callback rules in the skill; retain the workflow and checklist as the executable summary.

- [ ] **Step 3: Split universal and language-specific scope in the authoritative reference**

Replace the opening TypeScript-only sentence and first scope bullet with an explicit two-layer contract:

```markdown
Universal structural rules in this standard govern all human-authored code in
the repository. TypeScript-specific rules additionally govern TypeScript and
JavaScript-family source where their syntax and tooling apply.
```

Identify the universal sections by name: first principle, construction/dependencies/callbacks, functional dataflow/state, services/responsibility boundaries, decision depth, comments, and review. Do not rewrite their content or create a second reference file.

- [ ] **Step 4: Generalize the human review workflow while isolating checker scope**

Change the guide introduction to `all human-authored code`. At the start of `Warning-only checker`, call it the `TypeScript checker` and state that it automates only syntax it can parse; the preceding human sequence remains language-neutral.

Keep all existing checker commands and exclusions unchanged.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
npx vitest run packages/tests/repo/repo-code-style-integrity.test.ts
npm run test:repo-governance
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the cohesive scope correction**

Stage only the five files in this task and commit:

```bash
git add AGENTS.md \
  .agents/skills/rallar-code-writing/SKILL.md \
  .agents/skills/rallar-code-writing/references/repo-code-style.md \
  docs/repo-human-style-guide.md \
  packages/tests/repo/repo-code-style-integrity.test.ts
git commit -m "docs: apply code clarity guidance universally"
```

---

### Task 3: Complete repository and publication gates

**Files:**

- Verify only; no planned file changes.

**Interfaces:**

- Consumes: the final committed scope correction.
- Produces: exact local and remote evidence for the same commit SHA.

- [ ] **Step 1: Run final local gates on the unchanged tree**

```bash
npm run test:unit
npm run test:ci
npm run build
```

Expected: all commands exit 0. Any edit after these commands invalidates them.

- [ ] **Step 2: Publish and update the draft pull request**

Push the feature branch, open or update a draft PR, and include the scope contract, exact changed files, and validation results in the PR body.

- [ ] **Step 3: Record remote completion evidence**

Require **Branch Release Gate** to pass for the exact feature commit. After merge, require **Run Hetzner Supported Distributed Manifests** to pass for the resulting default-branch commit. Record both full SHAs; do not mark this plan complete before both workflows pass.
