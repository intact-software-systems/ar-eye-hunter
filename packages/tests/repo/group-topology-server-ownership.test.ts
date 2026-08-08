import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS as publicDefaultOverrideTtl,
  GroupTopologyConfigValidationError as PublicConfigValidationError,
  readDefaultGroupTopologyConfig as publicReadDefaults,
  resolveGroupTopologyConfig as publicResolveConfig,
} from '../../shared-server/mod.ts';
import {
  DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS as ownedDefaultOverrideTtl,
  GroupTopologyConfigValidationError as OwnedConfigValidationError,
  readDefaultGroupTopologyConfig as ownedReadDefaults,
  resolveGroupTopologyConfig as ownedResolveConfig,
} from '../../shared-server/rallar-system/topology/config/group-topology-config.ts';

const repoRoot = process.cwd();
const removedOwners = [
  'packages/shared-server/rallar-system/services/group-topology-config-mutations.ts',
  'packages/shared-server/rallar-system/services/group-topology-config-service.ts',
  'packages/shared-server/rallar-system/services/topology-mutation-authority-proof.ts',
] as const;
const productionOwners = [
  'packages/shared-server/rallar-system/topology/config/group-topology-config.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/group-topology-config-mutation-contracts.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/topology-config-mutation-idempotency.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/compute-topology-config-mutation.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation-input.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/topology-config-mutation-validation-primitives.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation-records.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/validate-topology-config-receipt.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/topology-config-mutation-receipt.ts',
  'packages/shared-server/rallar-system/topology/inbox/topology-mutation-authority-proof.ts',
] as const;

describe('group topology server PR-A ownership', () => {
  it('removes all three predecessor private owners without a shim', () => {
    for (const owner of removedOwners) expect(existsSync(absolute(owner)), owner).toBe(false);
  });

  it('keeps every changed production owner within 400 physical lines', () => {
    for (const owner of productionOwners) {
      expect(physicalLines(read(owner)), owner).toBeLessThanOrEqual(400);
    }
  });

  it('keeps config mutation owners pure and directed away from side-effect shells', () => {
    for (const owner of productionOwners.filter((owner) => owner.includes('/config/'))) {
      const source = read(owner);
      for (const forbidden of [
        'GroupTopologyConfigRepository',
        'PSqlTransactionSql',
        '.begin(',
        'Date.now',
        'Temporal.Now',
        'Math.random',
        'AppGroupInboxService',
        'GroupTopologyManagementService',
      ]) {
        expect(source, `${owner}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('retargets public config exports and both RTC RTT proof consumers directly', () => {
    expect(read('packages/shared-server/mod.ts')).toContain(
      "export * from './rallar-system/topology/config/group-topology-config.ts';",
    );
    for (const consumer of [
      'packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-authority.ts',
      'packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts',
    ]) {
      expect(read(consumer), consumer).toContain(
        "from '../../topology/inbox/topology-mutation-authority-proof.ts';",
      );
    }
  });

  it('preserves direct public config runtime export identity', () => {
    expect(publicDefaultOverrideTtl).toBe(ownedDefaultOverrideTtl);
    expect(PublicConfigValidationError).toBe(OwnedConfigValidationError);
    expect(publicReadDefaults).toBe(ownedReadDefaults);
    expect(publicResolveConfig).toBe(ownedResolveConfig);
  });
});

function physicalLines(source: string): number {
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

function read(relativePath: string): string {
  return readFileSync(absolute(relativePath), 'utf8');
}

function absolute(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}
