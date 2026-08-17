import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import * as sharedServer from '@shared-server/mod.ts';
import { toTopologyAppInboxCommand as compatibilityTopologyCommand } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { GroupTopologyConfigRepository as canonicalConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { GroupTopologyManagementService as canonicalManagementService } from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
import { toTopologyAppInboxCommand as canonicalTopologyCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';

const serverRoot = fileURLToPath(
  new URL('../../../../../shared-server/rallar-system/', import.meta.url),
);

const targetOwners = [
  'topology/inbox/topology-app-inbox-contracts.ts',
  'topology/inbox/topology-app-inbox-command.ts',
  'topology/inbox/topology-app-inbox-authority.ts',
  'topology/inbox/topology-app-inbox-handler.ts',
  'rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts',
  'rtc-topology/inbox/rtc-rtt-app-inbox-authority.ts',
  'rtc-topology/inbox/rtc-rtt-app-inbox-handler.ts',
] as const;

const removedPredecessorOwners = [
  'repositories/GroupTopologyConfigRepository.ts',
  'repositories/group-topology-mutation-exact-read.ts',
  'repositories/group-topology-stored-source-values.ts',
  'services/group-topology-config-generation-backfill.ts',
  'services/group-topology-config-mutation-read.ts',
  'services/group-topology-config-mutations.ts',
  'services/group-topology-config-service.ts',
  'services/group-topology-management-service.ts',
  'services/topology-mutation-authority-proof.ts',
] as const;

describe('topology and RTC RTT AppInbox ownership', () => {
  it('keeps the exact seven responsibility owners in the approved target tree', () => {
    expect(targetOwners.filter((path) => !existsSync(`${serverRoot}${path}`))).toEqual([]);
  });

  it('keeps public topology command compatibility as a direct one-hop export', () => {
    const facade = readOwner('services/AppGroupInboxService.ts');

    expect(facade).toContain("from '../topology/inbox/topology-app-inbox-command.ts';");
    expect(facade).toContain('export { toTopologyAppInboxCommand }');
    expect(facade).not.toContain('function toCanonicalTopologyAppInboxPayload(');
    expect(facade).not.toContain('function toTopologyConfigMutationCommand(');
    expect(compatibilityTopologyCommand).toBe(canonicalTopologyCommand);
  });

  it('keeps package exports identical to the canonical topology owners', () => {
    expect(sharedServer.GroupTopologyConfigRepository).toBe(canonicalConfigRepository);
    expect(sharedServer.GroupTopologyManagementService).toBe(canonicalManagementService);
  });

  it('routes active composition and replay imports directly to canonical topology owners', () => {
    const packageEntry = readRepositoryPath('packages/shared-server/mod.ts');
    const apiComposition = readRepositoryPath(
      'apps/api-v1/src/composition/create-api-v1-topology-services.ts',
    );
    const replayOwner = readOwner('topology/replay/create-rtc-topology-work-handler.ts');

    expect(packageEntry).toContain(
      "from './rallar-system/topology/config/persistence/group-topology-config-repository.ts';",
    );
    expect(packageEntry).toContain(
      "export * from './rallar-system/topology/group-topology-management-service.ts';",
    );
    expect(apiComposition).toMatch(
      /from '@shared-server\/rallar-system\/topology\/\\\s*group-topology-management-service\.ts';/,
    );
    expect(replayOwner).toContain(
      "from '../planning/materialize-rtc-overlay-topology-broadcast-message.ts';",
    );
    expect(apiComposition).not.toContain('/services/group-topology-management-service.ts');
    expect(replayOwner).not.toContain("from '../group-topology-management-service.ts';");
  });

  it('keeps moved private predecessor paths absent without compatibility wrappers', () => {
    expect(
      removedPredecessorOwners.filter((relativePath) => existsSync(`${serverRoot}${relativePath}`)),
    ).toEqual([]);
  });

  it('keeps the public facade free of topology and RTC RTT mutation algorithms', () => {
    const facade = readOwner('services/AppGroupInboxService.ts');

    expect(facade).not.toContain('computeTopologyConfigMutation(');
    expect(facade).not.toContain('computeTopologyMutation(');
    expect(facade).not.toContain('computeRtcRttMutation(');
    expect(facade).not.toContain('writeRtcRttMutation(');
    expect(facade).not.toContain('createTopologyMutationAuthorityProof(');
  });

  it('keeps handler imports directed toward contracts, authority, and retained services', () => {
    const topologyHandler = readOwner('topology/inbox/topology-app-inbox-handler.ts');
    const rtcHandler = readOwner('rtc-topology/inbox/rtc-rtt-app-inbox-handler.ts');

    expect(topologyHandler).not.toContain('AppGroupInboxService');
    expect(rtcHandler).not.toContain('AppGroupInboxService');
    expect(topologyHandler).not.toContain('../rtc-topology/');
    expect(rtcHandler).not.toContain('../topology/inbox/');
  });

  it('keeps predecessor setters only on the facade and passes complete handler dependencies', () => {
    const facade = readOwner('services/AppGroupInboxService.ts');
    const topologyHandler = readOwner('topology/inbox/topology-app-inbox-handler.ts');
    const rtcHandler = readOwner('rtc-topology/inbox/rtc-rtt-app-inbox-handler.ts');

    expect(facade).toContain('private topologyManagementService?: GroupTopologyManagementService;');
    expect(facade).toContain('private rtcRttDependencies?: RtcRttAppInboxDependencies;');
    expect(facade).toContain('setTopologyManagementService(');
    expect(facade).toContain('setRtcRttAppInboxDependencies(');
    expect(topologyHandler).not.toContain('private topologyManagementService?');
    expect(topologyHandler).not.toContain('setTopologyManagementService(');
    expect(rtcHandler).not.toContain('private rtcRttDependencies?');
    expect(rtcHandler).not.toContain('setDependencies(');
    expect(topologyHandler).toContain('owners: TopologyAppInboxMutationOwners');
    expect(rtcHandler).toContain('rtcRttDependencies: RtcRttAppInboxDependencies');
  });
});

function readOwner(relativePath: string): string {
  const filePath = `${serverRoot}${relativePath}`;
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function readRepositoryPath(repositoryPath: string): string {
  return readFileSync(`${process.cwd()}/${repositoryPath}`, 'utf8');
}
