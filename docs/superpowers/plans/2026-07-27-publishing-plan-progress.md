# Publishing Plan Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repo-local workflow that publishes observable GitHub checkpoints during long-running implementation-plan execution without waiting for human review, while requiring explicit just-in-time approval for every default-branch push.

**Architecture:** Keep `AGENTS.md` as the automatic router and repository-wide default-branch safety rule, and put the complete publication contract in one new repo-local skill. Extend the existing skill-integrity test so discovery, routing, branch policy, checkpoint cadence, the default-branch push gate, and the non-blocking review rule remain executable repository contracts.

**Tech Stack:** Markdown agent skills, Codex plugin JSON, Vitest, TypeScript.

## Global Constraints

- Apply this change directly on `main` as explicitly requested by the user.
- Preserve the user's durable requirement that future long-running plan execution publishes progress unless an explicit instruction narrows or disables publication.
- Use `codex/<topic>` for future agent-created feature branches.
- Work and commits on the default branch remain local until the agent presents
  the exact remote, destination ref, commit range, and force status and receives
  explicit just-in-time permission. Each later push requires a new request and
  approval.
- Never stage unrelated changes, secrets, generated junk, or artificial empty commits.
- Human review observes progress but does not pause plan execution by default.

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

- [ ] **Step 1: Write the failing integrity contract**

Add `publishing-plan-progress` to `expectedSkills`. Add a focused test that reads
the new skill, `AGENTS.md`, and plugin metadata and requires:

```ts
expectAll(agents, ['publishing-plan-progress', 'long-running']);
expectAll(progressSkill, [
  '`codex/<topic>`',
  'draft pull request',
  'completed plan milestone',
  'without waiting for human review',
  'Explicit user instructions',
]);
expect(plugin.interface?.longDescription).toContain('observable plan progress');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
```

Expected: FAIL because `.agents/skills/publishing-plan-progress/SKILL.md` and
its routing do not exist yet.

- [ ] **Step 3: Write the minimal skill and routing**

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

- [ ] **Step 4: Run focused verification and verify GREEN**

Run:

```bash
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts packages/tests/repo/repo-code-style-integrity.test.ts packages/tests/repo/repo-style-check.test.ts
npm run check:repo-style
```

Expected: all Vitest commands PASS. The warning-only style check exits zero;
report any warnings in changed production files.

- [ ] **Step 5: Forward-test the skill**

Give an isolated read-only agent the completed skill and the same multi-day plan
scenario used for baseline testing. Expected behavior: it requires early
publication on `codex/<topic>`, a draft PR, milestone checkpoint pushes, honest
validation status, and continued execution without a review gate, while
respecting an explicit default-branch override.

- [ ] **Step 6: Commit the implementation checkpoint**

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
