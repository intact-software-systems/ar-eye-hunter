import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const base = '2fdba024bb347622727d337eb06fc13d2fe129fc';
const manifestPath = 'plans/repo-style-lineages/client-state-server-ordinary-transaction.json';

const expectedLineages = [
  {
    path: 'packages/shared-server/rallar-system/services/client-state-service.ts',
    blob: 'aa6c2483db49bfc2c819e14c37d64197a51064c7',
    targets: [
      'packages/shared-server/rallar-system/client-state/client-state-service-contracts.ts',
      'packages/shared-server/rallar-system/client-state/client-state-service.ts',
      'packages/shared-server/rallar-system/client-state/client-state-service-timing.ts',
      'packages/shared-server/rallar-system/client-state/mutation/read/read-client-mutation.ts',
      'packages/shared-server/rallar-system/client-state/mutation/write/write-client-mutation.ts',
    ],
  },
  {
    path: 'packages/shared-server/rallar-system/services/AppClientInboxService.ts',
    blob: '8f5d371f3693e135e17beeeef4781aba19c93a23',
    targets: [
      'packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts',
      'packages/shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts',
      'packages/shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts',
      'packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts',
    ],
  },
] as const;

describe('client-state ordinary transaction lineage provenance', () => {
  it('binds every canonical Task 4B owner to one exact Task 4B predecessor', () => {
    expect(JSON.parse(read(manifestPath))).toEqual({
      version: 1,
      lineages: expectedLineages.map((lineage) => ({
        mergeBase: base,
        source: { path: lineage.path, blob: lineage.blob },
        targets: lineage.targets,
      })),
    });

    const targets = expectedLineages.flatMap((lineage) => lineage.targets);
    expect(new Set(targets).size).toBe(targets.length);
    for (const lineage of expectedLineages) {
      expect(readBlob(lineage.path), lineage.path).toBe(lineage.blob);
      for (const target of lineage.targets) expect(existsSync(absolute(target)), target).toBe(true);
    }
  });

  it('records the direct authorised-WS move outside structural capacity', () => {
    const provenance = read(
      'plans/repo-style-lineages/client-state-server-ordinary-transaction-provenance.md',
    );
    expect(
      readBlob('packages/shared-server/rallar-system/services/authorised-ws-client-app-inbox.ts'),
    ).toBe('490c3d4c3050ee3adf21a2b680aa4376357c3989');
    expect(provenance).toContain(
      'packages/shared-server/rallar-system/services/authorised-ws-client-app-inbox.ts',
    );
    expect(provenance).toContain(
      'packages/shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts',
    );
  });
});

function readBlob(filePath: string): string {
  return execFileSync('git', ['rev-parse', `${base}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function absolute(filePath: string): string {
  return path.join(repoRoot, filePath);
}

function read(filePath: string): string {
  return readFileSync(absolute(filePath), 'utf8');
}
