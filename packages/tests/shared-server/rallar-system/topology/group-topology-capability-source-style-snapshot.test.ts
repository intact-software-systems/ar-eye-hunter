import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  countSourceMatches,
  groupTopologyCapabilityBaseCommit,
  groupTopologyCapabilityBaseTree,
  groupTopologyPlanningSnapshotPath,
  groupTopologySourceStyleSnapshotOwner,
  groupTopologySourceStyleSnapshotRemovalCondition,
  maximumEnforcedLineWidth,
  maximumSourceLineWidth,
  mirroredGroupTopologyTestRoot,
  predecessorGroupTopologyTestRoot,
  readWorkspaceFile,
  resolveWorkspacePath,
  rtcTopologyWorkHandlerPath,
  runGit,
  sourceLineCount,
} from '../group-topology-capability-source-style-snapshot.ts';

describe('group topology capability source and style snapshot', () => {
  it('binds the exact implementation base and retained PR C style findings', () => {
    expect(runGit('rev-parse', `${groupTopologyCapabilityBaseCommit}^{tree}`)).toBe(
      groupTopologyCapabilityBaseTree,
    );
    expect(
      runGit(
        'rev-parse',
        `${groupTopologyCapabilityBaseCommit}:${groupTopologyPlanningSnapshotPath}`,
      ),
    ).toBe('d79fbafbc6981426edc9b911a844888252101bd4');
    expect(
      runGit('rev-parse', `${groupTopologyCapabilityBaseCommit}:${rtcTopologyWorkHandlerPath}`),
    ).toBe('a520fd4ef76236b9467a96730b7880b1a5465934');

    const planningSource = runGit(
      'show',
      `${groupTopologyCapabilityBaseCommit}:${groupTopologyPlanningSnapshotPath}`,
    );
    const replaySource = runGit(
      'show',
      `${groupTopologyCapabilityBaseCommit}:${rtcTopologyWorkHandlerPath}`,
    );
    expect(maximumSourceLineWidth(planningSource)).toBe(110);
    expect(sourceLineCount(replaySource)).toBe(402);
  });

  it('names the temporary evidence owner and later-ledger removal condition', () => {
    expect(groupTopologySourceStyleSnapshotOwner).toBe(
      'rallar-group-topology-server-structure child through PR D',
    );
    expect(groupTopologySourceStyleSnapshotRemovalCondition).toContain('later evidence ledger');
    expect(groupTopologySourceStyleSnapshotRemovalCondition).toContain(
      'permanent semantic and size checks',
    );
  });

  it('moves the complete current test cohort into the recognized mirror', () => {
    const predecessorPaths = runGit(
      'ls-tree',
      '-r',
      '--name-only',
      groupTopologyCapabilityBaseCommit,
      predecessorGroupTopologyTestRoot,
    ).split('\n');
    const mirroredPaths = predecessorPaths.map((predecessorPath) =>
      predecessorPath
        .replace(predecessorGroupTopologyTestRoot, mirroredGroupTopologyTestRoot)
        .replace(
          '/concurrency/fixtures/postgres-topology-app-inbox-worker.ts',
          '/concurrency/postgres-topology-app-inbox-worker.ts',
        )
        .replace(
          '/config/persistence/group-topology-config-legacy-migration.test.ts',
          '/config/maintenance/group-topology-config-legacy-migration.test.ts',
        ),
    );
    const predecessorSources = predecessorPaths.map((predecessorPath) =>
      runGit('show', `${groupTopologyCapabilityBaseCommit}:${predecessorPath}`),
    );
    const mirroredSources = mirroredPaths.map((mirroredPath) => readWorkspaceFile(mirroredPath));

    expect(predecessorPaths).toHaveLength(31);
    expect(predecessorPaths.filter((filePath) => filePath.endsWith('.test.ts'))).toHaveLength(26);
    expect(mirroredPaths.filter((filePath) => !existsSync(resolveWorkspacePath(filePath)))).toEqual(
      [],
    );
    expect(existsSync(resolveWorkspacePath(predecessorGroupTopologyTestRoot))).toBe(false);
    expect(countSourceMatches(predecessorSources, /\b(?:it|test)\s*\(/gu)).toBe(85);
    expect(countSourceMatches(predecessorSources, /\bexpect\s*\(/gu)).toBe(356);
    expect(countSourceMatches(mirroredSources, /\b(?:it|test)\s*\(/gu)).toBeGreaterThanOrEqual(85);
    expect(countSourceMatches(mirroredSources, /\bexpect\s*\(/gu)).toBeGreaterThanOrEqual(356);
  });

  it('uses the exact focused command and machine-verifiable navigation owner', () => {
    const packageJson = JSON.parse(readWorkspaceFile('package.json')) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const navigation = readWorkspaceFile('packages/shared-server/rallar-system/topology/README.md');

    expect(packageJson.scripts['test:group-topology']).toBe(
      `vitest run ${mirroredGroupTopologyTestRoot}`,
    );
    expect(navigation.match(/```repository-navigation-v1\n[\s\S]+?\n```/gu)).toHaveLength(1);
    expect(navigation).toContain(
      '[group-topology-management-service.ts#GroupTopologyManagementService]',
    );
  });

  it('resolves the retained PR C line-width finding without changing its owner', () => {
    expect(
      maximumEnforcedLineWidth(readWorkspaceFile(groupTopologyPlanningSnapshotPath)),
    ).toBeLessThanOrEqual(100);
  });
});
