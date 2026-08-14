import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeSha256 } from '../../../../scripts/governance-decisions/canonical-json.mjs';
import {
  computeGovernanceDecisionId,
  decodeGovernanceDecisionRequest,
} from '../../../../scripts/governance-decisions/governance-decision-request.mjs';
import { computeGovernanceDecisionTransition } from '../../../../scripts/governance-decisions/governance-decision-transition.mjs';
import { readGitRepositorySnapshot } from '../../../../scripts/governance-decisions/git-repository-snapshot.mjs';
import { parseAdaptivePlanRecord } from '../../../../scripts/plan-adaptation/adaptive-plan-record.mjs';
import { toGovernanceDecisionFixturePlanMarkdown } from './governance-decision-fixture';

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    execFileSync('rm', ['-rf', fixture]);
  }
});

describe('governance decision transitions', () => {
  it.each([
    ['plan.cancel', 'not-achieved'],
    ['plan.complete', 'admin-attested'],
  ])('removes only the exact target plan for %s', (operation, status) => {
    const fixture = createRepositoryFixture();
    const beforePlan = readFileSync(path.join(fixture.root, fixture.planPath), 'utf8');
    const request = dispositionRequest(fixture, operation);
    const snapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.headOid,
    });

    const transition = computeGovernanceDecisionTransition({ request, snapshot });

    expect(transition.result).toEqual({ acceptanceStatus: status });
    expect(transition.deletions).toEqual([fixture.planPath]);
    expect(transition.additions).toEqual([]);
    expect(transition.stateChanges.map((change) => change.path)).toEqual([fixture.planPath]);
    expect(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8')).toBe(beforePlan);
  });

  it('repairs facts and checkpoint while preserving other state and reporting bypasses', () => {
    const fixture = createRepositoryFixture();
    const snapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.headOid,
    });
    const original = parseAdaptivePlanRecord(
      readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'),
      fixture.planPath,
    );
    original.facts.diffBase = snapshot.headOid;
    original.completedSlicesSinceCheckpoint = ['old-slice'];
    original.checkpoint.nextSlices = original.checkpoint.nextSlices.filter(
      (slice: string) => slice !== 'old-slice',
    );
    original.checkpoint.decision = 'continue';
    original.freshStructuralReview = { status: 'failed', failures: [] };
    const brokenMarkdown = toPlanMarkdown(original);
    const brokenSnapshot = replaceSnapshotEntry(snapshot, fixture.planPath, brokenMarkdown);
    const request = repairRequest(fixture, brokenMarkdown);

    const transition = computeGovernanceDecisionTransition({
      request,
      snapshot: brokenSnapshot,
      readChanges: () => [],
      readSnapshot: () => snapshot,
    });
    const repairedMarkdown = transition.additions.find(
      (addition) => addition.path === fixture.planPath,
    )!.content;
    const repaired = parseAdaptivePlanRecord(repairedMarkdown, fixture.planPath);

    expect(repaired.goal).toBe(original.goal);
    expect(repaired.acceptanceCriteria).toEqual(original.acceptanceCriteria);
    expect(repaired.architecture).toEqual(original.architecture);
    expect(repaired.completedSlicesSinceCheckpoint).toEqual(['old-slice']);
    expect(repaired.checkpoint).toEqual(request.payload.checkpoint);
    expect(transition.additions.map((addition) => addition.path)).toEqual([fixture.planPath]);
    expect(repaired.facts.affectedCodeDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(repaired.materialDecisions).toHaveLength(original.materialDecisions.length + 1);
    expect(repaired.materialDecisions.at(-1)).toMatchObject({
      decision: 'amend',
      summary: request.payload.checkpoint.outcome,
    });
    expect(transition.bypassedInvariants).toEqual([...transition.bypassedInvariants].sort());
    expect(transition.bypassedInvariants).toContain(
      'existing checkpoint: continue is invalid while an unrecoverable navigation or ownership failure is known',
    );
  });

  it('reports every forced replacement-checkpoint domain invariant', () => {
    const fixture = createRepositoryFixture();
    const snapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.headOid,
    });
    const markdown = readFileSync(path.join(fixture.root, fixture.planPath), 'utf8');
    const record = parseAdaptivePlanRecord(markdown, fixture.planPath);
    record.facts.diffBase = snapshot.headOid;
    record.freshStructuralReview = {
      status: 'failed',
      failures: [
        {
          kind: 'ownership',
          summary: 'The active ownership boundary is unrecoverable.',
          recoverable: false,
          deepenedBySlices: [],
        },
      ],
    };
    const invalidMarkdown = toPlanMarkdown(record);
    const invalidSnapshot = replaceSnapshotEntry(snapshot, fixture.planPath, invalidMarkdown);
    const request = decodeGovernanceDecisionRequest({
      ...repairRequest(fixture, invalidMarkdown),
      payload: {
        checkpoint: {
          outcome: 'Force continuation.',
          learning: 'Administrative override.',
          structure: 'Leave structure unchanged.',
          decision: 'continue',
          nextSlices: ['next-slice'],
        },
      },
    });

    const transition = computeGovernanceDecisionTransition({
      request,
      snapshot: invalidSnapshot,
      readChanges: () => [],
      readSnapshot: () => snapshot,
    });

    expect(transition.bypassedInvariants).toContain(
      'replacement checkpoint: continue is invalid while an unrecoverable navigation or ownership failure is known',
    );
  });

  it('computes repair facts from the exact candidate plan tree', () => {
    const fixture = createRepositoryFixture({
      planPath: 'plans/governance-lifecycle-recovery.md',
    });
    const snapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.headOid,
    });
    const record = parseAdaptivePlanRecord(
      readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'),
      fixture.planPath,
    );
    record.facts.diffBase = snapshot.headOid;
    const markdown = toPlanMarkdown(record);
    const currentSnapshot = replaceSnapshotEntry(snapshot, fixture.planPath, markdown);

    const transition = computeGovernanceDecisionTransition({
      request: repairRequest(fixture, markdown),
      snapshot: currentSnapshot,
      readChanges: () => [],
      readSnapshot: () => snapshot,
    });
    const repaired = parseAdaptivePlanRecord(
      transition.additions.find((addition) => addition.path === fixture.planPath)!.content,
      fixture.planPath,
    );

    expect(repaired.facts.computedTriggers).toContain('lifecycle-change');
  });

  it('computes repair facts only from the target plan ownership', () => {
    const fixture = createRepositoryFixture();
    const baseSnapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.headOid,
    });
    const target = parseAdaptivePlanRecord(
      readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'),
      fixture.planPath,
    );
    target.facts.diffBase = fixture.headOid;
    const targetMarkdown = toPlanMarkdown(target);
    const second = structuredClone(target);
    second.planId = 'second-plan';
    second.capabilities[0] = {
      ...second.capabilities[0],
      owner: 'second owner',
      root: 'scripts/second',
      entry: 'scripts/second.mjs',
      testRoot: 'packages/tests/repo/second',
      navigationMap: null,
    };
    const secondPath = 'plans/second-plan.md';
    const secondMarkdown = toPlanMarkdown(second);
    const currentSnapshot = replaceSnapshotEntry(
      {
        ...baseSnapshot,
        entries: [
          ...baseSnapshot.entries,
          snapshotEntry(secondPath, secondMarkdown),
          snapshotEntry('scripts/second/change.mjs', 'export const second = true;\n'),
        ],
      },
      fixture.planPath,
      targetMarkdown,
    );

    const transition = computeGovernanceDecisionTransition({
      request: repairRequest(fixture, targetMarkdown),
      snapshot: currentSnapshot,
      readSnapshot: () => baseSnapshot,
      readChanges: () => [
        { status: 'M', path: fixture.planPath, oldMode: '100644', newMode: '100644' },
        { status: 'A', path: secondPath, oldMode: '000000', newMode: '100644' },
        {
          status: 'A',
          path: 'scripts/second/change.mjs',
          oldMode: '000000',
          newMode: '100644',
        },
      ],
    });
    const repaired = parseAdaptivePlanRecord(
      transition.additions.find((addition) => addition.path === fixture.planPath)!.content,
      fixture.planPath,
    );

    expect(repaired.facts.undeclaredChangedPaths).toEqual([]);
  });

  it('reports a forced second autonomous consolidation as a bypassed invariant', () => {
    const fixture = createRepositoryFixture();
    const snapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.headOid,
    });
    const markdown = readFileSync(path.join(fixture.root, fixture.planPath), 'utf8');
    const record = parseAdaptivePlanRecord(markdown, fixture.planPath);
    record.facts.diffBase = snapshot.headOid;
    record.materialDecisions.push({
      date: '2026-08-12',
      decision: 'consolidate',
      summary: 'The prior autonomous consolidation was selected.',
      checkpointDigest: 'a'.repeat(64),
    });
    const priorConsolidationMarkdown = toPlanMarkdown(record);
    const priorConsolidationSnapshot = replaceSnapshotEntry(
      snapshot,
      fixture.planPath,
      priorConsolidationMarkdown,
    );
    const request = decodeGovernanceDecisionRequest({
      ...repairRequest(fixture, priorConsolidationMarkdown),
      payload: {
        checkpoint: {
          outcome: 'Force another consolidation.',
          learning: 'Administrative override.',
          structure: 'One more bounded consolidation is required.',
          decision: 'consolidate',
          nextSlices: ['second-consolidation'],
        },
      },
    });

    const transition = computeGovernanceDecisionTransition({
      request,
      snapshot: priorConsolidationSnapshot,
      readChanges: () => [],
      readSnapshot: () => snapshot,
    });

    expect(transition.bypassedInvariants).toContain(
      'replacement checkpoint: only one autonomous consolidation slice is allowed',
    );
  });

  it('supersedes through the injected blob reader and installs one valid active successor', () => {
    const fixture = createRepositoryFixture();
    const snapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.headOid,
    });
    const successorPath = 'plans/successor.md';
    const predecessor = parseAdaptivePlanRecord(
      readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'),
      fixture.planPath,
    );
    const successor = structuredClone(predecessor);
    successor.planId = 'successor';
    successor.capabilities[0].activation = {
      state: 'planned',
      slice: 'successor-slice',
    };
    successor.checkpoint.nextSlices = ['successor-slice'];
    const successorMarkdown = toPlanMarkdown(successor);
    const successorBlobOid = computeGitBlobOid(successorMarkdown);
    const request = decodeGovernanceDecisionRequest({
      ...commonRequest(fixture, 'plan.supersede'),
      target: {
        planPath: fixture.planPath,
        planDigest: computeSha256(readFileSync(path.join(fixture.root, fixture.planPath))),
      },
      payload: { successorPlanPath: successorPath, successorPlanBlobOid: successorBlobOid },
    });
    const readBlobCalls: string[] = [];

    const transition = computeGovernanceDecisionTransition({
      request,
      snapshot,
      readBlob(blobOid) {
        readBlobCalls.push(blobOid);
        return successorMarkdown;
      },
    });

    expect(readBlobCalls).toEqual([successorBlobOid]);
    expect(transition.result).toEqual({ acceptanceStatus: 'transferred' });
    expect(transition.deletions).toEqual([fixture.planPath]);
    expect(transition.additions.map((addition) => addition.path)).toEqual([successorPath]);
    expect(transition.additions.find((addition) => addition.path === successorPath)?.content).toBe(
      successorMarkdown,
    );
    const multiplePlans = `${successorMarkdown}\n${successorMarkdown}`;
    const multiplePlansRequest = decodeGovernanceDecisionRequest({
      ...request,
      payload: {
        ...request.payload,
        successorPlanBlobOid: computeGitBlobOid(multiplePlans),
      },
    });
    expect(() =>
      computeGovernanceDecisionTransition({
        request: multiplePlansRequest,
        snapshot,
        readBlob: () => multiplePlans,
      }),
    ).toThrow('exactly one plan-adaptation-v1 block');

    const occupiedSnapshot = {
      ...snapshot,
      entries: [
        ...snapshot.entries,
        {
          path: successorPath,
          mode: '100644',
          blobOid: computeGitBlobOid('occupied\n'),
          content: 'occupied\n',
        },
      ],
    };
    expect(() =>
      computeGovernanceDecisionTransition({
        request,
        snapshot: occupiedSnapshot,
        readBlob: () => successorMarkdown,
      }),
    ).toThrow('successorPlanPath already exists at expected head');
  });

  it('quarantines an unreadable plan only at its exact blob identity', () => {
    const fixture = createRepositoryFixture({ planMarkdown: 'not a valid adaptive plan\n' });
    const snapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.headOid,
    });
    const entry = snapshot.entries.find(({ path: entryPath }) => entryPath === fixture.planPath)!;
    const request = decodeGovernanceDecisionRequest({
      ...commonRequest(fixture, 'plan.quarantine'),
      target: { planPath: fixture.planPath, planBlobOid: entry.blobOid },
      payload: {},
    });

    const transition = computeGovernanceDecisionTransition({ request, snapshot });

    expect(transition.result).toEqual({ acceptanceStatus: 'unknown' });
    expect(transition.deletions).toEqual([fixture.planPath]);
    expect(() =>
      computeGovernanceDecisionTransition({
        request: decodeGovernanceDecisionRequest({
          ...request,
          target: { ...request.target, planBlobOid: 'f'.repeat(40) },
        }),
        snapshot,
      }),
    ).toThrow('target plan blob identity does not match expected head');
  });

  it('fails closed for stale heads, symlink plans, and duplicate receipt paths', () => {
    const fixture = createRepositoryFixture();
    const snapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.headOid,
    });
    const request = dispositionRequest(fixture, 'plan.cancel');

    expect(() =>
      computeGovernanceDecisionTransition({
        request: decodeGovernanceDecisionRequest({
          ...request,
          expectedHeadOid: 'f'.repeat(40),
        }),
        snapshot,
      }),
    ).toThrow('expected head does not match repository snapshot');

    const symlinkSnapshot = replaceSnapshotEntry(snapshot, fixture.planPath, 'outside', '120000');
    expect(() =>
      computeGovernanceDecisionTransition({ request, snapshot: symlinkSnapshot }),
    ).toThrow('target plan must not be a symbolic link');

    const receiptSnapshot = {
      ...snapshot,
      entries: [
        ...snapshot.entries,
        {
          path: `governance/decisions/${computeGovernanceDecisionId(request)}.json`,
          mode: '100644',
          blobOid: 'e'.repeat(40),
          content: '{}\n',
        },
      ],
    };
    expect(() =>
      computeGovernanceDecisionTransition({ request, snapshot: receiptSnapshot }),
    ).toThrow('decision receipt path already exists');
  });

  it('never bypasses plan schema defects outside domain checkpoint policy', () => {
    const fixture = createRepositoryFixture();
    const snapshot = readGitRepositorySnapshot({
      repoRoot: fixture.root,
      commitOid: fixture.headOid,
    });
    const record = parseAdaptivePlanRecord(
      readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'),
      fixture.planPath,
    );
    record.facts.diffBase = snapshot.headOid;
    record.goal = '';
    const invalidMarkdown = toPlanMarkdown(record);
    const invalidSnapshot = replaceSnapshotEntry(snapshot, fixture.planPath, invalidMarkdown);

    expect(() =>
      computeGovernanceDecisionTransition({
        request: repairRequest(fixture, invalidMarkdown),
        snapshot: invalidSnapshot,
        readChanges: () => [],
        readSnapshot: () => snapshot,
      }),
    ).toThrow('target plan contains non-bypassable schema defects: record.goal');
  });
});

