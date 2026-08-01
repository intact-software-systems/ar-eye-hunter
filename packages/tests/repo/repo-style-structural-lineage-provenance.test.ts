import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const manifestPath = 'plans/repo-style-lineages/rallar-group-state-server-structure.json';
const provenancePath =
  'plans/repo-style-lineages/rallar-group-state-server-structure-provenance.md';

const expectedLineages = [
  [
    'packages/shared-server/rallar-system/services/AppGroupInboxService.ts',
    'b7525b31bd38e24a883c69bdf97d0ef0a5232448',
    [
      'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts',
      'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts',
      'packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-authority.ts',
      'packages/shared-server/rallar-system/topology/inbox/topology-app-inbox-authority.ts',
      'packages/shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts',
      'packages/shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts',
    ],
  ],
  [
    'packages/shared-server/rallar-system/services/group-state-service.ts',
    '3c8356ee088d2963d6f8f0f3b688bc0954d4745b',
    [
      'packages/shared-server/rallar-system/group-state/group-mutation-authority.ts',
      'packages/shared-server/rallar-system/group-state/group-state-service.ts',
    ],
  ],
  [
    'packages/shared-server/rallar-system/services/group-state-mutations.ts',
    '66a5a6fcbd86a1d144a2e0a1394ee80eca2fb520',
    [
      'packages/shared-server/rallar-system/group-state/mutation/aggregate/compute-group-aggregate-mutation.ts',
      'packages/shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts',
      'packages/shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts',
      'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-mutation-request-validation.ts',
      'packages/shared-server/rallar-system/group-state/mutation/result-validation/validate-computed-group-mutation-write.ts',
      'packages/shared-server/rallar-system/group-state/mutation/result-validation/validate-computed-group-mutation.ts',
      'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-command.ts',
      'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-operation-input.ts',
      'packages/shared-server/rallar-system/group-state/mutation/state-validation/validate-group-mutation-read.ts',
      'packages/shared-server/rallar-system/group-state/mutation/result-validation/validate-group-mutation-result.ts',
      'packages/shared-server/rallar-system/group-state/persistence/group-state-persistence-codec.ts',
      'packages/shared-server/rallar-system/group-state/persistence/validate-persisted-group-presence.ts',
      'packages/shared-server/rallar-system/group-state/persistence/validate-persisted-group.ts',
      'packages/shared-server/rallar-system/group-state/presence/compute-group-presence-summary.ts',
    ],
  ],
  [
    'packages/shared-server/rallar-system/repositories/GroupStateRepository.ts',
    'ade6c012f1ea17ff3b3604f1bac05c6764b4f7a0',
    [
      'packages/shared-server/rallar-system/group-state/persistence/group-aggregate-repository.ts',
      'packages/shared-server/rallar-system/group-state/persistence/group-membership-repository.ts',
      'packages/shared-server/rallar-system/group-state/persistence/group-presence-repository.ts',
      'packages/shared-server/rallar-system/group-state/persistence/group-state-persistence-contracts.ts',
      'packages/shared-server/rallar-system/group-state/persistence/group-state-repository-reads.ts',
      'packages/shared-server/rallar-system/group-state/persistence/group-state-snapshot-repository.ts',
    ],
  ],
  [
    'packages/shared-server/rallar-system/services/app-group-ws-session-lifecycle.ts',
    '837714f6dc40c6572c4114490c6b366f5dec122e',
    ['packages/shared-server/rallar-system/group-state/presence/group-presence-service.ts'],
  ],
  [
    'packages/shared-server/rallar-system/services/group-snapshot-validation.ts',
    '94e8f14c8753aca5236b7c0f968e6c945b0406e3',
    [
      'packages/shared-server/rallar-system/group-state/snapshot/validate-persisted-group-snapshot.ts',
    ],
  ],
  [
    'packages/shared-server/rallar-system/services/group-state-validation-primitives.ts',
    '71860577dc37f2c8fb8cf4025559a6cf0cff6bb4',
    ['packages/shared-server/rallar-system/group-state/group-state-validation-primitives.ts'],
  ],
  [
    'packages/shared-server/rallar-system/services/group-state-crypto.ts',
    '5e804aaa083a2ca1a9f46a7ff378d33aab26ca79',
    ['packages/shared-server/rallar-system/group-state/mutation/group-state-crypto.ts'],
  ],
  [
    'packages/shared-server/rallar-system/services/group-expired-state-authority.ts',
    'dd7adf62ec3e1e907af5133481aea04f94acfd0c',
    ['packages/shared-server/rallar-system/group-state/presence/group-expired-state-authority.ts'],
  ],
  [
    'packages/shared-test/black-box-runner/api-v1-black-box-run.mts',
    'baaadae42ebe02e4d6cdd9a856f77dd8afc77c45',
    [
      'packages/shared-test/black-box-runner/managed-api/api-v1-managed-api-readiness.mts',
      'packages/shared-test/black-box-runner/managed-api/api-v1-managed-api-redaction-patterns.mts',
      'packages/shared-test/black-box-runner/managed-api/api-v1-managed-log-tail.mts',
      'packages/shared-test/black-box-runner/managed-api/api-v1-managed-postgres-run-database.mts',
      'packages/shared-test/black-box-runner/managed-api/api-v1-managed-process-lifecycle.mts',
    ],
  ],
  [
    'packages/shared-test/black-box-runner/api-v1-state-write-evidence.ts',
    '90f1497f1636ea8685dba92b7757f9f94e5d6088',
    [
      'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-contracts.ts',
      'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-derivation.ts',
      'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-source.ts',
      'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-sql.ts',
    ],
  ],
  [
    'packages/shared-test/black-box-runner/api-v1-state-write-group-causal-evidence.ts',
    '9be5158ab51c0106cf73a2f855cf97ad4eadd24b',
    [
      'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-group-causal-evidence.ts',
    ],
  ],
  [
    'packages/shared-test/black-box-runner/api-v1-state-write-json-evidence.ts',
    '9dfbd2c6a5c350ee14ba56088b3c56d62ce9ba24',
    [
      'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-json-evidence.ts',
    ],
  ],
  [
    'packages/shared-test/black-box-runner/api-v1-state-write-match.ts',
    '30af6a2b9de18b3215700b89fb0166af466fa9d3',
    [
      'packages/shared-test/black-box-runner/state-write-evidence/to-exact-persisted-evidence-matches.ts',
    ],
  ],
  [
    'packages/shared-test/black-box-runner/api-v1-state-write-topology-result-evidence.ts',
    'c88f184577dfad6af825f8caa2643a0ca6dc2d9c',
    [
      'packages/shared-test/black-box-runner/state-write-evidence/validate-topology-mutation-result-payload.ts',
    ],
  ],
  [
    'packages/shared-test/black-box-runner/artifact-report-bounds.ts',
    '2bf9ee11bb835ab44706d964a5caff9d0dae2f1c',
    ['packages/shared-test/black-box-runner/artifacts/with-bounded-artifact-report-results.ts'],
  ],
  [
    'packages/shared-test/black-box-runner/live-preflight-variables.ts',
    '2ede5ae0110654cc4cae9f1e80cfe37f6b670933',
    ['packages/shared-test/black-box-runner/preflight/resolve-variable-by-env.ts'],
  ],
] as const;

