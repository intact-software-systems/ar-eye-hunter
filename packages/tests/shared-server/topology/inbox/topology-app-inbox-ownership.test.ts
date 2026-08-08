import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { toTopologyAppInboxCommand as compatibilityTopologyCommand } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { toTopologyAppInboxCommand as canonicalTopologyCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';

const serverRoot = fileURLToPath(
  new URL('../../../../shared-server/rallar-system/', import.meta.url),
);
const testsRoot = fileURLToPath(new URL('../../', import.meta.url));

const targetOwners = [
  'topology/inbox/topology-app-inbox-contracts.ts',
  'topology/inbox/topology-app-inbox-command.ts',
  'topology/inbox/topology-app-inbox-authority.ts',
  'topology/inbox/topology-app-inbox-handler.ts',
  'rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts',
  'rtc-topology/inbox/rtc-rtt-app-inbox-authority.ts',
  'rtc-topology/inbox/rtc-rtt-app-inbox-handler.ts',
] as const;

const materiallyChangedOwners = ['services/AppGroupInboxService.ts', ...targetOwners] as const;

const materiallyChangedTestSupport = [
  'mutation-routing-inventory.ts',
  'mutation-routing-owner-inventory.ts',
  'mutation-routing-reachability.ts',
  'authoritative-mutation-read-compute-validate-write.test.ts',
  'authoritative-mutation-runtime-source-inventory.ts',
  'topology/inbox/topology-app-inbox-ownership.test.ts',
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

  it('keeps the public facade free of topology and RTC RTT mutation algorithms', () => {
    const facade = readOwner('services/AppGroupInboxService.ts');

    expect(facade).not.toContain('computeTopologyConfigMutation(');
    expect(facade).not.toContain('computeTopologyMutation(');
    expect(facade).not.toContain('computeRttMutation(');
    expect(facade).not.toContain('writeRttMutation(');
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
    expect(topologyHandler).toContain('topologyManagementService: GroupTopologyManagementService');
    expect(rtcHandler).toContain('rtcRttDependencies: RtcRttAppInboxDependencies');
  });

  it('keeps every materially changed production owner within the hard file limit', () => {
    for (const relativePath of materiallyChangedOwners) {
      expect(readOwner(relativePath).split('\n').length, relativePath).toBeLessThanOrEqual(400);
    }
  });

  it('keeps materially changed Task 6 test support within the hard file limit', () => {
    for (const relativePath of materiallyChangedTestSupport) {
      const source = readFileSync(`${testsRoot}${relativePath}`, 'utf8');
      expect(source.split('\n').length, relativePath).toBeLessThanOrEqual(400);
    }
  });
});

function readOwner(relativePath: string): string {
  const filePath = `${serverRoot}${relativePath}`;
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}