function createRepositoryFixture(options: { planMarkdown?: string; planPath?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'governance-decisions-'));
  fixtures.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: root });
  const planPath = options.planPath ?? 'plans/authenticated-governance-decisions.md';
  execFileSync('mkdir', ['-p', 'plans'], { cwd: root });
  const planMarkdown = options.planMarkdown ?? toGovernanceDecisionFixturePlanMarkdown();
  writeFileSync(path.join(root, planPath), planMarkdown);
  writeFileSync(path.join(root, 'plans/README.md'), '# Adaptive plans\n\nStatic navigation.\n');
  writeFileSync(
    path.join(root, 'plans/policy.json'),
    '{"schemaVersion":"adaptive-plan-policy-v1","maxActivePlans":8}\n',
  );
  writeFileSync(path.join(root, 'unrelated.txt'), 'preserve me\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-08-13T10:00:00Z',
      GIT_COMMITTER_DATE: '2026-08-13T10:00:00Z',
    },
  });
  const headOid = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return { root, planPath, headOid };
}

function dispositionRequest(
  fixture: ReturnType<typeof createRepositoryFixture>,
  operation: string,
) {
  const plan = readFileSync(path.join(fixture.root, fixture.planPath));
  return decodeGovernanceDecisionRequest({
    ...commonRequest(fixture, operation),
    target: { planPath: fixture.planPath, planDigest: computeSha256(plan) },
    payload: {},
  });
}

