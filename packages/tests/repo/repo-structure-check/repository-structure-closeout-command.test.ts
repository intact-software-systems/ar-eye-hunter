import { rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { toActivePlanRegistry } from '../../../../scripts/plan-adaptation/active-plan-registry.mjs';
import { computeAdaptivePlanRecordDigest } from '../../../../scripts/plan-adaptation/adaptive-plan-record.mjs';
import {
  cleanupRepositoryFixtures,
  createRecord,
  createRepositoryFixture,
  recordBlock,
  runChecker,
  runGit,
  writeFixture,
  writePlanRecord,
} from './repository-structure-command-fixture.ts';

afterEach(cleanupRepositoryFixtures);

describe('repository structure close-out command', () => {
  it('accepts an authenticated last-plan close-out without an active record', () => {
    const { fixture, closeBase } = createLastPlanCloseoutFixture();

    const result = runChecker(fixture, { includeBase: false });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`PASS: repository structure (${closeBase} -> WORKTREE)`);
  });

  it('rejects an authenticated close-out when more than one active plan is removed', () => {
    const fixture = createRepositoryFixture();
    const firstRecord = createRecord();
    writePlanRecord(fixture.root, firstRecord);
    const secondRecord = { ...createRecord(), planId: 'second-plan' };
    (secondRecord.facts as Record<string, unknown>).diffBase = (
      firstRecord.facts as Record<string, unknown>
    ).diffBase;
    writeFixture(
      fixture.root,
      'plans/second-plan.md',
      `# Second plan\n\n${recordBlock(secondRecord)}\n`,
    );
    writeFixture(
      fixture.root,
      'plans/README.md',
      toActivePlanRegistry([
        { planPath: 'plans/fixture-plan.md', record: firstRecord },
        { planPath: 'plans/second-plan.md', record: secondRecord },
      ]),
    );
    runGit(fixture.root, ['add', '.']);
    runGit(fixture.root, ['commit', '--quiet', '-m', 'activate two plans']);
    const closeBase = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();

    rmSync(path.join(fixture.root, 'plans/fixture-plan.md'));
    rmSync(path.join(fixture.root, 'plans/second-plan.md'));
    writeFixture(fixture.root, 'plans/README.md', toActivePlanRegistry([]));
    writeClosureReceipt(fixture.root, 'plans/fixture-plan.md', firstRecord);
    writeClosureReceipt(fixture.root, 'plans/second-plan.md', secondRecord);

    const result = runChecker({ ...fixture, base: closeBase }, { includeBase: true });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('authenticated last-plan close-out');
    expect(result.stderr).not.toContain('PASS: repository structure');
  });

  it('rejects a malformed last-plan close-out receipt', () => {
    const { fixture } = createLastPlanCloseoutFixture();
    writeFixture(fixture.root, 'plans/fixture-plan.closure.json', '{broken}\n');

    const result = runChecker(fixture, { includeBase: false });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('close-out is not authenticated');
  });

  it('rejects additional changed surface beside an authenticated last-plan close-out', () => {
    const { fixture } = createLastPlanCloseoutFixture();
    writeFixture(fixture.root, 'scripts/unrelated.mjs', 'export const unrelated = true;\n');

    const result = runChecker(fixture, { includeBase: false });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('authenticated last-plan close-out');
  });
});

function createLastPlanCloseoutFixture() {
  const fixture = createRepositoryFixture();
  const record = createRecord();
  writePlanRecord(fixture.root, record);
  writeFixture(
    fixture.root,
    'plans/README.md',
    toActivePlanRegistry([{ planPath: 'plans/fixture-plan.md', record }]),
  );
  runGit(fixture.root, ['add', '.']);
  runGit(fixture.root, ['commit', '--quiet', '-m', 'activate plan']);
  const closeBase = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
  runGit(fixture.root, ['update-ref', 'refs/remotes/origin/main', closeBase]);

  rmSync(path.join(fixture.root, 'plans/fixture-plan.md'));
  writeFixture(fixture.root, 'plans/README.md', toActivePlanRegistry([]));
  writeClosureReceipt(fixture.root, 'plans/fixture-plan.md', record);
  return { fixture, closeBase };
}

function writeClosureReceipt(
  root: string,
  planPath: string,
  record: ReturnType<typeof createRecord>,
): void {
  writeFixture(
    root,
    `plans/${String(record.planId)}.closure.json`,
    `${JSON.stringify(
      {
        schemaVersion: 'plan-adaptation-closure-v1',
        planId: record.planId,
        planPath,
        planDigest: computeAdaptivePlanRecordDigest(record),
        pullRequestUrl: 'https://github.com/example/repository/pull/42',
        finalReviewStatus: 'complete',
      },
      null,
      2,
    )}\n`,
  );
}
