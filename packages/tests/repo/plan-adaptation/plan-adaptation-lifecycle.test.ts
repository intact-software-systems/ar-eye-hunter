import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const sourceRoot = process.cwd();
const entryPath = path.join(sourceRoot, 'scripts/plan-adaptation.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plan adaptation CLI lifecycle', () => {
  it('writes the live overview only to the ignored plan-adaptation directory', () => {
    const fixture = createLifecycleRepository();
    const readmePath = path.join(fixture.root, 'plans/README.md');
    const readmeBefore = readFileSync(readmePath, 'utf8');

    const result = runCli(fixture.root, ['overview']);

    expect(result.status, result.stdout).toBe(0);
    expect(readFileSync(readmePath, 'utf8')).toBe(readmeBefore);
    expect(readFileSync(path.join(fixture.root, '.plan-adaptation/overview.md'), 'utf8')).toContain(
      'Capacity: 1/8 active, 0 postponed, 7 available.',
    );
    expect(runGit(fixture.root, ['check-ignore', '.plan-adaptation/overview.md'])).toContain(
      '.plan-adaptation/overview.md',
    );
  });

  it('postpones without current facts and resumes with refreshed target facts', () => {
    const fixture = createLifecycleRepository();
    const readmePath = path.join(fixture.root, 'plans/README.md');
    const readmeBefore = readFileSync(readmePath, 'utf8');

    const postponed = runCli(fixture.root, [
      'postpone',
      '--plan',
      fixture.planPath,
      '--reason',
      'Serialize conflicting governance ownership.',
    ]);

    expect(postponed.status, postponed.stdout).toBe(0);
    let record = parseRecord(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'));
    expect(record.status).toBe('postponed');
    expect(record.materialDecisions.at(-1)).toEqual(
      expect.objectContaining({
        decision: 'postpone',
        summary: 'Serialize conflicting governance ownership.',
      }),
    );
    expect(readFileSync(readmePath, 'utf8')).toBe(readmeBefore);
    expect(
      runCli(fixture.root, ['prepare', '--plan', fixture.planPath, '--base', fixture.base]).stdout,
    ).toContain('prepare requires an active plan');

    const resumed = runCli(fixture.root, [
      'resume',
      '--plan',
      fixture.planPath,
      '--base',
      fixture.base,
      '--reason',
      'Ownership is disjoint again.',
    ]);

    expect(resumed.status, resumed.stdout).toBe(0);
    record = parseRecord(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'));
    expect(record.status).toBe('active');
    expect(record.facts.diffBase).toBe(fixture.base);
    expect(record.facts.affectedCodeDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.facts.affectedCodeDigest).not.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(record.materialDecisions.at(-1)).toEqual(
      expect.objectContaining({ decision: 'resume', summary: 'Ownership is disjoint again.' }),
    );
    expect(readFileSync(readmePath, 'utf8')).toBe(readmeBefore);
  });

  it('rejects resume when it would exceed capacity or restore mutable overlap', () => {
    const fixture = createLifecycleRepository();
    const second = createRecord();
    second.planId = 'second-plan';
    second.status = 'postponed';
    second.capabilities[0].owner = 'second owner';
    writeFixture(fixture.root, 'plans/second-plan.md', `# Second plan\n\n${recordBlock(second)}\n`);
    writeFixture(
      fixture.root,
      'plans/policy.json',
      '{"schemaVersion":"adaptive-plan-policy-v1","maxActivePlans":1}\n',
    );

    expect(
      runCli(fixture.root, [
        'resume',
        '--plan',
        'plans/second-plan.md',
        '--base',
        fixture.base,
        '--reason',
        'Try to resume.',
      ]).stdout,
    ).toContain('active plan capacity 2/1 exceeded');

    writeFixture(
      fixture.root,
      'plans/policy.json',
      '{"schemaVersion":"adaptive-plan-policy-v1","maxActivePlans":8}\n',
    );
    expect(
      runCli(fixture.root, [
        'resume',
        '--plan',
        'plans/second-plan.md',
        '--base',
        fixture.base,
        '--reason',
        'Try to resume.',
      ]).stdout,
    ).toContain('mutable ownership overlap');
  });

  it('allows only plan-only progress while a catalog remains invalid', () => {
    const fixture = createLifecycleRepository();
    for (const planId of ['second-plan', 'third-plan']) {
      const record = createRecord();
      record.planId = planId;
      record.capabilities[0].owner = `${planId} owner`;
      writeFixture(fixture.root, `plans/${planId}.md`, `# ${planId}\n\n${recordBlock(record)}\n`);
    }
    runGit(fixture.root, ['add', '.']);
    runGit(fixture.root, ['commit', '--quiet', '-m', 'invalid overlapping catalog']);
    const invalidBase = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();

    expect(
      runCli(fixture.root, [
        'postpone',
        '--plan',
        'plans/third-plan.md',
        '--reason',
        'Reduce the catalog overlap.',
      ]).status,
    ).toBe(0);
    expect(runCli(fixture.root, ['check', '--base', invalidBase]).status).toBe(0);

    writeFixture(fixture.root, 'packages/unrelated/product.ts', 'export const product = true;\n');
    const unrelated = runCli(fixture.root, ['check', '--base', invalidBase]);
    expect(unrelated.status).toBe(1);
    expect(unrelated.stdout).toContain('catalog recovery may change only plan governance paths');

    rmSync(path.join(fixture.root, 'packages/unrelated/product.ts'));
    expect(
      runCli(fixture.root, [
        'postpone',
        '--plan',
        'plans/second-plan.md',
        '--reason',
        'Resolve the final catalog overlap.',
      ]).status,
    ).toBe(0);
    expect(runCli(fixture.root, ['check', '--base', invalidBase]).status).toBe(0);
  });

  it('isolates facts for disjoint active plans and reports unassigned qualifying scope', () => {
    const fixture = createLifecycleRepository();
    const second = createRecord();
    second.planId = 'second-plan';
    second.capabilities[0] = {
      ...second.capabilities[0],
      owner: 'second owner',
      root: 'packages/second',
      entry: 'packages/second/index.ts',
      testRoot: 'packages/tests/second',
      navigationMap: null,
    };
    writeFixture(fixture.root, 'plans/second-plan.md', `# Second plan\n\n${recordBlock(second)}\n`);
    writeFixture(
      fixture.root,
      '.agents/evaluations/navigation/rubric.json',
      '{"result":"initial navigation evidence"}\n',
    );
    runGit(fixture.root, ['add', '.']);
    runGit(fixture.root, ['commit', '--quiet', '-m', 'two plan base']);
    const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    writeFixture(
      fixture.root,
      'scripts/plan-adaptation/first-change.mjs',
      'export const first = true;\n',
    );
    writeFixture(fixture.root, 'packages/second/change.ts', 'export const second = true;\n');

    expect(runCli(fixture.root, ['init', '--plan', fixture.planPath, '--base', base]).status).toBe(
      0,
    );
    expect(
      runCli(fixture.root, ['init', '--plan', 'plans/second-plan.md', '--base', base]).status,
    ).toBe(0);
    const evidenceOnlyChange = runCli(fixture.root, ['check', '--base', base]);
    expect(evidenceOnlyChange.status, evidenceOnlyChange.stdout).toBe(0);

    writeFixture(
      fixture.root,
      '.agents/evaluations/navigation/rubric.json',
      '{"result":"updated navigation evidence"}\n',
    );
    const evaluationChange = runCli(fixture.root, ['check', '--base', base]);
    expect(evaluationChange.status, evaluationChange.stdout).toBe(0);

    writeFixture(
      fixture.root,
      'scripts/plan-adaptation/later-first-change.mjs',
      'export const later = true;\n',
    );
    expect(runCli(fixture.root, ['init', '--plan', fixture.planPath, '--base', base]).status).toBe(
      0,
    );
    const refreshedFirstPlan = runCli(fixture.root, ['check', '--base', base]);
    expect(refreshedFirstPlan.status, refreshedFirstPlan.stdout).toBe(0);

    writeFixture(
      fixture.root,
      'packages/unassigned/new-owner.ts',
      'export const unassigned = true;\n',
    );
    const unassigned = runCli(fixture.root, ['check', '--base', base]);
    expect(unassigned.status).toBe(1);
    expect(unassigned.stdout).toContain(
      'unassigned qualifying scope: packages/unassigned/new-owner.ts; candidate plans: fixture-plan, second-plan',
    );

    expect(
      runCli(fixture.root, ['prepare', '--plan', fixture.planPath, '--base', base]).status,
    ).toBe(0);
    const draft = JSON.parse(
      readFileSync(path.join(fixture.root, '.plan-adaptation/fixture-plan.draft.json'), 'utf8'),
    );
    expect(draft.record.facts.undeclaredChangedPaths).toContain('packages/unassigned/new-owner.ts');
    expect(draft.record.facts.undeclaredChangedPaths).not.toContain(
      '.agents/evaluations/navigation/rubric.json',
    );
  });

  it('runs init, complete-slice, prepare, apply, check, and close through real files', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];
    const readmeBefore = readFileSync(path.join(fixture.root, 'plans/README.md'), 'utf8');

    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);
    expect(readFileSync(path.join(fixture.root, 'plans/README.md'), 'utf8')).toBe(readmeBefore);

    expect(runCli(fixture.root, ['complete-slice', ...common, '--slice', 'slice-one']).status).toBe(
      0,
    );
    const completedPlan = parseRecord(
      readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'),
    );
    expect(completedPlan.completedSlicesSinceCheckpoint).toEqual(['slice-one']);
    expect(completedPlan.checkpoint.nextSlices).toEqual(['slice-two']);
    expect(readFileSync(path.join(fixture.root, 'plans/README.md'), 'utf8')).toBe(readmeBefore);
    expect(runCli(fixture.root, ['prepare', ...common]).status).toBe(0);

    const draftPath = path.join(fixture.root, '.plan-adaptation/fixture-plan.draft.json');
    const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
    expect(draft.record.completedSlicesSinceCheckpoint).toEqual(['slice-one']);
    expect(draft.record.facts.affectedCodeDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(draft.record.facts.undeclaredChangedPaths).toEqual([]);
    expect(draft.record.checkpoint).toEqual({
      outcome: '',
      learning: '',
      structure: '',
      decision: '',
      nextSlices: [],
    });
    draft.record.checkpoint = {
      outcome: 'The first slice now owns the canonical lifecycle.',
      learning: 'Content tuples keep review freshness independent of commit identity.',
      structure: 'The thin entry routes into one cohesive plan-adaptation owner.',
      decision: 'amend',
      nextSlices: ['slice-two'],
    };
    writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`);

    expect(runCli(fixture.root, ['apply', ...common]).status).toBe(0);
    expect(existsSync(draftPath)).toBe(false);
    const appliedPlan = readFileSync(path.join(fixture.root, fixture.planPath), 'utf8');
    expect(appliedPlan).toContain('"decision": "amend"');
    expect(appliedPlan).toContain('"completedSlicesSinceCheckpoint": []');

    const beforeCheck = snapshotTrackedFiles(fixture.root);
    expect(runCli(fixture.root, ['check', ...common]).status).toBe(0);
    expect(snapshotTrackedFiles(fixture.root)).toEqual(beforeCheck);
    runGit(fixture.root, ['add', '.']);
    runGit(fixture.root, ['commit', '--quiet', '-m', 'complete fixture plan']);
    const closeBase = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();

    const evidenceRelativePath = 'final-pr-evidence.json';
    const evidencePath = path.join(fixture.root, evidenceRelativePath);
    const record = parseRecord(appliedPlan);
    writeFileSync(
      evidencePath,
      JSON.stringify({
        version: 1,
        planId: 'fixture-plan',
        pullRequestUrl: 'https://github.com/example/repository/pull/1',
        finalReview: { status: 'complete', planDigest: recordDigest(record) },
      }),
    );
    expect(
      runCli(fixture.root, [
        'close',
        '--plan',
        fixture.planPath,
        '--base',
        closeBase,
        '--final-pr-evidence',
        evidenceRelativePath,
      ]).status,
    ).toBe(0);
    expect(existsSync(path.join(fixture.root, fixture.planPath))).toBe(false);
    expect(readFileSync(path.join(fixture.root, 'plans/README.md'), 'utf8')).toBe(readmeBefore);
    expect(
      JSON.parse(readFileSync(path.join(fixture.root, 'plans/fixture-plan.closure.json'), 'utf8')),
    ).toEqual({
      schemaVersion: 'plan-adaptation-closure-v1',
      planId: 'fixture-plan',
      planPath: fixture.planPath,
      planDigest: recordDigest(record),
      pullRequestUrl: 'https://github.com/example/repository/pull/1',
      finalReviewStatus: 'complete',
    });
    expect(runCli(fixture.root, ['check', '--base', closeBase]).status).toBe(0);
  });

  it('rejects completion of a slice outside the current horizon without changing files', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];
    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);
    const planBefore = readFileSync(path.join(fixture.root, fixture.planPath), 'utf8');
    const registryBefore = readFileSync(path.join(fixture.root, 'plans/README.md'), 'utf8');

    const result = runCli(fixture.root, [
      'complete-slice',
      ...common,
      '--slice',
      'unplanned-slice',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('slice unplanned-slice is not in the current horizon');
    expect(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8')).toBe(planBefore);
    expect(readFileSync(path.join(fixture.root, 'plans/README.md'), 'utf8')).toBe(registryBefore);
  });

  it('requires a planned capability to activate before its slice can complete', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];
    const record = parseRecord(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'));
    record.capabilities[0].activation = { state: 'planned', slice: 'slice-one' };
    writeFixture(fixture.root, fixture.planPath, `# Fixture plan\n\n${recordBlock(record)}\n`);

    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);
    const result = runCli(fixture.root, ['complete-slice', ...common, '--slice', 'slice-one']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'slice slice-one has planned capabilities: plan adaptation; activate them before completion',
    );
  });

  it('allows a source-record activation to pass init, check, and slice completion', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];
    const planned = parseRecord(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'));
    planned.capabilities[0].activation = { state: 'planned', slice: 'slice-one' };
    writeFixture(fixture.root, fixture.planPath, `# Fixture plan\n\n${recordBlock(planned)}\n`);

    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);
    const activated = parseRecord(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'));
    delete activated.capabilities[0].activation;
    writeFixture(fixture.root, fixture.planPath, `# Fixture plan\n\n${recordBlock(activated)}\n`);

    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);
    expect(runCli(fixture.root, ['check', ...common]).status).toBe(0);
    expect(runCli(fixture.root, ['complete-slice', ...common, '--slice', 'slice-one']).status).toBe(
      0,
    );
  });

  it('rejects a planned capability that is outside the current horizon', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];
    const record = parseRecord(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'));
    record.capabilities[0].activation = { state: 'planned', slice: 'stale-owner' };
    writeFixture(fixture.root, fixture.planPath, `# Fixture plan\n\n${recordBlock(record)}\n`);

    const result = runCli(fixture.root, ['init', ...common]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'planned capability plan adaptation must bind a current horizon slice: stale-owner',
    );
  });

  it('keeps an applied consolidation checkpoint valid while rejecting a second one', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];

    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);
    expect(runCli(fixture.root, ['prepare', ...common]).status).toBe(0);

    const draftPath = path.join(fixture.root, '.plan-adaptation/fixture-plan.draft.json');
    const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
    draft.record.checkpoint = {
      outcome: 'Navigation requires one bounded consolidation.',
      learning: 'The active owner map is incomplete.',
      structure: 'One consolidation slice repairs the owner map.',
      decision: 'consolidate',
      nextSlices: ['repair-owner-map'],
    };
    writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`);

    expect(runCli(fixture.root, ['apply', ...common]).status).toBe(0);
    expect(runCli(fixture.root, ['check', ...common]).status).toBe(0);
    expect(
      runCli(fixture.root, ['complete-slice', ...common, '--slice', 'repair-owner-map']).status,
    ).toBe(0);
    expect(runCli(fixture.root, ['check', ...common]).status).toBe(0);

    expect(runCli(fixture.root, ['prepare', ...common]).status).toBe(0);
    const secondDraft = JSON.parse(readFileSync(draftPath, 'utf8'));
    secondDraft.record.checkpoint = {
      outcome: 'Navigation requires one bounded consolidation.',
      learning: 'The active owner map is incomplete.',
      structure: 'One consolidation slice repairs the owner map.',
      decision: 'consolidate',
      nextSlices: ['repair-owner-map'],
    };
    writeFileSync(draftPath, `${JSON.stringify(secondDraft, null, 2)}\n`);

    expect(runCli(fixture.root, ['apply', ...common]).stdout).toContain(
      'only one autonomous consolidation slice is allowed',
    );
  });

  it('keeps prepare drafts ignored and rejects stale facts or incomplete judgments on apply', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];
    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);
    expect(runCli(fixture.root, ['prepare', ...common]).status).toBe(0);
    expect(
      runGit(fixture.root, ['check-ignore', '.plan-adaptation/fixture-plan.draft.json']),
    ).toContain('.plan-adaptation/fixture-plan.draft.json');

    const draftPath = path.join(fixture.root, '.plan-adaptation/fixture-plan.draft.json');
    const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
    writeFileSync(draftPath, JSON.stringify(draft));
    expect(runCli(fixture.root, ['apply', ...common]).stdout).toContain(
      'checkpoint.learning must be a non-empty judgment',
    );

    draft.record.checkpoint = {
      outcome: 'A complete outcome judgment.',
      learning: 'A complete learning judgment.',
      structure: 'A complete structure judgment.',
      decision: 'continue',
      nextSlices: ['slice-one'],
    };
    writeFileSync(draftPath, JSON.stringify(draft));
    writeFixture(
      fixture.root,
      'scripts/plan-adaptation/new-owner.mjs',
      'export const owner = true;\n',
    );
    expect(runCli(fixture.root, ['apply', ...common]).stdout).toContain(
      'draft facts are stale; run prepare again',
    );
  });

  it('requires matching final pull-request evidence before destructive close-out', () => {
    const fixture = createLifecycleRepository();
    const result = runCli(fixture.root, [
      'close',
      '--plan',
      fixture.planPath,
      '--base',
      fixture.base,
      '--final-pr-evidence',
      'missing.json',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('final pull-request evidence');
    expect(existsSync(path.join(fixture.root, fixture.planPath))).toBe(true);
  });

  it('rejects close-out while a capability remains planned', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];
    const record = parseRecord(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'));
    record.capabilities[0].activation = { state: 'planned', slice: 'slice-one' };
    writeFixture(fixture.root, fixture.planPath, `# Fixture plan\n\n${recordBlock(record)}\n`);
    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);

    const evidenceRelativePath = 'final-pr-evidence.json';
    writeFileSync(
      path.join(fixture.root, evidenceRelativePath),
      JSON.stringify({
        version: 1,
        planId: record.planId,
        pullRequestUrl: 'https://github.com/example/repository/pull/1',
        finalReview: { status: 'complete', planDigest: recordDigest(record) },
      }),
    );

    const result = runCli(fixture.root, [
      'close',
      ...common,
      '--final-pr-evidence',
      evidenceRelativePath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'close cannot continue while planned capabilities remain: plan adaptation',
    );
  });

  it('runs the package check entry from the single active record and configured base', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];
    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);

    const result = runCli(fixture.root, ['check']);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: plan adaptation check');
  });

  it('requires qualifying work to have one valid active adaptive plan', () => {
    const missing = createLifecycleRepository();
    rmSync(path.join(missing.root, missing.planPath));
    expect(runCli(missing.root, ['check', '--base', missing.base]).stdout).toContain(
      'qualifying work requires an active plan-adaptation-v1 record',
    );

    const unfenced = createLifecycleRepository();
    writeFixture(unfenced.root, unfenced.planPath, '# Unfenced implementation plan\n');
    expect(runCli(unfenced.root, ['check', '--base', unfenced.base]).stdout).toContain(
      'qualifying work requires an active plan-adaptation-v1 record',
    );

    const mistyped = createLifecycleRepository();
    const mistypedMarkdown = readFileSync(path.join(mistyped.root, mistyped.planPath), 'utf8');
    const mistypedRecord = parseRecord(mistypedMarkdown);
    mistypedRecord.status = 'acitve';
    writeFixture(
      mistyped.root,
      mistyped.planPath,
      `# Fixture plan\n\n${recordBlock(mistypedRecord)}\n`,
    );
    expect(runCli(mistyped.root, ['check', '--base', mistyped.base]).stdout).toContain(
      'record.status must be active',
    );
  });

  it('confines plan, draft, evidence, and Git revision inputs', () => {
    const fixture = createLifecycleRepository();
    const outsideName = `${path.basename(fixture.root)}-outside-plan.md`;
    const outsidePlan = path.join(path.dirname(fixture.root), outsideName);
    fixtureRoots.push(outsidePlan);
    writeFileSync(outsidePlan, `# Outside\n\n${recordBlock(createRecord())}\n`);
    const outsideBefore = readFileSync(outsidePlan, 'utf8');
    expect(
      runCli(fixture.root, ['init', '--plan', `../${outsideName}`, '--base', fixture.base]).stdout,
    ).toContain('plan path must identify a direct plans/*.md tactical plan');
    expect(readFileSync(outsidePlan, 'utf8')).toBe(outsideBefore);

    const symlinkPlan = path.join(fixture.root, 'plans/symlink-plan.md');
    symlinkSync(outsidePlan, symlinkPlan);
    expect(
      runCli(fixture.root, ['init', '--plan', 'plans/symlink-plan.md', '--base', fixture.base])
        .stdout,
    ).toContain('plan path must not be a symbolic link');
    rmSync(symlinkPlan);

    const markdown = readFileSync(path.join(fixture.root, fixture.planPath), 'utf8');
    const unsafeIdRecord = parseRecord(markdown);
    unsafeIdRecord.planId = '../outside-draft';
    writeFixture(
      fixture.root,
      fixture.planPath,
      `# Fixture plan\n\n${recordBlock(unsafeIdRecord)}\n`,
    );
    expect(
      runCli(fixture.root, ['prepare', '--plan', fixture.planPath, '--base', fixture.base]).stdout,
    ).toContain('record.planId must use lowercase letters, digits, and single hyphens');
    expect(existsSync(path.join(fixture.root, 'outside-draft.draft.json'))).toBe(false);

    const draftSymlinkFixture = createLifecycleRepository();
    const outsideDraftRoot = `${draftSymlinkFixture.root}-outside-drafts`;
    fixtureRoots.push(outsideDraftRoot);
    mkdirSync(outsideDraftRoot);
    symlinkSync(outsideDraftRoot, path.join(draftSymlinkFixture.root, '.plan-adaptation'));
    expect(
      runCli(draftSymlinkFixture.root, [
        'prepare',
        '--plan',
        draftSymlinkFixture.planPath,
        '--base',
        draftSymlinkFixture.base,
      ]).stdout,
    ).toContain('.plan-adaptation directory must remain inside the repository');
    expect(existsSync(path.join(outsideDraftRoot, 'fixture-plan.draft.json'))).toBe(false);

    const outputPath = path.join(fixture.root, 'git-output.txt');
    expect(
      runCli(fixture.root, ['check', '--base', `--output=${outputPath}`, '--unknown', 'value'])
        .stdout,
    ).toContain('unknown option --unknown');
    expect(existsSync(outputPath)).toBe(false);
    expect(runCli(fixture.root, ['check', '--base', `--output=${outputPath}`]).stdout).toContain(
      'Git base must not begin with an option prefix',
    );
    expect(existsSync(outputPath)).toBe(false);
  });

  it('rejects symlinked plan roots without treating the static README as lifecycle state', () => {
    const plansRootFixture = createLifecycleRepository();
    const outsidePlansRoot = `${plansRootFixture.root}-outside-plans`;
    fixtureRoots.push(outsidePlansRoot);
    renameSync(path.join(plansRootFixture.root, 'plans'), outsidePlansRoot);
    writeFixture(outsidePlansRoot, 'malformed-plan.md', '```plan-adaptation-v1\n{broken}\n```\n');
    symlinkSync(outsidePlansRoot, path.join(plansRootFixture.root, 'plans'));

    const plansRootResult = runCli(plansRootFixture.root, [
      'check',
      '--base',
      plansRootFixture.base,
    ]);
    expect(plansRootResult.status).toBe(1);
    expect(plansRootResult.stdout).toContain('plans directory must remain inside the repository');
    expect(plansRootResult.stdout).not.toContain('invalid JSON');

    const registryFixture = createLifecycleRepository();
    const common = ['--plan', registryFixture.planPath, '--base', registryFixture.base];
    expect(runCli(registryFixture.root, ['init', ...common]).status).toBe(0);
    const registryPath = path.join(registryFixture.root, 'plans/README.md');
    const outsideRegistry = `${registryFixture.root}-outside-registry.md`;
    fixtureRoots.push(outsideRegistry);
    renameSync(registryPath, outsideRegistry);
    symlinkSync(outsideRegistry, registryPath);

    const outsideBefore = readFileSync(outsideRegistry, 'utf8');
    const registryResult = runCli(registryFixture.root, ['check', ...common]);
    expect(registryResult.status, registryResult.stdout).toBe(0);
    expect(readFileSync(outsideRegistry, 'utf8')).toBe(outsideBefore);
  });

  it('rejects apply when the source plan record changed after prepare', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];
    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);
    expect(runCli(fixture.root, ['prepare', ...common]).status).toBe(0);
    const draftPath = path.join(fixture.root, '.plan-adaptation/fixture-plan.draft.json');
    const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
    draft.record.checkpoint = completeCheckpoint();
    writeFileSync(draftPath, JSON.stringify(draft));

    expect(runCli(fixture.root, ['complete-slice', ...common, '--slice', 'slice-one']).status).toBe(
      0,
    );
    const changedPlan = readFileSync(path.join(fixture.root, fixture.planPath), 'utf8');
    const result = runCli(fixture.root, ['apply', ...common]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('source plan record changed after prepare');
    expect(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8')).toBe(changedPlan);
    expect(existsSync(draftPath)).toBe(true);
  });

  it('applies the prepared plan without reading or replacing the static README', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];
    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);
    expect(runCli(fixture.root, ['prepare', ...common]).status).toBe(0);
    const draftPath = path.join(fixture.root, '.plan-adaptation/fixture-plan.draft.json');
    const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
    draft.record.checkpoint = completeCheckpoint();
    writeFileSync(draftPath, JSON.stringify(draft));
    rmSync(path.join(fixture.root, 'plans/README.md'));
    mkdirSync(path.join(fixture.root, 'plans/README.md'));

    const result = runCli(fixture.root, ['apply', ...common]);

    expect(result.status, result.stdout).toBe(0);
    expect(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8')).toContain(
      'The prepared result is complete.',
    );
    expect(existsSync(draftPath)).toBe(false);
  });

  it('validates the complete fact schema and closes independently of static README content', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];
    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);
    const markdown = readFileSync(path.join(fixture.root, fixture.planPath), 'utf8');
    const malformed = parseRecord(markdown);
    malformed.facts.computedTriggers = 'folder-change';
    writeFixture(fixture.root, fixture.planPath, `# Fixture plan\n\n${recordBlock(malformed)}\n`);
    expect(runCli(fixture.root, ['check', ...common]).stdout).toContain(
      'record.facts.computedTriggers must be an array',
    );

    writeFixture(fixture.root, fixture.planPath, markdown);
    runGit(fixture.root, ['add', fixture.planPath]);
    runGit(fixture.root, ['commit', '--quiet', '-m', 'initialize plan facts']);
    const closeBase = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    const record = parseRecord(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'));
    const evidenceRelativePath = 'final-pr-evidence.json';
    const evidencePath = path.join(fixture.root, evidenceRelativePath);
    writeFileSync(
      evidencePath,
      JSON.stringify({
        version: 1,
        planId: record.planId,
        pullRequestUrl: 'https://github.com/example/repository/pull/1',
        finalReview: { status: 'complete', planDigest: recordDigest(record) },
      }),
    );
    const readmePath = path.join(fixture.root, 'plans/README.md');
    writeFileSync(readmePath, '# Independently edited navigation\n');
    const closeResult = runCli(fixture.root, [
      'close',
      '--plan',
      fixture.planPath,
      '--base',
      closeBase,
      '--final-pr-evidence',
      evidenceRelativePath,
    ]);
    expect(closeResult.status, closeResult.stdout).toBe(0);
    expect(existsSync(path.join(fixture.root, fixture.planPath))).toBe(false);

    const unsafe = createLifecycleRepository();
    expect(
      runCli(unsafe.root, [
        'close',
        '--plan',
        'plans/README.md',
        '--base',
        unsafe.base,
        '--final-pr-evidence',
        evidenceRelativePath,
      ]).stdout,
    ).toContain('plan path must identify a direct plans/*.md tactical plan');
  });
});

