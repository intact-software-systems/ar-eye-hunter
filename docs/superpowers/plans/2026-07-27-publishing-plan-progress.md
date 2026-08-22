# Publishing Plan Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repo-local workflow that publishes observable GitHub checkpoints during long-running implementation-plan execution without waiting for human review, while requiring independent explicit just-in-time approval for every default-branch commit and push.

**Architecture:** Keep `AGENTS.md` as the automatic router and repository-wide default-branch safety rule, and put the complete publication contract in one new repo-local skill. Extend the existing skill-integrity test so discovery, routing, branch policy, checkpoint cadence, independent default-branch commit and push gates, and the non-blocking review rule remain executable repository contracts.

**Tech Stack:** Markdown agent skills, Codex plugin JSON, Vitest, TypeScript.

## Global Constraints

- Apply this change directly on `main` as explicitly requested by the user.
- Preserve the user's durable requirement that future long-running plan execution publishes progress unless an explicit instruction narrows or disables publication.
- Use `codex/<topic>` for future agent-created feature branches.
- Default-branch edits remain uncommitted until the agent presents the exact
  local branch and operation, staged files, staged diff summary and staged Git
  tree ID from `git write-tree`, proposed messages, and affected full commit IDs
  and receives explicit just-in-time permission. Each later commit or changed
  input requires a new request.
- Default-branch commits remain local until the agent separately presents the
  exact remote, destination ref and refspec, resolved full old and new commit
  IDs, and force status and receives explicit just-in-time permission. Each
  later push or changed tip requires a new request.
- Approval to commit never grants approval to push, and approval to push never
  grants approval to commit.
- Never stage unrelated changes, secrets, generated junk, or artificial empty commits.
- Human review observes progress but does not pause plan execution by default.

Tasks 1 and 2 record completed historical work. The retained commit `b1c6ed28`
is explicitly accepted by the user. Task 3 supersedes their default-branch
commit authorization for all later work.

---

### Task 1: Enforce and document observable plan progress

**Files:**

- Create: `.agents/skills/publishing-plan-progress/SKILL.md`
- Modify: `AGENTS.md`
- Modify: `.codex-plugin/plugin.json`
- Modify: `packages/tests/repo/rallar-skill-integrity.test.ts`

**Interfaces:**

- Consumes: written implementation plans, repository Git state, the GitHub publish workflow, and explicit user instructions.
- Produces: a discoverable `publishing-plan-progress` skill plus executable routing and workflow assertions.

- [x] **Step 1: Write the failing integrity contract**

Add `publishing-plan-progress` to `expectedSkills`. Add a focused test that reads
the new skill, `AGENTS.md`, and plugin metadata and requires:

```ts
expectAll(agents, ['publishing-plan-progress', 'long-running']);
expectAll(progressSkill, [
    '`codex/<topic>`',
    'draft pull request',
    'completed plan milestone',
    'without waiting for human review',
    'Explicit user instructions'
]);
expect(plugin.interface?.longDescription).toContain('observable plan progress');
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
```

Expected: FAIL because `.agents/skills/publishing-plan-progress/SKILL.md` and
its routing do not exist yet.

- [x] **Step 3: Write the minimal skill and routing**

Create the skill with a trigger limited to written-plan execution and clearly
long-running implementation. Define this sequence:

1. inspect Git state and preserve unrelated work;
2. obey an explicit current-task branch override, otherwise create and push
   `codex/<topic>` before implementation;
3. open a draft PR after the first meaningful commit;
4. verify, commit, push, and update the draft PR after each completed milestone
   or cohesive vertical slice;
5. publish coherent progress before yielding after a substantial work interval;
6. continue without waiting for review and report publication or validation
   failures honestly.

Add a concise `AGENTS.md` routing bullet. Update plugin keywords,
`longDescription`, and one existing `defaultPrompt` entry without exceeding the
three-prompt limit.

- [x] **Step 4: Run focused verification and verify GREEN**

Run:

```bash
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts packages/tests/repo/repo-code-style-integrity.test.ts packages/tests/repo/repo-style-check.test.ts
npm run check:repo-style
```

Expected: all Vitest commands PASS. The warning-only style check exits zero;
report any warnings in changed production files.

- [x] **Step 5: Forward-test the skill**

Give an isolated read-only agent the completed skill and the same multi-day plan
scenario used for baseline testing. Expected behavior: it requires early
publication on `codex/<topic>`, a draft PR, milestone checkpoint pushes, honest
validation status, and continued execution without a review gate, while
respecting an explicit default-branch override.

- [x] **Step 6: Commit the implementation checkpoint**

```bash
git add .agents/skills/publishing-plan-progress/SKILL.md AGENTS.md .codex-plugin/plugin.json packages/tests/repo/rallar-skill-integrity.test.ts docs/superpowers/plans/2026-07-27-publishing-plan-progress.md
git commit -m "docs: publish long-running plan progress"
```

---

### Task 2: Require explicit permission before every default-branch push

**Files:**

- Modify: `AGENTS.md`
- Modify: `.agents/skills/publishing-plan-progress/SKILL.md`
- Modify: `packages/tests/repo/rallar-skill-integrity.test.ts`
- Modify: `docs/superpowers/specs/2026-07-27-publishing-plan-progress-design.md`
- Modify: `docs/superpowers/plans/2026-07-27-publishing-plan-progress.md`