const compatibilityPaths = [
  'packages/shared-server/rallar-system/services/AppGroupInboxService.ts',
  'packages/shared-server/rallar-system/services/group-state-service.ts',
  'packages/shared-server/rallar-system/services/group-state-mutations.ts',
  'packages/shared-server/rallar-system/repositories/GroupStateRepository.ts',
  'packages/shared-server/rallar-system/services/app-group-ws-session-lifecycle.ts',
  'packages/shared-server/rallar-system/services/group-snapshot-validation.ts',
  'packages/shared-test/black-box-runner/api-v1-black-box-run.mts',
  'packages/shared-test/black-box-runner/api-v1-state-write-evidence.ts',
] as const;

describe('group-state structural-lineage provenance', () => {
  it('keeps the immutable manifest inventory and its active compatibility paths exact', () => {
    const manifest = readJson(manifestPath) as { version: number; lineages: unknown };

    expect(manifest.version).toBe(1);
    expect(manifest.lineages).toEqual(
      expectedLineages.map(([sourcePath, blob, targets]) => ({
        mergeBase: '52d973bb71dda2100455e8585a0a8f98d177bd13',
        source: { path: sourcePath, blob },
        targets,
      })),
    );
    expect(new Set(expectedLineages.flatMap(([, , targets]) => targets)).size).toBe(48);
    expect(
      compatibilityPaths.filter((filePath) => existsSync(path.join(repoRoot, filePath))),
    ).toEqual(compatibilityPaths);
    expect(
      expectedLineages
        .flatMap(([, , targets]) => targets)
        .filter((filePath) => !existsSync(path.join(repoRoot, filePath))),
    ).toEqual([]);
  });

  it('requires one reviewed provenance row for every immutable source and target region', () => {
    const provenanceAbsolutePath = path.join(repoRoot, provenancePath);

    expect(existsSync(provenanceAbsolutePath), `${provenancePath} must be created in Task 3`).toBe(
      true,
    );
    if (!existsSync(provenanceAbsolutePath)) return;

    const provenance = readFileSync(provenanceAbsolutePath, 'utf8');
    for (const [sourcePath, blob, targets] of expectedLineages) {
      expect(provenance).toContain(`## Source: \`${sourcePath}\``);
      expect(provenance).toContain(`Source blob: \`${blob}\``);
      for (const targetPath of targets) {
        const targetStart = provenance.indexOf(`### Target: \`${targetPath}\``);
        expect(targetStart, targetPath).toBeGreaterThanOrEqual(0);
        const targetRow = provenance.slice(
          targetStart,
          provenance.indexOf('\n### Target:', targetStart + 1),
        );
        expectAll(targetRow, [
          'Source symbol or line span:',
          'Target symbol or line span:',
          'Mechanical-move classification:',
          'Semantic additions excluded from inherited capacity:',
          'Human disposition:',
        ]);
      }
    }
  });
});

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, filePath), 'utf8'));
}

function expectAll(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) expect(haystack, needle).toContain(needle);
}