function createLifecycleRepository() {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-adaptation-lifecycle-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '--quiet', '--initial-branch=main']);
  runGit(root, ['config', 'user.name', 'Plan Adaptation Test']);
  runGit(root, ['config', 'user.email', 'plan-adaptation@example.test']);
  writeFixture(root, '.gitignore', '/.plan-adaptation/\n');
  writeFixture(
    root,
    'plans/policy.json',
    '{"schemaVersion":"adaptive-plan-policy-v1","maxActivePlans":8}\n',
  );
  writeFixture(
    root,
    'plans/README.md',
    '# Adaptive plans\n\nRun `npm run plan:adapt -- overview` for live status.\n',
  );
  writeFixture(root, 'scripts/plan-adaptation.mjs', 'console.log("fixture entry");\n');
  writeFixture(root, 'packages/tests/repo/plan-adaptation/fixture.test.ts', 'export {};\n');
  writeFixture(root, 'plans/fixture-plan.md', `# Fixture plan\n\n${recordBlock(createRecord())}\n`);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'base']);
  const base = runGit(root, ['rev-parse', 'HEAD']).trim();
  writeFixture(root, 'scripts/plan-adaptation/change.mjs', 'export const changed = true;\n');
  runGit(root, ['add', '.']);
  return { root, base, planPath: 'plans/fixture-plan.md' };
}

