import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const topologyRoot = 'packages/shared-server/rallar-system/topology';
const navigationPath = `${topologyRoot}/README.md`;
const currentOwners = [
  ['config/group-topology-config.ts', 'resolveGroupTopologyConfig'],
  [
    'config/mutation/group-topology-config-mutation-contracts.ts',
    'GroupTopologyConfigMutationComputed',
  ],
  [
    'config/mutation/topology-config-mutation-idempotency.ts',
    'probeTopologyConfigMutationIdempotency',
  ],
  ['config/mutation/compute-topology-config-mutation.ts', 'computeTopologyConfigMutation'],
  ['config/mutation/validate-topology-config-mutation.ts', 'validateTopologyConfigMutation'],
  [
    'config/mutation/validate-topology-config-mutation-input.ts',
    'validateTopologyConfigMutationInput',
  ],
  [
    'config/mutation/topology-config-mutation-boundary.ts',
    'readTopologyConfigMutationRecordBoundary',
  ],
  ['config/mutation/topology-config-mutation-validation-values.ts', 'validateTopologyGroupRef'],
  [
    'config/mutation/validate-topology-config-records.ts',
    'validateGroupTopologyConfigMutationRecord',
  ],
  ['config/mutation/validate-topology-config-receipt.ts', 'validateTopologyConfigReceipt'],
  ['config/mutation/topology-config-mutation-receipt.ts', 'resultFromTopologyConfigReceipt'],
  ['inbox/topology-app-inbox-contracts.ts', 'TopologyAppInboxCommand'],
  ['inbox/topology-app-inbox-command.ts', 'toTopologyAppInboxCommand'],
  ['inbox/topology-app-inbox-authority.ts', 'verifyTopologyAppInboxAuthority'],
  ['inbox/topology-mutation-authority-proof.ts', 'createTopologyMutationAuthorityProof'],
  ['inbox/topology-app-inbox-handler.ts', 'TopologyAppInboxHandler'],
] as const;

describe('group topology server navigation map', () => {
  it('links every current PR-A owner to its primary symbol', () => {
    const navigation = read(navigationPath);

    for (const [relativePath, symbol] of currentOwners) {
      expect(navigation, relativePath).toContain(`](${relativePath})`);
      expect(exportedNames(read(`${topologyRoot}/${relativePath}`)), relativePath).toContain(
        symbol,
      );
    }
  });

  it('separates current owners from explicitly deferred PR-B and PR-C owners', () => {
    const navigation = read(navigationPath);

    expect(navigation).toContain('## Current PR-A owners');
    expect(navigation).toContain('## Deferred owners');
    expect(navigation).toContain('PR B');
    expect(navigation).toContain('PR C');
    expect(navigation).toContain('Construction and registration');
    expect(navigation).toContain('Runtime invocation');
  });

  it('keeps every linked current owner present and parseable', () => {
    for (const [relativePath] of currentOwners) {
      const ownerPath = `${topologyRoot}/${relativePath}`;
      expect(existsSync(absolute(ownerPath)), ownerPath).toBe(true);
      parse(read(ownerPath), { sourceType: 'module', plugins: ['typescript'] });
    }
  });
});

function exportedNames(source: string): readonly string[] {
  const program = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program;
  const names: string[] = [];
  for (const statement of program.body) {
    if (statement.type !== 'ExportNamedDeclaration') {
      continue;
    }
    if (statement.declaration && 'id' in statement.declaration && statement.declaration.id) {
      names.push(statement.declaration.id.name);
    }
    for (const specifier of statement.specifiers) {
      names.push(
        specifier.exported.type === 'Identifier'
          ? specifier.exported.name
          : specifier.exported.value,
      );
    }
  }
  return names;
}

function read(relativePath: string): string {
  return readFileSync(absolute(relativePath), 'utf8');
}

function absolute(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}