- [x] **Step 1: Establish the behavioral baseline**

Confirm that the previous guidance would push the default branch without a
just-in-time permission request when the user requested work directly on it.

- [x] **Step 2: Write and run the failing integrity contract**

Require a repository-wide prohibition plus skill guidance that keeps default-
branch commits local, describes the exact remote, destination ref, commit range,
and force status, asks immediately before every push, waits for explicit
approval, and never treats silence or standing preferences as consent.

- [x] **Step 3: Add the default-branch push gate**

Add the concise durable rule to `AGENTS.md`, the operational steps to the
publication skill, and the rationale and compatibility boundary to the design.
Keep automatic checkpoint pushes unchanged when their destination refs are
non-default published branches. Require separate disclosure and approval for a
force push, and continue safe local work while default-branch publication waits.

- [x] **Step 4: Verify and pressure-test the rule**

Run the focused repository skill tests, validate the skill structure, and test
direct-default-branch, standing-publication, early-approval, and ordinary
feature-branch scenarios with an isolated agent.

- [x] **Step 5: Commit locally without pushing `main`**

Commit only the five in-scope files on `main`. Do not push the commit; a future
push requires a new, exact permission request immediately before the operation.

---

### Task 3: Require explicit permission before every default-branch commit

**Files:**

- Modify: `AGENTS.md`
- Modify: `.agents/skills/publishing-plan-progress/SKILL.md`
- Modify: `packages/tests/repo/rallar-skill-integrity.test.ts`
- Modify: `docs/superpowers/specs/2026-07-27-publishing-plan-progress-design.md`
- Modify: `docs/superpowers/plans/2026-07-27-publishing-plan-progress.md`

- [x] **Step 1: Establish the behavioral baseline**

Confirm that the prior guidance allowed cohesive local commits on an explicitly
selected default branch without an immediate permission request.

- [x] **Step 2: Write and run the failing integrity contract**

Require a repository-wide prohibition and skill procedure covering commit,
amend, merge, revert, cherry-pick, rebase, and squash operations on the local
default branch. Require exact operation details, an immediate permission
request, an explicit answer, and a new request for every later commit.

- [x] **Step 3: Add independent commit and push gates**

Make editing or working directly on the default branch insufficient commit
authorization. Keep commit permission separate from push permission and allow
safe uncommitted local work to continue while either approval is pending. Bind
commit approval to the staged diff hash and affected full commit IDs, and bind
push approval to immutable full old and new tip IDs rather than symbolic ranges.

- [x] **Step 4: Verify and pressure-test the rule**

Run the focused repository skill tests, validate the skill structure, and test
task-start branch selection, unavailable-user, approved-commit, repeated-commit,
history-editing, and separate-push-permission scenarios with an isolated agent.

- [x] **Step 5: Leave the correction uncommitted**

Keep the user-approved `b1c6ed28` commit. Do not create another commit on
`main`; leave this correction as working-tree changes until the agent presents
an exact commit and receives separate just-in-time approval.

---

### Task 4: Make completion depend on final local and published gates

**Files:**

- Modify: `AGENTS.md`
- Modify: `.agents/skills/publishing-plan-progress/SKILL.md`
- Modify: `.agents/skills/rallar-testing/SKILL.md`
- Modify: `.agents/skills/rallar-testing/references/test-commands.md`
- Modify: `.agents/skills/rallar-code-writing/SKILL.md`
- Modify: `packages/tests/repo/rallar-skill-integrity.test.ts`
- Modify: `docs/superpowers/specs/2026-07-27-publishing-plan-progress-design.md`
- Modify: `docs/superpowers/plans/2026-07-27-publishing-plan-progress.md`

- [x] **Step 1: Establish the behavioral baseline**

Record that focused test rounds allowed a plan to be treated as finished even
though the exact final branch had not passed the full unit and CI suites.

- [x] **Step 2: Write and run the failing integrity contract**

Require mandatory `npm run test:unit`, `npm run test:ci`, and `npm run build`
results plus a current draft PR and SHA-specific **Branch Release Gate** and
**Run Hetzner Supported Distributed Manifests** results.

- [x] **Step 3: Add the completion contract to active guidance**

Make focused checks non-substitutable feedback, invalidate results after later
changes, and keep a plan incomplete whenever a required command or workflow is
pending, skipped, failed, or attached to older code. A no-commit or no-push
instruction postpones remote gates but never waives them.

- [x] **Step 4: Run the final local completion commands**

Run `npm run test:unit`, `npm run test:ci`, and `npm run build` from the final
uncommitted working tree. Any subsequent change restarts this step.

Validated on 2026-07-27 from the uncommitted `main` working tree. The final
post-documentation run is the authoritative evidence; earlier focused and full
runs were diagnostic feedback only.

- [ ] **Step 5: Publish and verify the remote completion gates**

After exact just-in-time commit and push approval, keep the draft PR current,
verify **Branch Release Gate** on the final feature-branch commit, and verify
**Run Hetzner Supported Distributed Manifests** on the resulting default-branch
commit. Until then, report the plan as incomplete rather than waiving the gates.