function runCli(root: string, args: readonly string[], environment: Record<string, string> = {}) {
  return spawnSync(process.execPath, [entryPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function snapshotTrackedFiles(root: string): Record<string, string> {
  const paths = runGit(root, ['ls-files']).trim().split('\n').filter(Boolean);
  return Object.fromEntries(
    paths.map((file) => [file, readFileSync(path.join(root, file), 'utf8')]),
  );
}

function parseRecord(markdown: string): any {
  const match = markdown.match(/```plan-adaptation-v1\n([\s\S]*?)\n```/u);
  if (!match) {
    throw new Error('fixture record missing');
  }
  return JSON.parse(match[1]);
}

function recordDigest(record: unknown): string {
  return execFileSync(
    process.execPath,
    [
      '-e',
      "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(process.argv[1]).digest('hex'))",
      JSON.stringify(record),
    ],
    { encoding: 'utf8' },
  );
}

function createRecord(): any {
  return {
    version: 1,
    planId: 'fixture-plan',
    status: 'active',
    goal: 'Prove the adaptive plan lifecycle.',
    acceptanceCriteria: ['All lifecycle commands preserve one canonical record.'],
    capabilities: [
      {
        owner: 'plan adaptation',
        root: 'scripts/plan-adaptation',
        entry: 'scripts/plan-adaptation.mjs',
        testRoot: 'packages/tests/repo/plan-adaptation',
        focusedCommand: 'npm run test:plan-adaptation',
        navigationMap: null,
        factContracts: [],
        controlFlowFamilies: ['lifecycle mutation', 'read-only check'],
      },
    ],
    architecture: {
      currentHypothesis: 'There is no adaptive owner.',
      intendedHypothesis: 'One lifecycle owns adaptive records.',
      freshInitialReview: { status: 'complete', reviewer: 'fixture', verdict: 'pass' },
    },
    completedSlicesSinceCheckpoint: [],
    facts: {
      diffBase: 'HEAD',
      affectedCodeDigest: null,
      computedTriggers: ['written-plan'],
      undeclaredChangedPaths: [],
    },
    checkpoint: {
      outcome: 'The fixture plan is active.',
      learning: 'The initial review fixed the owner.',
      structure: 'One capability owns the lifecycle.',
      decision: 'continue',
      nextSlices: ['slice-one', 'slice-two'],
    },
    structuralDispositions: [],
    freshStructuralReview: null,
    coldNavigationEvidence: null,
    materialDecisions: [],
  };
}

function recordBlock(record: ReturnType<typeof createRecord>): string {
  return `\`\`\`plan-adaptation-v1\n${JSON.stringify(record, null, 2)}\n\`\`\``;
}

function completeCheckpoint() {
  return {
    outcome: 'The prepared result is complete.',
    learning: 'The source record must remain current.',
    structure: 'The lifecycle owns one atomic transaction.',
    decision: 'continue',
    nextSlices: ['slice-two'],
  };
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