function repairRequest(
  fixture: ReturnType<typeof createRepositoryFixture>,
  currentMarkdown: string,
) {
  return decodeGovernanceDecisionRequest({
    ...commonRequest(fixture, 'plan.repair'),
    target: { planPath: fixture.planPath, planDigest: computeSha256(currentMarkdown) },
    payload: {
      checkpoint: {
        outcome: 'Recovered truthful plan state.',
        learning: 'Facts are recomputed from the full candidate tree.',
        structure: 'The existing owner remains coherent.',
        decision: 'amend',
        nextSlices: ['next-slice'],
      },
    },
  });
}

function commonRequest(fixture: ReturnType<typeof createRepositoryFixture>, operation: string) {
  return {
    schemaVersion: 'governance-decision-request-v1',
    operation,
    repository: 'intact-software-systems/ar-eye-hunter',
    defaultBranch: 'main',
    expectedHeadOid: fixture.headOid,
    force: true,
    reason: 'Administrator disposition is required.',
  };
}

function toPlanMarkdown(record: object) {
  return `# Fixture plan\n\n\`\`\`plan-adaptation-v1\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
}

function computeGitBlobOid(content: string) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'governance-blob-'));
  fixtures.push(fixture);
  return execFileSync('git', ['hash-object', '--stdin'], {
    input: content,
    encoding: 'utf8',
  }).trim();
}

function replaceSnapshotEntry(snapshot: any, entryPath: string, content: string, mode = '100644') {
  return {
    ...snapshot,
    entries: snapshot.entries.map((entry: any) =>
      entry.path === entryPath
        ? { ...entry, mode, content, blobOid: computeGitBlobOid(content) }
        : entry,
    ),
  };
}

function snapshotEntry(entryPath: string, content: string) {
  return { path: entryPath, mode: '100644', content, blobOid: computeGitBlobOid(content) };
}
