import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { oversizedGeneralFunctions } from './group-topology-server-test-ast.ts';
import {
  DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS as publicDefaultOverrideTtl,
  GroupTopologyConfigValidationError as PublicConfigValidationError,
  readDefaultGroupTopologyConfig as publicReadDefaults,
  resolveGroupTopologyConfig as publicResolveConfig,
  GROUP_TOPOLOGY_CONFIG_NAMESPACE as publicConfigNamespace,
  GroupTopologyConfigRepository as PublicTopologyConfigRepository,
  GroupTopologyConfigRepositoryInvariantCorruptionError as PublicRepositoryCorruptionError,
} from '../../shared-server/mod.ts';
import {
  DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS as ownedDefaultOverrideTtl,
  GroupTopologyConfigValidationError as OwnedConfigValidationError,
  readDefaultGroupTopologyConfig as ownedReadDefaults,
  resolveGroupTopologyConfig as ownedResolveConfig,
} from '../../shared-server/rallar-system/topology/config/group-topology-config.ts';
import { GroupTopologyConfigRepositoryInvariantCorruptionError as OwnedRepositoryCorruptionError } from '../../shared-server/rallar-system/topology/config/persistence/group-topology-config-repository-contracts.ts';
import { GroupTopologyConfigRepository as OwnedTopologyConfigRepository } from '../../shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { GROUP_TOPOLOGY_CONFIG_NAMESPACE as ownedConfigNamespace } from '../../shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts';

const repoRoot = process.cwd();
const removedOwners = [
  'packages/shared-server/rallar-system/services/group-topology-config-mutations.ts',
  'packages/shared-server/rallar-system/services/group-topology-config-service.ts',
  'packages/shared-server/rallar-system/services/topology-mutation-authority-proof.ts',
  'packages/shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts',
  'packages/shared-server/rallar-system/repositories/group-topology-mutation-exact-read.ts',
  'packages/shared-server/rallar-system/repositories/group-topology-stored-source-values.ts',
  'packages/shared-server/rallar-system/services/group-topology-config-generation-backfill.ts',
  'packages/shared-server/rallar-system/services/group-topology-config-mutation-read.ts',
] as const;
const productionOwners = [
  'packages/shared-server/rallar-system/topology/config/group-topology-config.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/group-topology-config-mutation-contracts.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/topology-config-mutation-idempotency.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/compute-topology-config-mutation.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation-input.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/topology-config-mutation-boundary.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/topology-config-mutation-validation-values.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/validate-topology-config-records.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/validate-topology-config-receipt.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/topology-config-mutation-receipt.ts',
  'packages/shared-server/rallar-system/topology/inbox/topology-mutation-authority-proof.ts',
] as const;
const persistenceOwners = [
  'packages/shared-server/rallar-system/topology/config/persistence/group-topology-config-repository-contracts.ts',
  'packages/shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts',
  'packages/shared-server/rallar-system/topology/config/persistence/group-topology-config-source-repository.ts',
  'packages/shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts',
  'packages/shared-server/rallar-system/topology/config/persistence/group-topology-config-storage-keys.ts',
  'packages/shared-server/rallar-system/topology/config/persistence/group-topology-config-persistence-codec.ts',
  'packages/shared-server/rallar-system/topology/config/persistence/read-exact-group-topology-config-mutation.ts',
  'packages/shared-server/rallar-system/topology/config/persistence/decode-stored-group-topology-config.ts',
  'packages/shared-server/rallar-system/topology/config/maintenance/backfill-group-topology-config-generations.ts',
  'packages/shared-server/rallar-system/topology/config/maintenance/migrate-legacy-group-topology-config-keys.ts',
  'packages/shared-server/rallar-system/topology/config/mutation/read-topology-config-mutation.ts',
] as const;

describe('group topology server ownership through PR B', () => {
  it('removes every predecessor private owner without a shim', () => {
    for (const owner of removedOwners) expect(existsSync(absolute(owner)), owner).toBe(false);
  });

  it('keeps every changed production owner within 400 physical lines', () => {
    for (const owner of [...productionOwners, ...persistenceOwners]) {
      expect(physicalLines(read(owner)), owner).toBeLessThanOrEqual(400);
    }
  });

  it('keeps every persistence function within 60 physical lines', () => {
    for (const owner of persistenceOwners) {
      expect(oversizedGeneralFunctions(read(owner)), owner).toEqual([]);
    }
  });

  it('keeps persistence directed away from application and transport shells', () => {
    for (const owner of persistenceOwners) {
      const source = read(owner);
      for (const forbidden of [
        'GroupTopologyManagementService',
        'AppGroupInboxService',
        'TopologyAppInboxHandler',
        'RtcTopology',
        'create-rallar-server',
      ]) {
        expect(source, `${owner}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('imports canonical group-state storage keys without a compatibility hop', () => {
    const owner = read(
      'packages/shared-server/rallar-system/topology/config/persistence/group-topology-config-storage-keys.ts',
    );
    expect(owner).toContain("from '../../../group-state/persistence/group-state-storage-keys.ts';");
    expect(owner).not.toContain("from '../../../group-state-storage-keys.ts';");
  });

  it('keeps both topology concurrency suites in the recurring PostgreSQL gate', () => {
    const config = read('packages/tests/shared-server/vitest.postgres-integration.config.mjs');
    expect(config).toContain(
      "const topologyConcurrencyDirectory = 'packages/tests/shared-server/topology/concurrency';",
    );
    expect(config).toContain("'postgres-topology-config-override-concurrency.test.ts'");
    expect(config).toContain("'postgres-topology-mutation-worker-concurrency.test.ts'");
    expect(config).toContain('...topologyConcurrencyTests');
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
    expect(PublicTopologyConfigRepository).toBe(OwnedTopologyConfigRepository);
    expect(PublicRepositoryCorruptionError).toBe(OwnedRepositoryCorruptionError);
    expect(publicConfigNamespace).toBe(ownedConfigNamespace);
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
